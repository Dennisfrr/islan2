require('dotenv').config();
const wppconnect = require('@wppconnect-team/wppconnect');
const { v4: uuidv4 } = require('uuid'); // Para gerar IDs para hipóteses

const generativeAI_module = require("@google/generative-ai");
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } = generativeAI_module;

const { getSession, closeDriver, getDriver } = require('./db_neo4j'); // Supondo que este arquivo exista e funcione
const { handleDebouncedMessage } = require('./debounceHandler');
const { Planner } = require('./planner');
const neo4j = require('neo4j-driver');
const { dispatchToCRM, CRM_ORGANIZATION_ID } = require('./crmBridge');
const { ReflectiveAgent, ReflectionFocus } = require('./reflectiveAgent');
const { ReflectionAnalyticsTracker } = require('./reflectionAnalyticsTracker'); // Importa o Tracker
const { MetaReflexor } = require('./metaReflexor'); // Importa o MetaReflexor

// --- Configurações Globais ---
const SESSION_NAME = process.env.SESSION_NAME || 'wpp-consultor-neo4j';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NOME_DO_AGENTE = process.env.NOME_DO_AGENTE || "Leo Consultor";
const DELIMITER_MSG_BREAK = "||MSG_BREAK||";

const GEMINI_MODEL_NAME = "gemini-1.5-flash-latest";
const GEMINI_MAX_OUTPUT_TOKENS = 800;
const GEMINI_TEMPERATURE = 0.65;

const DEBOUNCE_DELAY_MS = 7500;
const MAX_TOOL_ITERATIONS = 5;

const debounceActiveForUser = new Map();
let globalReflectiveAgent;
let globalAnalyticsTracker; // Instância global do Tracker
let globalMetaReflexor; // Instância global do MetaReflexor

// Pequeno cache/debounce para reflexões por lead
const reflectionCache = new Map(); // leadId -> { signature: string, at: number }
function buildReflectionSignature(agentMsg, userMsg, plannerState, leadProfile) {
    const step = plannerState?.currentStep?.name || '';
    const plan = plannerState?.selectedPlanName || '';
    const lpv = [
        leadProfile?.nivelDeInteresseReuniao || '',
        (leadProfile?.principaisDores || []).slice(0,3).join('|'),
        (leadProfile?.tags || []).slice(0,3).join('|'),
    ].join('~');
    const text = [String(agentMsg||'').slice(0,200), String(userMsg||'').slice(0,200), step, plan, lpv].join('||');
    let h = 2166136261;
    for (let i=0; i<text.length; i++) { h ^= text.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return String(h >>> 0);
}
function shouldSkipReflection(leadId, signature, windowMs = 90 * 1000) {
    const prev = reflectionCache.get(leadId);
    if (!prev) return false;
    const recent = Date.now() - prev.at < windowMs;
    return recent && prev.signature === signature;
}
function markReflection(leadId, signature) {
    reflectionCache.set(leadId, { signature, at: Date.now() });
}

// =======================================================================================
//  INICIALIZAÇÃO DE MÓDULOS GLOBAIS
// =======================================================================================
if (!GEMINI_API_KEY) {
    console.error("!!! CRÍTICO: API Key do Gemini não configurada. Verifique a variável de ambiente GEMINI_API_KEY. Encerrando. !!!");
    process.exit(1);
}
if (!SchemaType || typeof SchemaType.OBJECT === 'undefined') {
    console.error("!!! CRÍTICO: SchemaType não foi carregado corretamente da biblioteca @google/generative-ai.");
    process.exit(1);
}

try {
    globalReflectiveAgent = new ReflectiveAgent(GEMINI_API_KEY);
    globalAnalyticsTracker = new ReflectionAnalyticsTracker();
    globalMetaReflexor = new MetaReflexor(globalAnalyticsTracker); // Instancia o MetaReflexor
    globalMetaReflexor.start(); // Inicia análise periódica
} catch (e) {
    console.error("!!! CRÍTICO: Falha ao instanciar ReflectiveAgent ou AnalyticsTracker. !!!", e);
    globalReflectiveAgent = null;
    globalAnalyticsTracker = null;
}

// =======================================================================================
//  DEFINIÇÃO DAS FERRAMENTAS
// =======================================================================================
const tools = [
    {
        name: "get_lead_profile",
        description: `Obtém o perfil completo e atualizado de um lead (cliente potencial) do banco de dados CRM (Neo4j). Use isso para entender o histórico, preferências, dores e interações passadas com o lead antes de formular uma resposta ou tomar uma decisão. Forneça o 'leadId' e 'leadName'.`,
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                leadId: { type: SchemaType.STRING, description: "O ID do WhatsApp do lead (ex: '55119XXXXXXXX@c.us')." },
                leadName: { type: SchemaType.STRING, description: "O nome do lead (ex: 'João Silva')." }
            },
            required: ["leadId", "leadName"]
        },
        execute: async ({ leadId, leadName }) => {
            console.log(`[Tool Execute] get_lead_profile para: ${leadName} (${leadId})`);
            try {
                const perfil = await carregarOuCriarPerfilLead(leadId, leadName);
                if (chatSessions[leadId] && perfil) {
                    chatSessions[leadId].perfil = perfil;
                }
                return perfil ? JSON.stringify(perfil) : JSON.stringify({ error: "Perfil não encontrado ou erro ao carregar." });
            } catch (error) {
                console.error(`[Tool Error] get_lead_profile:`, error);
                return JSON.stringify({ error: `Erro ao buscar perfil: ${error.message}` });
            }
        }
    },
    {
        name: "get_knowledge_schemas_for_pains",
        description: `Busca nos esquemas de conhecimento do Neo4j informações sobre Dores Comuns, Soluções Oferecidas pela empresa e Objeções Comuns relacionadas a uma lista de dores específicas mencionadas pelo lead. Use isso para embasar suas respostas sobre como a empresa pode ajudar. Forneça 'leadPainPointsArray', um array de strings com as dores.`,
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                leadPainPointsArray: {
                    type: SchemaType.ARRAY,
                    items: { type: SchemaType.STRING },
                    description: "Um array de strings, onde cada string é uma dor ou problema mencionado pelo lead (ex: ['Baixa Geração de Leads', 'Processos Manuais Lentos'])."
                }
            },
            required: ["leadPainPointsArray"]
        },
        execute: async ({ leadPainPointsArray }) => {
            console.log(`[Tool Execute] get_knowledge_schemas_for_pains para dores: ${leadPainPointsArray.join(', ')}`);
            if (!leadPainPointsArray || leadPainPointsArray.length === 0) {
                return JSON.stringify({ info: "Nenhuma dor fornecida para buscar esquemas." });
            }
            try {
                const esquemas = await buscarEsquemasDeConhecimento(leadPainPointsArray);
                return esquemas ? JSON.stringify(esquemas) : JSON.stringify({ info: "Nenhum esquema de conhecimento encontrado para as dores fornecidas." });
            } catch (error) {
                console.error(`[Tool Error] get_knowledge_schemas_for_pains:`, error);
                return JSON.stringify({ error: `Erro ao buscar esquemas de conhecimento: ${error.message}` });
            }
        }
    },
    {
        name: "analyze_and_update_lead_profile",
        description: `Analisa o histórico recente da conversa e o perfil conceitual atual de um lead para extrair e atualizar informações como nome do negócio, tipo de negócio, principais dores, interesses, soluções discutidas, nível de interesse em reunião, resumo da situação, notas e tags. Use esta ferramenta APÓS interações significativas ou quando sentir que novas informações importantes sobre o lead foram reveladas e precisam ser persistidas no CRM. Forneça 'leadId', 'fullChatHistoryArray' (array de objetos de mensagens) e 'currentConceptualProfileObject'.`,
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                leadId: { type: SchemaType.STRING, description: "O ID do WhatsApp do lead." },
                fullChatHistoryArray: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            role: { type: SchemaType.STRING, description: "'user' ou 'model'" },
                            parts: {
                                type: SchemaType.ARRAY,
                                items: {
                                    type: SchemaType.OBJECT,
                                    properties: {
                                        text: { type: SchemaType.STRING, description: "Conteúdo textual da mensagem" }
                                    },
                                }
                            }
                        }
                    },
                    description: "O histórico completo da conversa atual com o lead."
                },
                currentConceptualProfileObject: {
                    type: SchemaType.OBJECT,
                    description: "O objeto JSON do perfil conceitual atual do lead, antes desta análise."
                }
            },
            required: ["leadId", "fullChatHistoryArray", "currentConceptualProfileObject"]
        },
        execute: async ({ leadId, fullChatHistoryArray, currentConceptualProfileObject }) => {
            console.log(`[Tool Execute] analyze_and_update_lead_profile para: ${leadId}`);
            try {
                const perfilTotalmenteAtualizado = await analisarEAtualizarPerfil(
                    leadId,
                    fullChatHistoryArray,
                    currentConceptualProfileObject
                );

                if (perfilTotalmenteAtualizado) {
                    if (chatSessions[leadId]) {
                        chatSessions[leadId].perfil = perfilTotalmenteAtualizado;
                        console.log(`[Tool Execute - analyze_and_update_lead_profile] Perfil na sessão de ${leadId} atualizado.`);

                        if (chatSessions[leadId].planner && chatSessions[leadId].planner.status === "active") {
                            console.log(`[Tool Execute - analyze_and_update_lead_profile] Verificando progresso do planner para ${leadId}.`);
                            chatSessions[leadId].planner.checkAndUpdateProgress(perfilTotalmenteAtualizado);
                        }
                    }
                    // Best-effort notify CRM intents with updated profile fields
                    try {
                        const phone = String(leadId || '').replace(/\D/g, '');
                        const p = perfilTotalmenteAtualizado || {};
                        try {
                            await dispatchToCRM('update_lead', {
                                phone,
                                organization_id: CRM_ORGANIZATION_ID || undefined,
                                name: p.nomeDoLead || p.name || undefined,
                                company: p.nomeDoNegocio || p.businessName || undefined,
                                status: undefined,
                                notes: p.ultimoResumoDaSituacao || undefined,
                                tags: Array.isArray(p.tags) ? p.tags : undefined,
                                value: undefined,
                            });
                            // Golden Note: resumo da situação
                            try {
                                const title = 'Dado de Ouro — Resumo atualizado';
                                const description = (p.ultimoResumoDaSituacao || p.lastSummary || '').toString().slice(0, 1200) || '—';
                                await dispatchToCRM('create_note', {
                                    phone,
                                    title,
                                    description,
                                    organization_id: CRM_ORGANIZATION_ID || undefined,
                                }, { idempotencyKey: `gold-note-profile-${phone}-${Buffer.from(description).toString('base64').slice(0,32)}` });
                                // Follow-up Task: próximo passo da reflexão/perfil, se houver
                                const nextStep = (typeof p.proximoPassoLogicoSugerido === 'string' && p.proximoPassoLogicoSugerido)
                                  || (typeof p.nextStep === 'string' && p.nextStep)
                                  || null;
                                if (nextStep) {
                                  const due = new Date(Date.now() + 24*60*60*1000).toISOString();
                                  await dispatchToCRM('create_task', {
                                    phone,
                                    title: nextStep,
                                    description: 'Gerado automaticamente após atualização de perfil.',
                                    due_date: due,
                                    organization_id: CRM_ORGANIZATION_ID || undefined,
                                  }, { idempotencyKey: `auto-task-profile-${phone}-${Buffer.from(nextStep).toString('base64').slice(0,24)}` });
                                }
                                // Oportunidade: menção a orçamento/prazo no resumo → alerta quente
                                const lower = description.toLowerCase()
                                if (/orcamento|orçamento|budget|prazo|deadline|cotação|cotacao/i.test(lower)) {
                                  try {
                                    await dispatchToCRM('create_note', {
                                      phone,
                                      title: 'Alerta de Oportunidade — Janela Quente',
                                      description: 'Resumo menciona orçamento/prazo. Priorize este lead.',
                                      organization_id: CRM_ORGANIZATION_ID || undefined,
                                    }, { idempotencyKey: `hot-window-${phone}` })
                                    const due = new Date(Date.now() + 12*60*60*1000).toISOString()
                                    await dispatchToCRM('create_task', {
                                      phone,
                                      title: 'Priorizar contato — janela quente',
                                      description: 'Responder em até 12h com proposta/ajuste.',
                                      due_date: due,
                                      organization_id: CRM_ORGANIZATION_ID || undefined,
                                    }, { idempotencyKey: `hot-window-task-${phone}` })
                                  } catch {}
                                }
                                // Decisor identificado (cargo/poder de decisão)
                                if (/(\bceo\b|\bcfo\b|\bcto\b|diretor|decisor|sou eu quem decide|eu aprovo|head\b)/i.test(lower)) {
                                  try {
                                    await dispatchToCRM('create_note', {
                                      phone,
                                      title: 'Dado de Ouro — Decisor identificado',
                                      description: 'Perfil/resumo indica decisor ou autoridade de compra.',
                                      organization_id: CRM_ORGANIZATION_ID || undefined,
                                    }, { idempotencyKey: `gold-decisor-${phone}` })
                                  } catch {}
                                }
                                // Risco: sem resposta recente (se perfil trouxer lastInteraction)
                                const lastInteraction = p.lastInteraction || p.dtUltimaAtualizacao || null
                                if (lastInteraction) {
                                  try {
                                    const diff = Date.now() - Date.parse(String(lastInteraction))
                                    if (diff > 5*24*60*60*1000) {
                                      await dispatchToCRM('create_note', {
                                        phone,
                                        title: 'Alerta de Risco — Sem resposta',
                                        description: 'Lead sem interação recente (>5 dias). Agendar follow-up.',
                                        organization_id: CRM_ORGANIZATION_ID || undefined,
                                      }, { idempotencyKey: `risk-stale-${phone}` })
                                      const due = new Date(Date.now() + 24*60*60*1000).toISOString()
                                      await dispatchToCRM('create_task', {
                                        phone,
                                        title: 'Follow-up — lead estagnado',
                                        description: 'Enviar mensagem curta de retomada e valor.',
                                        due_date: due,
                                        organization_id: CRM_ORGANIZATION_ID || undefined,
                                      }, { idempotencyKey: `risk-stale-task-${phone}` })
                                    }
                                  } catch {}
                                }
                            } catch (eNote) { console.warn('[index] create_note(profile) failed:', eNote?.message || eNote) }
                        } catch (eUpd) {
                            const msg = String(eUpd?.message || eUpd || '').toLowerCase();
                            if (msg.includes('lead_not_found') || msg.includes('404')) {
                                try {
                                    await dispatchToCRM('create_lead', {
                                        name: p.nomeDoLead || p.name || 'Lead',
                                        company: p.nomeDoNegocio || p.businessName || '—',
                                        phone,
                                        organization_id: CRM_ORGANIZATION_ID || undefined,
                                        status: 'new',
                                        source: 'whatsapp-agent'
                                    });
                                    // Note mesmo após criar
                                    try {
                                        const title = 'Dado de Ouro — Resumo atualizado';
                                        const description = (p.ultimoResumoDaSituacao || p.lastSummary || '').toString().slice(0, 1200) || '—';
                                        await dispatchToCRM('create_note', { phone, title, description, organization_id: CRM_ORGANIZATION_ID || undefined }, { idempotencyKey: `gold-note-profile-${phone}-${Buffer.from(description).toString('base64').slice(0,32)}` });
                                    } catch {}
                                } catch (eCreate) {
                                    console.warn('[index] create_lead failed:', eCreate?.message || eCreate);
                                }
                            } else {
                                throw eUpd;
                            }
                        }
                    } catch (e) {
                        console.warn('[index] dispatch update_lead failed:', e?.message || e);
                    }
                    return JSON.stringify({ success: true, message: "Perfil analisado e atualizado no CRM e na sessão.", updatedProfile: perfilTotalmenteAtualizado });
                } else {
                    console.error(`[Tool Error - analyze_and_update_lead_profile] A função interna analisarEAtualizarPerfil não retornou um perfil para ${leadId}.`);
                    return JSON.stringify({ success: false, error: "Erro interno ao analisar ou atualizar perfil. Perfil não retornado." });
                }
            } catch (error) {
                console.error(`[Tool Error - analyze_and_update_lead_profile] Falha crítica na execução da ferramenta para ${leadId}:`, error);
                return JSON.stringify({ success: false, error: `Erro na ferramenta analyze_and_update_lead_profile: ${error.message}` });
            }
        }
    },
    {
        name: "get_relevant_case_studies_or_social_proof",
        description: "Busca no banco de dados de conhecimento (Neo4j) por estudos de caso, depoimentos ou outras provas sociais relevantes para um tópico específico, dor do lead ou solução discutida. Use isso quando o lead parecer cético, hesitante, pedir exemplos concretos ou quando uma prova social fortaleceria seu argumento.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                topicOrPainOrSolution: { type: SchemaType.STRING, description: "O tópico, dor, produto, serviço ou solução específica para a qual a prova social é necessária (ex: 'Baixa Geração de Leads', 'Automação de Processos com IA')." },
                leadBusinessType: { type: SchemaType.STRING, description: "(Opcional) O tipo de negócio do lead (ex: 'Varejo', 'Tecnologia') para encontrar casos mais direcionados." }
            },
            required: ["topicOrPainOrSolution"]
        },
        execute: async ({ topicOrPainOrSolution, leadBusinessType }) => {
            console.log(`[Tool Execute] get_relevant_case_studies_or_social_proof para Tópico: ${topicOrPainOrSolution}, Tipo de Negócio do Lead: ${leadBusinessType || 'N/A'}`);
            let neo4jSession;
            try {
                neo4jSession = await getSession();
                const searchTerm = String(topicOrPainOrSolution).toLowerCase();
                const businessTypeTerm = leadBusinessType ? String(leadBusinessType).toLowerCase() : null;

                const query = `
                    MATCH (kn)
                    WHERE (kn:DorComum OR kn:SolucaoOferecida OR kn:KnowledgeTopic)
                      AND (
                           toLower(kn.name) CONTAINS $searchTerm
                           OR ($searchTerm IN kn.keywords) 
                           OR ($searchTerm IN kn.tags) 
                           OR (kn.descricao IS NOT NULL AND toLower(kn.descricao) CONTAINS $searchTerm)
                          )
                    WITH kn
                    MATCH (sp:SocialProof)-[:ADDRESSES_PAIN|SHOWCASES_SOLUTION|RELATES_TO_TOPIC]->(kn)
                    OPTIONAL MATCH (sp)-[:TARGETS_INDUSTRY]->(i:Industry)
                    WITH sp, i, kn,
                         CASE
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NOT NULL AND toLower(i.name) CONTAINS $businessTypeTerm THEN 2
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NOT NULL AND NOT (toLower(i.name) CONTAINS $businessTypeTerm) THEN 0
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NULL THEN 1 
                            ELSE 1 
                         END AS industryScore
                    WHERE industryScore > 0
                    RETURN
                        sp.type AS type,
                        sp.summary AS content,
                        sp.detailsUrl AS detailsUrl,
                        CASE WHEN i IS NOT NULL AND industryScore = 2 THEN i.name ELSE "geral" END AS industry_match,
                        kn.name AS related_knowledge_node_name,
                        true AS found
                    ORDER BY industryScore DESC, rand() 
                    LIMIT 1
                `;

                let result = await neo4jSession.run(query, { searchTerm, businessTypeTerm });

                if (result.records.length > 0) {
                    const record = result.records[0];
                    console.log(`[Neo4j SocialProof] Encontrado via nó de conhecimento: ${record.get('related_knowledge_node_name')}`);
                    return JSON.stringify({
                        found: true,
                        type: record.get('type'),
                        content: record.get('content'),
                        details_available_on_request: !!record.get('detailsUrl'),
                        related_to_topic: topicOrPainOrSolution,
                        industry_match: record.get('industry_match')
                    });
                }

                console.log(`[Neo4j SocialProof] Nenhum resultado via nós de conhecimento. Tentando fallback direto em SocialProof...`);
                const fallbackQuery = `
                    MATCH (sp:SocialProof)
                    WHERE toLower(sp.summary) CONTAINS $searchTerm
                       OR ($searchTerm IN sp.keywords) 
                    OPTIONAL MATCH (sp)-[:TARGETS_INDUSTRY]->(i:Industry)
                    WITH sp, i,
                         CASE
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NOT NULL AND toLower(i.name) CONTAINS $businessTypeTerm THEN 2
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NOT NULL AND NOT (toLower(i.name) CONTAINS $businessTypeTerm) THEN 0
                            WHEN $businessTypeTerm IS NOT NULL AND i IS NULL THEN 1
                            ELSE 1
                         END AS industryScore
                    WHERE industryScore > 0
                    RETURN
                        sp.type AS type,
                        sp.summary AS content,
                        sp.detailsUrl AS detailsUrl,
                        CASE WHEN i IS NOT NULL AND industryScore = 2 THEN i.name ELSE "geral" END AS industry_match,
                        true AS found
                    ORDER BY industryScore DESC, rand()
                    LIMIT 1
                `;
                result = await neo4jSession.run(fallbackQuery, { searchTerm, businessTypeTerm });

                if (result.records.length > 0) {
                    const record = result.records[0];
                    console.log(`[Neo4j SocialProof] Encontrado via fallback direto.`);
                    return JSON.stringify({
                        found: true,
                        type: record.get('type'),
                        content: record.get('content'),
                        details_available_on_request: !!record.get('detailsUrl'),
                        related_to_topic: topicOrPainOrSolution,
                        industry_match: record.get('industry_match')
                    });
                }
                
                console.log(`[Neo4j SocialProof] Nenhuma prova social encontrada para: ${topicOrPainOrSolution}`);
                return JSON.stringify({
                    found: false,
                    message: `No momento, não tenho um estudo de caso ou depoimento específico para '${topicOrPainOrSolution}' ${businessTypeTerm ? 'no setor de ' + leadBusinessType : ''}. No entanto, posso explicar os benefícios gerais ou como abordagens semelhantes funcionaram em outros contextos.`,
                    related_to_topic: topicOrPainOrSolution
                });

            } catch (error) {
                console.error(`[Tool Error] get_relevant_case_studies_or_social_proof:`, error);
                return JSON.stringify({ found: false, error: `Erro ao buscar prova social: ${error.message}`, related_to_topic: topicOrPainOrSolution });
            } finally {
                if (neo4jSession) {
                    await neo4jSession.close();
                }
            }
        }
    }
];

const toolDefinitions = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
}));

const toolExecutors = tools.reduce((acc, tool) => {
    acc[tool.name] = tool.execute;
    return acc;
}, {});


// =======================================================================================
// SYSTEM INSTRUCTION BASE DO AGENTE
// =======================================================================================
const system_instruction_agente_base = `
<prompt_agente_consultivo_com_ferramentas_e_adaptacao>
  <persona_e_objetivo>
    <nome_agente>${NOME_DO_AGENTE}</nome_agente>
    <papel>Você é ${NOME_DO_AGENTE}, um consultor estratégico de otimização de processos altamente inteligente, proativo e adaptável. Seu objetivo principal é engajar leads (clientes potenciais) em conversas consultivas via WhatsApp, identificar profundamente suas dores e desafios operacionais, construir valor mostrando entendimento e potenciais caminhos, e, no momento oportuno, propor uma reunião como próximo passo lógico.</papel>
    <objetivo_conversa>Ajudar o lead a resolver seus problemas, usando suas ferramentas, conhecimento e capacidade de adaptação para fornecer a melhor assistência possível. A venda ou agendamento de reunião é uma consequência de um bom atendimento e da identificação de uma necessidade real.</objetivo_conversa>
  </persona_e_objetivo>

  <instrucoes_de_raciocinio_e_uso_de_ferramentas>
    <instrucao_geral>Você tem acesso a um conjunto de ferramentas para obter informações e realizar ações. Pense passo a passo. Antes de responder ao usuário, considere se usar uma ferramenta pode te ajudar a obter informações mais precisas ou a realizar uma tarefa solicitada. CONSIDERE SEMPRE AS ORIENTAÇÕES DO PLANNER ESTRATÉGICO, se fornecidas, para guiar suas ações e objetivos de curto prazo.</instrucao_geral>
    <ciclo_pensamento_acao>
      1.  **PENSAMENTO (Thought):**
          a.  Analise a mensagem do usuário, o histórico da conversa, O PERFIL ATUAL DO LEAD (se disponível) E AS ORIENTAÇÕES DO PLANNER ESTRATÉGICO (se disponíveis).
          b.  **AVALIE O SENTIMENTO E A INTENÇÃO DO LEAD:** O lead parece cético, confuso, interessado, apressado, técnico, frustrado? Qual o objetivo principal da mensagem dele?
          c.  Decida qual é o seu objetivo para a próxima resposta (ex: esclarecer dúvida, aprofundar na dor, construir valor, pedir mais informações, propor reunião, etc.), alinhado com a etapa atual do PLANNER.
          d.  Com base no sentimento/intenção, no seu objetivo e na orientação do PLANNER, determine se alguma ferramenta pode te ajudar.
          e.  Se sim, escolha a ferramenta e determine os parâmetros. Se o lead parecer cético ou pedir exemplos, e o PLANNER indicar, considere fortemente usar "get_relevant_case_studies_or_social_proof".
      2.  **AÇÃO (Action - Use Tool):** Se decidir usar uma ferramenta, indique-a claramente com os argumentos JSON corretos. O sistema executará e fornecerá o resultado. Não invente ferramentas. Exemplo de chamada de ferramenta: \`\`\`json { "functionCall": { "name": "nome_da_ferramenta", "args": { "parametro1": "valor1" } } } \`\`\`
      3.  **OBSERVAÇÃO (Observation - Function Response):** Após a chamada da função, você receberá o resultado.
      4.  **NOVO PENSAMENTO:** Use essa observação para continuar seu raciocínio e decidir o próximo passo: responder ao usuário ou usar outra ferramenta, sempre verificando se a ação ajudou a progredir na etapa do PLANNER.
    </ciclo_pensamento_acao>
    <quando_responder_diretamente>Se você tiver informações suficientes, ou se já usou as ferramentas necessárias, formule uma resposta direta para o usuário, adaptando seu estilo e profundidade conforme o sentimento/intenção que você inferiu e as diretrizes do PLANNER.</quando_responder_diretamente>
    
    <formato_resposta_final_usuario_IMPORTANTE>
        <instrucao>AO FORMULAR SUA RESPOSTA FINAL PARA O USUÁRIO, NUNCA, JAMAIS inclua os termos "PENSAMENTO (Thought):", "AÇÃO (Action - Use Tool):", "OBSERVAÇÃO (Observation - Function Response):" ou qualquer parte do seu ciclo de raciocínio interno ou chamadas de função JSON.</instrucao>
        <instrucao>Sua resposta final deve ser apenas o texto que o usuário deve ler, formatado conforme as <instrucoes_gerais_de_estilo_e_tamanho_para_respostas_ao_usuario>.</instrucao>
        <instrucao>O ciclo de PENSAMENTO-AÇÃO-OBSERVAÇÃO é para seu processo interno. O usuário SÓ DEVE VER a mensagem final resultante desse processo.</instrucao>
    </formato_resposta_final_usuario_IMPORTANTE>

    <uso_de_perfil_e_esquemas>
      <ferramenta_perfil>Use "get_lead_profile" no início ou para contexto atualizado sobre o lead ([Nome do Lead], id: [ID do Lead]). O resultado desta ferramenta atualiza o perfil na sessão, que é usado pelo PLANNER.</ferramenta_perfil>
      <ferramenta_esquemas>Se o lead mencionar dores, use "get_knowledge_schemas_for_pains" para buscar soluções.</ferramenta_esquemas>
      <ferramenta_analise_perfil>Após interações significativas, use "analyze_and_update_lead_profile" para atualizar o CRM. O resultado desta ferramenta é CRUCIAL para o PLANNER avaliar o progresso. Pergunte-se: "O perfil do lead precisa ser atualizado para que o PLANNER possa verificar a conclusão da etapa atual?"</ferramenta_analise_perfil>
      <ferramenta_prova_social_nova>NOVO: Use "get_relevant_case_studies_or_social_proof" quando o lead parecer cético, pedir exemplos concretos, ou se você julgar que uma prova social (estudo de caso, depoimento) fortaleceria sua argumentação sobre uma dor, solução ou tópico, especialmente se o PLANNER sugerir.</ferramenta_prova_social_nova>
    </uso_de_perfil_e_esquemas>
    <adaptacao_dinamica_da_conversa_IMPORTANTE>
        <instrucao>Com base na sua avaliação do sentimento e intenção do lead (item 1b do ciclo de pensamento) E NAS ORIENTAÇÕES DO PLANNER:</instrucao>
        <item_adaptacao>Se o lead parecer **técnico ou muito detalhista**, você pode se aprofundar um pouco mais nos aspectos técnicos das soluções ou fazer perguntas mais específicas. Não simplifique demais.</item_adaptacao>
        <item_adaptacao>Se o lead parecer **apressado ou muito direto**, seja mais conciso e vá direto ao ponto. Evite explanações longas se não solicitadas.</item_adaptacao>
        <item_adaptacao>Se o lead parecer **cético ou hesitante**, seja mais empático, valide as preocupações dele e considere ativamente usar a ferramenta "get_relevant_case_studies_or_social_proof" para oferecer exemplos concretos e construir confiança.</item_adaptacao>
        <item_adaptacao>Se o lead parecer **confuso ou inseguro**, simplifique a linguagem, ofereça explicações claras e talvez divida informações complexas em partes menores. Faça perguntas para garantir o entendimento.</item_adaptacao>
        <item_adaptacao>Se o lead parecer **frustrado ou irritado**, demonstre empatia de forma genuína, reconheça a frustração e foque em como você pode ajudar a resolver o problema. Evite ser defensivo.</item_adaptacao>
        <item_adaptacao>Se o lead parecer **entusiasmado ou muito engajado**, espelhe esse entusiasmo (com moderação) e aproveite para aprofundar nos pontos de interesse dele.</item_adaptacao>
        <instrucao_geral_adaptacao>Seu objetivo é criar uma conversa que pareça o mais natural e personalizada possível para aquele lead específico naquele momento. Não siga rigidamente um script se a situação pedir uma abordagem diferente. O fluxo de etapas da conversa (e do PLANNER) é um guia, não uma regra inflexível.</instrucao_geral_adaptacao>
    </adaptacao_dinamica_da_conversa_IMPORTANTE>
    <multiplas_ferramentas>Você pode precisar usar múltiplas ferramentas em sequência.</multiplas_ferramentas>
    <tratamento_de_erros_ferramentas>Se uma ferramenta retornar um erro, analise e decida como proceder.</tratamento_de_erros_ferramentas>
  </instrucoes_de_raciocinio_e_uso_de_ferramentas>

  <instrucoes_gerais_de_estilo_e_tamanho_para_respostas_ao_usuario>
    <instrucao>PRIORIDADE MÁXIMA: Suas respostas DIRETAS AO USUÁRIO DEVEM ser CURTAS e CONCISAS, ideais para leitura rápida no WhatsApp.</instrucao>
    <instrucao_nova_quebra_mensagem>
      QUEBRA DE MENSAGENS LONGAS (OBRIGATÓRIO E CRÍTICO PARA WHATSAPP): Sua principal prioridade na formatação da resposta é evitar mensagens longas.
      VOCÊ DEVE OBRIGATORIAMENTE USAR o delimitador "${DELIMITER_MSG_BREAK}" para dividir suas respostas em múltiplos balões de mensagem.
      CONDIÇÕES PARA USAR O DELIMITER:
      1.  Se a resposta total tiver MAIS DE 160 caracteres.
      2.  Se a resposta contiver 3 OU MAIS frases.
      3.  Se estiver apresentando uma lista, múltiplos pontos ou fazendo várias perguntas.
      REGRAS PARA CADA PARTE APÓS A QUEBRA:
      -   CADA PARTE INDIVIDUAL gerada pela quebra (entre os delimitadores "${DELIMITER_MSG_BREAK}") NÃO PODE EXCEDER, IDEALMENTE, 150 caracteres e, NO MÁXIMO ABSOLUTO, 200 caracteres.
      -   CADA PARTE INDIVIDUAL DEVE fazer sentido por si só.
      -   Priorize quebras no final de frases ou em pausas naturais.
      EXCEÇÃO: Se a resposta COMPLETA for EXTREMAMENTE CURTA (ex: uma única frase pequena, menos de 100 caracteres), você PODE omitir o delimitador.
      FALHAR EM QUEBRAR MENSAGENS LONGAS CORRETAMENTE É UM ERRO GRAVE. Revise suas respostas para garantir que esta regra está sendo seguida.
    </instrucao_nova_quebra_mensagem>
    <instrucao>Use emojis com EXTREMA MODERAÇÃO. Na saudação inicial "Formal Frio", NÃO use emojis. Em etapas posteriores, apenas se adicionar valor real à comunicação empática, especialmente se o lead usar emojis ou tiver um tom mais informal.</instrucao>
    <instrucao>FLUIDEZ E NATURALIDADE: Mesmo com tons definidos e adaptações, busque uma comunicação que não soe excessivamente rígida ou como um script decorado.</instrucao>
    <instrucao_nova>Você pode receber mensagens tanto em formato de texto quanto de áudio. Processe o conteúdo da mensagem do lead independentemente do formato. Se for um áudio, o conteúdo estará nele. Se múltiplas mensagens forem agregadas (texto ou áudio), o conteúdo combinado será fornecido.</instrucao_nova>
  </instrucoes_gerais_de_estilo_e_tamanho_para_respostas_ao_usuario>

  <persona_detalhada_e_fluxo_conversacional_herdado>
    </persona_detalhada_e_fluxo_conversacional_herdado>
</prompt_agente_consultivo_com_ferramentas_e_adaptacao>
`;
// =======================================================================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

const modelWithTools = genAI.getGenerativeModel({
    model: GEMINI_MODEL_NAME,
    safetySettings,
    systemInstruction: { parts: [{text: system_instruction_agente_base}], role: "system" },
    tools: [{ functionDeclarations: toolDefinitions }]
});

const generationConfig = {
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    temperature: GEMINI_TEMPERATURE,
};

// Estrutura da sessão:
// chatSessions[userId] = {
//   chat: ChatSession, // Sessão de chat com a LLM principal
//   lastActivity: number,
//   perfil: object, // Perfil do lead
//   planner: Planner | null, // Instância do Planner para este lead
//   lastUserMessageText: string | null, // Última mensagem do utilizador (para reflexão)
//   reflectionHistory: Array<object>, // Array das últimas N reflexões
//   activeHypotheses: Array<object> // Array de hipóteses ativas sobre o lead
// }
const chatSessions = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- FUNÇÕES DE INTERAÇÃO COM NEO4J PARA PERFIL ---
async function carregarOuCriarPerfilLead(userId, userName) {
    const neo4jSession = await getSession();
    let perfil = {
        idWhatsapp: userId,
        nomeDoLead: userName,
        nomeDoNegocio: null,
        tipoDeNegocio: null,
        principaisDores: [],
        interessesEspecificos: [],
        solucoesJaDiscutidas: [],
        nivelDeInteresseReuniao: "inicial",
        ultimoResumoDaSituacao: "Início da conversa.",
        notasAdicionais: [],
        tags: [],
        historicoDeInteracaoResumido: [],
        activeHypotheses: [] 
    };
    try {
        const result = await neo4jSession.run(
            `MERGE (l:Lead {idWhatsapp: $userId})
             ON CREATE SET 
                l.nome = $userName, 
                l.dtCriacao = timestamp(), 
                l.nivelDeInteresseReuniao = "inicial", 
                l.ultimoResumoDaSituacao = "Início da conversa.",
                l.tags = [], 
                l.activeHypotheses = []
             ON MATCH SET 
                l.nome = $userName
             RETURN l.idWhatsapp AS idWhatsapp, l.nome AS nome, l.nomeDoNegocio AS nomeDoNegocio,
                    l.tipoDeNegocio AS tipoDeNegocio, l.nivelDeInteresseReuniao AS nivelDeInteresseReuniao,
                    l.ultimoResumoDaSituacao AS ultimoResumoDaSituacao, l.tags AS tags,
                    l.activeHypotheses AS activeHypotheses,
                    l.emotionalState AS emotionalState, l.emotionalConfidence AS emotionalConfidence,
                    l.decisionProfile AS decisionProfile, l.decisionProfileSecondary AS decisionProfileSecondary,
                    l.precallSummary AS precallSummary, l.precallQuestions AS precallQuestions`,
            { userId, userName }
        );
        if (result.records.length > 0) {
            const record = result.records[0];
            perfil.nomeDoLead = record.get('nome');
            perfil.nomeDoNegocio = record.get('nomeDoNegocio');
            perfil.tipoDeNegocio = record.get('tipoDeNegocio');
            perfil.nivelDeInteresseReuniao = record.get('nivelDeInteresseReuniao');
            perfil.ultimoResumoDaSituacao = record.get('ultimoResumoDaSituacao');
            perfil.tags = record.get('tags') || [];
            perfil.activeHypotheses = record.get('activeHypotheses') || [];
            perfil.emotionalState = record.get('emotionalState') || null;
            perfil.emotionalConfidence = record.get('emotionalConfidence') ?? null;
            perfil.decisionProfile = record.get('decisionProfile') || null;
            perfil.decisionProfileSecondary = record.get('decisionProfileSecondary') || null;
            perfil.precallSummary = record.get('precallSummary') || null;
            perfil.precallQuestions = record.get('precallQuestions') || [];

            const doresResult = await neo4jSession.run('MATCH (l:Lead {idWhatsapp: $userId})-[:TEM_DOR]->(d:Dor) RETURN d.nome AS nomeDor', { userId });
            perfil.principaisDores = doresResult.records.map(r => r.get('nomeDor'));
            const interessesResult = await neo4jSession.run('MATCH (l:Lead {idWhatsapp: $userId})-[:TEM_INTERESSE]->(i:Interesse) RETURN i.nome AS nomeInteresse', { userId });
            perfil.interessesEspecificos = interessesResult.records.map(r => r.get('nomeInteresse'));
            const solucoesResult = await neo4jSession.run('MATCH (l:Lead {idWhatsapp: $userId})-[:DISCUTIU_SOLUCAO]->(s:Solucao) RETURN s.nome AS nomeSolucao', { userId });
            perfil.solucoesJaDiscutidas = solucoesResult.records.map(r => r.get('nomeSolucao'));
            const notasResult = await neo4jSession.run('MATCH (l:Lead {idWhatsapp: $userId}) RETURN l.notasAdicionais AS notas', { userId });
            if (notasResult.records.length > 0 && notasResult.records[0].get('notas')) perfil.notasAdicionais = notasResult.records[0].get('notas');
            const histResult = await neo4jSession.run('MATCH (l:Lead {idWhatsapp: $userId}) RETURN l.historicoDeInteracaoResumido AS historico', { userId });
            if (histResult.records.length > 0 && histResult.records[0].get('historico')) perfil.historicoDeInteracaoResumido = histResult.records[0].get('historico');
            
            console.log(`[Neo4j Perfil] Perfil para ${userName} (ID: ${userId}). Tipo Neg: ${perfil.tipoDeNegocio}. Tags: ${perfil.tags.join(', ')}. Hipóteses: ${perfil.activeHypotheses.length}`);
        }
    } catch (error) {
        console.error(`[Neo4j Perfil] Erro ao carregar/criar perfil para ${userId}:`, error);
    } finally {
        if (neo4jSession) await neo4jSession.close();
    }
    return perfil;
}

async function salvarOuAtualizarArrayDeNosRelacionados(neo4jSession, userId, leadPropertyArray, nodeLabel, relationshipType) {
    // Remove relações existentes para este tipo
    await neo4jSession.run(
        `MATCH (l:Lead {idWhatsapp: $userId})-[r:${relationshipType}]->(n:${nodeLabel}) DELETE r`,
        { userId }
    );
    // Cria novas relações se houver itens no array
    if (leadPropertyArray && leadPropertyArray.length > 0) {
        for (const itemName of leadPropertyArray) {
            if (itemName && String(itemName).trim() !== "") { // Garante que não é nulo ou string vazia
                await neo4jSession.run(
                    `MATCH (l:Lead {idWhatsapp: $userId})
                     MERGE (n:${nodeLabel} {name: $itemName})
                     MERGE (l)-[:${relationshipType}]->(n)`,
                    { userId, itemName: String(itemName).trim() }
                );
            }
        }
    }
}

async function salvarPerfilLead(userId, perfil) {
    const neo4jSession = await getSession();
    try {
        await neo4jSession.run(
            `MATCH (l:Lead {idWhatsapp: $userId})
             SET l.nome = $nomeDoLead, l.nomeDoNegocio = $nomeDoNegocio, l.tipoDeNegocio = $tipoDeNegocio,
                 l.nivelDeInteresseReuniao = $nivelDeInteresseReuniao, l.ultimoResumoDaSituacao = $ultimoResumoDaSituacao,
                 l.notasAdicionais = $notasAdicionais, l.historicoDeInteracaoResumido = $historicoDeInteracaoResumido,
                 l.tags = $tags,
                 l.activeHypotheses = $activeHypotheses,
                 l.dtUltimaAtualizacao = timestamp()`,
            {
                userId,
                nomeDoLead: perfil.nomeDoLead,
                nomeDoNegocio: perfil.nomeDoNegocio,
                tipoDeNegocio: perfil.tipoDeNegocio,
                nivelDeInteresseReuniao: perfil.nivelDeInteresseReuniao,
                ultimoResumoDaSituacao: perfil.ultimoResumoDaSituacao,
                notasAdicionais: perfil.notasAdicionais || [],
                historicoDeInteracaoResumido: perfil.historicoDeInteracaoResumido || [],
                tags: perfil.tags || [],
                activeHypotheses: perfil.activeHypotheses || [] 
            }
        );
        await salvarOuAtualizarArrayDeNosRelacionados(neo4jSession, userId, perfil.principaisDores, 'Dor', 'TEM_DOR');
        await salvarOuAtualizarArrayDeNosRelacionados(neo4jSession, userId, perfil.interessesEspecificos, 'Interesse', 'TEM_INTERESSE');
        await salvarOuAtualizarArrayDeNosRelacionados(neo4jSession, userId, perfil.solucoesJaDiscutidas, 'Solucao', 'DISCUTIU_SOLUCAO');
        console.log(`[Neo4j Perfil] Perfil de ${perfil.nomeDoLead} (ID: ${userId}) salvo/atualizado. Tags: ${perfil.tags.join(', ')}. Hipóteses: ${perfil.activeHypotheses.length}`);
    } catch (error) {
        console.error(`[Neo4j Perfil] Erro ao salvar perfil de ${userId}:`, error);
    } finally {
        if (neo4jSession) await neo4jSession.close();
    }
}

async function analisarEAtualizarPerfil(userId, historicoCompletoConversa, perfilConceitualAtual) {
    const mensagensParaAnalise = historicoCompletoConversa.map(msg => {
        const role = msg.role === 'user' ? (perfilConceitualAtual.nomeDoLead || 'Lead') : NOME_DO_AGENTE;
        const textContent = (msg.parts && msg.parts[0] && typeof msg.parts[0].text === 'string')
            ? msg.parts[0].text
            : ( (msg.parts && msg.parts[0] && msg.parts[0].inlineData) ? "(Conteúdo de áudio/imagem)" : "(Conteúdo não textual ou formato inesperado)" );
        return `${role}: ${textContent}`;
    }).join('\n');

    const promptAnalise = `
        Sua tarefa é analisar o DIÁLOGO RECENTE e o PERFIL ATUAL de um lead chamado '${perfilConceitualAtual.nomeDoLead}' e retornar APENAS um objeto JSON contendo as atualizações para o perfil.
        Não inclua explicações ou texto fora do JSON.
        PERFIL ATUAL do Lead '${perfilConceitualAtual.nomeDoLead}':
        \`\`\`json
        ${JSON.stringify(perfilConceitualAtual, null, 2)}
        \`\`\`
        DIÁLOGO RECENTE com '${perfilConceitualAtual.nomeDoLead}' (pode incluir referências a áudio):
        \`\`\`
        ${mensagensParaAnalise}
        \`\`\`
        Com base no DIÁLOGO e no PERFIL ATUAL, identifique e/ou atualize os seguintes campos para o JSON de saída:
        - nomeDoNegocio: (string|null)
        - tipoDeNegocio: (string|null)
        - principaisDores: (array de strings, adicione NOVAS dores distintas. Mantenha as existentes.)
        - interessesEspecificos: (array de strings, adicione NOVOS interesses distintos. Mantenha os existentes.)
        - solucoesJaDiscutidas: (array de strings, adicione NOVAS soluções/tópicos discutidos. Mantenha os existentes.)
        - nivelDeInteresseReuniao: (string, escolha UM: "inicial", "baixo", "médio", "alto", "agendado", "desinteressado", "reagendar", "reunião concluída")
        - ultimoResumoDaSituacao: (string, uma frase concisa e ATUALIZADA sobre o estado atual.)
        - notasAdicionais: (array de strings, adicione NOVAS observações. Mantenha as existentes.)
        - tags: (array de strings, adicione NOVAS palavras-chave relevantes como "cético", "lead_quente", "decisor", "influenciador", "lead_frio", "urgente", "precisa_de_prova_social". Mantenha as existentes.)
        REGRAS IMPORTANTES PARA O JSON:
        1. Retorne APENAS o objeto JSON.
        2. Para campos de array, sua resposta deve CONTER OS ITENS ANTIGOS E OS NOVOS, SEM DUPLICATAS e sem itens vazios ou nulos.
        3. O campo 'ultimoResumoDaSituacao' DEVE ser atualizado.
    `;
    let perfilSugeridoJson = ""; // Declarar aqui para estar no escopo do catch e finally
    try {
        console.log(`[Perfil Analise LLM] Solicitando análise do perfil para ${userId}...`);
        const analiseModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Pode ser um modelo diferente se necessário
        const result = await analiseModel.generateContent(promptAnalise);
        const responseText = result.response.text();
        
        const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            perfilSugeridoJson = jsonMatch[1];
        } else if (responseText.trim().startsWith("{") && responseText.trim().endsWith("}")) {
            perfilSugeridoJson = responseText.trim();
        } else {
             console.warn(`[Perfil Analise LLM] Formato JSON não encontrado na resposta para ${userId}. Tentando extração manual. Resposta:`, responseText.substring(0, 300));
             const looseJsonMatch = responseText.match(/{[\s\S]*}/);
             if (looseJsonMatch && looseJsonMatch[0]) {
                 perfilSugeridoJson = looseJsonMatch[0];
             } else {
                 console.error(`[Perfil Analise LLM] Falha ao extrair JSON da resposta para ${userId}. Retornando perfil original.`);
                 return perfilConceitualAtual; // Retorna o perfil original se não conseguir extrair
             }
        }

        if (perfilSugeridoJson) {
            const perfilSugeridoPelaLLM = JSON.parse(perfilSugeridoJson);
            // Merge inteligente, priorizando arrays e garantindo unicidade e limpeza
            const perfilParaSalvar = {
                ...perfilConceitualAtual, // Base
                ...perfilSugeridoPelaLLM, // Atualizações da LLM
                // Tratamento especial para arrays para evitar duplicatas e manter itens existentes
                principaisDores: [...new Set([...(perfilConceitualAtual.principaisDores || []), ...(perfilSugeridoPelaLLM.principaisDores || [])])].filter(d => d && String(d).trim() !== ""),
                interessesEspecificos: [...new Set([...(perfilConceitualAtual.interessesEspecificos || []), ...(perfilSugeridoPelaLLM.interessesEspecificos || [])])].filter(i => i && String(i).trim() !== ""),
                solucoesJaDiscutidas: [...new Set([...(perfilConceitualAtual.solucoesJaDiscutidas || []), ...(perfilSugeridoPelaLLM.solucoesJaDiscutidas || [])])].filter(s => s && String(s).trim() !== ""),
                notasAdicionais: [...new Set([...(perfilConceitualAtual.notasAdicionais || []), ...(perfilSugeridoPelaLLM.notasAdicionais || [])])].filter(n => n && String(n).trim() !== ""),
                tags: [...new Set([...(perfilConceitualAtual.tags || []), ...(perfilSugeridoPelaLLM.tags || [])])].filter(t => t && String(t).trim() !== ""),
                activeHypotheses: perfilConceitualAtual.activeHypotheses || [] // Mantém as hipóteses do perfil conceitual
            };
            // Adiciona ao histórico resumido
            const novoResumo = perfilParaSalvar.ultimoResumoDaSituacao || 'Interação registrada.';
            const interacaoResumida = `${new Date().toISOString().split('T')[0]} - ${novoResumo}`;
            perfilParaSalvar.historicoDeInteracaoResumido = [...(perfilConceitualAtual.historicoDeInteracaoResumido || []), interacaoResumida].slice(-10); // Mantém os últimos 10
            
            await salvarPerfilLead(userId, perfilParaSalvar); // Salva no Neo4j
            console.log(`[Perfil Analise LLM] Perfil de ${userId} (${perfilParaSalvar.nomeDoLead}) atualizado no CRM.`);
            return perfilParaSalvar; // Retorna o perfil totalmente mesclado e salvo
        } else {
            console.warn(`[Perfil Analise LLM] Não foi possível extrair JSON para ${userId}. Nenhuma atualização no CRM.`);
            return perfilConceitualAtual; // Retorna o perfil original se não houver JSON
        }
    } catch (error) {
        console.error(`[Perfil Analise LLM] Erro ao analisar/atualizar perfil para ${userId}:`, error);
        if (error instanceof SyntaxError) { // Se o erro for de parse do JSON
            console.error("[Perfil Analise LLM] Detalhe do erro de Syntax (JSON inválido):", error.message, "JSON Recebido:", perfilSugeridoJson);
        }
        return perfilConceitualAtual; // Em caso de erro, retorna o perfil conceitual original
    }
}


// --- FUNÇÕES PARA ESQUEMAS DE CONHECIMENTO ---
async function buscarEsquemasDeConhecimento(principaisDoresDoLead) {
    if (!principaisDoresDoLead || principaisDoresDoLead.length === 0) return null;
    let neo4jSession;
    try {
        neo4jSession = await getSession();
        const esquemasAgregados = { doresMapeadas: [] };
        for (const dorLead of principaisDoresDoLead) {
            const query = `
                MATCH (dc:DorComum) WHERE toLower(dc.name) CONTAINS toLower($dorLeadParam) OR toLower(dc.descricao) CONTAINS toLower($dorLeadParam)
                OPTIONAL MATCH (dc)<-[:RESOLVE]-(sol:SolucaoOferecida)
                OPTIONAL MATCH (sol)-[:PODE_GERAR]->(objSol:ObjecaoComum)
                OPTIONAL MATCH (dc)-[:PODE_GERAR]->(objDor:ObjecaoComum)
                RETURN dc.nome AS nomeDorComum, dc.descricao AS descDorComum, sol.nome AS nomeSolucao, sol.descricao AS descSolucao,
                       collect(DISTINCT objSol.nome) AS objecoesDaSolucao, collect(DISTINCT objDor.nome) AS objecoesDaDor`;
            const result = await neo4jSession.run(query, { dorLeadParam: dorLead });
            if (result.records.length > 0) {
                const dorMapeadaInfo = { dorOriginalDoLead: dorLead, dorComumNoEsquema: null, solucoesSugeridas: [], objecoesGeraisDaDor: new Set() };
                const solucoesMap = new Map();
                result.records.forEach(record => {
                    const nomeDorComum = record.get('nomeDorComum');
                    if (nomeDorComum && !dorMapeadaInfo.dorComumNoEsquema) dorMapeadaInfo.dorComumNoEsquema = { nome: nomeDorComum, descricao: record.get('descDorComum') };
                    const nomeSolucao = record.get('nomeSolucao');
                    if (nomeSolucao) {
                        if (!solucoesMap.has(nomeSolucao)) solucoesMap.set(nomeSolucao, { nome: nomeSolucao, descricao: record.get('descSolucao'), objecoes: new Set() });
                        const objecoesSolucaoArray = record.get('objecoesDaSolucao');
                        if (objecoesSolucaoArray) objecoesSolucaoArray.forEach(obj => { if(obj) solucoesMap.get(nomeSolucao).objecoes.add(obj); });
                    }
                    const objecoesDorArray = record.get('objecoesDaDor');
                    if (objecoesDorArray) objecoesDorArray.forEach(obj => { if(obj) dorMapeadaInfo.objecoesGeraisDaDor.add(obj); });
                });
                dorMapeadaInfo.solucoesSugeridas = Array.from(solucoesMap.values()).map(s => ({ ...s, objecoes: Array.from(s.objecoes) }));
                dorMapeadaInfo.objecoesGeraisDaDor = Array.from(dorMapeadaInfo.objecoesGeraisDaDor);
                if(dorMapeadaInfo.dorComumNoEsquema) esquemasAgregados.doresMapeadas.push(dorMapeadaInfo);
            }
        }
        if (esquemasAgregados.doresMapeadas.length > 0) {
            console.log(`[Esquemas Conhecimento] Encontrados esquemas para: ${principaisDoresDoLead.join(', ')}`);
            return esquemasAgregados;
        }
        console.log(`[Esquemas Conhecimento] Nenhum esquema encontrado para: ${principaisDoresDoLead.join(', ')}`);
        return null;
    } catch (error) {
        console.error("[Esquemas Conhecimento] Erro ao buscar esquemas:", error);
        return { error: `Erro ao buscar esquemas: ${error.message}` };
    } finally {
        if (neo4jSession) await neo4jSession.close();
    }
}

// --- FUNÇÃO PRINCIPAL DA GEMINI ---
async function askGemini(userId, userName, aggregatedMessages) {
    console.log(`[Agent Core] Iniciando ciclo de agente para ${userId} (${userName}).`);
    let sessionData = chatSessions[userId];
    let chat;
    let currentPerfilDoLead;

    if (!sessionData || !sessionData.chat) {
        console.log(`[Agent Core] Iniciando NOVA SESSÃO de chat Gemini para ${userId} (${userName}).`);
        currentPerfilDoLead = await carregarOuCriarPerfilLead(userId, userName);
        chat = modelWithTools.startChat({ history: [], generationConfig: generationConfig });
        sessionData = { 
            chat, 
            lastActivity: Date.now(), 
            perfil: currentPerfilDoLead, 
            planner: null, 
            lastUserMessageText: null,
            reflectionHistory: [], 
            activeHypotheses: currentPerfilDoLead.activeHypotheses || [] 
        };
        chatSessions[userId] = sessionData;
    } else {
        console.log(`[Agent Core] Usando SESSÃO de chat Gemini EXISTENTE para ${userId} (${userName}).`);
        chat = sessionData.chat;
        sessionData.lastActivity = Date.now();
        // Recarrega o perfil para garantir que está atualizado, especialmente as hipóteses.
        currentPerfilDoLead = await carregarOuCriarPerfilLead(userId, userName); 
        sessionData.perfil = currentPerfilDoLead;
        sessionData.reflectionHistory = sessionData.reflectionHistory || [];
        sessionData.activeHypotheses = currentPerfilDoLead.activeHypotheses || sessionData.activeHypotheses || [];
    }

    let combinedUserTextForReflection = "";
    aggregatedMessages.forEach(msg => {
        if (msg.type === 'text' && msg.content) combinedUserTextForReflection += (combinedUserTextForReflection ? "\n" : "") + msg.content;
        else if (msg.type === 'audio') combinedUserTextForReflection += (combinedUserTextForReflection ? "\n" : "") + "[MENSAGEM DE ÁUDIO DO UTILIZADOR]";
    });
    sessionData.lastUserMessageText = combinedUserTextForReflection || null;


    if (!sessionData.planner || sessionData.planner.isPlanComplete() || sessionData.planner.status !== "active") {
        if (sessionData.planner && sessionData.planner.isPlanComplete()) {
            console.log(`[Agent Core] Plano anterior para ${userId} (${sessionData.planner.selectedPlanName}) foi concluído.`);
        } else if (sessionData.planner && sessionData.planner.status !== "active") {
            console.log(`[Agent Core] Planner para ${userId} (${sessionData.planner.selectedPlanName || 'N/A'}) não está ativo (status: ${sessionData.planner ? sessionData.planner.status : 'N/A'}).`);
        }
        try {
            sessionData.planner = new Planner(currentPerfilDoLead); 
            console.log(`[Agent Core] Planner instanciado/reiniciado para ${userId}. Plano: ${sessionData.planner.selectedPlanName}. Etapa: ${sessionData.planner.getCurrentStep()?.name}`);
        } catch (plannerError) {
            console.error(`[Agent Core CRITICAL] Falha ao instanciar Planner para ${userId}. Erro:`, plannerError);
            sessionData.planner = null; 
        }
    }

    let userMessageContentParts = [];
    if (currentPerfilDoLead) {
        userMessageContentParts.push({ text: `<perfil_atual_do_lead_para_referencia_imediata>
Nome: ${currentPerfilDoLead.nomeDoLead}
ID: ${currentPerfilDoLead.idWhatsapp}
Tipo de Negócio: ${currentPerfilDoLead.tipoDeNegocio || 'Não informado'}
Último Resumo da Situação: ${currentPerfilDoLead.ultimoResumoDaSituacao}
Nível de Interesse em Reunião: ${currentPerfilDoLead.nivelDeInteresseReuniao}
Tags: ${(currentPerfilDoLead.tags || []).join(', ') || 'Nenhuma'}
Hipóteses Ativas: ${sessionData.activeHypotheses.map(h => `${h.description} (Conf: ${h.confidence || 'N/A'})`).join('; ') || 'Nenhuma'}
</perfil_atual_do_lead_para_referencia_imediata>\n\n` });
    }

    if (sessionData.planner && sessionData.planner.status === "active") {
        const plannerGuidanceText = sessionData.planner.getGuidanceForLLM(currentPerfilDoLead);
        if (plannerGuidanceText) {
            userMessageContentParts.push({ text: `<instrucao_do_planner_para_este_turno>\n${plannerGuidanceText}\n</instrucao_do_planner_para_este_turno>\n\n` });
        }
    }

    // Modulação de tom por estado emocional e perfil de decisão
    try {
        const emo = (currentPerfilDoLead?.emotionalState || '').toLowerCase();
        const dprof = (currentPerfilDoLead?.decisionProfile || '').toLowerCase();
        const dprof2 = (currentPerfilDoLead?.decisionProfileSecondary || '').toLowerCase();
        const toneHints = [];
        if (emo) {
            if (emo.includes('frustr') || emo.includes('impaciente')) toneHints.push('Seja empático, valide a frustração e ofereça solução objetiva.');
            if (emo.includes('confuso')) toneHints.push('Seja claro e didático; use passos simples e exemplos.');
            if (emo.includes('interess') || emo.includes('animado')) toneHints.push('Mantenha ritmo positivo e direcione para próximo passo claro.');
            if (emo.includes('cético')) toneHints.push('Inclua evidências/prova social para aumentar confiança.');
        }
        const profileHints = [];
        const allProfiles = [dprof, dprof2].filter(Boolean);
        if (allProfiles.some(p => p.includes('analit'))) profileHints.push('Priorize dados, estruturas e benefícios quantificáveis.');
        if (allProfiles.some(p => p.includes('emoc'))) profileHints.push('Priorize confiança, segurança e exemplos relacionáveis.');
        if (allProfiles.some(p => p.includes('urg'))) profileHints.push('Seja conciso, direto e apresente próximo passo imediato.');
        if (allProfiles.some(p => p.includes('cét'))) profileHints.push('Use prova social/casos e explique porquê funciona.');
        const combinedHints = [...toneHints, ...profileHints];
        if (combinedHints.length) {
            userMessageContentParts.unshift({ text: `<modulacao_de_tom>\n${combinedHints.map((h,i)=>`${i+1}. ${h}`).join('\n')}\n</modulacao_de_tom>\n\n` });
        }
    } catch {}
    
    let combinedUserTextForLLM = "";
    let lastAudioMessageForLLM = null;
    aggregatedMessages.forEach(msg => {
        if (msg.type === 'text' && msg.content) combinedUserTextForLLM += (combinedUserTextForLLM ? "\n\n" : "") + msg.content;
        else if (msg.type === 'audio' && msg.data && msg.mimeType) lastAudioMessageForLLM = msg;
    });

    if (combinedUserTextForLLM) userMessageContentParts.push({ text: `Mensagem(ns) do usuário ${userName} (ID: ${userId}):\n${combinedUserTextForLLM}` });
    if (lastAudioMessageForLLM) {
        userMessageContentParts.push({ text: `(Áudio do usuário ${userName} (ID: ${userId}) a seguir. Transcreva e considere seu conteúdo.)`});
        userMessageContentParts.push({ inlineData: { mimeType: lastAudioMessageForLLM.mimeType, data: lastAudioMessageForLLM.data } });
    }

    if (userMessageContentParts.filter(p => !p.text.includes('<perfil_atual_do_lead') && !p.text.includes('<instrucao_do_planner')).length === 0) {
        if (sessionData.planner && sessionData.planner.selectedPlanName === "ColdLeadReEngagement" && sessionData.planner.getCurrentStep()?.name === "GentleReIntroduction" && sessionData.planner.getCurrentStep()?.retries === 0) {
             console.log(`[Agent Core] Permitindo que o planner de reengajamento atue para ${userId} sem nova mensagem do usuário.`);
        } else {
            console.warn(`[Agent Core] Nenhuma mensagem de usuário efetiva para ${userId}. Não chamando LLM.`);
            return ""; 
        }
    }

    let iterationCount = 0;
    let currentMessageForGemini = userMessageContentParts;

    try {
        while (iterationCount < MAX_TOOL_ITERATIONS) {
            iterationCount++;
            console.log(`[Agent Core] Iteração ${iterationCount} para ${userId}. Enviando para Gemini.`);
            // console.log("[Agent Core DEBUG] Mensagem para Gemini:", JSON.stringify(currentMessageForGemini, null, 2));

            const result = await chat.sendMessage(currentMessageForGemini);
            const response = result.response;
            const candidate = response.candidates?.[0];

            if (!candidate) {
                const blockReason = response?.promptFeedback?.blockReason;
                console.warn(`[Agent Core] Resposta vazia ou bloqueada para ${userId}. Razão: ${blockReason || 'Não especificada'}.`);
                return `Desculpe, ${userName}, não consegui processar sua mensagem (${blockReason || 'erro interno'}). Tente reformular.`;
            }

            const functionCallPart = candidate.content?.parts?.find(part => part.functionCall);

            if (functionCallPart) {
                const { name: toolName, args: toolArgs } = functionCallPart.functionCall;
                console.log(`[Agent Core] Gemini SDK forneceu structured functionCall: ${toolName} com args:`, toolArgs);

                if (toolExecutors[toolName]) {
                    let finalToolArgs = toolArgs;
                    if (toolName === "analyze_and_update_lead_profile") {
                        const historyForTool = await chat.getHistory();
                        finalToolArgs = {
                            ...toolArgs,
                            leadId: toolArgs.leadId || userId,
                            fullChatHistoryArray: historyForTool,
                            currentConceptualProfileObject: sessionData.perfil // Usa o perfil da sessão que é atualizado
                        };
                    } else if (toolName === "get_lead_profile") {
                        finalToolArgs.leadId = finalToolArgs.leadId || userId;
                        finalToolArgs.leadName = finalToolArgs.leadName || userName;
                    } else if (toolName === "get_relevant_case_studies_or_social_proof") {
                        if (!finalToolArgs.leadBusinessType && sessionData.perfil && sessionData.perfil.tipoDeNegocio) {
                            finalToolArgs.leadBusinessType = sessionData.perfil.tipoDeNegocio;
                        }
                    }

                    const toolResult = await toolExecutors[toolName](finalToolArgs);
                    const toolResultString = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                    console.log(`[Agent Core] Resultado da ferramenta ${toolName}:`, toolResultString.substring(0, 200) + "...");
                    currentMessageForGemini = [{
                        functionResponse: {
                            name: toolName,
                            response: { name: toolName, content: toolResultString }
                        }
                    }];
                    // Se a ferramenta atualizou o perfil, atualiza na sessão também
                    if (toolName === "analyze_and_update_lead_profile" && typeof toolResult === 'object' && toolResult.updatedProfile) {
                        sessionData.perfil = toolResult.updatedProfile;
                        console.log(`[Agent Core] Perfil na sessão de ${userId} atualizado após analyze_and_update_lead_profile.`);
                    } else if (toolName === "get_lead_profile" && typeof toolResult === 'string') {
                        try {
                           const parsedProfile = JSON.parse(toolResult);
                           if (!parsedProfile.error) {
                               sessionData.perfil = parsedProfile;
                               console.log(`[Agent Core] Perfil na sessão de ${userId} atualizado após get_lead_profile.`);
                           }
                        } catch(e) { console.warn("[Agent Core] Erro ao parsear resultado de get_lead_profile para atualizar sessão"); }
                    }
                    continue;
                } else {
                    console.error(`[Agent Core] Ferramenta desconhecida solicitada: ${toolName}`);
                    currentMessageForGemini = [{
                        functionResponse: {
                            name: toolName,
                            response: { name: toolName, content: JSON.stringify({ error: `Ferramenta ${toolName} não encontrada.` }) }
                        }
                    }];
                    continue;
                }
            }
            
            // Verifica se a resposta é um JSON de chamada de função (fallback)
            const allPartsText = candidate.content?.parts?.map(p => p.text || "").join("").trim();
            if (allPartsText) {
                try {
                    const potentialJson = JSON.parse(allPartsText);
                    if (potentialJson.functionCall && potentialJson.functionCall.name && typeof potentialJson.functionCall.args === 'object') {
                        const { name: toolName, args: toolArgs } = potentialJson.functionCall;
                        console.log(`[Agent Core] Detectado functionCall JSON em TEXTO: ${toolName} com args:`, toolArgs);

                        if (toolExecutors[toolName]) {
                             let finalToolArgsFallback = toolArgs;
                            if (toolName === "analyze_and_update_lead_profile") {
                                const historyForToolFallback = await chat.getHistory();
                                finalToolArgsFallback = {
                                    ...toolArgs,
                                    leadId: toolArgs.leadId || userId,
                                    fullChatHistoryArray: historyForToolFallback,
                                    currentConceptualProfileObject: sessionData.perfil
                                };
                            } else if (toolName === "get_lead_profile") {
                                finalToolArgsFallback.leadId = finalToolArgsFallback.leadId || userId;
                                finalToolArgsFallback.leadName = finalToolArgsFallback.leadName || userName;
                            } else if (toolName === "get_relevant_case_studies_or_social_proof") {
                                if (!finalToolArgsFallback.leadBusinessType && sessionData.perfil && sessionData.perfil.tipoDeNegocio) {
                                    finalToolArgsFallback.leadBusinessType = sessionData.perfil.tipoDeNegocio;
                                }
                            }
                            const toolResult = await toolExecutors[toolName](finalToolArgsFallback);
                            const toolResultString = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                            console.log(`[Agent Core] Resultado da ferramenta (via texto JSON) ${toolName}:`, toolResultString.substring(0, 200) + "...");
                            currentMessageForGemini = [{
                                functionResponse: {
                                    name: toolName,
                                    response: { name: toolName, content: toolResultString }
                                }
                            }];
                             // Se a ferramenta atualizou o perfil, atualiza na sessão também (fallback)
                            if (toolName === "analyze_and_update_lead_profile" && typeof toolResult === 'object' && toolResult.updatedProfile) {
                                sessionData.perfil = toolResult.updatedProfile;
                                console.log(`[Agent Core] Perfil na sessão de ${userId} atualizado após analyze_and_update_lead_profile (fallback).`);
                            } else if (toolName === "get_lead_profile" && typeof toolResult === 'string') {
                                try {
                                   const parsedProfileFallback = JSON.parse(toolResult);
                                   if (!parsedProfileFallback.error) {
                                       sessionData.perfil = parsedProfileFallback;
                                       console.log(`[Agent Core] Perfil na sessão de ${userId} atualizado após get_lead_profile (fallback).`);
                                   }
                                } catch(e) { console.warn("[Agent Core] Erro ao parsear resultado de get_lead_profile para atualizar sessão (fallback)"); }
                            }
                            continue; 
                        } else {
                             console.error(`[Agent Core] Ferramenta desconhecida (via texto JSON) solicitada: ${toolName}`);
                             currentMessageForGemini = [{
                                functionResponse: {
                                    name: toolName,
                                    response: { name: toolName, content: JSON.stringify({ error: `Ferramenta ${toolName} não encontrada.` }) }
                                }
                            }];
                            continue;
                        }
                    }
                    // Se foi um JSON, mas não uma chamada de função, é uma resposta inesperada.
                    console.warn(`[Agent Core] Resposta da LLM foi um JSON, mas não uma chamada de função esperada. Conteúdo: ${allPartsText.substring(0,200)}...`);
                    return `Desculpe, ${userName}, tive um problema ao processar a informação internamente. Poderia tentar de novo? (Ref: JSON_RESP_UNEXPECTED)`;

                } catch (e) { 
                    // Não era JSON, então é a resposta final do agente.
                    console.log(`[Agent Core] Resposta final do agente para ${userId} (${userName}): "${allPartsText.substring(0, 100)}..."`);
                    // Substitui [Nome do Lead] pelo nome real
                    const cleanText = sanitizeModelOutputForUser(allPartsText).replace(/\[Nome do Lead\]/g, userName);
                    return cleanText.trim();
                }
            }
            
            // Se chegou aqui, a resposta não foi nem function call estruturado, nem JSON de function call, nem texto claro.
            console.warn(`[Agent Core] Resposta do Gemini não era nem function call estruturado, nem JSON de function call em texto, nem texto claro para ${userId}. Conteúdo:`, JSON.stringify(candidate.content, null, 2));
            return `Desculpe, ${userName}, tive uma dificuldade em formular a resposta. Poderia tentar de novo?`;
        }

        console.warn(`[Agent Core] Máximo de iterações de ferramentas (${MAX_TOOL_ITERATIONS}) atingido para ${userId}.`);
        return `Desculpe, ${userName}, estou tendo um pouco de dificuldade em processar sua solicitação. Poderia tentar simplificar?`;

    } catch (error) {
        console.error(`[Agent Core] Erro no ciclo do agente para ${userId}:`, error);
        if (error.response && error.response.promptFeedback) {
            console.error('[Agent Core] Detalhes do Prompt Feedback:', JSON.stringify(error.response.promptFeedback, null, 2));
        }
        return `Ops! Tive um probleminha técnico com a IA aqui, ${userName}. 🤯 Poderia tentar de novo em um instante?`;
    }
}


// --- FUNÇÃO DE PROCESSAMENTO DE MENSAGENS ---
async function processAndRespondToMessages(client, senderId, senderName, messagesToProcess) {
    console.log(`[Process Msg] Processando ${messagesToProcess.length} mensagem(ns) de ${senderName} (${senderId})`);
    let agentResponseText = "";
    const sessionForReflection = chatSessions[senderId]; 

    // Verifica se há mensagens para processar OU se o planner de reengajamento está na primeira etapa e pode atuar sem mensagem do usuário
    const canProcess = messagesToProcess.length > 0 || 
                       (sessionForReflection && sessionForReflection.planner && 
                        sessionForReflection.planner.selectedPlanName === "ColdLeadReEngagement" && 
                        sessionForReflection.planner.getCurrentStep()?.name === "GentleReIntroduction" && 
                        sessionForReflection.planner.getCurrentStep()?.retries === 0);

    if (canProcess) {
        agentResponseText = await askGemini(senderId, senderName, messagesToProcess);
    } else {
        console.warn(`[Process Msg] Chamado para processar, mas sem mensagens para ${senderId} e sem condição de planner para atuar.`);
        return; // Não faz nada se não houver o que processar
    }

    if (agentResponseText && agentResponseText.trim() !== "") {
        const messagesToSend = agentResponseText.includes(DELIMITER_MSG_BREAK)
                               ? agentResponseText.split(DELIMITER_MSG_BREAK)
                               : [agentResponseText];
        for (let i = 0; i < messagesToSend.length; i++) {
            const part = messagesToSend[i].trim();
            if (part) {
                try {
                    await client.startTyping(senderId);
                    // Simula um tempo de digitação mais realista
                    const typingDuration = Math.min(Math.max(part.length * 70, 600), 4000); // Entre 0.6s e 4s
                    await delay(typingDuration);
                    await client.sendText(senderId, part);
                    await client.stopTyping(senderId);
                    // Persist outbound message (agent)
                    try {
                      const neo4jSession = await getSession();
                      try {
                        const at = Date.now();
                        await neo4jSession.run(`
                          MERGE (l:Lead {idWhatsapp: $id})
                          ON CREATE SET l.nome = $name, l.dtCriacao = timestamp()
                          WITH l
                          CREATE (m:Message { id: $mid, text: $text, at: $at, role: 'model', direction: 'outbound' })
                          CREATE (l)-[:HAS_MESSAGE]->(m)
                        `, { id: senderId, name: senderName, mid: `${senderId}-${at}-${i}`, text: part, at: neo4j.int(at) });
                      } finally { await neo4jSession.close(); }
                    } catch (persistErr) { console.warn('[Persist Outbound] falhou:', persistErr?.message || persistErr); }
                } catch (sendError) {
                    console.error(`[WPPConnect Send] Erro ao enviar parte da mensagem para ${senderId}:`, sendError);
                }
            }
        }
        console.log(`[Process Msg] Resposta completa do ${NOME_DO_AGENTE} enviada para ${senderId} (${senderName}).`);

        // --- LÓGICA DE REFLEXÃO PÓS-TURNO ---
        if (globalReflectiveAgent && sessionForReflection && globalAnalyticsTracker) {
            const lastAgentMsgForReflection = agentResponseText; // Resposta completa do agente
            const lastUserMsgForReflection = sessionForReflection.lastUserMessageText; // Já combinado no askGemini
            const currentProfileForReflection = sessionForReflection.perfil;
            const currentPlannerStateForReflection = sessionForReflection.planner ? {
                selectedPlanName: sessionForReflection.planner.selectedPlanName,
                currentStep: sessionForReflection.planner.getCurrentStep(),
                planStatus: sessionForReflection.planner.status
            } : null;
            
            let conversationHistoryForReflection = [];
            try {
                if (sessionForReflection.chat) {
                    // Pega o histórico, excluindo a última mensagem do modelo (que é a resposta atual)
                    // e a última do usuário (que já está em lastUserMsgForReflection)
                    const fullHistory = await sessionForReflection.chat.getHistory();
                    // Queremos o contexto ANTES da interação atual.
                    // Se a última mensagem no histórico é do 'model', é a resposta que acabamos de dar.
                    // Se a penúltima é 'user', é a mensagem que o usuário enviou e estamos respondendo.
                    // Então, queremos o histórico ANTES dessas duas.
                    conversationHistoryForReflection = fullHistory.slice(-7, -1); // Exemplo: últimos 5 turnos (user+model) antes do atual
                }
            } catch (histError) {
                console.warn("[Reflexão] Erro ao obter histórico do chat para reflexão:", histError);
            }

            // Determinar o foco da reflexão
            let focusTypeForReflection = ReflectionFocus.GENERAL_PROGRESS; // Padrão
            if (currentPlannerStateForReflection?.currentStep?.status === 'failed') {
                focusTypeForReflection = ReflectionFocus.AGENT_TACTIC_EFFECTIVENESS;
            } else if (currentPlannerStateForReflection?.planStatus === 'failed' || currentPlannerStateForReflection?.planStatus === 'paused') {
                focusTypeForReflection = ReflectionFocus.PLAN_ALIGNMENT_AND_RISKS; // Supondo que você adicione este foco
            } else if (lastUserMsgForReflection && (lastUserMsgForReflection.length < 20 || lastUserMsgForReflection.toLowerCase().includes("não sei"))) {
                // Se a resposta do usuário for muito curta ou indicar incerteza
                focusTypeForReflection = ReflectionFocus.LEAD_SENTIMENT_ENGAGEMENT;
            }
            
            // Debounce/cache de reflexão: pula se não mudou contexto em janela curta
            try {
                const sig = buildReflectionSignature(
                  lastAgentMsgForReflection,
                  lastUserMsgForReflection,
                  currentPlannerStateForReflection,
                  currentProfileForReflection
                );
                if (shouldSkipReflection(senderId, sig)) {
                    console.log(`[Reflexão] Ignorada (cache) para ${senderId} — assinatura repetida em janela curta.`);
                    return; // evita reflexão redundante
                }
                markReflection(senderId, sig);
            } catch (e) { console.warn('[Reflexão] Falha no debounce/cache:', e?.message || e); }

            console.log(`[Reflexão] Solicitando reflexão para ${senderId} com foco: ${focusTypeForReflection}`);
            
            const previousReflectionsForPrompt = sessionForReflection.reflectionHistory || [];
            const activeHypothesesForPrompt = sessionForReflection.activeHypotheses || [];

            globalReflectiveAgent.reflect(
                lastAgentMsgForReflection,
                lastUserMsgForReflection, 
                currentProfileForReflection,
                currentPlannerStateForReflection,
                conversationHistoryForReflection, // Histórico ANTES da interação atual
                focusTypeForReflection,
                previousReflectionsForPrompt, // Passa o histórico de reflexões anteriores
                activeHypothesesForPrompt // Passa as hipóteses ativas
            ).then(reflectionResult => {
                if (reflectionResult && !reflectionResult.error) {
                    console.log(`[Reflexão Sucesso - ${senderId}] Resumo: ${reflectionResult.resumoDaReflexao || 'N/A'}`);
                    // console.log("[Reflexão Detalhada]:", JSON.stringify(reflectionResult, null, 2));

                    // 1. Adicionar dados ao Analytics Tracker
                    globalAnalyticsTracker.addReflectionData({
                        leadId: senderId,
                        leadName: senderName,
                        leadType: currentProfileForReflection.tipoDeNegocio, // Exemplo
                        planName: currentPlannerStateForReflection?.selectedPlanName || 'N/A',
                        stepName: currentPlannerStateForReflection?.currentStep?.name || 'N/A',
                        agentAction: reflectionResult.acaoPrincipalRealizadaPeloAgente || 'N/A',
                        stepGoalAchieved: reflectionResult.objetivoDaEtapaDoPlannerAvancou === true, // Garante boolean
                        inferredLeadSentiment: reflectionResult.sentimentoInferidoDoLead,
                        sentimentConfidenceLabel: reflectionResult.confiancaSentimentoLead || null,
                        sentimentConfidenceScore: typeof reflectionResult.confidenceScore === 'number' ? reflectionResult.confidenceScore : null,
                        tacticRepetitionDetected: reflectionResult.sinalizadorRepeticaoTatica?.detectada || false,
                        hypothesisStatus: reflectionResult.hipotesesAtualizadas?.find(h => h.status === 'confirmada' || h.status === 'descartada')?.status, // Exemplo simples
                        previousReflectionEvaluation: reflectionResult.avaliacaoDeReflexaoAnterior?.eficaz !== undefined ? (reflectionResult.avaliacaoDeReflexaoAnterior.eficaz ? 'eficaz' : 'nao_eficaz') : undefined,
                        rawReflection: reflectionResult // Armazena a reflexão completa
                    });

                    // 2. Atualizar histórico de reflexões na sessão
                    sessionForReflection.reflectionHistory.push(reflectionResult);
                    if (sessionForReflection.reflectionHistory.length > 3) { // Mantém as últimas 3
                        sessionForReflection.reflectionHistory.shift();
                    }

                    // 3. Atualizar hipóteses ativas na sessão (e potencialmente no perfil do Neo4j)
                    if (reflectionResult.hipotesesAtualizadas && Array.isArray(reflectionResult.hipotesesAtualizadas)) {
                        sessionForReflection.activeHypotheses = reflectionResult.hipotesesAtualizadas.filter(h => h.status === 'ativa');
                        // Salva o perfil com as hipóteses atualizadas
                        if (sessionForReflection.perfil) {
                            sessionForReflection.perfil.activeHypotheses = sessionForReflection.activeHypotheses;
                            salvarPerfilLead(senderId, sessionForReflection.perfil)
                                .catch(err => console.error(`[Reflexão] Erro ao salvar perfil com hipóteses atualizadas para ${senderId}:`, err));
                        }
                    }

                    // 4. Considerar sugestão de mudança de plano (exemplo de lógica)
                    if (reflectionResult.sugestaoAlteracaoPlano?.necessaria && sessionForReflection.planner) {
                        console.warn(`[Reflexão - ${senderId}] SUGESTÃO DE MUDANÇA DE PLANO: Para '${reflectionResult.sugestaoAlteracaoPlano.novoPlanoSugerido}'. Justificativa: ${reflectionResult.sugestaoAlteracaoPlano.justificativa}`);
                        // Implementar lógica para realmente mudar o plano, ex:
                        // sessionForReflection.planner = null; // Forçará a recriação do planner na próxima interação
                        // Poderia adicionar uma tag ao perfil do lead para influenciar a próxima seleção de plano.
                        // Ex: currentProfileForReflection.tags.push("sugestao_plano_" + reflectionResult.sugestaoAlteracaoPlano.novoPlanoSugerido);
                    }

                    // 5. Logar sugestão de micropersona
                    if (reflectionResult.sugestaoMicropersona) {
                        console.log(`[Reflexão - ${senderId}] SUGESTÃO DE MICROPERSONA: Cluster '${reflectionResult.sugestaoMicropersona.clusterIdentificado}', Ajuste: '${reflectionResult.sugestaoMicropersona.ajusteSugeridoNaPersonaAgente}'`);
                    }

                    // 6. Assistir o Planner com base na reflexão (auto-avançar se aderente)
                    try {
                        if (sessionForReflection.planner) {
                            const fit = reflectionResult.stepFit;
                            const avancou = reflectionResult.objetivoDaEtapaDoPlannerAvancou === true;
                            if ((fit && fit.matchesStep) || avancou) {
                                const ok = sessionForReflection.planner.completeCurrentStepWithReason('reflection_fit');
                                if (ok) console.log(`[Planner Assist] Etapa atual concluída por reflexão para ${senderId}.`);
                            } else if (fit && Array.isArray(fit.missingInfo) && fit.missingInfo.length > 0) {
                                // Cria uma tarefa leve para coletar a primeira informação faltante
                                const firstMissing = String(fit.missingInfo[0] || '').trim();
                                if (firstMissing) {
                                    (async () => { try {
                                        const phone = String(senderId || '').replace(/\D/g, '');
                                        const title = `Coletar: ${firstMissing}`;
                                        const description = `Reflexão indicou dados ausentes: ${fit.missingInfo.slice(0,3).join(', ')}`;
                                        const due = new Date(Date.now() + 24*60*60*1000).toISOString();
                                        await dispatchToCRM('create_task', { phone, title, description, due_date: due });
                                        console.log('[Planner Assist] Tarefa criada para coletar informação ausente:', firstMissing);
                                    } catch (eTask) { console.warn('[Planner Assist] Falha ao criar tarefa de coleta:', eTask?.message || eTask); } })();
                                }
                            }
                        }
                    } catch (eAssist) { console.warn('[Planner Assist] erro:', eAssist?.message || eAssist); }

                    // 6. Enviar "Dado de Ouro — Reflexão" para o CRM como nota (JSON estruturado)
                    (async () => {
                      try {
                        const now = Date.now();
                        sessionForReflection.lastReflectionNoteAt = sessionForReflection.lastReflectionNoteAt || 0;
                        const MIN_NOTE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos para evitar spam
                        if (now - sessionForReflection.lastReflectionNoteAt > MIN_NOTE_INTERVAL_MS) {
                            const phone = String(senderId || '').replace(/\D/g, '');
                            const title = `Dado de Ouro — Reflexão${(typeof focusTypeForReflection === 'string' && focusTypeForReflection) ? ` (${focusTypeForReflection})` : ''}`;
                            const description = JSON.stringify({
                                foco: focusTypeForReflection,
                                resumo: reflectionResult.resumoDaReflexao || null,
                                proximaPerguntaDeAltoValor: reflectionResult.proximaPerguntaDeAltoValor || null,
                                proximoPassoLogicoSugerido: reflectionResult.proximoPassoLogicoSugerido || null,
                                sentimentoInferidoDoLead: reflectionResult.sentimentoInferidoDoLead || null,
                                confiancaSentimentoLead: reflectionResult.confiancaSentimentoLead || null,
                                confidenceScore: typeof reflectionResult.confidenceScore === 'number' ? reflectionResult.confidenceScore : null,
                                stepFit: reflectionResult.stepFit || null,
                                principaisPontosDeAtencao: Array.isArray(reflectionResult.principaisPontosDeAtencao) ? reflectionResult.principaisPontosDeAtencao.slice(0,3) : [],
                                raw: reflectionResult
                            });
                            const idem = `gold-reflection-${phone}-${Buffer.from((reflectionResult.resumoDaReflexao || '')).toString('base64').slice(0,32)}`;
                            await dispatchToCRM('create_note', { phone, title, description }, { idempotencyKey: idem });
                            sessionForReflection.lastReflectionNoteAt = now;
                        }
                      } catch (eNote) {
                        console.warn(`[Reflexão] Falha ao enviar nota de reflexão para CRM (${senderId}):`, eNote?.message || eNote);
                      }
                    })();

                    // 7. Disparar evento pós-reflexão para o mecanismo de ferramentas
                    try {
                        const { evaluateAndRunTools } = require('./toolsEngine');
                        const leadProfile = { idWhatsapp: senderId, ...(sessionForReflection?.perfil || {}) };
                        evaluateAndRunTools({ eventType: 'afterReflection', leadProfile, reflectionResult })
                          .catch(e => console.warn('[afterReflection] tools error:', e?.message || e));
                    } catch (e) {
                        console.warn('[afterReflection] dispatch failed:', e?.message || e);
                    }

                    // 8. Se houver metas off_track, emitir evento goalBreach para acionar automações
                    try {
                        const goalsEngine = require('./goalsEngine');
                        const snaps = (typeof goalsEngine.getSnapshots === 'function') ? goalsEngine.getSnapshots() : [];
                        const latestById = new Map();
                        for (const s of snaps) {
                            const prev = latestById.get(s.id);
                            if (!prev || Number(s.at||0) > Number(prev.at||0)) latestById.set(s.id, s);
                        }
                        const off = Array.from(latestById.values()).filter(s => s.status === 'off_track').slice(0, 3);
                        if (off.length) {
                            const { evaluateAndRunTools } = require('./toolsEngine');
                            const leadProfile = { idWhatsapp: senderId, ...(sessionForReflection?.perfil || {}) };
                            for (const g of off) {
                                evaluateAndRunTools({ eventType: 'goalBreach', leadProfile, reflectionResult, goal: { id: g.id, value: g.value, target: g.target, direction: g.direction } })
                                  .catch(e => console.warn('[goalBreach] tools error:', e?.message || e));
                            }
                        }
                    } catch (e) {
                        console.warn('[goalBreach] dispatch failed:', e?.message || e);
                    }


                } else if (reflectionResult && reflectionResult.error) {
                    console.error(`[Reflexão Falha - ${senderId}] Erro: ${reflectionResult.error}`, reflectionResult.details || '');
                }
            }).catch(reflectionError => {
                console.error(`[Reflexão Erro Crítico - ${senderId}] Exceção ao chamar reflect:`, reflectionError);
            });
        }
        // --- FIM DA LÓGICA DE REFLEXÃO PÓS-TURNO ---

        // --- ANÁLISE AUTOMÁTICA DE PERFIL (FALLBACK, SEM DEPENDER DO GEMINI) ---
        try {
            if (sessionForReflection) {
                const now = Date.now();
                const MIN_INTERVAL_MS = 2 * 60 * 1000; // evita chamadas a cada turno
                sessionForReflection.lastProfileAnalysisAt = sessionForReflection.lastProfileAnalysisAt || 0;
                if (now - sessionForReflection.lastProfileAnalysisAt > MIN_INTERVAL_MS) {
                    const fullChatHist = sessionForReflection.chat ? await sessionForReflection.chat.getHistory() : [];
                    const analysisResultStr = await toolExecutors["analyze_and_update_lead_profile"]({
                        leadId: senderId,
                        fullChatHistoryArray: fullChatHist,
                        currentConceptualProfileObject: sessionForReflection.perfil
                    });
                    try {
                        const analysisResult = typeof analysisResultStr === "string" ? JSON.parse(analysisResultStr) : analysisResultStr;
                        if (analysisResult && analysisResult.updatedProfile) {
                            sessionForReflection.perfil = analysisResult.updatedProfile;
                            console.log(`[AutoProfile] Perfil de ${senderId} atualizado automaticamente após turno.`);
                        }
                    } catch (parseErr) {
                        console.warn(`[AutoProfile] Falha ao parsear resultado da análise automática de perfil para ${senderId}.`, parseErr.message);
                    }
                    sessionForReflection.lastProfileAnalysisAt = now;
                }
            }
        } catch (autoErr) {
            console.error(`[AutoProfile] Erro ao executar análise automática de perfil para ${senderId}:`, autoErr);
        }
        // --- FIM DA ANÁLISE AUTOMÁTICA DE PERFIL ---

    } else {
        console.log(`[Process Msg] Nenhuma resposta gerada pelo Agente para ${senderId}. Não haverá reflexão.`);
    }
}

// --- BOT WPPCONNECT ---
async function startBot() {
  try {
    console.log('[WPPConnect] Iniciando o cliente...');
    // Verifica conexão com Neo4j
    try {
        getDriver(); // Garante que o driver está inicializado
        const checkSession = await getSession();
        await checkSession.close();
        console.log('[Neo4j] Conexão com Neo4j verificada com sucesso.');
    } catch (e) {
        console.error("!!!!!!!!!! FALHA CRÍTICA AO INICIALIZAR OU VERIFICAR DRIVER DO NEO4J. VERIFIQUE A CONFIGURAÇÃO E CONEXÃO. !!!!!!!!!!", e);
        // Considerar encerrar o processo se o Neo4j for essencial
        // process.exit(1); 
    }

    const client = await wppconnect.create({
      session: SESSION_NAME,
      catchQR: (base64Qr, asciiQR) => { console.log('QR Code:\n' + asciiQR); },
      statusFind: (statusSession, session) => {
        console.log('[WPPConnect] Status da Sessão:', statusSession, '- Nome:', session);
        if (statusSession === 'isLogged') console.log('[WPPConnect] Cliente conectado! ✅');
      },
      headless: 'new', // 'new' para novo modo headless do Chrome
      logQR: true,
      autoClose: 0, // Não fechar automaticamente
      puppeteerOptions: { 
        // args: ['--no-sandbox', '--disable-setuid-sandbox'] // Descomentar se rodar como root em certos ambientes
      },
    });
    console.log(`[WPPConnect] Cliente '${client.session}' iniciado.`);

    client.onMessage(async (message) => {
      console.log('--------------------------------------------------');
      const senderName = message.sender.pushname || message.sender.verifiedName || message.notifyName || "Lead";
      const senderId = message.from; // ID do remetente (ex: 55119XXXXXXXX@c.us)
      console.log(`[WhatsApp Msg Rec] De: ${senderId} (${senderName}), Tipo: ${message.type}, ID Msg: ${message.id.toString()}`);
      if(message.body) console.log('[WhatsApp Msg Rec] Conteúdo (se texto):', message.body.substring(0,100));
      console.log('--------------------------------------------------');

      // Ignorar mensagens de status, de grupo, próprias ou revogadas
      if (message.isStatusMsg || message.isGroupMsg || message.fromMe || message.type === 'revoked') {
        console.log(`[Filtro] Mensagem de ${senderId} ignorada (status, grupo, própria ou revogada).`);
        return;
      }

      let userMessagePayload = null;

      // Dispara tool assíncrona: enfileirar análise emocional
      try {
        const { evaluateAndRunTools } = require('./toolsEngine');
        const leadProfile = { idWhatsapp: senderId };
        await evaluateAndRunTools({ eventType: 'afterMessage', leadProfile, messageText: message.body || '' });
      } catch (e) { console.warn('[afterMessage] enqueue emotion failed:', e?.message || e) }

      // Comandos de administração/debug
      if (message.type === 'chat' && message.body) {
        const userCommandText = message.body.trim().toLowerCase();
        if (userCommandText === "/novochat") {
            if (chatSessions[senderId]) {
                // Reinicia a sessão de chat Gemini
                chatSessions[senderId].chat = modelWithTools.startChat({ history: [], generationConfig: generationConfig });
                // Reinicia o planner
                chatSessions[senderId].planner = null; // Será recriado na próxima mensagem
                // Limpa o último texto do usuário para reflexão
                chatSessions[senderId].lastUserMessageText = null;
                // Limpa o histórico de reflexões e hipóteses da sessão
                chatSessions[senderId].reflectionHistory = [];
                chatSessions[senderId].activeHypotheses = [];
                console.log(`[Sistema Comando] Sessão completa para ${senderId} (${senderName}) reiniciada.`);
            }
            // Reseta o estado do debounce para este usuário
            debounceActiveForUser.delete(senderId);
            console.log(`[Debounce Control] Estado de debounce para ${senderId} (${senderName}) resetado por /novochat.`);
            await client.sendText(senderId, `Beleza, ${senderName}! Reiniciamos nosso papo e o planejamento estratégico com o ${NOME_DO_AGENTE}. Pode mandar sua dúvida! 👍`);
            return;
        }
        if (userCommandText === "/verperfil") {
            const perfilAtual = await carregarOuCriarPerfilLead(senderId, senderName);
            if (chatSessions[senderId]) { // Atualiza o perfil na sessão se ela existir
                chatSessions[senderId].perfil = perfilAtual;
            }
            if (perfilAtual) {
                let perfilTexto = `Perfil de ${senderName} (ID: ${senderId}):\n`;
                perfilTexto += `Nome Negócio: ${perfilAtual.nomeDoNegocio || 'N/A'}\n`;
                perfilTexto += `Tipo Negócio: ${perfilAtual.tipoDeNegocio || 'N/A'}\n`;
                perfilTexto += `Dores: ${(perfilAtual.principaisDores || []).join(', ') || 'N/A'}\n`;
                perfilTexto += `Interesses: ${(perfilAtual.interessesEspecificos || []).join(', ') || 'N/A'}\n`;
                perfilTexto += `Soluções Discutidas: ${(perfilAtual.solucoesJaDiscutidas || []).join(', ') || 'N/A'}\n`;
                perfilTexto += `Interesse Reunião: ${perfilAtual.nivelDeInteresseReuniao}\n`;
                perfilTexto += `Último Resumo: ${perfilAtual.ultimoResumoDaSituacao}\n`;
                perfilTexto += `Tags: ${(perfilAtual.tags || []).join(', ') || 'N/A'}\n`;
                if(perfilAtual.notasAdicionais && perfilAtual.notasAdicionais.length > 0) perfilTexto += `Notas: ${perfilAtual.notasAdicionais.join('; ')}\n`;
                if(perfilAtual.historicoDeInteracaoResumido && perfilAtual.historicoDeInteracaoResumido.length > 0) {
                    perfilTexto += `\nHistórico Resumido (últimos):\n`;
                    perfilAtual.historicoDeInteracaoResumido.slice(-5).forEach(h => perfilTexto += `- ${h}\n`);
                }
                perfilTexto += `\nHipóteses Ativas no Perfil: ${(perfilAtual.activeHypotheses || []).map(h => `${h.description} (${h.status || 'ativa'})`).join('; ') || 'Nenhuma'}\n`;
                
                // Adiciona informações do Planner e Reflexão se a sessão existir
                if (chatSessions[senderId]) {
                    const session = chatSessions[senderId];
                    if (session.planner) {
                        const plannerInfo = session.planner;
                        perfilTexto += `\n--- Planner Info ---\n`;
                        perfilTexto += `Plano Ativo: ${plannerInfo.selectedPlanName}\n`;
                        perfilTexto += `Status Plano: ${plannerInfo.status}\n`;
                        const currentStepPlanner = plannerInfo.getCurrentStep();
                        if (currentStepPlanner) {
                            perfilTexto += `Etapa Atual: ${currentStepPlanner.name} (Status: ${currentStepPlanner.status}, Tentativas: ${currentStepPlanner.retries})\n`;
                        } else {
                            perfilTexto += `Etapa Atual: Nenhuma\n`;
                        }
                    }
                    if (session.reflectionHistory && session.reflectionHistory.length > 0) {
                        perfilTexto += `\n--- Última Reflexão ---\n`;
                        const lastRef = session.reflectionHistory[session.reflectionHistory.length - 1];
                        perfilTexto += `Resumo: ${lastRef.resumoDaReflexao || 'N/A'}\n`;
                        perfilTexto += `Próximo Passo Sugerido: ${lastRef.proximoPassoLogicoSugerido || 'N/A'}\n`;
                    }
                     if (session.activeHypotheses && session.activeHypotheses.length > 0) {
                        perfilTexto += `\n--- Hipóteses Ativas (Sessão) ---\n`;
                        session.activeHypotheses.forEach(h => {
                            perfilTexto += `- ${h.description} (Status: ${h.status}, Confiança: ${h.confidence || 'N/A'})\n`;
                        });
                    }
                }
                await client.sendText(senderId, perfilTexto);
            } else {
                await client.sendText(senderId, "Não foi possível carregar seu perfil.");
            }
            return;
        }
        if (userCommandText === "/populartudo") { 
            await popularEsquemasIniciais();
            await popularSocialProofData(); 
            await client.sendText(senderId, "Tentei popular os esquemas de conhecimento e as provas sociais iniciais no Neo4j!");
            return;
        }
        if (userCommandText === "/vermetricas" && globalAnalyticsTracker) { // Comando para ver métricas (simples)
            const metrics = globalAnalyticsTracker.getMetricsForPlan("LeadQualificationToMeeting"); // Exemplo
            let metricsText = `Métricas para o plano "LeadQualificationToMeeting":\n`;
            metricsText += `Total de Reflexões: ${metrics.totalReflections}\n`;
            metricsText += `Passos Concluídos com Sucesso: ${metrics.successfulSteps}\n`;
            metricsText += `Taxa de Sucesso: ${metrics.successRate}%\n`;
            metricsText += `Contagem de Sentimentos: ${JSON.stringify(metrics.sentimentCounts)}\n`;
            await client.sendText(senderId, metricsText);
            return;
        }
      }

      // Processamento normal de mensagens
      if (message.type === 'chat' && message.body) {
        await client.sendSeen(senderId); // Marca como lida
        userMessagePayload = {
            id: message.id.toString(), type: 'text', content: message.body.trim(),
            senderId: senderId, senderName: senderName, timestamp: message.timestamp || Math.floor(Date.now() / 1000)
        };
      } else if ((message.type === 'ptt' || message.type === 'audio') && message.mediaKey) {
        // Lógica para baixar e processar áudio (requer descriptografia e conversão)
        try {
            await client.sendSeen(senderId);
            const buffer = await client.decryptFile(message);
            const base64Audio = buffer.toString('base64');
            userMessagePayload = {
                id: message.id.toString(), type: 'audio', data: base64Audio, mimeType: message.mimetype || 'audio/ogg; codecs=opus',
                senderId: senderId, senderName: senderName, timestamp: message.timestamp || Math.floor(Date.now() / 1000)
            };
            console.log(`[WhatsApp Msg Rec] Áudio de ${senderName} (${senderId}) recebido e convertido para base64.`);
        } catch (audioError) {
            console.error(`[WhatsApp Msg Rec] Erro ao processar áudio de ${senderId}:`, audioError);
            await client.sendText(senderId, `${NOME_DO_AGENTE}: Tive um problema ao processar seu áudio, ${senderName}. Poderia tentar novamente ou enviar como texto?`);
            return;
        }
      } else {
        console.log(`[Filtro] Mensagem de tipo '${message.type}' de ${senderId} não processável.`);
        return;
      }

      // Persist inbound message (user)
      try {
        const neo4jSession = await getSession();
        try {
          const at = Number(message.timestamp ? (message.timestamp * 1000) : Date.now());
          const text = message.body || '';
          if (text && !message.fromMe && !message.isStatusMsg && !message.isGroupMsg) {
            await neo4jSession.run(`
              MERGE (l:Lead {idWhatsapp: $id})
              ON CREATE SET l.nome = $name, l.dtCriacao = timestamp()
              WITH l
              CREATE (m:Message { id: $mid, text: $text, at: $at, role: 'user', direction: 'inbound' })
              CREATE (l)-[:HAS_MESSAGE]->(m)
            `, { id: senderId, name: senderName, mid: String(message.id || `${senderId}-${at}`), text, at: neo4j.int(at) });
          }
        } finally { await neo4jSession.close(); }
      } catch (e) { console.warn('[Persist Inbound] falhou:', e?.message || e); }

      // Lógica de Debounce
      if (userMessagePayload) {
          if (debounceActiveForUser.get(senderId)) {
              console.log(`[Debounce Control] Debounce ATIVO para ${senderName} (${senderId}). Usando handler.`);
              handleDebouncedMessage(userMessagePayload, {
                  delay: DEBOUNCE_DELAY_MS,
                  processFunction: (sId, sName, aggMsgs) => processAndRespondToMessages(client, sId, sName, aggMsgs)
              });
          } else {
              // Se o debounce não está ativo, ativa e processa a primeira mensagem imediatamente.
              // As subsequentes (rápidas) serão agrupadas pelo handleDebouncedMessage.
              console.log(`[Debounce Control] Debounce INATIVO para ${senderName} (${senderId}). Ativando e processando diretamente.`);
              debounceActiveForUser.set(senderId, true); // Ativa o debounce para futuras mensagens
              console.log(`[Debounce Control] Debounce AGORA ATIVO para ${senderName} (${senderId}) para mensagens futuras.`);
              await processAndRespondToMessages(client, senderId, senderName, [userMessagePayload]);
          }
      }
    });
  } catch (error) {
      console.error('[WPPConnect CRITICAL] Erro CRÍTICO ao iniciar o bot:', error);
      // Considerar tentar reiniciar ou notificar um administrador
  }
}

// --- FUNÇÕES PARA POPULAR DADOS NO NEO4J (EXEMPLOS) ---
async function popularEsquemasIniciais() {
    let neo4jSession;
    console.log("[Populando Esquemas] Iniciando população de dados de conhecimento...");
    try {
        neo4jSession = await getSession();
        // Dores Comuns
        await neo4jSession.run(`MERGE (dc1:DorComum {nome: "Baixa Geração de Leads", descricao: "Empresas com dificuldade em atrair novos potenciais clientes de forma consistente.", keywords: ["leads", "poucos clientes", "marketing fraco"]})`);
        await neo4jSession.run(`MERGE (dc2:DorComum {nome: "Processos Manuais Lentos", descricao: "Perda de tempo e eficiência devido a tarefas repetitivas feitas manualmente.", keywords: ["lentidão", "tarefas manuais", "burocracia"]})`);
        await neo4jSession.run(`MERGE (dc3:DorComum {nome: "Dificuldade em Converter Vendas", descricao: "Leads chegam mas o processo de fechamento de negócios não é eficaz.", keywords: ["vendas baixas", "não fecho negócios", "conversão ruim"]})`);
        await neo4jSession.run(`MERGE (dc4:DorComum {nome: "Atendimento ao Cliente Ineficiente", descricao: "Clientes demoram a ser respondidos ou problemas não são resolvidos satisfatoriamente.", keywords: ["atendimento ruim", "demora para responder", "suporte fraco"]})`);
        console.log("[Populando Esquemas] Dores Comuns criadas/verificadas.");

        // Soluções Oferecidas
        await neo4jSession.run(`MERGE (so1:SolucaoOferecida {nome: "Consultoria de Marketing Digital", descricao: "Estratégias personalizadas para aumentar a visibilidade online e gerar mais leads qualificados.", keywords: ["marketing online", "seo", "gerar leads"]})`);
        await neo4jSession.run(`MERGE (so2:SolucaoOferecida {nome: "Automação de Processos com IA", descricao: "Implementação de ferramentas e robôs para automatizar tarefas repetitivas e otimizar o fluxo de trabalho.", keywords: ["ia", "inteligência artificial", "automatizar", "robôs"]})`);
        await neo4jSession.run(`MERGE (so3:SolucaoOferecida {nome: "Treinamento de Vendas Consultivas", descricao: "Capacitação da equipe de vendas com técnicas para melhorar a conversão e o relacionamento com clientes.", keywords: ["treinar vendas", "vender mais", "equipe comercial"]})`);
        await neo4jSession.run(`MERGE (so4:SolucaoOferecida {nome: "Implementação de Chatbots Inteligentes", descricao: "Desenvolvimento de chatbots para atendimento ao cliente 24/7, triagem de leads e respostas rápidas.", keywords: ["chatbot", "atendimento automático", "wpp bot"]})`);
        console.log("[Populando Esquemas] Soluções Oferecidas criadas/verificadas.");

        // Objeções Comuns
        await neo4jSession.run(`MERGE (oc1:ObjecaoComum {nome: "Custo Elevado da Solução", keywords: ["caro", "preço alto", "investimento grande"]})`);
        await neo4jSession.run(`MERGE (oc2:ObjecaoComum {nome: "Falta de Tempo para Implementar", keywords: ["sem tempo", "demorado", "complexo de implementar"]})`);
        await neo4jSession.run(`MERGE (oc3:ObjecaoComum {nome: "Não vejo resultado rápido", keywords: ["resultado rápido", "demora para ver efeito"]})`);
        await neo4jSession.run(`MERGE (oc4:ObjecaoComum {nome: "Minha equipe não vai se adaptar", keywords: ["equipe resistente", "difícil para o time"]})`);
        console.log("[Populando Esquemas] Objeções Comuns criadas/verificadas.");

        // KnowledgeTopics (Novo)
        await neo4jSession.run(`MERGE (kt1:KnowledgeTopic {nome: "Inteligência Artificial para Negócios", descricao: "Como a IA pode ser aplicada para resolver problemas e gerar oportunidades em empresas.", keywords: ["ia nos negócios", "ai", "machine learning"]})`);
        await neo4jSession.run(`MERGE (kt2:KnowledgeTopic {nome: "Otimização de Funil de Vendas", descricao: "Melhorar cada etapa do funil de vendas para aumentar a conversão.", keywords: ["funil de vendas", "jornada do cliente"]})`);
        console.log("[Populando Esquemas] KnowledgeTopics criados/verificados.");

        // Relacionamentos
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Consultoria de Marketing Digital"}), (dc:DorComum {nome: "Baixa Geração de Leads"}) MERGE (so)-[:RESOLVE]->(dc)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Automação de Processos com IA"}), (dc:DorComum {nome: "Processos Manuais Lentos"}) MERGE (so)-[:RESOLVE]->(dc)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Treinamento de Vendas Consultivas"}), (dc:DorComum {nome: "Dificuldade em Converter Vendas"}) MERGE (so)-[:RESOLVE]->(dc)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Implementação de Chatbots Inteligentes"}), (dc:DorComum {nome: "Atendimento ao Cliente Ineficiente"}) MERGE (so)-[:RESOLVE]->(dc)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Automação de Processos com IA"}), (kt:KnowledgeTopic {nome: "Inteligência Artificial para Negócios"}) MERGE (so)-[:RELATES_TO_TOPIC]->(kt)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Consultoria de Marketing Digital"}), (kt:KnowledgeTopic {nome: "Otimização de Funil de Vendas"}) MERGE (so)-[:RELATES_TO_TOPIC]->(kt)`);
        await neo4jSession.run(`MATCH (so:SolucaoOferecida {nome: "Consultoria de Marketing Digital"}), (oc:ObjecaoComum {nome: "Custo Elevado da Solução"}) MERGE (so)-[:PODE_GERAR]->(oc)`);
        // Adicionar mais relações conforme necessário
        console.log("[Populando Esquemas] Relacionamentos de conhecimento criados/verificados.");
    } catch (error) {
        console.error("[Populando Esquemas] Erro ao popular esquemas iniciais:", error);
    } finally {
        if (neo4jSession) await neo4jSession.close();
    }
}

async function popularSocialProofData() {
    let neo4jSession;
    console.log("[Populando Provas Sociais] Iniciando população de dados de prova social...");
    try {
        neo4jSession = await getSession();

        // Indústrias
        await neo4jSession.run(`MERGE (i1:Industry {name: "Varejo Online"})`);
        await neo4jSession.run(`MERGE (i2:Industry {name: "Serviços B2B"})`);
        await neo4jSession.run(`MERGE (i3:Industry {name: "Tecnologia"})`);
        await neo4jSession.run(`MERGE (i4:Industry {name: "Saúde"})`);
        console.log("[Populando Provas Sociais] Indústrias criadas/verificadas.");

        // Provas Sociais (SocialProof)
        await neo4jSession.run(`
            MERGE (sp1:SocialProof {
                type: "case_study",
                summary: "A Loja de Moda XYZ, um e-commerce, aumentou seus leads qualificados em 60% em 3 meses após nossa consultoria de marketing digital focada em SEO e conteúdo.",
                detailsUrl: "http://example.com/case/loja-moda-xyz",
                keywords: ["leads", "marketing digital", "seo", "conteúdo", "e-commerce", "moda"]
            })
            WITH sp1
            MATCH (dc:DorComum {nome: "Baixa Geração de Leads"}) MERGE (sp1)-[:ADDRESSES_PAIN]->(dc)
            MATCH (so:SolucaoOferecida {nome: "Consultoria de Marketing Digital"}) MERGE (sp1)-[:SHOWCASES_SOLUTION]->(so)
            MATCH (i:Industry {name: "Varejo Online"}) MERGE (sp1)-[:TARGETS_INDUSTRY]->(i)
        `);

        await neo4jSession.run(`
            MERGE (sp2:SocialProof {
                type: "testimonial",
                summary: "'Com a automação de processos que o Leo Consultor nos ajudou a implementar, economizamos cerca de 15 horas semanais da equipe administrativa!' - Maria Silva, Gerente da Serviços Eficientes Ltda.",
                keywords: ["automação", "processos", "economia de tempo", "eficiência", "serviços"]
            })
            WITH sp2
            MATCH (dc:DorComum {nome: "Processos Manuais Lentos"}) MERGE (sp2)-[:ADDRESSES_PAIN]->(dc)
            MATCH (so:SolucaoOferecida {nome: "Automação de Processos com IA"}) MERGE (sp2)-[:SHOWCASES_SOLUTION]->(so)
            MATCH (i:Industry {name: "Serviços B2B"}) MERGE (sp2)-[:TARGETS_INDUSTRY]->(i)
        `);

        await neo4jSession.run(`
            MERGE (sp3:SocialProof {
                type: "statistic",
                summary: "Empresas que adotam nossa solução de Automação com IA para tarefas repetitivas relatam, em média, uma redução de 25% nos custos operacionais.",
                keywords: ["ia", "automação", "redução de custos", "custos operacionais"]
            })
            WITH sp3
            MATCH (so:SolucaoOferecida {nome: "Automação de Processos com IA"}) MERGE (sp3)-[:SHOWCASES_SOLUTION]->(so)
            MATCH (kt:KnowledgeTopic {nome: "Inteligência Artificial para Negócios"}) MERGE (sp3)-[:RELATES_TO_TOPIC]->(kt)
        `);

        await neo4jSession.run(`
            MERGE (sp4:SocialProof {
                type: "case_study",
                summary: "A Startup TechInova conseguiu dobrar sua taxa de conversão de trial para pago utilizando nosso treinamento de vendas consultivas focado no mercado SaaS.",
                detailsUrl: "http://example.com/case/techinova-saas",
                keywords: ["vendas consultivas", "conversão", "saas", "startup", "treinamento"]
            })
            WITH sp4
            MATCH (dc:DorComum {nome: "Dificuldade em Converter Vendas"}) MERGE (sp4)-[:ADDRESSES_PAIN]->(dc)
            MATCH (so:SolucaoOferecida {nome: "Treinamento de Vendas Consultivas"}) MERGE (sp4)-[:SHOWCASES_SOLUTION]->(so)
            MATCH (i:Industry {name: "Tecnologia"}) MERGE (sp4)-[:TARGETS_INDUSTRY]->(i)
        `);
        console.log("[Populando Provas Sociais] Nós SocialProof e relacionamentos criados/verificados.");
        console.log("[Populando Provas Sociais] População de dados de prova social concluída!");
    } catch (error) {
        console.error("[Populando Provas Sociais] Erro ao popular dados de prova social:", error);
    } finally {
        if (neo4jSession) {
            await neo4jSession.close();
        }
    }
}


startBot();

// --- ROTINAS DE ENCERRAMENTO GRACIOSO ---
async function gracefulShutdown() {
  console.log('\n[Sistema] Recebido sinal para encerrar. Fechando conexões e cliente WhatsApp...');
  try {
    await closeDriver(); // Fecha a conexão com o Neo4j
    console.log('[Neo4j] Driver do Neo4j fechado com sucesso.');
  } catch (e) {
    console.error('[Neo4j] Erro ao fechar driver do Neo4j:', e);
  }
  // Tenta fechar o cliente wppconnect se existir
  if (typeof wppconnect !== 'undefined' && wppconnect.clientsArray && wppconnect.clientsArray.length > 0) {
    console.log(`[WPPConnect] Tentando fechar ${wppconnect.clientsArray.length} cliente(s) wppconnect...`);
    for (const client of wppconnect.clientsArray) {
      try {
        if (client && typeof client.close === 'function') {
          console.log(`[WPPConnect] Fechando sessão ${client.session || 'desconhecida'}...`);
          await client.close();
          console.log(`[WPPConnect] Sessão ${client.session || 'desconhecida'} fechada.`);
        }
      } catch (e) {
        console.error(`[WPPConnect] Erro ao fechar sessão ${client.session || 'desconhecida'}:`, e.message);
      }
    }
  } else {
    console.log('[WPPConnect] Nenhum cliente wppconnect ativo para fechar.');
  }
  console.log('[Sistema] Processo encerrado.');
  process.exit(0);
}

// Captura sinais de encerramento
process.on('SIGINT', gracefulShutdown); // Ctrl+C
process.on('SIGTERM', gracefulShutdown); // kill

// Captura exceções não tratadas e rejeições de promises
process.on('uncaughtException', (error, origin) => {
  console.error(`!!!!!!!!!! Exceção não capturada: ${error.message} !!!!!!!!!!`, error.stack, `Origem: ${origin}`);
  // Considerar um gracefulShutdown aqui também, dependendo da gravidade
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!!!!!!!! Rejeição de Promise não tratada: !!!!!!!!!!', reason);
  // Considerar um gracefulShutdown
});

module.exports = { popularEsquemasIniciais, popularSocialProofData };

// === UTIL: Remove marcadores internos (PENSAMENTO, AÇÃO, OBSERVAÇÃO) da resposta ===
function sanitizeModelOutputForUser(rawText) {
    if (!rawText) return rawText;
    const lines = rawText.split(/\r?\n/);
    const filtered = lines.filter(line => {
        const l = line.trim().toLowerCase();
        return !(l.startsWith('pensamento') || l.startsWith('ação') || l.startsWith('acao') || l.startsWith('observação') || l.startsWith('observacao') || l.startsWith('thought') || l.startsWith('action') || l.startsWith('observation'));
    });
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n'); // evita múltiplas linhas vazias
}

