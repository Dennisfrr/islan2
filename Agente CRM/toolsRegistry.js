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
    id: 'tool.auto.firstMessageOnLeadCreated',
    name: 'Enviar 1ª mensagem ao criar lead (CRM)',
    description: 'Ao receber crm_lead_created, envia mensagem inicial no WhatsApp com CTA.',
    enabled: true,
    eventTypes: ['crm_lead_created'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const lead = ctx?.leadProfile;
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 };
      return { shouldFire: true, confidence: 1.0 };
    },
    action: async (ctx) => {
      try {
        const base = process.env.WA_AGENT_BASE_URL || 'http://localhost:3006';
        const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || '';
        const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`;
        const fetch = (await import('node-fetch')).default;
        const waJid = ctx?.leadProfile?.idWhatsapp;
        const phone = extractPhoneFromWhatsappId(waJid);
        const idempotencyKey = `firstmsg_${phone}`;
        const body = {
          name: 'generate_and_send',
          commandId: `first_${Date.now()}`,
          idempotencyKey,
          lead: { waJid },
          objective: 'Primeiro contato: entender contexto e oferecer call curta',
          constraints: { maxChars: 300, tone: 'respeitoso e direto' },
          cta: { type: 'schedule', label: 'Agendar 15 min?' },
          abTest: false,
          metadata: { reason: 'crm_lead_created' }
        };
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key?{ 'X-Agent-Key': key }:{}) }, body: JSON.stringify(body) });
      } catch (e) {
        console.warn('[toolsRegistry] firstMessageOnLeadCreated failed:', e?.message || e);
      }
    }
  },
  {
    id: 'tool.auto.proposalOnStageProposal',
    name: 'Gerar proposta e enviar quando estágio=proposal',
    description: 'Ao mudar para estágio de proposta, cria deal (sent) e envia link da proposta no WhatsApp.',
    enabled: true,
    eventTypes: ['crm_stage_changed'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => {
      const toStage = String(ctx?.payload?.toStage || '').toLowerCase();
      const isProposal = /propost|proposal|orcament|orçamento/.test(toStage);
      const hasLead = !!ctx?.leadProfile?.idWhatsapp;
      return { shouldFire: isProposal && hasLead, confidence: isProposal && hasLead ? 1.0 : 0.0 };
    },
    action: async (ctx) => {
      try {
        const waJid = ctx?.leadProfile?.idWhatsapp;
        const phone = extractPhoneFromWhatsappId(waJid);
        // 1) Criar deal no CRM (status sent)
        try {
          await dispatchToCRM('create_deal', { phone, value: 0, stage: 'sent', title: 'Proposta' });
        } catch (e) { console.warn('[toolsRegistry] create_deal failed:', e?.message || e) }
        // 2) Gerar link simples de proposta (placeholder ou base configurável)
        const baseUrl = process.env.PROPOSAL_BASE_URL || 'https://propostas.local';
        const proposalUrl = `${String(baseUrl).replace(/\/$/, '')}/${phone}-${Date.now()}`;
        // 3) Enviar via WA Agent (generate_and_send)
        try {
          const base = process.env.WA_AGENT_BASE_URL || 'http://localhost:3006';
          const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || '';
          const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`;
          const fetch = (await import('node-fetch')).default;
          const idempotencyKey = `proposal_${phone}`;
          const body = {
            name: 'generate_and_send',
            commandId: `prop_${Date.now()}`,
            idempotencyKey,
            lead: { waJid },
            objective: 'Enviar proposta com duas opções e esclarecer próximos passos',
            constraints: { maxChars: 380, tone: 'respeitoso e direto' },
            cta: { type: 'link', label: 'Ver proposta', url: proposalUrl },
            abTest: false,
            metadata: { proposalUrl, reason: 'stage_changed_to_proposal' }
          };
          await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key?{ 'X-Agent-Key': key }:{}) }, body: JSON.stringify(body) });
        } catch (e) { console.warn('[toolsRegistry] send proposal WA failed:', e?.message || e) }
      } catch (e) {
        console.warn('[toolsRegistry] proposalOnStageProposal failed:', e?.message || e);
      }
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
          // Golden Note: registrar motivo do avanço
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
            // Follow-up Task: próximo passo simples por estágio
            const nextStep = toStageId === 'proposal' ? 'Enviar proposta (2 opções) em 48h' :
                             toStageId === 'negotiation' ? 'Agendar call de negociação em 72h' :
                             toStageId === 'qualified' ? 'Enviar mensagem de descoberta (3 perguntas)' : null;
            if (nextStep) {
              const due = new Date(Date.now() + (toStageId === 'proposal' ? 48 : (toStageId === 'negotiation' ? 72 : 24)) * 60 * 60 * 1000).toISOString();
              await dispatchToCRM('create_task', {
                phone,
                title: nextStep,
                description: `Gerado automaticamente após avanço para ${toStageId}.`,
                due_date: due,
                organization_id: CRM_ORGANIZATION_ID || undefined,
              }, { idempotencyKey: `auto-task-${phone}-${toStageId}` });
            }
          } catch (eNote) { console.warn('[toolsRegistry] create_note(move) failed:', eNote?.message || eNote) }
        } catch (e) {
          console.warn('[toolsRegistry] dispatch move_lead failed:', e?.message || e);
          if (isLeadNotFoundError(e)) {
            try {
              await dispatchToCRM('create_lead', {
                name: leadProfile?.nomeDoLead || 'Lead',
                company: leadProfile?.nomeDoNegocio || '—',
                phone: extractPhoneFromWhatsappId(leadProfile?.idWhatsapp),
                organization_id: CRM_ORGANIZATION_ID || undefined,
                status: 'new',
                source: 'whatsapp-agent'
              });
              // try move again
              const phone = extractPhoneFromWhatsappId(leadProfile.idWhatsapp);
              const toStageId = mapStageToCrmStatus(toStage);
              await dispatchToCRM('move_lead', { phone, toStageId, organization_id: CRM_ORGANIZATION_ID || undefined });
              // also note after creating
              try {
                const title = `Dado de Ouro — Movido para ${toStageId}`;
                const rationale = triggerResult.rationale || '';
                const conf = typeof triggerResult.confidence === 'number' ? triggerResult.confidence.toFixed(2) : '';
                const description = `Rationale: ${rationale}\nConfidence: ${conf}`;
                await dispatchToCRM('create_note', { phone, title, description, organization_id: CRM_ORGANIZATION_ID || undefined }, { idempotencyKey: `gold-note-move-${phone}-${toStageId}` });
              } catch {}
            } catch (e2) {
              console.warn('[toolsRegistry] create_lead/move retry failed:', e2?.message || e2);
            }
          }
        }
      } finally {
        await session.close();
      }
    }
  },
  {
    id: 'crm-inbound-sync-lead',
    name: 'Sincronizar lead inbound do CRM',
    description: 'Cria/atualiza o nó Lead no Neo4j quando evento do CRM chegar.',
    enabled: true,
    eventTypes: ['crm_lead_created', 'crm_lead_updated'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const lead = context?.leadProfile
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      return { shouldFire: true, confidence: 1.0 }
    },
    action: async (context, _tr, deps) => {
      const { getSession } = deps
      const lead = context.leadProfile
      const session = await getSession()
      try {
        await session.run(`
          MERGE (l:Lead { idWhatsapp: $id })
          ON CREATE SET l.nome = coalesce($nome, 'Lead'), l.dtCriacao = timestamp(), l.dtUltimaAtualizacao = timestamp()
          ON MATCH SET l.nome = coalesce($nome, l.nome), l.dtUltimaAtualizacao = timestamp(),
            l.nomeDoNegocio = coalesce($empresa, l.nomeDoNegocio),
            l.tipoDeNegocio = coalesce($tipo, l.tipoDeNegocio),
            l.ultimoResumoDaSituacao = coalesce($resumo, l.ultimoResumoDaSituacao),
            l.nivelDeInteresseReuniao = coalesce($interesse, l.nivelDeInteresseReuniao)
        `, {
          id: lead.idWhatsapp,
          nome: lead.nomeDoLead,
          empresa: lead.nomeDoNegocio,
          tipo: lead.tipoDeNegocio,
          resumo: lead.ultimoResumoDaSituacao,
          interesse: lead.nivelDeInteresseReuniao,
        })
      } finally { await session.close() }
    }
  },
  {
    id: 'crm-inbound-stage-change',
    name: 'Aplicar mudança de estágio inbound',
    description: 'Atualiza stage no Neo4j a partir do webhook de stage do CRM.',
    enabled: true,
    eventTypes: ['crm_stage_changed'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (context) => {
      const lead = context?.leadProfile
      if (!lead?.idWhatsapp) return { shouldFire: false, confidence: 0 }
      const toStage = context?.payload?.toStage
      if (!toStage) return { shouldFire: false, confidence: 0 }
      return { shouldFire: true, confidence: 1.0, payload: { toStage } }
    },
    action: async (context, trig, deps) => {
      const { getSession } = deps
      const session = await getSession()
      try {
        await session.run(`
          MATCH (l:Lead { idWhatsapp: $id })
          WITH l, l.pipelineStage AS fromStage
          SET l.pipelineStage = $toStage, l.stageUpdatedAt = timestamp(), l.dtUltimaAtualizacao = timestamp()
          MERGE (s:PipelineStage { name: $toStage })
          CREATE (t:StageTransition { from: coalesce(fromStage,'Desconhecido'), to: $toStage, at: timestamp(), by: 'crm' })
          CREATE (l)-[:HAS_TRANSITION]->(t)
          CREATE (t)-[:TO_STAGE]->(s)
        `, { id: context.leadProfile.idWhatsapp, toStage: trig.payload.toStage })
      } finally { await session.close() }
    }
  },
  {
    id: 'tool.crm.createTask',
    name: 'Criar tarefa CRM',
    description: 'Cria uma tarefa no CRM e opcionalmente sincroniza referência no Lead.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (ctx, { payload }, { getSession }) => {
      const { leadId, text, due, priority } = payload
      const r = await dispatchToCRM('create_task', { phone: String(leadId || '').replace(/\D/g, ''), title: text, description: text, due_date: due, priority })
      try {
        if (r?.taskId && leadId) {
          const s = await getSession();
          try {
            await s.run(`MATCH (l:Lead { idWhatsapp: $id }) SET l.lastTaskId = $taskId, l.dtUltimaAtualizacao = timestamp()`, { id: leadId, taskId: String(r.taskId) })
          } finally { await s.close() }
        }
      } catch {}
      return r
    }
  },
  {
    id: 'tool.crm.moveStage',
    name: 'Mover lead de estágio',
    description: 'Solicita mudança de estágio no CRM e grava transição no Neo4j.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }, { getSession }) => {
      const leadId = payload?.leadId
      const to = payload?.to
      const rationale = payload?.rationale || ''
      const phone = String(leadId || '').replace(/\D/g, '')
      const r = await dispatchToCRM('move_lead', { phone, toStageId: to })
      const s = await getSession();
      try {
        await s.run(`
          MATCH (l:Lead { idWhatsapp: $id })
          WITH l, l.pipelineStage AS fromStage
          SET l.pipelineStage = $to, l.stageUpdatedAt = timestamp(), l.dtUltimaAtualizacao = timestamp()
          MERGE (st:PipelineStage { name: $to })
          CREATE (t:StageTransition { from: coalesce(fromStage,'Desconhecido'), to: $to, at: timestamp(), by: 'agent', rationale: $rationale })
          CREATE (l)-[:HAS_TRANSITION]->(t)
          CREATE (t)-[:TO_STAGE]->(st)
        `, { id: leadId, to, rationale })
      } finally { await s.close() }
      return r
    }
  },
  {
    id: 'tool.crm.addLead',
    name: 'Criar lead',
    description: 'Cria lead no CRM e registra no Neo4j.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }, { getSession }) => {
      const { name, phone, email, source, stage } = payload
      const r = await dispatchToCRM('create_lead', { name, phone: String(phone||'').replace(/\D/g, ''), email, source, status: stage || 'new' })
      const idWhatsapp = phone ? `${String(phone).replace(/\D/g,'')}@c.us` : null
      if (idWhatsapp) {
        const s = await getSession();
        try {
          await s.run(`MERGE (l:Lead { idWhatsapp: $id }) ON CREATE SET l.nome = $name, l.dtCriacao = timestamp(), l.dtUltimaAtualizacao = timestamp()`, { id: idWhatsapp, name: name || 'Lead' })
        } finally { await s.close() }
      }
      return r
    }
  },
  {
    id: 'tool.crm.addNote',
    name: 'Criar nota no CRM',
    description: 'Cria uma nota vinculada ao lead.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const { leadId, text, type, tags } = payload
      const phone = String(leadId || '').replace(/\D/g, '')
      return await dispatchToCRM('create_note', { phone, title: type || 'note', description: text, tags })
    }
  },
  {
    id: 'tool.crm.createDeal',
    name: 'Criar deal',
    description: 'Cria deal vinculado a um lead no CRM.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const { leadId, value, stage, title } = payload
      const phone = String(leadId || '').replace(/\D/g, '')
      return await dispatchToCRM('create_deal', { phone, value, stage, title })
    }
  },
  {
    id: 'tool.crm.updateTask',
    name: 'Atualizar tarefa CRM',
    description: 'Atualiza campos de uma tarefa existente no CRM.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const { taskId, text, due, status } = payload
      return await dispatchToCRM('update_task', { taskId, title: text, description: text, due_date: due, status })
    }
  },
  {
    id: 'tool.crm.completeTask',
    name: 'Concluir tarefa CRM',
    description: 'Marca uma tarefa como concluída no CRM.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const { taskId } = payload
      return await dispatchToCRM('complete_task', { taskId })
    }
  },
  {
    id: 'tool.crm.deleteTask',
    name: 'Remover tarefa CRM',
    description: 'Remove/arquiva uma tarefa no CRM.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const { taskId } = payload
      return await dispatchToCRM('delete_task', { taskId })
    }
  },
  {
    id: 'tool.crm.tagLead',
    name: 'Adicionar tags ao lead',
    description: 'Adiciona tags ao lead no CRM e Neo4j.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }, { getSession }) => {
      const { leadId, tags } = payload
      const phone = String(leadId || '').replace(/\D/g, '')
      const r = await dispatchToCRM('tag_lead', { phone, tags: Array.isArray(tags) ? tags : [] })
      const s = await getSession();
      try {
        if (Array.isArray(tags) && tags.length) {
          await s.run(`
            MATCH (l:Lead { idWhatsapp: $id })
            FOREACH (t IN $tags |
              MERGE (tg:Tag { nome: t })
              MERGE (l)-[:TEM_TAG]->(tg)
            )
            SET l.dtUltimaAtualizacao = timestamp()
          `, { id: leadId, tags })
        }
      } finally { await s.close() }
      return r
    }
  },
  {
    id: 'tool.crm.untagLead',
    name: 'Remover tags do lead',
    description: 'Remove tags do lead no CRM e Neo4j.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }, { getSession }) => {
      const { leadId, tags } = payload
      const phone = String(leadId || '').replace(/\D/g, '')
      const r = await dispatchToCRM('untag_lead', { phone, tags: Array.isArray(tags) ? tags : [] })
      const s = await getSession();
      try {
        if (Array.isArray(tags) && tags.length) {
          await s.run(`
            MATCH (l:Lead { idWhatsapp: $id })
            WITH l
            UNWIND $tags AS t
            MATCH (l)-[r:TEM_TAG]->(tg:Tag { nome: t })
            DELETE r
            SET l.dtUltimaAtualizacao = timestamp()
          `, { id: leadId, tags })
        }
      } finally { await s.close() }
      return r
    }
  },
  {
    id: 'tool.wa.sendWhatsApp',
    name: 'Enviar mensagem WhatsApp via WA Agent',
    description: 'Dispara mensagem via agente WhatsApp (RPC HTTP).',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const base = process.env.WA_AGENT_BASE_URL || 'http://localhost:3006'
      const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || ''
      const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`
      const fetch = (await import('node-fetch')).default
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key?{ 'X-Agent-Key': key }:{}) }, body: JSON.stringify({ name: 'send_message', payload }) })
      const js = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(js?.error || `http_${res.status}`)
      return js
    }
  },
  {
    id: 'tool.wa.sendTemplate',
    name: 'Enviar template WhatsApp via WA Agent',
    description: 'Dispara template via agente WhatsApp (RPC HTTP).',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const base = process.env.WA_AGENT_BASE_URL || 'http://localhost:3006'
      const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || ''
      const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`
      const fetch = (await import('node-fetch')).default
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key?{ 'X-Agent-Key': key }:{}) }, body: JSON.stringify({ name: 'send_template', payload }) })
      const js = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(js?.error || `http_${res.status}`)
      return js
    }
  },
  {
    id: 'tool.wa.generateFollowup',
    name: 'Gerar e enviar follow-up via WA Agent',
    description: 'Envia objetivo ao agente WhatsApp para gerar abordagem com LLM e enviar.',
    enabled: true,
    eventTypes: ['manual', 'agent_action'],
    threshold: DEFAULT_THRESHOLD,
    trigger: (ctx) => ({ shouldFire: true, confidence: 1.0, payload: ctx?.payload || {} }),
    action: async (_ctx, { payload }) => {
      const base = process.env.WA_AGENT_BASE_URL || 'http://localhost:3006'
      const key = process.env.WA_AGENT_KEY || process.env.CRM_AGENT_KEY || ''
      const url = `${String(base).replace(/\/$/, '')}/api/wa/dispatch`
      const fetch = (await import('node-fetch')).default
      const { leadId, objective, idempotencyKey, commandId, constraints, cta, abTest, lead, metadata } = payload
      const body = {
        commandId: commandId || `cmd_${Date.now()}`,
        name: 'generate_and_send',
        idempotencyKey: idempotencyKey || (leadId ? `idem_${String(leadId).replace(/\W/g,'')}_${Date.now()}` : undefined),
        lead: lead || { waJid: leadId },
        objective,
        constraints,
        cta,
        abTest: !!abTest,
        metadata
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key?{ 'X-Agent-Key': key }:{}) },
        body: JSON.stringify(body)
      })
      const js = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(js?.error || `http_${res.status}`)
      return js
    }
  }
];

module.exports = { TOOLS };


