// dashboard-backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getSession, closeDriver, neo4jDriver } = require('./db_neo4j'); // Assumindo que db_neo4j exporta o driver também
const neo4j = require('neo4j-driver');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY_DASHBOARD = process.env.GEMINI_API_KEY_DASHBOARD || process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY_DASHBOARD) {
    console.warn("!!! AVISO: GEMINI_API_KEY_DASHBOARD não configurada. Funcionalidade de chat de insights não funcionará. !!!");
}
const genAIDashboard = GEMINI_API_KEY_DASHBOARD ? new GoogleGenerativeAI(GEMINI_API_KEY_DASHBOARD) : null;
const insightModel = genAIDashboard ? genAIDashboard.getGenerativeModel({ model: "gemini-1.5-flash-latest" }) : null;

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3007;

app.use(cors());
app.use(express.json());
// ===== Goals API ===== (safe require)
let goalsEngine = null;
try {
    goalsEngine = require('./goalsEngine');
    try { goalsEngine.start(parseInt(process.env.GOALS_EVAL_INTERVAL_MS || '300000')); } catch {}
} catch (e) {
    console.warn('[Goals] goalsEngine módulo não encontrado ou falhou ao carregar. Endpoints relacionados podem retornar 503.');
}

app.get('/api/goals', async (_req, res) => {
  try {
    if (!goalsEngine || typeof goalsEngine.getGoals !== 'function') return res.status(503).json({ error: 'goals_engine_unavailable' });
    res.json(goalsEngine.getGoals());
  } catch (e) { res.status(500).json({ error: 'internal_error' }); }
});

app.post('/api/goals/evaluate', async (_req, res) => {
  try {
    if (!goalsEngine || typeof goalsEngine.evaluateGoals !== 'function') return res.status(503).json({ error: 'goals_engine_unavailable' });
    const results = await goalsEngine.evaluateGoals();
    res.json(results);
  } catch (e) {
    console.error('[Goals] evaluate error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/goals/snapshots', async (_req, res) => {
  try {
    if (!goalsEngine || typeof goalsEngine.getSnapshots !== 'function') return res.status(503).json({ error: 'goals_engine_unavailable' });
    res.json(goalsEngine.getSnapshots());
  } catch (e) { res.status(500).json({ error: 'internal_error' }); }
});

// Minimal edit endpoint to set goals.json content (admin-only in real system)
app.put('/api/goals', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'goals.json');
    const body = Array.isArray(req.body) ? req.body : (req.body?.goals || []);
    if (!Array.isArray(body)) return res.status(400).json({ error: 'invalid_body' });
    fs.writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
    goalsEngine.loadGoals();
    const results = await goalsEngine.evaluateGoals();
    res.json({ ok: true, count: body.length, results });
  } catch (e) {
    console.error('[Goals] put error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});
// ===== Reflection Analytics Endpoints =====
app.get('/api/analytics/reflections', async (req, res) => {
    try {
        let tracker;
        try { ({ globalAnalyticsTracker: tracker } = require('./index.js')); } catch {}
        tracker = tracker || (global && global.globalAnalyticsTracker) || null;
        if (!tracker || typeof tracker.getAllReflectionData !== 'function') {
            return res.status(503).json({ error: 'analytics_tracker_unavailable' });
        }
        const data = tracker.getAllReflectionData();
        res.json(data.map(r => ({
            leadId: r.leadId,
            leadName: r.leadName,
            planName: r.planName,
            stepName: r.stepName,
            agentAction: r.agentAction,
            stepGoalAchieved: r.stepGoalAchieved,
            inferredLeadSentiment: r.inferredLeadSentiment,
            sentimentConfidenceLabel: r.sentimentConfidenceLabel || null,
            sentimentConfidenceScore: r.sentimentConfidenceScore || null,
            timestamp: r.timestamp,
        })));
    } catch (e) {
        console.error('[Analytics] reflections endpoint error:', e);
        res.status(500).json({ error: 'internal_error' });
    }
});

app.get('/api/analytics/reflections/metrics', async (req, res) => {
    try {
        const plan = req.query.plan || '';
        let tracker;
        try { ({ globalAnalyticsTracker: tracker } = require('./index.js')); } catch {}
        tracker = tracker || (global && global.globalAnalyticsTracker) || null;
        if (!tracker || typeof tracker.getMetricsForPlan !== 'function') {
            return res.status(503).json({ error: 'analytics_tracker_unavailable' });
        }
        const metrics = tracker.getMetricsForPlan(String(plan));
        res.json(metrics);
    } catch (e) {
        console.error('[Analytics] reflections metrics endpoint error:', e);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ===== Dashboard Smart Summary (LLM) =====
app.post('/api/dashboard/summary', async (req, res) => {
    try {
        const payload = req.body || {};
        const { periodLabel = 'últimos 7 dias', numbers = {} } = payload;
        const { newLeads = 0, proposals = 0, negotiations = 0, won = 0, lost = 0 } = numbers;
        const base = `Dados (${periodLabel}): novos=${newLeads}, proposta=${proposals}, negociacao=${negotiations}, ganhos=${won}, perdidos=${lost}.`;
        if (!insightModel) {
            const text = `Você recebeu ${newLeads} novo(s) lead(s) ${periodLabel}. ${proposals>0?`${proposals} já evoluíram para proposta`: 'Nenhum avançou para proposta'}${won>0?`, e ${won} foram fechados com sucesso.`: ', e ainda não houve fechamentos.'}`;
            return res.json({ text, fallback: true });
        }
        const prompt = `Atue como consultor de vendas. Gere 1-2 frases, claras e práticas, em pt-BR, sobre os números abaixo. Evite jargões. Sugira, em no máximo 1 ação, o foco para hoje.
${base}`;
        const r = await insightModel.generateContent(prompt);
        const text = (r?.response?.text?.() || '').trim();
        return res.json({ text: text || `Resumo: ${base}` });
    } catch (e) {
        console.error('[dashboard/summary] error:', e);
        res.status(500).json({ error: 'internal_error' });
    }
});

// --- Helpers (mantidos e expandidos) ---
async function closeSession(session) {
    if (session) {
        await session.close();
    }
}

function convertNeo4jProperties(properties) {
    const result = {};
    for (const key in properties) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
            const value = properties[key];
            if (neo4j.isInt(value)) {
                result[key] = value.toNumber(); // Converter inteiros do Neo4j para números JS
            } else if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isTime(value) || neo4j.isDuration(value)) {
                result[key] = value.toString(); // Converter tipos de data/hora para string ISO
            } else if (typeof value === 'bigint') {
                result[key] = Number(value);
            }
            else if (key === 'dtCriacao' || key === 'dtUltimaAtualizacao' || key === 'createdAt' || key === 'updatedAt' || key === 'lastInteraction' || key === 'timestamp') {
                 result[key] = convertNeo4jDateToISO(value, `prop-${key}`);
            } else if (Array.isArray(value)) {
                result[key] = value.map(item => neo4j.isInt(item) ? item.toNumber() : (typeof item === 'bigint' ? Number(item) : item) );
            }
            else {
                result[key] = value;
            }
        }
    }
    return result;
}


function convertNeo4jDateToISO(dateValue, debugContext = "") {
    if (dateValue === null || dateValue === undefined) return null;
    try {
        let timestampNumber;
        if (typeof dateValue === 'bigint') timestampNumber = Number(dateValue);
        else if (neo4j.isInt(dateValue)) timestampNumber = dateValue.toNumber();
        else if (neo4j.isDate(dateValue) || neo4j.isDateTime(dateValue) || neo4j.isLocalDateTime(dateValue)) {
             timestampNumber = new Date(
                dateValue.year.toNumber(), dateValue.month.toNumber() - 1, dateValue.day.toNumber(),
                dateValue.hour ? dateValue.hour.toNumber() : 0, dateValue.minute ? dateValue.minute.toNumber() : 0,
                dateValue.second ? dateValue.second.toNumber() : 0, dateValue.nanosecond ? dateValue.nanosecond.toNumber() / 1000000 : 0
            ).getTime();
        }
        else if (typeof dateValue === 'object' && dateValue.year && dateValue.month && dateValue.day) { // Fallback para objeto literal
             timestampNumber = new Date(
                dateValue.year, dateValue.month - 1, dateValue.day,
                dateValue.hour || 0, dateValue.minute || 0, dateValue.second || 0
            ).getTime();
        }
        else if (typeof dateValue === 'number') timestampNumber = dateValue;
        else if (typeof dateValue === 'string') {
            timestampNumber = Date.parse(dateValue);
            if (isNaN(timestampNumber)) {
                const numAttempt = Number(dateValue);
                if (!isNaN(numAttempt)) timestampNumber = numAttempt;
            }
        }

        if (timestampNumber !== undefined && !isNaN(timestampNumber)) return new Date(timestampNumber).toISOString();
        console.warn(`[WARN ${debugContext}] Não foi possível converter dateValue para timestamp:`, dateValue, typeof dateValue);
        return String(dateValue);
    } catch (e) {
        console.error(`[ERROR ${debugContext}] Erro ao converter data: `, e, `Valor original:`, dateValue);
        return String(dateValue);
    }
}

function neo4jIdToString(idField) {
    if (neo4j.isInt(idField)) return idField.toString();
    return String(idField);
}

function getNodeDisplayLabel(properties, labels) {
    if (properties.nome) return String(properties.nome);
    if (properties.idWhatsapp) return `Lead: ${String(properties.idWhatsapp).substring(0,10)}...`;
    if (properties.name) return String(properties.name);
    if (labels && labels.length > 0) return labels.join(', ');
    return 'Nó Desconhecido';
}

function getNodeTitle(properties, labels, id) {
    let title = `ID: ${id}\nLabels: ${labels.join(', ')}\n`;
    for (const key in properties) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
            if (typeof properties[key] === 'object' && properties[key] !== null) {
                 if(Array.isArray(properties[key])) title += `${key}: ${properties[key].slice(0,3).join(', ')}${properties[key].length > 3 ? '...' : ''}\n`;
                 else title += `${key}: [Objeto]\n`;
            } else title += `${key}: ${properties[key]}\n`;
        }
    }
    return title.trim();
}

// =========================================================================
// ENDPOINTS PARA KORA BRAIN DASHBOARD
// =========================================================================

// 1. Configurações do Agente
app.get('/api/agent/config', async (req, res) => {
    try {
        // Em um cenário real, estas configs viriam de um arquivo, DB, ou do próprio agente principal.
        // Por agora, vamos simular com base nas variáveis de ambiente e constantes do agente.
        const agentConfig = {
            agentName: process.env.NOME_DO_AGENTE || "Leo Consultor",
            llmModel: process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash-latest", // Supondo que você tenha uma var de ambiente para isso
            temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.65,
            debounceDelayMs: parseInt(process.env.DEBOUNCE_DELAY_MS) || 7500,
            maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS) || 5,
            systemPromptBase: process.env.SYSTEM_INSTRUCTION_AGENTE_BASE || "Prompt base não configurado no backend do dashboard.", // Você precisaria carregar o prompt real
            messageBreakDelimiter: process.env.DELIMITER_MSG_BREAK || "||MSG_BREAK||",
            messageLengthTarget: parseInt(process.env.MESSAGE_LENGTH_TARGET) || 160, // Supondo uma var para isso
        };
        res.json(agentConfig);
    } catch (error) {
        console.error("Erro ao buscar configuração do agente:", error);
        res.status(500).json({ error: "Erro interno ao buscar configuração do agente" });
    }
});

app.put('/api/agent/config', async (req, res) => {
    // TODO: Implementar lógica para ATUALIZAR a configuração do agente.
    // Isso é complexo, pois pode exigir recarregar/reiniciar o agente principal.
    console.log("Recebido PUT para /api/agent/config com corpo:", req.body);
    res.status(501).json({ message: "Atualização de configuração ainda não implementada." });
});

// 2. Ferramentas do Agente
app.get('/api/agent/tools', async (req, res) => {
    try {
        // Simular a lista de ferramentas como definida no seu agente principal (index.js)
        // Em um sistema real, isso poderia vir de uma configuração ou ser introspectado.
        const toolsFromAgent = [ // Copiado/adaptado do seu index.js
            { id: "tool1", name: "get_lead_profile", description: "Obtém o perfil completo e atualizado de um lead...", isActive: true }, // isActive precisaria ser gerenciado
            { id: "tool2", name: "get_knowledge_schemas_for_pains", description: "Busca nos esquemas de conhecimento do Neo4j informações sobre Dores Comuns...", isActive: true },
            { id: "tool3", name: "analyze_and_update_lead_profile", description: "Analisa o histórico recente da conversa e o perfil conceitual atual...", isActive: true },
            { id: "tool4", name: "get_relevant_case_studies_or_social_proof", description: "Busca no banco de dados de conhecimento (Neo4j) por estudos de caso...", isActive: true },
        ];
        // TODO: Idealmente, o status 'isActive' viria de uma configuração persistida.
        res.json(toolsFromAgent);
    } catch (error) {
        console.error("Erro ao buscar ferramentas do agente:", error);
        res.status(500).json({ error: "Erro interno ao buscar ferramentas do agente" });
    }
});

app.put('/api/agent/tools/:toolId/status', async (req, res) => {
    const { toolId } = req.params;
    const { isActive } = req.body;
    // TODO: Implementar lógica para persistir o status da ferramenta.
    console.log(`Recebido PUT para /api/agent/tools/${toolId}/status com isActive: ${isActive}`);
    res.status(501).json({ message: `Atualização de status para ferramenta ${toolId} não implementada.` });
});

// 3. Planos do Planner
app.get('/api/agent/planner/plans', async (req, res) => {
    try {
        // Simular os planos como definidos no seu planner.js
        // Em um sistema real, isso poderia vir de uma configuração ou ser introspectado.
        const plansFromAgent = require('../kora-agent-files/planner').PLANS; // Assumindo que você pode requerer o PLANS diretamente
        const formattedPlans = Object.entries(plansFromAgent).map(([id, planData], index) => ({
            id: `plan${index + 1}`, // Gerar um ID simples para o frontend
            name: id,
            goal: planData.goal,
            steps: planData.steps.map((step, stepIndex) => ({
                id: `step${index+1}_${stepIndex+1}`,
                name: step.name,
                objective: step.objective,
                completionCriteria: step.completion_check ? step.completion_check.toString() : "Não definido", // Converter função para string é limitado
                isActive: true // TODO: Gerenciar status da etapa
            }))
        }));
        res.json(formattedPlans);
    } catch (error) {
        console.error("Erro ao buscar planos do planner:", error);
        res.status(500).json({ error: "Erro interno ao buscar planos do planner" });
    }
});
// TODO: Endpoints para CRUD de Planos (POST, PUT, DELETE)

// 4. Leads (Aprimorado)
app.get('/api/leads/:id', async (req, res) => {
    const { id: leadWhatsappId } = req.params;
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $leadWhatsappId})
            OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
            OPTIONAL MATCH (l)-[:TEM_INTERESSE]->(i:Interesse)
            OPTIONAL MATCH (l)-[:DISCUTIU_SOLUCAO]->(s:Solucao)
            OPTIONAL MATCH (l)-[:HAS_CONCEPTUAL_MEMORY]->(cm:ConceptualMemory)
            WITH l,
                 collect(DISTINCT d.nome) AS dores,
                 collect(DISTINCT i.nome) AS interesses,
                 collect(DISTINCT s.nome) AS solucoesDiscutidas,
                 collect(DISTINCT cm {.*, id: cm.id}) AS memoriasConceituais // Coleta todas as props de CM
            RETURN l {
                .* ,
                id: l.idWhatsapp, // Garante que o ID principal é o whatsappId
                name: l.nome,
                businessName: l.nomeDoNegocio,
                businessType: l.tipoDeNegocio,
                pains: dores,
                interests: interesses,
                discussedSolutions: solucoesDiscutidas,
                meetingInterest: l.nivelDeInteresseReuniao,
                lastSummary: l.ultimoResumoDaSituacao,
                activeHypotheses: CASE WHEN l.activeHypotheses IS NULL THEN [] ELSE l.activeHypotheses END, // Garante array
                conceptualMemories: memoriasConceituais,
                currentPlan: l.currentPlan, // Assumindo que estes campos são salvos no Lead
                currentStep: l.currentStep,
                lastInteraction: l.dtUltimaAtualizacao,
                tags: CASE WHEN l.tags IS NULL THEN [] ELSE l.tags END,
                emotionalState: l.emotionalState,
                emotionalConfidence: l.emotionalConfidence,
                emotionalUpdatedAt: l.emotionalUpdatedAt,
                emotionalJustification: l.emotionalJustification
            } AS lead
        `, { leadWhatsappId });

        if (result.records.length === 0) {
            return res.status(404).json({ error: "Lead não encontrado" });
        }
        
        let leadData = result.records[0].get('lead');
        leadData = convertNeo4jProperties(leadData); // Converte tipos Neo4j para JS

        // Formatar activeHypotheses e conceptualMemories se necessário (ex: datas)
        if (leadData.activeHypotheses) {
            leadData.activeHypotheses = leadData.activeHypotheses.map(h => convertNeo4jProperties(h));
        }
        if (leadData.conceptualMemories) {
            leadData.conceptualMemories = leadData.conceptualMemories.map(cm => convertNeo4jProperties(cm));
        }
        // Simular lastLatentInterpretations (poderia vir de hipóteses recentes do MeaningSupervisor)
        leadData.lastLatentInterpretations = (leadData.activeHypotheses || [])
            .filter(h => h.source === 'MeaningSupervisor' && h.type === 'IntentInterpretation')
            .sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0,3) // Pega as 3 mais recentes
            .map(h => ({ // Formata para o que o frontend espera
                interpretation: h.description.replace('Hipótese de intenção: "', '').replace(/" \(Foco sugerido: .*\)/, ''),
                confidenceScore: h.confidence,
                suggestedAgentFocus: h.description.match(/Foco sugerido: (.*?)\)/)?.[1] || 'N/A',
                potentialUserGoal: h.details?.potentialUserGoal || 'N/A',
                emotionalToneHint: h.details?.emotionalToneHint || 'N/A',
            }));


        res.json(leadData);
    } catch (error) {
        console.error(`Erro ao buscar detalhes do lead ${leadWhatsappId}:`, error);
        res.status(500).json({ error: "Erro interno ao buscar detalhes do lead" });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Analisar/atualizar perfil do lead via Gemini (resumo + próximo passo)
app.post('/api/leads/:id/analyze', async (req, res) => {
    try {
        if (!insightModel) return res.status(500).json({ error: 'gemini_not_configured' });
        const waId = String(req.params.id || '');
        if (!waId) return res.status(400).json({ error: 'id_required' });
        const neo4jSession = await getSession();
        try {
            const result = await neo4jSession.run(`
                MATCH (l:Lead {idWhatsapp: $waId})
                OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
                OPTIONAL MATCH (l)-[:TEM_INTERESSE]->(i:Interesse)
                RETURN l { .* } AS lead, collect(DISTINCT d.nome) AS dores, collect(DISTINCT i.nome) AS interesses
            `, { waId });
            if (result.records.length === 0) return res.status(404).json({ error: 'lead_not_found' });
            const lead = result.records[0].get('lead');
            const dores = result.records[0].get('dores') || [];
            const interesses = result.records[0].get('interesses') || [];
            const profile = {
                nomeDoLead: lead.nome || lead.name || 'Lead',
                nomeDoNegocio: lead.nomeDoNegocio || lead.businessName || null,
                tipoDeNegocio: lead.tipoDeNegocio || lead.businessType || null,
                principaisDores: dores,
                interesses: interesses,
                ultimoResumoDaSituacao: lead.ultimoResumoDaSituacao || lead.lastSummary || null,
                tags: lead.tags || []
            };
            const prompt = `Resuma em até 4 linhas o estado do lead (negócio, dor, momento) e proponha UM próximo passo objetivo. Responda JSON com campos { resumo: string, proximoPasso: string }.
Perfil: ${JSON.stringify(profile)}`;
            const r = await insightModel.generateContent(prompt);
            const text = r?.response?.text?.() || '';
            let resumo = null, proximoPasso = null;
            try { const js = JSON.parse(text); resumo = js?.resumo || null; proximoPasso = js?.proximoPasso || null; } catch { resumo = text.slice(0, 600); }
            await neo4jSession.run(`
                MATCH (l:Lead {idWhatsapp: $waId})
                SET l.ultimoResumoDaSituacao = coalesce($resumo, l.ultimoResumoDaSituacao), l.dtUltimaAtualizacao = timestamp()
            `, { waId, resumo });
            // Inferência de tom/emocional do lead
            let emotionalState = null; let emotionalConfidence = null; let emotionJustification = null;
            try {
                const emotionPrompt = `Com base no contexto abaixo, infira o TOM/ESTADO EMOCIONAL ATUAL do lead. Escolha uma das categorias: impaciente, interessado, indiferente, confuso, animado, frustrado, neutro.\nResponda estritamente em JSON com o formato { estado: string, confianca: number, justificativa: string } onde confianca está entre 0 e 1.\nContexto:\nResumoAtual: ${JSON.stringify(resumo || '')}\nResumoAnterior: ${JSON.stringify(profile.ultimoResumoDaSituacao || '')}`;
                const er = await insightModel.generateContent(emotionPrompt);
                const etext = er?.response?.text?.() || '';
                try {
                    const ej = JSON.parse(etext);
                    if (ej && typeof ej === 'object') {
                        emotionalState = typeof ej.estado === 'string' ? ej.estado.toLowerCase() : null;
                        emotionalConfidence = typeof ej.confianca === 'number' ? Math.max(0, Math.min(1, ej.confianca)) : null;
                        emotionJustification = typeof ej.justificativa === 'string' ? ej.justificativa : null;
                    }
                } catch {}
            } catch {}
            if (emotionalState) {
                await neo4jSession.run(`
                    MATCH (l:Lead {idWhatsapp: $waId})
                    SET l.emotionalState = $emotionalState,
                        l.emotionalConfidence = $emotionalConfidence,
                        l.emotionalUpdatedAt = timestamp(),
                        l.emotionalJustification = coalesce($emotionJustification, l.emotionalJustification)
                `, { waId, emotionalState, emotionalConfidence, emotionJustification });
            }
            return res.json({ ok: true, resumo, proximoPasso, emotionalState: emotionalState || null, emotionalConfidence: emotionalConfidence ?? null });
        } finally { await neo4jSession.close(); }
    } catch (e) {
        console.error('[analyze] error', e);
        return res.status(500).json({ error: String(e?.message || e) });
    }
});

// Leitura de emoção atual do lead (estado + confiança + timestamp)
app.get('/api/leads/:id/emotion', async (req, res) => {
  const waId = String(req.params.id || '')
  if (!waId) return res.status(400).json({ error: 'id_required' })
  const neo4jSession = await getSession()
  try {
    const r = await neo4jSession.run(`
      MATCH (l:Lead {idWhatsapp: $waId})
      RETURN l.emotionalState AS state, l.emotionalConfidence AS confidence, l.emotionalUpdatedAt AS updatedAt, l.emotionalJustification AS justification
    `, { waId })
    if (!r.records.length) return res.status(404).json({ error: 'lead_not_found' })
    const rec = r.records[0]
    return res.json({
      state: rec.get('state') || null,
      confidence: rec.get('confidence') ?? null,
      updatedAt: rec.get('updatedAt') || null,
      justification: rec.get('justification') || null,
    })
  } catch (e) {
    console.error('[emotion:get] error', e)
    return res.status(500).json({ error: String(e?.message || e) })
  } finally { await neo4jSession.close() }
})

// Solicita refresh assíncrono da emoção (marca flag e worker processa)
app.post('/api/leads/:id/emotion/refresh', async (req, res) => {
  const waId = String(req.params.id || '')
  if (!waId) return res.status(400).json({ error: 'id_required' })
  const neo4jSession = await getSession()
  try {
    await neo4jSession.run(`
      MATCH (l:Lead {idWhatsapp: $waId})
      SET l.emotionNeedsRefresh = true
    `, { waId })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[emotion:refresh] error', e)
    return res.status(500).json({ error: String(e?.message || e) })
  } finally { await neo4jSession.close() }
})

app.get('/api/leads/:id/chathistory', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id_required' });
    const session = await getSession();
    try {
        const r = await session.run(`
          MATCH (l:Lead { idWhatsapp: $id })-[:HAS_MESSAGE]->(m:Message)
          RETURN m.role AS role, m.text AS text, m.at AS at
          ORDER BY m.at ASC
        `, { id });
        const items = r.records.map(rec => ({
            role: rec.get('role'),
            parts: [{ text: rec.get('text') || '' }],
            timestamp: Number(rec.get('at') || 0)
        }));
        return res.json(items);
    } catch (e) {
        console.error('[chathistory] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Pré-call: últimas mensagens + 3 perguntas sugeridas
app.get('/api/leads/:id/precall', async (req, res) => {
  try {
    const waId = String(req.params.id || '')
    if (!waId) return res.status(400).json({ error: 'id_required' })
    const neo4jSession = await getSession()
    try {
      // Primeiro tenta cache de pre-call (resumo + perguntas). Se recente, retorna
      const cache = await neo4jSession.run(`
        MATCH (l:Lead {idWhatsapp: $waId})
        RETURN l.precallSummary AS summary, l.precallQuestions AS questions, l.precallUpdatedAt AS updatedAt
      `, { waId })
      const rec = cache.records[0]
      let cachedSummary = null, cachedQuestions = null
      if (rec) {
        cachedSummary = rec.get('summary') || null
        cachedQuestions = Array.isArray(rec.get('questions')) ? rec.get('questions').slice(0,3) : null
        const updatedAt = rec.get('updatedAt') || null
        if (cachedSummary || cachedQuestions) {
          // Também agrega últimas mensagens reais
          const msgs = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $waId})-[:HAS_MESSAGE]->(m:Message)
            RETURN m.role AS role, m.text AS text, m.at AS at
            ORDER BY m.at DESC LIMIT 5
          `, { waId })
          const lastMessages = msgs.records.map(r => ({ role: r.get('role'), text: r.get('text'), at: Number(r.get('at')) })).reverse()
          try { await neo4jSession.run(`MATCH (l:Lead {idWhatsapp: $waId}) SET l.precallNeedsRefresh = true`, { waId }) } catch {}
          return res.json({ summary: cachedSummary, suggestedQuestions: cachedQuestions || [], lastMessages })
        }
      }

      // Sem cache: retorna últimas mensagens reais (se houver) e perguntas padrão; agenda refresh
      const msgs = await neo4jSession.run(`
        MATCH (l:Lead {idWhatsapp: $waId})-[:HAS_MESSAGE]->(m:Message)
        RETURN m.role AS role, m.text AS text, m.at AS at
        ORDER BY m.at DESC LIMIT 5
      `, { waId })
      const lastMessages = msgs.records.map(r => ({ role: r.get('role'), text: r.get('text'), at: Number(r.get('at')) })).reverse()
      await neo4jSession.run(`MATCH (l:Lead {idWhatsapp: $waId}) SET l.precallNeedsRefresh = true`, { waId })
      return res.json({ summary: null, suggestedQuestions: [
        'Quais resultados você espera alcançar nos próximos 3 meses?',
        'Como sua equipe avalia propostas hoje? (critérios e prazos)',
        'Existe alguma objeção ou requisito essencial que devemos considerar?'
      ], lastMessages })
    } finally { await neo4jSession.close() }
  } catch (e) {
    console.error('[precall] error', e)
    return res.status(500).json({ error: String(e?.message || e) })
  }
})


// 5. Analytics de Reflexão
app.get('/api/analytics/overview', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Total de reflexões: Assumindo que você tem nós :ReflectionDataPoint
        // Esta é uma simulação, você precisaria adaptar para sua estrutura de dados de reflexão.
        const totalReflectionsResult = await neo4jSession.run(`MATCH (r:ReflectionDataPoint) RETURN count(r) AS total`);
        const totalReflections = totalReflectionsResult.records[0] ? totalReflectionsResult.records[0].get('total').toNumber() : 0;

        // Total de leads
        const totalLeadsResult = await neo4jSession.run(`MATCH (l:Lead) RETURN count(l) AS total`);
        const activeLeads = totalLeadsResult.records[0] ? totalLeadsResult.records[0].get('total').toNumber() : 0; // Simplificado

        // Reuniões agendadas
        const meetingsScheduledResult = await neo4jSession.run(`MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"}) RETURN count(l) AS total`);
        const meetingsScheduled = meetingsScheduledResult.records[0] ? meetingsScheduledResult.records[0].get('total').toNumber() : 0;
        
        // Taxa média de sucesso (simplificado - precisaria de dados de plano por reflexão)
        // const avgSuccessRateResult = await neo4jSession.run(`
        //     MATCH (r:ReflectionDataPoint)
        //     WHERE r.stepGoalAchieved IS NOT NULL
        //     RETURN avg(CASE r.stepGoalAchieved WHEN true THEN 1.0 ELSE 0.0 END) * 100 AS avgRate
        // `);
        // const avgSuccessRate = avgSuccessRateResult.records[0] ? (avgSuccessRateResult.records[0].get('avgRate') || 0) : 0;


        res.json({
            totalReflections: totalReflections,
            activeLeads: activeLeads, // Este é o total de leads, não apenas os "ativos"
            meetingsScheduled: meetingsScheduled,
            averagePlanSuccessRate: 70, // Mock, pois calcular isso corretamente é complexo
        });
    } catch (error) {
        console.error("Erro ao buscar overview de analytics:", error);
        res.status(500).json({ error: "Erro interno ao buscar overview de analytics" });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/plan-success', async (req, res) => {
    // TODO: Implementar query para buscar taxa de sucesso por plano.
    // Exigiria que ReflectionDataPoint tivesse 'planName' e 'stepGoalAchieved'.
    res.json([ // Mock
        { name: 'LeadQualificationToMeeting', successRate: 75, totalRuns: 80 },
        { name: 'ColdLeadReEngagement', successRate: 60, totalRuns: 50 },
    ]);
});

app.get('/api/analytics/sentiment-distribution', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        // Assumindo que ReflectionDataPoint armazena 'inferredLeadSentiment'
        const result = await neo4jSession.run(`
            MATCH (r:ReflectionDataPoint)
            WHERE r.inferredLeadSentiment IS NOT NULL
            RETURN r.inferredLeadSentiment AS name, count(r) AS value
        `);
        const sentimentDistribution = result.records.map(record => ({
            name: record.get('name'),
            value: record.get('value').toNumber()
        }));
        res.json(sentimentDistribution.length > 0 ? sentimentDistribution : [ { name: 'Não Coletado', value: 100 } ]);
    } catch (error) {
        console.error("Erro ao buscar distribuição de sentimentos:", error);
        res.status(500).json({ error: "Erro interno ao buscar distribuição de sentimentos" });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/analytics/tool-usage', async (req, res) => {
    // TODO: Implementar query para uso de ferramentas.
    // Exigiria logar chamadas de função (ferramentas) no Neo4j.
    res.json([ // Mock
        {name: 'get_lead_profile', value: 120}, {name: 'get_knowledge_schemas_for_pains', value: 90},
        {name: 'analyze_and_update_lead_profile', value: 70}, {name: 'get_relevant_case_studies_or_social_proof', value: 40}
    ]);
});

app.get('/api/analytics/effective-tactics', async (req, res) => {
    // TODO: Implementar query para táticas eficazes.
    // Exigiria que ReflectionDataPoint tivesse 'agentAction' e 'stepGoalAchieved'.
    res.json([ // Mock
        { tactic: "Apresentar Prova Social Específica", effectivenessScore: 0.85, count: 30 },
        { tactic: "Perguntar sobre Impacto Financeiro da Dor", effectivenessScore: 0.78, count: 45 },
    ]);
});


// 6. Base de Conhecimento
app.get('/api/knowledgebase/stats', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const stats = {};
        const nodeTypes = ['DorComum', 'SolucaoOferecida', 'ObjecaoComum', 'KnowledgeTopic', 'SocialProof'];
        for (const type of nodeTypes) {
            const result = await neo4jSession.run(`MATCH (n:${type}) RETURN count(n) AS count`);
            stats[type] = result.records[0] ? result.records[0].get('count').toNumber() : 0;
        }
        res.json({
            commonPains: stats['DorComum'] || 0,
            solutionsOffered: stats['SolucaoOferecida'] || 0,
            commonObjections: stats['ObjecaoComum'] || 0,
            knowledgeTopics: stats['KnowledgeTopic'] || 0,
            socialProofs: stats['SocialProof'] || 0,
        });
    } catch (error) {
        console.error("Erro ao buscar estatísticas da base de conhecimento:", error);
        res.status(500).json({ error: "Erro interno ao buscar estatísticas da base de conhecimento" });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/knowledgebase/items/:nodeType', async (req, res) => {
    const { nodeType } = req.params;
    const neo4jSession = await getSession();
    try {
        // Validar nodeType para segurança
        const allowedNodeTypes = ['DorComum', 'SolucaoOferecida', 'ObjecaoComum', 'KnowledgeTopic', 'SocialProof'];
        if (!allowedNodeTypes.includes(nodeType)) {
            return res.status(400).json({ error: "Tipo de nó inválido." });
        }

        const result = await neo4jSession.run(`MATCH (n:${nodeType}) RETURN n { .*, id: elementId(n) } AS item LIMIT 100`); // Limitar resultados
        const items = result.records.map(record => convertNeo4jProperties(record.get('item')));
        res.json(items);
    } catch (error) {
        console.error(`Erro ao buscar itens para ${nodeType}:`, error);
        res.status(500).json({ error: `Erro interno ao buscar itens para ${nodeType}` });
    } finally {
        await closeSession(neo4jSession);
    }
});
// TODO: Endpoints CRUD para itens da Base de Conhecimento (POST, PUT, DELETE)

// ===== FollowUps (criação simples) =====
app.post('/api/followups', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const body = req.body || {};
        const leadId = body.leadId;
        const objective = body.objective || 'Retomar conversa';
        const constraints = body.constraints || null; // { maxChars, cooldownHours }
        const cta = body.cta || null; // { text }
        const scheduleMinutes = Number(body.scheduleInMinutes || 0);

        if (!leadId) {
            return res.status(400).json({ error: 'leadId_required' });
        }

        const now = Date.now();
        const scheduledAt = scheduleMinutes > 0 ? now + (scheduleMinutes * 60 * 1000) : now + (15 * 60 * 1000);

        const result = await neo4jSession.run(`
            MATCH (l:Lead { idWhatsapp: $id })
            CREATE (f:FollowUp {
              objective: $objective,
              leadId: $id,
              channel: 'whatsapp',
              status: 'scheduled',
              scheduledAt: $scheduledAt,
              createdAt: $now,
              updatedAt: $now,
              attempts: 0,
              maxAttempts: 3,
              cooldownHours: coalesce($cooldown, 0),
              constraintsJson: $constraints,
              ctaJson: $cta
            })
            CREATE (l)-[:HAS_FOLLOWUP]->(f)
            RETURN f { .*, id: elementId(f) } AS followup
        `, {
            id: leadId,
            objective,
            scheduledAt: neo4j.int(scheduledAt),
            now: neo4j.int(now),
            cooldown: constraints && constraints.cooldownHours ? Number(constraints.cooldownHours) : 0,
            constraints: constraints ? JSON.stringify(constraints) : null,
            cta: cta ? JSON.stringify(cta) : null,
        });

        const rec = result.records[0];
        const followup = rec ? rec.get('followup') : null;
        return res.status(201).json({ ok: true, followup });
    } catch (e) {
        console.error('[followups:create] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// KPI simples de Follow-ups por status
app.get('/api/analytics/followups', async (_req, res) => {
    const session = await getSession();
    try {
        const r = await session.run(`
          MATCH (f:FollowUp)
          RETURN coalesce(f.status, 'unknown') AS status, count(f) AS c
        `);
        const byStatus = r.records.map(rec => ({
            status: String(rec.get('status') || 'unknown'),
            value: (rec.get('c') && typeof rec.get('c').toNumber === 'function') ? rec.get('c').toNumber() : Number(rec.get('c') || 0)
        }));
        return res.json({ byStatus });
    } catch (e) {
        console.error('[followups:analytics] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Candidatos a follow-up (heurística leve baseada em silêncio)
app.get('/api/followups/candidates', async (req, res) => {
    const session = await getSession();
    try {
        const silenceMs = Number(process.env.FOLLOWUP_SILENCE_MS || (24 * 60 * 60 * 1000));
        const now = Date.now();

        // Busca último inbound/outbound por lead a partir de mensagens
        const r = await session.run(`
          MATCH (l:Lead)
          OPTIONAL MATCH (l)-[:HAS_MESSAGE]->(m:Message)
          WITH l, m
          RETURN l.idWhatsapp AS id,
                 max(CASE WHEN m.role = 'user' THEN m.at END) AS lastInboundAt,
                 max(CASE WHEN m.role <> 'user' THEN m.at END) AS lastOutboundAt
        `);

        const items = [];
        for (const rec of r.records) {
            const leadId = String(rec.get('id') || '');
            if (!leadId) continue;
            const li = rec.get('lastInboundAt');
            const lo = rec.get('lastOutboundAt');
            const lastInboundAt = li && typeof li.toNumber === 'function' ? li.toNumber() : (li != null ? Number(li) : null);
            const lastOutboundAt = lo && typeof lo.toNumber === 'function' ? lo.toNumber() : (lo != null ? Number(lo) : null);

            const reasons = [];
            let priority_rule = 5;
            if (lastOutboundAt && (!lastInboundAt || (lastInboundAt < lastOutboundAt && (now - lastOutboundAt) >= silenceMs))) {
                reasons.push('silence');
                const overdueMs = now - Number(lastOutboundAt);
                // Quanto maior o silêncio, menor a prioridade numérica (1 = mais urgente)
                if (overdueMs >= 3 * silenceMs) priority_rule = 1;
                else if (overdueMs >= 2 * silenceMs) priority_rule = 2;
                else priority_rule = 3;
            }

            if (!reasons.length) continue;
            items.push({
                leadId,
                priority_rule,
                reasons,
                evidence: {
                    lastInboundAt: lastInboundAt ? new Date(lastInboundAt).toISOString() : null,
                    lastOutboundAt: lastOutboundAt ? new Date(lastOutboundAt).toISOString() : null,
                    overdueTasks: []
                }
            });
        }

        // Ordena por prioridade (1 melhor) e retorna
        items.sort((a, b) => (a.priority_rule - b.priority_rule));
        return res.json({ items });
    } catch (e) {
        console.error('[followups:candidates] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Insights de follow-up (stub por organização)
app.get('/api/followups/insights', async (req, res) => {
    try {
        const organization_id = String(req.query.organization_id || '');
        // Placeholder: retornar vazio até termos pipeline de insights consolidado
        return res.json({ items: [], organization_id });
    } catch (e) {
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Listar follow-ups de um lead
app.get('/api/leads/:id/followups', async (req, res) => {
    const session = await getSession();
    try {
        const id = String(req.params.id || '');
        if (!id) return res.status(400).json({ error: 'id_required' });
        const r = await session.run(`
          MATCH (l:Lead { idWhatsapp: $id })-[:HAS_FOLLOWUP]->(f:FollowUp)
          RETURN f { .*, id: elementId(f) } AS f
          ORDER BY f.scheduledAt ASC
        `, { id });
        const items = r.records.map(rec => rec.get('f'));
        return res.json(items);
    } catch (e) {
        console.error('[followups:listByLead] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Listar/filtrar follow-ups (operação)
app.get('/api/followups', async (req, res) => {
    const session = await getSession();
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const params = { skip: neo4j.int(skip), limit: neo4j.int(parseInt(limit)) };
        let where = [];
        if (status) { where.push('f.status = $status'); params.status = String(status); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const count = await session.run(`
          MATCH (f:FollowUp)
          ${whereSql}
          RETURN count(f) AS total
        `, params);
        const totalItems = count.records[0] ? count.records[0].get('total').toNumber() : 0;

        const r = await session.run(`
          MATCH (f:FollowUp)
          ${whereSql}
          RETURN f { .*, id: elementId(f) } AS f
          ORDER BY coalesce(f.scheduledAt, f.createdAt) ASC
          SKIP $skip LIMIT $limit
        `, params);
        const items = r.records.map(rec => rec.get('f'));
        return res.json({ data: items, page: parseInt(page), limit: parseInt(limit), totalItems, totalPages: Math.ceil(totalItems / parseInt(limit)) });
    } catch (e) {
        console.error('[followups:list] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Cancelar follow-up
app.put('/api/followups/:id/cancel', async (req, res) => {
    const session = await getSession();
    try {
        const idEl = String(req.params.id || '');
        if (!idEl) return res.status(400).json({ error: 'id_required' });
        const r = await session.run(`
          MATCH (f:FollowUp)
          WHERE elementId(f) = $id
          AND f.status IN ['scheduled','processing']
          SET f.status = 'cancelled', f.updatedAt = timestamp(), f.processingAt = NULL, f.workerId = NULL
          RETURN f { .*, id: elementId(f) } AS f
        `, { id: idEl });
        if (!r.records.length) return res.status(404).json({ error: 'not_found_or_not_cancellable' });
        return res.json({ ok: true, followup: r.records[0].get('f') });
    } catch (e) {
        console.error('[followups:cancel] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// Reagendar follow-up
app.put('/api/followups/:id/reschedule', async (req, res) => {
    const session = await getSession();
    try {
        const idEl = String(req.params.id || '');
        if (!idEl) return res.status(400).json({ error: 'id_required' });
        const { scheduledAt, scheduleInMinutes, constraints, cta } = req.body || {};
        const now = Date.now();
        const next = scheduledAt ? Number(scheduledAt) : (scheduleInMinutes ? now + (Number(scheduleInMinutes) * 60 * 1000) : now + (15 * 60 * 1000));
        const r = await session.run(`
          MATCH (f:FollowUp)
          WHERE elementId(f) = $id
          SET f.status = 'scheduled',
              f.processingAt = NULL,
              f.workerId = NULL,
              f.scheduledAt = $next,
              f.updatedAt = $now,
              f.constraintsJson = $constraints,
              f.ctaJson = $cta
          RETURN f { .*, id: elementId(f) } AS f
        `, { id: idEl, next: neo4j.int(next), now: neo4j.int(now), constraints: constraints ? JSON.stringify(constraints) : null, cta: cta ? JSON.stringify(cta) : null });
        if (!r.records.length) return res.status(404).json({ error: 'not_found' });
        return res.json({ ok: true, followup: r.records[0].get('f') });
    } catch (e) {
        console.error('[followups:reschedule] error', e);
        return res.status(500).json({ error: 'internal_error' });
    } finally { await closeSession(session); }
});

// === INTEGRAÇÃO COM ANALYTICS E META-REFLEXOR ===
const { ReflectionAnalyticsTracker } = require('./reflectionAnalyticsTracker');
const { MetaReflexor } = require('./metaReflexor');
let globalAnalyticsTracker, globalMetaReflexor;
try {
    // Tenta importar as instâncias globais do index.js
    ({ globalAnalyticsTracker, globalMetaReflexor } = require('./index.js'));
} catch (e) {
    // Fallback: cria novas instâncias se não conseguir importar
    globalAnalyticsTracker = new ReflectionAnalyticsTracker();
    globalMetaReflexor = new MetaReflexor(globalAnalyticsTracker);
}

// Endpoint: retorna todos os dados de reflexão
app.get('/api/analytics/reflection-log', (req, res) => {
    if (!globalAnalyticsTracker) return res.status(500).json({ error: 'AnalyticsTracker não disponível' });
    res.json(globalAnalyticsTracker.getAllReflectionData());
});

// Endpoint: clusters de micropersonas
app.get('/api/analytics/micropersona-patterns', (req, res) => {
    if (!globalAnalyticsTracker || !globalAnalyticsTracker.getPatternsForMicropersonas) return res.status(500).json({ error: 'AnalyticsTracker não disponível' });
    res.json(globalAnalyticsTracker.getPatternsForMicropersonas());
});

// Endpoint: insights completos do MetaReflexor
app.get('/api/analytics/meta-reflexor-insights', (req, res) => {
    if (!globalMetaReflexor) return res.status(500).json({ error: 'MetaReflexor não disponível' });
    res.json(globalMetaReflexor.getLatestInsights());
});

// Endpoint: recomendações do MetaReflexor
app.get('/api/analytics/meta-reflexor-recommendations', (req, res) => {
    if (!globalMetaReflexor) return res.status(500).json({ error: 'MetaReflexor não disponível' });
    const insights = globalMetaReflexor.getLatestInsights();
    res.json(insights && insights.recommendations ? insights.recommendations : []);
});

// =========================================================================
// ENDPOINTS EXISTENTES (Mantidos e verificados)
// =========================================================================
// O endpoint /api/leads já foi refatorado acima para ser mais completo.
// Outros endpoints do server.js original podem ser mantidos se ainda forem úteis
// ou removidos/adaptados conforme necessário.
app.get('/api/stats/geral-periodo', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const { startDate, endDate } = req.query; 
        let startMillis = 0;
        let endMillis = new Date().getTime(); 
        if (startDate) {
            const sDate = new Date(startDate);
            sDate.setHours(0, 0, 0, 0);
            startMillis = sDate.getTime();
        }
        if (endDate) {
            const eDate = new Date(endDate);
            eDate.setHours(23, 59, 59, 999);
            endMillis = eDate.getTime();
        }
        if (startDate && endDate && startMillis > endMillis) {
            return res.status(400).json({ error: "Data de início não pode ser posterior à data de fim." });
        }
        const totalLeadsResult = await neo4jSession.run('MATCH (l:Lead) RETURN count(l) AS totalLeads');
        const totalLeads = totalLeadsResult.records[0] ? neo4j.integer.toNumber(totalLeadsResult.records[0].get('totalLeads')) : 0;
        const totalConvertidosResult = await neo4jSession.run(
            'MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"}) RETURN count(l) AS totalConvertidos'
        );
        const totalConvertidos = totalConvertidosResult.records[0] ? neo4j.integer.toNumber(totalConvertidosResult.records[0].get('totalConvertidos')) : 0;
        const leadsNoPeriodoResult = await neo4jSession.run(
            `MATCH (l:Lead)
             WHERE l.dtCriacao >= $startMillis AND l.dtCriacao <= $endMillis
             RETURN count(l) AS leadsNoPeriodo`,
            { startMillis, endMillis }
        );
        const leadsAdicionadosNoPeriodo = leadsNoPeriodoResult.records[0] ? neo4j.integer.toNumber(leadsNoPeriodoResult.records[0].get('leadsNoPeriodo')) : 0;
        const convertidosNoPeriodoResult = await neo4jSession.run(
            `MATCH (l:Lead {nivelDeInteresseReuniao: "agendado"})
             WHERE l.dtUltimaAtualizacao >= $startMillis AND l.dtUltimaAtualizacao <= $endMillis
             RETURN count(l) AS convertidosNoPeriodo`,
            { startMillis, endMillis }
        );
        const leadsConvertidosNoPeriodo = convertidosNoPeriodoResult.records[0] ? neo4j.integer.toNumber(convertidosNoPeriodoResult.records[0].get('convertidosNoPeriodo')) : 0;
        res.json({
            periodo: { inicio: startDate || "Início dos tempos", fim: endDate || "Agora" },
            totalLeadsGeral: totalLeads,
            totalConvertidosGeral: totalConvertidos,
            leadsAdicionadosNoPeriodo,
            leadsConvertidosNoPeriodo,
        });
    } catch (error) {
        console.error("Erro ao buscar estatísticas gerais por período:", error);
        res.status(500).json({ error: "Erro ao buscar dados para estatísticas gerais por período" });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/leads', async (req, res) => { // Este endpoint agora serve para a lista principal de leads
    const neo4jSession = await getSession();
    try {
        const {
            nome, tag, dor, nivelInteresse, origem,
            dtCriacaoStart, dtCriacaoEnd, dtAtualizacaoStart, dtAtualizacaoEnd,
            page = 1, limit = 10 // Paginação padrão
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const params = { skip: neo4j.int(skip), limit: neo4j.int(parseInt(limit)) };
        let whereClauses = [];
        let matchClauses = ["MATCH (l:Lead)"];

        if (nome) { whereClauses.push("toLower(l.nome) CONTAINS toLower($nome)"); params.nome = nome; }
        if (nivelInteresse) { whereClauses.push("l.nivelDeInteresseReuniao = $nivelInteresse"); params.nivelInteresse = nivelInteresse; }
        if (origem) { whereClauses.push("l.origemDoLead = $origem"); params.origem = origem; }

        if (dtCriacaoStart) { const dt = new Date(dtCriacaoStart); dt.setHours(0,0,0,0); whereClauses.push("l.dtCriacao >= $dtCriacaoStartMillis"); params.dtCriacaoStartMillis = dt.getTime(); }
        if (dtCriacaoEnd) { const dt = new Date(dtCriacaoEnd); dt.setHours(23,59,59,999); whereClauses.push("l.dtCriacao <= $dtCriacaoEndMillis"); params.dtCriacaoEndMillis = dt.getTime(); }
        if (dtAtualizacaoStart) { const dt = new Date(dtAtualizacaoStart); dt.setHours(0,0,0,0); whereClauses.push("l.dtUltimaAtualizacao >= $dtAtualizacaoStartMillis"); params.dtAtualizacaoStartMillis = dt.getTime(); }
        if (dtAtualizacaoEnd) { const dt = new Date(dtAtualizacaoEnd); dt.setHours(23,59,59,999); whereClauses.push("l.dtUltimaAtualizacao <= $dtAtualizacaoEndMillis"); params.dtAtualizacaoEndMillis = dt.getTime(); }

        if (tag) { matchClauses.push("MATCH (l)-[:TEM_TAG]->(tg:Tag WHERE tg.nome = $tag)"); params.tag = tag; }
        if (dor) { matchClauses.push("MATCH (l)-[:TEM_DOR]->(dr:Dor WHERE dr.nome = $dor)"); params.dor = dor; }

        const baseQuery = `${matchClauses.join(" ")} ${whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : ""}`;
        
        const countQuery = `${baseQuery} RETURN count(DISTINCT l) AS total`;
        const countResult = await neo4jSession.run(countQuery, params);
        const totalItems = countResult.records[0] ? countResult.records[0].get('total').toNumber() : 0;
        const totalPages = Math.ceil(totalItems / parseInt(limit));

        const dataQuery = `
            ${baseQuery}
            WITH DISTINCT l
            RETURN l {
                .idWhatsapp, 
                .nome, 
                .nomeDoNegocio,
                .tipoDeNegocio,
                .dtCriacao, 
                .dtUltimaAtualizacao,
                .nivelDeInteresseReuniao, 
                .ultimoResumoDaSituacao,
                .currentPlan,
                .currentStep,
                tags: [(l)-[:TEM_TAG]->(t) | t.nome],
                pains: [(l)-[:TEM_DOR]->(d) | d.nome]
            } AS lead
            ORDER BY l.dtUltimaAtualizacao DESC
            SKIP $skip LIMIT $limit
        `;
        
        const result = await neo4jSession.run(dataQuery, params);
        const leads = result.records.map(record => {
            const leadData = convertNeo4jProperties(record.get('lead'));
            // Renomear para corresponder ao mock do frontend se necessário
            return {
                id: leadData.idWhatsapp,
                whatsappId: leadData.idWhatsapp,
                name: leadData.nome,
                businessName: leadData.nomeDoNegocio,
                businessType: leadData.tipoDeNegocio,
                meetingInterest: leadData.nivelDeInteresseReuniao,
                lastSummary: leadData.ultimoResumoDaSituacao,
                currentPlan: leadData.currentPlan,
                currentStep: leadData.currentStep,
                lastInteraction: leadData.dtUltimaAtualizacao, // Já convertido para ISO
                tags: leadData.tags || [],
                pains: leadData.pains || [],
            };
        });
        res.json({ data: leads, page: parseInt(page), limit: parseInt(limit), totalItems, totalPages });
    } catch (error) {
        console.error("Erro ao buscar lista de leads:", error);
        res.status(500).json({ error: "Erro ao buscar lista de leads" });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.get('/api/graph/overview-formatted', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (n)
            OPTIONAL MATCH (n)-[r]-(m)
            WITH n, r, m
            LIMIT 150 
            RETURN n AS node1, r AS relationship, m AS node2
        `);
        const nodes = new Map();
        const edges = [];
        result.records.forEach(record => {
            const node1 = record.get('node1');
            const relationship = record.get('relationship');
            const node2 = record.get('node2');
            if (node1) {
                const nodeId1 = neo4jIdToString(node1.identity);
                if (!nodes.has(nodeId1)) {
                    nodes.set(nodeId1, {
                        id: nodeId1,
                        label: getNodeDisplayLabel(convertNeo4jProperties(node1.properties), node1.labels),
                        group: node1.labels[0] || 'Unknown',
                        title: getNodeTitle(convertNeo4jProperties(node1.properties), node1.labels, nodeId1)
                    });
                }
            }
            if (node2) {
                const nodeId2 = neo4jIdToString(node2.identity);
                if (!nodes.has(nodeId2)) {
                    nodes.set(nodeId2, {
                        id: nodeId2,
                        label: getNodeDisplayLabel(convertNeo4jProperties(node2.properties), node2.labels),
                        group: node2.labels[0] || 'Unknown',
                        title: getNodeTitle(convertNeo4jProperties(node2.properties), node2.labels, nodeId2)
                    });
                }
            }
            if (relationship) {
                edges.push({
                    from: neo4jIdToString(relationship.start),
                    to: neo4jIdToString(relationship.end),
                    label: relationship.type
                });
            }
        });
        res.json({ nodes: Array.from(nodes.values()), edges });
    } catch (error) {
        console.error("Erro ao buscar dados para visão geral do grafo:", error);
        res.status(500).json({ error: "Erro ao buscar dados para o grafo" });
    } finally {
        await closeSession(neo4jSession);
    }
});

// =========================================================================
// INICIALIZAÇÃO E SHUTDOWN
// =========================================================================
app.listen(PORT, () => {
    console.log(`Servidor da API da Dashboard Kora Brain rodando na porta ${PORT}`);
    getSession().then(session => {
        console.log("Conexão com Neo4j verificada com sucesso para a API da dashboard.");
        session.close();
    }).catch(err => {
        console.error("!!!!!!!!!! FALHA AO VERIFICAR CONEXÃO COM NEO4J PARA A API DA DASHBOARD !!!!!!!!!!", err);
    });
});

let isShuttingDown = false;
async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('Recebido sinal para encerrar a API da dashboard Kora Brain...');
    try {
        await closeDriver();
        console.log('Driver Neo4j da API da dashboard Kora Brain fechado.');
    } catch (e) {
        console.error('Erro ao fechar driver Neo4j da API Kora Brain:', e);
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error, origin) => {
  console.error(`API Dashboard Kora Brain - Exceção não capturada: ${error.message}`, error.stack, `Origem: ${origin}`);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('API Dashboard Kora Brain - Rejeição de Promise não tratada:', reason, 'Promise:', promise);
});

