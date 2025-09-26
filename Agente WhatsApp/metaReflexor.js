// metaReflexor.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

class MetaReflexor {
    constructor(analyticsTracker, options = {}) {
        this.analyticsTracker = analyticsTracker;
        this.analysisIntervalMs = options.analysisIntervalMs || 10 * 60 * 1000;
        this.lastAnalysis = null;
        this.timer = null;
        this.latestInsights = null;
        this.geminiApiKey = process.env.GEMINI_API_KEY;
        this.genAI = this.geminiApiKey ? new GoogleGenerativeAI(this.geminiApiKey) : null;
        this.geminiModelName = "gemini-1.5-flash-latest";
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.analyze(), this.analysisIntervalMs);
        this.analyze();
        console.log('[MetaReflexor] Análise periódica iniciada.');
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        console.log('[MetaReflexor] Análise periódica parada.');
    }

    async analyze() {
        const data = this.analyticsTracker.getAllReflectionData();
        if (!data.length) {
            console.log('[MetaReflexor] Nenhum dado de reflexão para analisar.');
            return;
        }
        // 1. Táticas por segmento
        const tacticsBySegment = {};
        // 2. Sentimentos que mais convertem
        const sentimentConversions = {};
        // 3. Padrões de sucesso/fracasso
        let successPatterns = [];
        let failurePatterns = [];
        // 4. Micropersonas
        const micropersonas = {};
        // 5. Táticas exauridas
        const exhaustedTactics = [];
        // 6. Prompt suggestions
        const suggestionsForPrompt = {};
        // 7. Modulação de comportamento (stub)
        const agentBehaviorModulation = [];
        // 8. Clusters de micropersonas
        const micropersonaClusters = this.analyticsTracker.getPatternsForMicropersonas ? this.analyticsTracker.getPatternsForMicropersonas() : [];

        // Agrupamento e contagem
        for (const r of data) {
            // Táticas por segmento
            const seg = r.leadType || 'desconhecido';
            if (!tacticsBySegment[seg]) tacticsBySegment[seg] = {};
            const tactic = r.agentAction || 'desconhecida';
            if (!tacticsBySegment[seg][tactic]) tacticsBySegment[seg][tactic] = { total: 0, success: 0, failures: 0 };
            tacticsBySegment[seg][tactic].total++;
            if (r.stepGoalAchieved) {
                tacticsBySegment[seg][tactic].success++;
            } else {
                tacticsBySegment[seg][tactic].failures++;
            }

            // Sentimento -> conversão
            const sent = r.inferredLeadSentiment || 'desconhecido';
            if (!sentimentConversions[sent]) sentimentConversions[sent] = { total: 0, success: 0 };
            sentimentConversions[sent].total++;
            if (r.stepGoalAchieved) sentimentConversions[sent].success++;

            // Padrões simples de sucesso/fracasso
            if (r.stepGoalAchieved) {
                successPatterns.push({ tactic, seg, sent, step: r.stepName });
            } else {
                failurePatterns.push({ tactic, seg, sent, step: r.stepName });
            }

            // Micropersona clustering
            if (!micropersonas[r.leadId]) {
                micropersonas[r.leadId] = { sentimentos: {}, acoes: {}, segmentos: {}, total: 0 };
            }
            if (r.inferredLeadSentiment) micropersonas[r.leadId].sentimentos[r.inferredLeadSentiment] = (micropersonas[r.leadId].sentimentos[r.inferredLeadSentiment] || 0) + 1;
            if (r.agentAction) micropersonas[r.leadId].acoes[r.agentAction] = (micropersonas[r.leadId].acoes[r.agentAction] || 0) + 1;
            if (r.leadType) micropersonas[r.leadId].segmentos[r.leadType] = (micropersonas[r.leadId].segmentos[r.leadType] || 0) + 1;
            micropersonas[r.leadId].total++;
        }

        // Detectar táticas exauridas/redundantes
        for (const seg in tacticsBySegment) {
            for (const tactic in tacticsBySegment[seg]) {
                const stats = tacticsBySegment[seg][tactic];
                if (stats.total >= 3 && stats.success === 0) {
                    exhaustedTactics.push({ seg, tactic, count: stats.total });
                }
            }
        }

        // Gerar micropersona inferida para cada lead
        const micropersonaInferida = Object.entries(micropersonas).map(([leadId, stats]) => {
            // Pega sentimento, ação e segmento mais frequentes
            const sentimento = this._getDominant(stats.sentimentos);
            const acao = this._getDominant(stats.acoes);
            const segmento = this._getDominant(stats.segmentos);
            // Gera tags e persona
            const tags = [sentimento, acao, segmento].filter(Boolean);
            const persona = this._nomearPersona(sentimento, acao, segmento);
            return {
                leadId,
                persona,
                tags,
                padrao: {
                    sentimentos: Object.keys(stats.sentimentos),
                    acoes: Object.keys(stats.acoes)
                }
            };
        });

        // Sugestões de ajuste de prompt por segmento
        for (const seg in tacticsBySegment) {
            const ajustes = [];
            // Exemplo: se segmento é Varejo, sugerir menos jargão técnico
            if (seg.toLowerCase().includes('varejo')) {
                ajustes.push('Aumentar empatia e reduzir jargões técnicos');
                ajustes.push('Apresentar estudo de caso logo após detecção de dor');
            }
            // Exemplo: se segmento é Serviços, sugerir perguntas abertas
            if (seg.toLowerCase().includes('serviço')) {
                ajustes.push('Usar perguntas abertas e validação de necessidades');
            }
            if (ajustes.length) {
                suggestionsForPrompt[seg] = ajustes;
            }
        }

        // Modulação de comportamento do agente (stub)
        for (const seg in tacticsBySegment) {
            for (const sent in sentimentConversions) {
                const stats = sentimentConversions[sent];
                const rate = stats.success / stats.total;
                if (seg === 'serviços' && sent === 'curioso' && rate > 0.8) {
                    agentBehaviorModulation.push({
                        segmento: seg,
                        sentimento: sent,
                        acao: 'setTaticaPrioritaria',
                        valor: 'exploração guiada',
                        estilo: 'perguntas abertas + validação'
                    });
                }
            }
        }

        // Recomendações narrativas com LLM (Gemini)
        let llmRecommendations = null;
        if (this.genAI) {
            llmRecommendations = await this._generateLLMRecommendations(tacticsBySegment, sentimentConversions, failurePatterns);
        }

        // Recomendações tradicionais
        const recommendations = [];
        for (const seg in tacticsBySegment) {
            for (const tactic in tacticsBySegment[seg]) {
                const stats = tacticsBySegment[seg][tactic];
                const rate = stats.success / stats.total;
                if (stats.total >= 5 && rate > 0.7) {
                    recommendations.push(`Priorizar a tática "${tactic}" para leads do segmento "${seg}" (taxa de sucesso: ${(rate*100).toFixed(1)}%)`);
                }
            }
        }
        for (const sent in sentimentConversions) {
            const stats = sentimentConversions[sent];
            const rate = stats.success / stats.total;
            if (stats.total >= 5 && rate > 0.6) {
                recommendations.push(`Ajustar prompts para estimular sentimento "${sent}" (taxa de conversão: ${(rate*100).toFixed(1)}%)`);
            }
        }
        if (failurePatterns.length > 10) {
            recommendations.push('Revisar padrões de falha recorrentes: verifique se há táticas repetidas sem sucesso ou sentimentos negativos frequentes.');
        }
        for (const exhausted of exhaustedTactics) {
            recommendations.push(`Evitar repetir a tática "${exhausted.tactic}" para leads do segmento "${exhausted.seg}", pois falhou ${exhausted.count} vezes seguidas.`);
        }

        // Recomendações baseadas em clusters de micropersonas
        micropersonaClusters.forEach(cluster => {
            if (cluster.taxaSucesso > 0.7 && cluster.total >= 5) {
                recommendations.push(
                    `Micropersona: Para sentimento '${cluster.sentimento}' e ação '${cluster.acao}', priorize essa abordagem (taxa de sucesso: ${(cluster.taxaSucesso*100).toFixed(1)}%, ${cluster.total} casos)`
                );
            }
        });

        this.latestInsights = {
            timestamp: new Date(),
            tacticsBySegment,
            sentimentConversions,
            successPatterns,
            failurePatterns,
            recommendations,
            micropersonaInferida,
            exhaustedTactics,
            suggestionsForPrompt,
            agentBehaviorModulation,
            llmRecommendations,
            micropersonaClusters,
        };
        this.lastAnalysis = new Date();
        console.log('[MetaReflexor] Análise concluída. Recomendações:', recommendations);
    }

    _getDominant(obj) {
        let max = 0, key = null;
        for (const k in obj) {
            if (obj[k] > max) { max = obj[k]; key = k; }
        }
        return key;
    }

    _nomearPersona(sentimento, acao, segmento) {
        // Lógica simples, pode ser expandida
        if (sentimento === 'cético' && acao === 'prova social') return 'cético racional';
        if (sentimento === 'curioso' && acao === 'exploração guiada') return 'explorador analítico';
        if (sentimento === 'interessado' && segmento === 'varejo') return 'varejista engajado';
        return [sentimento, acao, segmento].filter(Boolean).join('_');
    }

    async _generateLLMRecommendations(tacticsBySegment, sentimentConversions, failurePatterns) {
        if (!this.genAI) return null;
        try {
            const model = this.genAI.getGenerativeModel({ model: this.geminiModelName });
            const prompt = `Você é um analista de performance tática.\nCom base nos seguintes padrões:\nTáticas por segmento: ${JSON.stringify(tacticsBySegment)}\nSentimentos que mais convertem: ${JSON.stringify(sentimentConversions)}\nFalhas recorrentes: ${JSON.stringify(failurePatterns.slice(0,5))}\nQuais são suas recomendações estratégicas?`;
            const result = await model.generateContent(prompt);
            const response = result.response;
            if (response && response.text) {
                return response.text();
            }
            return null;
        } catch (e) {
            console.error('[MetaReflexor] Erro ao gerar recomendações LLM:', e.message);
            return null;
        }
    }

    getLatestInsights() {
        return this.latestInsights;
    }
}

module.exports = { MetaReflexor };