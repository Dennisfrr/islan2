const os = require('os');
const { getSession } = require('./db_neo4j');

const DEFAULT_INTERVAL_MS = Number(process.env.FOLLOWUPS_INTERVAL_MS || 60 * 1000);
const CLAIM_LIMIT = Number(process.env.FOLLOWUPS_CLAIM_LIMIT || 10);
const PROCESSING_STALE_MS = Number(process.env.FOLLOWUPS_PROCESSING_STALE_MS || (10 * 60 * 1000));
const BACKOFF_BASE_MINUTES = Number(process.env.FOLLOWUPS_BACKOFF_BASE_MINUTES || 15);

let timer = null;
const workerId = `${os.hostname()}-${process.pid}`;
// Lazy policies loader (best-send-time)
let POLICIES = null;
try {
    const fs = require('fs'); const path = require('path');
    const p = path.join(__dirname, 'followup_policies.json');
    POLICIES = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch { POLICIES = { stage_thresholds_hours: {}, sla_by_stage_hours: {}, cadences: {}, cta_by_stage: {} }; }

function nowMs() { return Date.now(); }

function computeBackoffMinutes(attempts) {
    const base = Math.max(1, BACKOFF_BASE_MINUTES);
    const pow = Math.min(6, Math.max(0, attempts)); // cap 2^6 = 64x
    return base * Math.pow(2, pow);
}

function parseJsonSafe(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
}

async function claimDueFollowUps(limit) {
    const session = await getSession();
    try {
        const now = nowMs();
        const stale = now - PROCESSING_STALE_MS;
        const r = await session.run(`
            MATCH (l:Lead)-[:HAS_FOLLOWUP]->(f:FollowUp)
            WHERE f.status = 'scheduled'
              AND coalesce(f.scheduledAt, 0) <= $now
              AND (f.processingAt IS NULL OR f.processingAt < $stale)
              AND coalesce(l.optOut, false) = false
            WITH f
            ORDER BY f.scheduledAt ASC
            LIMIT $limit
            SET f.status = 'processing',
                f.processingAt = $now,
                f.workerId = $workerId,
                f.updatedAt = $now,
                f.attempts = coalesce(f.attempts, 0) + 1
            RETURN f { .*, id: elementId(f) } AS f
        `, { now, stale, limit: Number(limit || CLAIM_LIMIT), workerId });
        return r.records.map(rec => rec.get('f'));
    } finally {
        await session.close();
    }
}

async function rescheduleFollowUp(idElement, minutesFromNow, lastError) {
    const session = await getSession();
    try {
        const next = nowMs() + Math.max(1, Math.round(minutesFromNow)) * 60 * 1000;
        await session.run(`
            MATCH (f:FollowUp)
            WHERE elementId(f) = $id
            SET f.status = 'scheduled',
                f.processingAt = NULL,
                f.workerId = NULL,
                f.scheduledAt = $next,
                f.lastError = $err,
                f.updatedAt = $now
        `, { id: idElement, next, err: lastError || null, now: nowMs() });
    } finally { await session.close(); }
}

async function computeBestSendTimeMinutesFromNow(followUp) {
    // Placeholder simples: se não houver política, retorna 30min com jitter
    try {
        const jitter = (min) => Math.max(5, min + Math.round((Math.random()*30)-15));
        // Futuro: ler histograma do lead e escolher melhor hora local
        return jitter(30);
    } catch { return 30 }
}

async function markSentAndUpdateLead(followUp, dispatchMeta) {
    const session = await getSession();
    try {
        const now = nowMs();
        const leadId = followUp.leadId;
        await session.run(`
            MATCH (f:FollowUp)
            WHERE elementId(f) = $id
            SET f.status = 'sent',
                f.sentAt = $now,
                f.updatedAt = $now,
                f.lastError = NULL,
                f.dispatchVariant = coalesce($variant, f.dispatchVariant)
            WITH f
            MATCH (l:Lead { idWhatsapp: $leadId })
            SET l.lastOutboundAt = $now,
                l.followupCount24h = coalesce(l.followupCount24h, 0) + 1,
                l.followupCount7d = coalesce(l.followupCount7d, 0) + 1,
                l.dtUltimaAtualizacao = timestamp()
        `, { id: followUp.id, now, leadId, variant: dispatchMeta && dispatchMeta.variant ? String(dispatchMeta.variant) : null });
    } finally { await session.close(); }
}

async function markFailed(followUp, errorMessage) {
    const session = await getSession();
    try {
        await session.run(`
            MATCH (f:FollowUp)
            WHERE elementId(f) = $id
            SET f.status = 'failed',
                f.processingAt = NULL,
                f.workerId = NULL,
                f.lastError = $err,
                f.updatedAt = $now
        `, { id: followUp.id, err: String(errorMessage || ''), now: nowMs() });
    } finally { await session.close(); }
}

async function processOne(f) {
    try {
        const base = process.env.WA_AGENT_BASE_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3005}`;
        const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || '';
        const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`;
        const fetch = (await import('node-fetch')).default;
        const constraints = parseJsonSafe(f.constraintsJson) || parseJsonSafe(f.quietHoursJson) || null;
        const body = {
            name: 'generate_and_send',
            commandId: f.commandId || `fup_${Date.now()}`,
            idempotencyKey: f.idempotencyKey || `fup_${String(f.leadId || '').replace(/\W/g,'')}_${String(f.createdAt || nowMs())}`,
            lead: { waJid: f.leadId },
            objective: f.objective,
            constraints: constraints || undefined,
            cta: parseJsonSafe(f.ctaJson) || undefined,
            abTest: !!f.abTest,
            metadata: { followUpId: f.id, templateId: f.templateId || null }
        };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Agent-Key': key } : {}) }, body: JSON.stringify(body) });
        const js = await res.json().catch(() => ({}));
        if (!res.ok) {
            const attempts = Number(f.attempts || 1);
            if (attempts >= Number(f.maxAttempts || 3)) {
                await markFailed(f, js?.error || `http_${res.status}`);
            } else {
                await rescheduleFollowUp(f.id, computeBackoffMinutes(attempts), js?.error || `http_${res.status}`);
            }
            return;
        }
        const status = js?.status || 'SENT';
        if (status === 'SENT') {
            await markSentAndUpdateLead(f, { variant: js?.variant || null });
            return;
        }
        if (status === 'QUEUED') {
            // Reschedule com base em guardrails simples
            const attempts = Number(f.attempts || 1);
            const cdHours = (constraints && constraints.cooldownHours) ? Number(constraints.cooldownHours) : 0;
            let minutes = cdHours > 0 ? Math.ceil(cdHours * 60) : Math.max(30, computeBackoffMinutes(attempts));
            try { if (!f.scheduledAt) { minutes = await computeBestSendTimeMinutesFromNow(f); } } catch {}
            await rescheduleFollowUp(f.id, minutes, 'guardrails_queued');
            return;
        }
        // Desconhecido → backoff
        const attempts = Number(f.attempts || 1);
        await rescheduleFollowUp(f.id, computeBackoffMinutes(attempts), `unknown_status_${status}`);
    } catch (e) {
        const attempts = Number(f.attempts || 1);
        if (attempts >= Number(f.maxAttempts || 3)) {
            await markFailed(f, e?.message || String(e));
        } else {
            await rescheduleFollowUp(f.id, computeBackoffMinutes(attempts), e?.message || String(e));
        }
    }
}

async function tickOnce() {
    try {
        const claimed = await claimDueFollowUps(CLAIM_LIMIT);
        for (const f of claimed) {
            // Cancelados enquanto aguardando? cheque rápido
            if (String(f.status) !== 'processing') continue;
            await processOne(f);
        }
    } catch (e) {
        console.error('[FollowUpScheduler] tick error:', e?.message || e);
    }
}

function start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (timer) return;
    timer = setInterval(tickOnce, Math.max(5_000, Number(intervalMs)));
    // Primeira execução após pequeno atraso para evitar disputa na subida
    setTimeout(() => { tickOnce().catch(() => {}); }, 2_000);
    console.log(`[FollowUpScheduler] started with interval=${intervalMs}ms workerId=${workerId}`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; console.log('[FollowUpScheduler] stopped'); } }

module.exports = { start, stop };


