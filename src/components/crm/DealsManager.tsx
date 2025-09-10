import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useDeals } from '@/hooks/useDeals'
import { useLeads } from '@/hooks/useLeads'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Trash2, Share2, FileText, Mail, Printer, Link as LinkIcon, CheckCircle2, XCircle, AlertTriangle, FileSignature } from 'lucide-react'
import { DealEditor } from './DealEditor'
import { EmailSendForm as DealsEmailSendForm } from './DealsEmailSendForm'

export function DealsManager() {
  const { deals, isLoading, createDeal, deleteDeal, updateDeal, isCreating, copyPublicLink } = useDeals()
  const { leads } = useLeads()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editorDealId, setEditorDealId] = useState<string | null>(null)
  const [emailOpen, setEmailOpen] = useState<string | null>(null)
  const [busyAutentique, setBusyAutentique] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return deals.filter(d => {
      if (status !== 'all' && d.status !== status) return false
      if (search) {
        const s = search.toLowerCase()
        return d.title.toLowerCase().includes(s) || (d.description || '').toLowerCase().includes(s)
      }
      return true
    })
  }, [deals, status, search])

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const lead_id = (fd.get('lead_id') as string) || null
    const title = fd.get('title') as string
    const description = (fd.get('description') as string) || null
    const valid_until = (fd.get('valid_until') as string) || null
    createDeal({ lead_id, title, description, status: 'draft', valid_until }, { onSuccess: () => setModalOpen(false) })
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Propostas</h2>
          <p className="text-muted-foreground">Crie, edite e compartilhe propostas com seus leads.</p>
        </div>
        <Dialog open={modalOpen} onOpenChange={setModalOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" /> Nova Proposta
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar Proposta</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>Lead (opcional)</Label>
                  <Select name="lead_id">
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione um lead" />
                    </SelectTrigger>
                    <SelectContent>
                      {leads.map(l => (
                        <SelectItem key={l.id} value={l.id}>{l.name} — {l.company}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Validade (opcional)</Label>
                  <Input type="date" name="valid_until" />
                </div>
                <div className="md:col-span-2">
                  <Label>Título</Label>
                  <Input name="title" required />
                </div>
                <div className="md:col-span-2">
                  <Label>Descrição</Label>
                  <Input name="description" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={isCreating}>{isCreating ? 'Criando...' : 'Criar'}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-gradient-card border-border shadow-card mb-4">
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <Label>Busca</Label>
            <Input placeholder="Título/descrição" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as any)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="draft">Rascunho</SelectItem>
                <SelectItem value="sent">Enviada</SelectItem>
                <SelectItem value="accepted">Aceita</SelectItem>
                <SelectItem value="rejected">Recusada</SelectItem>
                <SelectItem value="expired">Expirada</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-3 flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Carregando propostas...
          </div>
        ) : (
          filtered.map((d) => (
            <Card key={d.id} className="bg-gradient-card border-border shadow-card overflow-hidden break-words">
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="truncate">{d.title}</span>
                  <Badge variant="outline" className="capitalize text-xs">{d.status}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 overflow-hidden">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="text-xl font-bold text-primary">R$ {Number(d.total_value || 0).toLocaleString('pt-BR')}</div>
                {d.description && <div className="text-sm text-muted-foreground line-clamp-2 break-words max-w-full">{d.description}</div>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditorDealId(d.id)}>
                    <FileText className="h-4 w-4 mr-2" /> Editar Itens
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => updateDeal({ id: d.id, status: 'sent' })}>
                    <Share2 className="h-4 w-4 mr-2" /> Marcar como Enviada
                  </Button>
                  <Select onValueChange={(v) => updateDeal({ id: d.id, status: v as any })}>
                    <SelectTrigger className="h-8 w-full sm:w-[180px]">
                      <SelectValue placeholder="Alterar status">Alterar status</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft"><AlertTriangle className="h-3 w-3 mr-1 inline" />Rascunho</SelectItem>
                      <SelectItem value="sent"><LinkIcon className="h-3 w-3 mr-1 inline" />Enviada</SelectItem>
                      <SelectItem value="accepted"><CheckCircle2 className="h-3 w-3 mr-1 inline" />Aceita</SelectItem>
                      <SelectItem value="rejected"><XCircle className="h-3 w-3 mr-1 inline" />Recusada</SelectItem>
                      <SelectItem value="expired">Expirada</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => copyPublicLink(d.id)}><LinkIcon className="h-4 w-4 mr-2" />Copiar link</Button>
                  <Button size="sm" variant="outline" onClick={() => setEmailOpen(d.id)}><Mail className="h-4 w-4 mr-2" />Enviar email</Button>
                  <Button size="sm" variant="outline" onClick={async () => {
                    try {
                      setBusyAutentique(d.id)
                      // Buscar lead para obter email/nome
                      const lead = d.lead_id ? await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/leads?id=eq.${d.lead_id}&select=*`, {
                        headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY as string}` }
                      }).then(r => r.json()).then(arr => arr?.[0]) : null
                      const signers = [] as any[]
                      if (lead?.email) {
                        signers.push({ email: lead.email, name: lead.name, action: 'SIGN' })
                      } else {
                        const email = prompt('Email do signatário (cliente) para Autentique:')
                        if (!email) { setBusyAutentique(null); return }
                        signers.push({ email, name: lead?.name || 'Cliente', action: 'SIGN' })
                      }
                      const token = localStorage.getItem('sb-access-token')
                      const r = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/autentique/contracts`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          ...(token ? { Authorization: `Bearer ${token}` } : {}),
                        },
                        body: JSON.stringify({ dealId: d.id, name: d.title, message: 'Contrato enviado via CRM', signers })
                      })
                      if (!r.ok) throw new Error(await r.text())
                      const js = await r.json()
                      alert(`Contrato criado: ${js?.document?.name || ''}`)
                    } catch (e) {
                      alert('Falha ao criar contrato no Autentique')
                    } finally {
                      setBusyAutentique(null)
                    }
                  }} disabled={busyAutentique === d.id}>
                    {busyAutentique === d.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileSignature className="h-4 w-4 mr-2" />}Contrato (Autentique)
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => window.open(`/preview/deal/${d.id}`, '_blank')}><Printer className="h-4 w-4 mr-2" />Imprimir</Button>
                  <Button size="sm" variant="ghost" className="text-destructive ml-auto" onClick={() => deleteDeal(d.id)}>
                    <Trash2 className="h-4 w-4 mr-2" /> Excluir
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <DealEditor open={Boolean(editorDealId)} dealId={editorDealId} onOpenChange={(v) => !v && setEditorDealId(null)} />
      <Dialog open={Boolean(emailOpen)} onOpenChange={(v) => !v && setEmailOpen(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Enviar proposta por email</DialogTitle>
          </DialogHeader>
          {emailOpen && (
            <DealsEmailSendForm dealId={emailOpen} onDone={() => setEmailOpen(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}


