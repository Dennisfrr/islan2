// toolsEngine.js
const neo4j = require('neo4j-driver');
const { TOOLS } = require('./toolsRegistry');
const { dispatchToCRM, CRM_ORGANIZATION_ID } = require('./crmBridge');
function isLeadNotFoundError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('lead_not_found') || msg.includes('404');
}
const { getSession } = require('./db_neo4j');

// Controle simples de cooldown por tool+lead em memória
const lastRunByToolLead = new Map(); // key: `${toolId}::${leadId}` → timestamp

/**
 * Avalia e executa tools com base em um evento/ctx.
 * @param {{ eventType: string, leadProfile?: any, reflectionResult?: any, threshold?: number }} context
 */
async function evaluateAndRunTools(context) {
  const dynamic = await loadToolsFromDb();
  const combined = [...dynamic, ...TOOLS];
  const applicable = combined.filter(t => t.enabled && Array.isArray(t.eventTypes) && t.eventTypes.includes(context.eventType));
  for (const tool of applicable) {
    try {
      const result = tool.trigger(context) || { shouldFire: false };
      if (!result.shouldFire) continue;
      await tool.action(context, result, { neo4j, getSession });
    } catch (e) {
      console.error(`[ToolsEngine] Erro ao executar tool ${tool.id}:`, e);
    }
  }
}

function getRegisteredTools() {
  return TOOLS.map(t => ({ id: t.id, name: t.name, description: t.description, enabled: t.enabled, eventTypes: t.eventTypes, threshold: t.threshold }));
}

async function loadToolsFromDb() {
  try {
    const session = await getSession();
    try {
      const r = await session.run(`MATCH (t:Tool { enabled: true }) RETURN t`);
      return r.records.map(rec => {
        const t = rec.get('t').properties;
        // Normaliza tipos
        const eventTypes = Array.isArray(t.eventTypes) ? t.eventTypes : [];
        const threshold = typeof t.threshold === 'number' ? t.threshold : parseFloat(t.threshold || '0.75');
        const config = safeParseJson(t.configJson);
        return buildDynamicTool(t.id, t.name, t.description, eventTypes, threshold, t.type, config);
      });
    } finally { await session.close(); }
  } catch (e) {
    console.warn('[ToolsEngine] Falha ao carregar tools do DB:', e.message);
    return [];
  }
}

function safeParseJson(str) { try { return str ? JSON.parse(str) : {}; } catch { return {}; } }

function getLeadKeyFromContext(ctx) {
  return (ctx && (ctx.leadProfile?.idWhatsapp || ctx.payload?.leadId || ctx.leadId)) || 'global';
}

function isOnCooldown(toolId, leadKey, cooldownMs) {
  if (!cooldownMs || cooldownMs <= 0) return false;
  const key = `${toolId}::${leadKey}`;
  const last = lastRunByToolLead.get(key) || 0;
  return Date.now() - last < cooldownMs;
}

function markRun(toolId, leadKey) {
  const key = `${toolId}::${leadKey}`;
  lastRunByToolLead.set(key, Date.now());
}

function evaluateActivationExpr(expr, ctx) {
  try {
    // AVISO: Expressão avaliada via Function, similar ao workflowsEngine (MVP). Use com cuidado.
    const fn = new Function(
      'eventType', 'leadProfile', 'reflectionResult', 'messageText',
      `return (${expr});`
    );
    const messageText = ctx?.payload?.messageText || ctx?.messageText || '';
    return !!fn(ctx?.eventType, ctx?.leadProfile, ctx?.reflectionResult, messageText);
  } catch (e) {
    console.warn('[ToolsEngine] activationExpr falhou:', e?.message || e);
    return false;
  }
}

function buildContextBody(ctx, cfg) {
  const base = (cfg && (cfg.body || cfg.staticBody)) ? JSON.parse(JSON.stringify(cfg.body || cfg.staticBody)) : {};
  if (!cfg || !cfg.sendContext) return base;
  const allow = Array.isArray(cfg.contextFields) && cfg.contextFields.length > 0 ? new Set(cfg.contextFields) : null;
  const include = (name) => !allow || allow.has(name);
  if (include('eventType')) base.eventType = ctx?.eventType;
  if (include('leadProfile')) base.leadProfile = ctx?.leadProfile;
  if (include('reflectionResult')) base.reflectionResult = ctx?.reflectionResult;
  if (include('messageText')) base.messageText = ctx?.payload?.messageText || ctx?.messageText;
  return base;
}

function buildDynamicTool(id, name, description, eventTypes, threshold, type, config) {
  // Tipos suportados: 'http', 'pipeline'
  if (type === 'http') {
    return {
      id, name, description, enabled: true, eventTypes, threshold,
      trigger: (ctx) => {
        const leadKey = getLeadKeyFromContext(ctx);
        const cooldownMs = Number(config.cooldownMs || 0);
        let should = false;
        if (config && typeof config.activationExpr === 'string' && config.activationExpr.trim().length > 0) {
          should = evaluateActivationExpr(config.activationExpr, ctx);
        } else {
          should = !!config.fireAlways;
        }
        if (should && isOnCooldown(id, leadKey, cooldownMs)) {
          should = false;
        }
        const confidence = config.confidence || threshold;
        return { shouldFire: should, confidence, payload: { ...config, __leadKey: leadKey } };
      },
      action: async (ctx, { payload }) => {
        const fetch = (await import('node-fetch')).default;
        const method = (payload.method || 'POST').toUpperCase();
        const headers = payload.headers || { 'Content-Type': 'application/json' };
        const bodyObj = buildContextBody(ctx, payload);
        const body = method === 'GET' ? undefined : JSON.stringify(bodyObj);
        const res = await fetch(payload.url, { method, headers, body });
        if (!res.ok) throw new Error(`HTTP tool ${id} falhou: ${res.status}`);
        // marca cooldown após sucesso
        try { if (payload.__leadKey) markRun(id, payload.__leadKey); } catch {}
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const json = await res.json();
          return json;
        }
        const text = await res.text();
        return { text };
      }
    };
  }
  if (type === 'pipeline') {
    return {
      id, name, description, enabled: true, eventTypes, threshold,
      trigger: (ctx) => {
        const toStage = config.toStage;
        if (!toStage) return { shouldFire: false, confidence: 0 };
        return { shouldFire: true, confidence: config.confidence || threshold, payload: { toStage, rationale: config.rationale || 'tool:pipeline' } };
      },
      action: async (ctx, { payload }, { getSession }) => {
        const session = await getSession();
        try {
          await session.run(`
            MATCH (l:Lead {idWhatsapp: $id})
            WITH l, l.pipelineStage AS fromStage
            SET l.pipelineStage = $toStage, l.stageUpdatedAt = timestamp(), l.dtUltimaAtualizacao = coalesce(l.dtUltimaAtualizacao, timestamp())
            MERGE (s:PipelineStage { name: $toStage })
            CREATE (t:StageTransition { from: coalesce(fromStage,'Desconhecido'), to: $toStage, at: timestamp(), by: 'agent', rationale: $rationale, confidence: $confidence })
            CREATE (l)-[:HAS_TRANSITION]->(t)
            CREATE (t)-[:TO_STAGE]->(s)
          `, { id: ctx.leadProfile?.idWhatsapp, toStage: payload.toStage, rationale: payload.rationale, confidence: ctx.threshold || threshold });
        } finally { await session.close(); }
        // Best-effort notify CRM intents
        try {
          const phone = String(ctx.leadProfile?.idWhatsapp || '').replace(/\D/g, '');
          // simple mapping similar to toolsRegistry
          const v = String(payload.toStage || '').toLowerCase();
          const toStageId = v.includes('proposta') ? 'proposal'
            : v.includes('agend') ? 'negotiation'
            : v.includes('qualific') ? 'qualified'
            : (v.includes('perd') || v.includes('lost')) ? 'closed-lost'
            : (v.includes('ganh') || v.includes('won')) ? 'closed-won'
            : 'qualified';
          await dispatchToCRM('move_lead', {
            phone,
            toStageId,
            organization_id: CRM_ORGANIZATION_ID || undefined,
          });
        } catch (e) {
          console.warn('[toolsEngine] dispatch move_lead failed:', e?.message || e);
          if (isLeadNotFoundError(e)) {
            try {
              await dispatchToCRM('create_lead', {
                name: ctx.leadProfile?.nomeDoLead || 'Lead',
                company: ctx.leadProfile?.nomeDoNegocio || '—',
                phone: String(ctx.leadProfile?.idWhatsapp || '').replace(/\D/g, ''),
                organization_id: CRM_ORGANIZATION_ID || undefined,
                status: 'new',
                source: 'whatsapp-agent'
              });
              const phone = String(ctx.leadProfile?.idWhatsapp || '').replace(/\D/g, '');
              await dispatchToCRM('move_lead', { phone, toStageId, organization_id: CRM_ORGANIZATION_ID || undefined });
            } catch (e2) {
              console.warn('[toolsEngine] create_lead/move retry failed:', e2?.message || e2);
            }
          }
        }
      }
    };
  }
  // Default no-op
  return { id, name, description, enabled: true, eventTypes, threshold, trigger: () => ({ shouldFire: false, confidence: 0 }), action: async () => {} };
}

async function runToolById(id, payload = {}) {
  const dynamic = await loadToolsFromDb();
  const combined = [...dynamic, ...TOOLS];
  const tool = combined.find(t => t.id === id && t.enabled);
  if (!tool) throw new Error('Tool não encontrada ou desabilitada');
  const ctx = { eventType: 'manual', leadProfile: payload.leadProfile, threshold: payload.threshold };
  const trig = tool.trigger({ ...ctx, payload });
  if (!trig.shouldFire) return { fired: false };
  const result = await tool.action({ ...ctx, payload }, trig, { neo4j, getSession });
  return { fired: true, result };
}

module.exports = { evaluateAndRunTools, getRegisteredTools, runToolById };


