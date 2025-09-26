## CRM Agent API Contract

- Base URL: http://localhost:${CRM_AGENT_PORT|3010}
- Auth: sem auth global por padrão. Webhook usa `X-CRM-Signature` simples (se configurado).

### Health
- GET /health → `{ ok: true, service: 'crm-agent', port: number }`

### Tools
- GET /api/tools → lista ferramentas registradas
- POST /api/tools/:id/run → executa ferramenta manualmente

### CRM/Eventos
- POST /api/agent/event
```
{ "eventType": "crm_lead_created|crm_lead_updated|crm_stage_changed|...", "leadProfile": {...}, "payload": {...}, "messageText": "..." }
```

- POST /api/crm/webhook (Header: `X-CRM-Signature`)
```
{ "type": "lead.created|lead.updated|lead.stage_changed|...", "data": {...} }
```

### Leads
- GET /api/leads?nome=&tag=&dor=&nivelInteresse=&origem=&page=&limit=
- GET /api/leads/:id
- POST /api/leads/:id/analyze
- GET /api/leads/:id/emotion
- POST /api/leads/:id/emotion/refresh
- GET /api/leads/:id/chathistory
- GET /api/leads/:id/precall

### FollowUps
- POST /api/followups → cria follow-up (status scheduled)
- GET /api/followups → lista/paginação por status
- GET /api/leads/:id/followups → por lead
- PUT /api/followups/:id/cancel
- PUT /api/followups/:id/reschedule
- GET /api/analytics/followups → KPIs simples
- GET /api/followups/candidates → candidatos por silêncio

### Knowledge Base
- GET /api/knowledgebase/stats
- GET /api/knowledgebase/items/:nodeType (whitelist)

### Analytics & Meta‑Reflexão
- GET /api/analytics/reflections
- GET /api/analytics/reflections/metrics?plan=...
- GET /api/analytics/overview
- GET /api/analytics/sentiment-distribution
- GET /api/analytics/tool-usage (mock)
- GET /api/analytics/effective-tactics (mock)

Observações
- Integração WA: usa `WA_AGENT_BASE_URL` + `X-Agent-Key` quando configurado.
- Neo4j obrigatório (`NEO4J_PASSWORD`). Gemini opcional para análise.

