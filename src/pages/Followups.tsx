import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { CRMSidebar } from '@/components/crm/CRMSidebar'
import { useNavigate } from 'react-router-dom'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'
import { useOrg } from '@/components/org/OrgProvider'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

type FollowupCandidate = {
  leadId: string
  priority_rule: number
  priority_final?: number
  reasons: string[]
  why?: string | null
  evidence?: {
    lastInboundAt?: string | null
    lastOutboundAt?: string | null
    overdueTasks?: Array<{ id: string | null; title: string | null; dueAt: string | null }>
  }
}

type FollowupKpiResponse = {
  byStatus: Array<{ status: string; value: number }>
}

type InsightRow = {
  id: string
  organization_id: string
  lead_id: string | null
  lead_wa_id: string | null
  priority: number
  insight: any
  created_at: string
}

const reasonLabel: Record<string, string> = {
  sla_breach: 'SLA estourado',
  task_due: 'Tarefa vencida',
  stage_stale: 'Parado no estágio',
  silence: 'Silêncio do lead',
}

export default function FollowupsPage() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const { orgId } = useOrg()
  const [loading, setLoading] = React.useState(false)
  const [candidates, setCandidates] = React.useState<FollowupCandidate[]>([])
  const [kpis, setKpis] = React.useState<FollowupKpiResponse | null>(null)
  const [minPriority, setMinPriority] = React.useState<number>(1)
  const [reasonFilter, setReasonFilter] = React.useState<string>('all')
  const [autoMode, setAutoMode] = React.useState<boolean>(false)
  const [processingTop, setProcessingTop] = React.useState<boolean>(false)
  const [insights, setInsights] = React.useState<InsightRow[]>([])
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const [previewText, setPreviewText] = React.useState('')
  const [previewLeadId, setPreviewLeadId] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerLead, setDrawerLead] = React.useState<{ id: string; phoneDigits: string } | null>(null)
  const [drawerData, setDrawerData] = React.useState<any>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        // KPIs (by status)
        const ak = await apiFetch('/api/analytics/followups')
        const akj = await ak.json().catch(() => ({}))
        if (!cancelled) setKpis(ak.ok ? akj : null)
        // Insights recentes (se Supabase configurado no agente)
        if (orgId) {
          const r = await apiFetch(`/api/followups/insights?organization_id=${encodeURIComponent(orgId)}`)
          const js = await r.json().catch(() => ({}))
          if (!cancelled) setInsights(Array.isArray(js?.items) ? js.items : [])
        }
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Falha ao carregar KPIs', description: String(e?.message || e), variant: 'destructive' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await apiFetch('/api/followups/candidates?useLLM=1')
        const js = await r.json().catch(() => ({} as any))
        const items = Array.isArray(js?.items) ? js.items as FollowupCandidate[] : []
        if (!cancelled) setCandidates(items)
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Falha ao carregar fila', description: String(e?.message || e), variant: 'destructive' })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const filtered = candidates.filter(it => {
    const pr = Number(it.priority_final || it.priority_rule || 5)
    const okPriority = pr >= minPriority && pr <= 5
    const okReason = reasonFilter === 'all' || it.reasons.includes(reasonFilter)
    return okPriority && okReason
  })

  async function processTopN(n: number) {
    if (!filtered.length) { toast({ title: 'Sem itens', description: 'Nenhum item na fila para processar.' }); return }
    setProcessingTop(true)
    try {
      const sorted = [...filtered].sort((a, b) => (Number(a.priority_final || a.priority_rule || 5) - Number(b.priority_final || b.priority_rule || 5)))
      const picks = sorted.slice(0, n)
      let ok = 0, fail = 0
      for (const it of picks) {
        try {
          const phoneDigits = String(it.leadId).replace(/\D/g, '')
          const body = {
            name: 'generate_and_send',
            payload: { leadId: `${phoneDigits}@c.us`, objective: 'followup_reengagement' },
            abTest: true,
            constraints: { maxChars: 420 }
          }
          const r = await apiFetch('/api/wa/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          const js = await r.json().catch(() => ({} as any))
          if (!r.ok) throw new Error(js?.error || 'Falha no envio')
          ok++
        } catch {
          fail++
        }
      }
      toast({ title: 'Processamento concluído', description: `${ok} enviado(s), ${fail} falha(s).` })
      // Refresh simples
      try {
        const r = await apiFetch('/api/followups/candidates?useLLM=1')
        const js = await r.json().catch(() => ({} as any))
        const items = Array.isArray(js?.items) ? js.items as FollowupCandidate[] : []
        setCandidates(items)
      } catch {}
    } finally {
      setProcessingTop(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex">
      <CRMSidebar
        selectedView="followups"
        onViewChange={(view) => {
          if (view === 'goals') navigate('/goals')
          else navigate('/')
        }}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className="flex-1 max-w-full p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Follow-ups</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Auto‑mode</span>
              <Switch checked={autoMode} onCheckedChange={setAutoMode} />
            </div>
            <Button size="sm" disabled={processingTop} onClick={() => processTopN(5)}>
              {processingTop ? 'Processando…' : 'Processar Top 5'}
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-emerald-500">
            <CardHeader className="py-3"><CardTitle className="text-sm">Na fila</CardTitle></CardHeader>
            <CardContent className="pt-0"><div className="text-2xl font-bold">{candidates.length}</div></CardContent>
          </Card>
          <Card className="border-l-4 border-l-primary">
            <CardHeader className="py-3"><CardTitle className="text-sm">Enviados (log)</CardTitle></CardHeader>
            <CardContent className="pt-0"><div className="text-2xl font-bold">{(kpis?.byStatus || []).reduce((a, b) => a + (b.status === 'SENT' ? b.value : 0), 0)}</div></CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-500">
            <CardHeader className="py-3"><CardTitle className="text-sm">Aguardando (quiet/cooldown)</CardTitle></CardHeader>
            <CardContent className="pt-0"><div className="text-2xl font-bold">{(kpis?.byStatus || []).reduce((a, b) => a + (['QUEUED','BLOCKED'].includes(String(b.status)) ? b.value : 0), 0)}</div></CardContent>
          </Card>
          <Card className="border-l-4 border-l-rose-500">
            <CardHeader className="py-3"><CardTitle className="text-sm">Erros</CardTitle></CardHeader>
            <CardContent className="pt-0"><div className="text-2xl font-bold">{(kpis?.byStatus || []).reduce((a, b) => a + (String(b.status).toLowerCase().includes('error') ? b.value : 0), 0)}</div></CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="py-4"><CardTitle className="text-base">Fila Prioritária</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Prioridade mínima</span>
                <Input type="number" min={1} max={5} value={minPriority} onChange={e => setMinPriority(Math.max(1, Math.min(5, Number(e.target.value)||1)))} className="w-24 h-8" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Motivo</span>
                <select className="border rounded-md h-8 px-2 bg-background" value={reasonFilter} onChange={e => setReasonFilter(e.target.value)}>
                  <option value="all">Todos</option>
                  <option value="sla_breach">SLA estourado</option>
                  <option value="task_due">Tarefa vencida</option>
                  <option value="stage_stale">Parado no estágio</option>
                  <option value="silence">Silêncio do lead</option>
                </select>
              </div>
            </div>

            <div className="space-y-3">
              {filtered.map(it => {
                const pr = Number(it.priority_final || it.priority_rule || 5)
                const lastIn = it.evidence?.lastInboundAt ? new Date(it.evidence.lastInboundAt) : null
                const lastOut = it.evidence?.lastOutboundAt ? new Date(it.evidence.lastOutboundAt) : null
                const phoneDigits = String(it.leadId).replace(/\D/g, '')
                const suggest = insights.find(x => (x.lead_wa_id || '').replace(/\D/g,'') === phoneDigits)
                return (
                  <div key={`${it.leadId}-${pr}`} className="p-3 rounded-md border flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate" title={it.leadId}>{it.leadId}</span>
                        <Badge variant="secondary">P{pr}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {it.reasons.map(r => (
                          <span key={r} title={{
                            sla_breach: 'SLA estourado para o estágio ou regras da conta',
                            task_due: 'Existe tarefa vencida associada a este lead',
                            stage_stale: 'Lead parado há mais tempo que o threshold',
                            silence: 'Sem resposta após a última mensagem enviada'
                          }[r] || r}>
                            <Badge variant="outline" className="text-xs">{reasonLabel[r] || r}</Badge>
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {lastIn ? `Último inbound: ${formatDistanceToNow(lastIn, { addSuffix: true, locale: ptBR })}` : 'Sem inbound'} · {lastOut ? `Último envio: ${formatDistanceToNow(lastOut, { addSuffix: true, locale: ptBR })}` : 'Sem envio'}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Ação do agente: enviar mensagem curta (IA, máx 420, A/B on). Guardrails: quiet hours/cooldown respeitados automaticamente.
                      </div>
                      {suggest?.insight?.mensagem_sugerida && (
                        <div className="mt-2 text-xs">
                          <span className="font-medium">Sugestão do agente:</span> {String(suggest.insight.mensagem_sugerida).slice(0, 420)}
                        </div>
                      )}
                      {it.why && (
                        <div className="mt-1 text-xs text-muted-foreground truncate" title={it.why}>Justificativa IA: {it.why}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={async () => {
                        try {
                          const phoneDigits = String(it.leadId).replace(/\D/g, '')
                          setDrawerLead({ id: `${phoneDigits}@c.us`, phoneDigits })
                          setDrawerOpen(true)
                          setDrawerData(null)
                          const r = await apiFetch(`/api/leads/${encodeURIComponent(`${phoneDigits}@c.us`)}`)
                          const js = await r.json().catch(()=> ({} as any))
                          setDrawerData(js)
                        } catch (e: any) {
                          toast({ title: 'Falha ao carregar lead', description: String(e?.message || e), variant: 'destructive' })
                        }
                      }}>Detalhes</Button>
                      <Button size="sm" variant="outline" onClick={async () => {
                        try {
                          const phoneDigits = String(it.leadId).replace(/\D/g, '')
                          const r = await apiFetch(`/api/leads/${encodeURIComponent(`${phoneDigits}@c.us`)}/precall`)
                          const js = await r.json().catch(() => ({} as any))
                          const q = Array.isArray(js?.suggestedQuestions) && js.suggestedQuestions[0] ? String(js.suggestedQuestions[0]) : null
                          if (!q) { toast({ title: 'Sem sugestão', description: 'Nenhuma pergunta sugerida no momento.' }); return }
                          const suggest = insights.find(x => (x.lead_wa_id || '').replace(/\D/g,'') === phoneDigits)
                          const baseText = (suggest?.insight?.mensagem_sugerida as string) || ''
                          setPreviewLeadId(`${phoneDigits}@c.us`)
                          setPreviewText(baseText)
                          setPreviewOpen(true)
                        } catch (e: any) {
                          toast({ title: 'Falha na prévia', description: String(e?.message || e), variant: 'destructive' })
                        }
                      }}>Prévia</Button>
                      <Button size="sm" onClick={async () => {
                        try {
                          const phoneDigits = String(it.leadId).replace(/\D/g, '')
                          const body = {
                            name: 'generate_and_send',
                            payload: { leadId: `${phoneDigits}@c.us`, objective: 'followup_reengagement', text: suggest?.insight?.mensagem_sugerida || undefined },
                            abTest: true,
                            constraints: { maxChars: 420 }
                          }
                          const r = await apiFetch('/api/wa/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                          const js = await r.json().catch(() => ({} as any))
                          if (!r.ok) throw new Error(js?.error || 'Falha no envio')
                          toast({ title: 'Enviado', description: `Status: ${js?.status || 'SENT'}` })
                        } catch (e: any) {
                          toast({ title: 'Falha ao enviar', description: String(e?.message || e), variant: 'destructive' })
                        }
                      }}>Enviar WhatsApp</Button>
                    </div>
                  </div>
                )
              })}
              {!filtered.length && (
                <div className="text-sm text-muted-foreground">Nenhum item atende aos filtros atuais.</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="right" className="w-[420px] sm:w-[500px]">
            <SheetHeader>
              <SheetTitle>Lead</SheetTitle>
              <SheetDescription>{drawerLead?.id || ''}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-3">
              {!drawerData && <div className="text-sm text-muted-foreground">Carregando…</div>}
              {drawerData && (
                <div className="space-y-2">
                  <div className="text-sm"><span className="font-medium">Nome:</span> {drawerData.name || '—'}</div>
                  <div className="text-sm"><span className="font-medium">Negócio:</span> {drawerData.businessName || '—'}</div>
                  <div className="text-sm"><span className="font-medium">Tipo:</span> {drawerData.businessType || '—'}</div>
                  <div className="text-sm"><span className="font-medium">Emoção:</span> {drawerData.emotionalState || '—'} {drawerData.emotionalConfidence != null ? `(${Math.round((drawerData.emotionalConfidence || 0)*100)}%)` : ''}</div>
                  <div className="text-sm"><span className="font-medium">Último resumo:</span> {drawerData.lastSummary || '—'}</div>
                  <div className="text-sm"><span className="font-medium">Tags:</span> {(drawerData.tags || []).join(', ') || '—'}</div>
                  <div className="text-sm"><span className="font-medium">Dores:</span> {(drawerData.pains || []).join(', ') || '—'}</div>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Prévia do follow-up</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Textarea value={previewText} onChange={e => setPreviewText(e.target.value.slice(0, 420))} placeholder="Edite a mensagem antes de enviar" />
              <div className="text-xs text-muted-foreground text-right">{previewText.length}/420</div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPreviewOpen(false)}>Cancelar</Button>
              <Button onClick={async () => {
                try {
                  if (!previewLeadId) return
                  const body = { name: 'generate_and_send', payload: { leadId: previewLeadId, objective: 'followup_reengagement', text: previewText }, abTest: true, constraints: { maxChars: 420 } }
                  const r = await apiFetch('/api/wa/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                  const js = await r.json().catch(() => ({} as any))
                  if (!r.ok) throw new Error(js?.error || 'Falha no envio')
                  setPreviewOpen(false)
                  toast({ title: 'Enviado', description: `Status: ${js?.status || 'SENT'}` })
                } catch (e: any) {
                  toast({ title: 'Falha ao enviar', description: String(e?.message || e), variant: 'destructive' })
                }
              }}>Enviar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}


