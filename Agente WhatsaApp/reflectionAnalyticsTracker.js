// reflectionAnalyticsTracker.js

/**
 * @typedef {Object} ReflectionDataPoint
 * @property {string} leadId - ID do lead.
 * @property {string} [leadName] - Nome do lead.
 * @property {string} [leadType] - Tipo/segmento do lead (ex: 'varejo', 'serviços').
 * @property {string} planName - Nome do plano estratégico ativo.
 * @property {string} stepName - Nome da etapa do plano no momento da reflexão.
 * @property {string} agentAction - Ação principal realizada pelo agente no turno analisado.
 * @property {boolean} stepGoalAchieved - Se o objetivo da etapa do planner avançou.
 * @property {string} [inferredLeadSentiment] - Sentimento inferido do lead.
 * @property {boolean} [tacticRepetitionDetected] - Se foi detetada repetição tática infrutífera.
 * @property {string} [hypothesisStatus] - Status de uma hipótese principal (ex: 'confirmada', 'descartada').
 * @property {string} [previousReflectionEvaluation] - Avaliação da eficácia da reflexão anterior.
 * @property {Date} timestamp - Data e hora da reflexão.
 * @property {object} rawReflection - O objeto JSON completo da reflexão (para análises mais profundas).
 */

class ReflectionAnalyticsTracker {
    constructor() {
        /** @type {ReflectionDataPoint[]} */
        this.reflectionLog = [];
        console.log("[ReflectionAnalyticsTracker] Instanciado.");
    }

    /**
     * Adiciona um novo ponto de dados de reflexão ao log.
     * @param {ReflectionDataPoint} dataPoint - Os dados da reflexão a serem armazenados.
     */
    addReflectionData(dataPoint) {
        if (!dataPoint || !dataPoint.leadId || !dataPoint.planName || !dataPoint.stepName) {
            console.warn("[ReflectionAnalyticsTracker] Tentativa de adicionar dados de reflexão inválidos ou incompletos:", dataPoint);
            return;
        }
        this.reflectionLog.push({ ...dataPoint, timestamp: new Date() });
        // console.log(`[ReflectionAnalyticsTracker] Dados da reflexão para ${dataPoint.leadId} adicionados. Total de registos: ${this.reflectionLog.length}`);

        // Para demonstração, podemos logar a cada N reflexões
        if (this.reflectionLog.length % 10 === 0) {
            console.log(`[ReflectionAnalyticsTracker] Total de ${this.reflectionLog.length} reflexões registadas.`);
        }
    }

    /**
     * Retorna todos os dados de reflexão.
     * Em um sistema real, isto seria substituído por consultas a uma base de dados.
     * @returns {ReflectionDataPoint[]}
     */
    getAllReflectionData() {
        return [...this.reflectionLog]; // Retorna uma cópia
    }

    /**
     * Exemplo de função para obter métricas agregadas (muito simplificado).
     * Em um sistema real, isto usaria queries mais complexas ou ferramentas de BI.
     * @param {string} planName - O nome do plano para filtrar.
     * @returns {object} Métricas simples.
     */
    getMetricsForPlan(planName) {
        const planReflections = this.reflectionLog.filter(r => r.planName === planName);
        if (planReflections.length === 0) {
            return { planName, totalReflections: 0, successRate: 0, sentimentCounts: {} };
        }

        const successfulSteps = planReflections.filter(r => r.stepGoalAchieved).length;
        const successRate = (successfulSteps / planReflections.length) * 100;

        const sentimentCounts = planReflections.reduce((acc, r) => {
            if (r.inferredLeadSentiment) {
                acc[r.inferredLeadSentiment] = (acc[r.inferredLeadSentiment] || 0) + 1;
            }
            return acc;
        }, {});

        return {
            planName,
            totalReflections: planReflections.length,
            successfulSteps,
            successRate: parseFloat(successRate.toFixed(2)),
            sentimentCounts,
            // Poderia adicionar mais métricas: táticas mais usadas, taxa de repetição, etc.
        };
    }

    /**
     * Limpa todos os dados de reflexão (para fins de teste ou reset).
     */
    clearAllData() {
        this.reflectionLog = [];
        console.log("[ReflectionAnalyticsTracker] Todos os dados de reflexão foram limpos.");
    }

    // Futuramente:
    // - getInsightsFromAggregatedReflections(): Para a Ideia 7, poderia usar uma LLM para analisar this.reflectionLog.
    // - getPatternsForMicropersonas(): Para a Ideia 2, analisaria sentimento vs. ação.
}

module.exports = { ReflectionAnalyticsTracker };
