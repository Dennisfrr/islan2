## WhatsApp Agent API Contract

- Base URL: http://localhost:${WA_AGENT_PORT|DASHBOARD_PORT|3005}
- Auth: header `X-Agent-Key` (opcional; se definido no servidor, é obrigatório no cliente)

### GET /api/wa/health
- 200: `{ ok: true, service: 'wa-agent', ts: number }`

### GET /api/wa/session/status
- 200: `{ sessions: [{ session: string, connected: boolean, user: string|null }] }`

### POST /api/wa/dispatch
- Headers: `X-Agent-Key: <key>` (se configurado)
- Body:
```
{
  "name": "generate_and_send" | "send_message" | "send_template",
  "lead": { "waJid": "55119XXXXXXXX@c.us", "name": "João" },
  "objective": "texto do objetivo (se não enviar text)",
  "text": "mensagem explícita (opcional)",
  "constraints": { "maxChars": 420 },
  "cta": { "text": "..." | "label": "...", "url": "..." },
  "abTest": false,
  "metadata": { }
}
```
- 200: `{ status: 'SENT', variant: 'A'|'B', metadata: object|null }`
- 400: `{ error: 'waJid_and_text_or_objective_required' }`
- 503: `{ error: 'send_helper_unavailable' }` (export ausente)
- 500: `{ error: 'wpp_client_unavailable' | '...' }`

### POST /api/wa/followup/generate
- Headers: `X-Agent-Key` (se configurado)
- Body:
```
{ "leadId": "55119XXXXXXXX@c.us", "objective": "(opcional)", "maxChars": 420 }
```
- 200: `{ text: string }` (usa Gemini se `GEMINI_API_KEY`; fallback para templates)
- 400: `{ error: 'leadId_required' }`
- 500: `{ error: '...' }`

Notas
- Requer sessão WPPConnect autenticada (QR) para envio.
- Persiste mensagens no Neo4j quando disponíveis.


