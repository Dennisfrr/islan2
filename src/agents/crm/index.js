/*
  CRM Agent — ponte de intents com o app e orquestração básica
  - Envia intents via postMessage e aguarda respostas
  - Expõe window.CRMEngine com helpers de alto nível
*/

const DEFAULT_INTENT_TIMEOUT_MS = 15000

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

export function sendCRMIntent(name, payload = {}, { timeoutMs = DEFAULT_INTENT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const id = uuid()
    let timer = null
    const onMessage = (ev) => {
      const d = ev?.data || null
      if (!d || d.type !== 'crm_intent_result' || d.id !== id) return
      cleanup()
      if (d.ok) return resolve(d.result)
      return reject(new Error(d.error || 'intent_failed'))
    }
    function cleanup() {
      window.removeEventListener('message', onMessage)
      if (timer) clearTimeout(timer)
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ type: 'crm_intent', id, name, payload }, '*')
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('intent_timeout'))
    }, timeoutMs)
  })
}

export const CRMEngine = {
  async moveLead(leadId, toStageId) { return sendCRMIntent('move_lead', { leadId, toStageId }) },
  async createLead(data) { return sendCRMIntent('create_lead', data) },
  async updateLead(data) { return sendCRMIntent('update_lead', data) },
  async deleteLead(id) { return sendCRMIntent('delete_lead', { id }) },
  async setFilter(filters) { return sendCRMIntent('set_filter', filters) },
  async setView(view) { return sendCRMIntent('set_view', { view }) },
  async selectLead(leadId, openDetails = false) { return sendCRMIntent('select_lead', { leadId, openDetails }) },
  async openQuickChat(leadId) { return sendCRMIntent('open_quick_chat', { leadId }) },
  async openWhatsAppView(leadId) { return sendCRMIntent('open_whatsapp_view', { leadId }) },
  async getState() { return sendCRMIntent('get_state', {}) },
  // Atividades
  async createNote(p) { return sendCRMIntent('create_note', p) },
  async createTask(p) { return sendCRMIntent('create_task', p) },
  async updateActivity(p) { return sendCRMIntent('update_activity', p) },
  async deleteActivity(id) { return sendCRMIntent('delete_activity', { id }) },
  async openActivities() { return sendCRMIntent('open_activities', {}) },
  async openTasks() { return sendCRMIntent('open_tasks', {}) },
  // Deals
  async openDeals() { return sendCRMIntent('open_deals', {}) },
  async createDeal(p) { return sendCRMIntent('create_deal', p) },
  async updateDeal(p) { return sendCRMIntent('update_deal', p) },
  async deleteDeal(id) { return sendCRMIntent('delete_deal', { id }) },
}

// Expõe no window
;(function expose() {
  try { (window).CRMEngine = CRMEngine } catch {}
})()


