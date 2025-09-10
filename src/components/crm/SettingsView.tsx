import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  const [phoneLoading, setPhoneLoading] = useState(false)
  const [phoneOptions, setPhoneOptions] = useState<{ id: string; name: string }[]>([])
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [waConnected, setWaConnected] = useState<boolean | null>(null)
  // Não-oficial
  const [waProvider, setWaProvider] = useState<'wapi' | 'zapi' | 'wppconnect' | ''>('wapi')
  const [waInstance, setWaInstance] = useState('')
  const [waToken, setWaToken] = useState('')
  const [waBaseUrl, setWaBaseUrl] = useState('')
  // Organização (não-oficial)
  const [orgWaConnected, setOrgWaConnected] = useState<boolean | null>(null)
  const [orgWaProvider, setOrgWaProvider] = useState<'wapi' | 'zapi' | 'wppconnect' | ''>('wapi')
  const [orgWaInstance, setOrgWaInstance] = useState('')
  const [orgWaToken, setOrgWaToken] = useState('')
  const [orgWaBaseUrl, setOrgWaBaseUrl] = useState('')
  const [orgWaClientToken, setOrgWaClientToken] = useState('')
  const [openUserWaModal, setOpenUserWaModal] = useState(false)
  const [openOrgWaModal, setOpenOrgWaModal] = useState(false)
  // Autentique (por organização)
  const [autConnected, setAutConnected] = useState<boolean | null>(null)
  const [autToken, setAutToken] = useState('')

  // (IA removida)

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
      // Carregar lista de números disponíveis
      try {
        setPhoneLoading(true)
        const r2 = await apiFetch('/api/whatsapp/phones', { headers: { ...authHeader } })
        if (r2.ok) {
          const js = await r2.json()
          const items = Array.isArray(js?.phones) ? js.phones : []
          const mapped = items.map((p: any) => ({ id: String(p?.id || p?.phone_number_id || ''), name: String(p?.display_name || p?.name || p?.id || '') }))
          setPhoneOptions(mapped)
          if (!whatsappPhoneId && mapped.length > 0) setWhatsappPhoneId(mapped[0].id)
        }
      } catch {
      } finally {
        setPhoneLoading(false)
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
        // Autentique: status de conexão
        const rAut = await apiFetch(`/api/org/autentique/config?organization_id=${encodeURIComponent(orgId)}`, { headers: { ...authHeader } })
        if (rAut.ok) {
          const js = await rAut.json()
          setAutConnected(Boolean(js?.connected))
        } else {
          setAutConnected(false)
        }
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

  // (IA removida)

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

  const handleLoadPhones = async () => {
    setPhoneLoading(true)
    try {
      const r = await apiFetch('/api/whatsapp/phones', { headers: { ...authHeader } })
      const js = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(js?.error || 'Falha ao listar números')
      const items = Array.isArray(js?.phones) ? js.phones : []
      const mapped = items.map((p: any) => ({ id: String(p?.id || p?.phone_number_id || ''), name: String(p?.display_name || p?.name || p?.id || '') }))
      setPhoneOptions(mapped)
      if (!whatsappPhoneId && mapped.length > 0) setWhatsappPhoneId(mapped[0].id)
      toast({ title: 'Números carregados', description: `${mapped.length} número(s) disponível(is).` })
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao listar números', variant: 'destructive' })
    } finally {
      setPhoneLoading(false)
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
      const r = await apiFetch('/api/org/whatsapp/wapi/sync-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId, importLeads: false, page: 1, pageSize: 1 })
      })
      const js = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(js?.error || 'Falha ao testar conexão')
      toast({ title: 'Conexão OK', description: 'A integração W-API respondeu com sucesso.' })
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
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp Business</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-4">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Estado da conexão</div>
                    <div className="text-xs text-muted-foreground">Conecte sua conta Meta e habilite o número que será usado.</div>
                  </div>
                  <div className="flex gap-2">
                    {!waConnected ? (
                      <Button onClick={handleConnectWhatsApp}>Conectar conta</Button>
                    ) : (
                      <Button variant="destructive" onClick={handleDisconnectWhatsApp} disabled={loading}>Desconectar</Button>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-medium mb-2">Número do WhatsApp</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                  <div className="sm:col-span-2">
                    {phoneOptions.length > 0 ? (
                      <Select value={whatsappPhoneId} onValueChange={(v) => setWhatsappPhoneId(v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Selecione um número" />
                        </SelectTrigger>
                        <SelectContent>
                          {phoneOptions.map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.name || p.id}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input id="wa-number" placeholder="ex: 123456789012345" value={whatsappPhoneId} onChange={(e) => setWhatsappPhoneId(e.target.value)} />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleLoadPhones} disabled={phoneLoading}>{phoneLoading ? 'Carregando...' : 'Buscar números'}</Button>
                    <Button onClick={handleSaveWhatsAppNumber} disabled={loading || !whatsappPhoneId}>Salvar número</Button>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">Dica: após conectar via OAuth, os números aparecem aqui automaticamente.</div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-medium mb-2">Webhooks (URL do seu sistema)</div>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>Recebimento → <code>/webhooks/whatsapp</code></li>
                  <li>Mensagens recebidas (W-API) → <code>/webhooks/wapi/received</code></li>
                  <li>Entrega (W-API) → <code>/webhooks/wapi/delivery</code></li>
                  <li>Status da mensagem (W-API) → <code>/webhooks/wapi/message-status</code></li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card de Aplicação removido */}

        <Card>
          <CardHeader>
            <CardTitle>WhatsApp (Não-oficial)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Provedor recomendado: W-API. Configure sua conta pessoal.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpenUserWaModal(true)}>Configurar</Button>
              <Button variant="destructive" onClick={handleDisconnectWhatsApp} disabled={loading}>Desconectar</Button>
            </div>
            <p className="text-xs text-muted-foreground">Webhooks W-API:</p>
            <ul className="text-xs text-muted-foreground list-disc list-inside">
              <li>Recebimento → <code>/webhooks/wapi/received</code></li>
              <li>Delivery → <code>/webhooks/wapi/delivery</code></li>
              <li>Status da mensagem → <code>/webhooks/wapi/message-status</code></li>
              <li>Status do chat → <code>/webhooks/wapi/chat-presence</code></li>
              <li>Conectado → <code>/webhooks/wapi/connected</code></li>
              <li>Desconectado → <code>/webhooks/wapi/disconnected</code></li>
            </ul>
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
              <p className="text-xs text-muted-foreground">Webhooks W-API:</p>
              <ul className="text-xs text-muted-foreground list-disc list-inside">
                <li>Recebimento → <code>/webhooks/wapi/received</code></li>
                <li>Delivery → <code>/webhooks/wapi/delivery</code></li>
                <li>Status da mensagem → <code>/webhooks/wapi/message-status</code></li>
                <li>Status do chat → <code>/webhooks/wapi/chat-presence</code></li>
                <li>Conectado → <code>/webhooks/wapi/connected</code></li>
                <li>Desconectado → <code>/webhooks/wapi/disconnected</code></li>
              </ul>
            </CardContent>
          </Card>
        )}

        {/* (IA removida) */}
      </div>

      {/* Modal: WhatsApp Não-oficial (usuário) */}
      <Dialog open={openUserWaModal} onOpenChange={setOpenUserWaModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurar WhatsApp (Não-oficial)</DialogTitle>
            <DialogDescription>Informe as credenciais do provedor (ex.: W-API).</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div>
              <Label htmlFor="wa-prov">Provider</Label>
              <Input id="wa-prov" placeholder="wapi" value={waProvider} onChange={(e) => setWaProvider(e.target.value as any)} />
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
              <Input id="wa-base" placeholder="ex: https://api.w-api.app" value={waBaseUrl} onChange={(e) => setWaBaseUrl(e.target.value)} />
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
              <Input id="org-wa-prov" placeholder="wapi" value={orgWaProvider} onChange={(e) => setOrgWaProvider(e.target.value as any)} />
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
              <Input id="org-wa-base" placeholder="ex: https://api.w-api.app" value={orgWaBaseUrl} onChange={(e) => setOrgWaBaseUrl(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="org-wa-ctok">Client-Token (opcional)</Label>
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


