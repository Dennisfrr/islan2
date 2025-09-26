// db_neo4j.js
const neo4j = require('neo4j-driver');
require('dotenv').config(); // Para carregar variáveis de ambiente do seu arquivo .env

// Lê as configurações do Neo4j do seu arquivo .env
// Se não encontrar no .env, usa os valores default (para ambiente local comum)
const NEO4J_URI = process.env.NEO4J_URI || 'neo4j://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD; // Esta DEVE estar no seu .env

// Verifica se a senha foi fornecida, pois é crucial
if (!NEO4J_PASSWORD) {
    console.warn(`
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
AVISO CRÍTICO NEO4J: A variável de ambiente NEO4J_PASSWORD não está definida!
Verifique seu arquivo .env e certifique-se de que NEO4J_PASSWORD=sua_senha_aqui esteja presente.
A conexão com o Neo4j provavelmente falhará sem a senha.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    `);
}

let driver; // Variável para armazenar a instância do driver globalmente neste módulo

/**
 * Obtém ou inicializa a instância do driver do Neo4j.
 * @returns {neo4j.Driver} A instância do driver do Neo4j.
 * @throws {Error} Se não for possível criar ou obter o driver.
 */
function getDriver() {
    if (!driver) {
        try {
            // Cria uma nova instância do driver se ainda não existir
            driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
                // Configurações opcionais do driver podem ser adicionadas aqui, como:
                // maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 horas em milissegundos
                // maxConnectionPoolSize: 50,
                // connectionAcquisitionTimeout: 2 * 60 * 1000 // 2 minutos em milissegundos
                // encrypted: 'ENCRYPTION_ON', // Se estiver usando Neo4j AuraDB ou conexão SSL/TLS
                // trust: 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES', // Para AuraDB ou certificados confiáveis
            });
            console.log('[Neo4j] Driver do Neo4j inicializado com sucesso.');

            // Opcional: Testar a conectividade ao inicializar o driver
            // Isso pode ser útil para pegar erros de configuração cedo.
            driver.verifyConnectivity()
                .then(() => console.log('[Neo4j] Conexão com o servidor Neo4j verificada com sucesso.'))
                .catch(error => {
                    console.error('[Neo4j] Falha ao verificar conectividade com o Neo4j. Verifique URI, usuário, senha e se o servidor Neo4j está rodando.');
                    console.error('[Neo4j] Detalhes do erro de conectividade:', error.message);
                    // Você pode querer tratar este erro de forma mais drástica se a conexão for essencial no início.
                });

        } catch (error) {
            console.error('[Neo4j] Erro crítico ao tentar criar o driver do Neo4j:', error);
            // Dependendo da sua aplicação, você pode querer relançar o erro ou encerrar o processo
            // se a conexão com o banco de dados for absolutamente essencial para o funcionamento.
            throw error;
        }
    }
    return driver;
}

/**
 * Obtém uma nova sessão do Neo4j para executar transações.
 * @param {string} accessMode - O modo de acesso da sessão (neo4j.session.READ ou neo4j.session.WRITE). Default é WRITE.
 * @returns {neo4j.Session} Uma instância de sessão do Neo4j.
 * @throws {Error} Se o driver do Neo4j não estiver disponível.
 */
async function getSession(accessMode = neo4j.session.WRITE) {
    if (!driver) {
        getDriver(); // Tenta inicializar o driver se ele ainda não foi
    }
    if (!driver) { // Se ainda assim não inicializou (ex: erro de configuração que impediu a criação)
        throw new Error("[Neo4j] Driver do Neo4j não está disponível. Não é possível obter sessão. Verifique a configuração e logs anteriores.");
    }
    // Para cada operação, é recomendado obter uma nova sessão.
    // O driver gerencia um pool de conexões, então isso é eficiente.
    return driver.session({ defaultAccessMode: accessMode });
}

/**
 * Fecha a instância do driver do Neo4j.
 * Deve ser chamado quando a aplicação está encerrando para liberar recursos.
 */
async function closeDriver() {
    if (driver) {
        try {
            await driver.close();
            driver = null; // Reseta a variável global do driver
            console.log('[Neo4j] Driver do Neo4j fechado com sucesso.');
        } catch (error) {
            console.error('[Neo4j] Erro ao tentar fechar o driver do Neo4j:', error);
        }
    }
}

// Exportar as funções que serão usadas em outros módulos do seu projeto
module.exports = {
    getDriver,  // Exporta a função para obter o driver (útil para verificações ou configurações avançadas)
    getSession, // Função principal para obter sessões para transações
    closeDriver // Função para encerrar a conexão ao finalizar o app
};