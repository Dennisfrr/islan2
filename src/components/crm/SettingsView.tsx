import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/components/auth/AuthProvider'
import { useToast } from '@/hooks/use-toast'
import { apiFetch } from '@/lib/api'

export function SettingsView() {
  const { session } = useAuth()
  const { toast } = useToast()
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const [loading, setLoading] = useState(false)
  const [whatsappPhoneId, setWhatsappPhoneId] = useState('')
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [waConnected, setWaConnected] = useState<boolean | null>(null)

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

        <Card>
          <CardHeader>
            <CardTitle>Aplicação</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Ajuda com links de e-mail e redirecionamentos.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div className="sm:col-span-2">
                <Label htmlFor="public-url">URL pública (informativa)</Label>
                <Input id="public-url" placeholder="http(s)://seu-dominio" value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} />
              </div>
              <Button type="button" variant="outline" disabled>Salvar</Button>
            </div>
            <p className="text-xs text-muted-foreground">Nota: a URL pública efetiva usada pelo backend vem de PUBLIC_BASE_URL/CORS_ORIGIN no servidor.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}


