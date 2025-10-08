import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export default function AgentPage() {
  const { session } = useAuth()
  const { orgId } = useOrg()
  const { toast } = useToast()
  const authHeader = useMemo(() => ({ Authorization: session?.access_token ? `Bearer ${session.access_token}` : '' }), [session?.access_token])

  const [running, setRunning] = useState<boolean | null>(null)
  // WhatsApp login removed from Agent
  const [busy, setBusy] = useState(false)

  // Policy state (org-level)
  const [policyLoading, setPolicyLoading] = useState(false)
  const [autopilotLevel, setAutopilotLevel] = useState<'suggest'|'approve'|'execute'>('suggest')
  const [cadencePerLeadPerDay, setCadencePerLeadPerDay] = useState<number>(1)
  const [allowedHours, setAllowedHours] = useState<string>('09:00-18:00')
  const [tonePolicy, setTonePolicy] = useState<string>('consultivo')
  const [disallowedTerms, setDisallowedTerms] = useState<string>('')
  const [allowedChannels, setAllowedChannels] = useState<Record<string, boolean>>({ whatsapp: true, email: false, sms: false })
  const [approvalRequired, setApprovalRequired] = useState<Record<string, boolean>>({ dispatch: false, contract: true, quote: false })

  // Insight state
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightScope, setInsightScope] = useState<'org'|'user'|'lead'>('org')
  const [insightType, setInsightType] = useState<'persona_hint'|'tone_policy'|'channel_pref'|'objection_pattern'|'playbook_override'|'goal_priority'|'risk_signal'|'bandit_feedback'>('tone_policy')
  const [insightLeadId, setInsightLeadId] = useState<string>('')
  const [insightLeadPhone, setInsightLeadPhone] = useState<string>('')
  const [insightPriority, setInsightPriority] = useState<number>(3)
  const [insightJson, setInsightJson] = useState<string>(JSON.stringify({ tone: 'consultivo', avoid_phrases: ['desconto imediato'] }, null, 2))

  const refreshAgentStatus = async () => {
    try {
      const r = await apiFetch('/api/agent/status', { headers: { ...authHeader } })
      const js = await r.json().catch(() => ({}))
      if (r.ok) setRunning(Boolean(js?.running))
    } catch {}
  }
  // QR/connection helpers removed

  useEffect(() => { refreshAgentStatus(); }, [orgId])

  // Load existing org policy
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!orgId) return
      setPolicyLoading(true)
      try {
        const { data, error } = await supabase
          .from('organization_settings')
          .select('key,value')
          .eq('organization_id', orgId)
          .eq('key', 'agent_policy')
          .maybeSingle()
        if (!cancelled && !error && data?.value) {
          const v = data.value as any
          if (v.autopilotLevel) setAutopilotLevel(v.autopilotLevel)
          if (typeof v.cadencePerLeadPerDay === 'number') setCadencePerLeadPerDay(v.cadencePerLeadPerDay)
          if (typeof v.allowedHours === 'string') setAllowedHours(v.allowedHours)
          if (typeof v.tonePolicy === 'string') setTonePolicy(v.tonePolicy)
          if (typeof v.disallowedTerms === 'string') setDisallowedTerms(v.disallowedTerms)
          if (v.allowedChannels && typeof v.allowedChannels === 'object') setAllowedChannels({ ...allowedChannels, ...v.allowedChannels })
          if (v.approvalRequired && typeof v.approvalRequired === 'object') setApprovalRequired({ ...approvalRequired, ...v.approvalRequired })
        }
      } catch {} finally { if (!cancelled) setPolicyLoading(false) }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

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

        {/* Agent Policies (Autopilot) */}
        <div className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Políticas do Agente (Autopilot)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Nível de Autopilot</Label>
                  <Select value={autopilotLevel} onValueChange={(v) => setAutopilotLevel(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="suggest">Sugerir</SelectItem>
                      <SelectItem value="approve">Aprovar</SelectItem>
                      <SelectItem value="execute">Executar</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Cadência por lead/dia</Label>
                  <Input type="number" min={0} value={cadencePerLeadPerDay} onChange={(e) => setCadencePerLeadPerDay(Number(e.target.value||0))} />
                </div>
                <div>
                  <Label className="text-xs">Janela de envio (HH:MM-HH:MM)</Label>
                  <Input value={allowedHours} onChange={(e) => setAllowedHours(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Tom (tone policy)</Label>
                  <Input value={tonePolicy} onChange={(e) => setTonePolicy(e.target.value)} />
                </div>
                <div className="md:col-span-2">
                  <Label className="text-xs">Termos proibidos (vírgula)</Label>
                  <Input value={disallowedTerms} onChange={(e) => setDisallowedTerms(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs mb-1 block">Canais permitidos</Label>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={allowedChannels.whatsapp} onCheckedChange={(v) => setAllowedChannels(s => ({ ...s, whatsapp: Boolean(v) }))} />
                      <span className="text-sm">WhatsApp</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={allowedChannels.email} onCheckedChange={(v) => setAllowedChannels(s => ({ ...s, email: Boolean(v) }))} />
                      <span className="text-sm">Email</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={allowedChannels.sms} onCheckedChange={(v) => setAllowedChannels(s => ({ ...s, sms: Boolean(v) }))} />
                      <span className="text-sm">SMS</span>
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Aprovação obrigatória</Label>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={approvalRequired.dispatch} onCheckedChange={(v) => setApprovalRequired(s => ({ ...s, dispatch: Boolean(v) }))} />
                      <span className="text-sm">Dispatch</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={approvalRequired.contract} onCheckedChange={(v) => setApprovalRequired(s => ({ ...s, contract: Boolean(v) }))} />
                      <span className="text-sm">Contrato</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={approvalRequired.quote} onCheckedChange={(v) => setApprovalRequired(s => ({ ...s, quote: Boolean(v) }))} />
                      <span className="text-sm">Proposta</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button disabled={policyLoading} onClick={async () => {
                  try {
                    if (!orgId) return
                    setPolicyLoading(true)
                    const value = { autopilotLevel, cadencePerLeadPerDay, allowedHours, tonePolicy, disallowedTerms, allowedChannels, approvalRequired }
                    const { error } = await supabase.from('organization_settings').upsert({ organization_id: orgId, key: 'agent_policy', value })
                    if (error) throw error
                    toast({ title: 'Salvo', description: 'Política do agente atualizada.' })
                  } catch (e: any) {
                    toast({ title: 'Erro ao salvar', description: String(e?.message || e), variant: 'destructive' })
                  } finally { setPolicyLoading(false) }
                }}>Salvar políticas</Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Insights to Agent */}
        <div className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Personalização (Enviar Insight ao Agente)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label className="text-xs">Escopo</Label>
                  <Select value={insightScope} onValueChange={(v) => setInsightScope(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="org">Organização</SelectItem>
                      <SelectItem value="user">Usuário</SelectItem>
                      <SelectItem value="lead">Lead</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Tipo</Label>
                  <Select value={insightType} onValueChange={(v) => setInsightType(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="persona_hint">Persona hint</SelectItem>
                      <SelectItem value="tone_policy">Tone policy</SelectItem>
                      <SelectItem value="channel_pref">Preferência de canal</SelectItem>
                      <SelectItem value="objection_pattern">Padrão de objeção</SelectItem>
                      <SelectItem value="playbook_override">Override de playbook</SelectItem>
                      <SelectItem value="goal_priority">Prioridade de objetivo</SelectItem>
                      <SelectItem value="risk_signal">Sinal de risco</SelectItem>
                      <SelectItem value="bandit_feedback">Feedback bandit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Prioridade (1-5)</Label>
                  <Input type="number" min={1} max={5} value={insightPriority} onChange={(e) => setInsightPriority(Math.max(1, Math.min(5, Number(e.target.value||3))))} />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Lead ID (opcional)</Label>
                  <Input value={insightLeadId} onChange={(e) => setInsightLeadId(e.target.value)} placeholder="uuid do lead" />
                </div>
                <div>
                  <Label className="text-xs">Telefone do Lead (opcional)</Label>
                  <Input value={insightLeadPhone} onChange={(e) => setInsightLeadPhone(e.target.value)} placeholder="Ex.: 5511999999999" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Payload (JSON)</Label>
                <Textarea rows={6} value={insightJson} onChange={(e) => setInsightJson(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <Button disabled={insightBusy} onClick={async () => {
                  try {
                    if (!orgId) { toast({ title: 'Org ausente', description: 'Entre em uma organização.' }); return }
                    setInsightBusy(true)
                    let payload: any = {}
                    try { payload = JSON.parse(insightJson || '{}') } catch { throw new Error('JSON inválido') }
                    const waId = insightLeadPhone ? `${String(insightLeadPhone).replace(/\D/g,'')}@c.us` : null
                    const { error } = await supabase.from('followup_insights').insert({
                      organization_id: orgId,
                      lead_id: insightScope === 'lead' && insightLeadId ? insightLeadId : null,
                      lead_wa_id: waId,
                      priority: insightPriority,
                      insight: { type: insightType, scope: insightScope, data: payload, source: 'dashboard' },
                    })
                    if (error) throw error
                    toast({ title: 'Insight enviado', description: 'O agente poderá se adaptar com base nisso.' })
                    setInsightJson(JSON.stringify(payload, null, 2))
                  } catch (e: any) {
                    toast({ title: 'Erro ao enviar', description: String(e?.message || e), variant: 'destructive' })
                  } finally { setInsightBusy(false) }
                }}>Enviar insight</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}


