import { CRMEngine } from '@/agents/crm/index'

export async function parseAndExecute(prompt: string) {
  const state = await CRMEngine.getState()
  const r = await fetch('/api/agent/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, context: state })
  })
  const js = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(js?.error || 'parse_failed')
  const name = String(js?.name || '')
  const payload = js?.payload || {}
  // Executa com o CRMEngine
  return await (window as any).CRMEngine?.dispatchIntent?.(name, payload)
}


