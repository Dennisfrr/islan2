import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import PDFDocument from 'pdfkit'

const app = express()
app.use(morgan('tiny'))
// Use raw body for webhook endpoints to verify signatures
app.use('/webhooks', express.raw({ type: '*/*', limit: '2mb' }))
// JSON parser for regular API endpoints
app.use(express.json({ limit: '2mb' }))

const PORT = process.env.PORT || 3000
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

// Bridge: Agente WhatsApp -> CRM (intents diretas, autenticado por X-Agent-Key)
app.post('/api/agent/dispatch', async (req, res) => {
  try {
    const agentKey = req.headers['x-agent-key'] || req.headers['X-Agent-Key']
    if (!agentKey || String(agentKey) !== String(process.env.AGENT_API_KEY || '')) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    const { name, payload } = req.body || {}
    const intent = String(name || '').toLowerCase()
    const p = payload || {}

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
      const { error } = await supabaseAdmin.from('activities').insert([{
        lead_id: lead.id,
        user_id: ownerUserId,
        type,
        title,
        description,
        due_date,
        completed: false,
        organization_id: orgId,
      }])
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    if (intent === 'update_lead') {
      const lead = await resolveLead({ lead_id: p.id || p.leadId, phone: p.phone, organization_id: p.organization_id })
      if (!lead) return res.status(404).json({ error: 'lead_not_found' })
      const updates = { ...p }
      delete updates.id; delete updates.leadId; delete updates.phone; delete updates.organization_id
      const { error } = await supabaseAdmin.from('leads').update(updates).eq('id', lead.id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
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
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown_intent' })
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Provedor de WhatsApp: 'meta' (oficial), 'wapi', 'ultramsg', 'greenapi', 'zapi' ou 'wppconnect'
const WHATSAPP_PROVIDER = (process.env.WHATSAPP_PROVIDER || 'wapi').toLowerCase()

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
      const lead = leads?.[0]

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
app.get('/auth/whatsapp/url', async (req, res) => {
  try {
    const user = await getUserFromAuthHeader(req)
    if (!user) return res.status(401).json({ error: 'unauthorized' })
    const state = signState(user.id)
    const clientId = process.env.META_APP_ID
    const redirectUri = process.env.META_REDIRECT_URI_WHATSAPP || process.env.META_REDIRECT_URI
    const scope = encodeURIComponent('whatsapp_business_management,whatsapp_business_messaging')
    if (!clientId || !redirectUri) return res.status(500).json({ error: 'META_APP_ID/META_REDIRECT_URI_WHATSAPP ausentes' })
    const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${scope}`
    return res.json({ url })
  } catch (e) {
    console.error('[auth/whatsapp/url] error', e)
    return res.sendStatus(500)
  }
})

// OAuth WhatsApp - callback
app.get('/auth/whatsapp/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    const userId = verifyState(state)
    if (!userId) return res.status(400).send('invalid_state')
    const clientId = process.env.META_APP_ID
    const clientSecret = process.env.META_APP_SECRET
    const redirectUri = process.env.META_REDIRECT_URI_WHATSAPP || process.env.META_REDIRECT_URI
    if (!clientId || !clientSecret || !redirectUri) return res.status(500).send('meta_config_missing_whatsapp')

    const tokenResp = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`)
    const tokenJson = await tokenResp.json()
    if (!tokenResp.ok) {
      console.error('[auth/whatsapp/callback] token error', tokenJson)
      return res.status(502).send('token_exchange_failed')
    }
    const access_token = tokenJson.access_token

    // Salvar nas settings do usuário
    const { error: setErr } = await supabaseAdmin
      .from('settings')
      .upsert({
        user_id: userId,
        key: 'whatsapp',
        value: { access_token, connected_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,key' })
    if (setErr) {
      console.error('[auth/whatsapp/callback] settings upsert error', setErr.message)
      // Continua o fluxo, mas sinaliza
    }

    return res.send('<script>window.close && window.close(); window.opener && window.opener.postMessage({ type: "whatsapp_connected" }, "*");</script>Conexão concluída. Você pode fechar esta janela.')
  } catch (e) {
    console.error('[auth/whatsapp/callback] error', e)
    return res.status(500).send('internal_error')
  }
})

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

    const lead = (leads || [])[0]

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
    const lead = (leads || [])[0]

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
    await supabaseAdmin.from('communications').insert([insertPayload])
    return res.sendStatus(200)
  } catch (e) {
    console.error('[greenapi] inbound error', e)
    return res.sendStatus(200)
  }
})

// Webhook W-API
app.post('/webhooks/wapi', async (req, res) => {
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
})

// Webhook WPPConnect
app.post('/webhooks/wppconnect', async (req, res) => {
  try {
    const body = parseJsonBody(req)
    const data = body || {}
    const msg = data.message || data.data || data
    const text = msg?.body || msg?.text || data?.text || ''
    const fromRaw = msg?.from || data?.from || msg?.chatId || msg?.chat?.id || ''
    const externalId = msg?.id || data?.id || msg?.messageId || null
    const session = data?.session || data?.Session || data?.sessionId || null
    if (!fromRaw || !text) return res.status(200).json({ ok: true })
    const from = String(fromRaw).replace(/\D/g, '')

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .ilike('phone', `%${from.slice(-8)}%`)
      .limit(1)
    const lead = (leads || [])[0]

    // Resolver org pelo session se necessário
    let orgId = lead?.organization_id || null
    if (!orgId && session) {
      try {
        const { data: orgCfg } = await supabaseAdmin
          .from('organization_settings')
          .select('organization_id')
          .eq('key', 'whatsapp_nonofficial')
          .filter('value->>provider', 'eq', 'wppconnect')
          .or(`value->>session.eq.${String(session)},value->>session_id.eq.${String(session)},value->>instance_id.eq.${String(session)}`)
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
    console.error('[wppconnect] inbound error', e)
    return res.sendStatus(200)
  }
})

// W-API: Received webhook (mensagens recebidas)
app.post('/webhooks/wapi/received', async (req, res) => {
  try {
    if (!verifyWapiSignature(req)) return res.sendStatus(403)
    // Reutiliza lógica do handler unificado
    return app._router.handle({ ...req, url: '/webhooks/wapi', method: 'POST' }, res, () => {})
  } catch (e) {
    console.error('[wapi/received] error', e)
    return res.sendStatus(200)
  }
})

// W-API: Delivery webhook (entrega enviada)
app.post('/webhooks/wapi/delivery', async (req, res) => {
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
})

// W-API: Message status webhook (sent/delivered/read/failed)
app.post('/webhooks/wapi/message-status', async (req, res) => {
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
})

// W-API: Chat presence webhook (typing/online etc) — ignoramos por ora
app.post('/webhooks/wapi/chat-presence', async (_req, res) => {
  try {
    // opcional: validar assinatura/token
    if (!verifyWapiSignature(_req)) return res.sendStatus(403)
    return res.sendStatus(200)
  } catch {
    return res.sendStatus(200)
  }
})

// W-API: Connected/Disconnected webhooks — apenas logam/ack
app.post('/webhooks/wapi/connected', async (_req, res) => {
  try { if (!verifyWapiSignature(_req)) return res.sendStatus(403); return res.sendStatus(200) } catch { return res.sendStatus(200) }
})
app.post('/webhooks/wapi/disconnected', async (_req, res) => {
  try { if (!verifyWapiSignature(_req)) return res.sendStatus(403); return res.sendStatus(200) } catch { return res.sendStatus(200) }
})

// Webhook Z-API
app.post('/webhooks/zapi', async (req, res) => {
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

    // Cria lead automaticamente quando não existir um lead correspondente
    let targetLead = lead || null
    if (!targetLead && ownerUserId) {
      try {
        const insertLead = {
          name: `Contato ${from.slice(-4)}`,
          company: '—',
          email: null,
          phone: from,
          ig_username: null,
          value: 0,
          status: 'new',
          responsible: 'Import',
          source: 'whatsapp',
          tags: ['zapi-inbound'],
          notes: null,
          user_id: ownerUserId,
          organization_id: orgId,
        }
        const { data: created, error: createLeadErr } = await supabaseAdmin
          .from('leads')
          .insert([insertLead])
          .select('*')
          .single()
        if (!createLeadErr && created) {
          targetLead = created
        }
      } catch {}
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
})

// Webhook Z-API: status da mensagem (delivered/read/failed)
app.post('/webhooks/zapi/status', async (req, res) => {
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
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'missing_gemini_key' })
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