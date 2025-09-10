// planner.js
const DEFAULT_PLAN_NAME = "VehicleProtectionQuoteOnboarding";
const MAX_RETRIES_PER_STEP = 2; // Número máximo de tentativas para uma etapa antes de considerar uma falha
const fs = require('fs');
const path = require('path');

// Definição dos planos disponíveis (padrão embutido, será sobrescrito por JSON se existir)
let PLANS = {
    "VehicleProtectionQuoteOnboarding": {
        goal: "Conduzir o cliente desde a cotação até a adesão da proteção veicular (coleta de dados do veículo, cálculo, proposta, vistoria e ativação).",
        steps: [
            {
                name: "CollectVehicleAndProfileData",
                objective: "Coletar dados essenciais do veículo e do condutor (modelo, ano, placa/cidade, uso principal, CEP) e confirmar dados de cadastro.",
                guidance_for_llm: "Apresente-se como atendente de proteção veicular. Faça perguntas objetivas para coletar: modelo/ano do veículo, cidade/CEP de circulação, uso (particular/app), principais condutores, e dados básicos do cliente. Mantenha mensagens curtas e claras. Se já houver dados no perfil, valide-os. Ao final, peça confirmação para calcular a cotação.",
                completion_check: (profile) => !!(profile && profile.veiculo && profile.veiculo.modelo && profile.veiculo.ano && (profile.veiculo.cidade || profile.veiculo.cep)),
            },
            {
                name: "ProvideQuoteAndOptions",
                objective: "Calcular e apresentar a cotação com opções de cobertura e assistências.",
                guidance_for_llm: "Use a ferramenta 'calculate_vehicle_protection_quote' com os dados coletados. Explique de forma simples o valor mensal, o que está incluso (coberturas/assistências) e opções (ex.: franquias, rastreador, carro reserva). Se o cliente pedir segunda via de boleto, direcione para o fluxo adequado mais à frente.",
                completion_check: (profile) => profile && ((profile.tags && profile.tags.includes("cotacao_calculada")) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("cotação calculada")))
            },
            {
                name: "ProposalAndDocs",
                objective: "Gerar proposta/adesão e orientar sobre documentos necessários.",
                guidance_for_llm: "Se o cliente gostar da cotação, use 'generate_membership_proposal'. Informe documentos necessários (CNH, CRLV, foto do veículo), forma de pagamento e próximos passos. Deixe claro que a proteção começa após vistoria/ativação, conforme política.",
                completion_check: (profile) => profile && ((profile.tags && profile.tags.includes("proposta_gerada")) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("proposta gerada")))
            },
            {
                name: "ScheduleInspection",
                objective: "Agendar a vistoria do veículo.",
                guidance_for_llm: "Proponha datas e janelas para vistoria. Use a ferramenta 'schedule_vehicle_inspection' quando o cliente indicar disponibilidade. Informe local (se aplicável), requisitos e duração aproximada.",
                completion_check: (profile) => profile && ((profile.tags && profile.tags.includes("vistoria_agendada")) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("vistoria agendada")))
            },
            {
                name: "FinalizeMembership",
                objective: "Confirmar ativação da proteção e próximos contatos.",
                guidance_for_llm: "Confirme que a adesão foi concluída/encaminhada para ativação após vistoria e pagamento, conforme política. Oriente sobre como solicitar assistências 24h, emitir 2ª via de boleto e abrir sinistro caso necessário.",
                completion_check: (profile) => profile && ((profile.tags && profile.tags.includes("adesao_concluida")) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("adesão concluída")))
            }
        ]
    },
    "ClaimsOpeningAndFollowUp": {
        goal: "Ajudar o cliente a abrir um sinistro e orientar sobre protocolo, documentos e acompanhamento.",
        steps: [
            {
                name: "TriageAndEligibility",
                objective: "Entender o ocorrido, verificar elegibilidade básica e acionar o fluxo correto (assistência 24h ou abertura de sinistro).",
                guidance_for_llm: "Pergunte de forma empática: o que aconteceu (roubo, colisão, pane), quando, onde e se há vítimas. Se for emergência/assistência, instrua a acionar 24h. Se for sinistro, prossiga para coleta de dados para abertura.",
                completion_check: (profile) => profile && profile.ultimoResumoDaSituacao && /triagem (concluída|concluida)/i.test(profile.ultimoResumoDaSituacao)
            },
            {
                name: "CollectOccurrenceDetails",
                objective: "Coletar dados essenciais do sinistro (data, local, boletim quando aplicável, descrição).",
                guidance_for_llm: "Solicite: data e hora, local, breve descrição, boletim de ocorrência (se aplicável) e contato preferido. Mantenha mensagens curtas e objetivas.",
                completion_check: (profile) => profile && profile.sinistro && profile.sinistro.data && profile.sinistro.local
            },
            {
                name: "OpenClaim",
                objective: "Abrir sinistro e gerar protocolo.",
                guidance_for_llm: "Use 'open_claim_and_get_protocol' com os dados coletados. Compartilhe o protocolo ao cliente e explique próximos passos e documentos."
                ,
                completion_check: (profile) => profile && ((profile.tags && profile.tags.includes("sinistro_aberto")) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("protocolo gerado")))
            },
            {
                name: "FollowUpAndDocs",
                objective: "Orientar sobre documentos e prazos, e combinar próximos contatos.",
                guidance_for_llm: "Envie lista de documentos, prazos estimados e canais de contato. Combine atualização de status e ofereça suporte adicional.",
                completion_check: (profile) => profile && profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("orientações enviadas")
            }
        ]
    },
    "LeadQualificationToMeeting": {
        goal: "Conduzir o lead desde o contato inicial até o agendamento de uma reunião, qualificando-o ao longo do caminho.",
        steps: [
            {
                name: "InitialContactAndPainDiscovery",
                objective: "Estabelecer contato, apresentar-se e começar a identificar a principal dor ou necessidade do lead.",
                guidance_for_llm: "Seu foco neste momento é fazer o lead se sentir ouvido e começar a articular o principal desafio ou motivo do contato. Use o fluxo de 'Conexão e Descoberta Inicial' e 'Identificação e Exploração da Dor' do seu prompt base. Pergunte abertamente sobre o que o lead precisa ou qual problema enfrenta.",
                completion_check: (profile) => profile && profile.principaisDores && profile.principaisDores.length > 0 && profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("dor identificada"),
                on_failure_next_step: null, // Ou poderia ser um nome de etapa específica para lidar com falha na descoberta
            },
            {
                name: "PainDeepDiveAndImpactValidation",
                objective: "Aprofundar na dor identificada, entender seu impacto no negócio do lead e validar a importância dessa dor para ele.",
                guidance_for_llm: "Explore as consequências da dor mencionada. Use o fluxo de 'Aprofundamento na Dor Identificada'. Valide se essa dor é realmente significativa para o lead, perguntando sobre os impactos que ela causa.",
                completion_check: (profile) => profile && profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("impacto da dor discutido"),
            },
            {
                name: "ValuePropositionAndLightSolution",
                objective: "Conectar a dor validada a uma proposta de valor e apresentar uma leve sugestão de como a empresa pode ajudar, possivelmente com prova social.",
                guidance_for_llm: "Faça a transição para como os problemas do lead podem ser resolvidos. Use 'Transição para Valor'. Considere usar a ferramenta 'get_relevant_case_studies_or_social_proof' se o lead parecer cético ou se o perfil indicar que seria útil. Apresente brevemente como sua solução pode ajudar com a dor específica.",
                completion_check: (profile) => profile && ((profile.solucoesJaDiscutidas && profile.solucoesJaDiscutidas.length > 0) || (profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("solução apresentada"))),
                next_step_logic: (profile) => { // Exemplo de lógica de transição condicional
                    if (profile && profile.tags && profile.tags.includes("cético")) {
                        return "ProvideSocialProof"; // Nome de uma etapa hipotética
                    }
                    return null; // Segue para a próxima etapa linear se não houver condição
                }
            },
            // Etapa hipotética para leads céticos
            // {
            //     name: "ProvideSocialProof",
            //     objective: "Apresentar provas sociais (estudos de caso, depoimentos) para aumentar a confiança do lead.",
            //     guidance_for_llm: "O lead parece cético. Use a ferramenta 'get_relevant_case_studies_or_social_proof' para o tópico/dor discutido e apresente os resultados de forma convincente.",
            //     completion_check: (profile) => profile && profile.ultimoResumoDaSituacao && profile.ultimoResumoDaSituacao.toLowerCase().includes("prova social apresentada"),
            // },
            {
                name: "MeetingProposal",
                objective: "Propor uma reunião como o próximo passo lógico para discutir a solução de forma mais aprofundada e personalizada.",
                guidance_for_llm: "Se o lead demonstrou interesse na solução ou no valor apresentado, proponha uma reunião. Use 'Identificando o Momento Ideal para o CTA da Reunião'. Seja claro sobre o objetivo e o baixo compromisso da reunião inicial.",
                completion_check: (profile) => profile && ["médio", "alto", "agendado"].includes(profile.nivelDeInteresseReuniao),
            },
            {
                name: "HandleObjectionsAndSchedule",
                objective: "Lidar com objeções à reunião e, se aceita, facilitar o agendamento.",
                guidance_for_llm: "Se houver objeções à reunião, trate-as com empatia e reforce o valor. Se a reunião for aceita, ajude a agendar. Use 'Tratamento de Objeções e Agendamento'.",
                completion_check: (profile) => profile && profile.nivelDeInteresseReuniao === "agendado",
            }
        ]
    },
    "ColdLeadReEngagement": {
        goal: "Reengajar um lead frio ou que não interage há algum tempo, tentando reacender o interesse.",
        steps: [
            {
                name: "GentleReIntroduction",
                objective: "Reintroduzir-se de forma suave e verificar se o lead tem disponibilidade ou interesse em retomar a conversa.",
                guidance_for_llm: "Seja breve, amigável e não pressione. Lembre o lead quem você é e ofereça algo de valor ou uma pergunta aberta. Ex: 'Olá [Nome do Lead], aqui é o [Seu Nome] da [Sua Empresa]. Estava a pensar se conseguiu avançar com [tópico anterior] ou se surgiu algo novo em que posso ajudar?'",
                completion_check: (profile) => profile && profile.ultimoResumoDaSituacao && (profile.ultimoResumoDaSituacao.toLowerCase().includes("lead respondeu ao reengajamento") || profile.ultimoResumoDaSituacao.toLowerCase().includes("interesse demonstrado")),
            },
            {
                name: "IdentifyCurrentNeedsOrChanges",
                objective: "Se o lead responder positivamente, tentar identificar necessidades atuais ou mudanças desde o último contato.",
                guidance_for_llm: "Pergunte sobre novidades, desafios recentes ou se as prioridades mudaram. O objetivo é encontrar um novo ponto de conexão.",
                completion_check: (profile) => profile && profile.principaisDores && profile.principaisDores.length > 0, // Similar à descoberta de dor
            },
            // ...Poderia seguir para etapas do plano "LeadQualificationToMeeting" ou ter suas próprias etapas de nutrição.
        ]
    }
};

// Carrega planos declarativos de plans.json, se existir
try {
    const p = path.join(__dirname, 'plans.json');
    if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const js = JSON.parse(raw);
        if (js && typeof js === 'object') {
            PLANS = js;
            console.log('[Planner] Planos carregados de plans.json');
        }
    }
} catch (e) {
    console.error('[Planner] Falha ao carregar plans.json:', e.message);
}

class Planner {
    constructor(leadProfile, planName) {
        this.leadId = leadProfile.idWhatsapp;
        this.selectedPlanName = planName || Planner.selectPlanForLead(leadProfile); // Usa o planName fornecido ou seleciona um
        this.plan = JSON.parse(JSON.stringify(PLANS[this.selectedPlanName]));

        if (!this.plan) {
            console.error(`[Planner ERROR] Plano '${this.selectedPlanName}' não encontrado para ${this.leadId}. Tentando plano padrão.`);
            this.selectedPlanName = DEFAULT_PLAN_NAME;
            this.plan = JSON.parse(JSON.stringify(PLANS[this.selectedPlanName]));
            if (!this.plan) {
                throw new Error(`[Planner CRITICAL] Plano padrão '${DEFAULT_PLAN_NAME}' também não encontrado.`);
            }
        }

        this.currentStepIndex = 0;
        this.status = "active"; // "active", "completed", "failed", "paused"
        this.stepRetries = 0; // Contador de tentativas para a etapa atual

        this.plan.steps.forEach(step => {
            step.status = "pending";
            step.retries = 0;
        });

        if (this.plan.steps.length > 0) {
            this.plan.steps[0].status = "active";
        }
        console.log(`[Planner] Novo plano '${this.selectedPlanName}' iniciado para ${this.leadId}. Meta: ${this.plan.goal}. Etapa inicial: ${this.getCurrentStep()?.name || 'N/A'}`);
    }

    getCurrentStep() {
        if (this.currentStepIndex < this.plan.steps.length) {
            return this.plan.steps[this.currentStepIndex];
        }
        return null;
    }

    getGuidanceForLLM(leadProfile) {
        const currentStep = this.getCurrentStep();
        if (currentStep && currentStep.status === "active") {
            let guidance = `ORIENTAÇÃO DO PLANNER ESTRATÉGICO (Plano: '${this.selectedPlanName}', Etapa Atual: '${currentStep.name}'): Objetivo da etapa: '${currentStep.objective}'. FOCO DETALHADO: ${currentStep.guidance_for_llm}`;
            if (currentStep.retries > 0) {
                guidance += `\nAVISO: Esta é a tentativa ${currentStep.retries + 1} para esta etapa. A tentativa anterior não moveu o lead para a conclusão da etapa. Considere uma abordagem diferente ou mais enfática.`;
            }
            if (leadProfile && leadProfile.ultimoResumoDaSituacao) {
                 guidance += `\nCONTEXTO RECENTE DO LEAD: ${leadProfile.ultimoResumoDaSituacao}`;
            }
            return guidance;
        }
        return "ORIENTAÇÃO DO PLANNER ESTRATÉGICO: Nenhum plano ativo ou etapa atual definida. Siga o fluxo padrão do seu system prompt base, mas mantenha o objetivo geral da conversa em mente.";
    }

    checkAndUpdateProgress(updatedLeadProfile) {
        if (this.status !== "active") {
            console.log(`[Planner] Verificação de progresso para ${this.leadId} ignorada. Status do plano: ${this.status}.`);
            return;
        }

        const currentStep = this.getCurrentStep();
        if (!currentStep) {
            this.status = this.plan.steps.every(step => step.status === "completed") ? "completed" : "failed";
            console.log(`[Planner] Plano para ${this.leadId} não tem mais etapas ativas. Status final: ${this.status}`);
            return;
        }

        if (currentStep.status === "active") {
            try {
                const ok = typeof currentStep.completion_check === 'function'
                  ? currentStep.completion_check(updatedLeadProfile)
                  : evaluateCompletionRules(currentStep, updatedLeadProfile);
                if (ok) {
                    currentStep.status = "completed";
                    currentStep.retries = 0; // Resetar tentativas na conclusão
                    console.log(`[Planner] Etapa '${currentStep.name}' CONCLUÍDA para ${this.leadId} (Plano: ${this.selectedPlanName}).`);

                    // Lógica de transição para a próxima etapa
                    let nextStepName = resolveNextStep(currentStep, updatedLeadProfile);

                    if (nextStepName) {
                        const nextStepIndex = this.plan.steps.findIndex(step => step.name === nextStepName);
                        if (nextStepIndex !== -1) {
                            this.currentStepIndex = nextStepIndex;
                        } else {
                            console.warn(`[Planner WARNING] Etapa de transição '${nextStepName}' não encontrada no plano '${this.selectedPlanName}'. Avançando linearmente.`);
                            this.currentStepIndex++;
                        }
                    } else {
                        this.currentStepIndex++; // Avanço linear padrão
                    }

                    if (this.currentStepIndex < this.plan.steps.length) {
                        this.plan.steps[this.currentStepIndex].status = "active";
                        console.log(`[Planner] Próxima etapa ATIVA para ${this.leadId}: '${this.getCurrentStep().name}' (Plano: ${this.selectedPlanName}).`);
                    } else {
                        this.status = "completed";
                        console.log(`[Planner] Todas as etapas do plano '${this.selectedPlanName}' CONCLUÍDAS para ${this.leadId}!`);
                    }
                } else {
                    // Etapa não concluída, incrementar tentativas
                    currentStep.retries = (currentStep.retries || 0) + 1;
                    console.log(`[Planner] Etapa '${currentStep.name}' para ${this.leadId} (Plano: ${this.selectedPlanName}) ainda pendente. Tentativa ${currentStep.retries}.`);

                    if (currentStep.retries >= (currentStep.max_retries !== undefined ? currentStep.max_retries : MAX_RETRIES_PER_STEP)) {
                        console.warn(`[Planner WARNING] Máximo de tentativas (${currentStep.retries}) atingido para a etapa '${currentStep.name}' do lead ${this.leadId}.`);
                        currentStep.status = "failed";
                        const failureName = currentStep.on_failure_next_step || null;
                        if (failureName) {
                            const failureStepIndex = this.plan.steps.findIndex(step => step.name === failureName);
                            if (failureStepIndex !== -1) {
                                this.currentStepIndex = failureStepIndex;
                                this.plan.steps[this.currentStepIndex].status = "active";
                                console.log(`[Planner] Transicionando para etapa de falha: '${this.getCurrentStep().name}'`);
                            } else {
                                this.status = "failed"; // Falha o plano se a etapa de falha não for encontrada
                                console.error(`[Planner ERROR] Etapa de falha '${failureName}' não encontrada. Plano '${this.selectedPlanName}' falhou para ${this.leadId}.`);
                            }
                        } else {
                            this.status = "failed"; // Falha o plano se não houver etapa de falha definida
                             console.log(`[Planner] Plano '${this.selectedPlanName}' falhou para ${this.leadId} na etapa '${currentStep.name}'.`);
                        }
                    }
                }
            } catch (error) {
                console.error(`[Planner ERROR] Erro ao executar completion_check ou lógica de transição para a etapa '${currentStep.name}' do lead ${this.leadId}:`, error);
                currentStep.status = "failed"; // Considera a etapa falha em caso de erro na sua lógica interna
                this.status = "failed";
            }
        }

        if (this.currentStepIndex >= this.plan.steps.length && this.status === "active") {
            this.status = "completed";
            console.log(`[Planner] Verificação final: Plano '${this.selectedPlanName}' para ${this.leadId} marcado como concluído.`);
        }
    }

    isPlanComplete() {
        return this.status === "completed";
    }

    static selectPlanForLead(leadProfile) {
        if (!leadProfile) return DEFAULT_PLAN_NAME;

        // Exemplo de lógica de seleção:
        const tags = leadProfile.tags || [];
        const interesseReuniao = leadProfile.nivelDeInteresseReuniao;
        const ultimoResumo = leadProfile.ultimoResumoDaSituacao || "";

        if (tags.includes("sinistro") || (ultimoResumo && /sinistro|roubo|colis[aã]o|pane/i.test(ultimoResumo))) {
            console.log(`[Planner Select] Selecionando plano 'ClaimsOpeningAndFollowUp' para ${leadProfile.idWhatsapp} devido a menção de sinistro/ocorrência.`);
            return "ClaimsOpeningAndFollowUp";
        }

        if (tags.includes("lead_frio") || (interesseReuniao === "inicial" && ultimoResumo.includes("sem resposta"))) {
            // Poderia verificar a data da última interação aqui também
            console.log(`[Planner Select] Selecionando plano 'ColdLeadReEngagement' para ${leadProfile.idWhatsapp} devido a tags ou inatividade.`);
            return "ColdLeadReEngagement";
        }

        if (tags.includes("cliente_existente") && tags.includes("upsell_oportunidade")) {
            // return "ExistingClientUpsell"; // Plano hipotético
        }

        if (interesseReuniao === "agendado" && ultimoResumo.toLowerCase().includes("aguardando reunião")) {
            // return "PreMeetingReminder"; // Plano hipotético
        }
        
        console.log(`[Planner Select] Selecionando plano padrão '${DEFAULT_PLAN_NAME}' para ${leadProfile.idWhatsapp}.`);
        return DEFAULT_PLAN_NAME;
    }

    // Função para forçar uma etapa específica (útil para testes ou intervenções manuais)
    // static forceStep(plannerInstance, stepName) {
    //     if (!plannerInstance || !plannerInstance.plan || !plannerInstance.plan.steps) return false;
    //     const stepIndex = plannerInstance.plan.steps.findIndex(s => s.name === stepName);
    //     if (stepIndex !== -1) {
    //         if(plannerInstance.getCurrentStep()) plannerInstance.getCurrentStep().status = "skipped"; // Marca a atual como pulada
    //         plannerInstance.currentStepIndex = stepIndex;
    //         plannerInstance.plan.steps[stepIndex].status = "active";
    //         plannerInstance.plan.steps[stepIndex].retries = 0;
    //         plannerInstance.status = "active";
    //         console.log(`[Planner ForceStep] Plano '${plannerInstance.selectedPlanName}' para ${plannerInstance.leadId} forçado para etapa '${stepName}'.`);
    //         return true;
    //     }
    //     console.warn(`[Planner ForceStep] Etapa '${stepName}' não encontrada no plano '${plannerInstance.selectedPlanName}'.`);
    //     return false;
    // }
}

module.exports = { Planner, PLANS };

// Helpers declarativos
function get(obj, pathStr) {
    try { return pathStr.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) } catch { return undefined }
}

function evaluateCompletionRules(step, profile) {
    const rules = step.completion_rules || {}
    if (!rules || Object.keys(rules).length === 0) return false
    if (Array.isArray(rules.requires_profile_fields)) {
        for (const p of rules.requires_profile_fields) {
            const v = get(profile, p)
            if (v === undefined || v === null || v === '') return false
        }
    }
    if (Array.isArray(rules.any_of_profile_fields)) {
        let okAny = false
        for (const p of rules.any_of_profile_fields) {
            const v = get(profile, p)
            if (v !== undefined && v !== null && v !== '') { okAny = true; break }
        }
        if (!okAny) return false
    }
    if (Array.isArray(rules.profile_tags_contains)) {
        const tags = profile?.tags || []
        for (const t of rules.profile_tags_contains) { if (!tags.includes(t)) return false }
    }
    if (Array.isArray(rules.or_text_in_profile_summary)) {
        const sum = String(profile?.ultimoResumoDaSituacao || '').toLowerCase()
        if (!rules.or_text_in_profile_summary.some(s => sum.includes(String(s).toLowerCase()))) return false
    }
    return true
}

function resolveNextStep(step, profile) {
    // Preferir função legacy
    if (typeof step.next_step_logic === 'function') return step.next_step_logic(profile) || null
    const next = step.next_step || null
    if (!next) return null
    if (typeof next === 'string') return next
    // Futuro: condicional declarativa
    return null
}
