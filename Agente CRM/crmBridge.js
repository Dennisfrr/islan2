require('dotenv').config()

const CRM_BASE_URL = process.env.CRM_BASE_URL || process.env.CRM_URL || 'http://localhost:3000'
const CRM_AGENT_KEY = process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY || ''
const CRM_BEARER_TOKEN = process.env.CRM_BEARER_TOKEN || process.env.CRM_SERVICE_TOKEN || ''
const CRM_ORGANIZATION_ID = process.env.CRM_ORGANIZATION_ID || ''

if (!CRM_AGENT_KEY && !CRM_BEARER_TOKEN) {
  console.warn('[CRMBridge] AVISO: defina CRM_AGENT_KEY (ou AGENT_API_KEY) ou CRM_BEARER_TOKEN no .env para autenticar no CRM /api/agent/dispatch')
}

const processedMessageIds = new Set()
const processedWindow = [] // manter ordem para GC
const MAX_TRACK = 5000

function wasProcessed(id) {
  return processedMessageIds.has(String(id || ''))
}

function markProcessed(id) {
  const key = String(id || '')
  if (!key) return
  if (!processedMessageIds.has(key)) {
    processedMessageIds.add(key)
    processedWindow.push(key)
    if (processedWindow.length > MAX_TRACK) {
      const old = processedWindow.shift()
      if (old) processedMessageIds.delete(old)
    }
  }
}

async function dispatchToCRM(name, payload, { idempotencyKey, timeoutMs = 10000 } = {}) {
  const url = `${String(CRM_BASE_URL).replace(/\/$/, '')}/api/agent/dispatch`
  const headers = { 'Content-Type': 'application/json' }
  if (CRM_AGENT_KEY) headers['X-Agent-Key'] = CRM_AGENT_KEY
  if (CRM_BEARER_TOKEN) headers['Authorization'] = `Bearer ${CRM_BEARER_TOKEN}`
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey)

  // Injeta organization_id por padrão se ausente
  const enrichedPayload = {
    ...(payload || {}),
    ...(CRM_ORGANIZATION_ID && !payload?.organization_id ? { organization_id: CRM_ORGANIZATION_ID } : {}),
  }

  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name, payload: enrichedPayload }), signal: controller.signal })
    const js = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      // Log detalhado e dica de configuração
      const hint = (resp.status === 401 || resp.status === 403)
        ? 'unauthorized: verifique CRM_AGENT_KEY/AGENT_API_KEY (no CRM) ou CRM_BEARER_TOKEN (token de serviço)'
        : `http_${resp.status}`
      throw new Error(js?.error || hint)
    }
    return js
  } finally {
    clearTimeout(to)
  }
}

module.exports = { dispatchToCRM, wasProcessed, markProcessed, CRM_ORGANIZATION_ID }


