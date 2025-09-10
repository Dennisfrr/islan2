// reflectiveAgent.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");

// Configurações para o LLM de reflexão
const REFLECTION_MODEL_NAME = "gemini-1.5-flash-latest";
const REFLECTION_MAX_OUTPUT_TOKENS = 400; // Aumentado para acomodar respostas mais detalhadas
const REFLECTION_TEMPERATURE = 0.5;

// Tipos de Foco para a Reflexão
const ReflectionFocus = {
    GENERAL_PROGRESS: "GENERAL_PROGRESS", // Foco no progresso geral e do planner
    LEAD_SENTIMENT_ENGAGEMENT: "LEAD_SENTIMENT_ENGAGEMENT", // Foco no sentimento e engajamento do lead
    AGENT_TACTIC_EFFECTIVENESS: "AGENT_TACTIC_EFFECTIVENESS" // Foco na eficácia da última tática do agente
};

class ReflectiveAgent {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error("API Key do Gemini é necessária para o ReflectiveAgent.");
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: REFLECTION_MODEL_NAME,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            ],
            generationConfig: {
                maxOutputTokens: REFLECTION_MAX_OUTPUT_TOKENS,
                temperature: REFLECTION_TEMPERATURE,
                responseMimeType: "application/json",
            }
        });
        console.log("[ReflectiveAgent] Instanciado com sucesso.");
    }

    /**
     * Constrói o prompt de reflexão com base no foco desejado.
     * @private
     */
    _buildReflectionPrompt(lastAgentMessage, lastUserMessage, leadProfile, plannerState, conversationHistory, focusType) {
        const plannerContext = plannerState && plannerState.currentStep ?
            `Plano Atual: '${plannerState.selectedPlanName || 'N/A'}'
             Etapa do Plano: '${plannerState.currentStep.name || 'N/A'}' (Status: ${plannerState.currentStep.status || 'N/A'}, Tentativas: ${plannerState.currentStep.retries || 0})
             Objetivo da Etapa: '${plannerState.currentStep.objective || 'N/A'}'
             Status Geral do Plano: '${plannerState.planStatus || 'N/A'}'`
            : "Nenhum plano ativo ou informações do planner disponíveis.";

        const profileSummary = `
            Nome do Lead: ${leadProfile.nomeDoLead}
            Tipo de Negócio: ${leadProfile.tipoDeNegocio || 'N/A'}
            Principais Dores Registradas: ${(leadProfile.principaisDores || []).join(', ') || 'Nenhuma'}
            Nível de Interesse em Reunião: ${leadProfile.nivelDeInteresseReuniao || 'N/A'}
            Último Resumo da Situação no Perfil: ${leadProfile.ultimoResumoDaSituacao || 'N/A'}
            Tags: ${(leadProfile.tags || []).join(', ') || 'Nenhuma'}
        `;

        const formattedHistory = conversationHistory.slice(-5).map(msg => { // Pega os últimos 5 turnos
            const role = msg.role === 'user' ? (leadProfile.nomeDoLead || 'Lead') : 'Agente';
            const text = (msg.parts && msg.parts[0] && msg.parts[0].text) ? msg.parts[0].text : "(Conteúdo não textual)";
            return `${role}: ${text}`;
        }).join('\n');

        let focusSpecificInstructions = "";
        let jsonSchemaDescription = `
            1.  "acaoPrincipalRealizadaPeloAgente": (string) Descreva concisamente a principal ação ou intenção da ÚLTIMA MENSAGEM DO AGENTE.
            2.  "objetivoDaEtapaDoPlannerAvancou": (boolean) O agente conseguiu avançar em direção ao OBJETIVO DA ETAPA ATUAL DO PLANNER com sua última mensagem? (Se não houver planner/etapa, considere o objetivo geral da conversa).
            3.  "justificativaProgressoPlanner": (string) Breve justificativa para o item anterior. Se não avançou, explique porquê.
            4.  "sentimentoInferidoDoLead": (string) Qual o sentimento provável do lead após a última mensagem do agente? (ex: "interessado", "cético", "confuso", "satisfeito", "neutro", "precisa de mais informação", "frustrado").
            5.  "confiancaSentimentoLead": (string, opcional, valores: "alta", "média", "baixa") Qual sua confiança na inferência do sentimento?
            6.  "proximoPassoLogicoSugerido": (string) Com base na situação atual, qual deveria ser o foco ou o próximo passo lógico para o agente na próxima interação para continuar progredindo no plano/conversa?
            7.  "sugestaoDeFerramentaParaProximoPasso": (string, opcional) Se aplicável, sugira uma ferramenta específica (ex: "get_relevant_case_studies_or_social_proof", "analyze_and_update_lead_profile") que o agente deveria considerar usar no próximo turno.
            8.  "necessidadeDeAjusteNaAbordagem": (boolean) A abordagem do agente parece estar no caminho certo ou precisa de algum ajuste (ex: ser mais direto, mais empático, fornecer mais exemplos, mudar de tática)?
            9.  "sugestaoDeAjuste": (string, opcional) Se o item anterior for true, qual ajuste é sugerido?
            10. "principaisPontosDeAtencao": (array de strings) Quaisquer pontos críticos, riscos ou oportunidades que o agente deve ter em mente para a próxima interação.
            11. "resumoDaReflexao": (string) Um resumo conciso de 1-2 frases da sua análise geral.`;

        switch (focusType) {
            case ReflectionFocus.LEAD_SENTIMENT_ENGAGEMENT:
                focusSpecificInstructions = "FOCO DESTA REFLEXÃO: Analise profundamente o SENTIMENTO e o NÍVEL DE ENGAJAMENTO do lead. A resposta do lead (se houver) e o tom da conversa são cruciais. Detalhe sua inferência sobre o sentimento e como o agente pode melhorar a conexão ou adaptar-se ao estado emocional do lead.";
                // Poderia ajustar o jsonSchemaDescription para ter mais campos sobre sentimento aqui
                break;
            case ReflectionFocus.AGENT_TACTIC_EFFECTIVENESS:
                focusSpecificInstructions = "FOCO DESTA REFLEXÃO: Avalie a EFICÁCIA da última ação/tática do agente. A tática escolhida foi apropriada para o contexto e para o objetivo da etapa do planner? Houve alguma consequência inesperada? Que tática alternativa poderia ter sido usada ou deveria ser considerada para o futuro?";
                jsonSchemaDescription += `
            12. "eficaciaDaUltimaTatica": (string, valores: "alta", "média", "baixa", "contraproducente") Avalie a eficácia da última tática do agente.
            13. "justificativaEficaciaTatica": (string) Justifique sua avaliação da eficácia.`;
                break;
            case ReflectionFocus.GENERAL_PROGRESS:
            default:
                focusSpecificInstructions = "FOCO DESTA REFLEXÃO: Avalie o PROGRESSO GERAL da conversa em relação aos objetivos do planner e da interação como um todo. Identifique se a conversa está no caminho certo ou se há desvios.";
                break;
        }

        return `
            Você é um módulo de autoanálise crítica para um agente conversacional consultivo chamado ${process.env.NOME_DO_AGENTE || "Consultor"}.
            Sua tarefa é refletir sobre a última interação entre o Agente e o Lead, e o progresso em relação aos objetivos.
            ${focusSpecificInstructions}

            CONTEXTO DA CONVERSA:
            ---
            Perfil do Lead:
            ${profileSummary}
            ---
            Estado do Planner Estratégico:
            ${plannerContext}
            ---
            ÚLTIMA INTERAÇÃO (Turno Mais Recente):
            Agente: ${lastAgentMessage}
            ${lastUserMessage ? `${leadProfile.nomeDoLead || 'Lead'}: ${lastUserMessage}` : "(Contexto: O agente pode ter iniciado a interação ou o lead ainda não respondeu a esta última mensagem do agente.)"}
            ---
            Histórico Anterior Recente (se houver, mais antigo primeiro):
            ${formattedHistory || "Nenhum histórico anterior fornecido para esta reflexão."}
            ---

            ANÁLISE SOLICITADA:
            Com base no CONTEXTO e no FOCO DESTA REFLEXÃO, responda em formato JSON com as seguintes chaves:
            ${jsonSchemaDescription}

            Exemplo de JSON esperado (pode variar com base no foco):
            {
              "acaoPrincipalRealizadaPeloAgente": "Tentou validar o impacto financeiro da dor X mencionada pelo lead.",
              "objetivoDaEtapaDoPlannerAvancou": true,
              "justificativaProgressoPlanner": "O agente fez uma pergunta direta sobre o impacto, alinhada com o objetivo da etapa de aprofundar na dor.",
              "sentimentoInferidoDoLead": "Reflexivo",
              "confiancaSentimentoLead": "média",
              "proximoPassoLogicoSugerido": "Aguardar a resposta do lead sobre o impacto. Se positivo, conectar com uma solução.",
              "sugestaoDeFerramentaParaProximoPasso": null,
              "necessidadeDeAjusteNaAbordagem": false,
              "sugestaoDeAjuste": null,
              "principaisPontosDeAtencao": ["Se o lead não quantificar o impacto, a dor pode não ser tão significativa."],
              "resumoDaReflexao": "O agente está progredindo bem na etapa de validação da dor. O sentimento do lead parece apropriado."
            }

            Responda APENAS com o objeto JSON. Seja crítico e forneça insights acionáveis.
        `;
    }

    /**
     * Gera uma reflexão sobre a última interação.
     * @param {string} lastAgentMessage A última mensagem enviada pelo agente principal.
     * @param {string} lastUserMessage A última mensagem recebida do usuário (pode ser null).
     * @param {object} leadProfile O perfil atual do lead.
     * @param {object} plannerState O estado atual do planner.
     * @param {Array<object>} conversationHistory Histórico recente da conversa.
     * @param {ReflectionFocus} focusType O tipo de foco para a reflexão (opcional, padrão GENERAL_PROGRESS).
     * @returns {Promise<object|null>} Um objeto com a reflexão estruturada ou null em caso de erro.
     */
    async reflect(lastAgentMessage, lastUserMessage, leadProfile, plannerState, conversationHistory, focusType = ReflectionFocus.GENERAL_PROGRESS) {
        if (!lastAgentMessage || !leadProfile) {
            console.error("[ReflectiveAgent] Mensagem do agente ou perfil do lead ausentes para reflexão.");
            return { error: "Dados insuficientes para reflexão.", details: "Mensagem do agente ou perfil do lead não fornecidos." };
        }
        if (!conversationHistory || !Array.isArray(conversationHistory)) {
            console.warn("[ReflectiveAgent] Histórico da conversa ausente ou em formato inválido. A reflexão pode ser limitada.");
            conversationHistory = []; // Garante que é um array
        }


        const reflectionPrompt = this._buildReflectionPrompt(
            lastAgentMessage,
            lastUserMessage,
            leadProfile,
            plannerState,
            conversationHistory,
            focusType
        );

        try {
            // console.log(`[ReflectiveAgent DEBUG] Prompt para reflexão (Foco: ${focusType}):`, reflectionPrompt);
            const result = await this.model.generateContent(reflectionPrompt);
            const response = result.response;
            
            if (!response || !response.candidates || response.candidates.length === 0) {
                const blockReason = response?.promptFeedback?.blockReason;
                const safetyRatings = response?.promptFeedback?.safetyRatings;
                console.warn(`[ReflectiveAgent] Resposta da LLM de reflexão está vazia ou sem candidatos. Razão do bloqueio: ${blockReason || 'Não especificada'}. Safety Ratings: ${JSON.stringify(safetyRatings)}`);
                return { error: `Resposta vazia ou bloqueada da LLM de reflexão`, details: blockReason ? `Razão: ${blockReason}` : 'Sem candidatos na resposta.' };
            }

            const responseText = response.text(); // .text() é um método síncrono que retorna o texto já disponível
            // console.log("[ReflectiveAgent DEBUG] Resposta crua da LLM de reflexão:", responseText);

            if (responseText) {
                try {
                    const reflectionData = JSON.parse(responseText);
                    console.log(`[ReflectiveAgent] Reflexão (Foco: ${focusType}) gerada para lead ${leadProfile.idWhatsapp}: Ação - '${reflectionData.acaoPrincipalRealizadaPeloAgente || 'N/A'}'`);
                    return reflectionData;
                } catch (parseError) {
                    console.error("[ReflectiveAgent] Erro ao fazer parse do JSON da reflexão:", parseError.message);
                    console.error("[ReflectiveAgent] Resposta recebida que falhou no parse:", responseText.substring(0, 500)); // Loga parte da resposta
                    const jsonMatch = responseText.match(/{[\s\S]*}/);
                    if (jsonMatch && jsonMatch[0]) {
                        try {
                            const fallbackReflectionData = JSON.parse(jsonMatch[0]);
                            console.warn("[ReflectiveAgent] Reflexão extraída com fallback após erro de parse inicial.");
                            return fallbackReflectionData;
                        } catch (fallbackParseError) {
                             console.error("[ReflectiveAgent] Erro no parse do JSON de fallback da reflexão:", fallbackParseError.message);
                        }
                    }
                    return { error: "Falha ao parsear JSON da reflexão", rawResponse: responseText, details: parseError.message };
                }
            } else {
                 // Este caso é menos provável se candidates[0] existir, mas é uma salvaguarda.
                console.warn("[ReflectiveAgent] response.text() retornou vazio, embora houvesse um candidato.");
                return { error: "Resposta textual vazia da LLM de reflexão, mesmo com candidato." };
            }
        } catch (error) {
            console.error(`[ReflectiveAgent] Erro ao chamar LLM para reflexão (Foco: ${focusType}):`, error.message, error.stack);
             if (error.response && error.response.promptFeedback) { // Acesso pode variar dependendo da estrutura do erro da API
                console.error('[ReflectiveAgent] Detalhes do Prompt Feedback da reflexão:', JSON.stringify(error.response.promptFeedback, null, 2));
            }
            return { error: `Erro na API de reflexão: ${error.message}`, details: error.stack };
        }
    }
}

module.exports = { ReflectiveAgent, ReflectionFocus };
