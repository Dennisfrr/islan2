import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'
import React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function SettingsView() {
  const { session } = useAuth()
  const { orgId, orgRole } = useOrg()
  const { toast } = useToast()
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const [loading, setLoading] = useState(false)
  // WhatsApp via WPPConnect removido
  // Autentique (por organização)
  const [autConnected, setAutConnected] = useState<boolean | null>(null)
  const [autToken, setAutToken] = useState('')

  // (IA removida)

  // Carregamento de WPPConnect removido

  // Carregar status do Autentique quando orgId disponível
  useEffect(() => {
    const loadAut = async () => {
      if (!orgId) return
      try {
        const rAut = await apiFetch(`/api/org/autentique/config?organization_id=${encodeURIComponent(orgId)}`, { headers: { ...authHeader } })
        if (rAut.ok) {
          const js = await rAut.json()
          setAutConnected(Boolean(js?.connected))
        } else {
          setAutConnected(false)
        }
      } catch {
        setAutConnected(false)
      }
    }
    loadAut()
  }, [orgId, authHeader])

  // (IA removida)

  // WPPConnect handlers removidos

  const handleSaveAutentique = async () => {
    if (!orgId || !autToken) return
    setLoading(true)
    try {
      const r = await apiFetch('/api/org/autentique/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId, token: autToken })
      })
      if (!r.ok) throw new Error('Falha ao salvar token do Autentique')
      setAutConnected(true)
      setAutToken('')
      toast({ title: 'Autentique conectado', description: 'Token salvo para a organização.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao salvar token', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // (IA removida)

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Configurações</h2>
        <p className="text-muted-foreground">Preferências da organização e integrações.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Autentique (Contratos)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Status</div>
                  <div className="text-xs text-muted-foreground">Token da organização para criação de contratos.</div>
                </div>
                <div className="text-xs">{autConnected ? 'Conectado' : 'Desconectado'}</div>
              </div>
              {(orgRole === 'admin' || orgRole === 'manager') && (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-3 items-end">
                  <div className="sm:col-span-3">
                    <Label htmlFor="aut-token">Token do Autentique</Label>
                    <Input id="aut-token" placeholder="Cole o token da API" value={autToken} onChange={(e) => setAutToken(e.target.value)} />
                  </div>
                  <div className="sm:col-span-1 flex gap-2">
                    <Button onClick={handleSaveAutentique} disabled={loading || !orgId || !autToken}>Salvar</Button>
                  </div>
                </div>
              )}
              <div className="mt-2 text-[11px] text-muted-foreground">Somente admin/manager pode salvar o token. Os membros da organização poderão criar contratos usando esse token.</div>
            </div>
          </CardContent>
        </Card>
        {/* Integração WhatsApp via WPPConnect removida */}

        {/* Move Extraction Profile para a página Strategies */}
      </div>

    </div>
  )
}
function ExtractionProfile() {
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
  const [instructions, setInstructions] = useState<string>('Extraia orçamento aproximado e a principal dor em 1 frase curta.')

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
      <div className="text-sm text-muted-foreground">Defina o que o agente deve extrair de conversas e registros.</div>
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
              <Label>Fonte</Label>
              <Select value={f.source || 'pattern'} onValueChange={(v: any) => setFields(prev => prev.map((x,i)=> i===idx ? { ...x, source: v } : x))}>
                <SelectTrigger><SelectValue placeholder="pattern" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pattern">Leve (regex/padrão)</SelectItem>
                  <SelectItem value="llm">LLM (semântico)</SelectItem>
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
        <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Como o agente deve interpretar os campos" />
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={loading || !orgId}>Salvar perfil</Button>
      </div>
    </CardContent>
  )
}


