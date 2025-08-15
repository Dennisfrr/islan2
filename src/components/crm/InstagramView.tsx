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

interface AccountOption {
  ig_user_id: string
  username: string
  page_id: string
  page_name: string
}

export function InstagramView() {
  const { session } = useAuth()
  const { leads } = useLeads()
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined)
  const [selectedLeadId, setSelectedLeadId] = useState<string | undefined>(undefined)
  const authHeader = useMemo(() => ({
    Authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
  }), [session?.access_token])

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/instagram/accounts', { headers: { ...authHeader } })
      if (r.status === 400) {
        setConnected(false)
        setAccounts([])
        return
      }
      if (!r.ok) throw new Error('Falha ao obter contas do Instagram')
      const json = await r.json()
      setConnected(true)
      setAccounts(json.accounts || [])
    } catch (e) {
      setConnected(false)
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAccounts()
    const onMessage = (ev: MessageEvent) => {
      if (ev?.data?.type === 'instagram_connected') fetchAccounts()
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
      const r = await apiFetch('/auth/instagram/url', { headers: { ...authHeader } })
      if (!r.ok) throw new Error('Falha ao iniciar OAuth do Instagram')
      const { url } = await r.json()
      window.open(url, 'instagram_oauth', 'width=600,height=800')
    } catch (e) {
      // noop
    }
  }

  const handleSelectAccount = async (ig_user_id: string) => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/instagram/select-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ ig_user_id })
      })
      if (!r.ok) throw new Error('Falha ao selecionar conta')
      setSelectedAccountId(ig_user_id)
    } finally {
      setLoading(false)
    }
  }

  const { communications, sendMessage, isSending } = useCommunications(selectedLeadId, 'instagram')
  const infinite = useCommunicationsInfinite(selectedLeadId, 'instagram')
  const selectedLead = leads.find(l => l.id === selectedLeadId)

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Instagram</h2>
        <p className="text-muted-foreground">Conecte sua conta do Instagram Business e converse com seus contatos.</p>
      </div>

      <Card className="mb-4">
        <CardContent className="py-3 flex items-center justify-between">
          {connected ? (
            <div className="text-sm">Conta conectada. {accounts.length > 0 ? 'Selecione a conta abaixo.' : 'Nenhuma conta IG encontrada nas suas Páginas.'}</div>
          ) : (
            <div className="text-sm text-muted-foreground">Nenhuma conta conectada.</div>
          )}
          {!connected && (
            <Button onClick={handleConnect} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlugZap className="h-4 w-4 mr-2" />}
              Conectar Instagram
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
              <Label className="text-xs text-muted-foreground">Conta selecionada</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId as any}>
                <SelectTrigger className="h-8 w-64">
                  <SelectValue placeholder="Escolha uma conta" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map(acc => (
                    <SelectItem key={acc.ig_user_id} value={acc.ig_user_id}>@{acc.username} — {acc.page_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => selectedAccountId && handleSelectAccount(selectedAccountId)}>Usar</Button>
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