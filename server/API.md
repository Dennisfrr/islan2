## Gateway API Contract

- Base URL: http://localhost:${PORT|3000}
- Auth: Bearer opcional (para endpoints protegidos). Proxies propagam `Authorization` e `X-Agent-Key` quando aplicável.

### Agent process manager
- GET /api/agent/status → `{ running, pid, startedAt, lastExit }`
- POST /api/agent/start → inicia Agente WhatsApp (spawn em `Agente WhatsaApp/index.js`)
- POST /api/agent/stop → encerra

### Proxies para Agente WhatsApp
- GET /api/agent/lead-emotion?waId=...|phone=...
- POST /api/agent/lead-emotion/refresh { waId|phone }
- GET /api/agent/precall?waId=...|phone=...
- GET /api/agent/lead-profile?waId=...|phone=...
- POST /api/agent/lead-profile/refresh { waId|phone }
- POST /api/wa/dispatch (proxy) → envia ao WA Agent `/api/wa/dispatch`

### Proxies para CRM Agent
- GET /api/analytics/followups (proxy)
- GET /api/followups/candidates (proxy)
- GET /api/followups/insights (proxy)
- GET /api/goals (proxy)
- POST /api/dashboard/summary (proxy)
- GET /api/analytics/reflections (proxy)

### Webhooks
- /webhooks/whatsapp, /webhooks/instagram, /webhooks/messenger, /webhooks/ultramsg, /webhooks/greenapi (handlers conforme provedor)

Notas
- `CRM_HTTP_BASE` e `WA_AGENT_BASE_URL` definem destinos dos proxies.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são obrigatórios para features do console/insights.

