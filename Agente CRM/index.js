require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { evaluateAndRunTools, getRegisteredTools, runToolById } = require('./toolsEngine')
const { getSession, closeDriver } = require('./db_neo4j')
const { ReflectionAnalyticsTracker } = require('./reflectionAnalyticsTracker')
const { MetaReflexor } = require('./metaReflexor')
const { ReflectiveAgent, ReflectionFocus } = require('./reflectiveAgent')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = Number(process.env.CRM_AGENT_PORT || 3010)
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || ''

app.get('/health', (_req, res) => res.json({ ok: true, service: 'crm-agent', port: PORT }))

// Lista de tools registradas (dinâmicas + estáticas do WhatsApp)
app.get('/api/tools', (_req, res) => {
  try { res.json(getRegisteredTools()) } catch (e) { res.status(500).json({ error: e.message }) }
})

// Recebe eventos do CRM ou de outros serviços e aciona o motor de ferramentas
// body: { eventType: string, leadProfile?: any, reflectionResult?: any, payload?: any, messageText?: string, threshold?: number }
app.post('/api/agent/event', async (req, res) => {
  try {
    const ctx = req.body || {}
    if (!ctx.eventType) return res.status(400).json({ error: 'eventType_required' })
    await evaluateAndRunTools(ctx)
    res.json({ ok: true })
  } catch (e) {
    console.error('[CRM Agent] /api/agent/event error:', e)
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// Webhook inbound do CRM → normaliza em eventos internos
// Espera header 'X-CRM-Signature' simples (MVP) igual ao CRM_WEBHOOK_SECRET
app.post('/api/crm/webhook', async (req, res) => {
  try {
    const sig = String(req.headers['x-crm-signature'] || '')
    if (CRM_WEBHOOK_SECRET && sig !== CRM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid_signature' })
    }
    const body = req.body || {}
    const { type, data } = body
    if (!type) return res.status(400).json({ error: 'type_required' })

    // Mapeamentos comuns: lead.created, lead.updated, lead.stage_changed, note.created, task.completed
    switch (String(type)) {
      case 'lead.created': {
        const leadProfile = normalizeLeadFromCrm(data)
        await evaluateAndRunTools({ eventType: 'crm_lead_created', leadProfile, payload: { raw: data } })
        break
      }
      case 'lead.updated': {
        const leadProfile = normalizeLeadFromCrm(data)
        await evaluateAndRunTools({ eventType: 'crm_lead_updated', leadProfile, payload: { raw: data } })
        break
      }
      case 'lead.stage_changed': {
        const leadProfile = normalizeLeadFromCrm(data)
        await evaluateAndRunTools({ eventType: 'crm_stage_changed', leadProfile, payload: { raw: data, toStage: data?.toStage } })
        break
      }
      default: {
        await evaluateAndRunTools({ eventType: `crm_${String(type)}`, leadProfile: normalizeLeadFromCrm(data), payload: { raw: data } })
      }
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[CRM Agent] /api/crm/webhook error:', e)
    res.status(500).json({ error: String(e?.message || e) })
  }
})

function normalizeLeadFromCrm(d) {
  try {
    if (!d || typeof d !== 'object') return {}
    const phone = String(d.phone || d.telefone || d.whatsapp || '').replace(/\D/g, '')
    return {
      idWhatsapp: phone ? `${phone}@c.us` : (d.idWhatsapp || null),
      nomeDoLead: d.name || d.nome || d.leadName || null,
      nomeDoNegocio: d.company || d.empresa || null,
      tipoDeNegocio: d.businessType || d.segment || null,
      nivelDeInteresseReuniao: d.meetingInterest || d.stage || null,
      ultimoResumoDaSituacao: d.lastSummary || null,
      tags: Array.isArray(d.tags) ? d.tags : [],
    }
  } catch { return {} }
}

// Execução manual de tool por id
app.post('/api/tools/:id/run', async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!id) return res.status(400).json({ error: 'id_required' })
    const result = await runToolById(id, req.body || {})
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// ====== Analytics & Meta-Reflexão ======
const globalAnalyticsTracker = new ReflectionAnalyticsTracker()
global.globalAnalyticsTracker = globalAnalyticsTracker
const globalMetaReflexor = new MetaReflexor(globalAnalyticsTracker)
global.globalMetaReflexor = globalMetaReflexor
try { globalMetaReflexor.start() } catch {}

app.get('/api/analytics/reflections', (_req, res) => {
  res.json(globalAnalyticsTracker.getAllReflectionData())
})

app.get('/api/analytics/reflections/metrics', (req, res) => {
  const plan = String(req.query.plan || '')
  res.json(globalAnalyticsTracker.getMetricsForPlan(plan))
})

app.get('/api/analytics/meta-reflexor-insights', (_req, res) => {
  res.json(globalMetaReflexor.getLatestInsights() || {})
})

// Gera reflexão ad-hoc com Gemini
app.post('/api/reflection/generate', async (req, res) => {
  try {
    const { lastAgentMessage, lastUserMessage, leadProfile, plannerState, conversationHistory, focusType, previousReflections, activeHypotheses } = req.body || {}
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'gemini_not_configured' })
    const ra = new ReflectiveAgent(process.env.GEMINI_API_KEY)
    const reflection = await ra.reflect(lastAgentMessage, lastUserMessage, leadProfile, plannerState || {}, Array.isArray(conversationHistory)?conversationHistory:[], focusType || ReflectionFocus.GENERAL_PROGRESS, previousReflections || [], activeHypotheses || [])
    // Loga no tracker se tiver campos mínimos
    try {
      if (leadProfile?.idWhatsapp && plannerState?.selectedPlanName && plannerState?.currentStep?.name) {
        globalAnalyticsTracker.addReflectionData({
          leadId: leadProfile.idWhatsapp,
          leadName: leadProfile.nomeDoLead || null,
          leadType: leadProfile.tipoDeNegocio || null,
          planName: plannerState.selectedPlanName,
          stepName: plannerState.currentStep.name,
          agentAction: reflection?.acaoPrincipalRealizadaPeloAgente || null,
          stepGoalAchieved: !!reflection?.objetivoDaEtapaDoPlannerAvancou,
          inferredLeadSentiment: reflection?.sentimentoInferidoDoLead || null,
          rawReflection: reflection,
        })
      }
    } catch {}
    // Roteador agentic opcional: se houver sugestão de ferramenta, tenta executar
    let routed = null
    try {
      const minConf = Number(process.env.ROUTER_TOOL_MIN_CONF || 0.55)
      const conf = Number(reflection?.confidenceScore || 0)
      if (conf >= minConf && leadProfile?.idWhatsapp) {
        const route = mapReflectionToTool(reflection, leadProfile)
        if (route && route.toolId) {
          routed = await runToolById(route.toolId, { leadProfile, ...route.payload, threshold: conf })
        }
      }
    } catch (e) { console.warn('[router] tool route failed:', e?.message || e) }
    res.json({ reflection, routed })
  } catch (e) {
    console.error('[CRM Agent] /api/reflection/generate error:', e)
    res.status(500).json({ error: String(e?.message || e) })
  }
})

function mapReflectionToTool(reflection, leadProfile) {
  try {
    const s = String(reflection?.sugestaoDeFerramentaParaProximoPasso || '').toLowerCase()
    const next = String(reflection?.proximoPassoLogicoSugerido || '').trim()
    const leadId = leadProfile?.idWhatsapp
    const includes = (kw) => s.includes(kw) || next.toLowerCase().includes(kw)

    // tarefa
    if (includes('tarefa') || includes('task')) {
      const due = new Date(Date.now() + 24*60*60*1000).toISOString()
      const text = next || 'Follow-up automático'
      return { toolId: 'tool.crm.createTask', payload: { leadId, text, due } }
    }
    // nota
    if (includes('nota') || includes('note')) {
      const text = next || (reflection?.resumoDaReflexao || 'Nota automática')
      return { toolId: 'tool.crm.addNote', payload: { leadId, text, type: 'insight' } }
    }
    // mover estágio
    if (includes('estagio') || includes('estágio') || includes('stage') || includes('pipeline') || includes('mover')) {
      const to = guessStageIdFromText(s + ' ' + next)
      if (to) return { toolId: 'tool.crm.moveStage', payload: { leadId, to, rationale: reflection?.justificativaProgressoPlanner || 'router' } }
    }
    // pré-call
    if (includes('precall') || includes('pré-call') || includes('pre-call')) {
      return { toolId: 'enqueue-precall-reflection', payload: { leadProfile } }
    }
    return null
  } catch { return null }
}

function guessStageIdFromText(text) {
  const t = String(text || '').toLowerCase()
  if (/propost|orcament|proposal|budget/.test(t)) return 'proposal'
  if (/negoci|agend|meeting|schedule/.test(t)) return 'negotiation'
  if (/qualific|qualify/.test(t)) return 'qualified'
  if (/ganh|won/.test(t)) return 'closed-won'
  if (/perd|lost/.test(t)) return 'closed-lost'
  return null
}

// Endpoint utilitário: testa conexão com Neo4j
app.get('/_db/ping', async (_req, res) => {
  const session = await getSession()
  try {
    await session.run('RETURN 1 AS ok')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  } finally { await session.close() }
})

const server = app.listen(PORT, () => {
  console.log(`CRM Agent listening on :${PORT}`)
})

async function shutdown() {
  try { server.close(() => console.log('HTTP server closed')) } catch {}
  try { await closeDriver() } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

module.exports = { }


