// reflectiveAgent.js
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, SchemaType } = require("@google/generative-ai");
const goalsEngine = require('./goalsEngine');

// Configurações para o LLM de reflexão
const REFLECTION_MODEL_NAME = "gemini-1.5-flash-latest";
const REFLECTION_MAX_OUTPUT_TOKENS = 400; // Aumentado para acomodar respostas mais detalhadas
const REFLECTION_TEMPERATURE = 0.5;

// Tipos de Foco para a Reflexão
const ReflectionFocus = {
    GENERAL_PROGRESS: "GENERAL_PROGRESS", // Foco no progresso geral e do planner
    LEAD_SENTIMENT_ENGAGEMENT: "LEAD_SENTIMENT_ENGAGEMENT", // Foco no sentimento e engajamento do lead
    AGENT_TACTIC_EFFECTIVENESS: "AGENT_TACTIC_EFFECTIVENESS", // Foco na eficácia da última tática do agente
    PLAN_ALIGNMENT_AND_RISKS: "PLAN_ALIGNMENT_AND_RISKS", // Avaliar alinhamento com plano atual e riscos/desvios
};

class ReflectiveAgent {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error("API Key do Gemini é necessária para o ReflectiveAgent.");
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        // Schema para forçar JSON estruturado
        /** @type {any} */
        const reflectionSchema = {
            type: SchemaType.OBJECT,
            properties: {
                acaoPrincipalRealizadaPeloAgente: { type: SchemaType.STRING },
                objetivoDaEtapaDoPlannerAvancou: { type: SchemaType.BOOLEAN },
                justificativaProgressoPlanner: { type: SchemaType.STRING },
                sentimentoInferidoDoLead: { type: SchemaType.STRING, description: "Enum: interessado | cético | confuso | satisfeito | neutro | precisa de mais informação | frustrado" },
                confiancaSentimentoLead: { type: SchemaType.STRING, description: "Enum: alta | média | baixa" },
                confidenceScore: { type: SchemaType.NUMBER, description: "Confiança numérica 0.0–1.0 para o sentimento inferido" },
                proximoPassoLogicoSugerido: { type: SchemaType.STRING },
                sugestaoDeFerramentaParaProximoPasso: { type: SchemaType.STRING },
                necessidadeDeAjusteNaAbordagem: { type: SchemaType.BOOLEAN },
                sugestaoDeAjuste: { type: SchemaType.STRING },
                principaisPontosDeAtencao: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                resumoDaReflexao: { type: SchemaType.STRING },
                proximaPerguntaDeAltoValor: { type: SchemaType.STRING },
                stepFit: { type: SchemaType.OBJECT, properties: { matchesStep: { type: SchemaType.BOOLEAN }, missingInfo: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } } }, required: ["matchesStep", "missingInfo"] },
                // --- Campos opcionais adicionais para enriquecer o follow-up ---
                emocaoInferida: { type: SchemaType.STRING, description: "Enum: raiva | urgencia | confianca | hesitacao | neutro | frustrado | animado" },
                emocaoConfianca: { type: SchemaType.NUMBER, description: "0.0–1.0" },
                intencaoDetectada: { type: SchemaType.STRING, description: "Enum: marcar_reuniao | pedir_proposta | pedir_desconto | objeção | followup | pos_venda | indeciso" },
                objeçõesDetectadas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING, description: "Enum: preco | timing | concorrencia | desinteresse | complexidade" } },
                nivelDeConsciencia: { type: SchemaType.STRING, description: "Enum: inconsciente | problema | solucao | produto | decisao" },
                conscienciaConfianca: { type: SchemaType.NUMBER, description: "0.0–1.0" },
                mensagemSugerida: { type: SchemaType.STRING, description: "Mensagem curta (<=420 chars) para follow-up" },
                canalRecomendado: { type: SchemaType.STRING, description: "Enum: whatsapp | email | ligacao" },
            },
            required: [
                "acaoPrincipalRealizadaPeloAgente",
                "objetivoDaEtapaDoPlannerAvancou",
                "justificativaProgressoPlanner",
                "sentimentoInferidoDoLead",
                "proximoPassoLogicoSugerido",
                "necessidadeDeAjusteNaAbordagem",
                "principaisPontosDeAtencao",
                "resumoDaReflexao",
                "stepFit",
            ],
        };
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
                responseSchema: reflectionSchema,
            }
        });
        console.log("[ReflectiveAgent] Instanciado com sucesso.");
    }

    /**
     * Constrói o prompt de reflexão com base no foco desejado.
     * @private
     */
    _buildReflectionPrompt(lastAgentMessage, lastUserMessage, leadProfile, plannerState, conversationHistory, focusType, previousReflections = [], activeHypotheses = []) {
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
            case ReflectionFocus.PLAN_ALIGNMENT_AND_RISKS:
                focusSpecificInstructions = "FOCO DESTA REFLEXÃO: Verifique o ALINHAMENTO da última interação com o PLANO/ETAPA atuais. Liste riscos e desvios, e indique se é prudente PAUSAR, RETENTAR a etapa com ajuste, ou PIVOTAR para outra etapa/plano. Sugira um racional curto para a decisão.";
                jsonSchemaDescription += `
            12. "alinhadoAoPlano": (boolean) A interação está alinhada à etapa/objetivo do plano?
            13. "riscosIdentificados": (array de strings, máx. 3) Riscos ou desvios relevantes.
            14. "sugestaoDeRota": (string, valores: "continuar", "retentar_com_ajuste", "pausar", "pivotar") Rota sugerida.
            15. "racionalRota": (string) Justificativa concisa para a rota.`;
                break;
            case ReflectionFocus.GENERAL_PROGRESS:
            default:
                focusSpecificInstructions = "FOCO DESTA REFLEXÃO: Avalie o PROGRESSO GERAL da conversa em relação aos objetivos do planner e da interação como um todo. Identifique se a conversa está no caminho certo ou se há desvios.";
                break;
        }

        // Instruções dinâmicas de estilo/persona
        let personaInstructions = "";
        if (leadProfile.personaInferida) {
            personaInstructions += `\nIMPORTANTE: O lead foi classificado como uma micropersona do tipo '${leadProfile.personaInferida}'.\nAdapte seu tom, exemplos e abordagem para maximizar conexão e eficácia com esse perfil.`;
        }
        if (leadProfile.tags && leadProfile.tags.length) {
            personaInstructions += `\nTags comportamentais do lead: ${leadProfile.tags.join(', ')}.`;
        }
        // Integração com recomendações do MetaReflexor
        if (typeof global !== 'undefined' && global.globalMetaReflexor && typeof global.globalMetaReflexor.getLatestInsights === 'function') {
            const insights = global.globalMetaReflexor.getLatestInsights();
            if (insights && insights.suggestionsForPrompt) {
                // Por segmento
                if (leadProfile.tipoDeNegocio && insights.suggestionsForPrompt[leadProfile.tipoDeNegocio]) {
                    personaInstructions += `\nSugestões estratégicas para este segmento: ${insights.suggestionsForPrompt[leadProfile.tipoDeNegocio].join('; ')}`;
                }
                // Por persona
                if (leadProfile.personaInferida && insights.suggestionsForPrompt[leadProfile.personaInferida]) {
                    personaInstructions += `\nSugestões estratégicas para esta persona: ${insights.suggestionsForPrompt[leadProfile.personaInferida].join('; ')}`;
                }
            }
        }

        // Truncagem defensiva para evitar prompts muito longos
        const _t = (s, n = 600) => (s ? String(s).slice(0, n) : "");

        // Resumo de reflexões anteriores (anti-repetição) e hipóteses ativas
        const previousReflectionsSummary = Array.isArray(previousReflections) && previousReflections.length
          ? previousReflections.slice(-2).map((r, i) => {
              const a = _t(r.acaoPrincipalRealizadaPeloAgente || '', 120);
              const aj = _t(r.sugestaoDeAjuste || '', 120);
              const nx = _t(r.proximoPassoLogicoSugerido || '', 120);
              return `#${i+1} acao='${a}' ajuste='${aj}' next='${nx}'`;
            }).join("\n")
          : "Nenhuma";
        const activeHypothesesSummary = Array.isArray(activeHypotheses) && activeHypotheses.length
          ? activeHypotheses.slice(-5).map((h, i) => `#${i+1} ${_t(h.description || h.interpretation || h.tipo || JSON.stringify(h)).replace(/\n/g,' ')}` ).join("\n")
          : "Nenhuma";

        // Hints a partir do estado das metas (goals) — metas off_track → orientação sintética
        let goalHints = "";
        try {
            const snaps = (typeof goalsEngine.getSnapshots === 'function') ? goalsEngine.getSnapshots() : [];
            const gs = (typeof goalsEngine.getGoals === 'function') ? goalsEngine.getGoals() : [];
            const latestById = new Map();
            for (const s of snaps) {
                const prev = latestById.get(s.id);
                if (!prev || Number(s.at||0) > Number(prev.at||0)) latestById.set(s.id, s);
            }
            const off = Array.from(latestById.values()).filter(s => s.status === 'off_track');
            if (off.length) {
                const lines = off.slice(0, 3).map(s => {
                    const g = gs.find(x => x.id === s.id);
                    // tenta usar hint de prompt_mod, se existir
                    const hint = Array.isArray(g?.actionsOnBreach) ? (g.actionsOnBreach.find(a => a.type === 'prompt_mod')?.hint || null) : null;
                    const base = `Meta '${g?.title || s.id}' off-track (valor: ${Number.isFinite(s.value)?s.value:'N/A'} vs alvo: ${s.target}).`;
                    return hint ? `${base} Sugestão: ${hint}` : base;
                });
                goalHints = `\n[GOAL HINTS]\n${lines.join('\n')}`;
            }
        } catch {}
        const emotionCtx = leadProfile && (leadProfile.emotionalState || leadProfile.estadoEmocional)
          ? `\nEstado Emocional Atual: ${leadProfile.emotionalState || leadProfile.estadoEmocional} (conf: ${leadProfile.emotionalConfidence ?? 'N/A'})`
          : '';
        const decisionCtx = leadProfile && (leadProfile.decisionProfile || leadProfile.decisionProfileSecondary)
          ? `\nPerfil de Decisão: ${leadProfile.decisionProfile}${leadProfile.decisionProfileSecondary ? ` (sec: ${leadProfile.decisionProfileSecondary})` : ''}`
          : '';
        const precallCtx = leadProfile && (leadProfile.precallSummary || (leadProfile.precallQuestions && leadProfile.precallQuestions.length))
          ? `\nPré-call: ${_t(leadProfile.precallSummary || '')}${Array.isArray(leadProfile.precallQuestions) ? `\nPerguntas pré-call: ${leadProfile.precallQuestions.slice(0,3).join(' | ')}` : ''}`
          : '';

        return `
            Você é um módulo de autoanálise crítica para um agente conversacional consultivo chamado ${process.env.NOME_DO_AGENTE || "Consultor"}.
            ${personaInstructions}
            Sua tarefa é refletir sobre a última interação entre o Agente e o Lead, e o progresso em relação aos objetivos.
            ${focusSpecificInstructions}
            ${goalHints}

            CONTEXTO DA CONVERSA:
            ---
            Perfil do Lead:
            ${profileSummary}
            Info Dinâmica:${emotionCtx}${decisionCtx}${precallCtx}
            ---
            Histórico de Reflexões Recentes (anti-repetição):
            ${previousReflectionsSummary}
            ---
            Hipóteses Ativas:
            ${activeHypothesesSummary}
            ---
            Estado do Planner Estratégico:
            ${plannerContext}
            ---
            ÚLTIMA INTERAÇÃO (Turno Mais Recente):
            Agente: ${_t(lastAgentMessage)}
            ${lastUserMessage ? `${leadProfile.nomeDoLead || 'Lead'}: ${_t(lastUserMessage)}` : "(Contexto: O agente pode ter iniciado a interação ou o lead ainda não respondeu a esta última mensagem do agente.)"}
            ---
            Histórico Anterior Recente (se houver, mais antigo primeiro):
            ${formattedHistory || "Nenhum histórico anterior fornecido para esta reflexão."}
            ---

            ANÁLISE SOLICITADA:
            Com base no CONTEXTO e no FOCO DESTA REFLEXÃO, responda em formato JSON com as seguintes chaves:
            ${jsonSchemaDescription}
            12. "proximaPerguntaDeAltoValor": (string) Uma pergunta específica e curta que gere máximo valor no próximo turno.
            13. "stepFit": (obj) Avalie aderência à etapa atual do planner: { matchesStep: boolean, missingInfo: string[] }.
            14. Campos OPCIONAIS adicionais para enriquecer follow-up (somente preencha quando claro):
                - "emocaoInferida": enum { raiva, urgencia, confianca, hesitacao, neutro, frustrado, animado }
                - "emocaoConfianca": número 0..1
                - "intencaoDetectada": enum { marcar_reuniao, pedir_proposta, pedir_desconto, objeção, followup, pos_venda, indeciso }
                - "objeçõesDetectadas": array de enums { preco, timing, concorrencia, desinteresse, complexidade }
                - "nivelDeConsciencia": enum { inconsciente, problema, solucao, produto, decisao }
                - "conscienciaConfianca": número 0..1
                - "mensagemSugerida": string (<= 420 chars) — uma mensagem curta e específica para WhatsApp
                - "canalRecomendado": enum { whatsapp, email, ligacao }
            Regras: use valores de sentimento dentre os listados; limite "principaisPontosDeAtencao" a no máximo 3 itens; evite repetir a mesma tática/reflexão das últimas interações — gere uma alternativa quando detectar repetição; seja específico e acionável.

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
    async reflect(lastAgentMessage, lastUserMessage, leadProfile, plannerState, conversationHistory, focusType = ReflectionFocus.GENERAL_PROGRESS, previousReflections = [], activeHypotheses = []) {
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
            focusType,
            previousReflections,
            activeHypotheses
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
                    let reflectionData = JSON.parse(responseText);
                    reflectionData = this._normalizeReflection(reflectionData);
                    console.log(`[ReflectiveAgent] Reflexão (Foco: ${focusType}) gerada para lead ${leadProfile.idWhatsapp}: Ação - '${reflectionData.acaoPrincipalRealizadaPeloAgente || 'N/A'}'`);
                    return reflectionData;
                } catch (parseError) {
                    console.error("[ReflectiveAgent] Erro ao fazer parse do JSON da reflexão:", parseError.message);
                    console.error("[ReflectiveAgent] Resposta recebida que falhou no parse:", responseText.substring(0, 500)); // Loga parte da resposta
                    // Tentativa 1: reparar escapes inválidos (e.g., \\u sem 4 hexdígitos, barras invertidas soltas)
                    const repairedFull = this._repairJsonString(responseText);
                    if (repairedFull && repairedFull !== responseText) {
                        try {
                            const repairedData = JSON.parse(repairedFull);
                            console.warn("[ReflectiveAgent] Reflexão parseada após reparo de escapes.");
                            return this._normalizeReflection(repairedData);
                        } catch {}
                    }
                    // Tentativa 2: extrair primeiro JSON balanceado (longo) do texto reparado
                    const balancedFromRepaired = this._extractBalancedJson(repairedFull || responseText);
                    if (balancedFromRepaired) {
                        try {
                            const data = JSON.parse(balancedFromRepaired);
                            console.warn("[ReflectiveAgent] Reflexão extraída de JSON balanceado (reparado).");
                            return this._normalizeReflection(data);
                        } catch {}
                    }
                    const jsonMatch = responseText.match(/{[\s\S]*}/);
                    if (jsonMatch && jsonMatch[0]) {
                        try {
                            const fallbackBalanced = this._extractBalancedJson(jsonMatch[0]) || jsonMatch[0];
                            const fallbackCandidate = this._repairJsonString(fallbackBalanced);
                            const fallbackReflectionData = JSON.parse(fallbackCandidate);
                            console.warn("[ReflectiveAgent] Reflexão extraída com fallback após erro de parse inicial.");
                            return this._normalizeReflection(fallbackReflectionData);
                        } catch (fallbackParseError) {
                             console.error("[ReflectiveAgent] Erro no parse do JSON de fallback da reflexão:", fallbackParseError.message);
                        }
                    }
                    // Tentativa 3: re-gerar resposta com instrução de formato estrito
                    try {
                        const fallbackPrompt = reflectionPrompt + "\n\nATENÇÃO: Responda APENAS com um objeto JSON VÁLIDO e completo, sem texto extra.";
                        const second = await this.model.generateContent(fallbackPrompt);
                        const secondText = second?.response?.text?.() || "";
                        if (secondText) {
                            const repairedSecond = this._repairJsonString(secondText);
                            const balancedSecond = this._extractBalancedJson(repairedSecond || secondText) || (repairedSecond || secondText);
                            const data = JSON.parse(balancedSecond);
                            console.warn("[ReflectiveAgent] Reflexão obtida na segunda tentativa (formato estrito).");
                            return this._normalizeReflection(data);
                        }
                    } catch {}
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

// Helpers
ReflectiveAgent.prototype._repairJsonString = function (str) {
    try {
        if (!str) return str;
        let s = String(str);
        // Corrige sequências \u inválidas (\u seguido de não-hex) duplicando a barra
        s = s.replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u");
        // Dobra barras invertidas que não iniciam uma sequência de escape JSON válida
        s = s.replace(/\\(?![\\\/\"bfnrtu])/g, "\\\\");
        // Remove caracteres de controle não permitidos (0x00–0x1F) exceto tab (\t), newline (\n), carriage return (\r)
        s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u0019]/g, "");
        return s;
    } catch { return str; }
}

ReflectiveAgent.prototype._extractBalancedJson = function (str) {
    try {
        if (!str) return null;
        const s = String(str);
        const start = s.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            if (depth === 0) {
                return s.slice(start, i + 1);
            }
        }
        return null;
    } catch { return null; }
}

// Normalização de sentimento/confiança e score numérico
ReflectiveAgent.prototype._normalizeReflection = function (obj) {
    try {
        if (!obj || typeof obj !== 'object') return obj;
        const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const sentimentMap = new Map([
            ['interessado', 'interessado'],
            ['interesse', 'interessado'],
            ['engajado', 'interessado'],
            ['cético', 'cético'],
            ['cetico', 'cético'],
            ['desconfiado', 'cético'],
            ['duvida', 'cético'],
            ['duvidoso', 'cético'],
            ['confuso', 'confuso'],
            ['nao entendi', 'confuso'],
            ['não entendi', 'confuso'],
            ['satisfeito', 'satisfeito'],
            ['ok', 'satisfeito'],
            ['neutro', 'neutro'],
            ['precisa de mais informacao', 'precisa de mais informação'],
            ['precisa de mais informação', 'precisa de mais informação'],
            ['frustrado', 'frustrado'],
        ]);
        const confLabelMap = new Map([
            ['alta', { label: 'alta', score: 0.85 }],
            ['media', { label: 'média', score: 0.6 }],
            ['média', { label: 'média', score: 0.6 }],
            ['baixa', { label: 'baixa', score: 0.35 }],
        ]);

        const emotionMap = new Map([
            ['raiva', 'raiva'], ['ira', 'raiva'],
            ['urgencia', 'urgencia'], ['urgência', 'urgencia'],
            ['confianca', 'confianca'], ['confiança', 'confianca'],
            ['hesitacao', 'hesitacao'], ['hesitação', 'hesitacao'],
            ['neutro', 'neutro'], ['frustrado', 'frustrado'], ['animado', 'animado']
        ]);
        const intentMap = new Map([
            ['marcar reuniao', 'marcar_reuniao'], ['marcar_reuniao', 'marcar_reuniao'],
            ['pedir proposta', 'pedir_proposta'], ['pedir_proposta', 'pedir_proposta'],
            ['pedir desconto', 'pedir_desconto'], ['pedir_desconto', 'pedir_desconto'],
            ['objeção', 'objeção'], ['objeçao', 'objeção'], ['objeção detectada', 'objeção'],
            ['followup', 'followup'], ['pos venda', 'pos_venda'], ['pós venda', 'pos_venda'],
            ['indeciso', 'indeciso']
        ]);
        const awarenessMap = new Map([
            ['inconsciente', 'inconsciente'], ['problema', 'problema'], ['solucao', 'solucao'], ['solução', 'solucao'], ['produto', 'produto'], ['decisao', 'decisao'], ['decisão', 'decisao']
        ]);

        if (obj.sentimentoInferidoDoLead) {
            const k = stripAccents(obj.sentimentoInferidoDoLead);
            const normalized = sentimentMap.get(k) || obj.sentimentoInferidoDoLead;
            obj.sentimentoInferidoDoLead = normalized;
        }
        let score = typeof obj.confidenceScore === 'number' ? obj.confidenceScore : null;
        if (obj.confiancaSentimentoLead) {
            const k = stripAccents(obj.confiancaSentimentoLead);
            const mapped = confLabelMap.get(k);
            if (mapped) {
                obj.confiancaSentimentoLead = mapped.label;
                if (score === null || score === undefined) score = mapped.score;
            }
        }
        if (score === null || score === undefined) {
            score = 0.5; // default neutro
        }
        // clamp
        if (Number.isFinite(score)) {
            obj.confidenceScore = Math.max(0, Math.min(1, Number(score)));
        } else {
            obj.confidenceScore = 0.5;
        }

        // Normaliza emoção (opcional)
        if (obj.emocaoInferida) {
            const k = stripAccents(obj.emocaoInferida);
            const v = emotionMap.get(k) || obj.emocaoInferida;
            obj.emocaoInferida = v;
        }
        if (typeof obj.emocaoConfianca === 'number') {
            obj.emocaoConfianca = Math.max(0, Math.min(1, obj.emocaoConfianca));
        }

        // Normaliza intenção (opcional)
        if (obj.intencaoDetectada) {
            const k = stripAccents(obj.intencaoDetectada);
            const v = intentMap.get(k) || obj.intencaoDetectada;
            obj.intencaoDetectada = v;
        }

        // Normaliza nível de consciência (opcional)
        if (obj.nivelDeConsciencia) {
            const k = stripAccents(obj.nivelDeConsciencia);
            const v = awarenessMap.get(k) || obj.nivelDeConsciencia;
            obj.nivelDeConsciencia = v;
        }
        if (typeof obj.conscienciaConfianca === 'number') {
            obj.conscienciaConfianca = Math.max(0, Math.min(1, obj.conscienciaConfianca));
        }

        // Enforce limite de 420 chars na mensagem sugerida
        if (obj.mensagemSugerida && typeof obj.mensagemSugerida === 'string') {
            obj.mensagemSugerida = obj.mensagemSugerida.slice(0, 420);
        }
    } catch {}
    return obj;
}

module.exports = { ReflectiveAgent, ReflectionFocus };
