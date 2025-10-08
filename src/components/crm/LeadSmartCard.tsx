import React, { useEffect, useMemo, useState } from 'react'
import type { Lead } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useActivities } from '@/hooks/useActivities'
import { useCommunications } from '@/hooks/useCommunications'
import { apiFetch } from '@/lib/api'
import { MessageSquare, MoreHorizontal, RefreshCw, Compass, Brain } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

interface LeadSmartCardProps {
  lead: Lead
}

export function LeadSmartCard({ lead }: LeadSmartCardProps) {
  const { toast } = useToast()
  const { activities } = useActivities(lead.id)
  const { communications } = useCommunications(lead.id)

  const [waOpen, setWaOpen] = useState(false)
  const [waMsg, setWaMsg] = useState(`Olá ${lead.name}, tudo bem?`)

  // Propostas removidas deste card

  const phoneDigits = String(lead.phone || '').replace(/\D/g, '')

  async function handlePrecall() {
    try {
      if (!phoneDigits) throw new Error('Telefone ausente')
      const r = await apiFetch(`/api/agent/precall?phone=${encodeURIComponent(phoneDigits)}`)
      const js = await r.json().catch(() => ({} as any))
      const q = Array.isArray(js?.suggestedQuestions) && js.suggestedQuestions[0] ? String(js.suggestedQuestions[0]) : null
      if (!q) { toast({ title: 'Sem sugestão', description: 'Nenhuma pergunta sugerida no momento.' }); return }
      try { await navigator.clipboard.writeText(q) } catch {}
      toast({ title: 'Sugestão pronta', description: q })
    } catch (e: any) {
      toast({ title: 'Falha na Próx. Ação', description: String(e?.message || e), variant: 'destructive' })
    }
  }

  async function handleProfileRefresh() {
    try {
      if (!phoneDigits) throw new Error('Telefone ausente')
      const r = await apiFetch('/api/agent/lead-profile/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phoneDigits }) })
      if (!r.ok) throw new Error(await r.text())
      toast({ title: 'Perfil atualizado', description: 'Análise via IA concluída.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    }
  }

  async function handleEmotionRefresh() {
    try {
      if (!phoneDigits) throw new Error('Telefone ausente')
      const r = await apiFetch('/api/agent/lead-emotion/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phoneDigits }) })
      if (!r.ok) throw new Error(await r.text())
      toast({ title: 'Emoção atualizada', description: 'Sinais do agente atualizados.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    }
  }

  return (
    <Card className="border-border/60 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{lead.name} — {lead.company}</CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="text-[10px] uppercase">{lead.status}</Badge>
              <div className="text-xs text-muted-foreground">Resp.: {lead.responsible}</div>
              <div className="text-xs text-muted-foreground">R$ {Number(lead.value||0).toLocaleString('pt-BR')}</div>
              {Array.isArray(lead.tags) && lead.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {lead.tags.slice(0,6).map(t => (<Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {lead.phone && (
              <Button variant="outline" size="sm" onClick={() => setWaOpen(true)}><MessageSquare className="h-4 w-4 mr-1"/>WhatsApp</Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4"/></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handlePrecall}><Compass className="h-4 w-4 mr-2"/>Pré‑call</DropdownMenuItem>
                <DropdownMenuItem onClick={handleProfileRefresh}><Brain className="h-4 w-4 mr-2"/>Perfil (IA)</DropdownMenuItem>
                <DropdownMenuItem onClick={handleEmotionRefresh}><RefreshCw className="h-4 w-4 mr-2"/>Atualizar emoção</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="dados" className="w-full">
          <TabsList className="mb-3 flex flex-wrap">
            <TabsTrigger value="dados">Dados</TabsTrigger>
            <TabsTrigger value="comunicacoes">Comunicações</TabsTrigger>
            <TabsTrigger value="atividades">Atividades</TabsTrigger>
            <TabsTrigger value="insights">Insights</TabsTrigger>
            <TabsTrigger value="arquivos">Arquivos</TabsTrigger>
          </TabsList>

          <TabsContent value="dados" className="space-y-2">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Email</div>
                <div>{lead.email || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Telefone</div>
                <div>{lead.phone || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Origem</div>
                <div>{lead.source}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Último contato</div>
                <div>{lead.last_contact ? new Date(lead.last_contact).toLocaleString('pt-BR') : '—'}</div>
              </div>
            </div>
            {lead.notes && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Observações</div>
                <div className="bg-muted p-2 rounded-md text-sm whitespace-pre-wrap">{lead.notes}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground mb-1">AI Score</div>
              <AILeadScoreInline leadId={lead.id} />
            </div>
          </TabsContent>

          {/* Propostas removidas do Smart Card */}

          <TabsContent value="comunicacoes" className="space-y-2">
            {communications.length === 0 && <p className="text-xs text-muted-foreground">Sem comunicações.</p>}
            {communications.map(c => (
              <Card key={c.id} className="border-border/50 shadow-none">
                <CardContent className="p-3 text-sm">[{c.type} • {c.direction}] {c.content}</CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="atividades" className="space-y-2">
            {activities.length === 0 && <p className="text-xs text-muted-foreground">Sem atividades.</p>}
            {activities.map(a => (
              <Card key={a.id} className="border-border/50 shadow-none">
                <CardContent className="p-3 text-sm"><span className="capitalize">[{a.type}]</span> {a.title} {a.due_date ? `— até ${new Date(a.due_date).toLocaleString('pt-BR')}` : ''}</CardContent>
              </Card>
            ))}
          </TabsContent>

          <TabsContent value="insights">
            <InsightsPanel phoneDigits={phoneDigits} />
          </TabsContent>

          <TabsContent value="arquivos">
            <p className="text-xs text-muted-foreground">Em breve: upload e gerenciamento de arquivos do lead.</p>
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={waOpen} onOpenChange={setWaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar WhatsApp</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="to">Para</Label>
              <Input id="to" value={lead.phone || ''} disabled />
            </div>
            <div className="space-y-1">
              <Label htmlFor="msg">Mensagem</Label>
              <Textarea id="msg" rows={4} value={waMsg} onChange={(e) => setWaMsg(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setWaOpen(false)}>Cancelar</Button>
              <Button onClick={() => { if (!phoneDigits) return; window.open(`https://wa.me/${phoneDigits}?text=${encodeURIComponent(waMsg)}`, '_blank'); setWaOpen(false) }}>Enviar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default LeadSmartCard

function InsightsPanel({ phoneDigits }: { phoneDigits: string }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState({ emotion: false, precall: false, profile: false })
  const [emotion, setEmotion] = useState<{ label?: string; confidence?: number } | null>(null)
  const [precall, setPrecall] = useState<{ suggestedQuestions?: string[]; lastMessages?: any[] } | null>(null)
  const [profile, setProfile] = useState<any | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!phoneDigits) return
      try {
        setLoading(v => ({ ...v, emotion: true }))
        const r = await apiFetch(`/api/agent/lead-emotion?phone=${encodeURIComponent(phoneDigits)}`)
        const js = await r.json().catch(() => ({}))
        if (!cancelled) setEmotion(r.ok ? js : null)
      } catch {} finally { if (!cancelled) setLoading(v => ({ ...v, emotion: false })) }
      try {
        setLoading(v => ({ ...v, profile: true }))
        const r = await apiFetch(`/api/agent/lead-profile?phone=${encodeURIComponent(phoneDigits)}`)
        const js = await r.json().catch(() => ({}))
        if (!cancelled) setProfile(r.ok ? js : null)
      } catch {} finally { if (!cancelled) setLoading(v => ({ ...v, profile: false })) }
    })()
    return () => { cancelled = true }
  }, [phoneDigits])

  async function onPrecall() {
    try {
      if (!phoneDigits) return
      setLoading(v => ({ ...v, precall: true }))
      const r = await apiFetch(`/api/agent/precall?phone=${encodeURIComponent(phoneDigits)}`)
      const js = await r.json().catch(() => ({}))
      setPrecall(r.ok ? js : null)
      const q = Array.isArray(js?.suggestedQuestions) && js.suggestedQuestions[0] ? String(js.suggestedQuestions[0]) : null
      if (q) { try { await navigator.clipboard.writeText(q) } catch {} toast({ title: 'Sugestão pronta', description: q }) }
    } catch (e: any) {
      toast({ title: 'Falha na Próx. Ação', description: String(e?.message || e), variant: 'destructive' })
    } finally { setLoading(v => ({ ...v, precall: false })) }
  }

  async function onProfileRefresh() {
    try {
      if (!phoneDigits) return
      setLoading(v => ({ ...v, profile: true }))
      const r = await apiFetch('/api/agent/lead-profile/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phoneDigits }) })
      if (!r.ok) throw new Error(await r.text())
      const r2 = await apiFetch(`/api/agent/lead-profile?phone=${encodeURIComponent(phoneDigits)}`)
      const js = await r2.json().catch(() => ({}))
      setProfile(r2.ok ? js : null)
      toast({ title: 'Perfil atualizado', description: 'Análise via IA concluída.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setLoading(v => ({ ...v, profile: false })) }
  }

  async function onEmotionRefresh() {
    try {
      if (!phoneDigits) return
      setLoading(v => ({ ...v, emotion: true }))
      const r = await apiFetch('/api/agent/lead-emotion/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phoneDigits }) })
      if (!r.ok) throw new Error(await r.text())
      const r2 = await apiFetch(`/api/agent/lead-emotion?phone=${encodeURIComponent(phoneDigits)}`)
      const js = await r2.json().catch(() => ({}))
      setEmotion(r2.ok ? js : null)
      toast({ title: 'Emoção atualizada', description: 'Sinais do agente atualizados.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setLoading(v => ({ ...v, emotion: false })) }
  }

  const pains = Array.isArray(profile?.pains) ? profile.pains : (Array.isArray(profile?.principaisDores) ? profile.principaisDores : [])
  const interests = Array.isArray(profile?.interests) ? profile.interests : []
  const tags = Array.isArray(profile?.tags) ? profile.tags : []
  const emotionalState = (emotion?.label || profile?.emotionalState || profile?.estadoEmocional || null) as string | null
  const emotionalConfidence = typeof emotion?.confidence === 'number' ? Math.round(emotion.confidence * 100) : (typeof profile?.emotionalConfidence === 'number' ? Math.round(profile.emotionalConfidence * 100) : null)

  return (
    <Card className="border-border/50 shadow-none">
      <CardContent className="p-3 space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onPrecall} disabled={loading.precall}><Compass className="h-4 w-4 mr-1"/>Pré‑call</Button>
          <Button size="sm" variant="outline" onClick={onProfileRefresh} disabled={loading.profile}><Brain className="h-4 w-4 mr-1"/>Perfil (IA)</Button>
          <Button size="sm" variant="outline" onClick={onEmotionRefresh} disabled={loading.emotion}><RefreshCw className="h-4 w-4 mr-1"/>Atualizar emoção</Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Estado emocional</div>
            <div>{emotionalState ? `${emotionalState}${emotionalConfidence != null ? ` (${emotionalConfidence}%)` : ''}` : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Pergunta sugerida</div>
            <div className="truncate" title={(precall?.suggestedQuestions?.[0] || '') as string}>{precall?.suggestedQuestions?.[0] || '—'}</div>
          </div>
          <div className="col-span-2">
            <div className="text-xs text-muted-foreground">Resumo</div>
            <div className="bg-muted p-2 rounded-md">{profile?.lastSummary || profile?.ultimoResumoDaSituacao || '—'}</div>
          </div>
          {interests.length > 0 && (
            <div className="col-span-2">
              <div className="text-xs text-muted-foreground">Interesses</div>
              <div className="flex flex-wrap gap-1">
                {interests.slice(0,6).map((t: string) => (<Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>))}
              </div>
            </div>
          )}
          {tags.length > 0 && (
            <div className="col-span-2">
              <div className="text-xs text-muted-foreground">Tags IA</div>
              <div className="flex flex-wrap gap-1">
                {tags.slice(0,8).map((t: string) => (<Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>))}
              </div>
            </div>
          )}
        </div>

        {Array.isArray(precall?.lastMessages) && precall!.lastMessages!.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Últimas mensagens</div>
            <div className="bg-muted rounded-md p-2 max-h-40 overflow-auto text-xs space-y-1">
              {precall!.lastMessages!.slice(0, 12).map((m: any, i: number) => (
                <div key={i}>• {typeof m === 'string' ? m : JSON.stringify(m)}</div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AILeadScoreInline({ leadId }: { leadId: string }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{ score: number; bucket: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await apiFetch(`/api/leads/ai-score?lead_id=${encodeURIComponent(leadId)}`)
        const js = await r.json().catch(() => ({}))
        if (!cancelled) setData(r.ok && typeof js?.score === 'number' ? { score: js.score, bucket: String(js.bucket || '-') } : null)
        if (!r.ok && !cancelled) toast({ title: 'AI Score indisponível', description: String(js?.error || r.statusText || '—'), variant: 'destructive' })
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [leadId])
  if (loading) return <p className="text-xs text-muted-foreground">Carregando…</p>
  if (!data) return <p className="text-xs text-muted-foreground">—</p>
  return <div className="text-sm"><Badge variant="secondary" className="mr-2">{data.bucket}</Badge>{data.score}/100</div>
}


