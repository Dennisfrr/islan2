import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Line, LineChart, XAxis, YAxis, CartesianGrid } from 'recharts'

type Goal = {
  id: string
  title: string
  window?: '7d' | '30d' | 'all'
  type?: string
  target: number
  direction: '>=' | '<='
  measure?: { cypher?: string }
  actionsOnBreach?: Array<{ type: string; [k: string]: any }>
}

type Snapshot = { id: string; at: number; value: number; target: number; direction: string; status: string }

export default function GoalsPage() {
  const { toast } = useToast()
  const [goals, setGoals] = useState<Goal[]>([])
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [simpleMode, setSimpleMode] = useState(true)

  // Templates simples para evitar escrever Cypher
  const templates = [
    { id: 'conversion_rate', label: 'Taxa de conversão (Won / Leads)', direction: '>=' as const, defaultTarget: 0.2, defaultWindow: '30d' as const },
    { id: 'meetings_per_week', label: 'Reuniões por semana (Agendado)', direction: '>=' as const, defaultTarget: 10, defaultWindow: '7d' as const },
    { id: 'proposals_per_week', label: 'Propostas por semana (Proposta)', direction: '>=' as const, defaultTarget: 15, defaultWindow: '7d' as const },
    { id: 'qualified_per_week', label: 'Qualificados por semana (Qualificado)', direction: '>=' as const, defaultTarget: 20, defaultWindow: '7d' as const },
    { id: 'data_completeness_rate', label: 'Taxa de perfil completo', direction: '>=' as const, defaultTarget: 0.75, defaultWindow: '30d' as const },
  ]
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0].id)

  function genCypher(templateId: string, windowVal: '7d' | '30d' | 'all') {
    const now = 'timestamp()'
    const last7d = `${now} - 7*24*60*60*1000`
    const last30d = `${now} - 30*24*60*60*1000`
    const cutoff = windowVal === '7d' ? last7d : windowVal === '30d' ? last30d : null
    if (templateId === 'conversion_rate') {
      if (cutoff) {
        return (
          `MATCH (l:Lead) WHERE coalesce(l.createdAt,0) > ${cutoff} WITH count(l) AS total ` +
          `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'closed-won' }) WHERE t.at > ${cutoff} ` +
          `WITH total, count(t) AS won ` +
          `RETURN CASE WHEN total = 0 THEN 0.0 ELSE toFloat(won)/toFloat(total) END AS value`
        )
      }
      return (
        `MATCH (l:Lead) WITH count(l) AS total ` +
        `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'closed-won' }) ` +
        `WITH total, count(t) AS won ` +
        `RETURN CASE WHEN total = 0 THEN 0.0 ELSE toFloat(won)/toFloat(total) END AS value`
      )
    }
    if (templateId === 'meetings_per_week') {
      return cutoff
        ? `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Agendado' }) WHERE t.at > ${cutoff} RETURN count(t) AS value`
        : `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Agendado' }) RETURN count(t) AS value`
    }
    if (templateId === 'proposals_per_week') {
      return cutoff
        ? `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Proposta' }) WHERE t.at > ${cutoff} RETURN count(t) AS value`
        : `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Proposta' }) RETURN count(t) AS value`
    }
    if (templateId === 'qualified_per_week') {
      return cutoff
        ? `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Qualificado' }) WHERE t.at > ${cutoff} RETURN count(t) AS value`
        : `MATCH (:Lead)-[:HAS_TRANSITION]->(t:StageTransition { to: 'Qualificado' }) RETURN count(t) AS value`
    }
    if (templateId === 'data_completeness_rate') {
      return cutoff
        ? `MATCH (l:Lead) WHERE coalesce(l.dtUltimaAtualizacao, l.createdAt, 0) > ${cutoff} WITH l, (CASE WHEN l.nomeDoNegocio IS NOT NULL AND l.tipoDeNegocio IS NOT NULL AND size(coalesce(l.principaisDores, [])) > 0 THEN 1 ELSE 0 END) AS ok RETURN toFloat(sum(ok))/toFloat(count(l)) AS value`
        : `MATCH (l:Lead) WITH l, (CASE WHEN l.nomeDoNegocio IS NOT NULL AND l.tipoDeNegocio IS NOT NULL AND size(coalesce(l.principaisDores, [])) > 0 THEN 1 ELSE 0 END) AS ok RETURN toFloat(sum(ok))/toFloat(count(l)) AS value`
    }
    return ''
  }

  const load = async () => {
    try {
      const [g, s] = await Promise.all([
        apiFetch('/api/goals').then(r => r.json()),
        apiFetch('/api/goals/snapshots').then(r => r.json()),
      ])
      setGoals(Array.isArray(g) ? g : [])
      setSnaps(Array.isArray(s) ? s : [])
    } catch {}
  }
  useEffect(() => { load() }, [])

  const latestById = useMemo(() => {
    const m = new Map<string, Snapshot>()
    for (const s of snaps) {
      const prev = m.get(s.id)
      if (!prev || Number(s.at || 0) > Number(prev.at || 0)) m.set(s.id, s)
    }
    return m
  }, [snaps])

  const [form, setForm] = useState<Goal>({ id: '', title: '', target: 0, direction: '>=' })

  const saveGoals = async (arr: Goal[]) => {
    setBusy(true)
    try {
      const r = await apiFetch('/api/goals', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arr) })
      if (!r.ok) throw new Error('Falha ao salvar metas')
      toast({ title: 'Metas salvas', description: 'Reavaliação disparada.' })
      await load()
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const addOrUpdate = () => {
    if (simpleMode) {
      const tpl = templates.find(t => t.id === selectedTemplateId)
      if (!tpl) { toast({ title: 'Selecione um tipo de meta', variant: 'destructive' }); return }
      const id = form.id || tpl.id
      const title = form.title || tpl.label
      const windowVal = (form.window as any) || tpl.defaultWindow
      const direction = form.direction || tpl.direction
      const target = (form.target || tpl.defaultTarget) as number
      const cypher = genCypher(tpl.id, windowVal)
      if (!cypher) { toast({ title: 'Falha ao gerar meta', description: 'Tipo não suportado', variant: 'destructive' }); return }
      const simpleGoal: Goal = {
        id,
        title,
        window: windowVal,
        type: tpl.id,
        direction,
        target,
        measure: { cypher },
        actionsOnBreach: [ { type: 'prompt_mod', hint: tpl.id === 'data_completeness_rate' ? 'Coletar dados essenciais do perfil quando faltarem.' : 'Aumentar cadência de CTA e reduzir latência de follow-up.' } ]
      }
      const arr = goals.slice()
      const idx = arr.findIndex(g => g.id === simpleGoal.id)
      if (idx >= 0) arr[idx] = simpleGoal; else arr.push(simpleGoal)
      saveGoals(arr)
      return
    }
    if (!form.id || !form.title || !form.measure?.cypher) {
      toast({ title: 'Campos obrigatórios', description: 'id, title e measure.cypher são obrigatórios', variant: 'destructive' })
      return
    }
    const arr = goals.slice()
    const idx = arr.findIndex(g => g.id === form.id)
    if (idx >= 0) arr[idx] = form; else arr.push(form)
    saveGoals(arr)
  }

  const remove = (id: string) => {
    const arr = goals.filter(g => g.id !== id)
    saveGoals(arr)
  }

  const evaluateNow = async () => {
    setBusy(true)
    try {
      await apiFetch('/api/goals/evaluate', { method: 'POST' })
      await load()
      toast({ title: 'Reavaliado', description: 'Metas reavaliadas.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setBusy(false) }
  }

  // KPIs
  const kpi = useMemo(() => {
    const latest = new Map<string, Snapshot>();
    for (const s of snaps) {
      const prev = latest.get(s.id);
      if (!prev || Number(s.at||0) > Number(prev.at||0)) latest.set(s.id, s);
    }
    const values = Array.from(latest.values());
    const total = values.length;
    const onTrack = values.filter(v => v.status === 'on_track').length;
    const offTrack = values.filter(v => v.status === 'off_track').length;
    const avgSuccess = values.length ? Math.round((onTrack/values.length)*100) : 0;
    return { total, onTrack, offTrack, avgSuccess };
  }, [snaps]);

  function StatusBadge({ status }: { status?: string }) {
    const s = (status || '').toLowerCase();
    if (s === 'on_track') return <Badge className="bg-green-500 hover:bg-green-600">On track</Badge>
    if (s === 'off_track') return <Badge className="bg-red-500 hover:bg-red-600">Off track</Badge>
    if (s === 'at_risk') return <Badge className="bg-yellow-500 hover:bg-yellow-600">At risk</Badge>
    return <Badge variant="outline">—</Badge>
  }

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailGoalId, setDetailGoalId] = useState<string | null>(null)
  const detailSeries = useMemo(() => {
    if (!detailGoalId) return [] as Array<{ at: number; value: number }>
    return snaps.filter(s => s.id === detailGoalId).slice(-120).map(s => ({ at: s.at, value: Number(s.value || 0) }))
  }, [detailGoalId, snaps])

  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Hero acolhedor */}
        <div className="rounded-2xl bg-secondary/70 backdrop-blur-md border-none shadow-[0_10px_30px_-20px_hsl(var(--foreground)/0.24)] p-5 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Seu progresso importa</div>
            <h1 className="text-2xl font-semibold">Metas do Agente</h1>
            <p className="text-sm text-muted-foreground">Defina objetivos claros e acompanhe sua evolução</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={evaluateNow} disabled={busy}>Reavaliar agora</Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
            <CardContent className="p-4">
              <div className="text-[11px] text-foreground/60 uppercase tracking-wide">Metas</div>
              <div className="text-[28px] font-semibold">{kpi.total}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
            <CardContent className="p-4">
              <div className="text-[11px] text-foreground/60 uppercase tracking-wide">On track</div>
              <div className="text-[28px] font-semibold text-green-600">{kpi.onTrack}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
            <CardContent className="p-4">
              <div className="text-[11px] text-foreground/60 uppercase tracking-wide">Off track</div>
              <div className="text-[28px] font-semibold text-red-600">{kpi.offTrack}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
            <CardContent className="p-4">
              <div className="text-[11px] text-foreground/60 uppercase tracking-wide">Sucesso médio</div>
              <div className="flex items-center gap-3">
                <div className="text-[28px] font-semibold">{kpi.avgSuccess}%</div>
                <div className="flex-1">
                  <Progress value={kpi.avgSuccess} className="h-2" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
          <CardHeader><CardTitle>Criar / Editar Meta</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <Button variant={simpleMode ? 'default' : 'outline'} size="sm" onClick={() => setSimpleMode(true)}>Modo assistido</Button>
              <Button variant={!simpleMode ? 'default' : 'outline'} size="sm" onClick={() => setSimpleMode(false)}>Avançado</Button>
            </div>

            {simpleMode ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <div className="text-xs text-muted-foreground mb-1">Seu objetivo (ex.: Aumentar conversão)</div>
                    <Input
                      value={form.title}
                      onChange={e => {
                        const v = e.target.value
                        setForm({ ...form, title: v })
                        const txt = v.toLowerCase()
                        const infer = ((): string => {
                          if (/(convers|ganh|won|fechad)/.test(txt)) return 'conversion_rate'
                          if (/(reuni|agend)/.test(txt)) return 'meetings_per_week'
                          if (/(propost)/.test(txt)) return 'proposals_per_week'
                          if (/(qualific)/.test(txt)) return 'qualified_per_week'
                          if (/(perfil|complet)/.test(txt)) return 'data_completeness_rate'
                          return selectedTemplateId
                        })()
                        setSelectedTemplateId(infer)
                      }}
                      placeholder="Descreva em uma frase"
                    />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Métrica</div>
                    <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {templates.map(t => (<SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Janela</div>
                    <Select value={(form.window as any) || '7d'} onValueChange={(v) => setForm({ ...form, window: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7d">7 dias</SelectItem>
                        <SelectItem value="30d">30 dias</SelectItem>
                        <SelectItem value="all">Tudo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Direção</div>
                    <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value=">=">≥</SelectItem>
                        <SelectItem value="<=">≤</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Target</div>
                    <Input type="number" value={String(form.target ?? '')} onChange={e => setForm({ ...form, target: Number(e.target.value) })} placeholder="Ex.: 10 ou 0.2 (20%)" />
                </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">ID (opcional)</div>
                    <Input value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} placeholder="(Deixe vazio p/ automático)" />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">ID</div>
                    <Input value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} placeholder="meetings_per_week" />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Título</div>
                    <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Reuniões por semana" />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Janela</div>
                    <Select value={form.window || '7d'} onValueChange={(v) => setForm({ ...form, window: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7d">7 dias</SelectItem>
                        <SelectItem value="30d">30 dias</SelectItem>
                        <SelectItem value="all">Tudo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Target</div>
                    <Input type="number" value={String(form.target ?? 0)} onChange={e => setForm({ ...form, target: Number(e.target.value) })} />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Direção</div>
                    <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value=">=">≥</SelectItem>
                        <SelectItem value="<=">≤</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Tipo</div>
                    <Input value={form.type || ''} onChange={e => setForm({ ...form, type: e.target.value })} placeholder="count | rate | pipeline_stage" />
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Cypher de Medição (retorne 'value')</div>
                  <Textarea value={form.measure?.cypher || ''} onChange={e => setForm({ ...form, measure: { ...(form.measure||{}), cypher: e.target.value } })} rows={5} placeholder="MATCH ... RETURN count(x) AS value" />
                </div>
              </>
            )}
            <div className="flex gap-2">
              <Button onClick={addOrUpdate} disabled={busy}>Salvar Meta</Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
          <CardHeader><CardTitle>Metas Ativas</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Título</TableHead>
                    <TableHead>Janela</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {goals.map((g) => {
                    const s = latestById.get(g.id)
                    return (
                      <TableRow key={g.id}>
                        <TableCell>{g.id}</TableCell>
                        <TableCell>{g.title}</TableCell>
                        <TableCell>{g.window || '7d'}</TableCell>
                        <TableCell>{g.direction} {g.target}</TableCell>
                        <TableCell className="min-w-[180px]">
                          {(s && Number.isFinite(s.value)) ? (
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-medium">{s.value}</div>
                              <div className="flex-1">
                                <Progress value={(() => {
                                  const dir = g.direction;
                                  const tgt = Number(g.target||0);
                                  const val = Number(s.value||0);
                                  if (!Number.isFinite(tgt) || tgt === 0) return 0;
                                  const pct = dir === '>= ' || dir === '>=' ? Math.max(0, Math.min(100, (val/tgt)*100)) : Math.max(0, Math.min(100, (tgt>0 ? (tgt - val)/tgt : 0)*100));
                                  return pct;
                                })()} className="h-2" />
                              </div>
                            </div>
                          ) : '—'}
                        </TableCell>
                        <TableCell><StatusBadge status={s?.status} /></TableCell>
                        <TableCell className="text-right space-x-2">
                          <Button variant="secondary" size="sm" onClick={() => { setDetailGoalId(g.id); setDetailOpen(true) }}>Detalhes</Button>
                          <Button variant="outline" size="sm" onClick={() => setForm(g)}>Editar</Button>
                          <Button variant="destructive" size="sm" className="ml-2" onClick={() => remove(g.id)}>Remover</Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {goals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">Nenhuma meta</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Detalhes da Meta</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {detailGoalId ? (
                <>
                  <div className="text-sm text-muted-foreground">{detailGoalId}</div>
                  <ChartContainer config={{ value: { label: 'Valor', color: 'hsl(var(--primary))' } }} className="w-full h-64">
                    <LineChart data={detailSeries.map(d => ({ ...d, ts: new Date(d.at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) }))}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="ts" hide={false} />
                      <YAxis width={40} allowDecimals={true} />
                      <Line type="monotone" dataKey="value" stroke="var(--color-value)" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <ChartTooltip cursor={true} content={<ChartTooltipContent />} />
                    </LineChart>
                  </ChartContainer>
                </>
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}


