import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/components/auth/AuthProvider'
import { useLeads } from '@/hooks/useLeads'
import { Loader2, PlugZap } from 'lucide-react'
import { WhatsAppSidebar as Sidebar } from '@/components/crm/WhatsApp/Sidebar'
import { WhatsAppChat as Chat } from '@/components/crm/WhatsApp/Chat'
import { useCommunications } from '@/hooks/useCommunications'
import { useCommunicationsInfinite } from '@/hooks/useCommunicationsInfinite'
import { apiFetch } from '@/lib/api'

interface PageOption {
  page_id: string
  page_name: string
}

export function MessengerView() {
  const { session } = useAuth()
  const { leads } = useLeads()
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [pages, setPages] = useState<PageOption[]>([])
  const [selectedPageId, setSelectedPageId] = useState<string | undefined>(undefined)
  const [selectedLeadId, setSelectedLeadId] = useState<string | undefined>(undefined)
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const fetchPages = async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/messenger/pages', { headers: { ...authHeader } })
      if (r.status === 400) {
        setConnected(false)
        setPages([])
        return
      }
      if (!r.ok) throw new Error('Falha ao obter páginas do Messenger')
      const json = await r.json()
      setConnected(true)
      setPages(json.pages || [])
    } catch (e) {
      setConnected(false)
      setPages([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPages()
    const onMessage = (ev: MessageEvent) => {
      if (ev?.data?.type === 'messenger_connected') fetchPages()
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
      const r = await apiFetch('/auth/messenger/url', { headers: { ...authHeader } })
      if (!r.ok) throw new Error('Falha ao iniciar OAuth do Messenger')
      const { url } = await r.json()
      window.open(url, 'messenger_oauth', 'width=600,height=800')
    } catch (e) {
      // noop
    }
  }

  const handleSelectPage = async (page_id: string) => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/messenger/select-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ page_id })
      })
      if (!r.ok) throw new Error('Falha ao selecionar página')
      setSelectedPageId(page_id)
    } finally {
      setLoading(false)
    }
  }

  const { communications, sendMessage, isSending } = useCommunications(selectedLeadId, 'messenger')
  const infinite = useCommunicationsInfinite(selectedLeadId, 'messenger')
  const selectedLead = leads.find(l => l.id === selectedLeadId)

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Messenger</h2>
        <p className="text-muted-foreground">Conecte sua Página do Facebook e converse com seus contatos.</p>
      </div>

      <Card className="mb-4">
        <CardContent className="py-3 flex items-center justify-between">
          {connected ? (
            <div className="text-sm">Conta conectada. {pages.length > 0 ? 'Selecione a página abaixo.' : 'Nenhuma página encontrada.'}</div>
          ) : (
            <div className="text-sm text-muted-foreground">Nenhuma conta conectada.</div>
          )}
          {!connected && (
            <Button onClick={handleConnect} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlugZap className="h-4 w-4 mr-2" />}
              Conectar Messenger
            </Button>
          )}
        </CardContent>
      </Card>

      {connected && (
        <div className="flex border border-border rounded-md bg-card overflow-hidden">
          <Sidebar
            leads={leads}
            selectedLeadId={selectedLeadId}
            onSelectLead={setSelectedLeadId as any}
          />
          <div className="flex-1 flex flex-col">
            <div className="h-12 border-b border-border px-3 flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Página selecionada</Label>
              <Select value={selectedPageId} onValueChange={setSelectedPageId as any}>
                <SelectTrigger className="h-8 w-64">
                  <SelectValue placeholder="Escolha uma página" />
                </SelectTrigger>
                <SelectContent>
                  {pages.map(pg => (
                    <SelectItem key={pg.page_id} value={pg.page_id}>{pg.page_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => selectedPageId && handleSelectPage(selectedPageId)}>Usar</Button>
            </div>
            <Chat
              lead={selectedLead}
              messages={infinite.items.length ? infinite.items : communications}
              onSend={(text) => selectedLeadId && sendMessage({ leadId: selectedLeadId, body: text })}
              isSending={isSending}
              onLoadMore={() => infinite.hasNextPage && infinite.fetchNextPage()}
              hasMore={Boolean(infinite.hasNextPage)}
              isLoadingMore={infinite.isFetchingNextPage}
            />
          </div>
        </div>
      )}
    </div>
  )
} 