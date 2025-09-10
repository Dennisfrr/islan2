require('dotenv').config()

const CRM_BASE_URL = process.env.CRM_BASE_URL || process.env.CRM_URL || 'http://localhost:3000'
const CRM_AGENT_KEY = process.env.CRM_AGENT_KEY || process.env.AGENT_API_KEY || ''
const CRM_ORGANIZATION_ID = process.env.CRM_ORGANIZATION_ID || ''

if (!CRM_AGENT_KEY) {
  console.warn('[CRMBridge] AVISO: defina CRM_AGENT_KEY (ou AGENT_API_KEY) no .env para autenticar no CRM /api/agent/dispatch')
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

async function dispatchToCRM(name, payload, { idempotencyKey } = {}) {
  const url = `${String(CRM_BASE_URL).replace(/\/$/, '')}/api/agent/dispatch`
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Key': CRM_AGENT_KEY }
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey)
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name, payload }) })
  const js = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(js?.error || `dispatch_failed_${resp.status}`)
  return js
}

module.exports = { dispatchToCRM, wasProcessed, markProcessed, CRM_ORGANIZATION_ID }


