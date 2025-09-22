CRM Agent

Microserviço HTTP que orquestra ações de CRM reutilizando o motor de ferramentas do agente WhatsApp.

Endpoints

- GET `/health` — status do serviço.
- GET `/api/tools` — lista as tools disponíveis (dinâmicas do Neo4j + estáticas).
- POST `/api/agent/event` — despacha um evento para o motor de ferramentas.
  - body: `{ eventType: string, leadProfile?: object, reflectionResult?: object, payload?: any, messageText?: string, threshold?: number }`
- POST `/api/tools/:id/run` — executa uma tool manualmente.

Variáveis de ambiente

- `CRM_AGENT_PORT` (default: 3010)
- Reusa as configurações do agente WhatsApp para Neo4j/CRM, como por exemplo:
  - `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
  - `CRM_BASE_URL`, `CRM_AGENT_KEY` ou `CRM_BEARER_TOKEN`, `CRM_ORGANIZATION_ID`

Rodando

```bash
npm install
npm run start
# ou
npm run dev
```


