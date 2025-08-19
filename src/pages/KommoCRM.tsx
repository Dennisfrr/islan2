import { useState, useEffect, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { DndContext, closestCenter, DragEndEvent } from "@dnd-kit/core"
import { Plus, Search, MoreHorizontal, Eye, Edit, Trash2, Download, Filter, Loader2, LogOut } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/components/auth/AuthProvider"
import { useLeads, useLeadStats } from "@/hooks/useLeads"
import { useOrg } from "@/components/org/OrgProvider"
import { apiFetch } from "@/lib/api"
import { CRMSidebar } from "@/components/crm/CRMSidebar"
import { PipelineStage } from "@/components/crm/PipelineStage"
// Produtos removido
import { ActivitiesView } from "@/components/crm/ActivitiesView"
import { SettingsView } from "@/components/crm/SettingsView"
import { WhatsAppView } from "@/components/crm/WhatsAppView"
import { EmployeesView } from "@/components/crm/EmployeesView"
import { LeadTimeline } from "@/components/crm/LeadTimeline"
import { DealsManager } from "@/components/crm/DealsManager"
// Settings removida
import { QuickChat } from "@/components/crm/WhatsApp/QuickChat"

const defaultPipelineStages = [
  { id: "new", name: "Novos Leads", color: "bg-blue-500", count: 0 },
  { id: "qualified", name: "Qualificados", color: "bg-yellow-500", count: 0 },
  { id: "proposal", name: "Proposta", color: "bg-orange-500", count: 0 },
  { id: "negotiation", name: "Negociação", color: "bg-purple-500", count: 0 },
  { id: "closed-won", name: "Fechados", color: "bg-green-500", count: 0 },
  { id: "closed-lost", name: "Perdidos", color: "bg-red-500", count: 0 }
]

export default function KommoCRM() {
  const { user, role, signOut, session } = useAuth()
  const { orgId, orgRole } = useOrg()
  const { leads, isLoading, error, createLead, updateLead, deleteLead, isCreating, isUpdating, isDeleting } = useLeads()
  const stats = useLeadStats()
  const queryClient = useQueryClient()
  
  const [selectedView, setSelectedView] = useState("pipeline")
  const [selectedChatLeadId, setSelectedChatLeadId] = useState<string | null>(null)
  const [isQuickChatOpen, setIsQuickChatOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterResponsible, setFilterResponsible] = useState<string>("all")
  const [filterSource, setFilterSource] = useState<string>("all")
  const [minValue, setMinValue] = useState<string>("")
  const [maxValue, setMaxValue] = useState<string>("")
  const [selectedLead, setSelectedLead] = useState<any>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [pendingCreateStatus, setPendingCreateStatus] = useState<string | null>(null)
  const [isBulkCreateOpen, setIsBulkCreateOpen] = useState(false)
  const [isAddStageOpen, setIsAddStageOpen] = useState(false)
  const [newStageId, setNewStageId] = useState('')
  const [newStageName, setNewStageName] = useState('')
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false)
  const { toast } = useToast()
  // Carregar labels do pipeline (persistidos no backend)
  useEffect(() => {
    const load = async () => {
      if (!orgId) return
      try {
        const r = await apiFetch(`/api/org/pipeline/config?organization_id=${encodeURIComponent(orgId)}`,
          { headers: { ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) } }
        )
        if (!r.ok) return
        const js = await r.json()
        const cfg = js?.config || null
        if (cfg?.stageLabels) setStageLabels(cfg.stageLabels)
      } catch {}
    }
    load()
  }, [orgId, session?.access_token])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return

    const leadId = String(active.id)
    // Se estiver sobre um item (lead), usamos o containerId (que é o id do estágio)
    const overContainerId = (over.data && (over.data as any).current && (over.data as any).current.sortable && (over.data as any).current.sortable.containerId) || null
    const targetStageId = String(overContainerId || over.id)

    // Garante que estamos movendo para um estágio válido do pipeline
    const validStageIds = new Set(pipelineStages.map(s => s.id))
    if (!validStageIds.has(targetStageId)) return

    const lead = leads.find(l => l.id === leadId)
    if (lead && lead.status !== targetStageId) {
      handleUpdateLeadStatus(leadId, targetStageId as any)
    }
  }

  // Unique options for filters
  const responsibleOptions = Array.from(new Set(leads.map(l => l.responsible))).filter(Boolean)
  const sourceOptions = Array.from(new Set(leads.map(l => l.source))).filter(Boolean)

  // Filtro principal
  const filteredLeads = leads.filter(lead => {
    const matchesSearch = lead.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         lead.company.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStatus = filterStatus === "all" || lead.status === filterStatus
    const matchesResp = filterResponsible === "all" || lead.responsible === filterResponsible
    const matchesSource = filterSource === "all" || lead.source === filterSource
    const minOk = !minValue || lead.value >= Number(minValue)
    const maxOk = !maxValue || lead.value <= Number(maxValue)
    return matchesSearch && matchesStatus && matchesResp && matchesSource && minOk && maxOk
  })

  // Labels do pipeline
  const [stageLabels, setStageLabels] = useState<Record<string, string>>({})
  const [isEditStagesOpen, setIsEditStagesOpen] = useState(false)
  const [savingStages, setSavingStages] = useState(false)

  // Construir lista de estágios aplicando labels customizados
  const pipelineStages = useMemo(() => {
    // defaults com labels aplicados
    const base = defaultPipelineStages.map(s => ({ ...s, name: stageLabels[s.id] || s.name }))
    // extras vindos de stageLabels não presentes nos defaults
    const defaultIds = new Set(base.map(s => s.id))
    const extras = Object.entries(stageLabels || {})
      .filter(([id]) => !defaultIds.has(id))
      .map(([id, name]) => ({ id, name: String(name || id), color: 'bg-gray-500', count: 0 }))
    return [...base, ...extras]
  }, [stageLabels])

  // Stats por estágio (após filtros)
  const stageStats = pipelineStages.map(stage => {
    const items = filteredLeads.filter(lead => lead.status === stage.id)
    const value = items.reduce((sum, l) => sum + (Number(l.value) || 0), 0)
    return { ...stage, count: items.length, value }
  })
  const totalPipelineValue = stageStats.reduce((sum, s) => sum + s.value, 0)
  const totalPipelineCount = filteredLeads.length

  const handleCreateLead = (formData: FormData) => {
    const newLeadData = {
      name: formData.get('name') as string,
      company: formData.get('company') as string,
      value: Number(formData.get('value')),
      status: formData.get('status') as any,
      responsible: formData.get('responsible') as string,
      source: formData.get('source') as string,
      tags: ((formData.get('tags') as string) || '').split(',').map(tag => tag.trim()).filter(Boolean),
      email: formData.get('email') as string,
      phone: formData.get('phone') as string,
      notes: formData.get('notes') as string,
      last_contact: new Date().toISOString(),
    };
    
    createLead(newLeadData, {
      onSuccess: () => {
        setIsCreateModalOpen(false);
        toast({
          title: "Lead criado!",
          description: "O novo lead foi adicionado ao pipeline.",
        });
      },
      onError: (error: any) => {
        const msg = String(error?.message || '')
        toast({
          title: "Erro!",
          description: msg.includes('Organização ainda não carregada') ? 'Aguarde o carregamento da organização e tente novamente.' : (msg || 'Falha ao criar lead.'),
          variant: "destructive",
        });
      }
    });
  }

  const handleEditLead = (formData: FormData) => {
    if (!selectedLead) return
    
    const updatedLead = {
      ...selectedLead,
      name: formData.get('name') as string,
      company: formData.get('company') as string,
      value: Number(formData.get('value')),
      status: formData.get('status') as any,
      responsible: formData.get('responsible') as string,
      source: formData.get('source') as string,
      tags: (formData.get('tags') as string).split(',').map(tag => tag.trim()).filter(Boolean),
      email: formData.get('email') as string,
      phone: formData.get('phone') as string,
      notes: formData.get('notes') as string,
    }
    
    updateLead(updatedLead, {
      onSuccess: () => {
        setIsEditModalOpen(false);
        setSelectedLead(null);
        toast({
          title: "Lead atualizado!",
          description: "O lead foi atualizado com sucesso.",
        });
      },
      onError: (error: any) => {
        toast({
          title: "Erro!",
          description: error.message,
          variant: "destructive",
        });
      }
    });
  }

  const handleDeleteLead = (leadId: string) => {
    deleteLead(leadId, {
      onSuccess: () => {
        toast({
          title: "Lead removido!",
          description: "O lead foi removido do pipeline.",
          variant: "destructive"
        });
      },
      onError: (error: any) => {
        toast({
          title: "Erro!",
          description: error.message,
          variant: "destructive",
        });
      }
    });
  }

  const handleUpdateLeadStatus = (leadId: string, newStatus: any) => {
    const leadToUpdate = leads.find(lead => lead.id === leadId);
    if (leadToUpdate) {
      updateLead({ ...leadToUpdate, status: newStatus, last_contact: new Date().toISOString() }, {
        onSuccess: () => {
          toast({
            title: "Status atualizado!",
            description: "O status do lead foi alterado.",
          });
        },
        onError: (error: any) => {
          toast({
            title: "Erro!",
            description: error.message,
            variant: "destructive",
          });
        }
      });
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      toast({
        title: "Logout realizado!",
        description: "Você foi desconectado com sucesso.",
      })
    } catch (error: any) {
      toast({
        title: "Erro no logout!",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-dark flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-destructive mb-4">Erro ao carregar dados</h2>
          <p className="text-foreground mb-4">{error.message}</p>
          <Button onClick={() => window.location.reload()}>Tentar novamente</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="h-screen flex">
        <CRMSidebar 
          selectedView={selectedView}
          onViewChange={setSelectedView}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        {/* Main Content */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="h-16 bg-card border-b border-border flex items-center justify-between px-6 shadow-sm">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="hover:bg-primary/10"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              <h1 className="text-xl font-semibold text-foreground">
                {selectedView === "pipeline" ? "Pipeline de Vendas" : 
                 selectedView === "dashboard" ? "Dashboard" : 
                 selectedView === "contacts" ? "Contatos" : 
                 selectedView === "settings" ? "Configurações" : ""}
              </h1>
            </div>

            <div className="flex items-center space-x-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar leads, contatos..."
                  className="pl-9 w-64 bg-input border-border"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-40">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filtrar" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="new">Novos</SelectItem>
                  <SelectItem value="qualified">Qualificados</SelectItem>
                  <SelectItem value="proposal">Proposta</SelectItem>
                  <SelectItem value="negotiation">Negociação</SelectItem>
                  <SelectItem value="closed-won">Fechados</SelectItem>
                  <SelectItem value="closed-lost">Perdidos</SelectItem>
                </SelectContent>
              </Select>
              
               {role !== 'sales' && (
               <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary">
                    <Plus className="h-4 w-4 mr-2" />
                    Novo Lead
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Criar Novo Lead</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={(e) => {
                    e.preventDefault()
                    const formData = new FormData(e.currentTarget)
                    handleCreateLead(formData)
                  }} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="name">Nome *</Label>
                        <Input id="name" name="name" required />
                      </div>
                      <div>
                        <Label htmlFor="company">Empresa *</Label>
                        <Input id="company" name="company" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="email">Email</Label>
                        <Input id="email" name="email" type="email" />
                      </div>
                      <div>
                        <Label htmlFor="phone">Telefone</Label>
                        <Input id="phone" name="phone" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <Label htmlFor="value">Valor (R$) *</Label>
                        <Input id="value" name="value" type="number" required />
                      </div>
                      <div>
                        <Label htmlFor="status">Status *</Label>
                        <Select name="status" defaultValue={pendingCreateStatus || pipelineStages[0]?.id || 'new'}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {pipelineStages.map(s => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="responsible">Responsável *</Label>
                        <Input id="responsible" name="responsible" placeholder="Nome do responsável" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="source">Origem *</Label>
                        <Input id="source" name="source" placeholder="Ex.: Website, WhatsApp, Email" required />
                      </div>
                      <div>
                        <Label htmlFor="tags">Tags (separadas por vírgula)</Label>
                        <Input id="tags" name="tags" placeholder="premium, hot, enterprise" />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="notes">Observações</Label>
                      <Textarea id="notes" name="notes" rows={3} />
                    </div>
                    <div className="flex justify-end space-x-2">
                      <Button type="button" variant="outline" onClick={() => setIsCreateModalOpen(false)}>
                        Cancelar
                      </Button>
                      <Button type="submit" disabled={isCreating}>
                        {isCreating ? "Criando..." : "Criar Lead"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
               </Dialog>
               )}

              <Dialog open={isBulkCreateOpen} onOpenChange={setIsBulkCreateOpen}>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Criar vários leads</DialogTitle>
                    <DialogDescription>Informe um lead por linha. Campos: Nome | Empresa | Telefone | Email | Valor. O status será "{pendingCreateStatus || 'new'}".</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={async (e) => {
                    e.preventDefault()
                    const form = e.currentTarget as HTMLFormElement
                    const textarea = form.elements.namedItem('bulk') as HTMLTextAreaElement
                    const lines = (textarea.value || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
                    const created: any[] = []
                    for (const line of lines) {
                      const [name='', company='', phone='', email='', valueStr='0'] = line.split('|').map(s => s.trim())
                      try {
                        await createLead({
                          name: name || 'Lead',
                          company: company || '—',
                          value: Number(valueStr || 0),
                          status: (pendingCreateStatus as any) || 'new',
                          responsible: user?.user_metadata?.full_name || '—',
                          source: 'bulk',
                          tags: [],
                          email: email || null,
                          phone: phone || null,
                        } as any)
                        created.push(name || company || phone || 'Lead')
                      } catch {}
                    }
                    setIsBulkCreateOpen(false)
                    toast({ title: 'Leads criados', description: `${created.length} lead(s) adicionados em ${pendingCreateStatus || 'new'}.` })
                  }} className="space-y-3">
                    <Textarea name="bulk" rows={10} placeholder={"Exemplos:\nMaria Silva | ACME | 11999999999 | maria@ex.com | 5000\nCarlos Lima | Beta Ltda | 11988887777 |  | 3000"} />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setIsBulkCreateOpen(false)}>Cancelar</Button>
                      <Button type="submit">Criar</Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              {/* Adicionar novo estágio */}
              <Dialog open={isAddStageOpen} onOpenChange={setIsAddStageOpen}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Novo estágio do pipeline</DialogTitle>
                    <DialogDescription>Defina um identificador e um nome exibido. O identificador será usado internamente nos leads.</DialogDescription>
                  </DialogHeader>
                  <form onSubmit={async (e) => {
                    e.preventDefault()
                    if (!orgId) return
                    const id = (newStageId || '').trim().toLowerCase().replace(/\s+/g, '-')
                    const name = (newStageName || '').trim()
                    if (!id || !name) return
                    try {
                      // Merge stageLabels e adiciona o novo
                      const next = { ...stageLabels, [id]: name }
                      const payload = { organization_id: orgId, stageLabels: next }
                      const r = await apiFetch('/api/org/pipeline/config', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify(payload)
                      })
                      if (!r.ok) throw new Error('Falha ao salvar estágio')
                      setStageLabels(next)
                      setIsAddStageOpen(false)
                    } catch {}
                  }} className="space-y-3">
                    <div>
                      <Label htmlFor="stage-id">Identificador</Label>
                      <Input id="stage-id" value={newStageId} onChange={(e) => setNewStageId(e.target.value)} placeholder="ex: follow-up" />
                    </div>
                    <div>
                      <Label htmlFor="stage-name">Nome</Label>
                      <Input id="stage-name" value={newStageName} onChange={(e) => setNewStageName(e.target.value)} placeholder="Ex.: Follow up" />
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setIsAddStageOpen(false)}>Cancelar</Button>
                      <Button type="submit">Adicionar</Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              <div className="flex items-center gap-2">
                <Badge variant="outline" className="uppercase text-[10px]">{role || '...'}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSignOut}
                  className="hover:bg-destructive/10 text-destructive"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Sair
                </Button>
                {(orgRole === 'admin' || orgRole === 'manager') && selectedView === 'pipeline' && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setIsEditStagesOpen(true)} className="ml-2">Editar estágios</Button>
                    <Button variant="outline" size="sm" onClick={() => { setNewStageId(''); setNewStageName(''); setIsAddStageOpen(true) }}>Adicionar estágio</Button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Content based on selected view */}
          {selectedView === "pipeline" && (
            <div className="flex-1 p-6 overflow-auto">
              {/* KPI agregado */}
              <div className="mb-4 grid grid-cols-3 gap-4">
                <Card>
                  <CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground">Leads no pipeline</div>
                    <div className="text-2xl font-bold text-primary">{totalPipelineCount}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground">Valor total</div>
                    <div className="text-2xl font-bold text-success">R$ {totalPipelineValue.toLocaleString('pt-BR')}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <div className="text-xs text-muted-foreground">Ticket médio</div>
                    <div className="text-2xl font-bold text-foreground">R$ {(totalPipelineCount ? (totalPipelineValue/totalPipelineCount) : 0).toLocaleString('pt-BR')}</div>
                  </CardContent>
                </Card>
              </div>
              {/* Quick Filters */}
              <Card className="mb-4">
                <CardContent className="p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
                  <div className="md:col-span-2">
                    <Label className="text-xs">Responsável</Label>
                    <Select value={filterResponsible} onValueChange={setFilterResponsible}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Todos" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todos</SelectItem>
                        {responsibleOptions.map(r => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-2">
                    <Label className="text-xs">Origem</Label>
                    <Select value={filterSource} onValueChange={setFilterSource}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Todas" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas</SelectItem>
                        {sourceOptions.map(s => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2">
                    <div>
                      <Label className="text-xs">Valor mín</Label>
                      <Input value={minValue} onChange={(e) => setMinValue(e.target.value)} type="number" className="h-9" />
                    </div>
                    <div>
                      <Label className="text-xs">Valor máx</Label>
                      <Input value={maxValue} onChange={(e) => setMaxValue(e.target.value)} type="number" className="h-9" />
                    </div>
                    <Button variant="outline" className="ml-auto h-9" onClick={() => { setFilterResponsible("all"); setFilterSource("all"); setMinValue(""); setMaxValue(""); }}>Limpar</Button>
                  </div>
                </CardContent>
              </Card>

              {/* (títulos removidos para evitar desalinhamento quando há mais de 6 estágios) */}

              {/* Kanban Board */}
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <div className="grid grid-cols-6 gap-4 h-[calc(100vh-280px)]">
                  {isLoading ? (
                    <div className="col-span-6 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <span className="ml-2 text-foreground">Carregando leads...</span>
                    </div>
                  ) : (
                    stageStats.map((stage) => (
                    <PipelineStage 
                      key={stage.id} 
                      stage={stage} 
                      leads={filteredLeads.filter(l => l.status === stage.id)}
                      onViewLead={(lead) => {
                        setSelectedLead(lead)
                        setIsDetailsModalOpen(true)
                      }}
                      onEditLead={(lead) => {
                        setSelectedLead(lead)
                        setIsEditModalOpen(true)
                      }}
                       onDeleteLead={role === 'admin' || role === 'manager' ? handleDeleteLead : undefined}
                      onUpdateStatus={handleUpdateLeadStatus}
                      onCreateLeadInStage={(status) => {
                        if (role === 'sales') {
                          toast({
                            title: 'Permissão insuficiente',
                            description: 'Somente Admin/Manager podem criar leads.',
                            variant: 'destructive',
                          })
                          return
                        }
                        setPendingCreateStatus(status)
                        setIsCreateModalOpen(true)
                      }}
                      onOpenChat={(leadId) => { setSelectedChatLeadId(leadId); setIsQuickChatOpen(true) }}
                      onEditStages={() => setIsEditStagesOpen(true)}
                      onBulkCreateInStage={(status) => {
                        if (role === 'sales') {
                          toast({
                            title: 'Permissão insuficiente',
                            description: 'Somente Admin/Manager podem criar leads.',
                            variant: 'destructive',
                          })
                          return
                        }
                        setPendingCreateStatus(status)
                        setIsBulkCreateOpen(true)
                      }}
                      onBulkCreateInStage={(status) => {
                        if (role === 'sales') {
                          toast({
                            title: 'Permissão insuficiente',
                            description: 'Somente Admin/Manager podem criar leads.',
                            variant: 'destructive',
                          })
                          return
                        }
                        setPendingCreateStatus(status)
                        setIsBulkCreateOpen(true)
                      }}
                    />
                  )))}
                </div>
              </DndContext>
            </div>
          )}

          {/* Dashboard View */}
          {selectedView === "dashboard" && (
            <div className="flex-1 p-6 overflow-auto">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                <Card className="bg-gradient-card border-border shadow-card hover:shadow-glow transition-all duration-300 animate-slide-up">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total de Leads</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-primary">{stats.total}</div>
                    {Number.isFinite(stats.trends?.totalDeltaPct) && (
                      <p className={`text-xs ${stats.trends.totalDeltaPct >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {stats.trends.totalDeltaPct >= 0 ? '+' : ''}{stats.trends.totalDeltaPct.toFixed(1)}% {stats.trends.periodLabel}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="bg-gradient-card border-border shadow-card hover:shadow-glow transition-all duration-300 animate-slide-up">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">Taxa de Conversão</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-primary">{stats.conversionRate.toFixed(1)}%</div>
                    {Number.isFinite(stats.trends?.conversionDeltaPp) && (
                      <p className={`text-xs ${stats.trends.conversionDeltaPp >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {stats.trends.conversionDeltaPp >= 0 ? '+' : ''}{stats.trends.conversionDeltaPp.toFixed(1)} pp {stats.trends.periodLabel}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="bg-gradient-card border-border shadow-card hover:shadow-glow transition-all duration-300 animate-slide-up">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">Valor Total</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-primary">R$ {stats.totalValue.toLocaleString('pt-BR')}</div>
                    {Number.isFinite(stats.trends?.totalValueDeltaPct) && (
                      <p className={`text-xs ${stats.trends.totalValueDeltaPct >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {stats.trends.totalValueDeltaPct >= 0 ? '+' : ''}{stats.trends.totalValueDeltaPct.toFixed(1)}% {stats.trends.periodLabel}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="bg-gradient-card border-border shadow-card hover:shadow-glow transition-all duration-300 animate-slide-up">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">Deals Fechados</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-primary">{stats.byStatus['closed-won']}</div>
                    {Number.isFinite(stats.trends?.closedWonDeltaPct) && (
                      <p className={`text-xs ${stats.trends.closedWonDeltaPct >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {stats.trends.closedWonDeltaPct >= 0 ? '+' : ''}{stats.trends.closedWonDeltaPct.toFixed(1)}% {stats.trends.periodLabel}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Recent Activity */}
              <Card className="bg-gradient-card border-border shadow-card">
                <CardHeader>
                  <CardTitle className="text-foreground">Atividades Recentes</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {leads.slice(0, 5).map((lead) => (
                      <div key={lead.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                        <div>
                          <p className="text-sm font-medium text-foreground">{lead.name} - {lead.company}</p>
                          <p className="text-xs text-muted-foreground">Status: {lead.status}</p>
                        </div>
                        <div className="text-right">
                          <span className="text-sm font-bold text-primary">R$ {lead.value.toLocaleString('pt-BR')}</span>
                          <p className="text-xs text-muted-foreground">{lead.responsible}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Contacts View */}
          {selectedView === "contacts" && (
            <div className="flex-1 p-6 overflow-auto">
              <div className="mb-6 flex justify-between items-center">
                <h2 className="text-2xl font-bold text-foreground">Contatos</h2>
                <Button 
                  variant="outline" 
                  className="border-border hover:bg-primary/10"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Exportar
                </Button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredLeads.map((lead, index) => (
                  <Card key={lead.id} className="bg-gradient-card border-border shadow-card hover:shadow-glow transition-all duration-300 animate-slide-up group" style={{ animationDelay: `${index * 0.1}s` }}>
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">{lead.name}</h3>
                          <p className="text-sm text-muted-foreground">{lead.company}</p>
                          {lead.email && <p className="text-xs text-muted-foreground">{lead.email}</p>}
                          {lead.phone && <p className="text-xs text-muted-foreground">{lead.phone}</p>}
                        </div>
                        <div className="flex space-x-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-primary/10"
                            onClick={() => {
                              setSelectedLead(lead)
                              setIsDetailsModalOpen(true)
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-primary/10"
                            onClick={() => {
                              setSelectedLead(lead)
                              setIsEditModalOpen(true)
                            }}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 hover:bg-destructive/10 text-destructive"
                            onClick={() => handleDeleteLead(lead.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Valor:</span>
                          <span className="text-sm font-bold text-success">R$ {lead.value.toLocaleString('pt-BR')}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Status:</span>
                          <Badge variant="outline" className="text-xs">
                            {lead.status}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Responsável:</span>
                          <span className="text-xs text-muted-foreground">{lead.responsible}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Origem:</span>
                          <span className="text-xs text-muted-foreground">{lead.source}</span>
                        </div>
                        {Array.isArray(lead.tags) && lead.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {lead.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Products View removida */}

          {/* Deals/Propostas View */}
          {selectedView === "deals" && (
            <DealsManager />
          )}

          {/* Activities View */}
          {selectedView === "activities" && (
            <ActivitiesView
              title="Atividades"
              onViewLead={(leadId) => {
                const lead = leads.find(l => l.id === leadId)
                if (lead) {
                  setSelectedLead(lead)
                  setIsDetailsModalOpen(true)
                }
              }}
            />
          )}

          {/* Tasks View */}
          {selectedView === "tasks" && (
            <ActivitiesView
              title="Tarefas"
              lockedType="task"
              onViewLead={(leadId) => {
                const lead = leads.find(l => l.id === leadId)
                if (lead) {
                  setSelectedLead(lead)
                  setIsDetailsModalOpen(true)
                }
              }}
            />
          )}

          {/* WhatsApp View */}
          {selectedView === "whatsapp" && (
            <WhatsAppView initialLeadId={selectedChatLeadId || undefined} />
          )}

          {/* Settings View */}
          {selectedView === "settings" && (
            <SettingsView />
          )}

          

          {/* Employees View */}
          {selectedView === "employees" && (
            <EmployeesView />
          )}

          {/* Settings View removida */}

          {/* Messages View */}
          {selectedView === "messages" && (
            <div className="flex-1 p-6 overflow-auto">
              <div className="mb-6">
                <h2 className="text-2xl font-bold text-foreground">Mensagens</h2>
                <p className="text-muted-foreground">Gerencie suas comunicações</p>
              </div>
              
              <Card className="bg-gradient-card border-border shadow-card">
                <CardHeader>
                  <CardTitle className="text-foreground">Em Desenvolvimento</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    O sistema de mensagens está sendo implementado. Em breve você poderá:
                  </p>
                  <ul className="list-disc list-inside mt-2 space-y-1 text-sm text-muted-foreground">
                    <li>Enviar emails em massa</li>
                    <li>Integrar com WhatsApp Business</li>
                    <li>Usar templates personalizados</li>
                    <li>Acompanhar status de entrega</li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      {/* Quick WhatsApp Chat Modal */}
      <QuickChat leadId={selectedChatLeadId || undefined} open={isQuickChatOpen} onOpenChange={setIsQuickChatOpen} />

      {/* Lead Details Modal */}
      <Dialog open={isDetailsModalOpen} onOpenChange={setIsDetailsModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Detalhes do Lead</DialogTitle>
          </DialogHeader>
          {selectedLead && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium">Nome</Label>
                  <p className="text-sm">{selectedLead.name}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium">Empresa</Label>
                  <p className="text-sm">{selectedLead.company}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium">Email</Label>
                  <p className="text-sm">{selectedLead.email || "Não informado"}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium">Telefone</Label>
                  <p className="text-sm">{selectedLead.phone || "Não informado"}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label className="text-sm font-medium">Valor</Label>
                  <p className="text-sm font-bold text-success">R$ {selectedLead.value.toLocaleString('pt-BR')}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium">Status</Label>
                  <Badge variant="outline">{selectedLead.status}</Badge>
                </div>
                <div>
                  <Label className="text-sm font-medium">Responsável</Label>
                  <p className="text-sm">{selectedLead.responsible}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium">Origem</Label>
                  <p className="text-sm">{selectedLead.source}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium">Tags</Label>
                  <div className="flex flex-wrap gap-1">
                    {(selectedLead.tags ?? []).map((tag: string) => (
                      <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              {selectedLead.notes && (
                <div>
                  <Label className="text-sm font-medium">Observações</Label>
                  <p className="text-sm bg-muted p-3 rounded-md">{selectedLead.notes}</p>
                </div>
              )}
              {/* Timeline resumida: últimas 5 atividades/comunicações/propostas */}
              <div>
                <Label className="text-sm font-medium">Timeline</Label>
                <LeadTimeline leadId={selectedLead.id} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Lead Modal */}
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Editar Lead</DialogTitle>
          </DialogHeader>
          {selectedLead && (
            <form onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              handleEditLead(formData)
            }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-name">Nome *</Label>
                  <Input id="edit-name" name="name" defaultValue={selectedLead.name} required />
                </div>
                <div>
                  <Label htmlFor="edit-company">Empresa *</Label>
                  <Input id="edit-company" name="company" defaultValue={selectedLead.company} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-email">Email</Label>
                  <Input id="edit-email" name="email" type="email" defaultValue={selectedLead.email} />
                </div>
                <div>
                  <Label htmlFor="edit-phone">Telefone</Label>
                  <Input id="edit-phone" name="phone" defaultValue={selectedLead.phone} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="edit-value">Valor (R$) *</Label>
                  <Input id="edit-value" name="value" type="number" defaultValue={selectedLead.value} required />
                </div>
                <div>
                  <Label htmlFor="edit-status">Status *</Label>
                  <Select name="status" defaultValue={selectedLead.status}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">Novo</SelectItem>
                      <SelectItem value="qualified">Qualificado</SelectItem>
                      <SelectItem value="proposal">Proposta</SelectItem>
                      <SelectItem value="negotiation">Negociação</SelectItem>
                      <SelectItem value="closed-won">Fechado</SelectItem>
                      <SelectItem value="closed-lost">Perdido</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="edit-responsible">Responsável *</Label>
                  <Input id="edit-responsible" name="responsible" defaultValue={selectedLead.responsible} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-source">Origem *</Label>
                  <Input id="edit-source" name="source" defaultValue={selectedLead.source} required />
                </div>
                <div>
                  <Label htmlFor="edit-tags">Tags (separadas por vírgula)</Label>
                  <Input id="edit-tags" name="tags" defaultValue={Array.isArray(selectedLead.tags) ? selectedLead.tags.join(', ') : ''} />
                </div>
              </div>
              <div>
                <Label htmlFor="edit-notes">Observações</Label>
                <Textarea id="edit-notes" name="notes" rows={3} defaultValue={selectedLead.notes} />
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setIsEditModalOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={isUpdating}>
                  {isUpdating ? "Salvando..." : "Salvar Alterações"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Pipeline Stages Modal */}
      <Dialog open={isEditStagesOpen} onOpenChange={setIsEditStagesOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Renomear estágios do pipeline</DialogTitle>
            <DialogDescription>Personalize os nomes dos estágios para sua equipe.</DialogDescription>
          </DialogHeader>
          <form onSubmit={async (e) => {
            e.preventDefault()
            if (!orgId) return
            setSavingStages(true)
            try {
              const payload = { organization_id: orgId, stageLabels }
              const r = await apiFetch('/api/org/pipeline/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
                body: JSON.stringify(payload)
              })
              if (!r.ok) throw new Error('Falha ao salvar estágios')
              setIsEditStagesOpen(false)
            } catch (e: any) {
              const msg = e?.message || 'Falha ao salvar estágios'
              // opcional: toast de erro se disponível
              try { /* toast pode estar fora de escopo aqui; ignoramos silenciosamente */ } catch {}
              console.error('[pipeline] save error', msg)
            }
            setSavingStages(false)
          }} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {[...defaultPipelineStages.map(s => s.id), ...Object.keys(stageLabels || {}).filter(id => !defaultPipelineStages.find(d => d.id === id))]
                .map((id) => {
                  const placeholder = defaultPipelineStages.find(d => d.id === id)?.name || id
                  return (
                    <div key={id}>
                      <Label className="text-xs">{placeholder}</Label>
                      <Input value={stageLabels[id] || ''} onChange={(e) => setStageLabels(prev => ({ ...prev, [id]: e.target.value }))} placeholder={placeholder} />
                    </div>
                  )
              })}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsEditStagesOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={savingStages}>{savingStages ? 'Salvando...' : 'Salvar'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}