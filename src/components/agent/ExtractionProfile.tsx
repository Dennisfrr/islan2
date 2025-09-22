import React, { useEffect, useState } from 'react'
import { CardContent } from '@/components/ui/card'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/lib/api'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function ExtractionProfile() {
  const { session } = useAuth()
  const { orgId } = useOrg()
  const { toast } = useToast()
  const authHeader = React.useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : ''
  }), [session?.access_token])

  const [loading, setLoading] = useState(false)
  const [fields, setFields] = useState<Array<{ key: string; label: string; type: string; source?: 'pattern' | 'llm'; required?: boolean; confidence?: number }>>([
    { key: 'budget', label: 'Orçamento', type: 'number', source: 'pattern', required: false, confidence: 0.6 },
    { key: 'pain', label: 'Dor principal', type: 'string', source: 'llm', required: true, confidence: 0.5 },
  ])
  const [instructions, setInstructions] = useState<string>('Extraia orçamento e a principal dor em 1 frase curta.')
  const [wish, setWish] = useState<string>('Quero extrair orçamento, tom emocional e dores latentes')
  const [testText, setTestText] = useState<string>('Ex.: Estou apertado de orçamento, talvez uns 5k. Acho que perdemos vendas pela demora no atendimento.')
  const [testResult, setTestResult] = useState<Record<string, any> | null>(null)

  useEffect(() => {
    const load = async () => {
      if (!orgId) return
      try {
        const r = await apiFetch(`/api/agent/extraction-profile?organization_id=${encodeURIComponent(orgId)}`, { headers: { ...authHeader } })
        if (!r.ok) return
        const js = await r.json().catch(() => ({} as any))
        if (js?.fields) setFields(js.fields)
        if (js?.instructions) setInstructions(js.instructions)
      } catch {}
    }
    load()
  }, [orgId, authHeader])

  async function save() {
    if (!orgId) return
    setLoading(true)
    try {
      const payload = { organization_id: orgId, fields, instructions }
      const r = await apiFetch('/api/agent/extraction-profile', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify(payload) })
      if (!r.ok) throw new Error('Falha ao salvar perfil')
      toast({ title: 'Perfil salvo', description: 'O agente usará essas preferências.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
    } finally { setLoading(false) }
  }

  return (
    <CardContent className="space-y-3">
      <div className="text-sm text-muted-foreground">Defina o que o agente deve extrair e/ou perguntar durante conversas. Use frases simples — nós cuidamos do resto.</div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="md:col-span-2">
          <Label>O que você quer extrair?</Label>
          <Input value={wish} onChange={(e) => setWish(e.target.value)} placeholder="Ex.: orçamento, tom emocional, perfil psicológico, dores latentes" />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={async () => {
            try {
              const r = await apiFetch('/api/agent/extraction-profile/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify({ organization_id: orgId, wish }) })
              if (r.ok) {
                const js = await r.json().catch(()=>({}))
                if (Array.isArray(js?.fields)) setFields(js.fields)
                if (js?.instructions) setInstructions(js.instructions)
                toast({ title: 'Campos gerados', description: 'Revise antes de salvar.' })
              } else {
                const txt = wish.toLowerCase()
                const suggested: Array<any> = []
                if (/orc/.test(txt)) suggested.push({ key: 'budget', label: 'Orçamento', type: 'number', source: 'pattern', confidence: 0.6 })
                if (/emoc|tom/.test(txt)) suggested.push({ key: 'emotion_tone', label: 'Tom emocional', type: 'string', source: 'llm', confidence: 0.5 })
                if (/psicol|perfil/.test(txt)) suggested.push({ key: 'psych_profile', label: 'Perfil psicológico', type: 'string', source: 'llm', confidence: 0.5 })
                if (/dor|latente/.test(txt)) suggested.push({ key: 'latent_pain', label: 'Dor latente', type: 'string', source: 'llm', confidence: 0.5 })
                if (suggested.length) setFields(suggested)
                toast({ title: 'Gerador indisponível', description: 'Usei sugestões locais com base na sua frase.' })
              }
            } catch(e:any) { toast({ title: 'Falha ao gerar', description: String(e?.message||e), variant: 'destructive' }) }
          }}>Gerar campos com Agente</Button>
          <Button type="button" variant="outline" onClick={async () => {
            setTestResult(null)
            try {
              const r = await apiFetch('/api/agent/extraction-profile/test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify({ organization_id: orgId, fields, text: testText }) })
              if (r.ok) {
                const js = await r.json().catch(()=>({}))
                setTestResult(js?.extracted || js || {})
              } else {
                const local: Record<string, any> = {}
                for (const f of fields) {
                  const type = (f.type||'').toLowerCase()
                  const key = (f.key||'').toLowerCase()
                  if (key.includes('email')) {
                    const m = testText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i); if (m) local[f.key]=m[0]
                  } else if (type==='number' || /orcamento|orçamento|budget|valor/.test(key)) {
                    const m = testText.match(/(\d+[\.,]?\d*)\s*(k|mil)?/i); if (m) { let n=parseFloat(m[1].replace(',','.')); if(m[2]) n*=1000; local[f.key]=n }
                  } else {
                    local[f.key]= testText.slice(0,140)
                  }
                }
                setTestResult(local)
              }
            } catch(e:any) { toast({ title: 'Falha no teste', description: String(e?.message||e), variant: 'destructive' }) }
          }}>Testar com conversa</Button>
        </div>
      </div>
      <div className="space-y-2">
        {fields.map((f, idx) => (
          <div key={idx} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-3">
              <Label>Campo</Label>
              <Input value={f.key} onChange={(e) => setFields(prev => prev.map((x, i) => i===idx ? { ...x, key: e.target.value } : x))} />
            </div>
            <div className="col-span-3">
              <Label>Rótulo</Label>
              <Input value={f.label} onChange={(e) => setFields(prev => prev.map((x, i) => i===idx ? { ...x, label: e.target.value } : x))} />
            </div>
            <div className="col-span-2">
              <Label>Tipo</Label>
              <Input value={f.type} onChange={(e) => setFields(prev => prev.map((x, i) => i===idx ? { ...x, type: e.target.value } : x))} />
            </div>
            <div className="col-span-2">
              <Label>Modo</Label>
              <Select value={f.source || 'pattern'} onValueChange={(v: any) => setFields(prev => prev.map((x,i)=> i===idx ? { ...x, source: v } : x))}>
                <SelectTrigger><SelectValue placeholder="Rápido" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pattern">Rápido</SelectItem>
                  <SelectItem value="llm">Inteligente</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Confiança</Label>
              <Input type="number" value={String(f.confidence ?? '')} onChange={(e) => setFields(prev => prev.map((x, i) => i===idx ? { ...x, confidence: Number(e.target.value) } : x))} />
            </div>
            <div className="col-span-2">
              <Label>&nbsp;</Label>
              <Button variant="outline" onClick={() => setFields(prev => prev.filter((_, i) => i!==idx))}>Remover</Button>
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setFields(prev => [...prev, { key: '', label: '', type: 'string', source: 'pattern', required: false, confidence: 0.5 }])}>Adicionar campo</Button>
      </div>
      <div>
        <Label>Instruções</Label>
        <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Como o agente deve interpretar/perguntar" />
      </div>
      <div className="space-y-2">
        <Label>Conversa de teste (opcional)</Label>
        <Input value={testText} onChange={(e) => setTestText(e.target.value)} />
        {testResult && (
          <div className="text-xs text-muted-foreground">Prévia extraída: {JSON.stringify(testResult)}</div>
        )}
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={loading || !orgId}>Salvar perfil</Button>
      </div>
    </CardContent>
  )
}


