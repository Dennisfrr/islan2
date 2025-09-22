import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
// import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useAuth } from '@/components/auth/AuthProvider'
import { useLeads } from '@/hooks/useLeads'
import { useOrg } from '@/components/org/OrgProvider'
import { useToast } from '@/hooks/use-toast'
import { Loader2 } from 'lucide-react'
import { WhatsAppSidebar } from '@/components/crm/WhatsApp/Sidebar'
import { WhatsAppChat } from '@/components/crm/WhatsApp/Chat'
import { useCommunications, type Communication } from '@/hooks/useCommunications'
import { useCommunicationsInfinite } from '@/hooks/useCommunicationsInfinite'
import { apiFetch } from '@/lib/api'
import { supabase } from '@/lib/supabase'

interface PhoneOption {
  id: string
  number: string
  waba_id: string
}

export function WhatsAppView({ initialLeadId }: { initialLeadId?: string }) {
  const { session } = useAuth()
  const { leads, refetch: refetchLeads } = useLeads()
  const { orgId, orgRole } = useOrg()
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [phones, setPhones] = useState<PhoneOption[]>([])
  const [selectedPhoneId, setSelectedPhoneId] = useState<string | undefined>(undefined)
  const [selectedLeadId, setSelectedLeadId] = useState<string | undefined>(undefined)
  const isDemo = false
  const [demoMessages, setDemoMessages] = useState<Record<string, Communication[]>>({})
  const [syncModalOpen, setSyncModalOpen] = useState(false)
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

  // Login via WhatsApp removed

  // Realtime: ao receber uma comunicação inbound de WhatsApp na org, atualiza lista de leads e sugere seleção
  useEffect(() => {
    if (!orgId) return
    const channel = supabase.channel(`realtime:wa-inbound:${orgId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'communications',
        filter: `organization_id=eq.${orgId}`,
      }, async (payload) => {
        const row = (payload as any)?.new || null
        if (!row) return
        if (row.type !== 'whatsapp' || row.direction !== 'inbound') return
        const leadId = row.lead_id as string | undefined
        await refetchLeads()
        if (!selectedLeadId && leadId) setSelectedLeadId(leadId)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [orgId, refetchLeads, selectedLeadId])

  useEffect(() => {
    if (initialLeadId) {
      setSelectedLeadId(initialLeadId)
      return
    }
    if (!selectedLeadId) {
      const firstWithPhone = leads.find(l => (l.phone || '').toString().length > 0)
      setSelectedLeadId(firstWithPhone?.id)
    }
  }, [leads, selectedLeadId, initialLeadId])

  // OAuth WhatsApp login removed

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

  const handleSyncContacts = async (importLeads: boolean) => {
    try {
      if (!orgId) return
      setLoading(true)
      const r = await apiFetch('/api/org/whatsapp/wapi/sync-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ organization_id: orgId, importLeads, page: 1, pageSize: 200 })
      })
      const js = await r.json()
      if (!r.ok) throw new Error(js?.error || 'Falha ao sincronizar')
      if (importLeads) {
        toast({ title: 'Sincronizado', description: `Importados ${js.imported || 0} contatos para o pipeline.` })
        await refetchLeads()
      } else {
        toast({ title: 'Sincronizado', description: `Contatos sincronizados (sem importar para o pipeline).` })
      }
      // Seleciona um lead com telefone, se nenhum selecionado
      if (!selectedLeadId) {
        const firstWithPhone = (js.chats || [])
          .map((c: any) => String(c.phone || c.id || '').replace(/\D/g, ''))
          .filter((p: string) => p.length > 0)[0]
        if (firstWithPhone) {
          const updatedList = (await refetchLeads()).data || []
          const found = updatedList.find((l: any) => String(l.phone || '').replace(/\D/g, '').endsWith(firstWithPhone.slice(-8)))
          if (found?.id) setSelectedLeadId(found.id)
        }
      }
    } catch (e: any) {
      toast({ title: 'Erro', description: e?.message || 'Falha ao sincronizar', variant: 'destructive' })
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
    <div className="flex-1 overflow-hidden bg-background">
      {/* Top bar estilo WhatsApp (informativo e ações) */}
      <div className="h-12 px-4 flex items-center justify-between bg-secondary border-b border-sidebar-border">
        <div className="text-sm text-foreground/70">
          {connected ? 'Conta conectada.' : 'Nenhuma conta conectada.'}
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <Button variant="outline" size="sm" className="border-sidebar-border" onClick={() => setSyncModalOpen(true)} disabled={loading || !orgId}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Sincronizar contatos
            </Button>
          ) : null}
        </div>
      </div>

      {/* Área principal — duas colunas sem cartões */}
      {connected && (
        <div className="h-[calc(100vh-12rem)] min-h-[520px] flex bg-background">
          <WhatsAppSidebar
            leads={leads}
            selectedLeadId={selectedLeadId}
            onSelectLead={setSelectedLeadId as any}
          />
          <div className="flex-1 flex flex-col min-w-0">
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
      <Dialog open={syncModalOpen} onOpenChange={setSyncModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sincronizar contatos do WhatsApp</DialogTitle>
            <DialogDescription>
              Deseja adicionar os contatos sincronizados ao pipeline (Kanban)? Você pode apenas sincronizar a lista ou importar os contatos como leads.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => { setSyncModalOpen(false); handleSyncContacts(false) }} disabled={loading || !orgId}>
              Apenas sincronizar
            </Button>
            <Button onClick={() => { setSyncModalOpen(false); handleSyncContacts(true) }} disabled={loading || !orgId}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Sincronizar e importar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp login removed */}
    </div>
  )
} 