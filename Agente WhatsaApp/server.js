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
const N8N_API_URL = process.env.N8N_API_URL || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const N8N_WRAPPER_WEBHOOK_URL = process.env.N8N_WRAPPER_WEBHOOK_URL || '';
async function doFetch(url, options) { const fetch = (await import('node-fetch')).default; return fetch(url, options); }
async function n8nApi(path, method = 'GET', body) {
    if (!N8N_API_URL || !N8N_API_KEY) throw new Error('N8N_API_URL ou N8N_API_KEY não configurados');
    const res = await doFetch(`${N8N_API_URL.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': N8N_API_KEY },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        let bodyText = '';
        try { bodyText = await res.text(); } catch {}
        const snippet = bodyText ? ` | ${bodyText.substring(0,300)}` : '';
        throw new Error(`n8n API ${method} ${path} => ${res.status}${snippet}`);
    }
    return res.json();
}

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3005;

app.use(cors());
app.use(express.json());

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
            else if (key === 'dtCriacao' || key === 'dtUltimaAtualizacao' || key === 'createdAt' || key === 'updatedAt' || key === 'lastInteraction' || key === 'timestamp' || key === 'stageUpdatedAt') {
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
// PIPELINE KANBAN - Config padrão de estágios (fallback se DB estiver vazio)
// =========================================================================
const DEFAULT_PIPELINE_STAGES = [
    { name: 'Novo', order: 1 },
    { name: 'Qualificado', order: 2 },
    { name: 'Contato Iniciado', order: 3 },
    { name: 'Descoberta', order: 4 },
    { name: 'Proposta', order: 5 },
    { name: 'Agendado', order: 6 },
    { name: 'Seguimento', order: 7 },
    { name: 'Perdido', order: 8 },
    { name: 'Desqualificado', order: 9 },
];

// Classificador heurístico simples para estágio do pipeline (MVP)
function classifyLeadHeuristic(lead) {
    // lead: objeto com campos principais do Lead
    const rationaleParts = [];
    // Alta confiança se reunião agendada
    if (lead.nivelDeInteresseReuniao && String(lead.nivelDeInteresseReuniao).toLowerCase() === 'agendado') {
        rationaleParts.push('nivelDeInteresseReuniao = agendado');
        return { toStage: 'Agendado', confidence: 0.9, rationale: rationaleParts.join('; ') };
    }
    // Proposta se menção em último resumo
    if (lead.ultimoResumoDaSituacao && /proposta|orcamento|valor/i.test(String(lead.ultimoResumoDaSituacao))) {
        rationaleParts.push('menção a proposta/orçamento/valor no último resumo');
        return { toStage: 'Proposta', confidence: 0.72, rationale: rationaleParts.join('; ') };
    }
    // Descoberta se há dores e ainda não avançou
    if ((lead.pains?.length || 0) > 0 && (!lead.pipelineStage || ['Novo','Qualificado','Contato Iniciado'].includes(lead.pipelineStage))) {
        rationaleParts.push('dores identificadas e estágio inicial');
        return { toStage: 'Descoberta', confidence: 0.64, rationale: rationaleParts.join('; ') };
    }
    // Seguimento se tag lead_frio ou sem interação recente (>14 dias)
    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    const lastTs = lead.dtUltimaAtualizacao ? Number(lead.dtUltimaAtualizacao) : null;
    const stale = lastTs ? (Date.now() - lastTs) > twoWeeksMs : false;
    if ((lead.tags || []).includes('lead_frio') || stale) {
        rationaleParts.push(stale ? 'sem interação >14 dias' : 'tag lead_frio');
        return { toStage: 'Seguimento', confidence: 0.6, rationale: rationaleParts.join('; ') };
    }
    // Qualificado por padrão se tem algum dado de negócio
    if (lead.nomeDoNegocio || lead.tipoDeNegocio) {
        rationaleParts.push('dados de negócio presentes');
        return { toStage: 'Qualificado', confidence: 0.55, rationale: rationaleParts.join('; ') };
    }
    return { toStage: 'Novo', confidence: 0.5, rationale: 'estado default' };
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
            n8nWebhookConfigured: !!process.env.N8N_WEBHOOK_URL
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
        let toolsFromRegistry = [];
        try {
            toolsFromRegistry = require('./toolsEngine').getRegisteredTools();
        } catch (e) {
            console.warn('toolsEngine.getRegisteredTools não disponível, retornando lista mock.');
        }
        if (toolsFromRegistry && toolsFromRegistry.length > 0) return res.json(toolsFromRegistry);
        // fallback simples
        return res.json([
            { id: "get_lead_profile", name: "get_lead_profile", description: "Obtém o perfil completo do lead", enabled: true, eventTypes: [] },
            { id: "get_knowledge_schemas_for_pains", name: "get_knowledge_schemas_for_pains", description: "Busca esquemas de conhecimento", enabled: true, eventTypes: [] },
            { id: "analyze_and_update_lead_profile", name: "analyze_and_update_lead_profile", description: "Analisa e atualiza perfil", enabled: true, eventTypes: [] },
            { id: "get_relevant_case_studies_or_social_proof", name: "get_relevant_case_studies_or_social_proof", description: "Provas sociais relevantes", enabled: true, eventTypes: [] },
        ]);
    } catch (error) {
        console.error("Erro ao buscar ferramentas do agente:", error);
        res.status(500).json({ error: "Erro interno ao buscar ferramentas do agente" });
    }
});

// =========================================================================
// 8. Tools - CRUD e Execução Manual
// =========================================================================
app.get('/api/tools', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (t:Tool)
            RETURN t { .id, .name, .description, .enabled, .eventTypes, .threshold, .type, .configJson, createdAt: t.createdAt, updatedAt: t.updatedAt } AS tool
            ORDER BY coalesce(t.updatedAt, t.createdAt) DESC
        `);
        const tools = result.records.map(r => convertNeo4jProperties(r.get('tool')));
        res.json(tools);
    } catch (error) {
        console.error('Erro ao listar tools:', error);
        res.status(500).json({ error: 'Erro ao listar tools' });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.post('/api/tools', async (req, res) => {
    const { id, name, description, enabled = true, eventTypes = [], threshold = 0.75, type = 'http', configJson = '{}' } = req.body || {};
    if (!name || !type) return res.status(400).json({ error: 'name e type são obrigatórios' });
    const toolId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const neo4jSession = await getSession();
    try {
        const q = `
            MERGE (t:Tool { id: $id })
            ON CREATE SET t.createdAt = timestamp()
            SET t.name = $name,
                t.description = $description,
                t.enabled = $enabled,
                t.eventTypes = $eventTypes,
                t.threshold = $threshold,
                t.type = $type,
                t.configJson = $configJson,
                t.updatedAt = timestamp()
            RETURN t { .id, .name, .description, .enabled, .eventTypes, .threshold, .type, .configJson, createdAt: t.createdAt, updatedAt: t.updatedAt } AS tool
        `;
        const r = await neo4jSession.run(q, { id: toolId, name, description, enabled, eventTypes, threshold, type, configJson });
        const tool = convertNeo4jProperties(r.records[0].get('tool'));
        res.json(tool);
    } catch (error) {
        console.error('Erro ao criar/atualizar tool:', error);
        res.status(500).json({ error: 'Erro ao salvar tool' });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.patch('/api/tools/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, enabled, eventTypes, threshold, type, configJson } = req.body || {};
    const neo4jSession = await getSession();
    try {
        const sets = [];
        const params = { id };
        if (name !== undefined) { sets.push('t.name = $name'); params.name = name; }
        if (description !== undefined) { sets.push('t.description = $description'); params.description = description; }
        if (enabled !== undefined) { sets.push('t.enabled = $enabled'); params.enabled = enabled; }
        if (eventTypes !== undefined) { sets.push('t.eventTypes = $eventTypes'); params.eventTypes = eventTypes; }
        if (threshold !== undefined) { sets.push('t.threshold = $threshold'); params.threshold = threshold; }
        if (type !== undefined) { sets.push('t.type = $type'); params.type = type; }
        if (configJson !== undefined) { sets.push('t.configJson = $configJson'); params.configJson = configJson; }
        if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
        const q = `
            MATCH (t:Tool { id: $id })
            SET ${sets.join(', ')}, t.updatedAt = timestamp()
            RETURN t { .id, .name, .description, .enabled, .eventTypes, .threshold, .type, .configJson, createdAt: t.createdAt, updatedAt: t.updatedAt } AS tool
        `;
        const r = await neo4jSession.run(q, params);
        if (r.records.length === 0) return res.status(404).json({ error: 'Tool não encontrada' });
        const tool = convertNeo4jProperties(r.records[0].get('tool'));
        res.json(tool);
    } catch (error) {
        console.error('Erro ao atualizar tool:', error);
        res.status(500).json({ error: 'Erro ao atualizar tool' });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.delete('/api/tools/:id', async (req, res) => {
    const { id } = req.params;
    const neo4jSession = await getSession();
    try {
        const r = await neo4jSession.run(`MATCH (t:Tool { id: $id }) DETACH DELETE t RETURN count(*) AS removed`, { id });
        res.json({ ok: true, removed: r.records[0].get('removed').toNumber() });
    } catch (error) {
        console.error('Erro ao deletar tool:', error);
        res.status(500).json({ error: 'Erro ao deletar tool' });
    } finally {
        await closeSession(neo4jSession);
    }
});

app.post('/api/tools/:id/run', async (req, res) => {
    const { id } = req.params;
    const payload = req.body || {};
    try {
        const { runToolById } = require('./toolsEngine');
        const runResult = await runToolById(id, payload);
        res.json({ ok: true, result: runResult });
    } catch (error) {
        console.error('Erro ao executar tool:', error);
        res.status(500).json({ error: 'Erro ao executar tool', details: error.message });
    }
});

// 9. Workflows - CRUD e Execução Manual
app.get('/api/workflows', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const r = await neo4jSession.run(`MATCH (w:Workflow) RETURN w { .id, .name, .enabled, .workflowJson, createdAt: w.createdAt, updatedAt: w.updatedAt } AS wf ORDER BY coalesce(w.updatedAt, w.createdAt) DESC`);
        const workflows = r.records.map(rec => convertNeo4jProperties(rec.get('wf')));
        res.json(workflows);
    } catch (e) {
        console.error('Erro ao listar workflows:', e);
        res.status(500).json({ error: 'Erro ao listar workflows' });
    } finally { await closeSession(neo4jSession); }
});

app.post('/api/workflows', async (req, res) => {
    const { id, name, enabled = true, workflowJson } = req.body || {};
    if (!name || !workflowJson) return res.status(400).json({ error: 'name e workflowJson são obrigatórios' });
    const wfId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const neo4jSession = await getSession();
    try {
        const r = await neo4jSession.run(`
            MERGE (w:Workflow { id: $id })
            ON CREATE SET w.createdAt = timestamp()
            SET w.name = $name, w.enabled = $enabled, w.workflowJson = $workflowJson, w.updatedAt = timestamp()
            RETURN w { .id, .name, .enabled, .workflowJson, createdAt: w.createdAt, updatedAt: w.updatedAt } AS wf
        `, { id: wfId, name, enabled, workflowJson: typeof workflowJson === 'string' ? workflowJson : JSON.stringify(workflowJson) });
        const wf = convertNeo4jProperties(r.records[0].get('wf'));
        res.json(wf);
    } catch (e) {
        console.error('Erro ao criar/atualizar workflow:', e);
        res.status(500).json({ error: 'Erro ao salvar workflow' });
    } finally { await closeSession(neo4jSession); }
});

app.patch('/api/workflows/:id', async (req, res) => {
    const { id } = req.params;
    const { name, enabled, workflowJson } = req.body || {};
    const neo4jSession = await getSession();
    try {
        const sets = [];
        const params = { id };
        if (name !== undefined) { sets.push('w.name = $name'); params.name = name; }
        if (enabled !== undefined) { sets.push('w.enabled = $enabled'); params.enabled = enabled; }
        if (workflowJson !== undefined) { sets.push('w.workflowJson = $workflowJson'); params.workflowJson = typeof workflowJson === 'string' ? workflowJson : JSON.stringify(workflowJson); }
        if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
        const q = `MATCH (w:Workflow { id: $id }) SET ${sets.join(', ')}, w.updatedAt = timestamp() RETURN w { .id, .name, .enabled, .workflowJson, createdAt: w.createdAt, updatedAt: w.updatedAt } AS wf`;
        const r = await neo4jSession.run(q, params);
        if (r.records.length === 0) return res.status(404).json({ error: 'Workflow não encontrado' });
        const wf = convertNeo4jProperties(r.records[0].get('wf'));
        res.json(wf);
    } catch (e) {
        console.error('Erro ao atualizar workflow:', e);
        res.status(500).json({ error: 'Erro ao atualizar workflow' });
    } finally { await closeSession(neo4jSession); }
});

app.delete('/api/workflows/:id', async (req, res) => {
    const { id } = req.params;
    const neo4jSession = await getSession();
    try {
        const r = await neo4jSession.run(`MATCH (w:Workflow { id: $id }) DETACH DELETE w RETURN count(*) AS removed`, { id });
        res.json({ ok: true, removed: r.records[0].get('removed').toNumber() });
    } catch (e) {
        console.error('Erro ao deletar workflow:', e);
        res.status(500).json({ error: 'Erro ao deletar workflow' });
    } finally { await closeSession(neo4jSession); }
});

app.post('/api/workflows/:id/run', async (req, res) => {
    const { id } = req.params;
    const payload = req.body || {};
    try {
        const { runWorkflowById } = require('./workflowsEngine');
        const result = await runWorkflowById(id, payload);
        res.json(result);
    } catch (e) {
        console.error('Erro ao executar workflow:', e);
        res.status(500).json({ error: 'Erro ao executar workflow', details: e.message });
    }
});

// 10. Integração n8n - introspecção de workflows e execução manual
app.get('/api/integrations/n8n/workflows', async (req, res) => {
    try {
        const list = await n8nApi('/workflows', 'GET');
        const workflows = Array.isArray(list) ? list : (list.data || []);
        // Busca detalhes para extrair nodes/triggers
        const detailed = await Promise.all(workflows.map(async (wf) => {
            const id = wf.id || wf._id || String(wf?.id || '');
            try {
                const detail = await n8nApi(`/workflows/${id}`, 'GET');
                const nodes = detail?.nodes || [];
                const triggers = [];
                nodes.forEach(n => {
                    const type = String(n.type || '');
                    if (type.includes('webhook')) {
                        const path = n.parameters?.path || n.parameters?.pathSegment || '/';
                        const headerTrigger = n.parameters?.responseHeaders?.find?.(h => h.name === 'X-Dashboard-Trigger')?.value;
                        triggers.push({ type: headerTrigger || (String(path).includes('afterReflection') ? 'afterReflection' : 'webhook'), via: 'webhook', path });
                    }
                    if (type.includes('cron')) {
                        const expr = n.parameters?.triggerTimes?.items?.[0]?.hour || n.parameters?.rule || n.parameters?.cronExpression || 'cron';
                        triggers.push({ type: 'scheduled', via: 'cron', expr });
                    }
                });
                if (detail.tags && detail.tags.find(t => (t.name||t).toString().toLowerCase().includes('trigger:manual'))) triggers.push({ type: 'manual', via: 'tag' });
                return { id, name: detail.name || wf.name, active: detail.active ?? wf.active, triggers };
            } catch {
                return { id, name: wf.name, active: wf.active, triggers: [] };
            }
        }));
        res.json(detailed);
    } catch (e) {
        console.error('Erro ao listar workflows n8n:', e.message);
        res.status(500).json({ error: 'Erro ao listar workflows n8n', details: e.message });
    }
});

app.post('/api/integrations/n8n/run/:workflowId', async (req, res) => {
    const { workflowId } = req.params;
    try {
        // Preferencial: executar via wrapper por webhook se configurado
        try {
            if (N8N_WRAPPER_WEBHOOK_URL) {
                const payload = { workflowId, input: (req.body && Object.keys(req.body).length ? req.body : {}) };
                const resp = await doFetch(N8N_WRAPPER_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) throw new Error(`Wrapper webhook exec falhou: ${resp.status}`);
                const contentType = resp.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const json = await resp.json();
                    return res.json(json);
                }
                return res.json({ ok: true, status: resp.status });
            }
        } catch (eWrapper) {
            console.warn('Wrapper não utilizado ou falhou, tentando API direta. Motivo:', eWrapper.message);
        }

        // Tenta executar via API (pode não existir em algumas versões)
        try {
            const result = await n8nApi(`/workflows/${encodeURIComponent(workflowId)}/run`, 'POST', {});
            return res.json(result);
        } catch (eApi) {
            // Fallback: encontrar webhook do workflow e disparar via URL pública
            const detail = await n8nApi(`/workflows/${encodeURIComponent(workflowId)}`, 'GET');
            const webhookNode = (detail?.nodes || []).find((n) => String(n.type||'').includes('webhook'));
            if (!webhookNode) {
                throw new Error('Nenhum node Webhook encontrado neste workflow para fallback');
            }
            const path = webhookNode.parameters?.path || webhookNode.parameters?.pathSegment;
            if (!path) throw new Error('Node Webhook sem path configurado');
            const base = process.env.N8N_WEBHOOK_BASE || process.env.N8N_WEBHOOK_URL?.replace(/\/webhook.*/, '/webhook');
            if (!base) throw new Error('Defina N8N_WEBHOOK_BASE no .env para fallback de execução via webhook');
            const url = `${String(base).replace(/\/$/,'')}/${String(path).replace(/^\//,'')}`;
            const payload = req.body && Object.keys(req.body).length ? req.body : {};
            const resp = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!resp.ok) throw new Error(`Webhook exec falhou: ${resp.status}`);
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) return res.json(await resp.json());
            return res.json({ ok: true, status: resp.status });
        }
    } catch (e) {
        console.error('Erro ao executar workflow n8n:', e.message);
        res.status(500).json({ error: 'Erro ao executar workflow n8n', details: e.message });
    }
});

// Importar template (.json) de workflow diretamente para o n8n
app.post('/api/integrations/n8n/import', async (req, res) => {
    try {
        let template = req.body;
        // Permite importar via URL
        if (!template || Object.keys(template).length === 0) {
            const { templateUrl } = req.query;
            if (!templateUrl) return res.status(400).json({ error: 'Envie JSON no corpo ou informe ?templateUrl=' });
            const fetched = await doFetch(String(templateUrl), { method: 'GET' });
            if (!fetched.ok) return res.status(400).json({ error: `Falha ao baixar template: ${fetched.status}` });
            template = await fetched.json();
        }
        // Normaliza diferentes formatos de template (export do n8n ou payload direto)
        const normalized = (() => {
            // Alguns exports vêm como { workflow: {...} }
            const wf = template.workflow || template;
            // Apenas repassa campos reconhecidos
            return {
                name: wf.name || `workflow-${Date.now()}`,
                active: typeof wf.active === 'boolean' ? wf.active : false,
                nodes: wf.nodes || [],
                connections: wf.connections || {},
                settings: wf.settings || {},
                staticData: wf.staticData || undefined,
                pinData: wf.pinData || undefined,
            };
        })();

        // Cria workflow via API do n8n (rota v1)
        let created;
        let firstError = null;
        try {
            created = await n8nApi('/workflows', 'POST', normalized);
        } catch (eV1) {
            firstError = eV1;
            // Fallback para instâncias antigas que usam /rest
            try {
                created = await n8nApi('/rest/workflows', 'POST', normalized);
            } catch (eRest) {
                const details = {
                    primary: firstError?.message || String(firstError),
                    fallback: eRest?.message || String(eRest)
                };
                throw new Error(`Falha ao criar workflow no n8n. primary=${details.primary}; fallback=${details.fallback}`);
            }
        }
        return res.json({ ok: true, mode: 'create', workflow: created });
    } catch (e) {
        console.error('Erro no import de template n8n:', e.message);
        // Sugestões de diagnóstico comuns
        const hint = !N8N_API_URL || !N8N_API_KEY
            ? 'Verifique N8N_API_URL (deve incluir /api/v1) e N8N_API_KEY no .env.'
            : 'Confirme se o JSON contém nodes e connections válidos (export do n8n).';
        res.status(500).json({ error: 'Erro ao importar template n8n', details: e.message, hint });
    }
});

// Upload/Import do workflow do usuário e persistência de referência por owner
app.post('/api/integrations/n8n/workflows/upload', async (req, res) => {
    const { ownerId } = req.body || {};
    if (!ownerId) return res.status(400).json({ error: 'ownerId é obrigatório' });
    try {
        let template = req.body?.workflowJson || req.body?.template || {};
        if (!template || Object.keys(template).length === 0) {
            const { templateUrl } = req.query;
            if (!templateUrl) return res.status(400).json({ error: 'Envie workflowJson/template no corpo ou informe ?templateUrl=' });
            const fetched = await doFetch(String(templateUrl), { method: 'GET' });
            if (!fetched.ok) return res.status(400).json({ error: `Falha ao baixar template: ${fetched.status}` });
            template = await fetched.json();
        }

        const normalized = (() => {
            const wf = template.workflow || template;
            return {
                name: wf.name || `workflow-${Date.now()}`,
                active: typeof wf.active === 'boolean' ? wf.active : false,
                nodes: wf.nodes || [],
                connections: wf.connections || {},
                settings: wf.settings || {},
                staticData: wf.staticData || undefined,
                pinData: wf.pinData || undefined,
            };
        })();

        let created;
        try {
            created = await n8nApi('/workflows', 'POST', normalized);
        } catch (eV1) {
            created = await n8nApi('/rest/workflows', 'POST', normalized);
        }

        const n8nId = created?.id || created?._id || String(created?.id || '');
        const name = created?.name || normalized.name;
        const active = Boolean(created?.active ?? normalized.active ?? false);

        const neo4jSession = await getSession();
        try {
            const q = `
                MERGE (w:N8nWorkflow { n8nId: $n8nId })
                ON CREATE SET w.createdAt = timestamp()
                SET w.ownerId = $ownerId,
                    w.name = $name,
                    w.active = $active,
                    w.updatedAt = timestamp()
                RETURN w { .n8nId, .ownerId, .name, .active, createdAt: w.createdAt, updatedAt: w.updatedAt } AS ref
            `;
            const r = await neo4jSession.run(q, { n8nId, ownerId, name, active });
            const ref = convertNeo4jProperties(r.records[0].get('ref'));
            return res.json({ ok: true, workflow: created, ref });
        } finally { await closeSession(neo4jSession); }
    } catch (e) {
        console.error('Erro no upload/import e persistência do workflow n8n:', e.message);
        const hint = !N8N_API_URL || !N8N_API_KEY
            ? 'Verifique N8N_API_URL (deve incluir /api/v1) e N8N_API_KEY no .env.'
            : 'Confirme se o JSON contém nodes e connections válidos (export do n8n).';
        res.status(500).json({ error: 'Erro ao importar e vincular workflow n8n', details: e.message, hint });
    }
});

// Listar workflows n8n por ownerId
app.get('/api/integrations/n8n/workflows/owner/:ownerId', async (req, res) => {
    const { ownerId } = req.params;
    const neo4jSession = await getSession();
    try {
        const r = await neo4jSession.run(`
            MATCH (w:N8nWorkflow { ownerId: $ownerId })
            RETURN w { .n8nId, .ownerId, .name, .active, createdAt: w.createdAt, updatedAt: w.updatedAt } AS ref
            ORDER BY coalesce(w.updatedAt, w.createdAt) DESC
        `, { ownerId });
        const items = r.records.map(rec => convertNeo4jProperties(rec.get('ref')));
        res.json(items);
    } catch (e) {
        console.error('Erro ao listar N8nWorkflow por ownerId:', e.message);
        res.status(500).json({ error: 'Erro ao listar workflows do owner', details: e.message });
    } finally { await closeSession(neo4jSession); }
});

// Executar workflow n8n salvo (por n8nId) via wrapper/API/webhook
app.post('/api/integrations/n8n/workflows/:n8nId/run', async (req, res) => {
    const { n8nId } = req.params;
    try {
        // Preferencial: wrapper por webhook
        try {
            if (N8N_WRAPPER_WEBHOOK_URL) {
                const payload = { workflowId: n8nId, input: (req.body && Object.keys(req.body).length ? req.body : {}) };
                const resp = await doFetch(N8N_WRAPPER_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) throw new Error(`Wrapper webhook exec falhou: ${resp.status}`);
                const contentType = resp.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const json = await resp.json();
                    return res.json(json);
                }
                return res.json({ ok: true, status: resp.status });
            }
        } catch (eWrapper) {
            console.warn('Wrapper não utilizado ou falhou, tentando API direta. Motivo:', eWrapper.message);
        }

        // API direta
        try {
            const result = await n8nApi(`/workflows/${encodeURIComponent(n8nId)}/run`, 'POST', {});
            return res.json(result);
        } catch (eApi) {
            // fallback webhook
            const detail = await n8nApi(`/workflows/${encodeURIComponent(n8nId)}`, 'GET');
            const webhookNode = (detail?.nodes || []).find((n) => String(n.type||'').includes('webhook'));
            if (!webhookNode) {
                throw new Error('Nenhum node Webhook encontrado neste workflow para fallback');
            }
            const path = webhookNode.parameters?.path || webhookNode.parameters?.pathSegment;
            if (!path) throw new Error('Node Webhook sem path configurado');
            const base = process.env.N8N_WEBHOOK_BASE || process.env.N8N_WEBHOOK_URL?.replace(/\/webhook.*/, '/webhook');
            if (!base) throw new Error('Defina N8N_WEBHOOK_BASE no .env para fallback de execução via webhook');
            const url = `${String(base).replace(/\/$/,'')}/${String(path).replace(/^\//,'')}`;
            const payload = req.body && Object.keys(req.body).length ? req.body : {};
            const resp = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!resp.ok) throw new Error(`Webhook exec falhou: ${resp.status}`);
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) return res.json(await resp.json());
            return res.json({ ok: true, status: resp.status });
        }
    } catch (e) {
        console.error('Erro ao executar workflow n8n (por n8nId):', e.message);
        res.status(500).json({ error: 'Erro ao executar workflow n8n', details: e.message });
    }
});

// Logs de workflow (por workflow id)
app.get('/api/workflows/:id/logs', async (req, res) => {
    const { id } = req.params;
    const neo4jSession = await getSession();
    try {
        const runs = await neo4jSession.run(`MATCH (r:WorkflowRun) WHERE coalesce(r.wfId, r.wfName) CONTAINS $id RETURN r ORDER BY r.startedAt DESC LIMIT 50`, { id });
        const logs = await neo4jSession.run(`MATCH (l:WorkflowLog) WHERE l.runId IN (MATCH (r:WorkflowRun) WHERE coalesce(r.wfId, r.wfName) CONTAINS $id RETURN r.runId) RETURN l ORDER BY l.startedAt DESC LIMIT 200`, { id });
        res.json({
            runs: runs.records.map(rec => convertNeo4jProperties(rec.get('r').properties)),
            logs: logs.records.map(rec => convertNeo4jProperties(rec.get('l').properties))
        });
    } catch (e) {
        console.error('Erro ao buscar logs de workflow:', e);
        res.status(500).json({ error: 'Erro ao buscar logs' });
    } finally { await closeSession(neo4jSession); }
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
                .*,
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
                pipelineStage: coalesce(l.pipelineStage, 'Novo'),
                stageUpdatedAt: coalesce(l.stageUpdatedAt, l.dtUltimaAtualizacao)
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

app.get('/api/leads/:id/chathistory', async (req, res) => {
    const { id: leadId } = req.params;
    // TODO: Implementar busca do histórico de chat.
    // Isso depende de como/onde o histórico é armazenado (Neo4j, outro DB, logs).
    // Por agora, retornaremos mock.
    console.log(`Buscando histórico de chat para lead ${leadId}`);
    const mockChatHistory = [
        {role: "user", parts: [{text: `Olá, sou o lead ${leadId}. Tenho uma dúvida.`}], timestamp: Date.now() - 7200000},
        {role: "model", parts: [{text: `Olá ${leadId}! Como posso ajudar?`}], timestamp: Date.now() - 7100000},
    ];
    res.json(mockChatHistory);
});


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

// =========================================================================
// 7. Pipeline Kanban - Endpoints
// =========================================================================

// GET estágios do pipeline (tenta do DB, senão fallback)
app.get('/api/pipeline/stages', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (s:PipelineStage)
            RETURN s { .name, .order, wipLimit: s.wipLimit } AS stage
            ORDER BY s.order ASC
        `);
        const stagesFromDb = result.records.map(r => convertNeo4jProperties(r.get('stage')));
        if (stagesFromDb.length > 0) return res.json(stagesFromDb);
        return res.json(DEFAULT_PIPELINE_STAGES);
    } catch (error) {
        console.error('Erro ao buscar estágios do pipeline:', error);
        return res.json(DEFAULT_PIPELINE_STAGES);
    } finally {
        await closeSession(neo4jSession);
    }
});

// Listar leads por estágio (cards da coluna)
app.get('/api/pipeline/leads', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const { stage, search, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const params = { skip: neo4j.int(skip), limit: neo4j.int(parseInt(limit)) };
        let whereClauses = [];
        let matchClauses = ["MATCH (l:Lead)"];

        if (stage) { whereClauses.push("l.pipelineStage = $stage"); params.stage = stage; }
        if (search) { whereClauses.push("toLower(l.nome) CONTAINS toLower($search)"); params.search = search; }

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
                .nivelDeInteresseReuniao,
                .ultimoResumoDaSituacao,
                .dtUltimaAtualizacao,
                .pipelineStage,
                .stageUpdatedAt,
                tags: [(l)-[:TEM_TAG]->(t) | t.nome],
                pains: [(l)-[:TEM_DOR]->(d) | d.nome]
            } AS lead
            ORDER BY coalesce(l.stageUpdatedAt, l.dtUltimaAtualizacao) DESC
            SKIP $skip LIMIT $limit
        `;

        const result = await neo4jSession.run(dataQuery, params);
        const leads = result.records.map(record => {
            const leadData = convertNeo4jProperties(record.get('lead'));
            return {
                id: leadData.idWhatsapp,
                whatsappId: leadData.idWhatsapp,
                name: leadData.nome,
                businessName: leadData.nomeDoNegocio,
                businessType: leadData.tipoDeNegocio,
                meetingInterest: leadData.nivelDeInteresseReuniao,
                lastSummary: leadData.ultimoResumoDaSituacao,
                lastInteraction: leadData.dtUltimaAtualizacao,
                pipelineStage: leadData.pipelineStage || 'Novo',
                stageUpdatedAt: leadData.stageUpdatedAt || leadData.dtUltimaAtualizacao,
                tags: leadData.tags || [],
                pains: leadData.pains || [],
            };
        });
        res.json({ data: leads, page: parseInt(page), limit: parseInt(limit), totalItems, totalPages });
    } catch (error) {
        console.error('Erro ao listar leads por estágio:', error);
        res.status(500).json({ error: 'Erro ao listar leads por estágio' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Atualizar estágio do lead (move no kanban)
app.patch('/api/pipeline/leads/:id/stage', async (req, res) => {
    const { id } = req.params; // idWhatsapp
    const { toStage, by = 'user', rationale = '', confidence = null } = req.body || {};
    if (!toStage) return res.status(400).json({ error: 'toStage é obrigatório' });
    const neo4jSession = await getSession();
    try {
        const now = Date.now();
        const params = { idWhatsapp: id, toStage, by, rationale, confidence, now: neo4j.int(now) };
        const query = `
            MATCH (l:Lead {idWhatsapp: $idWhatsapp})
            WITH l, l.pipelineStage AS fromStage
            SET l.pipelineStage = $toStage,
                l.stageUpdatedAt = $now,
                l.dtUltimaAtualizacao = coalesce(l.dtUltimaAtualizacao, $now)
            WITH l, fromStage
            MERGE (s:PipelineStage { name: $toStage })
              ON CREATE SET s.order = case $toStage
                 when 'Novo' then 1 when 'Qualificado' then 2 when 'Contato Iniciado' then 3 when 'Descoberta' then 4 when 'Proposta' then 5 when 'Agendado' then 6 when 'Seguimento' then 7 when 'Perdido' then 8 when 'Desqualificado' then 9 else 999 end
            CREATE (t:StageTransition {
                from: coalesce(fromStage, 'Desconhecido'),
                to: $toStage,
                at: $now,
                by: $by,
                rationale: $rationale,
                confidence: $confidence
            })
            CREATE (l)-[:HAS_TRANSITION]->(t)
            CREATE (t)-[:TO_STAGE]->(s)
            RETURN l { .idWhatsapp, .pipelineStage, .stageUpdatedAt } AS lead
        `;
        const result = await neo4jSession.run(query, params);
        if (result.records.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });
        const lead = convertNeo4jProperties(result.records[0].get('lead'));
        res.json({ ok: true, lead });
    } catch (error) {
        console.error('Erro ao atualizar estágio do lead:', error);
        res.status(500).json({ error: 'Erro ao atualizar estágio do lead' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Histórico de transições do lead
app.get('/api/pipeline/leads/:id/transitions', async (req, res) => {
    const { id } = req.params; // idWhatsapp
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $id})-[:HAS_TRANSITION]->(t:StageTransition)
            OPTIONAL MATCH (t)-[:TO_STAGE]->(s:PipelineStage)
            RETURN t { .from, .to, .at, .by, .rationale, .confidence, stageOrder: s.order } AS tr
            ORDER BY t.at DESC
            LIMIT 50
        `, { id });
        const transitions = result.records.map(r => convertNeo4jProperties(r.get('tr')));
        res.json(transitions);
    } catch (error) {
        console.error('Erro ao buscar histórico de transições:', error);
        res.status(500).json({ error: 'Erro ao buscar histórico de transições' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Classificar um lead (heurística + LLM opcional se configurado)
app.post('/api/pipeline/classify/:id', async (req, res) => {
    const { id } = req.params;
    const useLLM = Boolean(insightModel); // usa Gemini se disponível
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $id})
            OPTIONAL MATCH (l)-[:TEM_TAG]->(tg:Tag)
            OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
            RETURN l { .*, tags: [(l)-[:TEM_TAG]->(t) | t.nome], pains: [(l)-[:TEM_DOR]->(dr) | dr.nome] } AS lead
        `, { id });
        if (result.records.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });
        const lead = convertNeo4jProperties(result.records[0].get('lead'));

        // Heurística base
        let { toStage, confidence, rationale } = classifyLeadHeuristic(lead);

        // Opcional: LLM para refinar
        if (useLLM) {
            try {
                const prompt = `Classifique o estágio de pipeline para o lead a partir dos dados:
Nome: ${lead.nome || 'N/A'} | Empresa: ${lead.nomeDoNegocio || 'N/A'} | Tipo: ${lead.tipoDeNegocio || 'N/A'}
Interesse Reunião: ${lead.nivelDeInteresseReuniao || 'N/A'} | Último Resumo: ${lead.ultimoResumoDaSituacao || 'N/A'}
Dores: ${(lead.pains || []).join(', ') || 'nenhuma'} | Tags: ${(lead.tags || []).join(', ') || 'nenhuma'}
Estágio atual: ${lead.pipelineStage || 'N/A'}
Estágios válidos: ${DEFAULT_PIPELINE_STAGES.map(s=>s.name).join(', ')}
Retorne JSON: { stage, confidence (0..1), rationale }`;
                const llmResp = await insightModel.generateContent(prompt);
                const text = llmResp.response.text();
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.stage && typeof parsed.confidence === 'number') {
                        // Combina com heurística se LLM for de confiança
                        if (parsed.confidence > confidence) {
                            toStage = parsed.stage;
                            confidence = parsed.confidence;
                            rationale = parsed.rationale || rationale;
                        }
                    }
                }
            } catch (e) {
                console.warn('LLM classify fallback para heurística. Erro:', e.message);
            }
        }

        // Se confiança baixa, não aplica — envia para revisão
        const AUTO_APPLY_THRESHOLD = parseFloat(process.env.KANBAN_AUTO_APPLY_THRESHOLD || '0.75');
        if (confidence < AUTO_APPLY_THRESHOLD) {
            // cria StageTransition pendente de revisão (by='agent', sem alterar pipelineStage)
            const now = neo4j.int(Date.now());
            const createReview = `
                MATCH (l:Lead {idWhatsapp: $id})
                MERGE (s:PipelineStage { name: $toStage })
                  ON CREATE SET s.order = 999
                CREATE (t:StageTransition { from: coalesce(l.pipelineStage, 'Desconhecido'), to: $toStage, at: $now, by: 'agent', rationale: $rationale, confidence: $confidence, needsReview: true })
                CREATE (l)-[:HAS_TRANSITION]->(t)
                CREATE (t)-[:TO_STAGE]->(s)
                RETURN t { .from, .to, .at, .by, .rationale, .confidence, .needsReview } AS tr
            `;
            const r2 = await neo4jSession.run(createReview, { id, toStage, now, rationale, confidence });
            const tr = convertNeo4jProperties(r2.records[0].get('tr'));
            return res.json({ applied: false, review: tr });
        }

        // Confiança alta: aplica mudança
        const apply = await neo4jSession.run(`
            MATCH (l:Lead {idWhatsapp: $id})
            WITH l, l.pipelineStage AS fromStage
            SET l.pipelineStage = $toStage, l.stageUpdatedAt = timestamp(), l.dtUltimaAtualizacao = coalesce(l.dtUltimaAtualizacao, timestamp())
            MERGE (s:PipelineStage { name: $toStage })
              ON CREATE SET s.order = 999
            CREATE (t:StageTransition { from: coalesce(fromStage,'Desconhecido'), to: $toStage, at: timestamp(), by: 'agent', rationale: $rationale, confidence: $confidence })
            CREATE (l)-[:HAS_TRANSITION]->(t)
            CREATE (t)-[:TO_STAGE]->(s)
            RETURN l { .idWhatsapp, .pipelineStage } AS lead
        `, { id, toStage, rationale, confidence });
        const appliedLead = convertNeo4jProperties(apply.records[0].get('lead'));
        res.json({ applied: true, lead: appliedLead });
    } catch (error) {
        console.error('Erro ao classificar lead:', error);
        res.status(500).json({ error: 'Erro ao classificar lead' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Fila de revisão: listar transições pendentes
app.get('/api/pipeline/review-queue', async (req, res) => {
    const neo4jSession = await getSession();
    try {
        const result = await neo4jSession.run(`
            MATCH (l:Lead)-[:HAS_TRANSITION]->(t:StageTransition {needsReview: true})
            OPTIONAL MATCH (t)-[:TO_STAGE]->(s:PipelineStage)
            RETURN {
                leadId: l.idWhatsapp,
                leadName: l.nome,
                currentStage: coalesce(l.pipelineStage, 'Novo'),
                suggestion: t { .from, .to, .at, .by, .rationale, .confidence, .needsReview },
                stageOrder: s.order
            } AS item
            ORDER BY t.at DESC
            LIMIT 100
        `);
        const items = result.records.map(r => convertNeo4jProperties(r.get('item')));
        res.json(items);
    } catch (error) {
        console.error('Erro ao listar fila de revisão:', error);
        res.status(500).json({ error: 'Erro ao listar fila de revisão' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Fila de revisão: aprovar sugestão (aplica estágio sugerido)
app.post('/api/pipeline/review-queue/approve', async (req, res) => {
    const { leadId, toStage } = req.body || {};
    if (!leadId || !toStage) return res.status(400).json({ error: 'leadId e toStage são obrigatórios' });
    const neo4jSession = await getSession();
    try {
        const query = `
            MATCH (l:Lead {idWhatsapp: $leadId})-[:HAS_TRANSITION]->(t:StageTransition {needsReview: true, to: $toStage})
            WITH l, t
            SET t.needsReview = false, t.approved = true, t.reviewedAt = timestamp(), t.reviewedBy = 'user'
            SET l.pipelineStage = $toStage, l.stageUpdatedAt = timestamp()
            RETURN l { .idWhatsapp, .pipelineStage } AS lead, t { .from, .to, .confidence, .rationale, .approved } AS tr
        `;
        const r = await neo4jSession.run(query, { leadId, toStage });
        if (r.records.length === 0) return res.status(404).json({ error: 'Sugestão não encontrada' });
        const lead = convertNeo4jProperties(r.records[0].get('lead'));
        const tr = convertNeo4jProperties(r.records[0].get('tr'));
        res.json({ ok: true, lead, tr });
    } catch (error) {
        console.error('Erro ao aprovar sugestão:', error);
        res.status(500).json({ error: 'Erro ao aprovar sugestão' });
    } finally {
        await closeSession(neo4jSession);
    }
});

// Fila de revisão: recusar sugestão
app.post('/api/pipeline/review-queue/reject', async (req, res) => {
    const { leadId, toStage } = req.body || {};
    if (!leadId || !toStage) return res.status(400).json({ error: 'leadId e toStage são obrigatórios' });
    const neo4jSession = await getSession();
    try {
        const query = `
            MATCH (l:Lead {idWhatsapp: $leadId})-[:HAS_TRANSITION]->(t:StageTransition {needsReview: true, to: $toStage})
            SET t.needsReview = false, t.rejected = true, t.reviewedAt = timestamp(), t.reviewedBy = 'user'
            RETURN t { .from, .to, .confidence, .rationale, .rejected } AS tr
        `;
        const r = await neo4jSession.run(query, { leadId, toStage });
        if (r.records.length === 0) return res.status(404).json({ error: 'Sugestão não encontrada' });
        const tr = convertNeo4jProperties(r.records[0].get('tr'));
        res.json({ ok: true, tr });
    } catch (error) {
        console.error('Erro ao rejeitar sugestão:', error);
        res.status(500).json({ error: 'Erro ao rejeitar sugestão' });
    } finally {
        await closeSession(neo4jSession);
    }
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

        if (tag) { matchClauses.push("MATCH (l)-[:TEM_TAG]->(tg:Tag)"); whereClauses.push("tg.nome = $tag"); params.tag = tag; }
        if (dor) { matchClauses.push("MATCH (l)-[:TEM_DOR]->(dr:Dor)"); whereClauses.push("dr.nome = $dor"); params.dor = dor; }

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
                .pipelineStage,
                .stageUpdatedAt,
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
                pipelineStage: leadData.pipelineStage || 'Novo',
                stageUpdatedAt: leadData.stageUpdatedAt || leadData.dtUltimaAtualizacao,
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

