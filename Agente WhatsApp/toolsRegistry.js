// toolsRegistry.js
// Registro de ferramentas orientadas a gatilhos (event-driven), com schema simples.

/**
 * Tool Schema (MVP):
 * {
 *   id: string,
 *   name: string,
 *   description: string,
 *   enabled: boolean,
 *   eventTypes: string[], // e.g., ['afterReflection', 'afterProfileUpdate']
 *   threshold: number, // confiança mínima para ação automática
 *   trigger: (context) => { shouldFire: boolean, confidence: number, rationale?: string, payload?: any },
 *   action: async (context, triggerResult, deps) => Promise<void>
 * }
 */

const DEFAULT_THRESHOLD = parseFloat(process.env.TOOL_DEFAULT_THRESHOLD || '0.75');
const { dispatchToCRM, CRM_ORGANIZATION_ID } = require('./crmBridge');

function mapStageToCrmStatus(stage) {
  const v = String(stage || '').toLowerCase();
  if (v.includes('proposta')) return 'proposal';
  if (v.includes('agend')) return 'negotiation';
  if (v.includes('qualific')) return 'qualified';
  if (v.includes('perd') || v.includes('lost')) return 'closed-lost';
  if (v.includes('ganh') || v.includes('won')) return 'closed-won';
  return 'qualified';
}

function extractPhoneFromWhatsappId(idWhatsapp) {
  return String(idWhatsapp || '').replace(/\D/g, '');
}

function isLeadNotFoundError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('lead_not_found') || msg.includes('404');
}

const TOOLS = [
  {
    id: 'enqueue-emotion-analysis',
    name: 'Agendar análise de emoção do lead',
    description: 'Marca o lead para análise de tom/emocional em background, sem bloquear o fluxo principal.',
    enabled: true,
    eventTypes: ['afterReflection', 'afterProfileUpdate', 'afterMessage'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const leadProfile = context?.leadProfile || null;
      if (!leadProfile?.idWhatsapp) return { shouldFire: false, confidence: 0 };
      // Debounce simples via threshold (não usado aqui) e deixa o worker decidir freshness
      return { shouldFire: true, confidence: 1.0, payload: { idWhatsapp: leadProfile.idWhatsapp } };
    },
    action: async (context, triggerResult, deps) => {
      const { getSession } = deps;
      const session = await getSession();
      try {
        const id = triggerResult?.payload?.idWhatsapp;
        if (!id) return;
        await session.run(`
          MATCH (l:Lead {idWhatsapp: $id})
          SET l.emotionNeedsRefresh = true
        `, { id });
      } finally {
        await session.close();
      }
    }
  },
  {
    id: 'tool.followup.feedbackOnInbound',
    name: 'Marcar sucesso de follow-up ao receber inbound',
    description: 'Detecta resposta do lead após envio e marca o último follow-up como bem sucedido, cancelando pendentes.',
    enabled: true,
    eventTypes: ['afterMessage'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const lead = ctx?.leadProfile
      const msg = String(ctx?.messageText || '')
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      // Qualquer inbound não vazio pode sinalizar sucesso
      return { shouldFire: true, confidence: msg.trim().length > 0 ? 1.0 : 0.0 }
    },
    action: async (ctx, _tr, { getSession }) => {
      const s = await getSession();
      try {
        const id = ctx.leadProfile.idWhatsapp
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })-[:HAS_FOLLOWUP]->(f:FollowUp)
          WHERE f.status IN ['scheduled','processing']
          SET f.status = CASE WHEN f.status='scheduled' THEN 'cancelled' ELSE f.status END,
              f.updatedAt = timestamp()
        `, { id })
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })-[:HAS_FOLLOWUP]->(f:FollowUp)
          WHERE f.status = 'sent'
          WITH f
          ORDER BY coalesce(f.sentAt, f.updatedAt) DESC
          LIMIT 1
          SET f.success = true, f.updatedAt = timestamp()
        `, { id })
      } finally { await s.close() }
    }
  },
  {
    id: 'crm-note-on-goal-breach',
    name: 'Criar nota CRM quando meta estourar',
    description: 'Quando uma meta estiver off_track, cria uma nota/tarefa no CRM destacando prioridade e próximo passo.',
    enabled: true,
    eventTypes: ['goalBreach'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const { goal, leadProfile } = context || {};
      if (!leadProfile?.idWhatsapp || !goal || !goal.id) return { shouldFire: false, confidence: 0 };
      // confiança fixa para disparo administrativo
      return { shouldFire: true, confidence: 1.0, payload: { goal } };
    },
    action: async (context, triggerResult, _deps) => {
      try {
        const { leadProfile } = context;
        const { goal } = triggerResult.payload || {};
        const phone = extractPhoneFromWhatsappId(leadProfile.idWhatsapp);
        const title = `Meta em risco: ${goal.id}`;
        const description = `Meta '${goal.id}' off-track. Valor atual: ${goal.value} | Alvo: ${goal.target} (${goal.direction}).`;
        await dispatchToCRM('create_note', { phone, title, description, organization_id: CRM_ORGANIZATION_ID || undefined }, { idempotencyKey: `goal-${goal.id}-${phone}` });
        // tarefa simples de follow-up
        const due = new Date(Date.now() + 24*60*60*1000).toISOString();
        await dispatchToCRM('create_task', { phone, title: `Ação para meta: ${goal.id}`, description: 'Priorizar próximos passos para recuperar meta.', due_date: due, organization_id: CRM_ORGANIZATION_ID || undefined }, { idempotencyKey: `goal-task-${goal.id}-${phone}` });
      } catch (e) {
        console.warn('[toolsRegistry] crm-note-on-goal-breach failed:', e?.message || e);
      }
    }
  },
  {
    id: 'enqueue-precall-reflection',
    name: 'Agendar Pre-call Reflection',
    description: 'Marca o lead para geração de resumo e perguntas de pré-call em background.',
    enabled: true,
    eventTypes: ['afterMessage', 'afterProfileUpdate'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const leadProfile = context?.leadProfile || null;
      if (!leadProfile?.idWhatsapp) return { shouldFire: false, confidence: 0 };
      return { shouldFire: true, confidence: 1.0, payload: { idWhatsapp: leadProfile.idWhatsapp } };
    },
    action: async (_context, triggerResult, deps) => {
      const { getSession } = deps;
      const session = await getSession();
      try {
        const id = triggerResult?.payload?.idWhatsapp;
        if (!id) return;
        await session.run(`
          MATCH (l:Lead {idWhatsapp: $id})
          SET l.precallNeedsRefresh = true
        `, { id });
      } finally { await session.close(); }
    }
  },
  {
    id: 'classify-pipeline-high-intent',
    name: 'Classificar estágio por intenção alta',
    description: 'Quando detectar intenção alta (ex.: reunião agendada ou proposta), mover ou sugerir estágio no pipeline.',
    enabled: true,
    eventTypes: ['afterReflection', 'afterProfileUpdate'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const { leadProfile, reflectionResult } = context || {};
      let confidence = 0.0;
      const rationaleParts = [];
      let toStage = null;

      if (leadProfile && String(leadProfile.nivelDeInteresseReuniao || '').toLowerCase() === 'agendado') {
        toStage = 'Agendado'; confidence = Math.max(confidence, 0.9); rationaleParts.push('nivelDeInteresseReuniao=agendado');
      }
      if (leadProfile && /proposta|orcamento|valor/i.test(String(leadProfile.ultimoResumoDaSituacao || ''))) {
        toStage = toStage || 'Proposta'; confidence = Math.max(confidence, 0.72); rationaleParts.push('menção a proposta/orçamento/valor');
      }
      if (!toStage && reflectionResult && /proposta|agendar/i.test(JSON.stringify(reflectionResult))) {
        toStage = 'Proposta'; confidence = Math.max(confidence, 0.65); rationaleParts.push('reflexão sugere proposta/agendar');
      }
      if (!toStage) return { shouldFire: false, confidence: 0 };
      return { shouldFire: true, confidence, rationale: rationaleParts.join('; '), payload: { toStage } };
    },
    action: async (context, triggerResult, deps) => {
      const { neo4j, getSession } = deps;
      const { leadProfile } = context;
      const { toStage } = triggerResult.payload || {};
      const session = await getSession();
      try {
        if (triggerResult.confidence >= (context.threshold || DEFAULT_THRESHOLD)) {
          await session.run(`
            MATCH (l:Lead {idWhatsapp: $id})
            WITH l, l.pipelineStage AS fromStage
            SET l.pipelineStage = $toStage, l.stageUpdatedAt = timestamp(), l.dtUltimaAtualizacao = coalesce(l.dtUltimaAtualizacao, timestamp())
            MERGE (s:PipelineStage { name: $toStage })
              ON CREATE SET s.order = 999
            CREATE (t:StageTransition { from: coalesce(fromStage,'Desconhecido'), to: $toStage, at: timestamp(), by: 'agent', rationale: $rationale, confidence: $confidence })
            CREATE (l)-[:HAS_TRANSITION]->(t)
            CREATE (t)-[:TO_STAGE]->(s)
          `, { id: leadProfile.idWhatsapp, toStage, rationale: triggerResult.rationale || '', confidence: triggerResult.confidence });
        } else {
          await session.run(`
            MATCH (l:Lead {idWhatsapp: $id})
            MERGE (s:PipelineStage { name: $toStage })
              ON CREATE SET s.order = 999
            CREATE (t:StageTransition { from: coalesce(l.pipelineStage,'Desconhecido'), to: $toStage, at: timestamp(), by: 'agent', rationale: $rationale, confidence: $confidence, needsReview: true })
            CREATE (l)-[:HAS_TRANSITION]->(t)
            CREATE (t)-[:TO_STAGE]->(s)
          `, { id: leadProfile.idWhatsapp, toStage, rationale: triggerResult.rationale || '', confidence: triggerResult.confidence });
        }
        // Best-effort notify CRM intents
        try {
          const phone = extractPhoneFromWhatsappId(leadProfile.idWhatsapp);
          const toStageId = mapStageToCrmStatus(toStage);
          await dispatchToCRM('move_lead', {
            phone,
            toStageId,
            organization_id: CRM_ORGANIZATION_ID || undefined,
          });
          // Golden Note
          try {
            const title = `Dado de Ouro — Movido para ${toStageId}`;
            const rationale = triggerResult.rationale || '';
            const conf = typeof triggerResult.confidence === 'number' ? triggerResult.confidence.toFixed(2) : '';
            const description = `Rationale: ${rationale}\nConfidence: ${conf}`;
            await dispatchToCRM('create_note', {
              phone,
              title,
              description,
              organization_id: CRM_ORGANIZATION_ID || undefined,
            }, { idempotencyKey: `gold-note-move-${phone}-${toStageId}` });
          } catch {}
        } catch (e) {
          console.warn('[toolsRegistry] dispatch move_lead failed:', e?.message || e);
        }
      } finally {
        await session.close();
      }
    }
  },
  // === Fase 2: Disparar follow-up por silêncio/inatividade ===
  {
    id: 'schedule_followup_on_silence',
    name: 'Agendar follow-up por silêncio',
    description: 'Agenda follow-up quando não há resposta do lead após saída do agente por um período.',
    enabled: true,
    eventTypes: ['afterMessage', 'afterReflection'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const lead = context?.leadProfile;
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 };
      const now = Date.now();
      const lastInbound = Number(lead.lastInboundAt || 0);
      const lastOutbound = Number(lead.lastOutboundAt || 0);
      const silenceMs = Number(process.env.FOLLOWUP_SILENCE_MS || (24 * 60 * 60 * 1000));
      const hasSilence = lastOutbound && (!lastInbound || (lastInbound < lastOutbound && (now - lastOutbound) >= silenceMs));
      if (!hasSilence) return { shouldFire: false, confidence: 0 };
      return { shouldFire: true, confidence: 0.9, payload: { when: new Date(now + 10 * 60 * 1000).getTime() } };
    },
    action: async (context, trig, { getSession }) => {
      const lead = context?.leadProfile;
      if (!lead?.idWhatsapp) return;
      const session = await getSession();
      try {
        await session.run(`
          MATCH (l:Lead { idWhatsapp: $id })
          CREATE (f:FollowUp {
            objective: 'Retomar conversa após silêncio',
            leadId: $id,
            channel: 'whatsapp',
            status: 'scheduled',
            scheduledAt: $when,
            createdAt: timestamp(),
            updatedAt: timestamp(),
            attempts: 0,
            maxAttempts: 3,
            cooldownHours: 0
          })
          CREATE (l)-[:HAS_FOLLOWUP]->(f)
        `, { id: lead.idWhatsapp, when: trig?.payload?.when || (Date.now() + 10 * 60 * 1000) });
      } finally { await session.close(); }
    }
  },
  // === Fase 2: Detectar opt-out e marcar lead ===
  {
    id: 'detect_optout_and_mark',
    name: 'Detectar opt-out e marcar lead',
    description: 'Detecta palavras-chave de opt-out em mensagens do lead e define optOut=true.',
    enabled: true,
    eventTypes: ['afterMessage'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const text = String(context?.messageText || '').toLowerCase();
      if (!text) return { shouldFire: false, confidence: 0 };
      const patterns = [ 'pare', 'parar', 'remover', 'não quero', 'nao quero', 'stop', 'unsubscribe', 'sair', 'me tire', 'sem contato' ];
      const hit = patterns.some(p => text.includes(p));
      return { shouldFire: hit, confidence: hit ? 0.99 : 0 };
    },
    action: async (context, _tr, { getSession }) => {
      const lead = context?.leadProfile;
      if (!lead?.idWhatsapp) return;
      const s = await getSession();
      try {
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })
          SET l.optOut = true, l.dtUltimaAtualizacao = timestamp()
        `, { id: lead.idWhatsapp });
      } finally { await s.close(); }
    }
  },
  {
    id: 'tool.goldenNotes.update',
    name: 'Atualizar Golden Notes do Lead',
    description: 'Gera e salva notas resumidas (summary, objections, nextStep, valuePoints, aiScore).',
    enabled: true,
    eventTypes: ['afterMessage', 'afterReflection'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const lead = ctx?.leadProfile
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      return { shouldFire: true, confidence: 1.0 }
    },
    action: async (ctx, _tr, { getSession }) => {
      try {
        const lead = ctx.leadProfile
        // Chama o endpoint analyze para obter resumo e emoção (best-effort)
        try {
          const fetch = (await import('node-fetch')).default
          const base = `http://localhost:${process.env.DASHBOARD_PORT || 3005}`
          const r = await fetch(`${String(base).replace(/\/$/,'')}/api/leads/${encodeURIComponent(lead.idWhatsapp)}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
          await r.json().catch(()=>({}))
        } catch {}
        // Persistência mínima das golden notes (resumo existente + campos conhecidos)
        const s = await getSession()
        try {
          await s.run(`
            MATCH (l:Lead { idWhatsapp: $id })
            SET l.goldenNotes = coalesce(l.goldenNotes, {}),
                l.goldenNotesUpdatedAt = timestamp()
          `, { id: lead.idWhatsapp })
        } finally { await s.close() }
      } catch {}
    }
  },
  {
    id: 'tool.followup.scheduleOnSilence',
    name: 'Agendar Follow-up por Silêncio',
    description: 'Agenda follow-up se não houver inbound no estágio dentro do threshold.',
    enabled: true,
    eventTypes: ['afterMessage', 'afterReflection'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const lead = ctx?.leadProfile
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      return { shouldFire: true, confidence: 1.0, payload: { leadId: lead.idWhatsapp } }
    },
    action: async (ctx, { payload }) => {
      try {
        const base = process.env.DASHBOARD_BASE_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3005}`
        const fetch = (await import('node-fetch')).default
        const res = await fetch(`${String(base).replace(/\/$/,'')}/api/followups`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: payload.leadId, objective: 'Seguir na negociação', constraints: { maxChars: 420 } })
        })
        await res.json().catch(()=>({}))
      } catch {}
    }
  },
  {
    id: 'tool.followup.detectOptOut',
    name: 'Detectar opt-out e cancelar follow-ups',
    description: 'Detecta palavras-chave de opt-out (pare/stop/remover) e marca o lead como optOut=true, cancelando pendentes.',
    enabled: true,
    eventTypes: ['afterMessage'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const msg = String(ctx?.messageText || '').toLowerCase()
      const patterns = [/\bpare\b/, /\bstop\b/, /remover meu numero|remover número|remover meu número|quero sair|nao quero mais|não quero mais|unsubscribe/]
      const hit = patterns.some(re => re.test(msg))
      const lead = ctx?.leadProfile
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      return { shouldFire: hit, confidence: hit ? 1.0 : 0.0 }
    },
    action: async (ctx, _tr, { getSession }) => {
      const s = await getSession();
      try {
        const id = ctx.leadProfile.idWhatsapp
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })
          SET l.optOut = true, l.dtUltimaAtualizacao = timestamp()
        `, { id })
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })-[:HAS_FOLLOWUP]->(f:FollowUp)
          WHERE f.status IN ['scheduled','processing']
          SET f.status = 'cancelled', f.updatedAt = timestamp(), f.processingAt = NULL, f.workerId = NULL
        `, { id })
      } finally { await s.close() }
    }
  }
];

module.exports = { TOOLS };


