// debounceHandler.js

/**
 * @typedef {Object} UserMessage
 * @property {string} id - ID da mensagem original do WhatsApp.
 * @property {string} type - Tipo da mensagem ('text', 'audio', etc.).
 * @property {string} [content] - Conteúdo da mensagem de texto.
 * @property {string} [data] - Dados base64 para áudio/imagem.
 * @property {string} [mimeType] - MimeType para áudio/imagem.
 * @property {string} senderId - ID do remetente.
 * @property {string} senderName - Nome do remetente.
 * @property {number} timestamp - Timestamp de quando a mensagem foi recebida.
 */

/**
 * @typedef {Object} DebounceConfig
 * @property {number} delay - Tempo em milissegundos para esperar antes de processar.
 * @property {(senderId: string, senderName: string, aggregatedMessages: UserMessage[]) => Promise<void>} processFunction - Função a ser chamada após o debounce.
 */

const userDebounceMap = new Map();

/**
 * Lida com as mensagens recebidas, aplicando uma lógica de debounce por usuário.
 * @param {UserMessage} message - A mensagem recebida.
 * @param {DebounceConfig} config - Configurações do debounce.
 */
function handleDebouncedMessage(message, config) {
  const { senderId, senderName } = message;
  const { delay, processFunction } = config;

  if (userDebounceMap.has(senderId)) {
    const existingData = userDebounceMap.get(senderId);
    clearTimeout(existingData.timerId);
    existingData.messages.push(message);
    existingData.timerId = setTimeout(() => {
      // Copia as mensagens para evitar modificação durante o processamento assíncrono
      const messagesToProcess = [...existingData.messages];
      userDebounceMap.delete(senderId); // Limpa antes de processar para permitir novas mensagens
      console.log(`[Debounce] Processando ${messagesToProcess.length} mensagens agregadas para ${senderName} (${senderId}) após ${delay}ms.`);
      processFunction(senderId, senderName, messagesToProcess);
    }, delay);
    console.log(`[Debounce] Mensagem de ${senderName} (${senderId}) adicionada ao buffer. Novo timeout de ${delay}ms.`);
  } else {
    const newDebounceData = {
      messages: [message],
      timerId: setTimeout(() => {
        // Copia as mensagens para evitar modificação durante o processamento assíncrono
        const messagesToProcess = [...newDebounceData.messages];
        userDebounceMap.delete(senderId); // Limpa antes de processar
        console.log(`[Debounce] Processando mensagem inicial para ${senderName} (${senderId}) após ${delay}ms.`);
        processFunction(senderId, senderName, messagesToProcess);
      }, delay),
    };
    userDebounceMap.set(senderId, newDebounceData);
    console.log(`[Debounce] Nova mensagem de ${senderName} (${senderId}). Iniciando timeout de ${delay}ms.`);
  }
}

module.exports = { handleDebouncedMessage };
