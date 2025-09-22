import React, { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/lib/api'

type Props = { open: boolean; onOpenChange: (v: boolean) => void }

const templates = [
  { id: 'conversion_rate', label: 'Taxa de conversão (Won / Leads)', direction: '>=' as const, defaultTarget: 0.2, defaultWindow: '30d' as const },
  { id: 'meetings_per_week', label: 'Reuniões por semana (Agendado)', direction: '>=' as const, defaultTarget: 10, defaultWindow: '7d' as const },
  { id: 'proposals_per_week', label: 'Propostas por semana (Proposta)', direction: '>=' as const, defaultTarget: 15, defaultWindow: '7d' as const },
  { id: 'qualified_per_week', label: 'Qualificados por semana (Qualificado)', direction: '>=' as const, defaultTarget: 20, defaultWindow: '7d' as const },
]

export default function GoalCoach({ open, onOpenChange }: Props) {
  const { toast } = useToast()
  const [objective, setObjective] = useState('')
  const [metric, setMetric] = useState<string>('conversion_rate')
  const [windowVal, setWindowVal] = useState<'7d' | '30d' | 'all'>('30d')
  const [direction, setDirection] = useState<'>=' | '<='>('>=')
  const [target, setTarget] = useState<number>(0.2)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const txt = objective.toLowerCase()
    const infer = () => {
      if (/(convers|ganh|won|fechad)/.test(txt)) return 'conversion_rate'
      if (/(reuni|agend)/.test(txt)) return 'meetings_per_week'
      if (/(propost)/.test(txt)) return 'proposals_per_week'
      if (/(qualific)/.test(txt)) return 'qualified_per_week'
      return metric
    }
    const m = infer()
    setMetric(m)
    const tpl = templates.find(t => t.id === m)!
    setDirection(tpl.direction)
    setTarget(tpl.defaultTarget)
    setWindowVal(tpl.defaultWindow)
  }, [objective])

  async function create() {
    try {
      setBusy(true)
      // server generates cypher based on metric id
      const r = await apiFetch('/api/goals/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: objective || templates.find(t => t.id === metric)?.label,
          type: metric,
          window: windowVal,
          direction,
          target,
        })
      })
      if (!r.ok) throw new Error('Falha ao criar meta')
      toast({ title: 'Meta criada', description: 'Acompanhe em Metas' })
      onOpenChange(false)
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Defina um objetivo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Ex.: Aumentar conversão" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Métrica</div>
              <Select value={metric} onValueChange={(v) => setMetric(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {templates.map(t => (<SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Janela</div>
              <Select value={windowVal} onValueChange={(v: any) => setWindowVal(v)}>
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
              <Select value={direction} onValueChange={(v: any) => setDirection(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value=">=">≥</SelectItem>
                  <SelectItem value="<=">≤</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Target</div>
              <Input type="number" value={String(target)} onChange={(e) => setTarget(Number(e.target.value))} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={create} disabled={busy || !objective.trim()}>Criar meta</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}


