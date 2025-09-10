// graphBandit.js
const { v4: uuidv4 } = require('uuid');
const { getSession } = require('./db_neo4j');

const DEFAULT_HALFLIFE_HOURS = parseFloat(process.env.BANDIT_HALFLIFE_HOURS || '168'); // 7 dias
const MAX_RECOMMENDATIONS = parseInt(process.env.BANDIT_MAX_TACTICS_PER_STEP || '3', 10);
const EXPLORATION_BONUS = parseFloat(process.env.BANDIT_UCB_BONUS || '0.25');
const BANDIT_POLICY_DEFAULT = (process.env.BANDIT_POLICY || 'ucb').toLowerCase(); // 'ucb' | 'ts' | 'hybrid'
const TOPK_PER_STEP = parseInt(process.env.BANDIT_TOPK_PER_STEP || '8', 10);
const TTL_HOURS = parseFloat(process.env.BANDIT_TTL_HOURS || '720'); // 30 dias
const HYBRID_WEIGHTS = (() => {
    const s = (process.env.BANDIT_HYBRID_WEIGHTS || '0.6,0.2,0.1,0.1').split(',').map(Number);
    const [wE, wU, wC, wR] = [s[0]||0.6, s[1]||0.2, s[2]||0.1, s[3]||0.1];
    return { wE, wU, wC, wR };
})();

function computeDecayFactor(lastUpdatedMs, nowMs, halfLifeHours = DEFAULT_HALFLIFE_HOURS) {
    if (!lastUpdatedMs || !Number.isFinite(lastUpdatedMs)) return 1.0; // Sem decaimento se não houver histórico
    const halfLifeMs = halfLifeHours * 60 * 60 * 1000;
    const delta = Math.max(0, nowMs - Number(lastUpdatedMs));
    const factor = Math.pow(2, -delta / halfLifeMs);
    return factor;
}

async function ensureStepAndTactic(session, stepName, tacticName) {
    const now = Date.now();
    const q = `
        MERGE (s:PlannerStep {name: $stepName})
          ON CREATE SET s.createdAt = $now
        MERGE (t:Tactic {name: $tacticName})
          ON CREATE SET t.createdAt = $now
        MERGE (s)-[r:USES_TACTIC]->(t)
          ON CREATE SET r.alpha = 1.0, r.beta = 1.0, r.count = 0, r.lastUpdated = $now, r.cost = coalesce(r.cost, 0)
        RETURN t.name AS tacticName, r.alpha AS alpha, r.beta AS beta, r.count AS count, r.lastUpdated AS lastUpdated, r.cost AS cost
    `;
    const res = await session.run(q, { stepName, tacticName, now: now });
    if (!res.records.length) return null;
    const rec = res.records[0];
    return {
        tacticName: rec.get('tacticName'),
        alpha: Number(rec.get('alpha')),
        beta: Number(rec.get('beta')),
        count: Number(rec.get('count')),
        lastUpdated: Number(rec.get('lastUpdated')),
        cost: Number(rec.get('cost') || 0)
    };
}

async function fetchTacticsForStep(stepName) {
    const session = await getSession();
    try {
        const q = `
            MATCH (:PlannerStep {name: $stepName})-[r:USES_TACTIC]->(t:Tactic)
            RETURN t.name AS tacticName, r.alpha AS alpha, r.beta AS beta, r.count AS count, r.lastUpdated AS lastUpdated, r.cost AS cost
        `;
        const res = await session.run(q, { stepName });
        return res.records.map(rec => ({
            tacticName: rec.get('tacticName'),
            alpha: Number(rec.get('alpha')),
            beta: Number(rec.get('beta')),
            count: Number(rec.get('count')),
            lastUpdated: Number(rec.get('lastUpdated')),
            cost: Number(rec.get('cost') || 0)
        }));
    } finally {
        await session.close();
    }
}

function scoreUCB(edgeStatsList) {
    const now = Date.now();
    const totalPlays = edgeStatsList.reduce((sum, e) => sum + Math.max(1, (e.alpha + e.beta)), 0);
    return edgeStatsList.map(e => {
        const decay = computeDecayFactor(e.lastUpdated, now);
        const alpha = e.alpha * decay;
        const beta = e.beta * decay;
        const n = Math.max(1, alpha + beta);
        const mean = alpha / n;
        const bonus = EXPLORATION_BONUS * Math.sqrt(Math.log(totalPlays + 1) / n);
        const score = mean + bonus;
        return {
            tacticName: e.tacticName,
            estimatedSuccessProb: mean,
            score,
            recencyScore: decay,
            cost: e.cost || 0,
            propensity: null, // será normalizado após ordenação
        };
    }).sort((a, b) => b.score - a.score);
}

// Gamma sampler (Marsaglia and Tsang) for k>0, theta=1
function sampleGamma(k) {
    const d = k < 1 ? k + (1 / 3) - 1 / 3 : k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x = 0, v = 0;
        do {
            // Standard normal using Box-Muller
            const u1 = Math.random();
            const u2 = Math.random();
            x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.random();
        if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}

function sampleBeta(a, b) {
    // For a,b <=0 protection
    const aa = Math.max(a, 1e-6);
    const bb = Math.max(b, 1e-6);
    const x = sampleGamma(aa);
    const y = sampleGamma(bb);
    return x / (x + y);
}

function scoreTS(edgeStatsList) {
    const now = Date.now();
    const scored = edgeStatsList.map(e => {
        const decay = computeDecayFactor(e.lastUpdated, now);
        const alpha = Math.max(1e-6, e.alpha * decay);
        const beta = Math.max(1e-6, e.beta * decay);
        const sample = sampleBeta(alpha, beta);
        return {
            tacticName: e.tacticName,
            estimatedSuccessProb: alpha / (alpha + beta),
            sampledScore: sample,
            recencyScore: decay,
            cost: e.cost || 0,
            propensity: null
        };
    }).sort((a, b) => b.sampledScore - a.sampledScore);
    return scored;
}

function scoreHybrid(edgeStatsList) {
    const now = Date.now();
    const { wE, wU, wC, wR } = HYBRID_WEIGHTS;
    const scored = edgeStatsList.map(e => {
        const decay = computeDecayFactor(e.lastUpdated, now);
        const alpha = Math.max(1e-6, e.alpha * decay);
        const beta = Math.max(1e-6, e.beta * decay);
        const n = alpha + beta;
        const mean = alpha / n;
        const variance = (alpha * beta) / ((n * n) * (n + 1));
        const uncertainty = Math.sqrt(Math.max(variance, 0));
        const cost = e.cost || 0;
        const score = (wE * mean) + (wU * uncertainty) - (wC * cost) + (wR * decay);
        return {
            tacticName: e.tacticName,
            estimatedSuccessProb: mean,
            score,
            unc: uncertainty,
            recencyScore: decay,
            cost,
            propensity: null
        };
    }).sort((a, b) => b.score - a.score);
    return scored;
}

async function recommendTacticsForStep(stepName, context = {}, options = {}) {
    if (!stepName) return [];
    let edges = await fetchTacticsForStep(stepName);
    if (!edges || edges.length === 0) return [];

    // TTL pruning (filter out expired)
    const now = Date.now();
    const ttlMs = TTL_HOURS * 60 * 60 * 1000;
    const fresh = edges.filter(e => !e.lastUpdated || (now - e.lastUpdated) <= ttlMs);
    if (fresh.length !== edges.length) {
        await pruneOldEdges(stepName, ttlMs);
        edges = fresh;
    }

    // Rank according to policy
    const policy = (options.policy || BANDIT_POLICY_DEFAULT);
    let ranked;
    if (policy === 'ts') {
        ranked = scoreTS(edges).slice(0, Math.max(1, Math.min(MAX_RECOMMENDATIONS, edges.length)));
        const sum = ranked.reduce((s, r) => s + r.sampledScore, 0) || 1;
        ranked.forEach(r => { r.propensity = r.sampledScore / sum; });
    } else if (policy === 'hybrid') {
        ranked = scoreHybrid(edges).slice(0, Math.max(1, Math.min(MAX_RECOMMENDATIONS, edges.length)));
        const sum = ranked.reduce((s, r) => s + r.score, 0) || 1;
        ranked.forEach(r => { r.propensity = r.score / sum; });
    } else { // ucb
        ranked = scoreUCB(edges).slice(0, Math.max(1, Math.min(MAX_RECOMMENDATIONS, edges.length)));
        const sumScores = ranked.reduce((s, r) => s + r.score, 0) || 1;
        ranked.forEach(r => { r.propensity = r.score / sumScores; });
    }

    // Top-K budget pruning per step to keep graph lean
    await pruneToTopK(stepName, policy, TOPK_PER_STEP);

    return ranked;
}

async function updateAfterReflection({ leadId, stepName, tacticName, success, recommendation, eligibility }) {
    if (!stepName || !tacticName) return;
    const session = await getSession();
    const now = Date.now();
    try {
        // Garante nós/aresta e lê estado atual
        await ensureStepAndTactic(session, stepName, tacticName);

        const credits = normalizeEligibility(eligibility, tacticName);
        for (const [tName, credit] of Object.entries(credits)) {
            const edge = await ensureStepAndTactic(session, stepName, tName);
            if (!edge) continue;
            const decay = computeDecayFactor(edge.lastUpdated, now);
            const decayedAlpha = edge.alpha * decay;
            const decayedBeta = edge.beta * decay;
            const addAlpha = success ? credit : 0.0;
            const addBeta = success ? 0.0 : credit;
            const newAlpha = decayedAlpha + addAlpha;
            const newBeta = decayedBeta + addBeta;
            const qUpdate = `
                MATCH (:PlannerStep {name: $stepName})-[r:USES_TACTIC]->(:Tactic {name: $tacticName})
                SET r.alpha = $newAlpha,
                    r.beta = $newBeta,
                    r.count = coalesce(r.count,0) + 1,
                    r.lastUpdated = $now
                RETURN r.alpha AS alpha, r.beta AS beta, r.count AS count
            `;
            await session.run(qUpdate, { stepName, tacticName: tName, newAlpha, newBeta, now });
        }

        // Log da decisão para OPE
        const decisionId = uuidv4();
        const qLog = `
            MATCH (l:Lead {idWhatsapp: $leadId})
            MERGE (s:PlannerStep {name: $stepName})
            MERGE (t:Tactic {name: $tacticName})
            CREATE (d:BanditDecision {
                id: $id,
                at: $now,
                step: $stepName,
                tactic: $tacticName,
                success: $success,
                propensity: $propensity,
                recommendedJson: $recommendedJson,
                policy: $policy
            })
            CREATE (l)-[:HAS_DECISION]->(d)
            CREATE (d)-[:AT_STEP]->(s)
            CREATE (d)-[:CHOSEN_TACTIC]->(t)
            RETURN d.id AS id
        `;
        let propensity = null;
        let recommendedJson = null;
        if (recommendation && Array.isArray(recommendation.recommended)) {
            recommendedJson = JSON.stringify(recommendation.recommended.map(r => ({
                tacticName: r.tacticName,
                estimatedSuccessProb: r.estimatedSuccessProb,
                propensity: r.propensity,
            })));
            const matched = recommendation.recommended.find(r => r.tacticName === tacticName);
            propensity = matched ? matched.propensity : null;
        }
        await session.run(qLog, {
            leadId,
            stepName,
            tacticName,
            id: decisionId,
            now,
            success: Boolean(success),
            propensity,
            recommendedJson,
            policy: (recommendation && recommendation.policy) ? recommendation.policy : BANDIT_POLICY_DEFAULT
        });
    } catch (e) {
        console.error('[Bandit] Erro ao atualizar/logar decisão:', e.message);
    } finally {
        await session.close();
    }
}

function normalizeEligibility(eligibility, chosenTacticName) {
    // eligibility: { tacticName: credit, ... }
    if (!eligibility || typeof eligibility !== 'object') return { [chosenTacticName]: 1.0 };
    const entries = Object.entries(eligibility).filter(([, v]) => typeof v === 'number' && v > 0);
    if (entries.length === 0) return { [chosenTacticName]: 1.0 };
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    const norm = {};
    entries.forEach(([k, v]) => { norm[k] = v / sum; });
    return norm;
}

async function pruneOldEdges(stepName, ttlMs) {
    const session = await getSession();
    try {
        const threshold = Date.now() - ttlMs;
        const q = `
            MATCH (:PlannerStep {name: $stepName})-[r:USES_TACTIC]->(:Tactic)
            WHERE r.lastUpdated < $threshold
            DELETE r
        `;
        await session.run(q, { stepName, threshold });
    } catch (e) {
        console.warn('[Bandit] pruneOldEdges falhou:', e.message);
    } finally {
        await session.close();
    }
}

async function pruneToTopK(stepName, policy, k) {
    const edges = await fetchTacticsForStep(stepName);
    if (!edges || edges.length <= k) return;
    let ranked;
    if (policy === 'ts') ranked = scoreTS(edges);
    else if (policy === 'hybrid') ranked = scoreHybrid(edges);
    else ranked = scoreUCB(edges);
    const keep = new Set(ranked.slice(0, k).map(r => r.tacticName));
    const toDelete = edges.filter(e => !keep.has(e.tacticName));
    if (toDelete.length === 0) return;
    const session = await getSession();
    try {
        const q = `
            MATCH (:PlannerStep {name: $stepName})-[r:USES_TACTIC]->(t:Tactic)
            WHERE NOT t.name IN $keep
            DELETE r
        `;
        await session.run(q, { stepName, keep: Array.from(keep) });
    } catch (e) {
        console.warn('[Bandit] pruneToTopK falhou:', e.message);
    } finally {
        await session.close();
    }
}

module.exports = { recommendTacticsForStep, updateAfterReflection };


