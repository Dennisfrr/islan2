import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const app = express()
app.use(morgan('tiny'))
// Use raw body for webhook endpoints to verify signatures
app.use('/webhooks', express.raw({ type: '*/*', limit: '2mb' }))
// JSON parser for regular API endpoints
app.use(express.json({ limit: '2mb' }))

// __dirname shim for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3000

// Base do CRM para proxy de endpoints não presentes neste servidor
const CRM_HTTP_BASE = process.env.CRM_HTTP_BASE || `http://localhost:${process.env.DASHBOARD_PORT_CRM || 3007}`
const WA_AGENT_BASE = process.env.WA_AGENT_BASE_URL || `http://localhost:${process.env.WA_AGENT_PORT || process.env.DASHBOARD_PORT || 3005}`

async function proxyToCRM(req, res, targetPath) {
  try {
    const url = `${String(CRM_HTTP_BASE).replace(/\/$/, '')}${targetPath}`
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' }
    // Copia Authorization se houver
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization
    const init = { method: req.method, headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
    }
    const r = await fetch(url, init)
    const text = await r.text()
    res.status(r.status)
    try { res.type(r.headers.get('content-type') || 'application/json') } catch {}
    return res.send(text)
  } catch (e) {
    console.error('[proxyToCRM] error', e)
    return res.status(502).json({ error: 'bad_gateway' })
  }
}

async function proxyToWA(req, res, targetPath) {
  try {
    const url = `${String(WA_AGENT_BASE).replace(/\/$/, '')}${targetPath}`
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' }
    if (req.headers['x-agent-key']) headers['X-Agent-Key'] = req.headers['x-agent-key']
    const envKey = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY
    if (envKey && !headers['X-Agent-Key']) headers['X-Agent-Key'] = String(envKey)
    if (req.headers['idempotency-key']) headers['Idempotency-Key'] = String(req.headers['idempotency-key'])
    // Add request signature (HMAC) + nonce to protect integrity/replay
    try {
      const secret = String(process.env.AGENT_SIGNING_SECRET || '')
      const nonce = crypto.randomBytes(12).toString('hex')
      const ts = Math.floor(Date.now() / 1000)
      const bodyStr = (req.method === 'GET' || req.method === 'HEAD') ? '' : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}))
      const base = `${req.method}\n${targetPath}\n${ts}\n${nonce}\n${bodyStr}`
      const sig = secret ? crypto.createHmac('sha256', secret).update(base).digest('hex') : ''
      if (sig) {
        headers['X-Req-Nonce'] = nonce
        headers['X-Req-Timestamp'] = String(ts)
        headers['X-Req-Signature'] = `sha256=${sig}`
      }
    } catch {}
    const init = { method: req.method, headers }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
    }
    const r = await fetch(url, init)
    const text = await r.text()
    res.status(r.status)
    try { res.type(r.headers.get('content-type') || 'application/json') } catch {}
    return res.send(text)
  } catch (e) {
    console.error('[proxyToWA] error', e)
    return res.status(502).json({ error: 'bad_gateway' })
  }
}
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const ALLOWED_ORIGINS = String(CORS_ORIGIN)
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
// URL pública para montar links de redirecionamento em mensagens de convite/confirmacao
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (ALLOWED_ORIGINS.find(o => o !== '*') || '')

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true) // requests sem origin (ex.: curl, servidores)
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    return cb(new Error('CORS: Origin not allowed'))
  },
}))

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[server] SUPABASE_URL/VITE_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes no .env')
  process.exit(1)
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// removed duplicate getUserFromAuthHeader (use the one with supabaseAdmin.auth.getUser below)

async function getUserOrgId(userId) {
  try {
    const { data } = await supabaseAdmin.from('organization_members').select('organization_id').eq('user_id', userId).limit(1).maybeSingle()
    return data?.organization_id || null
  } catch { return null }
}

async function insertAuditLog({ organization_id, user_id, action, resource_type, resource_id, payload, ip, user_agent }) {
  try {
    await supabaseAdmin.from('audit_logs').insert({ organization_id, user_id, action, resource_type, resource_id, payload, ip, user_agent })
  } catch (e) { /* ignore */ }
}

// ================================
// Agent process manager (Agente WhatsaApp)
// ================================
let agentProcess = null
let agentStartedAt = null
let agentLastExit = { code: null, signal: null, at: null }

function getAgentDir() {
  // Agent folder is at project root, not under server/
  const override = process.env.AGENT_DIR && String(process.env.AGENT_DIR).trim()
  if (override && fs.existsSync(override)) return override
  const candidate1 = path.join(__dirname, '..', 'Agente WhatsaApp Matheus')
  if (fs.existsSync(candidate1)) return candidate1
  const candidate2 = path.join(__dirname, '..', 'Agente WhatsaApp')
  return candidate2
}

function isAgentRunning() {
  return Boolean(agentProcess && !agentProcess.killed)
}

function getAgentHttpBase() {
  // Alinha com WA_AGENT_BASE para garantir que os proxies alcancem a API correta do agente
  return String(WA_AGENT_BASE).replace(/\/$/, '')
}

app.get('/api/agent/status', async (req, res) => {
  return res.json({ running: isAgentRunning(), pid: agentProcess?.pid || null, startedAt: agentStartedAt, lastExit: agentLastExit })
})

// Get agent policy (for dashboard or agent)
app.get('/api/agent/policy', async (req, res) => {
  try {
    const xKey = String(req.headers['x-agent-key'] || '')
    const envKey = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY || ''
    const hasAgentKey = envKey && xKey && xKey === envKey
    let uid = null
    if (!hasAgentKey) {
      const u = await getUserFromAuthHeader(req)
      if (!u?.id) return res.status(401).json({ error: 'unauthorized' })
      uid = u.id
    }
    const organizationId = String(req.query.organization_id || '') || (uid ? await getUserOrgId(uid) : '')
    if (!organizationId) return res.status(400).json({ error: 'organization_id_required' })
    const { data, error } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', organizationId)
      .eq('key', 'agent_policy')
      .maybeSingle()
    if (error) return res.status(500).json({ error: 'db_error' })
    const defaults = {
      autopilotLevel: 'suggest',
      cadencePerLeadPerDay: 1,
      allowedHours: '09:00-18:00',
      tonePolicy: 'consultivo',
      disallowedTerms: '',
      allowedChannels: { whatsapp: true, email: false, sms: false },
      approvalRequired: { dispatch: false, contract: true, quote: false },
    }
    const merged = { ...defaults, ...(data?.value || {}) }
    return res.json({ organization_id: organizationId, policy: merged })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

app.post('/api/agent/start', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    if (isAgentRunning()) return res.json({ ok: true, alreadyRunning: true, pid: agentProcess.pid })
    const cwd = getAgentDir()
    if (!fs.existsSync(path.join(cwd, 'index.js'))) return res.status(500).json({ error: 'agent_index_not_found', cwd })
    const env = { ...process.env }
    if (!env.AGENT_HTTP_PORT) env.AGENT_HTTP_PORT = String(process.env.AGENT_HTTP_PORT || 3101)
    agentProcess = spawn(process.execPath, ['index.js'], { cwd, env, stdio: 'pipe', windowsHide: true })
    agentStartedAt = new Date().toISOString()
    agentLastExit = { code: null, signal: null, at: null }
    agentProcess.stdout?.on('data', d => { try { process.stdout.write(`[agent] ${d}`) } catch {} })
    agentProcess.stderr?.on('data', d => { try { process.stderr.write(`[agent:err] ${d}`) } catch {} })
    agentProcess.on('exit', (code, signal) => { agentLastExit = { code, signal, at: new Date().toISOString() } })
    return res.json({ ok: true, pid: agentProcess.pid, startedAt: agentStartedAt })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: emoção do lead do Agente (estado atual)
app.get('/api/agent/lead-emotion', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const waId = String(req.query.waId || req.query.whatsapp_id || req.query.id || '')
    const phone = String(req.query.phone || '').replace(/\D/g, '')
    if (!waId && !phone) return res.status(400).json({ error: 'waId_or_phone_required' })
    const id = waId || (phone ? `${phone}@c.us` : '')
    const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(id)}/emotion`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json(j)
    return res.json(j)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: requisitar refresh assíncrono da emoção no Agente
app.post('/api/agent/lead-emotion/refresh', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const waId = String(req.body?.waId || req.query?.waId || '')
    const phone = String(req.body?.phone || req.query?.phone || '').replace(/\D/g, '')
    if (!waId && !phone) return res.status(400).json({ error: 'waId_or_phone_required' })
    const id = waId || (phone ? `${phone}@c.us` : '')
    const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(id)}/emotion/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json(j)
    // Audit
    try { await insertAuditLog({ organization_id: await getUserOrgId(user.id), user_id: user.id, action: 'agent.emotion.refresh', resource_type: 'lead', resource_id: id, payload: { by: user.id } }) } catch {}
    return res.json(j)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: Pré-call (últimas mensagens + 3 perguntas sugeridas)
app.get('/api/agent/precall', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const waId = String(req.query.waId || req.query.whatsapp_id || req.query.id || '')
    const phone = String(req.query.phone || '').replace(/\D/g, '')
    if (!waId && !phone) return res.status(400).json({ error: 'waId_or_phone_required' })
    const id = waId || (phone ? `${phone}@c.us` : '')
    const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(id)}/precall`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json(j)
    return res.json(j)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})
app.post('/api/agent/stop', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    if (!isAgentRunning()) return res.json({ ok: true, alreadyStopped: true })
    try { agentProcess.kill('SIGINT') } catch {}
    setTimeout(() => { try { if (isAgentRunning()) agentProcess.kill('SIGKILL') } catch {} }, 2000)
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: Perfil do lead do Agente (via dashboard do agente)
app.get('/api/agent/lead-profile', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const waId = String(req.query.waId || req.query.whatsapp_id || req.query.id || '')
    const phone = String(req.query.phone || '').replace(/\D/g, '')
    if (!waId && !phone) return res.status(400).json({ error: 'waId_or_phone_required' })
    const id = waId || (phone ? `${phone}@c.us` : '')
    const base = getAgentHttpBase()
    const url = `${base}/api/leads/${encodeURIComponent(id)}`
    const r = await fetch(url, { headers: {} })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json(j)
    return res.json(j)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: disparar análise de perfil via agente (Gemini)
app.post('/api/agent/lead-profile/refresh', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const waId = String(req.body?.waId || req.query?.waId || '')
    const phone = String(req.body?.phone || req.query?.phone || '').replace(/\D/g, '')
    if (!waId && !phone) return res.status(400).json({ error: 'waId_or_phone_required' })
    const id = waId || (phone ? `${phone}@c.us` : '')
    const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(id)}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json(j)
    // Audit
    try { await insertAuditLog({ organization_id: await getUserOrgId(user.id), user_id: user.id, action: 'agent.profile.refresh', resource_type: 'lead', resource_id: id, payload: { by: user.id } }) } catch {}
    return res.json({ ok: true, result: j })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Sugestão de follow-up: gera um texto curto e objetivo para enviar ao lead
app.post('/api/agent/suggest-followup', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const { lead_id } = req.body || {}
    if (!lead_id) return res.status(400).json({ error: 'lead_id_required' })

    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', String(lead_id))
      .maybeSingle()
    if (!lead) return res.status(404).json({ error: 'lead_not_found' })

    // Tenta obter perfil do agente por telefone para enriquecer contexto
    let agentProfile = null
    try {
      const digits = String(lead.phone || '').replace(/\D/g, '')
      if (digits) {
        const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(digits + '@c.us')}`)
        if (r.ok) agentProfile = await r.json().catch(() => null)
      }
    } catch {}

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'missing_gemini_key' })
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'

    const profile = {
      nome: lead.name,
      empresa: lead.company,
      telefone: lead.phone,
      valor: lead.value,
      status: lead.status,
      dores: agentProfile?.pains || agentProfile?.principaisDores || [],
      resumo: agentProfile?.lastSummary || agentProfile?.ultimoResumoDaSituacao || null,
      emocao: agentProfile?.emotionalState || null
    }

    const system = `Você é um assistente de CRM. Gere um texto curto e objetivo (máx. 400 caracteres) para follow-up por WhatsApp, em tom profissional e amigável. Use dados do perfil quando existir. Responda APENAS JSON no formato { sugestao: string, observacao?: string }.`
    const contents = [
      { role: 'user', parts: [{ text: system }] },
      { role: 'user', parts: [{ text: `Perfil: ${JSON.stringify(profile)}` }] }
    ]
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 200 } })
    })
    const js = await resp.json().catch(() => ({}))
    if (!resp.ok) return res.status(502).json({ error: 'gemini_error', details: js })
    const text = js?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    const sugestao = String(parsed?.sugestao || parsed?.text || text || '').slice(0, 600)
    const observacao = typeof parsed?.observacao === 'string' ? parsed.observacao : null

    return res.json({ sugestao, observacao })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Heurístico: AI Score do Lead (0-100) com bucket A/B/C
const __aiScoreCache = new Map(); // key: lead_id -> { score, bucket, reasons, at }
const __agentProfileCache = new Map(); // key: phoneDigits -> { emotionalState, decisionProfile, at }
app.get('/api/leads/ai-score', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const leadId = String(req.query.lead_id || '')
    if (!leadId) return res.status(400).json({ error: 'lead_id_required' })
    const cache = __aiScoreCache.get(leadId)
    const now = Date.now()
    if (cache && (now - cache.at < 15 * 60 * 1000)) return res.json(cache)

    // Carrega lead básico
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle()
    if (!lead) return res.status(404).json({ error: 'lead_not_found' })

    // Busca perfil IA via agente (se tiver phone)
    let profile = null
    if (lead.phone) {
      try {
        const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(String(lead.phone).replace(/\D/g, '') + '@c.us')}`)
        profile = await r.json().catch(() => null)
      } catch {}
    }

    // Heurística simples
    let score = 50
    const reasons = []
    const pain = (profile?.pains || profile?.principaisDores || [])[0]
    const meeting = String(profile?.meetingInterest || profile?.nivelDeInteresseReuniao || '').toLowerCase()
    const lastSummary = String(profile?.lastSummary || profile?.ultimoResumoDaSituacao || '')
    const tags = Array.isArray(profile?.tags) ? profile.tags : []

    if (meeting.includes('agend')) { score += 25; reasons.push('Interesse em reunião agendado') }
    else if (meeting.includes('alto') || meeting.includes('sim')) { score += 15; reasons.push('Alto interesse declarado') }
    if (pain) { score += 10; reasons.push(`Dor clara: ${pain}`) }
    if (/proposta|orçamento|orcamento|valor/i.test(lastSummary)) { score += 10; reasons.push('Resumo menciona proposta/valor') }
    if (tags.includes('hot-lead')) { score += 10; reasons.push('Tag hot-lead') }
    score = Math.max(0, Math.min(100, score))
    const bucket = score >= 80 ? 'A' : (score >= 65 ? 'B' : 'C')
    const out = { score, bucket, reasons, at: now }
    __aiScoreCache.set(leadId, out)
    return res.json(out)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Pipeline Health: métricas por coluna + recomendações simples
app.get('/api/pipeline/health', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const orgId = String(req.query.organization_id || '')
    if (!orgId) return res.status(400).json({ error: 'organization_id_required' })
    // Puxa leads da org
    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('id,status,value,updated_at,last_contact')
      .eq('organization_id', orgId)
    const byStage = new Map()
    for (const l of (leads || [])) {
      const s = String(l.status || 'new')
      if (!byStage.has(s)) byStage.set(s, [])
      byStage.get(s).push(l)
    }
    const now = Date.now()
    const stages = Array.from(byStage.keys())
    const out = stages.map((s) => {
      const arr = byStage.get(s) || []
      const count = arr.length
      const avgAgeDays = count ? Math.round(arr.reduce((sum, l) => {
        const ts = l.updated_at ? Date.parse(l.updated_at) : now
        return sum + Math.max(0, (now - ts) / (1000*60*60*24))
      }, 0) / count) : 0
      const totalValue = arr.reduce((sum, l) => sum + Number(l.value || 0), 0)
      // Proxy simples para "taxa de resposta" usando last_contact recência
      const recent = arr.filter(l => l.last_contact && (now - Date.parse(l.last_contact)) < 3*24*60*60*1000).length
      const responseRate = count ? Math.round((recent / count) * 100) : 0
      // Score heurístico: maior é melhor
      let score = 100
      score -= Math.min(60, avgAgeDays) // mais velho, pior
      score += Math.min(40, Math.round(totalValue / 1000)) // valor puxa score
      score += Math.round(responseRate / 2) // até +50
      score = Math.max(0, Math.min(100, score))
      // Sugestões simples
      const suggestions = []
      if (avgAgeDays > 10) suggestions.push('Reduzir idade média: priorize follow-ups')
      if (responseRate < 30) suggestions.push('Baixa resposta: revise copy ou cadência')
      if (totalValue === 0 && count > 0) suggestions.push('Sem valor previsto: qualifique e estime')
      return { stage: s, count, avgAgeDays, responseRate, totalValue, score, suggestions }
    })
    // Recomendações de reequilíbrio globais
    const avgScore = out.length ? Math.round(out.reduce((a,b)=>a+b.score,0)/out.length) : 0
    const weakest = out.slice().sort((a,b)=>a.score-b.score)[0] || null
    const strongest = out.slice().sort((a,b)=>b.score-a.score)[0] || null
    const rebalance = []
    if (weakest && strongest && (strongest.score - weakest.score) > 25) {
      rebalance.push(`Alocar tempo de ${strongest.stage} para ${weakest.stage}`)
    }
    return res.json({ stages: out, avgScore, rebalance })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Follow-up inteligente: fila de leads quentes com prob. de fechamento
app.get('/api/followup/queue', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const orgId = String(req.query.organization_id || '')
    if (!orgId) return res.status(400).json({ error: 'organization_id_required' })
    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('organization_id', orgId)
    const now = Date.now()
    const out = []
    for (const l of (leads || [])) {
      const status = String(l.status || '')
      // Pesos por estágio
      const stageWeight = status === 'proposal' ? 0.9 : status === 'negotiation' ? 0.8 : status === 'qualified' ? 0.6 : 0.4
      // AI score normalizado (0-1)
      let ai = 0
      try {
        const cached = __aiScoreCache.get(String(l.id))
        if (cached && (now - cached.at < 15*60*1000)) ai = Math.max(0, Math.min(1, Number(cached.score || 0)/100))
      } catch {}
      // Sinais do Agente (emoção/perfil) por telefone
      let emotionalBoost = 0
      let profileBoost = 0
      let emotionLabel = null
      let profileLabel = null
      try {
        const digits = String(l.phone || '').replace(/\D/g, '')
        if (digits) {
          let prof = __agentProfileCache.get(digits)
          if (!prof || (now - prof.at > 10*60*1000)) {
            try {
              const r = await fetch(`${getAgentHttpBase()}/api/leads/${encodeURIComponent(digits + '@c.us')}`)
              const j = await r.json().catch(() => null)
              if (j) {
                prof = {
                  emotionalState: j.emotionalState || j.estadoEmocional || null,
                  decisionProfile: j.decisionProfile || j.perfilDecisao || null,
                  at: now,
                }
                __agentProfileCache.set(digits, prof)
              }
            } catch {}
          }
          if (prof) {
            emotionLabel = prof.emotionalState || null
            profileLabel = prof.decisionProfile || null
            // micro-ajustes na probabilidade
            if (typeof prof.emotionalState === 'string') {
              const e = prof.emotionalState.toLowerCase()
              if (/interessad|engajad/.test(e)) emotionalBoost += 0.05
              if (/impacient|urgente/.test(e)) emotionalBoost += 0.03
              if (/indiferent|frio/.test(e)) emotionalBoost -= 0.03
            }
            if (typeof prof.decisionProfile === 'string') {
              const p = prof.decisionProfile.toLowerCase()
              if (/urg|ráp/.test(p)) profileBoost += 0.03
              if (/cétic|cetic/.test(p)) profileBoost -= 0.02
            }
          }
        }
      } catch {}
      // Recência (0-1) com decaimento log: <24h≈1, 3d≈0.5, 7d≈0.2
      let recency = 0.2
      if (l.last_contact) {
        const days = Math.max(0, (now - Date.parse(l.last_contact)) / (1000*60*60*24))
        recency = Math.max(0, Math.min(1, 1 / Math.log2(days + 2)))
      }
      // Valor normalizado (cap em 20k): 0-1
      const valueNorm = Math.max(0, Math.min(1, Number(l.value || 0) / 20000))
      // Bônus sinais quentes
      const hotTag = Array.isArray(l.tags) && l.tags.includes('hot-lead') ? 0.1 : 0
      const bonusStage = status === 'proposal' ? 0.1 : (status === 'negotiation' ? 0.05 : 0)
      // Combinação ponderada
      const contribAi = 0.45 * ai
      const contribRecency = 0.25 * recency
      const contribValue = 0.20 * valueNorm
      const contribStage = 0.10 * stageWeight
      const contribAgentSignals = Math.max(-0.05, Math.min(0.08, emotionalBoost + profileBoost))
      const contribBonuses = hotTag + bonusStage + contribAgentSignals
      let p = 0
      p += contribAi
      p += contribRecency
      p += contribValue
      p += contribStage
      p += contribBonuses
      // clamp & escala para % com piso/teto
      const prob = Math.max(5, Math.min(95, Math.round(p * 100)))
      const suggestion = status === 'proposal' ? 'Enviar proposta refinada ou follow-up de decisão'
        : status === 'negotiation' ? 'Agendar call de negociação com objeções'
        : (ai > 0.75 ? 'Propor próxima etapa (proposta/call)' : 'Mensagem de descoberta e CTA claro')
      const breakdown = {
        ai: Math.round(contribAi * 100),
        recency: Math.round(contribRecency * 100),
        value: Math.round(contribValue * 100),
        stage: Math.round(contribStage * 100),
        hotTag: Math.round(hotTag * 100),
        agentSignals: Math.round(contribAgentSignals * 100),
        bonusStage: Math.round(bonusStage * 100),
        total: Math.round((contribAi + contribRecency + contribValue + contribStage + hotTag + bonusStage + contribAgentSignals) * 100),
      }
      out.push({ id: l.id, name: l.name, company: l.company, phone: l.phone, status, value: l.value, probability: prob, suggestion, breakdown, emotion: emotionLabel, profile: profileLabel })
    }
    out.sort((a,b)=>b.probability-a.probability)
    return res.json({ items: out.slice(0, 200) })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Bridge: Agente WhatsApp -> CRM (intents diretas, autenticado por X-Agent-Key)
// Proteções: rate limiting, idempotência e verificação opcional de HMAC
const _agentDispatchIdemCache = new Map(); // key -> { ts, status, body }
const IDEM_WINDOW_MS = Number(process.env.IDEMPOTENCY_WINDOW_MS || (10 * 60 * 1000));
const IDEM_MAX_ENTRIES = Number(process.env.IDEMPOTENCY_MAX_ENTRIES || 5000);
const RATE_WINDOW_MS = Number(process.env.AGENT_RATE_WINDOW_MS || 10000);
const RATE_MAX = Number(process.env.AGENT_RATE_MAX || 50);
const AGENT_BODY_MAX_BYTES = Number(process.env.AGENT_BODY_MAX_BYTES || 200000);

const _rateStateByKey = new Map(); // agentKey -> { start, count }
function _rateAllow(agentKey) {
  const now = Date.now();
  const key = String(agentKey || '');
  let st = _rateStateByKey.get(key) || { start: now, count: 0 };
  if (now - st.start > RATE_WINDOW_MS) st = { start: now, count: 0 };
  st.count += 1;
  _rateStateByKey.set(key, st);
  return st.count <= RATE_MAX;
}

function _idemPrune() {
  while (_agentDispatchIdemCache.size > IDEM_MAX_ENTRIES) {
    const first = _agentDispatchIdemCache.keys().next().value;
    if (!first) break;
    _agentDispatchIdemCache.delete(first);
  }
}

function _idemSet(key, status, body) {
  _agentDispatchIdemCache.set(String(key), { ts: Date.now(), status, body });
  _idemPrune();
}

function _idemGet(key) {
  const rec = _agentDispatchIdemCache.get(String(key));
  if (!rec) return null;
  if ((Date.now() - rec.ts) > IDEM_WINDOW_MS) { _agentDispatchIdemCache.delete(String(key)); return null; }
  return rec;
}
app.post('/api/agent/dispatch', async (req, res) => {
  try {
    const agentKey = req.headers['x-agent-key'] || req.headers['X-Agent-Key']
    if (!agentKey || String(agentKey) !== String(process.env.AGENT_API_KEY || '')) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    // Basic rate limiting por agentKey
    if (!_rateAllow(agentKey)) return res.status(429).json({ error: 'rate_limited' })

    // Tamanho do corpo
    try {
      const rawLen = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8')
      if (rawLen > AGENT_BODY_MAX_BYTES) return res.status(413).json({ error: 'payload_too_large' })
    } catch {}

    // HMAC verification (optional)
    try {
      const secret = process.env.AGENT_HMAC_SECRET || process.env.CRM_HMAC_SECRET
      const ts = req.headers['x-timestamp']
      const sig = req.headers['x-signature']
      if (secret && ts && sig) {
        const crypto = require('crypto')
        const name = String((req.body && req.body.name) || '')
        const payload = req.body && req.body.payload ? req.body.payload : {}
        const payloadStr = JSON.stringify(payload)
        const payloadHash = crypto.createHash('sha256').update(payloadStr).digest('hex')
        const base = `${ts}.${name}.${payloadHash}`
        const expected = crypto.createHmac('sha256', String(secret)).update(base).digest('hex')
        if (expected !== String(sig)) return res.status(401).json({ error: 'invalid_signature' })
        const maxSkewMs = Number(process.env.AGENT_HMAC_MAX_SKEW_MS || 5 * 60 * 1000)
        const tsNum = Number(ts)
        if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > maxSkewMs) {
          return res.status(401).json({ error: 'timestamp_out_of_range' })
        }
      }
    } catch {}
    const { name, payload } = req.body || {}
    const intent = String(name || '').toLowerCase()
    const p = payload || {}

    // Idempotência (opcional)
    const idemKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key']
    if (idemKey) {
      const found = _idemGet(idemKey)
      if (found) return res.status(found.status).json(found.body)
    }

    // Minimal schema validation (defense-in-depth)
    function fail(msg) { return res.status(400).json({ error: msg }) }
    if (!intent) return fail('intent_required')
    if (p == null || typeof p !== 'object') return fail('payload_required')
    if (intent === 'create_note' || intent === 'create_task') {
      if (!p.phone && !p.leadId && !p.lead_id) return fail('phone_or_lead_required')
      if (!p.title) return fail('title_required')
    }
    if (intent === 'move_lead') {
      if (!p.phone && !p.leadId && !p.id) return fail('phone_or_lead_required')
      if (!p.toStageId && !p.status) return fail('toStageId_required')
    }
    if (intent === 'create_lead') {
      if (!p.organization_id) return fail('organization_id_required')
    }

    async function resolveLead({ lead_id, phone, organization_id }) {
      if (lead_id) {
        const { data } = await supabaseAdmin.from('leads').select('*').eq('id', lead_id).maybeSingle()
        return data || null
      }
      const digits = String(phone || '').replace(/\D/g, '')
      if (!digits) return null
      const q = supabaseAdmin.from('leads').select('*').ilike('phone', `%${digits.slice(-8)}%`).limit(1)
      const { data } = await q
      return (data && data[0]) || null
    }

    if (intent === 'create_note' || intent === 'create_task') {
      const lead = await resolveLead({ lead_id: p.leadId || p.lead_id, phone: p.phone, organization_id: p.organization_id })
      if (!lead) return res.status(404).json({ error: 'lead_not_found' })
      const orgId = lead.organization_id
      const ownerUserId = lead.user_id || (await pickOrgOwnerUserId(orgId))
      const type = intent === 'create_task' ? 'task' : 'note'
      const title = String(p.title || (type === 'task' ? 'Tarefa' : 'Nota'))
      const description = p.description ? String(p.description) : null
      const due_date = p.due_date ? new Date(p.due_date).toISOString() : null
      const { data: insertedActivity, error } = await supabaseAdmin.from('activities').insert([{
        lead_id: lead.id,
        user_id: ownerUserId,
        type,
        title,
        description,
        due_date,
        completed: false,
        organization_id: orgId,
      }]).select('id').maybeSingle()
      if (error) return res.status(500).json({ error: error.message })

      // Auto-sugestão de follow-up e criação de follow-up (apenas para tarefas)
      let followupResult = null
      if (type === 'task') {
        try {
          const digits = String(lead.phone || '').replace(/\D/g, '')
          const waJid = digits ? `${digits}@c.us` : null
          let suggestedText = null
          if (waJid) {
            try {
              const base = getAgentHttpBase()
              const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || ''
              const r = await fetch(`${base}/api/wa/followup/generate`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(key ? { 'X-Agent-Key': key } : {}),
                },
                body: JSON.stringify({ leadId: waJid, objective: title, maxChars: 400 })
              })
              if (r.ok) {
                const j = await r.json().catch(() => ({}))
                if (j && typeof j.text === 'string' && j.text.trim()) {
                  suggestedText = String(j.text).trim()
                }
              }
            } catch {}
          }

          try {
            const crmBase = process.env.CRM_HTTP_BASE || `http://localhost:${process.env.DASHBOARD_PORT_CRM || 3007}`
            const nowMs = Date.now()
            let scheduleInMinutes = undefined
            if (due_date) {
              const dueMs = new Date(due_date).getTime()
              if (Number.isFinite(dueMs) && dueMs > nowMs) {
                const diffMin = Math.ceil((dueMs - nowMs) / 60000)
                if (diffMin > 0) scheduleInMinutes = diffMin
              }
            }
            if (waJid) {
              const body = {
                leadId: waJid,
                objective: String(suggestedText || title).slice(0, 420),
                ...(scheduleInMinutes ? { scheduleInMinutes } : {}),
                constraints: { maxChars: 420 },
              }
              const r2 = await fetch(`${crmBase}/api/followups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              })
              const j2 = await r2.json().catch(() => ({}))
              if (r2.ok) followupResult = j2
            }
          } catch {}
        } catch {}
      }

      const out = { ok: true, taskId: insertedActivity?.id || null, followup: followupResult?.followup || null }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    if (intent === 'update_lead') {
      const lead = await resolveLead({ lead_id: p.id || p.leadId, phone: p.phone, organization_id: p.organization_id })
      if (!lead) return res.status(404).json({ error: 'lead_not_found' })
      const updates = { ...p }
      delete updates.id; delete updates.leadId; delete updates.phone; delete updates.organization_id
      const { error } = await supabaseAdmin.from('leads').update(updates).eq('id', lead.id)
      if (error) return res.status(500).json({ error: error.message })
      const out = { ok: true }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    if (intent === 'create_lead') {
      const orgId = p.organization_id || null
      if (!orgId) return res.status(400).json({ error: 'organization_id_required' })
      const ownerUserId = await pickOrgOwnerUserId(orgId)
      if (!ownerUserId) return res.status(400).json({ error: 'org_owner_not_found' })
      const insertPayload = {
        name: String(p.name || 'Lead'),
        company: String(p.company || '—'),
        email: p.email || null,
        phone: p.phone ? String(p.phone) : null,
        value: Number(p.value || 0),
        status: String(p.status || 'new'),
        responsible: String(p.responsible || 'Agent'),
        source: String(p.source || 'whatsapp-agent'),
        tags: Array.isArray(p.tags) ? p.tags : [],
        notes: p.notes || null,
        user_id: ownerUserId,
        organization_id: orgId,
      }
      const { error } = await supabaseAdmin.from('leads').insert([insertPayload])
      if (error) return res.status(500).json({ error: error.message })
      const out = { ok: true }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    // Move lead entre estágios
    if (intent === 'move_lead') {
      const lead = await resolveLead({ lead_id: p.leadId || p.id, phone: p.phone, organization_id: p.organization_id })
      if (!lead) return res.status(404).json({ error: 'lead_not_found' })
      const toStageId = String(p.toStageId || p.status || '').trim()
      if (!toStageId) return res.status(400).json({ error: 'invalid_params_toStageId' })
      const { error } = await supabaseAdmin.from('leads').update({ status: toStageId, last_contact: new Date().toISOString() }).eq('id', lead.id)
      if (error) return res.status(500).json({ error: error.message })
      const out = { ok: true }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    // Excluir lead
    if (intent === 'delete_lead') {
      const lead = await resolveLead({ lead_id: p.leadId || p.id, phone: p.phone, organization_id: p.organization_id })
      if (!lead) return res.status(404).json({ error: 'lead_not_found' })
      const { error } = await supabaseAdmin.from('leads').delete().eq('id', lead.id)
      if (error) return res.status(500).json({ error: error.message })
      const out = { ok: true }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    // Criar vários leads em um estágio
    if (intent === 'bulk_create_in_stage') {
      const orgId = p.organization_id || null
      if (!orgId) return res.status(400).json({ error: 'organization_id_required' })
      const status = String(p.status || 'new')
      const items = Array.isArray(p.items) ? p.items : []
      const ownerUserId = await pickOrgOwnerUserId(orgId)
      if (!ownerUserId) return res.status(400).json({ error: 'org_owner_not_found' })
      const toInsert = items.slice(0, 200).map((it) => ({
        name: String(it?.name || 'Lead'),
        company: String(it?.company || '—'),
        email: it?.email || null,
        phone: it?.phone || null,
        value: Number(it?.value || 0),
        status,
        responsible: String(it?.responsible || 'Agent'),
        source: String(it?.source || 'bulk-agent'),
        tags: Array.isArray(it?.tags) ? it.tags : [],
        notes: it?.notes || null,
        user_id: ownerUserId,
        organization_id: orgId,
      }))
      const { error } = await supabaseAdmin.from('leads').insert(toInsert)
      if (error) return res.status(500).json({ error: error.message })
      const out = { ok: true, inserted: toInsert.length }
      if (idemKey) _idemSet(idemKey, 200, out)
      return res.json(out)
    }

    return res.status(400).json({ error: 'intent_not_supported' })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// === Proxies para CRM (para compat com UI quando VITE_API_BASE_URL não é aplicado) ===
app.get('/api/analytics/followups', (req, res) => proxyToCRM(req, res, `/api/analytics/followups`))
app.get('/api/followups/candidates', (req, res) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
  return proxyToCRM(req, res, `/api/followups/candidates${qs}`)
})
app.get('/api/followups/insights', (req, res) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
  return proxyToCRM(req, res, `/api/followups/insights${qs}`)
})
app.get('/api/goals', (req, res) => proxyToCRM(req, res, `/api/goals`))
app.post('/api/dashboard/summary', (req, res) => proxyToCRM(req, res, `/api/dashboard/summary`))
app.get('/api/analytics/reflections', (req, res) => proxyToCRM(req, res, `/api/analytics/reflections`))

// Proxy WhatsApp Agent (com auditoria)
app.post('/api/wa/dispatch', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const out = await proxyToWA(req, res, `/api/wa/dispatch`)
    try {
      const orgId = await getUserOrgId(user.id)
      const payload = { to: req.body?.to || null, type: req.body?.type || null }
      await insertAuditLog({ organization_id: orgId, user_id: user.id, action: 'wa.dispatch', resource_type: 'message', resource_id: null, payload, ip: req.ip, user_agent: String(req.headers['user-agent'] || '') })
    } catch {}
    return out
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: Next Best Action
app.get('/api/agent/nba', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    const params = []
    const phone = String(req.query.phone || '').replace(/\D/g, '')
    const waId = String(req.query.waId || '')
    if (phone) params.push(`phone=${encodeURIComponent(phone)}`)
    if (waId) params.push(`waId=${encodeURIComponent(waId)}`)
    const q = params.length ? `?${params.join('&')}` : ''
    return proxyToWA(req, res, `/api/agent/nba${q}`)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Proxy: Generate follow-up text
app.post('/api/wa/followup/generate', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    return proxyToWA(req, res, `/api/wa/followup/generate`)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Agent-driven CRM: move lead stage (no user approval when agent key provided)
app.post('/api/agent/crm/move-lead', async (req, res) => {
  try {
    const hasAgentKey = (() => {
      const provided = String(req.headers['x-agent-key'] || '')
      const envKey = String(process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY || '')
      return Boolean(provided && envKey && provided === envKey)
    })()
    let user = null
    if (!hasAgentKey) {
      user = await getUserFromAuthHeader(req)
      if (!user?.id) return res.status(401).json({ error: 'unauthorized' })
    }
    const leadId = String(req.body?.lead_id || req.body?.leadId || '')
    const toStageId = String(req.body?.to_stage_id || req.body?.toStageId || req.body?.status || '')
    if (!leadId || !toStageId) return res.status(400).json({ error: 'invalid_params' })
    // Fetch lead to get org
    const { data: leadRow, error: selErr } = await supabaseAdmin.from('leads').select('id, organization_id, status').eq('id', leadId).maybeSingle()
    if (selErr) return res.status(500).json({ error: 'db_error' })
    if (!leadRow) return res.status(404).json({ error: 'lead_not_found' })
    const { error: updErr } = await supabaseAdmin.from('leads').update({ status: toStageId }).eq('id', leadId)
    if (updErr) return res.status(500).json({ error: 'update_failed' })
    try { await insertAuditLog({ organization_id: leadRow.organization_id || null, user_id: user?.id || null, action: 'lead.move', resource_type: 'lead', resource_id: leadId, payload: { to: toStageId, by: user?.id || 'agent' }, ip: req.ip, user_agent: String(req.headers['user-agent'] || '') }) } catch {}
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Provedor de WhatsApp: 'meta' (oficial), 'wapi', 'ultramsg', 'greenapi', 'zapi' ou 'wppconnect'
const WHATSAPP_PROVIDER = (process.env.WHATSAPP_PROVIDER || 'wppconnect').toLowerCase()

// (IA removida)

async function pickOrgOwnerUserId(orgId) {
  try {
    const { data } = await supabaseAdmin
      .from('organization_members')
      .select('user_id, role, created_at')
      .eq('organization_id', orgId)
      .in('role', ['admin','manager'])
      .order('created_at', { ascending: true })
      .limit(1)
    return data?.[0]?.user_id || null
  } catch { return null }
}

// (IA removida)

async function sendWhatsAppNonOfficial(to, body, lead, userCfg) {
  const provider = (userCfg?.provider || WHATSAPP_PROVIDER)
  if (provider === 'ultramsg') {
    const instanceId = userCfg?.instance_id || process.env.ULTRAMSG_INSTANCE_ID
    const token = userCfg?.token || process.env.ULTRAMSG_TOKEN
    if (!instanceId || !token) throw new Error('UltraMsg não configurado')
    const url = `https://api.ultramsg.com/${instanceId}/messages/chat`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // UltraMsg aceita JSON; alguns exemplos usam x-www-form-urlencoded. JSON funciona nas contas atuais.
      body: JSON.stringify({ to, body, priority: 1, referenceId: String(lead?.id || '') })
    })
    let json = null
    try { json = await resp.json() } catch {}
    if (!resp.ok || (json && (json.error || json.code 
      && Number(json.code) >= 400))) {
      const msg = (json && (json.message || json.error)) || 'Falha ao enviar via UltraMsg'
      throw new Error(msg)
    }
    return (json && (json.id || json.messageId || json.data?.id)) || null
  }

  if (provider === 'greenapi') {
    const instanceId = userCfg?.instance_id || process.env.GREENAPI_INSTANCE_ID
    const token = userCfg?.token || process.env.GREENAPI_TOKEN
    if (!instanceId || !token) throw new Error('GreenAPI não configurado')
    const url = `https://api.green-api.com/waInstance${instanceId}/SendMessage/${token}`
    const chatId = `${to}@c.us`
    const payload = { chatId, message: body }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    let json = null
    try { json = await resp.json() } catch {}
    if (!resp.ok || (json && json.code && Number(json.code) >= 400)) {
      const msg = (json && (json.message || json.error)) || 'Falha ao enviar via GreenAPI'
      throw new Error(msg)
    }
    return (json && (json.idMessage || json.id)) || null
  }

  if (provider === 'wapi') {
    const baseUrl = userCfg?.base_url || process.env.WAPI_BASE_URL
    const instanceId = userCfg?.instance_id || process.env.WAPI_INSTANCE_ID
    const token = userCfg?.token || process.env.WAPI_TOKEN
    if (!baseUrl || !instanceId || !token) throw new Error('W-API não configurado')
    // Conforme doc: POST https://api.w-api.app/v1/message/send-text?instanceId=INSTANCE_ID
    const base = String(baseUrl).replace(/\/$/, '')
    const url = `${base}/v1/message/send-text?instanceId=${encodeURIComponent(instanceId)}`
    // Campos usuais variam entre implementações: alguns exigem "text", outros "message"/"body".
    // Enviamos todos para maximizar compatibilidade sem impactar servidores que ignoram extras.
    const payload = { phone: to, text: body, message: body, body }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    })
    let json = null
    try { json = await resp.json() } catch {}
    if (!resp.ok || (json && (json.error || json.code && Number(json.code) >= 400))) {
      const msg = (json && (json.message || json.error)) || 'Falha ao enviar via W-API'
      throw new Error(msg)
    }
    return (json && (json.id || json.messageId || json.data?.id || json?.messageId)) || null
  }

  if (provider === 'wppconnect') {
    const baseUrl = userCfg?.base_url || process.env.WPPCONNECT_BASE_URL
    const session = userCfg?.session || userCfg?.session_id || userCfg?.instance_id || process.env.WPPCONNECT_SESSION
    const token = userCfg?.token || userCfg?.api_key || process.env.WPPCONNECT_TOKEN
    if (!baseUrl || !session || !token) throw new Error('WPPConnect não configurado')
    const base = String(baseUrl).replace(/\/$/, '')
    const url = `${base}/api/${encodeURIComponent(session)}/send-message`
    const payload = { phone: to, message: body }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    })
    let json = null
    try { json = await resp.json() } catch {}
    if (!resp.ok || (json && (json.error || json.status === 'error'))) {
      const msg = (json && (json.message || json.error)) || 'Falha ao enviar via WPPConnect'
      throw new Error(msg)
    }
    return (json && (json.id || json.messageId || json?.message?.id || json?.data?.id)) || null
  }

  if (provider === 'zapi') {
    const baseUrl = userCfg?.base_url || process.env.ZAPI_BASE_URL || 'https://api.z-api.io'
    const instanceId = userCfg?.instance_id || process.env.ZAPI_INSTANCE_ID
    const token = userCfg?.token || process.env.ZAPI_TOKEN
    const clientToken = userCfg?.client_token || process.env.ZAPI_CLIENT_TOKEN || null
    if (!baseUrl || !instanceId || !token) throw new Error('Z-API não configurado')
    // Formato comum: POST /instances/{instanceId}/token/{token}/send-text
    const base = String(baseUrl).replace(/\/$/, '')
    const url = `${base}/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(token)}/send-text`
    const payload = { phone: to, message: body }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...(clientToken ? { 'Client-Token': clientToken } : {}),
      },
      body: JSON.stringify(payload)
    })
    let json = null
    try { json = await resp.json() } catch {}
    if (!resp.ok || (json && (json.error || json.code && Number(json.code) >= 400))) {
      const msg = (json && (json.message || json.error)) || 'Falha ao enviar via Z-API'
      throw new Error(msg)
    }
    return (json && (json.idMessage || json.id || json.messageId)) || null
  }

  throw new Error('Provedor não-oficial desconhecido')
}

// Envio de mídia para provedores não-oficiais (W-API foco principal)
async function sendWhatsAppNonOfficialMedia(to, media, lead, userCfg) {
  const provider = (userCfg?.provider || WHATSAPP_PROVIDER)
  if (provider === 'wppconnect') {
    const baseUrl = userCfg?.base_url || process.env.WPPCONNECT_BASE_URL
    const session = userCfg?.session || userCfg?.session_id || userCfg?.instance_id || process.env.WPPCONNECT_SESSION
    const token = userCfg?.token || userCfg?.api_key || process.env.WPPCONNECT_TOKEN
    if (!baseUrl || !session || !token) throw new Error('WPPConnect não configurado')
    const base = String(baseUrl).replace(/\/$/, '')

    const type = String(media?.type || '').toLowerCase()
    const url = String(media?.url || '')
    const caption = media?.caption || null
    const filename = media?.filename || null
    if (!to || !type || !url) throw new Error('Parâmetros inválidos: to, type e url são obrigatórios')

    const candidates = []
    if (type === 'image') {
      candidates.push({ endpoint: `send-image`, payload: { phone: to, path: url, ...(caption ? { caption } : {}) } })
    } else if (type === 'video') {
      candidates.push({ endpoint: `send-file`, payload: { phone: to, path: url, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) } })
    } else if (type === 'audio') {
      candidates.push({ endpoint: `send-file`, payload: { phone: to, path: url, ...(filename ? { filename } : {}) } })
    } else if (type === 'document' || type === 'file' || type === 'pdf') {
      candidates.push({ endpoint: `send-file`, payload: { phone: to, path: url, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) } })
    }
    // Fallback
    candidates.push({ endpoint: `send-file`, payload: { phone: to, path: url, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) } })

    let lastError = null
    for (const c of candidates) {
      try {
        const fullUrl = `${base}/api/${encodeURIComponent(session)}/${c.endpoint}`
        const resp = await fetch(fullUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(c.payload)
        })
        let json = null
        try { json = await resp.json() } catch {}
        if (!resp.ok || (json && (json.error || json.status === 'error'))) {
          lastError = (json && (json.message || json.error)) || `HTTP ${resp.status}`
          continue
        }
        const externalId = (json && (json.id || json.messageId || json?.message?.id || json?.data?.id)) || null
        return externalId
      } catch (e) {
        lastError = e?.message || String(e)
      }
    }

    throw new Error(lastError || 'Falha ao enviar mídia via WPPConnect')
  }

  if (provider !== 'wapi') {
    throw new Error('Envio de mídia suportado apenas para W-API e WPPConnect neste endpoint')
  }
  const baseUrl = userCfg?.base_url || process.env.WAPI_BASE_URL
  const instanceId = userCfg?.instance_id || process.env.WAPI_INSTANCE_ID
  const token = userCfg?.token || process.env.WAPI_TOKEN
  if (!baseUrl || !instanceId || !token) throw new Error('W-API não configurado')
  const base = String(baseUrl).replace(/\/$/, '')

  const type = String(media?.type || '').toLowerCase()
  const url = String(media?.url || '')
  const caption = media?.caption || null
  const filename = media?.filename || null
  if (!to || !type || !url) throw new Error('Parâmetros inválidos: to, type e url são obrigatórios')

  // Candidatos de endpoints/payloads conforme variações comuns da W-API
  const candidates = []
  if (type === 'image') {
    candidates.push({
      url: `${base}/v1/message/send-image?instanceId=${encodeURIComponent(instanceId)}`,
      payload: { phone: to, url, ...(caption ? { caption } : {}) }
    })
  } else if (type === 'video') {
    candidates.push({
      url: `${base}/v1/message/send-video?instanceId=${encodeURIComponent(instanceId)}`,
      payload: { phone: to, url, ...(caption ? { caption } : {}) }
    })
  } else if (type === 'audio') {
    candidates.push({
      url: `${base}/v1/message/send-audio?instanceId=${encodeURIComponent(instanceId)}`,
      payload: { phone: to, url }
    })
  } else if (type === 'document' || type === 'file' || type === 'pdf') {
    candidates.push({
      url: `${base}/v1/message/send-document?instanceId=${encodeURIComponent(instanceId)}`,
      payload: { phone: to, url, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) }
    })
  }
  // Fallback genérico (algumas variantes expõem send-media)
  candidates.push({
    url: `${base}/v1/message/send-media?instanceId=${encodeURIComponent(instanceId)}`,
    payload: { phone: to, type, url, ...(filename ? { filename } : {}), ...(caption ? { caption } : {}) }
  })

  let lastError = null
  for (const c of candidates) {
    try {
      const resp = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(c.payload)
      })
      let json = null
      try { json = await resp.json() } catch {}
      if (!resp.ok || (json && (json.error || (json.code && Number(json.code) >= 400)))) {
        lastError = (json && (json.message || json.error)) || `HTTP ${resp.status}`
        continue
      }
      const externalId = (json && (json.id || json.messageId || json.data?.id || json?.messageId)) || null
      return externalId
    } catch (e) {
      lastError = e?.message || String(e)
    }
  }
  throw new Error(lastError || 'Falha ao enviar mídia via W-API')
}

// Helpers para webhooks Meta (assinatura)
function verifyMetaSignature(req) {
  try {
    const appSecret = process.env.META_APP_SECRET
    if (!appSecret) return true // sem segredo, não valida
    const sigHeader = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature']
    if (!sigHeader) return false
    const expectedPrefix = 'sha256='
    const provided = String(sigHeader)
    if (!provided.startsWith(expectedPrefix)) return false
    const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}))
    const hmac = crypto.createHmac('sha256', appSecret)
    hmac.update(bodyBuffer)
    const digest = hmac.digest('hex')
    const expected = expectedPrefix + digest
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

function parseJsonBody(req) {
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8') || '{}') } catch { return {} }
  }
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}') } catch { return {} }
  }
  return req.body || {}
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

// ================================
// Lead enrichment helpers
// ================================
function extractEmailsFromText(text) {
  try {
    const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    const found = String(text || '').match(re) || []
    // prefer the first unique
    return Array.from(new Set(found)).slice(0, 3)
  } catch { return [] }
}

function extractCompanyFromText(text) {
  const t = String(text || '').trim()
  if (!t) return null
  // Heurísticas simples para PT-BR
  const patterns = [
    /(empresa|da empresa|do grupo|somos (?:a|da)|sou (?:da|de))\s+([A-Za-zÀ-ÿ0-9&.,\- ]{2,60})/i,
    /(minha empresa|nossa empresa)\s*[:\-]?\s*([A-Za-zÀ-ÿ0-9&.,\- ]{2,60})/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m && m[2]) {
      const raw = m[2].replace(/\s{2,}/g, ' ').trim()
      // corta sufixos comuns após pontuação
      const cleaned = raw.split(/[.,;\n]/)[0].trim()
      if (cleaned && cleaned.length >= 2) return cleaned
    }
  }
  return null
}

function normalizeLeadName(name) {
  if (!name) return null
  const s = String(name).replace(/[_]{2,}/g, ' ').replace(/[\t\n\r]/g, ' ').trim()
  if (!s) return null
  // Title Case simples
  return s.toLowerCase().split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function normalizeTagsList(tags) {
  const toSlug = (v) => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const arr = (Array.isArray(tags) ? tags : []).map(toSlug).filter(Boolean)
  return Array.from(new Set(arr)).slice(0, 20)
}

async function upsertLeadIfMissing({ organization_id, phoneDigits, defaultName, source = 'whatsapp' }) {
  if (!organization_id || !phoneDigits) return null
  try {
    const { data: existing } = await supabaseAdmin
      .from('leads').select('*')
      .ilike('phone', `%${phoneDigits.slice(-8)}%`).limit(1)
    if (existing && existing[0]) return existing[0]
    const ownerUserId = await pickOrgOwnerUserId(organization_id)
    if (!ownerUserId) return null
    const insertPayload = {
      name: defaultName || `Contato ${phoneDigits.slice(-4)}`,
      company: '—',
      email: null,
      phone: phoneDigits,
      value: 0,
      status: 'new',
      responsible: 'Import',
      source,
      tags: ['auto-enriched', source],
      notes: null,
      user_id: ownerUserId,
      organization_id,
    }
    const { data: ins, error } = await supabaseAdmin.from('leads').insert([insertPayload]).select('*').single()
    if (error) return null
    return ins
  } catch { return null }
}

async function enrichLeadFromTextAndProfile(lead, { text, profileName }) {
  try {
    if (!lead) return
    const updates = {}
    // Email
    if (!lead.email) {
      const emails = extractEmailsFromText(text)
      if (emails[0]) updates.email = emails[0]
    }
    // Company
    if (!lead.company || lead.company === '—') {
      const company = extractCompanyFromText(text)
      if (company) updates.company = company
    }
    // Name
    const normalizedProfile = normalizeLeadName(profileName)
    const isGeneric = !lead.name || /^contato\s+\d{2,4}$/i.test(lead.name) || lead.name.length < 3
    if (normalizedProfile && isGeneric) updates.name = normalizedProfile
    // Tags
    const extraTags = []
    const low = String(text || '').toLowerCase()
    if (/orçamento|orcamento|proposta/.test(low)) extraTags.push('orçamento')
    if (/reclama|insatisfeito|ruim|p[ée]ssimo/.test(low)) extraTags.push('reclamacao')
    if (/boleto|2ª\s*via|segunda\s*via/.test(low)) extraTags.push('boleto')
    if (/agendar|reuni[aã]o|marcar/.test(low)) extraTags.push('agendamento')
    const current = Array.isArray(lead.tags) ? lead.tags : []
    const merged = normalizeTagsList([...current, ...extraTags])
    if (merged.join('|') !== (current.map(String).join('|') || '')) updates.tags = merged
    if (Object.keys(updates).length > 0) {
      await supabaseAdmin.from('leads').update(updates).eq('id', lead.id)
    }
  } catch {}
}

// Validação opcional para webhooks W-API
function verifyWapiSignature(req) {
  try {
    const expectedToken = process.env.WAPI_WEBHOOK_TOKEN
    const providedToken = (req.query && (req.query.token || req.query.auth)) || null
    if (expectedToken) {
      if (!providedToken || String(providedToken) !== String(expectedToken)) return false
      return true
    }
    const secret = process.env.WAPI_WEBHOOK_SECRET
    const header = req.headers['x-wapi-signature'] || req.headers['x-signature']
    if (secret && header) {
      const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}))
      const hmac = crypto.createHmac('sha256', secret)
      hmac.update(bodyBuffer)
      const digest = hmac.digest('hex')
      const provided = String(header).replace(/^sha256=/, '')
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(digest))
    }
    return true
  } catch {
    return false
  }
}

// Extratores mais robustos para webhooks não-oficiais
function extractDigitsFromChatId(chatId) {
  const v = String(chatId || '')
  const beforeAt = v.includes('@') ? v.split('@')[0] : v
  return normalizePhoneDigits(beforeAt)
}

function parseZapiInboundPayload(data) {
  try {
    const msg = (data && (data.message || data.data)) || data || {}
    const instanceId = data?.instanceId || data?.instance_id || data?.instance || msg?.instanceId || null
    // Possíveis campos para remetente
    const fromRaw = msg?.from || data?.from || data?.sender || msg?.sender || data?.phone || msg?.phone || msg?.chatId || data?.chatId || msg?.remoteJid || null
    // Extrair texto em múltiplos formatos comuns
    const extractText = (root) => {
      const candidates = [
        root?.message,
        root?.text,
        root?.body,
        root?.textMessage,
        root?.conversation,
        root?.caption,
        root?.extendedTextMessage?.text,
        root?.listResponseMessage?.title,
        root?.buttonsResponseMessage?.selectedDisplayText,
      ]
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c
        if (c && typeof c === 'object') {
          if (typeof c.text === 'string' && c.text.trim()) return c.text
          if (typeof c.body === 'string' && c.body.trim()) return c.body
          if (typeof c.message === 'string' && c.message.trim()) return c.message
          if (typeof c.caption === 'string' && c.caption.trim()) return c.caption
        }
      }
      return null
    }
    let textRaw = extractText(msg) || extractText(data)
    const externalId = data?.idMessage || msg?.idMessage || data?.messageId || data?.id || msg?.id || null
    const from = extractDigitsFromChatId(fromRaw)
    const text = typeof textRaw === 'string' ? textRaw : (textRaw ? JSON.stringify(textRaw) : '')
    return { instanceId, from, text, externalId }
  } catch {
    return { instanceId: null, from: '', text: '', externalId: null }
  }
}

// Helpers de auth do usuário (via token do Supabase)
async function getUserFromAuthHeader(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error) return null
  return data.user || null
}

function signState(userId) {
  const secret = process.env.JWT_SECRET || 'dev-secret'
  const sig = crypto.createHmac('sha256', secret).update(userId).digest('hex')
  return `${userId}.${sig}`
}

function verifyState(state) {
  const secret = process.env.JWT_SECRET || 'dev-secret'
  const [userId, sig] = String(state || '').split('.')
  if (!userId || !sig) return null
  const expected = crypto.createHmac('sha256', secret).update(userId).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? userId : null
}

// Helpers extras: checar se usuário é admin
async function isAdmin(userId) {
  const { data: prof } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()
  return prof?.role === 'admin' || prof?.role === 'manager'
}

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }))

// Bootstrap: verificar se existe admin e permitir auto-elevação do primeiro usuário
app.get('/api/bootstrap/status', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('role', { count: 'exact', head: false })
      .in('role', ['admin', 'manager'])
    if (error) return res.status(500).json({ error: error.message })
    const hasAdmin = (data || []).length > 0
    return res.json({ hasAdmin })
  } catch (e) {
    console.error('[bootstrap/status] error', e)
    return res.sendStatus(500)
  }
})

// ORGS — retornar organizações do usuário atual
app.get('/api/org/me', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id, role, organizations:organization_id(id, name)')
      .eq('user_id', user.id)
    if (error) return res.status(500).json({ error: error.message })
    const orgs = (data || []).map((m) => ({ id: m.organizations?.id || m.organization_id, name: m.organizations?.name || 'Minha Empresa', role: m.role }))
    return res.json({ organizations: orgs })
  } catch (e) {
    console.error('[org/me] error', e)
    return res.sendStatus(500)
  }
})

// ORGS — bootstrap: cria organização "Minha Empresa" para o usuário se ele não tiver nenhuma
app.post('/api/org/bootstrap', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    // Já tem?
    const { data: existing } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .limit(1)
    if ((existing || []).length > 0) return res.json({ ok: true })

    const orgName = 'Minha Empresa'
    const { data: org, error: orgErr } = await supabaseAdmin
      .from('organizations')
      .insert([{ name: orgName }])
      .select('*')
      .single()
    if (orgErr) return res.status(500).json({ error: orgErr.message })

    const { error: memErr } = await supabaseAdmin
      .from('organization_members')
      .insert([{ organization_id: org.id, user_id: user.id, role: 'admin' }])
    if (memErr) return res.status(500).json({ error: memErr.message })

    // Garantir profile com admin para compatibilidade
    await supabaseAdmin
      .from('profiles')
      .upsert({ id: user.id, role: 'admin', full_name: user.user_metadata?.full_name || user.email })

    return res.json({ ok: true, organization: org })
  } catch (e) {
    console.error('[org/bootstrap] error', e)
    return res.sendStatus(500)
  }
})

app.post('/api/bootstrap/ensure-admin', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    // Se já existe admin/manager, não permite auto-elevação
    const { data: roles, error: rErr } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .in('role', ['admin', 'manager'])
      .limit(1)
    if (rErr) return res.status(500).json({ error: rErr.message })
    if ((roles || []).length > 0) return res.status(403).json({ error: 'admin_exists' })

    // Tentar atualizar; se não existir linha, inserir
    const fullName = user.user_metadata?.full_name || user.email || 'Admin'
    const updatePayload = { role: 'admin', full_name: fullName, updated_at: new Date().toISOString() }
    const { data: updated, error: upErr } = await supabaseAdmin
      .from('profiles')
      .update(updatePayload)
      .eq('id', user.id)
      .select('*')
    if (upErr) return res.status(500).json({ error: upErr.message })
    if (!updated || updated.length === 0) {
      const { error: insErr } = await supabaseAdmin
        .from('profiles')
        .insert([{ id: user.id, full_name: fullName, role: 'admin' }])
      if (insErr) return res.status(500).json({ error: insErr.message })
    }
    return res.json({ ok: true })
  } catch (e) {
    console.error('[bootstrap/ensure-admin] error', e)
    return res.sendStatus(500)
  }
})

// Webhook verify helper
function verifyWebhook(req, res, expectedToken) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === expectedToken) {
    return res.status(200).send(challenge)
  }
  return res.sendStatus(403)
}

// WhatsApp Webhook Verification
app.get('/webhooks/whatsapp', (req, res) => {
  return verifyWebhook(req, res, process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)
})

// Instagram Webhook Verification
app.get('/webhooks/instagram', (req, res) => {
  return verifyWebhook(req, res, process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)
})

// Messenger Webhook Verification
app.get('/webhooks/messenger', (req, res) => {
  return verifyWebhook(req, res, process.env.MESSENGER_WEBHOOK_VERIFY_TOKEN)
})

// WhatsApp inbound webhook handler
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(403)
    const body = parseJsonBody(req)
    const entry0 = body?.entry?.[0]
    const changes = entry0?.changes?.[0]?.value
    const phoneNumberId = changes?.metadata?.phone_number_id || entry0?.id || null
    const messages = changes?.messages || []
    for (const msg of messages) {
      const from = msg.from
      const text = msg.text?.body || ''
      const externalId = msg.id

      const normalized = String(from).replace(/\D/g, '')
      const { data: leads, error: leadErr } = await supabaseAdmin
        .from('leads')
        .select('*')
        .ilike('phone', `%${normalized.slice(-8)}%`)
        .limit(1)
      if (leadErr) console.error('[whatsapp] erro buscando lead:', leadErr.message)
      let lead = leads?.[0]

      const insertPayload = {
        lead_id: lead?.id || null,
        user_id: lead?.user_id || null,
        type: 'whatsapp',
        direction: 'inbound',
        subject: null,
        content: text,
        status: 'read',
        external_id: externalId,
        organization_id: lead?.organization_id || null,
      }
      if (!insertPayload.organization_id && phoneNumberId) {
        try {
          const { data: setting } = await supabaseAdmin
            .from('settings')
            .select('user_id')
            .eq('key', 'whatsapp')
            .filter('value->>phone_number_id', 'eq', String(phoneNumberId))
            .limit(1)
          const settingsOwner = setting?.[0]?.user_id
          if (settingsOwner) {
            const { data: mem } = await supabaseAdmin
              .from('organization_members')
              .select('organization_id')
              .eq('user_id', settingsOwner)
              .limit(1)
            const orgId = mem?.[0]?.organization_id || null
            if (orgId) insertPayload.organization_id = orgId
          }
        } catch {}
      }
      // Enriquecer lead: se não existir lead na org, criar com nome genérico
      if (!lead && insertPayload.organization_id) {
        lead = await upsertLeadIfMissing({ organization_id: insertPayload.organization_id, phoneDigits: normalized, defaultName: null, source: 'whatsapp' })
        insertPayload.lead_id = lead?.id || null
        insertPayload.user_id = lead?.user_id || null
      }
      // Tentar enriquecer com texto e (se disponível) profile name do remetente
      const profileName = msg?.profile?.name || msg?.contacts?.[0]?.profile?.name || msg?.contacts?.[0]?.wa_name || null
      if (lead) await enrichLeadFromTextAndProfile(lead, { text, profileName })

      const { error: commErr } = await supabaseAdmin
        .from('communications')
        .insert([insertPayload])
      if (commErr) console.error('[whatsapp] erro inserindo communication:', commErr.message)
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('[whatsapp] inbound error', e)
    return res.sendStatus(500)
  }
})

// Instagram inbound webhook handler (DMs) — mapeando sender -> lead via ig_username
app.post('/webhooks/instagram', async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(403)
    const body = parseJsonBody(req)
    const entries = Array.isArray(body?.entry) ? body.entry : []
    for (const entry of entries) {
      const igUserIdEntry = entry?.id || null
      // Tentar resolver organization_id pelo ig_user_id salvo nas settings
      let orgIdFromSetting = null
      if (igUserIdEntry) {
        try {
          const { data: settingOwner } = await supabaseAdmin
            .from('settings')
            .select('user_id')
            .eq('key', 'instagram')
            .filter('value->>ig_user_id', 'eq', String(igUserIdEntry))
            .limit(1)
          const ownerUserId = settingOwner?.[0]?.user_id
          if (ownerUserId) {
            const { data: mem } = await supabaseAdmin
              .from('organization_members')
              .select('organization_id')
              .eq('user_id', ownerUserId)
              .limit(1)
            orgIdFromSetting = mem?.[0]?.organization_id || null
          }
        } catch {}
      }
      const messaging = entry.messaging || []
      for (const event of messaging) {
        const senderId = event.sender?.id
        const text = event.message?.text || event.message?.message || ''
        if (!senderId || !text) continue

        // Tenta obter username pela Graph API (senderId -> username)
        let username = null
        try {
          const { data: setting } = await supabaseAdmin
            .from('settings')
            .select('value')
            .eq('key', 'instagram')
            .limit(1)
            .maybeSingle()
          const token = setting?.value?.access_token
          if (token) {
            const resp = await fetch(`https://graph.facebook.com/v20.0/${senderId}?fields=username`, { headers: { Authorization: `Bearer ${token}` } })
            const js = await resp.json()
            username = js?.username || null
          }
        } catch {}

        let lead = null
        if (username) {
          const { data: leads } = await supabaseAdmin
            .from('leads')
            .select('*')
            .ilike('ig_username', username)
            .limit(1)
          lead = leads?.[0] || null
        }

        const insertPayload = {
          lead_id: lead?.id || null,
          user_id: lead?.user_id || null,
          type: 'instagram',
          direction: 'inbound',
          subject: null,
          content: text,
          status: 'read',
          external_id: senderId,
          organization_id: lead?.organization_id || orgIdFromSetting || null,
        }
        if (!insertPayload.user_id) {
          try {
            const auth = req.headers.authorization || ''
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
            if (token) {
              const { data: u } = await supabaseAdmin.auth.getUser(token)
              const userId = u?.user?.id
              if (userId) {
                const { data: mem } = await supabaseAdmin
                  .from('organization_members')
                  .select('organization_id')
                  .eq('user_id', userId)
                  .limit(1)
                const orgId = mem?.[0]?.organization_id || null
                if (orgId) insertPayload.organization_id = orgId
              }
            }
          } catch {}
        }
        const { error: commErr } = await supabaseAdmin
          .from('communications')
          .insert([insertPayload])
        if (commErr) console.error('[instagram] erro inserindo communication:', commErr.message)
      }

      // Formato via "changes" (Instagram Graph Webhooks)
      const changes = entry.changes || []
      for (const ch of changes) {
        const messages = ch?.value?.messages || []
        for (const msg of messages) {
          const senderId = msg.from?.id || msg.from
          const text = msg.text || msg.message || ''
          const externalId = msg.id || null
          if (!senderId || !text) continue
          const insertPayload = {
            lead_id: null,
            user_id: null,
            type: 'instagram',
            direction: 'inbound',
            subject: null,
            content: text,
            status: 'read',
            external_id: senderId,
          }
          if (orgIdFromSetting) insertPayload.organization_id = orgIdFromSetting
          try {
            const auth = req.headers.authorization || ''
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
            if (token) {
              const { data: u } = await supabaseAdmin.auth.getUser(token)
              const userId = u?.user?.id
              if (userId) {
                const { data: mem } = await supabaseAdmin
                  .from('organization_members')
                  .select('organization_id')
                  .eq('user_id', userId)
                  .limit(1)
                const orgId = mem?.[0]?.organization_id || null
                if (orgId) insertPayload.organization_id = orgId
              }
            }
          } catch {}
          const { error: commErr } = await supabaseAdmin
            .from('communications')
            .insert([insertPayload])
          if (commErr) console.error('[instagram] erro inserindo communication (changes):', commErr.message)
        }
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('[instagram] inbound error', e)
    return res.sendStatus(500)
  }
})

// Messenger inbound webhook handler
app.post('/webhooks/messenger', async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) return res.sendStatus(403)
    const body = parseJsonBody(req)
    const entries = Array.isArray(body?.entry) ? body.entry : []
    for (const entry of entries) {
      const messaging = entry.messaging || []
      for (const event of messaging) {
        const senderId = event.sender?.id
        const text = event.message?.text || event.message?.message || ''
        if (!senderId || !text) continue

        // Não há mapeamento por telefone. Opcional: armazenar messenger_psid em lead para mapear. Aqui gravamos sem vínculo e correlacionamos depois.
        const insertPayload = {
          lead_id: null,
          user_id: null,
          type: 'messenger',
          direction: 'inbound',
          subject: null,
          content: text,
          status: 'read',
          external_id: senderId,
        }
        try {
          const auth = req.headers.authorization || ''
          const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
          if (token) {
            const { data: u } = await supabaseAdmin.auth.getUser(token)
            const userId = u?.user?.id
            if (userId) {
              const { data: mem } = await supabaseAdmin
                .from('organization_members')
                .select('organization_id')
                .eq('user_id', userId)
                .limit(1)
              const orgId = mem?.[0]?.organization_id || null
              if (orgId) insertPayload.organization_id = orgId
            }
          }
        } catch {}
        const { error: commErr } = await supabaseAdmin
          .from('communications')
          .insert([insertPayload])
        if (commErr) console.error('[messenger] erro inserindo communication:', commErr.message)
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('[messenger] inbound error', e)
    return res.sendStatus(500)
  }
})

// OAuth Instagram - gerar URL
app.get('/auth/instagram/url', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const state = signState(user.id)
    const clientId = process.env.META_APP_ID
    const redirectUri = process.env.META_REDIRECT_URI_INSTAGRAM || process.env.META_REDIRECT_URI
    const scope = encodeURIComponent('instagram_basic,pages_show_list,instagram_manage_messages,pages_messaging')
    if (!clientId || !redirectUri) return res.status(500).json({ error: 'META_APP_ID/META_REDIRECT_URI_INSTAGRAM ausentes' })
    const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scope}`
    return res.json({ url })
  } catch (e) {
    console.error('[auth/instagram/url] error', e)
    return res.sendStatus(500)
  }
})

// OAuth Instagram - callback
app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    const userId = verifyState(state)
    if (!userId) return res.status(400).send('invalid_state')
    const clientId = process.env.META_APP_ID
    const clientSecret = process.env.META_APP_SECRET
    const redirectUri = process.env.META_REDIRECT_URI_INSTAGRAM || process.env.META_REDIRECT_URI
    if (!clientId || !clientSecret || !redirectUri) return res.status(500).send('meta_config_missing_instagram')

    // Short-lived token
    const tokenResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`)
    const tokenJson = await tokenResp.json()
    if (!tokenResp.ok) {
      console.error('[auth/instagram/callback] token error', tokenJson)
      return res.status(502).send('token_exchange_failed')
    }
    const shortToken = tokenJson.access_token

    // Exchange for long-lived token
    const longResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(shortToken)}`)
    const longJson = await longResp.json()
    const access_token = longJson.access_token || shortToken
    const expires_in = longJson.expires_in || tokenJson.expires_in || null

    // Salvar nas settings do usuário
    const { error: setErr } = await supabaseAdmin
      .from('settings')
      .upsert({
        user_id: userId,
        key: 'instagram',
        value: { access_token, connected_at: new Date().toISOString(), expires_in },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' })
    if (setErr) {
      console.error('[auth/instagram/callback] settings upsert error', setErr.message)
    }

    return res.send('<script>window.close && window.close(); window.opener && window.opener.postMessage({ type: "instagram_connected" }, "*");</script>Conexão concluída. Você pode fechar esta janela.')
  } catch (e) {
    console.error('[auth/instagram/callback] error', e)
    return res.status(500).send('internal_error')
  }
})

// Endpoint para refresh de long-lived token Instagram (opcional via CRON)
app.post('/api/instagram/refresh-token', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'instagram')
      .single()
    const token = setting?.value?.access_token
    if (!token) return res.status(400).json({ error: 'instagram_not_connected' })

    // Para long-lived tokens, a Meta oferece extensão/refresh similar
    const clientId = process.env.META_APP_ID
    const clientSecret = process.env.META_APP_SECRET
    const longResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(token)}`)
    const longJson = await longResp.json()
    if (!longResp.ok) return res.status(502).json(longJson)

    const access_token = longJson.access_token || token
    const expires_in = longJson.expires_in || null

    const newValue = { ...(setting?.value || {}), access_token, refreshed_at: new Date().toISOString(), expires_in }
    const { error: upErr } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'instagram', value: newValue, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/instagram/refresh-token] error', e)
    return res.sendStatus(500)
  }
})

// Listar contas do Instagram do usuário autenticado (via páginas)
app.get('/api/instagram/accounts', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'instagram')
      .single()
    const token = setting?.value?.access_token
    if (!token) return res.status(400).json({ error: 'instagram_not_connected' })

    const meResp = await fetch('https://graph.facebook.com/v20.0/me?fields=id,name', { headers: { Authorization: `Bearer ${token}` } })
    const me = await meResp.json()

    // Listar páginas do usuário e ig_business_account
    const pagesResp = await fetch(`https://graph.facebook.com/v20.0/${me.id}/accounts?fields=id,name,instagram_business_account`, { headers: { Authorization: `Bearer ${token}` } })
    const pages = await pagesResp.json()

    const accounts = []
    for (const pg of (pages.data || [])) {
      const ig = pg.instagram_business_account
      if (ig?.id) {
        // Buscar username da conta
        const igResp = await fetch(`https://graph.facebook.com/v20.0/${ig.id}?fields=username`, { headers: { Authorization: `Bearer ${token}` } })
        const igJson = await igResp.json()
        accounts.push({ ig_user_id: ig.id, username: igJson.username || ig.id, page_id: pg.id, page_name: pg.name })
      }
    }

    return res.json({ accounts })
  } catch (e) {
    console.error('[api/instagram/accounts] error', e)
    return res.sendStatus(500)
  }
})

// Selecionar conta do Instagram
app.post('/api/instagram/select-account', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { ig_user_id } = req.body
    if (!ig_user_id) return res.status(400).json({ error: 'ig_user_id_required' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'instagram')
      .single()
    const value = setting?.value || {}
    value.ig_user_id = ig_user_id

    const { error: upErr } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'instagram', value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/instagram/select-account] error', e)
    return res.sendStatus(500)
  }
})

// Envio de mensagem Instagram para um lead (usa credenciais do owner do lead)
app.post('/api/messages/instagram', async (req, res) => {
  try {
    const { leadId, body } = req.body
    if (!leadId || !body) return res.status(400).json({ error: 'leadId e body são obrigatórios' })

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', lead.user_id)
      .eq('key', 'instagram')
      .single()

    const token = setting?.value?.access_token
    const igUserId = setting?.value?.ig_user_id
    if (!token || !igUserId) return res.status(500).json({ error: 'Instagram não configurado. Conecte sua conta e selecione uma conta IG.' })

    // Recuperar último senderId de inbound para este lead
    const { data: lastInbound } = await supabaseAdmin
      .from('communications')
      .select('*')
      .eq('lead_id', leadId)
      .eq('type', 'instagram')
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const recipientId = lastInbound?.external_id
    if (!recipientId) return res.status(400).json({ error: 'Sem ID de destinatário IG para este lead (requer mensagem inbound prévia).' })

    const url = `https://graph.facebook.com/v20.0/${igUserId}/messages`
    const payload = { recipient: { id: recipientId }, message: { text: body } }

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    const json = await r.json()
    if (!r.ok) {
      console.error('[instagram] send error', json)
      return res.status(502).json(json)
    }

    const externalId = json?.message_id || null
    await supabaseAdmin.from('communications').insert([
      {
        lead_id: lead.id,
        user_id: lead.user_id,
        type: 'instagram',
        direction: 'outbound',
        subject: null,
        content: body,
        status: 'sent',
        external_id: externalId,
        organization_id: lead.organization_id || null,
      }
    ])

    return res.json({ ok: true, id: externalId })
  } catch (e) {
    console.error('[instagram] send exception', e)
    return res.sendStatus(500)
  }
})

// OAuth Messenger - gerar URL (usa mesma app Meta)
app.get('/auth/messenger/url', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const state = signState(user.id)
    const clientId = process.env.META_APP_ID
    const redirectUri = process.env.META_REDIRECT_URI_MESSENGER || process.env.META_REDIRECT_URI
    const scope = encodeURIComponent('pages_messaging,pages_show_list')
    if (!clientId || !redirectUri) return res.status(500).json({ error: 'META_APP_ID/META_REDIRECT_URI_MESSENGER ausentes' })
    const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scope}`
    return res.json({ url })
  } catch (e) {
    console.error('[auth/messenger/url] error', e)
    return res.sendStatus(500)
  }
})

// OAuth Messenger - callback (mesma lógica de trocar por long-lived)
app.get('/auth/messenger/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    const userId = verifyState(state)
    if (!userId) return res.status(400).send('invalid_state')
    const clientId = process.env.META_APP_ID
    const clientSecret = process.env.META_APP_SECRET
    const redirectUri = process.env.META_REDIRECT_URI_MESSENGER || process.env.META_REDIRECT_URI
    if (!clientId || !clientSecret || !redirectUri) return res.status(500).send('meta_config_missing_messenger')

    const tokenResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`)
    const tokenJson = await tokenResp.json()
    if (!tokenResp.ok) {
      console.error('[auth/messenger/callback] token error', tokenJson)
      return res.status(502).send('token_exchange_failed')
    }
    const shortToken = tokenJson.access_token

    const longResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(shortToken)}`)
    const longJson = await longResp.json()
    const access_token = longJson.access_token || shortToken
    const expires_in = longJson.expires_in || tokenJson.expires_in || null

    const { error: setErr } = await supabaseAdmin
      .from('settings')
      .upsert({
        user_id: userId,
        key: 'messenger',
        value: { access_token, connected_at: new Date().toISOString(), expires_in },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' })
    if (setErr) console.error('[auth/messenger/callback] settings upsert error', setErr.message)

    return res.send('<script>window.close && window.close(); window.opener && window.opener.postMessage({ type: "messenger_connected" }, "*");</script>Conexão concluída. Você pode fechar esta janela.')
  } catch (e) {
    console.error('[auth/messenger/callback] error', e)
    return res.status(500).send('internal_error')
  }
})

// Listar páginas do usuário para Messenger
app.get('/api/messenger/pages', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'messenger')
      .single()
    const token = setting?.value?.access_token
    if (!token) return res.status(400).json({ error: 'messenger_not_connected' })

    const meResp = await fetch('https://graph.facebook.com/v20.0/me?fields=id,name', { headers: { Authorization: `Bearer ${token}` } })
    const me = await meResp.json()

    const pagesResp = await fetch(`https://graph.facebook.com/v20.0/${me.id}/accounts?fields=id,name`, { headers: { Authorization: `Bearer ${token}` } })
    const pages = await pagesResp.json()

    const out = (pages.data || []).map((p) => ({ page_id: p.id, page_name: p.name }))
    return res.json({ pages: out })
  } catch (e) {
    console.error('[api/messenger/pages] error', e)
    return res.sendStatus(500)
  }
})

// Selecionar página para Messenger
app.post('/api/messenger/select-page', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { page_id } = req.body
    if (!page_id) return res.status(400).json({ error: 'page_id_required' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'messenger')
      .single()
    const value = setting?.value || {}
    value.page_id = page_id

    const { error: upErr } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'messenger', value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/messenger/select-page] error', e)
    return res.sendStatus(500)
  }
})

// Enviar mensagem Messenger
app.post('/api/messages/messenger', async (req, res) => {
  try {
    const { leadId, body } = req.body
    if (!leadId || !body) return res.status(400).json({ error: 'leadId e body são obrigatórios' })

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' })

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', lead.user_id)
      .eq('key', 'messenger')
      .single()

    const token = setting?.value?.access_token
    const pageId = setting?.value?.page_id
    if (!token || !pageId) return res.status(500).json({ error: 'Messenger não configurado. Conecte e selecione uma página.' })

    // Descobrir recipientId: usar último inbound messenger do lead
    const { data: lastInbound } = await supabaseAdmin
      .from('communications')
      .select('*')
      .eq('lead_id', leadId)
      .eq('type', 'messenger')
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const recipientId = lastInbound?.external_id
    if (!recipientId) return res.status(400).json({ error: 'Sem PSID para este lead (requer mensagem inbound prévia).' })

    const url = `https://graph.facebook.com/v20.0/${pageId}/messages`
    const payload = { recipient: { id: recipientId }, message: { text: body } }

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    const json = await r.json()
    if (!r.ok) {
      console.error('[messenger] send error', json)
      return res.status(502).json(json)
    }

    const externalId = json?.message_id || null
    await supabaseAdmin.from('communications').insert([
      {
        lead_id: lead.id,
        user_id: lead.user_id,
        type: 'messenger',
        direction: 'outbound',
        subject: null,
        content: body,
        status: 'sent',
        external_id: externalId,
        organization_id: lead.organization_id || null,
      }
    ])

    return res.json({ ok: true, id: externalId })
  } catch (e) {
    console.error('[messenger] send exception', e)
    return res.sendStatus(500)
  }
})

// OAuth WhatsApp - gerar URL
app.get('/auth/whatsapp/url', async (req, res) => res.status(404).json({ error: 'disabled' }))

// OAuth WhatsApp - callback
app.get('/auth/whatsapp/callback', async (req, res) => res.status(404).send('disabled'))

// Listar números do WhatsApp do usuário autenticado (opcional para selecionar)
app.get('/api/whatsapp/phones', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    // Multiusuário: buscar configuração do usuário
    const { data: non } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()

    // Config por organização
    let orgId = null
    try {
      const { data: mem } = await supabaseAdmin
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .limit(1)
      orgId = mem?.[0]?.organization_id || null
    } catch {}
    const { data: orgCfg } = orgId ? await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', orgId)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle() : { data: null }

    if (WHATSAPP_PROVIDER !== 'meta' || non || orgCfg) {
      const cfg = non?.value || orgCfg?.value
      const connected = Boolean(cfg?.provider && cfg?.instance_id && cfg?.token)
      return res.json({ phones: connected ? [{ id: `${cfg?.provider}:${cfg?.instance_id}`, number: '+55 00 00000-0000', waba_id: 'nonofficial' }] : [] })
    }

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp')
      .single()
    const token = setting?.value?.access_token
    if (!token) return res.status(400).json({ error: 'whatsapp_not_connected' })

    // Buscar WABA e telefones
    const meResp = await fetch('https://graph.facebook.com/v20.0/me?fields=id,name', { headers: { Authorization: `Bearer ${token}` } })
    const me = await meResp.json()
    const wabasResp = await fetch(`https://graph.facebook.com/v20.0/${me.id}/owned_whatsapp_business_accounts?fields=id,name`, { headers: { Authorization: `Bearer ${token}` } })
    const wabas = await wabasResp.json()
    const phones = []
    for (const waba of (wabas.data || [])) {
      const phoneResp = await fetch(`https://graph.facebook.com/v20.0/${waba.id}/phone_numbers?fields=id,display_phone_number`, { headers: { Authorization: `Bearer ${token}` } })
      const phoneJson = await phoneResp.json()
      for (const p of (phoneJson.data || [])) phones.push({ id: p.id, number: p.display_phone_number, waba_id: waba.id })
    }
    return res.json({ phones })
  } catch (e) {
    console.error('[api/whatsapp/phones] error', e)
    return res.sendStatus(500)
  }
})

// Selecionar número do WhatsApp
app.post('/api/whatsapp/select-number', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { phone_number_id } = req.body
    if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id_required' })

    if (WHATSAPP_PROVIDER !== 'meta') {
      // Não há seleção real em provedores não-oficiais; apenas aceita
      return res.json({ ok: true })
    }

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp')
      .single()
    const value = setting?.value || {}
    value.phone_number_id = phone_number_id

    const { error: upErr } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'whatsapp', value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/whatsapp/select-number] error', e)
    return res.sendStatus(500)
  }
})

// Informações da integração do WhatsApp do usuário atual
app.get('/api/whatsapp/me', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    // Multiusuário: configuração não-oficial por usuário
    const { data: non } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()

    // Config por organização
    let orgId = null
    try {
      const { data: mem } = await supabaseAdmin
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .limit(1)
      orgId = mem?.[0]?.organization_id || null
    } catch {}
    const { data: orgCfg } = orgId ? await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', orgId)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle() : { data: null }

    if (WHATSAPP_PROVIDER !== 'meta' || non || orgCfg) {
      const cfg = non?.value || orgCfg?.value
      const connected = Boolean(cfg?.provider && cfg?.instance_id && cfg?.token) || (
        (WHATSAPP_PROVIDER === 'wapi') && Boolean(process.env.WAPI_INSTANCE_ID && process.env.WAPI_TOKEN)
      )
      const id = cfg?.instance_id || process.env.WAPI_INSTANCE_ID || null
      return res.json({ connected, phone_number_id: connected && id ? `${cfg?.provider || 'wapi'}:${id}` : null })
    }

    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp')
      .maybeSingle()

    if (!setting) return res.json({ connected: false })

    const phone_number_id = setting?.value?.phone_number_id || null
    return res.json({ connected: true, phone_number_id })
  } catch (e) {
    console.error('[api/whatsapp/me] error', e)
    return res.sendStatus(500)
  }
})

// Desconectar WhatsApp (remove credenciais do usuário)
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { error } = await supabaseAdmin
      .from('settings')
      .delete()
      .eq('user_id', user.id)
      .in('key', ['whatsapp', 'whatsapp_nonofficial'])
    if (error) return res.status(500).json({ error: error.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/whatsapp/disconnect] error', e)
    return res.sendStatus(500)
  }
})

// Configuração AI por organização
app.post('/api/org/ai-prequal/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id, enabled, provider, model, minScore, createLead, createDeal, stageMap, system, prompt_prefix } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })
    const value = { enabled: Boolean(enabled), provider, model, minScore, createLead, createDeal, stageMap, system, prompt_prefix }
    const { error } = await supabaseAdmin
      .from('organization_settings')
      .upsert({ organization_id, key: 'ai_prequal', value, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/org/ai-prequal/config] error', e)
    return res.sendStatus(500)
  }
})

app.get('/api/org/ai-prequal/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const orgId = String(req.query.organization_id || '')
    if (!orgId) return res.status(400).json({ error: 'organization_id é obrigatório' })
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })
    const { data } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', orgId)
      .eq('key', 'ai_prequal')
      .maybeSingle()
    return res.json({ config: data?.value || null })
  } catch (e) {
    console.error('[api/org/ai-prequal/config:get] error', e)
    return res.sendStatus(500)
  }
})

// Configuração do Pipeline (rótulos de estágios) por organização
app.post('/api/org/pipeline/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id, stageLabels } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
    if (!stageLabels || typeof stageLabels !== 'object') return res.status(400).json({ error: 'stageLabels é obrigatório' })

    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })

    const value = { stageLabels }
    const { error } = await supabaseAdmin
      .from('organization_settings')
      .upsert({ organization_id, key: 'pipeline', value, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/org/pipeline/config] error', e)
    return res.sendStatus(500)
  }
})

app.get('/api/org/pipeline/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const organization_id = String(req.query.organization_id || '')
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })

    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })

    const { data } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', organization_id)
      .eq('key', 'pipeline')
      .maybeSingle()
    return res.json({ config: data?.value || null })
  } catch (e) {
    console.error('[api/org/pipeline/config:get] error', e)
    return res.sendStatus(500)
  }
})

// Configuração do Autentique por organização
app.post('/api/org/autentique/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id, token } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
    if (!token) return res.status(400).json({ error: 'token é obrigatório' })

    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })

    const value = { token: String(token) }
    const { error } = await supabaseAdmin
      .from('organization_settings')
      .upsert({ organization_id, key: 'autentique', value, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/org/autentique/config] error', e)
    return res.sendStatus(500)
  }
})

app.get('/api/org/autentique/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const organization_id = String(req.query.organization_id || '')
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })

    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })

    const { data } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', organization_id)
      .eq('key', 'autentique')
      .maybeSingle()
    const has = Boolean(data?.value?.token || process.env.AUTENTIQUE_TOKEN)
    return res.json({ connected: has })
  } catch (e) {
    console.error('[api/org/autentique/config:get] error', e)
    return res.sendStatus(500)
  }
})

// Salvar configuração do provedor não-oficial por usuário
app.post('/api/whatsapp/nonofficial/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { provider, instance_id, token, base_url } = req.body || {}
    if (!provider || !instance_id || !token) return res.status(400).json({ error: 'provider, instance_id e token são obrigatórios' })
    const value = { provider: String(provider).toLowerCase(), instance_id: String(instance_id), token: String(token), ...(base_url ? { base_url: String(base_url) } : {}) }
    const { error } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'whatsapp_nonofficial', value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/whatsapp/nonofficial/config] error', e)
    return res.sendStatus(500)
  }
})

// Obter configuração salva do provedor não-oficial
app.get('/api/whatsapp/nonofficial/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { data } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    return res.json({ config: data?.value || null })
  } catch (e) {
    console.error('[api/whatsapp/nonofficial/config:get] error', e)
    return res.sendStatus(500)
  }
})

// Configuração do WhatsApp (não-oficial) por organização — visível a todos os membros, editável por admin/manager
app.post('/api/org/whatsapp/nonofficial/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { provider, instance_id, token, base_url, client_token, organization_id } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })

    // Verifica se user é admin/manager da org
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })

    if (!provider || !instance_id || !token) return res.status(400).json({ error: 'provider, instance_id e token são obrigatórios' })
    const value = { provider: String(provider).toLowerCase(), instance_id: String(instance_id), token: String(token), ...(base_url ? { base_url: String(base_url) } : {}), ...(client_token ? { client_token: String(client_token) } : {}) }
    const { error } = await supabaseAdmin
      .from('organization_settings')
      .upsert({ organization_id, key: 'whatsapp_nonofficial', value, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/org/whatsapp/nonofficial/config] error', e)
    return res.sendStatus(500)
  }
})

app.get('/api/org/whatsapp/nonofficial/config', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const orgId = String(req.query.organization_id || '')
    if (!orgId) return res.status(400).json({ error: 'organization_id é obrigatório' })
    // Confirma membership
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })
    const { data } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', orgId)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    return res.json({ config: data?.value || null })
  } catch (e) {
    console.error('[api/org/whatsapp/nonofficial/config:get] error', e)
    return res.sendStatus(500)
  }
})

// Listar chats/contatos do provedor (Z-API) e opcionalmente importar como leads
app.post('/api/org/whatsapp/zapi/sync-contacts', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id, importLeads = false, page = 1, pageSize = 100 } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })

    // Verifica membership
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })

    // Carrega config org (zapi)
    const { data: orgCfg } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', organization_id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    const cfg = orgCfg?.value || {}
    if ((cfg.provider || 'zapi') !== 'zapi') return res.status(400).json({ error: 'provider_not_zapi' })
    const baseUrl = cfg.base_url || process.env.ZAPI_BASE_URL || 'https://api.z-api.io'
    const instanceId = cfg.instance_id || process.env.ZAPI_INSTANCE_ID
    const token = cfg.token || process.env.ZAPI_TOKEN
    const clientToken = cfg.client_token || process.env.ZAPI_CLIENT_TOKEN
    if (!instanceId || !token) return res.status(400).json({ error: 'zapi_missing_config' })

    const url = `${String(baseUrl).replace(/\/$/, '')}/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(token)}/chats?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`
    const r = await fetch(url, { headers: { ...(clientToken ? { 'Client-Token': clientToken } : {}) } })
    const js = await r.json()
    if (!r.ok) return res.status(502).json(js)
    const chats = Array.isArray(js) ? js : (Array.isArray(js?.data) ? js.data : [])

    let imported = 0
    if (importLeads && Array.isArray(chats)) {
      for (const c of chats) {
        const phoneDigits = normalizePhoneDigits(c.phone || c.id || '')
        if (!phoneDigits) continue
        // existe?
        const { data: existing } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('organization_id', organization_id)
          .ilike('phone', `%${phoneDigits.slice(-8)}%`)
          .limit(1)
        if (existing && existing.length > 0) continue
        // cria lead básico
        const ownerUserId = await pickOrgOwnerUserId(organization_id)
        if (!ownerUserId) continue
        await supabaseAdmin
          .from('leads')
          .insert([{
            name: c.name || `Contato ${phoneDigits.slice(-4)}`,
            company: '—',
            phone: phoneDigits,
            email: null,
            value: 0,
            status: 'new',
            responsible: 'Import',
            source: 'whatsapp',
            tags: ['zapi-import'],
            notes: null,
            user_id: ownerUserId,
            organization_id,
          }])
        imported++
      }
    }

    return res.json({ chats, imported })
  } catch (e) {
    console.error('[zapi] sync contacts error', e)
    return res.sendStatus(500)
  }
})

app.post('/api/org/whatsapp/nonofficial/disconnect', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
    // Verifica admin/manager
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })
    const { error } = await supabaseAdmin
      .from('organization_settings')
      .delete()
      .eq('organization_id', organization_id)
      .eq('key', 'whatsapp_nonofficial')
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[api/org/whatsapp/nonofficial/disconnect] error', e)
    return res.sendStatus(500)
  }
})

// Quick Replies (WhatsApp) — listar
app.get('/api/whatsapp/quick-replies', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const scope = String(req.query.scope || 'user')
    if (scope === 'org' || scope === 'organization') {
      const organization_id = String(req.query.organization_id || '')
      if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
      // Qualquer membro pode ler
      const { data: membership } = await supabaseAdmin
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('organization_id', organization_id)
        .maybeSingle()
      if (!membership) return res.status(403).json({ error: 'forbidden' })
      const { data } = await supabaseAdmin
        .from('organization_settings')
        .select('value')
        .eq('organization_id', organization_id)
        .eq('key', 'whatsapp_quick_replies')
        .maybeSingle()
      const raw = (data?.value?.items || data?.value || []) || []
      const items = (Array.isArray(raw) ? raw : []).map((it) => {
        if (typeof it === 'string') {
          const t = it.length > 60 ? it.slice(0, 60) : it
          return { title: t, content: it }
        }
        const content = String(it?.content ?? it?.text ?? '')
        const title = String(it?.title || '').trim()
        const finalTitle = title || (content ? (content.length > 60 ? content.slice(0, 60) : content) : '')
        return { title: finalTitle, content }
      }).filter((x) => x && x.content)
      return res.json({ items })
    }
    // user scope
    const { data } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'whatsapp_quick_replies')
      .maybeSingle()
    const raw = (data?.value?.items || data?.value || []) || []
    const items = (Array.isArray(raw) ? raw : []).map((it) => {
      if (typeof it === 'string') {
        const t = it.length > 60 ? it.slice(0, 60) : it
        return { title: t, content: it }
      }
      const content = String(it?.content ?? it?.text ?? '')
      const title = String(it?.title || '').trim()
      const finalTitle = title || (content ? (content.length > 60 ? content.slice(0, 60) : content) : '')
      return { title: finalTitle, content }
    }).filter((x) => x && x.content)
    return res.json({ items })
  } catch (e) {
    console.error('[quick-replies:get] error', e)
    return res.sendStatus(500)
  }
})

// Quick Replies (WhatsApp) — salvar
app.post('/api/whatsapp/quick-replies', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { scope = 'user', organization_id, items } = req.body || {}
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items deve ser uma lista' })
    const normalized = items.map((it) => {
      if (typeof it === 'string') {
        const t = it.length > 60 ? it.slice(0, 60) : it
        return { title: t, content: it }
      }
      const content = String(it?.content ?? it?.text ?? '').trim()
      const title = String(it?.title || '').trim()
      const finalTitle = title || (content ? (content.length > 60 ? content.slice(0, 60) : content) : '')
      return { title: finalTitle, content }
    }).filter((x) => x && x.content)
    const value = { items: normalized }
    if (String(scope) === 'org' || String(scope) === 'organization') {
      if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })
      // Apenas admin/manager pode salvar
      const { data: membership } = await supabaseAdmin
        .from('organization_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('organization_id', organization_id)
        .maybeSingle()
      if (!membership || !['admin','manager'].includes(String(membership.role))) return res.status(403).json({ error: 'forbidden' })
      const { error } = await supabaseAdmin
        .from('organization_settings')
        .upsert({ organization_id, key: 'whatsapp_quick_replies', value, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,key' })
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }
    // user scope
    const { error } = await supabaseAdmin
      .from('settings')
      .upsert({ user_id: user.id, key: 'whatsapp_quick_replies', value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (e) {
    console.error('[quick-replies:post] error', e)
    return res.sendStatus(500)
  }
})

// Listar chats/contatos do provedor (W-API) e opcionalmente importar como leads
app.post('/api/org/whatsapp/wapi/sync-contacts', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { organization_id, importLeads = false, page = 1, pageSize = 100 } = req.body || {}
    if (!organization_id) return res.status(400).json({ error: 'organization_id é obrigatório' })

    // Verifica membership
    const { data: membership } = await supabaseAdmin
      .from('organization_members')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .maybeSingle()
    if (!membership) return res.status(403).json({ error: 'forbidden' })

    // Carrega config org (wapi)
    const { data: orgCfg } = await supabaseAdmin
      .from('organization_settings')
      .select('value')
      .eq('organization_id', organization_id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    const cfg = orgCfg?.value || {}
    if ((cfg.provider || 'wapi') !== 'wapi') return res.status(400).json({ error: 'provider_not_wapi' })
    const baseUrl = cfg.base_url || process.env.WAPI_BASE_URL || 'https://api.w-api.app'
    const instanceId = cfg.instance_id || process.env.WAPI_INSTANCE_ID
    const token = cfg.token || process.env.WAPI_TOKEN
    if (!instanceId || !token) return res.status(400).json({ error: 'wapi_missing_config' })

    const base = String(baseUrl).replace(/\/$/, '')
    const p = Number.isFinite(Number(page)) ? Number(page) : 1
    const ps = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.min(500, Number(pageSize))) : 100
    const url = `${base}/v1/contacts/fetch-contacts?instanceId=${encodeURIComponent(instanceId)}&perPage=${encodeURIComponent(String(ps))}&page=${encodeURIComponent(String(p))}`
    let chats = []
    let lastError = null
    try {
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, ...(cfg?.client_token ? { 'Client-Token': cfg.client_token } : {}) } })
      let js = null
      let txt = ''
      try { js = await r.json() } catch { try { txt = await r.text() } catch {} }
      if (!r.ok) {
        return res.status(502).json({ status: r.status, url, body: js || txt || null })
      }
      const arr = Array.isArray(js) ? js
        : (Array.isArray(js?.contacts) ? js.contacts
        : (Array.isArray(js?.data?.contacts) ? js.data.contacts
        : (Array.isArray(js?.data) ? js.data
        : (Array.isArray(js?.result) ? js.result
        : (Array.isArray(js?.items) ? js.items : [])))))
      chats = arr.map((c) => ({
        id: c?.id || c?.phone || c?.number || c?.waId || c?.chatId || c?.remoteJid || c?.jid || null,
        name: c?.name || c?.pushName || c?.displayName || c?.username || c?.contactName || null,
        phone: normalizePhoneDigits(c?.phone || c?.number || c?.waId || c?.id || c?.chatId || c?.remoteJid || c?.jid || ''),
      })).filter((x) => x.phone)
    } catch (e) {
      lastError = e
    }
    if (!Array.isArray(chats)) chats = []

    let imported = 0
    if (importLeads && Array.isArray(chats)) {
      for (const c of chats) {
        const phoneDigits = normalizePhoneDigits(c.phone || c.id || '')
        if (!phoneDigits) continue
        const { data: existing } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('organization_id', organization_id)
          .ilike('phone', `%${phoneDigits.slice(-8)}%`)
          .limit(1)
        if (existing && existing.length > 0) continue
        const ownerUserId = await pickOrgOwnerUserId(organization_id)
        if (!ownerUserId) continue
        await supabaseAdmin
          .from('leads')
          .insert([{ 
            name: c.name || `Contato ${phoneDigits.slice(-4)}`,
            company: '—',
            phone: phoneDigits,
            email: null,
            value: 0,
            status: 'new',
            responsible: 'Import',
            source: 'whatsapp',
            tags: ['wapi-import'],
            notes: null,
            user_id: ownerUserId,
            organization_id,
          }])
        imported++
      }
    }

    if (!chats.length && lastError) return res.status(502).json({ error: String(lastError?.message || lastError), url })
    return res.json({ chats, imported })
  } catch (e) {
    console.error('[wapi] sync contacts error', e)
    return res.sendStatus(500)
  }
})

// Envio de mensagem WhatsApp para um lead (usa credenciais do owner do lead)
app.post('/api/messages/whatsapp', async (req, res) => {
  try {
    const { leadId, body } = req.body
    if (!leadId || !body) return res.status(400).json({ error: 'leadId e body são obrigatórios' })

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' })

    const to = String(lead.phone || '').replace(/\D/g, '')

    // Buscar config do owner do lead (não-oficial)
    const { data: non } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', lead.user_id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    // Org fallback
    let orgCfg = null
    try {
      const { data: cfg } = await supabaseAdmin
        .from('organization_settings')
        .select('value')
        .eq('organization_id', lead.organization_id)
        .eq('key', 'whatsapp_nonofficial')
        .maybeSingle()
      orgCfg = cfg || null
    } catch {}

    if (WHATSAPP_PROVIDER !== 'meta' || non || orgCfg) {
      try {
        const cfg = non?.value || orgCfg?.value
        const externalId = await sendWhatsAppNonOfficial(to, body, lead, cfg)
        await supabaseAdmin.from('communications').insert([
          {
            lead_id: lead.id,
            user_id: lead.user_id,
            type: 'whatsapp',
            direction: 'outbound',
            subject: null,
            content: body,
            status: 'sent',
            external_id: externalId || null,
            organization_id: lead.organization_id || null,
          }
        ])
        return res.json({ ok: true, id: externalId || null })
      } catch (e) {
        return res.status(502).json({ error: String(e?.message || e || 'send_failed') })
      }
    }

    // Buscar credenciais do owner do lead
    const { data: setting } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', lead.user_id)
      .eq('key', 'whatsapp')
      .single()

    let phoneNumberId = setting?.value?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID
    let token = setting?.value?.access_token || process.env.WHATSAPP_ACCESS_TOKEN
    if (!phoneNumberId || !token) return res.status(500).json({ error: 'WhatsApp não configurado. Conecte sua conta.' })

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }

    const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const json = await r.json()
    if (!r.ok) {
      console.error('[whatsapp] send error', json)
      return res.status(502).json(json)
    }

    const externalId = json?.messages?.[0]?.id || null
    await supabaseAdmin.from('communications').insert([
      {
        lead_id: lead.id,
        user_id: lead.user_id,
        type: 'whatsapp',
        direction: 'outbound',
        subject: null,
        content: body,
        status: 'sent',
        external_id: externalId,
        organization_id: lead.organization_id || null,
      }
    ])

    return res.json({ ok: true, id: externalId })
  } catch (e) {
    console.error('[whatsapp] send exception', e)
    return res.sendStatus(500)
  }
})

// Envio de mídia WhatsApp (não-oficial via W-API) para um lead
app.post('/api/messages/whatsapp/media', async (req, res) => {
  try {
    const { leadId, media } = req.body || {}
    if (!leadId || !media) return res.status(400).json({ error: 'leadId e media são obrigatórios' })

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' })

    const to = String(lead.phone || '').replace(/\D/g, '')

    // Buscar config (prioriza usuário, fallback org)
    const { data: non } = await supabaseAdmin
      .from('settings')
      .select('value')
      .eq('user_id', lead.user_id)
      .eq('key', 'whatsapp_nonofficial')
      .maybeSingle()
    let orgCfg = null
    try {
      const { data: cfg } = await supabaseAdmin
        .from('organization_settings')
        .select('value')
        .eq('organization_id', lead.organization_id)
        .eq('key', 'whatsapp_nonofficial')
        .maybeSingle()
      orgCfg = cfg || null
    } catch {}

    const cfg = non?.value || orgCfg?.value || null
    if (!cfg || (cfg.provider || 'wapi') !== 'wapi') {
      return res.status(400).json({ error: 'Envio de mídia requer W-API configurado' })
    }

    try {
      const externalId = await sendWhatsAppNonOfficialMedia(to, media, lead, cfg)
      await supabaseAdmin.from('communications').insert([
        {
          lead_id: lead.id,
          user_id: lead.user_id,
          type: 'whatsapp',
          direction: 'outbound',
          subject: null,
          content: media?.caption || (media?.url ? `[media] ${media.url}` : '[media]'),
          status: 'sent',
          external_id: externalId || null,
          organization_id: lead.organization_id || null,
        }
      ])
      return res.json({ ok: true, id: externalId || null })
    } catch (e) {
      return res.status(502).json({ error: String(e?.message || e || 'send_failed') })
    }
  } catch (e) {
    console.error('[whatsapp/media] send exception', e)
    return res.sendStatus(500)
  }
})

// Webhook UltraMsg (não requer verificação de assinatura)
app.post('/webhooks/ultramsg', async (req, res) => {
  try {
    const body = parseJsonBody(req)
    const data = body || {}
    const instanceId = data?.instanceId || data?.instance_id || data?.instance || null
    // Tenta normalizar campos
    const fromRaw = data.from || data.sender || data.phone || data.waId || data.senderId || (data.instanceId && data.data?.from) || null
    const text = data.body || data.message || data.text || data.data?.body || ''
    const externalId = data.id || data.messageId || data.idMessage || data.data?.id || null
    if (!fromRaw || !text) return res.status(200).json({ ok: true })

    const from = String(fromRaw).replace(/\D/g, '')

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .ilike('phone', `%${from.slice(-8)}%`)
      .limit(1)

    let lead = (leads || [])[0]

    // Tentar resolver organização via instanceId se não houver lead vinculado
    let orgId = lead?.organization_id || null
    if (!orgId && instanceId) {
      try {
        const { data: orgCfg } = await supabaseAdmin
          .from('organization_settings')
          .select('organization_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'ultramsg')
          .filter('value->>instance_id', 'eq', String(instanceId))
          .maybeSingle()
        orgId = orgCfg?.organization_id || null
      } catch {}
    }

    const ownerUserId = orgId ? await pickOrgOwnerUserId(orgId) : null
    if (!orgId) return res.sendStatus(200) // não sabemos a org; ignore com sucesso para não reentregar

    const insertPayload = {
      lead_id: lead?.id || null,
      user_id: lead?.user_id || ownerUserId,
      type: 'whatsapp',
      direction: 'inbound',
      subject: null,
      content: text,
      status: 'read',
      external_id: externalId,
      organization_id: orgId,
    }
    // Idempotência por external_id
    if (externalId) {
      const { data: existing } = await supabaseAdmin
        .from('communications')
        .select('id')
        .eq('external_id', externalId)
        .eq('type', 'whatsapp')
        .limit(1)
      if (existing && existing.length > 0) return res.sendStatus(200)
    }
    // Enriquecimento: criar lead se não houver (com base na org resolvida) e enriquecer dados
    if (!lead && orgId) {
      lead = await upsertLeadIfMissing({ organization_id: orgId, phoneDigits: from, defaultName: null, source: 'whatsapp' })
      insertPayload.lead_id = lead?.id || null
      insertPayload.user_id = lead?.user_id || ownerUserId
    }
    const profileName = data?.pushName || data?.senderName || null
    if (lead) await enrichLeadFromTextAndProfile(lead, { text, profileName })
    await supabaseAdmin.from('communications').insert([insertPayload])
    return res.sendStatus(200)
  } catch (e) {
    console.error('[ultramsg] inbound error', e)
    return res.sendStatus(200)
  }
})

// Webhook GreenAPI
app.post('/webhooks/greenapi', async (req, res) => {
  try {
    const body = parseJsonBody(req)
    const msg = body?.message || body?.data?.message || body
    const instanceId = body?.instanceData?.idInstance || body?.instanceId || null
    const text = msg?.textMessage || msg?.text || msg?.body || ''
    const fromRaw = msg?.senderData?.sender || msg?.from || msg?.chatId || body?.senderData?.sender || null
    const externalId = msg?.idMessage || msg?.id || null
    if (!fromRaw || !text) return res.status(200).json({ ok: true })
    const from = String(fromRaw).replace(/\D/g, '')

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .ilike('phone', `%${from.slice(-8)}%`)
      .limit(1)
    let lead = (leads || [])[0]

    // Resolver org por instanceId se necessário
    let orgId = lead?.organization_id || null
    if (!orgId && instanceId) {
      try {
        const { data: orgCfg } = await supabaseAdmin
          .from('organization_settings')
          .select('organization_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'greenapi')
          .filter('value->>instance_id', 'eq', String(instanceId))
          .maybeSingle()
        orgId = orgCfg?.organization_id || null
      } catch {}
    }

    const ownerUserId = orgId ? await pickOrgOwnerUserId(orgId) : null
    if (!orgId) return res.sendStatus(200)

    const insertPayload = {
      lead_id: lead?.id || null,
      user_id: lead?.user_id || ownerUserId,
      type: 'whatsapp',
      direction: 'inbound',
      subject: null,
      content: text,
      status: 'read',
      external_id: externalId,
      organization_id: orgId,
    }
    if (externalId) {
      const { data: existing } = await supabaseAdmin
        .from('communications')
        .select('id')
        .eq('external_id', externalId)
        .eq('type', 'whatsapp')
        .limit(1)
      if (existing && existing.length > 0) return res.sendStatus(200)
    }
    // Enriquecimento
    if (!lead && orgId) {
      lead = await upsertLeadIfMissing({ organization_id: orgId, phoneDigits: from, defaultName: null, source: 'whatsapp' })
      insertPayload.lead_id = lead?.id || null
      insertPayload.user_id = lead?.user_id || ownerUserId
    }
    const profileName = msg?.senderData?.senderName || body?.senderData?.chatName || null
    if (lead) await enrichLeadFromTextAndProfile(lead, { text, profileName })
    await supabaseAdmin.from('communications').insert([insertPayload])
    return res.sendStatus(200)
  } catch (e) {
    console.error('[greenapi] inbound error', e)
    return res.sendStatus(200)
  }
})

// Legacy W-API webhook (disabled)
/* app.post('/webhooks/wapi', async (req, res) => {
  try {
    if (!verifyWapiSignature(req)) return res.sendStatus(403)
    const body = parseJsonBody(req)
    const data = body || {}
    // Estruturas comuns: { message: { from, body, id } } ou { from, message, id }
    const msg = data.message || data.data || data
    const text = msg?.body || msg?.text || data?.text || ''
    const fromRaw = msg?.from || data?.from || data?.sender || data?.phone || ''
    const externalId = msg?.id || data?.id || msg?.messageId || null
    const instanceId = data?.instanceId || data?.instance_id || data?.instance || null
    if (!fromRaw || !text) return res.status(200).json({ ok: true })
    const from = String(fromRaw).replace(/\D/g, '')

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .ilike('phone', `%${from.slice(-8)}%`)
      .limit(1)
    const lead = (leads || [])[0]

    // Resolver org por instanceId se necessário
    let orgId = lead?.organization_id || null
    if (!orgId && instanceId) {
      try {
        const { data: orgCfg } = await supabaseAdmin
          .from('organization_settings')
          .select('organization_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'wapi')
          .filter('value->>instance_id', 'eq', String(instanceId))
          .maybeSingle()
        orgId = orgCfg?.organization_id || null
      } catch {}
    }

    const ownerUserId = orgId ? await pickOrgOwnerUserId(orgId) : null
    if (!orgId) return res.sendStatus(200)

    const insertPayload = {
      lead_id: lead?.id || null,
      user_id: lead?.user_id || ownerUserId,
      type: 'whatsapp',
      direction: 'inbound',
      subject: null,
      content: text,
      status: 'read',
      external_id: externalId,
      organization_id: orgId,
    }
    if (externalId) {
      const { data: existing } = await supabaseAdmin
        .from('communications')
        .select('id')
        .eq('external_id', externalId)
        .eq('type', 'whatsapp')
        .limit(1)
      if (existing && existing.length > 0) return res.sendStatus(200)
    }
    await supabaseAdmin.from('communications').insert([insertPayload])
    return res.sendStatus(200)
  } catch (e) {
    console.error('[wapi] inbound error', e)
    return res.sendStatus(200)
  }
}) */

// Webhook WPPConnect
app.post('/webhooks/wppconnect', async (req, res) => res.status(404).json({ error: 'disabled' }))

// Legacy W-API received (disabled)
/* app.post('/webhooks/wapi/received', async (req, res) => {
  try {
    if (!verifyWapiSignature(req)) return res.sendStatus(403)
    // Reutiliza lógica do handler unificado
    return app._router.handle({ ...req, url: '/webhooks/wapi', method: 'POST' }, res, () => {})
  } catch (e) {
    console.error('[wapi/received] error', e)
    return res.sendStatus(200)
  }
}) */

/* app.post('/webhooks/wapi/delivery', async (req, res) => {
  try {
    if (!verifyWapiSignature(req)) return res.sendStatus(403)
    const data = parseJsonBody(req) || {}
    const externalId = data?.messageId || data?.id || data?.data?.id || null
    if (!externalId) return res.status(200).json({ ok: true })
    await supabaseAdmin
      .from('communications')
      .update({ status: 'delivered' })
      .eq('external_id', externalId)
      .eq('type', 'whatsapp')
    return res.sendStatus(200)
  } catch (e) {
    console.error('[wapi/delivery] error', e)
    return res.sendStatus(200)
  }
}) */

/* app.post('/webhooks/wapi/message-status', async (req, res) => {
  try {
    if (!verifyWapiSignature(req)) return res.sendStatus(403)
    const data = parseJsonBody(req) || {}
    const externalId = data?.messageId || data?.id || data?.data?.id || null
    const statusRaw = data?.status || data?.messageStatus || data?.data?.status || data?.event || ''
    function mapStatus(s) {
      const v = String(s || '').toLowerCase()
      if (v.includes('read')) return 'read'
      if (v.includes('deliver')) return 'delivered'
      if (v.includes('sent')) return 'sent'
      if (v.includes('fail') || v.includes('error') || v.includes('undeliver')) return 'failed'
      return null
    }
    const mapped = mapStatus(statusRaw)
    if (!externalId || !mapped) return res.status(200).json({ ok: true })
    await supabaseAdmin
      .from('communications')
      .update({ status: mapped })
      .eq('external_id', externalId)
      .eq('type', 'whatsapp')
    return res.sendStatus(200)
  } catch (e) {
    console.error('[wapi/message-status] error', e)
    return res.sendStatus(200)
  }
}) */

/* app.post('/webhooks/wapi/chat-presence', async (_req, res) => {
  try {
    // opcional: validar assinatura/token
    if (!verifyWapiSignature(_req)) return res.sendStatus(403)
    return res.sendStatus(200)
  } catch {
    return res.sendStatus(200)
  }
}) */

/* app.post('/webhooks/wapi/connected', async (_req, res) => {
  try { if (!verifyWapiSignature(_req)) return res.sendStatus(403); return res.sendStatus(200) } catch { return res.sendStatus(200) }
})
app.post('/webhooks/wapi/disconnected', async (_req, res) => {
  try { if (!verifyWapiSignature(_req)) return res.sendStatus(403); return res.sendStatus(200) } catch { return res.sendStatus(200) }
}) */

// Legacy Z-API webhook (disabled)
/* app.post('/webhooks/zapi', async (req, res) => {
  try {
    const data = parseJsonBody(req) || {}
    const parsed = parseZapiInboundPayload(data)
    const instanceId = parsed.instanceId
    const text = parsed.text || ''
    const from = parsed.from || ''
    const externalId = parsed.externalId || null
    if (!from || !text) {
      // Log defensivo para ajustar mapeamento de payloads
      console.warn('[zapi] inbound sem from/text. keys=', Object.keys(data || {}))
      return res.status(200).json({ ok: true })
    }

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .ilike('phone', `%${from.slice(-8)}%`)
      .limit(1)
    const lead = (leads || [])[0]

    let orgId = lead?.organization_id || null
    if (!orgId && instanceId) {
      try {
        const { data: orgCfg } = await supabaseAdmin
          .from('organization_settings')
          .select('organization_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'zapi')
          .filter('value->>instance_id', 'eq', String(instanceId))
          .maybeSingle()
        orgId = orgCfg?.organization_id || null
      } catch {}
    }

    // Fallback: se ainda não achou a organização, tenta resolver pela configuração por usuário (settings)
    if (!orgId && instanceId) {
      try {
        const { data: userCfg } = await supabaseAdmin
          .from('settings')
          .select('user_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'zapi')
          .filter('value->>instance_id', 'eq', String(instanceId))
          .maybeSingle()
        const ownerUserIdFromSettings = userCfg?.user_id || null
        if (ownerUserIdFromSettings) {
          const { data: mem } = await supabaseAdmin
            .from('organization_members')
            .select('organization_id')
            .eq('user_id', ownerUserIdFromSettings)
            .limit(1)
          orgId = mem?.[0]?.organization_id || null
        }
      } catch {}
    }

    const ownerUserId = orgId ? await pickOrgOwnerUserId(orgId) : null
    if (!orgId) {
      console.warn('[zapi] inbound sem organization_id resolvido para instanceId=', instanceId)
      return res.sendStatus(200)
    }

    // Cria/enriquece lead automaticamente quando não existir
    let targetLead = lead || null
    if (!targetLead && ownerUserId) {
      targetLead = await upsertLeadIfMissing({ organization_id: orgId, phoneDigits: from, defaultName: null, source: 'whatsapp' })
    }
    if (targetLead) {
      const profileName = parsed?.senderName || parsed?.pushName || null
      await enrichLeadFromTextAndProfile(targetLead, { text, profileName })
    }

    const insertPayload = {
      lead_id: targetLead?.id || null,
      user_id: (targetLead?.user_id || ownerUserId),
      type: 'whatsapp',
      direction: 'inbound',
      subject: null,
      content: text,
      status: 'read',
      external_id: externalId,
      organization_id: orgId,
    }
    if (externalId) {
      const { data: existing } = await supabaseAdmin
        .from('communications')
        .select('id')
        .eq('external_id', externalId)
        .eq('type', 'whatsapp')
        .limit(1)
      if (existing && existing.length > 0) return res.sendStatus(200)
    }
    await supabaseAdmin.from('communications').insert([insertPayload])
    return res.sendStatus(200)
  } catch (e) {
    console.error('[zapi] inbound error', e)
    return res.sendStatus(200)
  }
}) */

/* app.post('/webhooks/zapi/status', async (req, res) => {
  try {
    const data = parseJsonBody(req) || {}
    const msg = data.message || data.data || data
    const externalId = data.idMessage || msg?.idMessage || data.messageId || data.id || null
    let statusRaw = data.status || msg?.status || data.type || data.event || ''
    const ack = typeof data.ack !== 'undefined' ? data.ack : (typeof msg?.ack !== 'undefined' ? msg.ack : null)

    function mapStatus(s, ackVal) {
      const v = String(s || '').toLowerCase()
      if (typeof ackVal === 'number') {
        if (ackVal >= 3) return 'read'
        if (ackVal === 2) return 'delivered'
        if (ackVal === 1) return 'sent'
      }
      if (v.includes('read')) return 'read'
      if (v.includes('delivered') || v.includes('received')) return 'delivered'
      if (v.includes('sent')) return 'sent'
      if (v.includes('fail') || v.includes('error') || v.includes('undeliver')) return 'failed'
      return null
    }

    const mapped = mapStatus(statusRaw, typeof ack === 'string' ? Number(ack) : ack)
    if (!externalId || !mapped) return res.status(200).json({ ok: true })

    await supabaseAdmin
      .from('communications')
      .update({ status: mapped })
      .eq('external_id', externalId)
      .eq('type', 'whatsapp')

    return res.sendStatus(200)
  } catch (e) {
    console.error('[zapi] status error', e)
    return res.sendStatus(200)
  }
}) */

// ================================
// Planner plans.json management (admin)
// ================================
app.get('/api/planner/plans', async (req, res) => {
  try {
    // Require agent key or authenticated user admin/manager
    const agentKey = req.headers['x-agent-key'] || req.headers['X-Agent-Key']
    const isAgent = agentKey && String(agentKey) === String(process.env.AGENT_API_KEY || '')
    let isAdmin = false
    if (!isAgent) {
      try {
        const user = await getUserFromAuthHeader(req)
        if (user?.id) {
          // any authenticated user can read for now; could restrict by role
          isAdmin = true
        }
      } catch {}
    }
    if (!isAgent && !isAdmin) return res.status(401).json({ error: 'unauthorized' })
    const p = path.join(__dirname, 'Agente WhatsaApp', 'plans.json')
    if (!fs.existsSync(p)) return res.json({})
    const raw = fs.readFileSync(p, 'utf8')
    try { return res.type('application/json').send(raw) } catch { return res.json(JSON.parse(raw)) }
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// ================================
// WPPConnect configuration and QR/status
// ================================
// Local WPPConnect SDK session manager (per organization)
const wppLocal = {
  sessions: new Map(), // organization_id -> { client, lastQrDataUrl, connected }
}

async function getWppSdk() {
  try {
    const mod = await import('@wppconnect-team/wppconnect')
    return mod?.default || mod
  } catch (e) {
    throw new Error(`WPPConnect SDK não instalado. Adicione @wppconnect-team/wppconnect nas dependências. Detalhes: ${e?.message || e}`)
  }
}

function isLocalWppConfig(v) {
  if (!v) return false
  const provider = String(v.provider || '').toLowerCase()
  const base = String(v.base_url || '').toLowerCase()
  return provider === 'wppconnect' && (base === 'local' || base === 'localhost' || base === 'embedded' || base === '')
}

function getLocalSession(orgId) {
  return wppLocal.sessions.get(orgId) || null
}

async function stopLocalSession(orgId) {
  const s = getLocalSession(orgId)
  if (!s) return
  try { if (s.client?.logout) await s.client.logout() } catch {}
  try { if (s.client?.close) await s.client.close() } catch {}
  wppLocal.sessions.delete(orgId)
}

async function ensureLocalClient(orgId, v) {
  let existing = getLocalSession(orgId)
  if (existing?.client) return existing
  const wppconnect = await getWppSdk()
  const sessionName = v?.session || v?.session_id || v?.instance_id || 'default'
  let state = { client: null, lastQrDataUrl: null, connected: false }
  const client = await wppconnect.create({
    session: sessionName,
    catchQR: (base64Qr /*, asciiQR */) => {
      const dataUrl = String(base64Qr || '')
      try { console.log(`[WPP] QR capturado para org=${orgId}, session=${sessionName}, tamanho=${dataUrl?.length||0}`) } catch {}
      state.lastQrDataUrl = dataUrl.startsWith('data:') ? dataUrl : `data:image/png;base64,${dataUrl}`
    },
    statusFind: (statusSession /*, session */) => {
      state.connected = String(statusSession || '').toLowerCase() === 'islogged'
      try { console.log(`[WPP] status=${statusSession} org=${orgId} session=${sessionName}`) } catch {}
    },
    headless: 'new',
    logQR: false,
    autoClose: 0,
    useChrome: String(process.env.WPPCONNECT_USE_CHROME || '').toLowerCase() === 'true',
    browserPathExecutable: process.env.WPPCONNECT_CHROME_PATH || undefined,
    puppeteerOptions: {
      // Extra flags can help in some environments
      args: [
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    },
  })
  state.client = client
  wppLocal.sessions.set(orgId, state)
  return state
}

app.post('/api/org/whatsapp/wppconnect/config', async (req, res) => res.status(404).json({ error: 'disabled' }))

app.get('/api/whatsapp/wppconnect/status', async (req, res) => res.status(404).json({ error: 'disabled' }))

app.get('/api/whatsapp/wppconnect/qrcode', async (req, res) => res.status(404).json({ error: 'disabled' }))

app.post('/api/whatsapp/wppconnect/start', async (req, res) => res.status(404).json({ error: 'disabled' }))

// Extra controls for local mode
app.post('/api/whatsapp/wppconnect/logout', async (req, res) => res.status(404).json({ error: 'disabled' }))

app.post('/api/whatsapp/wppconnect/restart', async (req, res) => res.status(404).json({ error: 'disabled' }))
app.put('/api/planner/plans', async (req, res) => {
  try {
    const agentKey = req.headers['x-agent-key'] || req.headers['X-Agent-Key']
    const isAgent = agentKey && String(agentKey) === String(process.env.AGENT_API_KEY || '')
    let isAdmin = false
    if (!isAgent) {
      try {
        const user = await getUserFromAuthHeader(req)
        if (user?.id) isAdmin = true
      } catch {}
    }
    if (!isAgent && !isAdmin) return res.status(401).json({ error: 'unauthorized' })
    // basic validation
    const body = req.body
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_json' })
    // quick sanity check on structure
    const plans = body
    if (!plans || typeof plans !== 'object') return res.status(400).json({ error: 'invalid_plans' })
    const keys = Object.keys(plans)
    if (keys.length === 0) return res.status(400).json({ error: 'empty_plans' })
    for (const k of keys) {
      const v = plans[k]
      if (!v || typeof v !== 'object') return res.status(400).json({ error: `invalid_plan_${k}` })
      if (!Array.isArray(v.steps)) return res.status(400).json({ error: `invalid_plan_steps_${k}` })
    }
    const dir = path.join(__dirname, 'Agente WhatsaApp')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'plans.json')
    // backup
    if (fs.existsSync(p)) {
      const backup = path.join(dir, `plans.backup.${new Date().toISOString().replace(/[:.]/g,'-')}.json`)
      try { fs.copyFileSync(p, backup) } catch {}
    }
    fs.writeFileSync(p, JSON.stringify(plans, null, 2), 'utf8')
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Generate a plan with AI (Gemini)
app.post('/api/planner/generate', async (req, res) => {
  try {
    // Auth: X-Agent-Key or authenticated user
    const agentKey = req.headers['x-agent-key'] || req.headers['X-Agent-Key']
    const isAgent = agentKey && String(agentKey) === String(process.env.AGENT_API_KEY || '')
    let isAdmin = false
    if (!isAgent) {
      try { const user = await getUserFromAuthHeader(req); if (user?.id) isAdmin = true } catch {}
    }
    if (!isAgent && !isAdmin) return res.status(401).json({ error: 'unauthorized' })

    const { name, goal, maxSteps = 6, domainHints = [], profileFields = [], tags = [] } = req.body || {}
    if (!name || !goal) return res.status(400).json({ error: 'name_and_goal_required' })
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'gemini_api_key_missing' })
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

    const system = `Você é um gerador de planos de atendimento para um CRM. Responda APENAS JSON puro no formato: { "${name}": { "goal": string, "steps": [ { "name": string, "objective": string, "guidance_for_llm": string, "completion_rules": { "requires_profile_fields"?: string[], "any_of_profile_fields"?: string[], "profile_tags_contains"?: string[], "or_text_in_profile_summary"?: string[] } } ... ] } }.
Regras:
- Máximo de ${Math.max(1, Math.min(12, Number(maxSteps)))} etapas.
- Textos curtos e diretos.
- Use os seguintes campos de perfil quando fizer sentido: ${profileFields.join(', ') || 'veiculo.modelo, veiculo.ano, veiculo.cidade, veiculo.cep'}.
- Se fizer sentido, sugira tags destas: ${tags.join(', ') || 'cotacao_calculada, proposta_gerada, vistoria_agendada, adesao_concluida'}.
- NUNCA retorne nada além de JSON válido.`

    const user = `Gere um plano chamado "${name}" com objetivo: ${goal}. Contexto: ${domainHints.join('; ') || 'geral CRM'}.`
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: system }] },
          { role: 'user', parts: [{ text: user }] }
        ],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
      })
    })
    const json = await resp.json()
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    let plan = null
    try { plan = JSON.parse(text) } catch {}
    if (!plan || !plan[name]) return res.status(500).json({ error: 'invalid_ai_output', raw: text?.slice?.(0, 400) })

    // quick validation
    if (!Array.isArray(plan[name].steps)) return res.status(400).json({ error: 'invalid_steps' })
    return res.json(plan)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Envio de email (placeholder - registra em communications)
app.post('/api/messages/email', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { leadId, subject, body } = req.body || {}
    if (!leadId || !subject || !body) return res.status(400).json({ error: 'leadId, subject e body são obrigatórios' })

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    if (leadErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' })

    // Placeholder: não envia email real. Apenas registra comunicação.
    const { error: commErr } = await supabaseAdmin
      .from('communications')
      .insert([{
        lead_id: lead.id,
        user_id: user.id,
        type: 'email',
        direction: 'outbound',
        subject,
        content: body,
        status: 'sent',
        external_id: null,
        organization_id: lead.organization_id || null,
      }])
    if (commErr) return res.status(500).json({ error: commErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[email] send exception', e)
    return res.sendStatus(500)
  }
})

// Listar funcionários (perfis + email)
app.get('/api/employees', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    if (!(await isAdmin(user.id))) return res.status(403).json({ error: 'forbidden' })

    // Organizações do usuário atual
    const { data: myMemberships, error: mErr } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
    if (mErr) return res.status(500).json({ error: mErr.message })
    const orgIds = (myMemberships || []).map(m => m.organization_id)
    if (orgIds.length === 0) return res.json({ employees: [] })

    // Usuários membros destas organizações
    const { data: members, error: memErr } = await supabaseAdmin
      .from('organization_members')
      .select('user_id')
      .in('organization_id', orgIds)
    if (memErr) return res.status(500).json({ error: memErr.message })
    const memberUserIds = Array.from(new Set((members || []).map(m => m.user_id)))

    const { data: profiles, error: pErr } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, phone, created_at, updated_at')
      .in('id', memberUserIds)
      .order('created_at', { ascending: true })
    if (pErr) return res.status(500).json({ error: pErr.message })

    // Listar emails via auth admin (primeira página suficiente para MVP)
    const usersResp = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const users = usersResp?.data?.users || []
    const idToEmail = new Map(users.map(u => [u.id, u.email]))

    const merged = (profiles || []).map(p => ({
      id: p.id,
      email: idToEmail.get(p.id) || null,
      full_name: p.full_name || '',
      role: p.role || 'sales',
      phone: p.phone || '',
      created_at: p.created_at,
      updated_at: p.updated_at,
    }))

    return res.json({ employees: merged })
  } catch (e) {
    console.error('[employees] list error', e)
    return res.sendStatus(500)
  }
})

// Criar funcionário (invite ou create)
app.post('/api/employees', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    if (!(await isAdmin(user.id))) return res.status(403).json({ error: 'forbidden' })

    const { email, full_name, role = 'sales', phone, password, sendInvite = true } = req.body || {}
    if (!email || !full_name) return res.status(400).json({ error: 'email e full_name são obrigatórios' })

    let newUser
    if (sendInvite) {
      const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { full_name, role },
        redirectTo: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/login` : undefined,
      })
      if (error) return res.status(502).json({ error: error.message })
      newUser = data?.user
    } else {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: password || crypto.randomBytes(8).toString('hex'),
        user_metadata: { full_name, role },
        email_confirm: false,
      })
      if (error) return res.status(502).json({ error: error.message })
      newUser = data?.user
    }

    if (!newUser?.id) return res.status(500).json({ error: 'create_user_failed' })

    // Atualizar perfil com dados extras
    const { error: upErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: newUser.id, full_name, role, phone: phone || null, updated_at: new Date().toISOString() })
    if (upErr) console.warn('[employees] upsert profile warning:', upErr.message)

    // Garantir membership do novo usuário na(s) mesma(s) organização(ões) do criador
    const { data: myMemberships, error: mErr } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
    if (mErr) return res.status(500).json({ error: mErr.message })
    const orgIds = (myMemberships || []).map(m => m.organization_id)
    for (const orgId of orgIds) {
      const { error: addMemErr } = await supabaseAdmin
        .from('organization_members')
        .upsert({ organization_id: orgId, user_id: newUser.id, role })
      if (addMemErr) console.warn('[employees] add membership warning:', addMemErr.message)
    }

    return res.json({ ok: true, id: newUser.id })
  } catch (e) {
    console.error('[employees] create error', e)
    return res.sendStatus(500)
  }
})

// Atualizar funcionário
app.patch('/api/employees/:id', async (req, res) => {
  try {
    const authUser = await getUserFromAuthHeader(req)
    if (!authUser) return res.status(401).json({ error: 'unauthorized' })
    if (!(await isAdmin(authUser.id))) return res.status(403).json({ error: 'forbidden' })

    const { id } = req.params
    const { full_name, role, phone, email } = req.body || {}

    if (email) {
      const { error: aErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email })
      if (aErr) return res.status(502).json({ error: aErr.message })
    }

    const { error: upErr } = await supabaseAdmin
      .from('profiles')
      .update({
        ...(full_name !== undefined ? { full_name } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(phone !== undefined ? { phone } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (upErr) return res.status(500).json({ error: upErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[employees] update error', e)
    return res.sendStatus(500)
  }
})

// Remover funcionário
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const authUser = await getUserFromAuthHeader(req)
    if (!authUser) return res.status(401).json({ error: 'unauthorized' })
    if (!(await isAdmin(authUser.id))) return res.status(403).json({ error: 'forbidden' })

    const { id } = req.params

    // Remover memberships
    await supabaseAdmin.from('organization_members').delete().eq('user_id', id)
    // Remover profile primeiro
    await supabaseAdmin.from('profiles').delete().eq('id', id)
    // Remover usuário auth
    const { error: aErr } = await supabaseAdmin.auth.admin.deleteUser(id)
    if (aErr) return res.status(502).json({ error: aErr.message })

    return res.json({ ok: true })
  } catch (e) {
    console.error('[employees] delete error', e)
    return res.sendStatus(500)
  }
})

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
}) 

// Utilitário: obter deal por id (para envio de e-mail)
app.get('/api/deals/:id', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const { id } = req.params
    const { data, error } = await supabaseAdmin.from('deals').select('*').eq('id', id).single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'not_found' })
    return res.json({ deal: data })
  } catch (e) {
    console.error('[deals/:id] error', e)
    return res.sendStatus(500)
  }
})

// ================================
// AUTENTIQUE — criação de contrato
// ================================
// Requer variáveis de ambiente:
// - AUTENTIQUE_TOKEN: Token de API (Bearer)
// - AUTENTIQUE_API: Base GraphQL (default https://api.autentique.com.br/v2/graphql)
// Fluxo:
// 1) Gera PDF simples da proposta (título, itens e total)
// 2) Envia via GraphQL multipart (operations/map) com mutation documentsCreate
// Docs referenciais: API Autentique v2 GraphQL multipart upload

function buildDealPdfBuffer(deal, items) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      doc.fontSize(18).text(`Proposta: ${deal.title}`, { align: 'left' })
      if (deal.description) {
        doc.moveDown(0.5)
        doc.fontSize(12).text(deal.description)
      }
      doc.moveDown(1)
      doc.fontSize(12).text(`Status: ${deal.status}`)
      if (deal.valid_until) doc.text(`Validade: ${new Date(deal.valid_until).toLocaleDateString('pt-BR')}`)
      doc.moveDown(1)

      // Tabela simples
      doc.fontSize(12).text('Itens:', { underline: true })
      doc.moveDown(0.5)
      items.forEach((it) => {
        doc.text(`${it.product_name}  x${it.quantity}  —  R$ ${Number(it.total_price).toLocaleString('pt-BR')}`)
      })
      doc.moveDown(1)
      doc.fontSize(14).text(`Total: R$ ${Number(deal.total_value || 0).toLocaleString('pt-BR')}`, { align: 'right' })

      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

async function fetchDealWithItems(dealId) {
  const { data: deal, error: dErr } = await supabaseAdmin.from('deals').select('*').eq('id', dealId).single()
  if (dErr || !deal) throw new Error('deal_not_found')
  const { data: items, error: iErr } = await supabaseAdmin.from('deal_items').select('*').eq('deal_id', dealId).order('created_at', { ascending: true })
  if (iErr) throw iErr
  return { deal, items: items || [] }
}

function buildAutentiqueMultipart({ name, signers, message }, fileBuffer, filename) {
  const query = `mutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {\n  documentsCreate(document: $document, signers: $signers, file: $file) {\n    id\n    name\n    status\n    url\n  }\n}`
  const operations = {
    query,
    variables: {
      document: { name, message: message || null },
      signers,
      file: null,
    },
  }
  const map = { '0': ['variables.file'] }
  const boundary = '----autentiqueForm' + Math.random().toString(16).slice(2)
  const CRLF = '\r\n'

  const parts = []
  function push(s) { parts.push(Buffer.isBuffer(s) ? s : Buffer.from(s)) }
  push(`--${boundary}${CRLF}`)
  push('Content-Disposition: form-data; name="operations"' + CRLF)
  push('Content-Type: application/json' + CRLF + CRLF)
  push(JSON.stringify(operations) + CRLF)

  push(`--${boundary}${CRLF}`)
  push('Content-Disposition: form-data; name="map"' + CRLF)
  push('Content-Type: application/json' + CRLF + CRLF)
  push(JSON.stringify(map) + CRLF)

  push(`--${boundary}${CRLF}`)
  push(`Content-Disposition: form-data; name="0"; filename="${filename}"` + CRLF)
  push('Content-Type: application/pdf' + CRLF + CRLF)
  push(fileBuffer)
  push(CRLF)

  push(`--${boundary}--${CRLF}`)
  const body = Buffer.concat(parts)
  return { body, boundary }
}

app.post('/api/autentique/contracts', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })

    const { dealId, name, message, signers } = req.body || {}
    if (!dealId) return res.status(400).json({ error: 'dealId obrigatório' })
    if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers obrigatório' })

    const { deal, items } = await fetchDealWithItems(dealId)
    // Checa se o usuário pertence à organização do deal
    if (deal.organization_id) {
      const { data: membership } = await supabaseAdmin
        .from('organization_members')
        .select('user_id')
        .eq('user_id', user.id)
        .eq('organization_id', deal.organization_id)
        .maybeSingle()
      if (!membership) return res.status(403).json({ error: 'forbidden' })
    }
    const pdf = await buildDealPdfBuffer(deal, items)

    // Token por organização (prioridade) ou fallback .env
    let token = null
    if (deal.organization_id) {
      const { data: orgCfg } = await supabaseAdmin
        .from('organization_settings')
        .select('value')
        .eq('organization_id', deal.organization_id)
        .eq('key', 'autentique')
        .maybeSingle()
      token = orgCfg?.value?.token || null
    }
    token = token || process.env.AUTENTIQUE_TOKEN
    const endpoint = process.env.AUTENTIQUE_API || 'https://api.autentique.com.br/v2/graphql'
    if (!token) return res.status(500).json({ error: 'AUTENTIQUE_TOKEN ausente' })

    // Normalizar signers no formato esperado: [{ email, action: SIGN, name? }]
    const normalizedSigners = signers.map((s) => ({
      email: s.email,
      action: s.action || 'SIGN',
      name: s.name || undefined,
    }))

    const multipart = buildAutentiqueMultipart({ name: name || deal.title, message, signers: normalizedSigners }, pdf, `${deal.title || 'contrato'}.pdf`)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok || (json && json.errors)) {
      return res.status(502).json({ error: json?.errors?.[0]?.message || 'autentique_error' })
    }

    const data = json?.data?.documentsCreate

    // Persistir contrato
    try {
      await supabaseAdmin
        .from('contracts')
        .insert([{
          deal_id: deal.id,
          organization_id: deal.organization_id,
          user_id: user.id,
          provider: 'autentique',
          external_id: data?.id || null,
          name: data?.name || (name || deal.title),
          url: data?.url || null,
          status: data?.status ? String(data.status).toLowerCase() : 'created',
          metadata: data || null,
        }])
    } catch {}

    return res.json({ ok: true, document: data })
  } catch (e) {
    console.error('[autentique/contracts] error', e)
    return res.sendStatus(500)
  }
})

// Webhook do Autentique — atualizar status do contrato
app.post('/webhooks/autentique', async (req, res) => {
  try {
    // Autentique envia payloads com informações do documento; aqui aceitamos sem verificação de assinatura (pode ser adicionado via secret)
    const data = parseJsonBody(req) || {}
    const docId = data?.document?.id || data?.id || data?.document_id || null
    const status = data?.document?.status || data?.status || null
    if (!docId) return res.status(200).json({ ok: true })
    const next = typeof status === 'string' ? String(status).toLowerCase() : null
    await supabaseAdmin
      .from('contracts')
      .update({ status: next || 'pending', metadata: data, updated_at: new Date().toISOString() })
      .eq('external_id', docId)
      .eq('provider', 'autentique')
    return res.sendStatus(200)
  } catch (e) {
    console.error('[webhooks/autentique] error', e)
    return res.sendStatus(200)
  }
})

// Gemini: parse intent a partir de linguagem natural
app.post('/api/agent/parse-intent', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.error('[parse-intent] GEMINI_API_KEY ausente. Configure no .env e reinicie o servidor.')
      return res.status(500).json({ error: 'missing_gemini_key' })
    }
    const { prompt, context } = req.body || {}
    if (!prompt) return res.status(400).json({ error: 'prompt_required' })

    // Compacta contexto mínimo
    const minimal = {
      view: context?.view || null,
      filters: context?.filters || null,
      stages: Array.isArray(context?.stages) ? context.stages.map((s) => ({ id: s.id, name: s.name })) : null,
    }

    const system = `Você é um parser de intenções de CRM. Responda APENAS JSON com {name: string, payload: object}. Intenções válidas:
    move_lead{leadId,toStageId}, open_quick_chat{leadId}, open_whatsapp_view{leadId?}, create_lead{...}, update_lead{id,...}, delete_lead{id},
    set_filter{...}, set_view{view}, select_lead{leadId,openDetails?}, create_note{leadId,title,description?}, create_task{leadId,title,description?,due_date?},
    update_activity{id,...}, delete_activity{id}, open_activities{}, open_tasks{}, open_deals{}, create_deal{leadId?,title,description?,status?,valid_until?,items?}, update_deal{id,...}, delete_deal{id}.
    Se faltar parâmetro essencial, use payload vazio e deixe para o cliente preencher.`

    // Chamada simples via fetch REST (models: gemini-1.5-flash ou 2.0/2.5 endpoints futuros)
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: system }] },
          { role: 'user', parts: [{ text: `Contexto: ${JSON.stringify(minimal)}` }] },
          { role: 'user', parts: [{ text: `Prompt: ${String(prompt)}` }] }
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 }
      })
    })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) return res.status(502).json({ error: 'gemini_error', details: json })
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (!parsed || !parsed.name) return res.status(200).json({ name: 'get_state', payload: {} })
    return res.json(parsed)
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Console chat com function-calling e opção de streaming SSE
app.post('/api/console/chat', async (req, res) => {
  try {
    const { organization_id } = req.query
    const { prompt, params } = req.body || {}
    if (!prompt) return res.status(400).json({ error: 'prompt_required' })

    const orgId = String(organization_id || params?.organization_id || '') || null
    const baseUrl = (process.env.API_BASE_URL && String(process.env.API_BASE_URL).startsWith('http'))
      ? String(process.env.API_BASE_URL)
      : `http://localhost:${PORT}`

    const isSSE = String(req.query.stream || '').toLowerCase() === '1' || String(req.headers.accept || '').includes('text/event-stream')

    // Helper: SSE
    const sse = {
      init() {
        if (!isSSE) return
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        try { res.flushHeaders && res.flushHeaders() } catch {}
      },
      send(event, data) {
        if (!isSSE) return
        try { res.write(`event: ${event}\n`) } catch {}
        try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {}
      },
      done() { if (isSSE) { try { res.write('event: done\ndata: {}\n\n') } catch {}; try { res.end() } catch {} } }
    }

    // Tools (somente leitura executadas automaticamente). Ações mutáveis serão apenas sugeridas nas actions
    const tools = {
      async get_followup_queue({ limit = 5, timeframe = 'this_week', minProb = 0 } = {}) {
        const qs = new URLSearchParams()
        if (orgId) qs.set('organization_id', orgId)
        const r = await fetch(`${baseUrl}/api/followup/queue?${qs.toString()}`)
        const js = await r.json().catch(() => ({}))
        let items = Array.isArray(js?.items) ? js.items : []
        items = items.filter((i) => (i?.probability ?? 0) >= Number(minProb))
        items.sort((a, b) => (Number(b?.probability || 0) - Number(a?.probability || 0)))
        return items.slice(0, Number(limit))
      },
      async get_pipeline_stats() {
        if (!orgId) return null
        const r = await fetch(`${baseUrl}/api/pipeline/health?organization_id=${encodeURIComponent(orgId)}`)
        return await r.json().catch(() => null)
      },
      async get_lead({ lead_id }) {
        if (!lead_id) return null
        const r = await fetch(`${baseUrl}/api/leads/${encodeURIComponent(lead_id)}`)
        return await r.json().catch(() => null)
      },
      async search_leads({ query = '', limit = 10 } = {}) {
        try {
          if (!orgId) return []
          const { data: leads } = await supabaseAdmin
            .from('leads')
            .select('*')
            .ilike('name', `%${query}%`)
            .eq('organization_id', orgId)
            .limit(Number(limit || 10))
          return leads || []
        } catch { return [] }
      }
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.error('[console/chat] GEMINI_API_KEY ausente. Configure no .env e reinicie o servidor.')
      return res.status(500).json({ error: 'missing_gemini_key' })
    }

    // Prompt para loop de function-calling minimalista
    const toolCatalog = [
      {
        name: 'get_followup_queue',
        args: { limit: 'number?', timeframe: "'this_week'|'today'|'this_month'?", minProb: 'number?' },
        description: 'Lista leads com maior probabilidade para follow-up'
      },
      { name: 'get_pipeline_stats', args: {}, description: 'Resumo de saúde do pipeline' },
      { name: 'get_lead', args: { lead_id: 'string' }, description: 'Busca um lead por ID' },
      { name: 'search_leads', args: { query: 'string', limit: 'number?' }, description: 'Pesquisa leads por nome' }
    ]

    function buildSystemPrompt() {
      return `Você é um agente de CRM com acesso a ferramentas SOMENTE LEITURA. Objetivo: ajudar com insights e etapas recomendadas.\n\n` +
      `Ferramentas disponíveis (somente leitura):\n` +
      `${toolCatalog.map(t => `- ${t.name}(${JSON.stringify(t.args)}): ${t.description}`).join('\n')}\n\n` +
      `Instruções de saída: sempre responda APENAS JSON. Em cada passo, responda um destes formatos:\n` +
      `{"call": {"name": "tool_name", "args": {...}}, "commentary": "por que chamou"}\n` +
      `OU {"final": {"text": "mensagem concisa", "items": [..opcional..], "actions": [{"type": "create_task|move_lead|open_lead|open_whatsapp_view", "params": {...}, "dangerous": boolean}]}}\n` +
      `Nunca execute ações mutáveis. Em vez disso, inclua-as em actions com dangerous=true quando apropriado.`
    }

    async function llm(contents) {
      const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents, generationConfig: { temperature: 0.2, maxOutputTokens: 512 } })
      })
      const js = await resp.json().catch(() => ({}))
      const text = js?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      return text
    }

    // Inicializa SSE
    sse.init()
    if (isSSE) sse.send('status', { state: 'starting' })

    // Loop simples de function calling (guardrails: whitelist e limite de iterações)
    const history = []
    const maxIters = 3
    let lastFinal = null
    for (let iter = 1; iter <= maxIters; iter++) {
      const contents = []
      contents.push({ role: 'user', parts: [{ text: buildSystemPrompt() }] })
      contents.push({ role: 'user', parts: [{ text: `Contexto: ${JSON.stringify({ orgId })}` }] })
      contents.push({ role: 'user', parts: [{ text: `Prompt: ${String(prompt)}` }] })
      if (history.length) contents.push({ role: 'user', parts: [{ text: `Histórico: ${JSON.stringify(history)}` }] })

      const raw = await llm(contents)
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      if (!parsed) {
        // Falhou parsing, encerra
        lastFinal = { text: 'Não entendi. Pode reformular?', items: [], actions: [] }
        break
      }

      if (parsed?.call?.name) {
        const name = String(parsed.call.name)
        const args = parsed.call.args || {}
        // whitelist
        if (!Object.prototype.hasOwnProperty.call(tools, name)) {
          lastFinal = { text: 'Pedido de ferramenta desconhecida.', items: [], actions: [] }
          break
        }
        if (isSSE) sse.send('tool_call', { name, args, iter })
        let result = null
        try { result = await tools[name](args) } catch (e) { result = { error: String(e?.message || e) } }
        history.push({ call: { name, args }, result })
        if (isSSE) sse.send('tool_result', { name, result, iter })
        continue
      }

      if (parsed?.final) {
        lastFinal = {
          text: String(parsed.final.text || '').trim() || '—',
          items: Array.isArray(parsed.final.items) ? parsed.final.items : [],
          actions: Array.isArray(parsed.final.actions) ? parsed.final.actions.map((a) => ({
            type: String(a?.type || ''),
            params: a?.params || a?.defaults || {},
            dangerous: Boolean(a?.dangerous || (a?.type && /create|update|delete|move|send/i.test(String(a.type))))
          })) : []
        }
        if (isSSE) sse.send('final', lastFinal)
        break
      }
    }

    if (!lastFinal) lastFinal = { text: 'Sem resultados por enquanto.', items: [], actions: [] }

    if (isSSE) {
      sse.done()
      return
    }
    return res.json(lastFinal)
  } catch (e) {
    console.error('[console/chat] error:', e)
    if (String(req.headers.accept || '').includes('text/event-stream') || String(req.query.stream || '').toLowerCase() === '1') {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'internal_error' })}\n\n`) } catch {}
      try { res.end() } catch {}
      return
    }
    res.status(500).json({ error: 'internal_error' })
  }
})