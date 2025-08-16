import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/components/auth/AuthProvider'
import { useLeads } from '@/hooks/useLeads'
import { Loader2, PlugZap, Phone, Send } from 'lucide-react'
import { WhatsAppSidebar } from '@/components/crm/WhatsApp/Sidebar'
import { WhatsAppChat } from '@/components/crm/WhatsApp/Chat'
import { useCommunications, type Communication } from '@/hooks/useCommunications'
import { useCommunicationsInfinite } from '@/hooks/useCommunicationsInfinite'
import { apiFetch } from '@/lib/api'

interface PhoneOption {
  id: string
  number: string
  waba_id: string
}

export function WhatsAppView() {
  const { session } = useAuth()
  const { leads } = useLeads()
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [phones, setPhones] = useState<PhoneOption[]>([])
  const [selectedPhoneId, setSelectedPhoneId] = useState<string | undefined>(undefined)
  const [selectedLeadId, setSelectedLeadId] = useState<string | undefined>(undefined)
  const isDemo = true
  const [demoMessages, setDemoMessages] = useState<Record<string, Communication[]>>({})
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const fetchPhones = async () => {
    setLoading(true)
    try {
      if (isDemo) {
        setConnected(true)
        const mock = [{ id: 'demo-phone-1', number: '+55 11 99999-0000', waba_id: 'demo' }]
        setPhones(mock)
        setSelectedPhoneId(mock[0].id)
      } else {
        // Primeiro checa status
        const me = await apiFetch('/api/whatsapp/me', { headers: { ...authHeader } })
        if (me.ok) {
          const js = await me.json()
          setConnected(Boolean(js.connected))
          if (js.phone_number_id) setSelectedPhoneId(js.phone_number_id)
        }

        const r = await apiFetch('/api/whatsapp/phones', { headers: { ...authHeader } })
        if (r.status === 400) {
          setConnected(false)
          setPhones([])
          return
        }
        if (!r.ok) throw new Error('Falha ao obter números do WhatsApp')
        const json = await r.json()
        setConnected(true)
        setPhones(json.phones || [])
      }
    } catch (e) {
      setConnected(false)
      setPhones([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPhones()
    const onMessage = (ev: MessageEvent) => {
      if (ev?.data?.type === 'whatsapp_connected') {
        fetchPhones()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!selectedLeadId) {
      const firstWithPhone = leads.find(l => (l.phone || '').toString().length > 0)
      setSelectedLeadId(firstWithPhone?.id)
    }
  }, [leads, selectedLeadId])

  const handleConnect = async () => {
    try {
      if (isDemo) return
      const r = await apiFetch('/auth/whatsapp/url', { headers: { ...authHeader } })
      if (!r.ok) throw new Error('Falha ao iniciar OAuth do WhatsApp')
      const { url } = await r.json()
      window.open(url, 'whatsapp_oauth', 'width=600,height=800')
    } catch (e) {
      // noop
    }
  }

  const handleSelectPhone = async (phone_number_id: string) => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/whatsapp/select-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ phone_number_id })
      })
      if (!r.ok) throw new Error('Falha ao selecionar número')
      setSelectedPhoneId(phone_number_id)
    } finally {
      setLoading(false)
    }
  }

  const { communications, isLoading: isLoadingComms, sendMessage, isSending } = useCommunications(selectedLeadId, 'whatsapp')
  const infinite = useCommunicationsInfinite(selectedLeadId, 'whatsapp')
  const selectedLead = leads.find(l => l.id === selectedLeadId)

  // Demo: mensagens locais por lead
  useEffect(() => {
    if (!isDemo) return
    if (!selectedLeadId) return
    setDemoMessages((prev) => {
      if (prev[selectedLeadId]) return prev
      const seed: Communication[] = [
        {
          id: 'demo-' + Math.random().toString(36).slice(2),
          lead_id: selectedLeadId,
          user_id: '',
          type: 'whatsapp',
          direction: 'inbound',
          subject: null,
          content: 'Olá! Como posso ajudar?',
          status: 'read',
          external_id: null,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ]
      return { ...prev, [selectedLeadId]: seed }
    })
  }, [isDemo, selectedLeadId])

  const demoSend = (text: string) => {
    if (!selectedLeadId) return
    const now = new Date().toISOString()
    setDemoMessages((prev) => {
      const list = prev[selectedLeadId] || []
      const out: Communication = {
        id: 'demo-' + Math.random().toString(36).slice(2),
        lead_id: selectedLeadId,
        user_id: '',
        type: 'whatsapp',
        direction: 'outbound',
        subject: null,
        content: text,
        status: 'sent',
        external_id: null,
        created_at: now,
      }
      return { ...prev, [selectedLeadId]: [...list, out] }
    })
    // eco simulado
    setTimeout(() => {
      setDemoMessages((prev) => {
        const list = prev[selectedLeadId] || []
        const inbound: Communication = {
          id: 'demo-' + Math.random().toString(36).slice(2),
          lead_id: selectedLeadId,
          user_id: '',
          type: 'whatsapp',
          direction: 'inbound',
          subject: null,
          content: 'Recebido 👍',
          status: 'read',
          external_id: null,
          created_at: new Date().toISOString(),
        }
        return { ...prev, [selectedLeadId]: [...list, inbound] }
      })
    }, 800)
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      {!isDemo && (
        <div className="mb-4">
          <h2 className="text-2xl font-bold text-foreground">WhatsApp</h2>
          <p className="text-muted-foreground">Conecte sua conta do WhatsApp Business e converse com seus contatos.</p>
        </div>
      )}

      {!isDemo && (
        <Card className="mb-4">
          <CardContent className="py-3 flex items-center justify-between">
            {connected ? (
              <div className="text-sm">Conta conectada. {phones.length > 0 ? 'Selecione o número preferido abaixo.' : 'Nenhum número encontrado.'}</div>
            ) : (
              <div className="text-sm text-muted-foreground">Nenhuma conta conectada.</div>
            )}
            <div className="flex items-center gap-2">
              {!connected && (
                <Button onClick={handleConnect} disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlugZap className="h-4 w-4 mr-2" />}
                  Conectar WhatsApp
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {connected && (
        <div className="flex border border-border rounded-md bg-card overflow-hidden h-[78vh] min-h-[520px]">
          <WhatsAppSidebar
            leads={leads}
            selectedLeadId={selectedLeadId}
            onSelectLead={setSelectedLeadId as any}
          />
          <div className="flex-1 flex flex-col min-w-0">
            {!isDemo && (
              <div className="h-12 border-b border-border px-3 flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Número selecionado</Label>
                <Select value={selectedPhoneId} onValueChange={setSelectedPhoneId as any}>
                  <SelectTrigger className="h-8 w-64">
                    <SelectValue placeholder="Escolha um número" />
                  </SelectTrigger>
                  <SelectContent>
                    {phones.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.number}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => selectedPhoneId && handleSelectPhone(selectedPhoneId)}>Usar</Button>
              </div>
            )}
            <WhatsAppChat
              lead={selectedLead}
              messages={isDemo ? (demoMessages[selectedLeadId || ''] || []) : (infinite.items.length ? infinite.items : communications)}
              onSend={(text) => isDemo ? demoSend(text) : (selectedLeadId && sendMessage({ leadId: selectedLeadId, body: text }))}
              isSending={isDemo ? false : isSending}
              onLoadMore={() => { if (!isDemo && infinite.hasNextPage) infinite.fetchNextPage() }}
              hasMore={isDemo ? false : Boolean(infinite.hasNextPage)}
              isLoadingMore={isDemo ? false : infinite.isFetchingNextPage}
            />
          </div>
        </div>
      )}
    </div>
  )
} 