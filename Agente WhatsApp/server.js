const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || process.env.WA_AGENT_PORT || process.env.DASHBOARD_PORT || 3005;

app.use(cors());
app.use(express.json());
// Resolve organization_id from header/query/env
app.use((req, _res, next) => {
  const headerOrg = req.headers['x-organization-id']
  const queryOrg = req.query && (req.query.organization_id || req.query.org)
  const envOrg = process.env.CRM_ORGANIZATION_ID
  const org = (headerOrg || queryOrg || envOrg || '').toString().trim()
  req.organization_id = org || null
  next()
})

// Optional simple key auth
function checkKey(req, res, next) {
  const configured = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || '';
  if (!configured) return next();
  const provided = req.headers['x-agent-key'];
  if (configured && provided && String(provided) === String(configured)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Lazy imports to avoid heavy init on boot
let cachedExports = null;
function getAgentExports() {
  if (cachedExports) return cachedExports;
  try {
    cachedExports = require('./index.js');
  } catch (e) {
    cachedExports = {};
  }
  return cachedExports;
}

app.get('/api/wa/health', (_req, res) => {
  res.json({ ok: true, service: 'wa-agent', ts: Date.now() });
});

// Generic health path for PaaS
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wa-agent', port: PORT });
});

// Expor QR atual (quando disponível) para onboarding 1-clique
app.get('/api/wa/qr', checkKey, (_req, res) => {
  try {
    const { getLatestQR } = getAgentExports();
    const v = typeof getLatestQR === 'function' ? getLatestQR() : null;
    if (!v) return res.status(204).end();
    res.json(v);
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// Status de sessão do WhatsApp (reflete statusFind)
app.get('/api/wa/status', checkKey, (_req, res) => {
  try {
    const { getLatestWppStatus } = getAgentExports();
    const v = typeof getLatestWppStatus === 'function' ? getLatestWppStatus() : { status: 'unknown' };
    res.json(v);
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// Admin: configurar organização/credenciais (sem restart)
app.post('/api/admin/enroll', checkKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { setOrg, getOrg } = require('./orgConfig');
    const updated = setOrg({
      organization_id: body.organization_id || body.org || undefined,
      crm_base_url: body.crm_base_url || body.crm_url || undefined,
      crm_agent_key: body.crm_agent_key || undefined,
      crm_bearer: body.crm_bearer || undefined
    });
    res.json({ ok: true, organization: updated });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/admin/info', checkKey, (_req, res) => {
  try {
    const { getOrg } = require('./orgConfig');
    res.json({ ok: true, organization: getOrg() });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.get('/api/wa/session/status', (_req, res) => {
  try {
    const wppconnect = require('@wppconnect-team/wppconnect');
    const clients = (wppconnect && wppconnect.clientsArray) || [];
    const statuses = clients.map((c) => ({ session: c.session || 'unknown', connected: !!c.page, user: c?.user?.id || null }));
    res.json({ sessions: statuses });
  } catch (e) {
    res.json({ sessions: [] });
  }
});

// Core dispatch endpoint used by FollowUpScheduler
// Body example: { name: 'generate_and_send', lead: { waJid }, objective, text?, constraints, cta, abTest, metadata }
app.post('/api/wa/dispatch', checkKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { lead = {}, objective, text: explicitText, constraints, cta, abTest, metadata } = body;
    const waJid = lead.waJid || lead.id || lead.whatsappId;
    if (!waJid || (!objective && !explicitText)) return res.status(400).json({ error: 'waJid_and_text_or_objective_required' });

    // Build message text
    const agentName = process.env.NOME_DO_AGENTE || 'Leo Consultor';
    const maxChars = (constraints && constraints.maxChars) ? Number(constraints.maxChars) : 420;
    let text = explicitText && String(explicitText).trim().length > 0
      ? String(explicitText)
      : `${agentName}: ${objective}`;
    if (!explicitText && cta && cta.text) text += `\n${cta.text}`;
    text = String(text).slice(0, Math.max(60, Math.min(1024, maxChars)));

    // Reuse index.js helper for send + persist
    const { sendWhatsAppText } = getAgentExports();
    if (typeof sendWhatsAppText !== 'function') return res.status(503).json({ error: 'send_helper_unavailable' });
    await sendWhatsAppText(waJid, text, { leadName: lead.name || 'Lead' });

    return res.json({ status: 'SENT', variant: abTest ? 'B' : 'A', metadata: metadata || null });
  } catch (e) {
    console.error('[wa/dispatch] error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Pre-meeting briefing endpoint
app.get('/api/wa/premeeting/brief', checkKey, async (req, res) => {
  try {
    const leadId = String(req.query.leadId || '').trim();
    if (!leadId) return res.status(400).json({ error: 'leadId_required' });
    const { generatePreMeetingBrief } = getAgentExports();
    if (typeof generatePreMeetingBrief !== 'function') return res.status(503).json({ error: 'brief_helper_unavailable' });
    const data = await generatePreMeetingBrief(leadId);
    return res.json({ ok: true, brief: data });
  } catch (e) {
    console.error('[wa/premeeting/brief] error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Generate follow-up message based on profile + last messages (LLM if available; template fallback)
app.post('/api/wa/followup/generate', checkKey, async (req, res) => {
  try {
    const { leadId, objective, maxChars = 420 } = req.body || {};
    const waId = String(leadId || '').trim();
    if (!waId) return res.status(400).json({ error: 'leadId_required' });

    const { getSession } = require('./db_neo4j');
    const session = await getSession();
    let profile = null; let lastMessages = [];
    try {
      const r1 = await session.run(`
        MATCH (l:Lead { idWhatsapp: $id })
        OPTIONAL MATCH (l)-[:TEM_DOR]->(d:Dor)
        OPTIONAL MATCH (l)-[:TEM_INTERESSE]->(i:Interesse)
        RETURN l { .*, name: coalesce(l.nome, ''), pains: collect(DISTINCT d.nome), interests: collect(DISTINCT i.nome) } AS lead
      `, { id: waId });
      profile = r1.records[0] ? r1.records[0].get('lead') : null;
      const r2 = await session.run(`
        MATCH (l:Lead { idWhatsapp: $id })-[:HAS_MESSAGE]->(m:Message)
        RETURN m.role AS role, m.text AS text, m.at AS at
        ORDER BY m.at DESC LIMIT 6
      `, { id: waId });
      lastMessages = r2.records.map(rec => ({ role: rec.get('role'), text: rec.get('text') || '', at: Number(rec.get('at') || 0) })).reverse();
    } finally { await session.close(); }

    const agentName = process.env.NOME_DO_AGENTE || 'Leo Consultor';
    const firstName = (profile && (profile.name || '')).split(' ')[0] || 'Tudo bem';
    const painHint = Array.isArray(profile?.pains) && profile.pains.length ? String(profile.pains[0]) : null;
    const recentUserText = lastMessages.filter(m => m.role === 'user').map(m => m.text).filter(Boolean).slice(-2).join(' ');

    let text = '';
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const key = process.env.GEMINI_API_KEY;
      if (key) {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_NAME || 'gemini-1.5-flash-latest', generationConfig: { temperature: 0.4, maxOutputTokens: 180 } });
        const sys = `Gere uma mensagem curta de follow-up em pt-BR para WhatsApp (<= ${Number(maxChars)} chars), gentil e consultiva, assinada implicitamente por ${agentName}. Personalize com base no perfil e últimas mensagens. 1-2 frases no máximo.`;
        const prompt = `${sys}\n\nPerfil: ${JSON.stringify({ name: profile?.name || '', pains: profile?.pains || [], interests: profile?.interests || [], lastSummary: profile?.ultimoResumoDaSituacao || null, businessType: profile?.tipoDeNegocio || null })}\nÚltimas mensagens do lead: ${recentUserText || '(sem histórico)'}${objective ? `\nObjetivo do follow-up: ${objective}` : ''}\n\nMensagem:`;
        const r = await model.generateContent([{ text: prompt }]);
        const out = (r?.response?.text?.() || '').trim();
        text = out || '';
      }
    } catch {}

    if (!text) {
      // Template fallback
      try {
        const fs = require('fs'); const path = require('path');
        const p = path.join(__dirname, 'followupTemplates.json');
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        const stage = (profile?.pipelineStage || profile?.nivelDeInteresseReuniao || '').toString().toLowerCase();
        let tpl = arr.find(t => String(t.stage || '').toLowerCase() === (stage.includes('proposta') ? 'proposal' : stage.includes('negoci') ? 'negotiation' : 'cold'))
               || arr.find(t => t.id === 'negotiation_default')
               || arr[0];
        const vars = {
          firstName,
          agentName,
          painHint: painHint || 'o que conversamos',
        };
        text = String(tpl.template)
          .replace(/\{\{\s*firstName\s*\}\}/g, vars.firstName)
          .replace(/\{\{\s*agentName\s*\}\}/g, vars.agentName)
          .replace(/\{\{\s*painHint\s*\}\}/g, vars.painHint);
      } catch {
        // Ultimate fallback
        text = `${firstName}, conseguimos avançar? Posso te ajudar a tirar dúvidas sobre ${painHint || 'o que conversamos'}.`;
      }
    }

    text = String(text).slice(0, Math.max(60, Math.min(1024, Number(maxChars))));
    return res.json({ text });
  } catch (e) {
    console.error('[wa/followup/generate] error:', e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[WA-API] WhatsApp Agent API running on port ${PORT}`);
});
