import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiFetch } from '@/lib/api'

type ReflectionItem = {
  leadId: string
  leadName?: string
  planName: string
  stepName: string
  agentAction: string
  stepGoalAchieved: boolean
  inferredLeadSentiment?: string
  sentimentConfidenceLabel?: string | null
  sentimentConfidenceScore?: number | null
  timestamp: string | Date
}

type Metrics = {
  planName: string
  totalReflections: number
  successfulSteps: number
  successRate: number
  sentimentCounts: Record<string, number>
}

function useReflections() {
  const [data, setData] = useState<ReflectionItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch('/api/analytics/reflections')
      const js = await r.json()
      if (!r.ok) throw new Error(js?.error || 'failed')
      setData(Array.isArray(js) ? js : [])
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally { setLoading(false) }
  }

  useEffect(() => { refresh() }, [])
  return { data, loading, error, refresh }
}

// client-side metrics based on filtered dataset
function calcMetrics(planName: string, items: ReflectionItem[]): Metrics {
  const totalReflections = items.length
  const successfulSteps = items.filter(r => r.stepGoalAchieved).length
  const successRate = totalReflections ? parseFloat(((successfulSteps / totalReflections) * 100).toFixed(2)) : 0
  const sentimentCounts = items.reduce<Record<string, number>>((acc, r) => {
    if (r.inferredLeadSentiment) acc[r.inferredLeadSentiment] = (acc[r.inferredLeadSentiment] || 0) + 1
    return acc
  }, {})
  return { planName, totalReflections, successfulSteps, successRate, sentimentCounts }
}

function formatRelative(d: string | Date) {
  try {
    const dt = typeof d === 'string' ? new Date(d) : d
    const delta = Date.now() - dt.getTime()
    const mins = Math.floor(delta / 60000)
    if (mins < 1) return 'agora'
    if (mins < 60) return `${mins} min`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs} h`
    const days = Math.floor(hrs / 24)
    return `${days} d`
  } catch { return '-' }
}

export function ReflectionAnalytics({ defaultPlan = 'LeadQualificationToMeeting' }: { defaultPlan?: string }) {
  const { data: reflections, loading: loadingR, error: errorR, refresh: refreshR } = useReflections()

  // filters
  const [plan, setPlan] = useState<string | 'all'>(defaultPlan || 'all')
  const [step, setStep] = useState<string | 'all'>('all')
  const [timeframe, setTimeframe] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
  const [search, setSearch] = useState('')

  const allPlans = useMemo(() => Array.from(new Set((reflections || []).map(r => r.planName))).sort(), [reflections])
  const stepsForPlan = useMemo(() => {
    const list = (reflections || []).filter(r => (plan === 'all' ? true : r.planName === plan)).map(r => r.stepName)
    return Array.from(new Set(list)).sort()
  }, [reflections, plan])

  const filtered = useMemo(() => {
    const items = (reflections || [])
    const now = Date.now()
    let cutoff = 0
    if (timeframe === '24h') cutoff = now - 24 * 60 * 60 * 1000
    else if (timeframe === '7d') cutoff = now - 7 * 24 * 60 * 60 * 1000
    else if (timeframe === '30d') cutoff = now - 30 * 24 * 60 * 60 * 1000

    const q = search.trim().toLowerCase()
    return items.filter(r => {
      if (plan !== 'all' && r.planName !== plan) return false
      if (step !== 'all' && r.stepName !== step) return false
      if (timeframe !== 'all') {
        const ts = new Date(r.timestamp as any).getTime()
        if (isFinite(ts) && ts < cutoff) return false
      }
      if (q) {
        const lead = (r.leadName || r.leadId || '').toLowerCase()
        if (!lead.includes(q)) return false
      }
      return true
    })
  }, [reflections, plan, step, timeframe, search])

  const metrics = useMemo(() => calcMetrics(plan === 'all' ? 'Todos' : plan, filtered), [filtered, plan])
  const sentiments = useMemo(() => {
    const obj = metrics?.sentimentCounts || {}
    return Object.keys(obj).sort((a, b) => (obj[b] - obj[a]))
  }, [metrics])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reflexões — Métricas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Plano</div>
              <Select value={plan} onValueChange={(v) => { setPlan(v as any); setStep('all') }}>
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {allPlans.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Etapa</div>
              <Select value={step} onValueChange={(v) => setStep(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {stepsForPlan.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Período</div>
              <Select value={timeframe} onValueChange={(v) => setTimeframe(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">Últimas 24h</SelectItem>
                  <SelectItem value="7d">Últimos 7 dias</SelectItem>
                  <SelectItem value="30d">Últimos 30 dias</SelectItem>
                  <SelectItem value="all">Tudo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Buscar Lead (nome/ID)</div>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ex.: João, 55119..." />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-muted-foreground">Plano</div>
              <div className="font-medium truncate">{metrics?.planName || plan || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Reflexões</div>
              <div className="font-medium">{loadingR ? '…' : (metrics?.totalReflections ?? 0)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Avanços de Etapa</div>
              <div className="font-medium">{loadingR ? '…' : (metrics?.successfulSteps ?? 0)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Taxa de Sucesso</div>
              <div className="font-medium">{loadingR ? '…' : `${metrics?.successRate ?? 0}%`}</div>
            </div>
          </div>
          <Separator />
          <div>
            <div className="text-xs text-muted-foreground mb-2">Sentimentos</div>
            <div className="flex flex-wrap gap-2">
              {sentiments.length === 0 && <span className="text-sm text-muted-foreground">—</span>}
              {sentiments.map(s => (
                <Badge key={s} variant="secondary">{s}: {metrics?.sentimentCounts?.[s]}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reflexões — Recentes</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Plano/Etapa</TableHead>
                  <TableHead>Ação do Agente</TableHead>
                  <TableHead>Sentimento</TableHead>
                  <TableHead>Conf.</TableHead>
                  <TableHead>Avançou</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(-20).reverse().map((r, idx) => (
                  <TableRow key={idx}>
                    <TableCell>{formatRelative(r.timestamp)}</TableCell>
                    <TableCell title={r.leadId}>{r.leadName || r.leadId?.slice(0, 6) + '…'}</TableCell>
                    <TableCell><span className="font-medium">{r.planName}</span> <span className="text-muted-foreground">/ {r.stepName}</span></TableCell>
                    <TableCell className="max-w-[280px] truncate" title={r.agentAction}>{r.agentAction}</TableCell>
                    <TableCell>{r.inferredLeadSentiment || '—'}</TableCell>
                    <TableCell>{typeof r.sentimentConfidenceScore === 'number' ? r.sentimentConfidenceScore.toFixed(2) : (r.sentimentConfidenceLabel || '—')}</TableCell>
                    <TableCell>{r.stepGoalAchieved ? '✅' : '—'}</TableCell>
                  </TableRow>
                ))}
                {(!filtered || filtered.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">Sem dados</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default ReflectionAnalytics


