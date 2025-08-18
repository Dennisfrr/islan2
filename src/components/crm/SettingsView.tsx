import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'

export function SettingsView() {
  const { session } = useAuth()
  const { orgId, orgRole } = useOrg()
  const { toast } = useToast()
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const [loading, setLoading] = useState(false)
  const [whatsappPhoneId, setWhatsappPhoneId] = useState('')
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [waConnected, setWaConnected] = useState<boolean | null>(null)
  // Não-oficial
  const [waProvider, setWaProvider] = useState<'zapi' | ''>('zapi')
  const [waInstance, setWaInstance] = useState('')
  const [waToken, setWaToken] = useState('')
  const [waBaseUrl, setWaBaseUrl] = useState('')
  // Organização (não-oficial)
  const [orgWaConnected, setOrgWaConnected] = useState<boolean | null>(null)
  const [orgWaProvider, setOrgWaProvider] = useState<'zapi' | ''>('zapi')
  const [orgWaInstance, setOrgWaInstance] = useState('')
  const [orgWaToken, setOrgWaToken] = useState('')
  const [orgWaBaseUrl, setOrgWaBaseUrl] = useState('')
  const [orgWaClientToken, setOrgWaClientToken] = useState('')
  const [openUserWaModal, setOpenUserWaModal] = useState(false)
  const [openOrgWaModal, setOpenOrgWaModal] = useState(false)

  // IA por organização
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiProvider, setAiProvider] = useState<'openai' | 'openrouter' | 'groq'>('openai')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiMinScore, setAiMinScore] = useState('0.6')
  const [aiCreateLead, setAiCreateLead] = useState(true)
  const [aiCreateDeal, setAiCreateDeal] = useState(false)
  const [aiStageMapQualified, setAiStageMapQualified] = useState<'new'|'qualified'|'proposal'|'negotiation'|'closed-won'|'closed-lost'>('qualified')
  const [aiStageMapNotQualified, setAiStageMapNotQualified] = useState<'new'|'qualified'|'proposal'|'negotiation'|'closed-won'|'closed-lost'>('new')

  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiFetch('/api/whatsapp/me', { headers: { ...authHeader } })
        if (!r.ok) throw new Error('Falha ao carregar integração do WhatsApp')
        const json = await r.json()
        setWaConnected(Boolean(json.connected))
        setWhatsappPhoneId(json.phone_number_id || '')
      } catch {
        setWaConnected(false)
      }
      // Carregar config não-oficial
      try {
        const r2 = await apiFetch('/api/whatsapp/nonofficial/config', { headers: { ...authHeader } })
        if (r2.ok) {
          const js = await r2.json()
          setWaProvider(js?.config?.provider || '')
          setWaInstance(js?.config?.instance_id || '')
          setWaToken(js?.config?.token || '')
          setWaBaseUrl(js?.config?.base_url || '')
        }
      } catch {}
    }
    load()
    const onMessage = (ev: MessageEvent) => {
      if (ev?.data?.type === 'whatsapp_connected') {
        load()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [authHeader])

  // Carregar configuração da organização quando orgId disponível
  useEffect(() => {
    const loadOrg = async () => {
      if (!orgId) return
      try {
        const r = await apiFetch(`/api/org/whatsapp/nonofficial/config?organization_id=${encodeURIComponent(orgId)}`, { headers: { ...authHeader } })
        if (r.ok) {
          const js = await r.json()
          const cfg = js?.config || null
          setOrgWaProvider(cfg?.provider || '')
          setOrgWaInstance(cfg?.instance_id || '')
          setOrgWaToken(cfg?.token || '')
          setOrgWaBaseUrl(cfg?.base_url || '')
          setOrgWaClientToken(cfg?.client_token || '')
          setOrgWaConnected(Boolean(cfg?.provider && cfg?.instance_id && cfg?.token))
        } else {
          setOrgWaConnected(false)
        }
      } catch {
        setOrgWaConnected(false)
      }
    }
    loadOrg()
  }, [orgId, authHeader])

  // Carregar configuração de IA por org
  useEffect(() => {
    const loadAi = async () => {
      if (!orgId) return
      try {
        const r = await apiFetch(`/api/org/ai-prequal/config?organization_id=${encodeURIComponent(orgId)}`, { headers: { ...authHeader } })
        if (!r.ok) return
        const js = await r.json()
        const cfg = js?.config || null
        if (cfg) {
          setAiEnabled(Boolean(cfg.enabled))
          if (cfg.provider) setAiProvider(cfg.provider)
          if (cfg.model) setAiModel(cfg.model)
          if (typeof cfg.minScore === 'number') setAiMinScore(String(cfg.minScore))
          setAiCreateLead(Boolean(cfg.createLead ?? true))
          setAiCreateDeal(Boolean(cfg.createDeal ?? false))
          if (cfg.stageMap?.qualified) setAiStageMapQualified(cfg.stageMap.qualified)
          if (cfg.stageMap?.notQualified) setAiStageMapNotQualified(cfg.stageMap.notQualified)
        }
      } catch {}
    }
    loadAi()
  }, [orgId, authHeader])

  const handleConnectWhatsApp = async () => {
    try {
      const r = await apiFetch('/auth/whatsapp/url', { headers: { ...authHeader } })
      if (!r.ok) throw new Error('Falha ao iniciar OAuth do WhatsApp')
      const { url } = await r.json()
      window.open(url, 'whatsapp_oauth', 'width=600,height=800')
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao conectar WhatsApp', variant: 'destructive' })
    }
  }

  const handleSaveWhatsAppNumber = async () => {
    if (!whatsappPhoneId) return
    setLoading(true)
    try {
      const r = await apiFetch('/api/whatsapp/select-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ phone_number_id: whatsappPhoneId })
      })
      if (!r.ok) throw new Error('Falha ao salvar número do WhatsApp')
      toast({ title: 'Sucesso', description: 'Número do WhatsApp salvo.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao salvar', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnectWhatsApp = async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/whatsapp/disconnect', { method: 'POST', headers: { ...authHeader } })
      if (!r.ok) throw new Error('Falha ao desconectar')
      setWaConnected(false)
      setWhatsappPhoneId('')
      toast({ title: 'Desconectado', description: 'A conta do WhatsApp foi desconectada.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao desconectar', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSaveNonOfficial = async () => {
    setLoading(true)
    try {
      if (!waProvider || !waInstance || !waToken) throw new Error('Preencha provider, instance e token')
      const r = await apiFetch('/api/whatsapp/nonofficial/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ provider: waProvider, instance_id: waInstance, token: waToken, base_url: waBaseUrl || undefined })
      })
      if (!r.ok) throw new Error('Falha ao salvar configuração')
      toast({ title: 'Salvo', description: 'Configuração do WhatsApp (não-oficial) salva.' })
      setWaConnected(true)
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao salvar configuração', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSaveOrgNonOfficial = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      if (!orgWaProvider || !orgWaInstance || !orgWaToken) throw new Error('Preencha provider, instance e token da organização')
      const r = await apiFetch('/api/org/whatsapp/nonofficial/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId, provider: orgWaProvider, instance_id: orgWaInstance, token: orgWaToken, base_url: orgWaBaseUrl || undefined, client_token: orgWaClientToken || undefined })
      })
      if (!r.ok) throw new Error('Falha ao salvar configuração da organização')
      toast({ title: 'Salvo', description: 'WhatsApp da organização configurado.' })
      setOrgWaConnected(true)
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao salvar configuração da organização', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleTestOrgNonOfficial = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const r = await apiFetch('/api/org/whatsapp/zapi/sync-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId, importLeads: false, page: 1, pageSize: 1 })
      })
      const js = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(js?.error || 'Falha ao testar conexão')
      toast({ title: 'Conexão OK', description: 'A integração Z-API respondeu com sucesso.' })
    } catch (e: any) {
      toast({ title: 'Erro na conexão', description: e?.message || 'Falha ao conectar à API', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnectOrgWhatsApp = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const r = await apiFetch('/api/org/whatsapp/nonofficial/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId })
      })
      if (!r.ok) throw new Error('Falha ao desconectar WhatsApp da organização')
      setOrgWaConnected(false)
      setOrgWaProvider(''); setOrgWaInstance(''); setOrgWaToken(''); setOrgWaBaseUrl('')
      toast({ title: 'Desconectado', description: 'WhatsApp da organização desconectado.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao desconectar', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSaveOrgAi = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const payload = {
        organization_id: orgId,
        enabled: aiEnabled,
        provider: aiProvider,
        model: aiModel,
        minScore: Number(aiMinScore || 0.6),
        createLead: aiCreateLead,
        createDeal: aiCreateDeal,
        stageMap: { qualified: aiStageMapQualified, notQualified: aiStageMapNotQualified },
      }
      const r = await apiFetch('/api/org/ai-prequal/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload)
      })
      if (!r.ok) throw new Error('Falha ao salvar configuração de IA')
      toast({ title: 'Salvo', description: 'Configuração de IA atualizada.' })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao salvar IA', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Configurações</h2>
        <p className="text-muted-foreground">Preferências da organização e integrações.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp Business</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Conecte sua conta e selecione o número padrão.</p>
            <div className="flex gap-2">
              {!waConnected ? (
                <Button onClick={handleConnectWhatsApp}>Conectar conta</Button>
              ) : (
                <Button variant="destructive" onClick={handleDisconnectWhatsApp} disabled={loading}>Desconectar</Button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div className="sm:col-span-2">
                <Label htmlFor="wa-number">Phone Number ID</Label>
                <Input id="wa-number" placeholder="ex: 123456789012345" value={whatsappPhoneId} onChange={(e) => setWhatsappPhoneId(e.target.value)} />
              </div>
              <Button onClick={handleSaveWhatsAppNumber} disabled={loading || !whatsappPhoneId}>Salvar</Button>
            </div>
          </CardContent>
        </Card>

        {/* Card de Aplicação removido */}

        <Card>
          <CardHeader>
            <CardTitle>WhatsApp (Não-oficial)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Provedor recomendado: Z-API. Configure sua conta pessoal.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpenUserWaModal(true)}>Configurar</Button>
              <Button variant="destructive" onClick={handleDisconnectWhatsApp} disabled={loading}>Desconectar</Button>
            </div>
            <p className="text-xs text-muted-foreground">Webhooks Z-API: Recebimento → <code>/webhooks/zapi</code>, Status → <code>/webhooks/zapi/status</code>.</p>
          </CardContent>
        </Card>

        {(orgRole === 'admin' || orgRole === 'manager') && (
          <Card>
            <CardHeader>
              <CardTitle>WhatsApp da Organização (Não-oficial)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Todos os membros usam este WhatsApp se não tiverem configuração própria.</p>
              <div className="flex gap-2">
                <Button onClick={() => setOpenOrgWaModal(true)} disabled={!orgId}>Configurar</Button>
                <Button variant="outline" onClick={handleTestOrgNonOfficial} disabled={loading || !orgId}>Testar conexão</Button>
                <Button variant="destructive" onClick={handleDisconnectOrgWhatsApp} disabled={loading || !orgId}>Desconectar</Button>
              </div>
              <p className="text-xs text-muted-foreground">Webhooks Z-API: Recebimento → <code>/webhooks/zapi</code> e Status → <code>/webhooks/zapi/status</code>.</p>
            </CardContent>
          </Card>
        )}

        {(orgRole === 'admin' || orgRole === 'manager') && (
        <Card>
          <CardHeader>
              <CardTitle>IA de Pré-qualificação</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
                <span className="text-sm">Ativar pré-qualificação automática de leads via WhatsApp</span>
              </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <Label htmlFor="ai-prov">Provider</Label>
                  <Input id="ai-prov" placeholder="openai | openrouter | groq" value={aiProvider} onChange={(e) => setAiProvider(e.target.value as any)} />
                </div>
                <div>
                  <Label htmlFor="ai-model">Model</Label>
                  <Input id="ai-model" placeholder="gpt-4o-mini" value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="ai-min">Min Score</Label>
                  <Input id="ai-min" placeholder="0.6" value={aiMinScore} onChange={(e) => setAiMinScore(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <Label>Stage quando qualificado</Label>
                  <Input value={aiStageMapQualified} onChange={(e) => setAiStageMapQualified(e.target.value as any)} placeholder="qualified" />
                </div>
                <div>
                  <Label>Stage quando não qualificado</Label>
                  <Input value={aiStageMapNotQualified} onChange={(e) => setAiStageMapNotQualified(e.target.value as any)} placeholder="new" />
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch checked={aiCreateLead} onCheckedChange={setAiCreateLead} />
                  <span className="text-sm">Criar lead automaticamente</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={aiCreateDeal} onCheckedChange={setAiCreateDeal} />
                  <span className="text-sm">Criar deal quando qualificado</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveOrgAi} disabled={loading || !orgId}>Salvar configuração de IA</Button>
            </div>
              <p className="text-xs text-muted-foreground">Status válidos: new, qualified, proposal, negotiation, closed-won, closed-lost.</p>
          </CardContent>
        </Card>
        )}
      </div>

      {/* Modal: WhatsApp Não-oficial (usuário) */}
      <Dialog open={openUserWaModal} onOpenChange={setOpenUserWaModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurar WhatsApp (Não-oficial)</DialogTitle>
            <DialogDescription>Informe as credenciais do provedor (ex.: Z-API).</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div>
              <Label htmlFor="wa-prov">Provider</Label>
              <Input id="wa-prov" placeholder="zapi" value={waProvider} onChange={(e) => setWaProvider(e.target.value as any)} />
            </div>
            <div>
              <Label htmlFor="wa-inst">Instance ID</Label>
              <Input id="wa-inst" placeholder="ex: 12345" value={waInstance} onChange={(e) => setWaInstance(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wa-tok">Token</Label>
              <Input id="wa-tok" placeholder="token/ chave API" value={waToken} onChange={(e) => setWaToken(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wa-base">Base URL (opcional)</Label>
              <Input id="wa-base" placeholder="ex: https://api.z-api.io (padrão)" value={waBaseUrl} onChange={(e) => setWaBaseUrl(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenUserWaModal(false)}>Cancelar</Button>
            <Button onClick={async () => { await handleSaveNonOfficial(); setOpenUserWaModal(false) }} disabled={loading}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal: WhatsApp Não-oficial (organização) */}
      <Dialog open={openOrgWaModal} onOpenChange={setOpenOrgWaModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurar WhatsApp da Organização</DialogTitle>
            <DialogDescription>Todos os membros da organização poderão usar esta integração.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <div>
              <Label htmlFor="org-wa-prov">Provider</Label>
              <Input id="org-wa-prov" placeholder="zapi" value={orgWaProvider} onChange={(e) => setOrgWaProvider(e.target.value as any)} />
            </div>
            <div>
              <Label htmlFor="org-wa-inst">Instance ID</Label>
              <Input id="org-wa-inst" placeholder="ex: 12345" value={orgWaInstance} onChange={(e) => setOrgWaInstance(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="org-wa-tok">Token</Label>
              <Input id="org-wa-tok" placeholder="token/ chave API" value={orgWaToken} onChange={(e) => setOrgWaToken(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="org-wa-base">Base URL (opcional)</Label>
              <Input id="org-wa-base" placeholder="ex: https://api.z-api.io (padrão)" value={orgWaBaseUrl} onChange={(e) => setOrgWaBaseUrl(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="org-wa-ctok">Client-Token (Z-API)</Label>
              <Input id="org-wa-ctok" placeholder="seu Client-Token (se exigido)" value={orgWaClientToken} onChange={(e) => setOrgWaClientToken(e.target.value)} />
      </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setOpenOrgWaModal(false)}>Cancelar</Button>
            <Button variant="secondary" onClick={handleTestOrgNonOfficial} disabled={loading || !orgId}>Testar conexão</Button>
            <Button onClick={async () => { await handleSaveOrgNonOfficial(); setOpenOrgWaModal(false) }} disabled={loading || !orgId}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


