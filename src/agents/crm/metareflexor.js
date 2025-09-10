/*
  MetaReflexor — funções de planejamento/reflexão para o agente do CRM
  - Constrói planos a partir de metas em linguagem natural
  - Faz escolhas simples de intent com base no estado atual
*/

import { CRMEngine } from './index'

export function planFromGoal(goalText) {
  const g = String(goalText || '').toLowerCase()
  const steps = []
  if (g.includes('mover') && g.includes('lead')) {
    steps.push({ intent: 'get_state' })
    steps.push({ intent: 'move_lead', params: { /* preencher leadId/toStageId */ } })
  }
  if (g.includes('criar') && (g.includes('nota') || g.includes('anota'))) {
    steps.push({ intent: 'create_note', params: { /* leadId, title */ } })
  }
  if (g.includes('tarefa')) {
    steps.push({ intent: 'create_task', params: { /* leadId, title, due_date? */ } })
  }
  if (g.includes('proposta') || g.includes('deal')) {
    steps.push({ intent: 'create_deal', params: { /* leadId?, title, items? */ } })
  }
  if (!steps.length) steps.push({ intent: 'get_state' })
  return steps
}

export async function reflect(lastResult, context = {}) {
  // Estratégia simples: se falhou por falta de parâmetro, solicitar/ajustar
  if (!lastResult || lastResult.ok) return { action: 'continue' }
  const msg = String(lastResult.error || '')
  if (msg.includes('invalid_params')) {
    return { action: 'await_params', need: 'params_missing' }
  }
  return { action: 'continue' }
}

export async function chooseIntentFromState(state, hint) {
  const h = String(hint || '').toLowerCase()
  if (h.includes('whatsapp')) return { name: 'open_whatsapp_view', payload: {} }
  if (h.includes('ativ') || h.includes('tarefa')) return { name: 'open_activities', payload: {} }
  if (h.includes('deal') || h.includes('proposta')) return { name: 'open_deals', payload: {} }
  return { name: 'get_state', payload: {} }
}

export async function executePlan(steps) {
  const results = []
  for (const step of steps) {
    try {
      const r = await (CRMEngine)[camelToMethod(step.intent)]?.(step.params || {})
      results.push({ step, ok: true, result: r })
    } catch (e) {
      results.push({ step, ok: false, error: String(e?.message || e) })
    }
  }
  return results
}

function camelToMethod(intentName) {
  const map = {
    'get_state': 'getState',
    'move_lead': 'moveLead',
    'open_quick_chat': 'openQuickChat',
    'open_whatsapp_view': 'openWhatsAppView',
    'create_lead': 'createLead',
    'update_lead': 'updateLead',
    'delete_lead': 'deleteLead',
    'set_filter': 'setFilter',
    'set_view': 'setView',
    'select_lead': 'selectLead',
    'bulk_create_in_stage': 'bulkCreateInStage', // não implementado no engine
    'edit_stages_open': 'editStagesOpen',        // não implementado no engine
    // atividades
    'create_note': 'createNote',
    'create_task': 'createTask',
    'update_activity': 'updateActivity',
    'delete_activity': 'deleteActivity',
    'open_activities': 'openActivities',
    'open_tasks': 'openTasks',
    // deals
    'open_deals': 'openDeals',
    'create_deal': 'createDeal',
    'update_deal': 'updateDeal',
    'delete_deal': 'deleteDeal',
  }
  return map[intentName] || intentName
}


