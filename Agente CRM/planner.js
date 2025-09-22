// planner.js
const DEFAULT_PLAN_NAME = "LeadQualificationToMeeting";
const MAX_RETRIES_PER_STEP = 2; // Número máximo de tentativas para uma etapa antes de considerar uma falha

// Definição dos planos disponíveis.
const PLANS = {
    "LeadQualificationToMeeting": {
        goal: "Conduzir o lead desde o contato inicial até o agendamento de uma reunião, qualificando-o ao longo do caminho.",
        steps: [
            {
                name: "InitialContactAndPainDiscovery",
                objective: "Estabelecer contato, apresentar-se e começar a identificar a principal dor ou necessidade do lead.",
                guidance_for_llm: "Seu foco neste momento é fazer o lead se sentir ouvido e começar a articular o principal desafio ou motivo do contato. Use o fluxo de 'Conexão e Descoberta Inicial' e 'Identificação e Exploração da Dor' do seu prompt base. Pergunte abertamente sobre o que o lead precisa ou qual problema enfrenta.",
                completion_check: (profile) => {
                    if (!profile) return false;
                    // 1) Dores identificadas explicitamente
                    if (Array.isArray(profile.principaisDores) && profile.principaisDores.length > 0) return true;
                    // 2) Indícios no resumo textual
                    const resumo = String(profile.ultimoResumoDaSituacao || '').toLowerCase();
                    const painHints = [
                        'dor', 'problema', 'perco', 'perda', 'impacto', 'demora', 'atraso', 'filas', 'reclama'
                    ];
                    if (painHints.some(h => resumo.includes(h))) return true;
                    // 3) Tags marcadoras
                    const tags = Array.isArray(profile.tags) ? profile.tags.map(t => String(t).toLowerCase()) : [];
                    if (tags.includes('dor_identificada') || tags.some(t => t.startsWith('pain:'))) return true;
                    return false;
                },
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

    // Marca a etapa atual como concluída e avança para a próxima (sem depender do completion_check)
    completeCurrentStepWithReason(reason = 'manual_complete') {
        const currentStep = this.getCurrentStep();
        if (!currentStep || currentStep.status !== 'active' || this.status !== 'active') return false;
        currentStep.status = 'completed';
        currentStep.retries = 0;
        console.log(`[Planner] Etapa '${currentStep.name}' concluída por '${reason}' para ${this.leadId}.`);
        this.currentStepIndex++;
        if (this.currentStepIndex < this.plan.steps.length) {
            this.plan.steps[this.currentStepIndex].status = 'active';
            console.log(`[Planner] Próxima etapa ATIVA: '${this.getCurrentStep().name}' (Plano: ${this.selectedPlanName}).`);
            return true;
        } else {
            this.status = 'completed';
            console.log(`[Planner] Todas as etapas concluídas para ${this.leadId} (Plano: ${this.selectedPlanName}).`);
            return true;
        }
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

        if (currentStep.status === "active" && typeof currentStep.completion_check === 'function') {
            try {
                if (currentStep.completion_check(updatedLeadProfile)) {
                    currentStep.status = "completed";
                    currentStep.retries = 0; // Resetar tentativas na conclusão
                    console.log(`[Planner] Etapa '${currentStep.name}' CONCLUÍDA para ${this.leadId} (Plano: ${this.selectedPlanName}).`);

                    // Lógica de transição para a próxima etapa
                    let nextStepName = null;
                    if (typeof currentStep.next_step_logic === 'function') {
                        nextStepName = currentStep.next_step_logic(updatedLeadProfile);
                    }

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
                        if (currentStep.on_failure_next_step) {
                            const failureStepIndex = this.plan.steps.findIndex(step => step.name === currentStep.on_failure_next_step);
                            if (failureStepIndex !== -1) {
                                this.currentStepIndex = failureStepIndex;
                                this.plan.steps[this.currentStepIndex].status = "active";
                                console.log(`[Planner] Transicionando para etapa de falha: '${this.getCurrentStep().name}'`);
                            } else {
                                this.status = "failed"; // Falha o plano se a etapa de falha não for encontrada
                                console.error(`[Planner ERROR] Etapa de falha '${currentStep.on_failure_next_step}' não encontrada. Plano '${this.selectedPlanName}' falhou para ${this.leadId}.`);
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
        } else if (currentStep.status === "active" && !currentStep.completion_check) {
             console.warn(`[Planner] Etapa '${currentStep.name}' para ${this.leadId} (Plano: ${this.selectedPlanName}) não possui 'completion_check'. Não é possível avançar/falhar automaticamente esta etapa por verificação.`);
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
