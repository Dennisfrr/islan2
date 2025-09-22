import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'

export default function AgentPage() {
  const { session } = useAuth()
  const { orgId } = useOrg()
  const { toast } = useToast()
  const authHeader = useMemo(() => ({ Authorization: session?.access_token ? `Bearer ${session.access_token}` : '' }), [session?.access_token])

  const [running, setRunning] = useState<boolean | null>(null)
  // WhatsApp login removed from Agent
  const [busy, setBusy] = useState(false)

  const refreshAgentStatus = async () => {
    try {
      const r = await apiFetch('/api/agent/status', { headers: { ...authHeader } })
      const js = await r.json().catch(() => ({}))
      if (r.ok) setRunning(Boolean(js?.running))
    } catch {}
  }
  // QR/connection helpers removed

  useEffect(() => { refreshAgentStatus(); }, [orgId])

  const startAgent = async () => {
    setBusy(true)
    try {
      const r = await apiFetch('/api/agent/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify({}) })
      if (!r.ok) throw new Error('Falha ao iniciar agente')
      setRunning(true)
      toast({ title: 'Agente iniciado', description: 'O agente foi iniciado.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setBusy(false) }
  }
  const stopAgent = async () => {
    setBusy(true)
    try {
      const r = await apiFetch('/api/agent/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify({}) })
      if (!r.ok) throw new Error('Falha ao parar agente')
      setRunning(false)
      
      toast({ title: 'Agente parado', description: 'O agente foi encerrado.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setBusy(false) }
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Agente de WhatsApp</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-2xl">🤖</div>
              <div>
                <div className="text-sm text-muted-foreground">Status do agente</div>
                <div className="text-base">{running == null ? '—' : (running ? 'Em execução' : 'Parado')}</div>
              </div>
              <div className="ml-auto flex gap-2">
                <Button onClick={startAgent} disabled={busy || running === true}>Iniciar agente</Button>
                <Button variant="outline" onClick={stopAgent} disabled={busy || running === false}>Parar agente</Button>
              </div>
            </div>
            {/* WhatsApp QR/connection removed */}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}


