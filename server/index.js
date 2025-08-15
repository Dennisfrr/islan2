import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

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
      to: String(lead.phone || '').replace(/\D/g, ''),
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
      const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { data: { full_name, role } })
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