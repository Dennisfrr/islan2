// meaningSupervisor.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } = require("@google/generative-ai");

const INTERPRETATION_MODEL_NAME = "gemini-1.5-flash-latest"; // Pode ser o mesmo modelo ou um otimizado para esta tarefa
const INTERPRETATION_MAX_OUTPUT_TOKENS = 450; // Suficiente para algumas interpretações
const INTERPRETATION_TEMPERATURE = 0.65; // Um pouco mais de criatividade para diversas interpretações

// Definição do Schema para a resposta da LLM de interpretação
// Isto garante que a LLM tentará retornar um JSON no formato esperado.
const interpretationSchema = {
    type: SchemaType.ARRAY,
    items: {
        type: SchemaType.OBJECT,
        properties: {
            interpretation: {
                type: SchemaType.STRING,
                description: "A descrição concisa da interpretação/intenção principal do usuário nesta hipótese."
            },
            keywordsInUserMessage: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: "Array de palavras-chave ou frases curtas da mensagem do usuário que suportam esta interpretação."
            },
            confidenceScore: {
                type: SchemaType.NUMBER,
                description: "Nível de confiança estimado para esta interpretação (0.0 a 1.0). Seja crítico."
            },
            suggestedAgentFocus: {
                type: SchemaType.STRING,
                description: "Dada esta interpretação, qual deveria ser o foco principal da próxima resposta do agente? (ex: 'Esclarecer dúvida X', 'Validar objeção Y', 'Aprofundar na dor Z', 'Coletar informação sobre W')."
            },
            potentialUserGoal: {
                type: SchemaType.STRING,
                description: "Qual o objetivo mais provável do usuário ao enviar esta mensagem, de acordo com esta interpretação?"
            },
            emotionalToneHint: {
                type: SchemaType.STRING,
                description: "Uma breve sugestão sobre o tom emocional percebido nesta interpretação (ex: 'frustrado', 'curioso', 'cético', 'decidido', 'neutro')."
            }
        },
        required: ["interpretation", "keywordsInUserMessage", "confidenceScore", "suggestedAgentFocus", "potentialUserGoal", "emotionalToneHint"]
    }
};

// Configurações de segurança (geralmente as mesmas do agente principal)
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

class MeaningSupervisor {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error("API Key do Gemini é necessária para o MeaningSupervisor.");
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: INTERPRETATION_MODEL_NAME,
            safetySettings: safetySettings,
            generationConfig: {
                maxOutputTokens: INTERPRETATION_MAX_OUTPUT_TOKENS,
                temperature: INTERPRETATION_TEMPERATURE,
                responseMimeType: "application/json", // Crucial para usar o schema
                responseSchema: interpretationSchema,   // Aplicar o schema definido
            }
        });
        console.log("[MeaningSupervisor] Instanciado com sucesso.");
    }

    /**
     * Constrói o prompt para a LLM gerar interpretações latentes.
     * @private
     * @param {string} userMessageText - A mensagem do usuário.
     * @param {object} leadProfile - O perfil do lead.
     * @param {string} shortConversationHistoryText - Um breve resumo do histórico recente.
     * @returns {string} O prompt formatado.
     */
    _buildInterpretationPrompt(userMessageText, leadProfile, shortConversationHistoryText) {
        const profileSummary = leadProfile ? `
            Informações sobre o Lead (Nome: ${leadProfile.nomeDoLead || 'N/A'}):
            - Tipo de Negócio: ${leadProfile.tipoDeNegocio || 'Não informado'}
            - Dores Registradas: ${(leadProfile.principaisDores || []).join(', ') || 'Nenhuma'}
            - Último Resumo da Situação: ${leadProfile.ultimoResumoDaSituacao || 'N/A'}
            - Tags: ${(leadProfile.tags || []).join(', ') || 'Nenhuma'}
            - Hipóteses Ativas sobre o Lead: ${(leadProfile.activeHypotheses || []).map(h => h.description).join('; ') || 'Nenhuma'}
        ` : "Nenhum perfil de lead disponível.";

        return `
            Você é um especialista em análise de diálogo e inferência de intenção.
            Sua tarefa é analisar a MENSAGEM DO USUÁRIO abaixo, considerando o CONTEXTO DO LEAD e o HISTÓRICO DA CONVERSA,
            e gerar de 2 a 3 hipóteses plausíveis sobre o significado ou intenção subjacente da mensagem do usuário.

            MENSAGEM DO USUÁRIO:
            "${userMessageText}"

            CONTEXTO DO LEAD:
            ${profileSummary}

            HISTÓRICO RECENTE DA CONVERSA (últimos turnos):
            ${shortConversationHistoryText || "Nenhum histórico recente fornecido."}

            Para cada hipótese, forneça:
            1.  "interpretation": Uma descrição concisa da interpretação/intenção.
            2.  "keywordsInUserMessage": Palavras-chave da mensagem do usuário que suportam esta interpretação.
            3.  "confidenceScore": Seu nível de confiança (0.0 a 1.0) de que esta é a interpretação correta. Seja realista.
            4.  "suggestedAgentFocus": Dada esta interpretação, qual deveria ser o foco da próxima resposta do agente principal?
            5.  "potentialUserGoal": Qual o objetivo mais provável do usuário com esta mensagem, segundo esta interpretação?
            6.  "emotionalToneHint": Uma sugestão do tom emocional percebido (ex: 'frustrado', 'curioso', 'cético').

            Retorne sua análise como um array de objetos JSON, seguindo o schema fornecido.
            Priorize interpretações que sejam acionáveis e distintas entre si. Evite redundâncias.
            Se a mensagem for muito simples ou direta, você pode gerar apenas uma interpretação com alta confiança.
        `;
    }

    /**
     * Obtém interpretações latentes da mensagem do usuário.
     * @param {string} userMessageText - Texto da mensagem do usuário.
     * @param {object} leadProfile - Perfil atual do lead.
     * @param {Array<object>} conversationHistory - Histórico de mensagens da sessão de chat (formato Gemini).
     * @returns {Promise<Array<object>|null>} Um array de objetos de interpretação ou null em caso de erro.
     */
    async getLatentInterpretations(userMessageText, leadProfile, conversationHistory = []) {
        if (!userMessageText) {
            console.warn("[MeaningSupervisor] userMessageText não fornecido.");
            return null;
        }

        // Formata um breve histórico da conversa para o prompt
        let shortConversationHistoryText = "Nenhum histórico relevante recente.";
        if (conversationHistory && conversationHistory.length > 0) {
            shortConversationHistoryText = conversationHistory.slice(-4) // Pega os últimos 4 turnos (2 do usuário, 2 do modelo)
                .map(msg => {
                    const role = msg.role === 'user' ? (leadProfile?.nomeDoLead || 'Usuário') : 'Agente';
                    const text = (msg.parts && msg.parts[0] && msg.parts[0].text) ? msg.parts[0].text.substring(0, 150) + (msg.parts[0].text.length > 150 ? '...' : '') : "(Conteúdo não textual)";
                    return `${role}: ${text}`;
                })
                .join('\n');
        }

        const prompt = this._buildInterpretationPrompt(userMessageText, leadProfile, shortConversationHistoryText);

        try {
            // console.log("[MeaningSupervisor DEBUG] Prompt para interpretação:", prompt);
            const result = await this.model.generateContent(prompt);
            const response = result.response;

            if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content || !response.candidates[0].content.parts || !response.candidates[0].content.parts[0].text) {
                 const blockReason = response?.promptFeedback?.blockReason;
                 const safetyRatings = response?.promptFeedback?.safetyRatings;
                 console.warn(`[MeaningSupervisor] Resposta da LLM de interpretação está vazia, bloqueada ou mal formatada. Razão: ${blockReason || 'Não especificada'}. Safety: ${JSON.stringify(safetyRatings)}`);
                 return [{
                    interpretation: "Interpretação padrão devido a erro ou resposta vazia da LLM de análise de significado.",
                    keywordsInUserMessage: [],
                    confidenceScore: 0.1,
                    suggestedAgentFocus: "Responder diretamente à mensagem do usuário da forma mais literal possível.",
                    potentialUserGoal: "Obter uma resposta direta.",
                    emotionalToneHint: "neutro"
                 }];
            }
            
            // A resposta já deve ser um JSON parseado devido ao responseMimeType e responseSchema
            // Mas o conteúdo real está em response.candidates[0].content.parts[0].text, que a API espera que seja um JSON string
            // que precisa ser parseado se o schema não for perfeitamente aplicado pela LLM (o que pode acontecer)
            let interpretations;
            try {
                // O SDK do Gemini com responseSchema deve retornar o JSON já parseado no `parts[0].text` se a LLM aderir ao schema.
                // No entanto, a documentação e a prática mostram que às vezes ele ainda vem como string.
                // Se `response.text()` estivesse disponível e retornasse o JSON já parseado, seria ideal.
                // Vamos assumir que `parts[0].text` contém o JSON string.
                const jsonText = response.candidates[0].content.parts[0].text;
                interpretations = JSON.parse(jsonText);

                if (!Array.isArray(interpretations)) { // Validação extra
                    console.warn("[MeaningSupervisor] Resposta da LLM de interpretação não foi um array JSON como esperado. Resposta:", interpretations);
                    throw new Error("Formato de resposta inválido.");
                }

            } catch (parseError) {
                console.error("[MeaningSupervisor] Erro ao fazer parse do JSON das interpretações:", parseError);
                console.error("[MeaningSupervisor] Resposta recebida que falhou no parse:", response.candidates[0].content.parts[0].text);
                 return [{
                    interpretation: "Falha ao processar múltiplas interpretações. Procedendo com abordagem padrão.",
                    keywordsInUserMessage: [],
                    confidenceScore: 0.1,
                    suggestedAgentFocus: "Responder diretamente à mensagem do usuário.",
                    potentialUserGoal: "Obter uma resposta direta.",
                    emotionalToneHint: "neutro"
                 }];
            }
            
            console.log(`[MeaningSupervisor] ${interpretations.length} interpretações geradas para a mensagem do usuário.`);
            return interpretations.sort((a, b) => b.confidenceScore - a.confidenceScore); // Ordena por confiança descendente

        } catch (error) {
            console.error(`[MeaningSupervisor] Erro ao chamar LLM para interpretação:`, error);
            if (error.response && error.response.promptFeedback) {
                console.error('[MeaningSupervisor] Detalhes do Prompt Feedback:', JSON.stringify(error.response.promptFeedback, null, 2));
            }
            // Retorna uma interpretação de fallback em caso de erro grave
            return [{
                interpretation: "Erro interno ao gerar interpretações. Abordagem padrão.",
                keywordsInUserMessage: [],
                confidenceScore: 0.05,
                suggestedAgentFocus: "Responder à mensagem do usuário de forma cautelosa e direta.",
                potentialUserGoal: "Desconhecido devido a erro.",
                emotionalToneHint: "neutro"
            }];
        }
    }
}

module.exports = { MeaningSupervisor };
