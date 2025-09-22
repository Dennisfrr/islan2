// planner.js
const { loadPlans, isStepCompleted, pickNextIndex } = require('./planLoader');
const { runToolsForEvent } = require('./toolRunner');
const DEFAULT_PLAN_NAME = "LeadQualificationToMeeting";
const GLOBAL_MAX_RETRIES_PER_STEP = 2; // Fallback se plano/etapa não definirem

class Planner {
    constructor(leadProfile, planName) {
        this.leadId = leadProfile.idWhatsapp;
        this.selectedPlanName = planName || Planner.selectPlanForLead(leadProfile); // Usa o planName fornecido ou seleciona um
        const loaded = loadPlans();
        const plans = loaded || {};
        this.plan = plans[this.selectedPlanName] ? JSON.parse(JSON.stringify(plans[this.selectedPlanName])) : null;

        if (!this.plan) {
            console.error(`[Planner ERROR] Plano '${this.selectedPlanName}' não encontrado para ${this.leadId}. Tentando plano padrão.`);
            this.selectedPlanName = DEFAULT_PLAN_NAME;
            this.plan = plans[this.selectedPlanName] ? JSON.parse(JSON.stringify(plans[this.selectedPlanName])) : null;
            if (!this.plan) {
                // Fallback mínimo para não quebrar execução
                this.plan = {
                    id: DEFAULT_PLAN_NAME,
                    goal: 'Plano padrão mínimo',
                    maxRetriesPerStep: GLOBAL_MAX_RETRIES_PER_STEP,
                    steps: [
                        { name: 'Initial', objective: 'Iniciar', guidance: 'Siga fluxo padrão.', completion: [] }
                    ]
                };
                console.warn(`[Planner WARNING] Usando fallback mínimo para o plano '${DEFAULT_PLAN_NAME}'.`);
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
        // Dispara onEnter da etapa inicial (não bloqueante)
        try { this._triggerTools('onEnter', this.getCurrentStep()); } catch {}
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
            const guidanceText = currentStep.guidance_for_llm || currentStep.guidance || '';
            let guidance = `ORIENTAÇÃO DO PLANNER ESTRATÉGICO (Plano: '${this.selectedPlanName}', Etapa Atual: '${currentStep.name}'): Objetivo da etapa: '${currentStep.objective}'. FOCO DETALHADO: ${guidanceText}`;
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
            try {
            if (currentStep.status === "active" && isStepCompleted(currentStep, updatedLeadProfile)) {
                    currentStep.status = "completed";
                    currentStep.retries = 0; // Resetar tentativas na conclusão
                    console.log(`[Planner] Etapa '${currentStep.name}' CONCLUÍDA para ${this.leadId} (Plano: ${this.selectedPlanName}).`);
                // Dispara ferramentas de conclusão da etapa atual
                try { this._triggerTools('onCompletion', currentStep); } catch {}

                // Transições condicionais declarativas
                const nextIdx = pickNextIndex(currentStep, this.plan, updatedLeadProfile);
                if (nextIdx != null) {
                    this.currentStepIndex = nextIdx;
                    } else {
                        this.currentStepIndex++; // Avanço linear padrão
                    }

                    if (this.currentStepIndex < this.plan.steps.length) {
                        this.plan.steps[this.currentStepIndex].status = "active";
                        console.log(`[Planner] Próxima etapa ATIVA para ${this.leadId}: '${this.getCurrentStep().name}' (Plano: ${this.selectedPlanName}).`);
                    try { this._triggerTools('onEnter', this.getCurrentStep()); } catch {}
                    } else {
                        this.status = "completed";
                        console.log(`[Planner] Todas as etapas do plano '${this.selectedPlanName}' CONCLUÍDAS para ${this.leadId}!`);
                    }
                } else {
                    // Etapa não concluída, incrementar tentativas
                    currentStep.retries = (currentStep.retries || 0) + 1;
                    console.log(`[Planner] Etapa '${currentStep.name}' para ${this.leadId} (Plano: ${this.selectedPlanName}) ainda pendente. Tentativa ${currentStep.retries}.`);

                const stepMax = currentStep.maxRetries !== undefined ? currentStep.maxRetries : currentStep.max_retries;
                const planMax = this.plan.maxRetriesPerStep;
                const maxRetries = (stepMax !== undefined ? stepMax : (planMax !== undefined ? planMax : GLOBAL_MAX_RETRIES_PER_STEP));

                if (currentStep.retries >= maxRetries) {
                        console.warn(`[Planner WARNING] Máximo de tentativas (${currentStep.retries}) atingido para a etapa '${currentStep.name}' do lead ${this.leadId}.`);
                        currentStep.status = "failed";
                    // Dispara ferramentas de falha da etapa atual
                    try { this._triggerTools('onFailure', currentStep); } catch {}

                    const failNext = currentStep.onFailureNextStep || currentStep.on_failure_next_step;
                    if (failNext) {
                        const failureStepIndex = this.plan.steps.findIndex(step => step.name === failNext);
                            if (failureStepIndex !== -1) {
                                this.currentStepIndex = failureStepIndex;
                                this.plan.steps[this.currentStepIndex].status = "active";
                                console.log(`[Planner] Transicionando para etapa de falha: '${this.getCurrentStep().name}'`);
                            try { this._triggerTools('onEnter', this.getCurrentStep()); } catch {}
                            } else {
                                this.status = "failed"; // Falha o plano se a etapa de falha não for encontrada
                            console.error(`[Planner ERROR] Etapa de falha '${failNext}' não encontrada. Plano '${this.selectedPlanName}' falhou para ${this.leadId}.`);
                            }
                        } else {
                            this.status = "failed"; // Falha o plano se não houver etapa de falha definida
                             console.log(`[Planner] Plano '${this.selectedPlanName}' falhou para ${this.leadId} na etapa '${currentStep.name}'.`);
                        }
                    }
                }
            } catch (error) {
            console.error(`[Planner ERROR] Erro ao avaliar regras para a etapa '${currentStep.name}' do lead ${this.leadId}:`, error);
            currentStep.status = "failed";
                this.status = "failed";
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

// Dispara ferramentas declaradas na etapa em background
Planner.prototype._triggerTools = async function(when, step) {
    try {
        const toolsArr = Array.isArray(step && step.tools) ? step.tools : [];
        if (!toolsArr.length) return;
        const ctx = {
            leadId: this.leadId,
            step: step.name,
            planId: this.selectedPlanName,
            profile: null
        };
        runToolsForEvent(toolsArr, when, ctx).then(results => {
            const okCount = results.filter(r => r.ok).length;
            const failCount = results.length - okCount;
            if (results.length) console.log(`[Planner Tools] '${when}' para etapa '${step.name}': ${okCount} ok, ${failCount} falha(s).`);
        }).catch(() => {});
    } catch {}
};

module.exports = { Planner };
