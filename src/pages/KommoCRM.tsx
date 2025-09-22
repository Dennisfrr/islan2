import { useState, useEffect, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { DndContext, closestCenter, DragEndEvent } from "@dnd-kit/core"
import { Plus, Search, MoreHorizontal, Eye, Edit, Trash2, Download, Filter, Loader2, LogOut, Send, CheckSquare, Sparkles, ListChecks, Target, BarChart3 } from "lucide-react"
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
import GoalsPage from "./Goals"
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
import { useActivities } from "@/hooks/useActivities"
import { useDeals } from "@/hooks/useDeals"
import { parseAndExecute } from "@/agents/crm/gemini"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { PieChart, Pie, Cell } from "recharts"
import { DashboardShell } from "@/components/dashboard/DashboardShell"
import { QuickActionCard } from "@/components/dashboard/QuickActionCard"
import { RecentGrid } from "@/components/dashboard/RecentGrid"
import { LeadsTable } from "@/components/dashboard/LeadsTable"

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
  const [sortByAi, setSortByAi] = useState(false)
  const [aiScoreMap, setAiScoreMap] = useState<Record<string, number>>({})
  const { toast } = useToast()
  const { createActivity, updateActivity, deleteActivity } = useActivities()
  const { createDeal, updateDeal, deleteDeal } = useDeals()
  const [agentModalOpen, setAgentModalOpen] = useState(false)
  const [agentPrompt, setAgentPrompt] = useState('')
  const [quickChatPrefill, setQuickChatPrefill] = useState<string | undefined>(undefined)
  const [quickChatAutoSend, setQuickChatAutoSend] = useState<boolean>(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestText, setSuggestText] = useState<string>('')
  // Smart Summary (expanded widget)
  const [smartSummaryOpen, setSmartSummaryOpen] = useState(false)
  const [smartSummaryText, setSmartSummaryText] = useState<string>('')
  const [smartSummaryBusy, setSmartSummaryBusy] = useState(false)
  // Labels do pipeline (precisamos antes do efeito que carrega config)
  const [stageLabels, setStageLabels] = useState<Record<string, string>>({})
  const [isEditStagesOpen, setIsEditStagesOpen] = useState(false)
  const [savingStages, setSavingStages] = useState(false)
  // Dashboard extra data
  const [dbGoals, setDbGoals] = useState<any[] | null>(null)
  const [dbReflections, setDbReflections] = useState<any[] | null>(null)
  const [dbLoading, setDbLoading] = useState(false)
  // WhatsApp WPPConnect removed from Dashboard
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

  // Dashboard helpers removed
  useEffect(() => {
    if (selectedView !== 'dashboard') return
    let cancelled = false
    ;(async () => {
      setDbLoading(true)
      try {
        const [g, r] = await Promise.all([
          apiFetch('/api/goals').then(res => res.json()).catch(() => []),
          apiFetch('/api/analytics/reflections').then(res => res.json()).catch(() => [])
        ])
        if (!cancelled) { setDbGoals(Array.isArray(g) ? g : []); setDbReflections(Array.isArray(r) ? r : []) }
      } catch { if (!cancelled) { setDbGoals([]); setDbReflections([]) } }
      finally { if (!cancelled) setDbLoading(false) }
    })()
    return () => { cancelled = true }
  }, [selectedView])

  const goalsKpi = useMemo(() => {
    return { total: (dbGoals?.length || 0), onTrack: 0, offTrack: 0 }
  }, [dbGoals])

  const recentStageItems = useMemo(() => {
    const entries = Object.keys(stageLabels || {}) as string[]
    return entries.slice(0, 8).map((id) => ({ id, title: (stageLabels as any)[id] || id }))
  }, [stageLabels])

  const sentimentData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of (dbReflections || [])) {
      const s = r.inferredLeadSentiment || '—'
      counts[s] = (counts[s] || 0) + 1
    }
    const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6)
    const colors = ['#10b981','#f59e0b','#ef4444','#6366f1','#06b6d4','#84cc16']
    return entries.map(([name, value], idx) => ({ name, value, fill: colors[idx % colors.length] }))
  }, [dbReflections])

  // Auto-check when entering Dashboard view
  // WPPConnect auto-check removed

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

  // Prefetch AI scores when sorting enabled
  useEffect(() => {
    if (!sortByAi) return
    let cancelled = false
    ;(async () => {
      const ids = leads.map(l => l.id)
      const next: Record<string, number> = {}
      for (const id of ids) {
        try {
          const r = await apiFetch(`/api/leads/ai-score?lead_id=${encodeURIComponent(id)}`)
          const js = await r.json().catch(() => ({} as any))
          if (r.ok && typeof js?.score === 'number') next[id] = js.score
        } catch {}
      }
      if (!cancelled) setAiScoreMap(next)
    })()
    return () => { cancelled = true }
  }, [sortByAi, leads])

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

  // Intents do CRM (expostas para um agente externo)
  useEffect(() => {
    const agent = {
      async moveLead(params: any) {
        const leadId = String(params?.leadId || params?.id || '')
        const toStageId = String(params?.toStageId || params?.status || '')
        if (!leadId || !toStageId) return { ok: false, error: 'invalid_params' }
        handleUpdateLeadStatus(leadId, toStageId)
        return { ok: true }
      },
      openQuickChat(params: any) {
        const leadId = String(params?.leadId || params?.id || '')
        if (!leadId) return { ok: false, error: 'invalid_params' }
        setSelectedChatLeadId(leadId)
        setIsQuickChatOpen(true)
        return { ok: true }
      },
      openWhatsAppView(params: any) {
        const leadId = params?.leadId ? String(params.leadId) : null
        if (leadId) setSelectedChatLeadId(leadId)
        setSelectedView('whatsapp')
        return { ok: true }
      },
      async createLead(params: any) {
        try {
          const payload = {
            name: String(params?.name || 'Lead'),
            company: String(params?.company || '—'),
            value: Number(params?.value || 0),
            status: String(params?.status || 'new') as any,
            responsible: String(params?.responsible || (user?.user_metadata?.full_name || '—')),
            source: String(params?.source || 'agent'),
            tags: Array.isArray(params?.tags) ? params.tags : [],
            email: params?.email || null,
            phone: params?.phone || null,
            notes: params?.notes || null,
            last_contact: new Date().toISOString(),
          } as any
          await new Promise<void>((resolve, reject) => {
            createLead(payload, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
          })
          return { ok: true }
        } catch (e: any) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
      async updateLead(params: any) {
        try {
          const leadId = String(params?.id || params?.leadId || '')
          const existing = leads.find(l => l.id === leadId)
          if (!existing) return { ok: false, error: 'lead_not_found' }
          const updated = { ...existing, ...params }
          await new Promise<void>((resolve, reject) => {
            updateLead(updated, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
          })
          return { ok: true }
        } catch (e: any) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
      async deleteLead(params: any) {
        const leadId = String(params?.leadId || params?.id || '')
        if (!leadId) return { ok: false, error: 'invalid_params' }
        return new Promise((resolve) => {
          deleteLead(leadId, {
            onSuccess: () => resolve({ ok: true }),
            onError: (e: any) => resolve({ ok: false, error: String(e?.message || e) }),
          })
        })
      },
      setFilter(params: any) {
        if (typeof params?.search === 'string') setSearchTerm(params.search)
        if (typeof params?.status === 'string') setFilterStatus(params.status)
        if (typeof params?.responsible === 'string') setFilterResponsible(params.responsible)
        if (typeof params?.source === 'string') setFilterSource(params.source)
        if (params?.minValue != null) setMinValue(String(params.minValue))
        if (params?.maxValue != null) setMaxValue(String(params.maxValue))
        return { ok: true }
      },
      setView(params: any) {
        const v = String(params?.view || '')
        if (!v) return { ok: false, error: 'invalid_params' }
        setSelectedView(v)
        return { ok: true }
      },
      selectLead(params: any) {
        const leadId = String(params?.leadId || params?.id || '')
        const openDetails = Boolean(params?.openDetails)
        if (!leadId) return { ok: false, error: 'invalid_params' }
        const lead = leads.find(l => l.id === leadId)
        if (!lead) return { ok: false, error: 'lead_not_found' }
        setSelectedLead(lead)
        if (openDetails) setIsDetailsModalOpen(true)
        return { ok: true }
      },
      async bulkCreateInStage(params: any) {
        const status = String(params?.status || 'new')
        const items = Array.isArray(params?.items) ? params.items : []
        let created = 0
        for (const it of items) {
          try {
            const payload = {
              name: String(it?.name || 'Lead'),
              company: String(it?.company || '—'),
              value: Number(it?.value || 0),
              status: status as any,
              responsible: String(it?.responsible || (user?.user_metadata?.full_name || '—')),
              source: String(it?.source || 'bulk-agent'),
              tags: Array.isArray(it?.tags) ? it.tags : [],
              email: it?.email || null,
              phone: it?.phone || null,
            } as any
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve, reject) => {
              createLead(payload, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            created++
          } catch {}
        }
        return { ok: true, created }
      },
      editStagesOpen() {
        setIsEditStagesOpen(true)
        return { ok: true }
      },
      getState() {
        return {
          selectedView,
          filters: { searchTerm, filterStatus, filterResponsible, filterSource, minValue, maxValue },
          stages: pipelineStages,
          leadsCount: leads.length,
        }
      },
      async dispatchIntent(name: string, payload: any) {
        const n = String(name || '').toLowerCase()
        const map: Record<string, any> = {
          'move_lead': this.moveLead,
          'open_quick_chat': this.openQuickChat,
          'open_whatsapp_view': this.openWhatsAppView,
          'create_lead': this.createLead,
          'update_lead': this.updateLead,
          'delete_lead': this.deleteLead,
          'set_filter': this.setFilter,
          'set_view': this.setView,
          'select_lead': this.selectLead,
          'bulk_create_in_stage': this.bulkCreateInStage,
          'edit_stages_open': this.editStagesOpen,
          'get_state': this.getState,
          // Atividades / Notas / Tarefas
          'create_note': async (p: any) => {
            const leadId = String(p?.leadId || p?.id || '')
            const title = String(p?.title || 'Nota')
            const description = p?.description ? String(p.description) : undefined
            if (!leadId) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              createActivity({ lead_id: leadId, type: 'note', title, description, completed: false } as any, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'create_task': async (p: any) => {
            const leadId = String(p?.leadId || p?.id || '')
            const title = String(p?.title || 'Tarefa')
            const description = p?.description ? String(p.description) : undefined
            const due_date = p?.due_date ? String(p.due_date) : undefined
            if (!leadId) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              createActivity({ lead_id: leadId, type: 'task', title, description, due_date, completed: false } as any, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'update_activity': async (p: any) => {
            const id = String(p?.id || '')
            if (!id) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              updateActivity({ ...p, id } as any, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'delete_activity': async (p: any) => {
            const id = String(p?.id || '')
            if (!id) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              deleteActivity(id, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'open_activities': () => { setSelectedView('activities'); return { ok: true } },
          'open_tasks': () => { setSelectedView('tasks'); return { ok: true } },
          // Deals / Propostas
          'open_deals': () => { setSelectedView('deals'); return { ok: true } },
          'create_deal': async (p: any) => {
            const payload: any = {
              lead_id: p?.leadId || p?.lead_id || null,
              title: String(p?.title || 'Proposta'),
              description: p?.description ?? null,
              status: (p?.status || 'draft'),
              valid_until: p?.valid_until ?? null,
              items: Array.isArray(p?.items) ? p.items : [],
            }
            await new Promise<void>((resolve, reject) => {
              createDeal(payload, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'update_deal': async (p: any) => {
            const id = String(p?.id || '')
            if (!id) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              updateDeal({ ...p, id } as any, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
          'delete_deal': async (p: any) => {
            const id = String(p?.id || '')
            if (!id) return { ok: false, error: 'invalid_params' }
            await new Promise<void>((resolve, reject) => {
              deleteDeal(id, { onSuccess: () => resolve(), onError: (e: any) => reject(e) })
            })
            return { ok: true }
          },
        }
        const fn = map[n]
        if (!fn) return { ok: false, error: 'unknown_intent' }
        return await fn.call(this, payload)
      },
    }
    ;(window as any).crmAgent = agent
    const onMessage = async (ev: MessageEvent) => {
      const d: any = ev?.data || null
      if (!d || d.type !== 'crm_intent') return
      try {
        const result = await agent.dispatchIntent(d.name, d.payload)
        ev?.source && (ev.source as any).postMessage && (ev.source as any).postMessage({ type: 'crm_intent_result', id: d.id || null, ok: true, result }, '*')
      } catch (e: any) {
        try { ev?.source && (ev.source as any).postMessage && (ev.source as any).postMessage({ type: 'crm_intent_result', id: d.id || null, ok: false, error: String(e?.message || e) }, '*') } catch {}
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      if ((window as any).crmAgent === agent) delete (window as any).crmAgent
      window.removeEventListener('message', onMessage)
    }
  }, [user?.user_metadata?.full_name, leads, pipelineStages, selectedView, searchTerm, filterStatus, filterResponsible, filterSource, minValue, maxValue, createLead, updateLead, deleteLead])

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
    <div className="min-h-screen bg-background/80">
      <div className="h-screen flex">
        <CRMSidebar 
          selectedView={selectedView}
          onViewChange={setSelectedView}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        {/* Main Content */}
        <div className="flex-1 flex flex-col">

          {/* Content based on selected view */}
          {selectedView === "pipeline" && (
            <div className="flex-1 p-6 overflow-auto">
              {/* KPI agregado */}
              <div className="mb-4 grid grid-cols-3 gap-4">
                <Card className="shadow-none border-border/50">
                  <CardContent className="p-4 text-center">
                    <div className="text-[11px] text-foreground/60 tracking-wide uppercase">Leads no pipeline</div>
                    <div className="text-[28px] font-semibold text-foreground">{totalPipelineCount}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-none border-border/50">
                  <CardContent className="p-4 text-center">
                    <div className="text-[11px] text-foreground/60 tracking-wide uppercase">Valor total</div>
                    <div className="text-[28px] font-semibold text-foreground">R$ {totalPipelineValue.toLocaleString('pt-BR')}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-none border-border/50">
                  <CardContent className="p-4 text-center">
                    <div className="text-[11px] text-foreground/60 tracking-wide uppercase">Ticket médio</div>
                    <div className="text-[28px] font-semibold text-foreground">R$ {(totalPipelineCount ? (totalPipelineValue/totalPipelineCount) : 0).toLocaleString('pt-BR')}</div>
                  </CardContent>
                </Card>
              </div>
              {/* Quick Filters */}
              <Card className="mb-4 bg-secondary/70 backdrop-blur-md border-none rounded-xl shadow-[0_10px_30px_-20px_hsl(var(--foreground)/0.24)]">
                <CardContent className="p-5 grid grid-cols-1 md:grid-cols-5 gap-4">
                  <div className="md:col-span-2">
                    <Label className="text-[11px] text-foreground/70">Responsável</Label>
                    <Select value={filterResponsible} onValueChange={setFilterResponsible}>
                      <SelectTrigger className="h-10 rounded-lg bg-background/30 hover:bg-background/40 border-border/40 focus-visible:ring-0 focus-visible:ring-offset-0">
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
                    <Label className="text-[11px] text-foreground/70">Origem</Label>
                    <Select value={filterSource} onValueChange={setFilterSource}>
                      <SelectTrigger className="h-10 rounded-lg bg-background/30 hover:bg-background/40 border-border/40 focus-visible:ring-0 focus-visible:ring-offset-0">
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
                  <div className="flex items-end gap-3">
                    <div>
                      <Label className="text-[11px] text-foreground/70">Valor mín</Label>
                      <Input value={minValue} onChange={(e) => setMinValue(e.target.value)} type="number" className="h-10 rounded-lg bg-background/30 hover:bg-background/40 border-border/40 focus-visible:ring-0 focus-visible:ring-offset-0" />
                    </div>
                    <div>
                      <Label className="text-[11px] text-foreground/70">Valor máx</Label>
                      <Input value={maxValue} onChange={(e) => setMaxValue(e.target.value)} type="number" className="h-10 rounded-lg bg-background/30 hover:bg-background/40 border-border/40 focus-visible:ring-0 focus-visible:ring-offset-0" />
                    </div>
                    <Button variant="outline" className="ml-auto h-10 rounded-lg border-border/40" onClick={() => { setFilterResponsible("all"); setFilterSource("all"); setMinValue(""); setMaxValue(""); }}>Limpar</Button>
                    <Button variant={sortByAi ? "default" : "outline"} className="h-10 rounded-lg border-border/40" onClick={() => setSortByAi(v => !v)}>
                      {sortByAi ? 'Ordenando por AI' : 'Ordenar por AI Score'}
                    </Button>
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
                      leads={(function() {
                        const stageLeads = filteredLeads.filter(l => l.status === stage.id)
                        if (!sortByAi) return stageLeads
                        const sorted = [...stageLeads].sort((a, b) => (Number(aiScoreMap[b.id] ?? -1) - Number(aiScoreMap[a.id] ?? -1)))
                        return sorted
                      })()}
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
                    />
                  )))}
                </div>
              </DndContext>
            </div>
          )}

          {/* Dashboard View */}
          {selectedView === "dashboard" && (
            <DashboardShell title="Dashboard" onImportClick={() => {}}>
              {/* Quick actions row */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <QuickActionCard icon={<Sparkles className="h-4 w-4" />} title={`Resumo Inteligente`} description={<span className="text-muted-foreground text-xs">{/* @ts-ignore */}<SmartSummary stats={stats} /></span> as any} actionLabel="Abrir" onClick={() => setSmartSummaryOpen(true)} />
                <QuickActionCard icon={<ListChecks className="h-4 w-4" />} title="Follow‑up Inteligente" description="Priorize leads por probabilidade" onClick={() => setSelectedView('followup')} />
                <QuickActionCard icon={<BarChart3 className="h-4 w-4" />} title="Ranking (AI Score)" description="Leads ordenados por AI" onClick={() => setSelectedView('ranking')} />
                <QuickActionCard icon={<Target className="h-4 w-4" />} title="Metas do Agente" description="Acompanhe seu progresso" onClick={() => setSelectedView('goals')} />
              </div>

              {/* KPI mini cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card className="card-spotlight card-tilt card-gradient-border p-4">
                  <div className="text-xs text-muted-foreground">Total de Leads</div>
                  <div className="text-2xl font-semibold text-primary mt-1">{stats.total}</div>
                </Card>
                <Card className="card-spotlight card-tilt card-gradient-border p-4">
                  <div className="text-xs text-muted-foreground">Taxa de Conversão</div>
                  <div className="text-2xl font-semibold text-primary mt-1">{stats.conversionRate.toFixed(1)}%</div>
                </Card>
                <Card className="card-spotlight card-tilt card-gradient-border p-4">
                  <div className="text-xs text-muted-foreground">Valor Total</div>
                  <div className="text-2xl font-semibold text-primary mt-1">R$ {stats.totalValue.toLocaleString('pt-BR')}</div>
                </Card>
                <Card className="card-spotlight card-tilt card-gradient-border p-4">
                  <div className="text-xs text-muted-foreground">Deals Fechados</div>
                  <div className="text-2xl font-semibold text-primary mt-1">{stats.byStatus['closed-won']}</div>
                </Card>
              </div>

              {/* Recent grid */}
              <RecentGrid title="Atalhos Recentes" items={recentStageItems} onSelect={() => setSelectedView('pipeline')} />

              {/* Table section */}
                        <div>
                <div className="text-sm font-medium text-foreground mb-3">Leads recentes</div>
                <LeadsTable rows={leads.slice(0, 8).map(l => ({ id: l.id, name: l.name, company: l.company, value: l.value, status: l.status, responsible: l.responsible, updatedAt: (l as any).updated_at }))} />
                        </div>

            </DashboardShell>
          )}

          {/* Ranking View */}
          {selectedView === "ranking" && (
            <div className="flex-1 p-6 overflow-auto">
              <RankingView leads={leads} />
            </div>
          )}

          {/* Follow-up View */}
          {selectedView === "followup" && (
            <div className="flex-1 p-6 overflow-auto">
              <FollowupView />
            </div>
          )}

          {/* Console (Agente) */}
          {selectedView === "console" && (
            <div className="flex-1 p-6 overflow-auto">
              {/* AgentConsole removido */}
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
                  <Card key={lead.id} className="border-border/60 shadow-none hover:shadow-card transition-all duration-300 animate-slide-up group" style={{ animationDelay: `${index * 0.1}s` }}>
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

              {/* Pipeline Health */}
              <PipelineHealthSection />
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

          {/* Goals View */}
          {selectedView === "goals" && (
            <div className="flex-1 p-6 overflow-auto">
              <GoalsPage />
            </div>
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
              
              <Card className="border-border/50 shadow-none">
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
      <QuickChat leadId={selectedChatLeadId || undefined} open={isQuickChatOpen} onOpenChange={setIsQuickChatOpen} prefillText={quickChatPrefill} autoSend={quickChatAutoSend} />

      {/* Agent Command Modal */}
      <Dialog open={agentModalOpen} onOpenChange={setAgentModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Agente (Gemini)</DialogTitle>
            <DialogDescription>Digite um comando em linguagem natural. Ex.: "mova o lead João para Proposta"</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} placeholder="Seu comando" rows={4} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAgentModalOpen(false)}>Cancelar</Button>
              <Button onClick={async () => {
                if (!agentPrompt.trim()) return
                try {
                  await parseAndExecute(agentPrompt.trim())
                  toast({ title: 'Ok', description: 'Ação executada.' })
                  setAgentModalOpen(false)
                  setAgentPrompt('')
                } catch (e: any) {
                  toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
                }
              }}>Executar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
              {/* Perfil IA (via Agente) */}
              <div className="rounded-md border p-3">
                <Label className="text-sm font-medium">Perfil IA</Label>
                <div className="flex items-center gap-2 mb-2">
                  <Button size="sm" variant="outline" onClick={async () => {
                    try {
                      if (!selectedLead?.phone) return
                      await apiFetch('/api/agent/lead-profile/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: selectedLead.phone }) })
                      toast({ title: 'Perfil atualizado', description: 'Análise via IA concluída.' })
                    } catch (e: any) {
                      toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
                    }
                  }}>Atualizar perfil via IA</Button>
                  <Button size="sm" onClick={async () => {
                    try {
                      const phoneDigits = String(selectedLead?.phone || '').replace(/\D/g, '')
                      const r = await apiFetch(`/api/agent/precall?${phoneDigits ? `phone=${encodeURIComponent(phoneDigits)}` : ''}`)
                      const js = await r.json().catch(() => ({} as any))
                      const q = Array.isArray(js?.suggestedQuestions) && js.suggestedQuestions[0] ? String(js.suggestedQuestions[0]) : null
                      if (!q) { toast({ title: 'Sem sugestão', description: 'Nenhuma pergunta sugerida no momento.' }); return }
                      try { await navigator.clipboard.writeText(q) } catch {}
                      toast({ title: 'Sugestão pronta', description: q })
                    } catch (e: any) {
                      toast({ title: 'Falha na Próx. Ação', description: String(e?.message || e), variant: 'destructive' })
                    }
                  }}>Próx. Ação</Button>
                  {/* Pedir ao Agente: sugere texto e oferece 3 opções */}
                  <Button size="sm" variant="default" onClick={async () => {
                    try {
                      if (!selectedLead?.id) return
                      setSuggestLoading(true)
                      setSuggestText('')
                      const r = await apiFetch('/api/agent/suggest-followup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: selectedLead.id }) })
                      const js = await r.json().catch(() => ({} as any))
                      const txt = String(js?.sugestao || '').trim()
                      if (!txt) { toast({ title: 'Sem sugestão', description: 'O agente não retornou texto.' }); return }
                      setSuggestText(txt)
                      toast({ title: 'Sugestão pronta', description: txt })
                    } catch (e: any) {
                      toast({ title: 'Erro ao sugerir follow‑up', description: String(e?.message || e), variant: 'destructive' })
                    } finally { setSuggestLoading(false) }
                  }}>{suggestLoading ? 'Gerando…' : 'Pedir ao Agente'}</Button>
                </div>
                <AILeadProfile phone={selectedLead.phone} />
                {suggestText && (
                  <div className="mt-3 border-t pt-3">
                    <Label className="text-sm font-medium">Sugestão de Follow‑up</Label>
                    <div className="mt-2 p-2 rounded-md bg-muted text-sm whitespace-pre-wrap">{suggestText}</div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button size="sm" variant="default" onClick={() => {
                        // Criar tarefa
                        if (!selectedLead?.id) return
                        createActivity({ lead_id: selectedLead.id, type: 'task', title: 'Follow‑up', description: suggestText, completed: false } as any, {
                          onSuccess: () => toast({ title: 'Tarefa criada', description: 'Follow‑up salvo como tarefa.' }),
                          onError: (e: any) => toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
                        })
                      }}>Criar tarefa</Button>
                      <Button size="sm" variant="secondary" onClick={() => {
                        // Enviar agora pelo WhatsApp
                        if (!selectedLead?.id) return
                        setSelectedChatLeadId(selectedLead.id)
                        setQuickChatPrefill(suggestText)
                        setQuickChatAutoSend(true)
                        setIsQuickChatOpen(true)
                      }}>Enviar agora pelo WhatsApp</Button>
                      <Button size="sm" variant="outline" onClick={() => {
                        // Salvar como nota
                        if (!selectedLead?.id) return
                        createActivity({ lead_id: selectedLead.id, type: 'note', title: 'Insight do Agente', description: suggestText, completed: false } as any, {
                          onSuccess: () => toast({ title: 'Nota salva', description: 'Insight salvo na timeline.' }),
                          onError: (e: any) => toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
                        })
                      }}>Salvar como nota</Button>
                    </div>
                  </div>
                )}
              </div>
              <div className="rounded-md border p-3">
                <Label className="text-sm font-medium">Lead AI Score</Label>
                <AILeadScore leadId={selectedLead.id} />
              </div>
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

      {/* Smart Summary Modal (Large) */}
      <Dialog open={smartSummaryOpen} onOpenChange={setSmartSummaryOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Resumo Inteligente</DialogTitle>
            <DialogDescription>Geração de resumo executivo e foco do dia</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card className="p-4"><div className="text-xs text-muted-foreground">Total de Leads</div><div className="text-2xl font-semibold">{stats.total}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Conversão</div><div className="text-2xl font-semibold">{stats.conversionRate.toFixed(1)}%</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Valor Total</div><div className="text-2xl font-semibold">R$ {stats.totalValue.toLocaleString('pt-BR')}</div></Card>
              <Card className="p-4"><div className="text-xs text-muted-foreground">Won</div><div className="text-2xl font-semibold">{stats.byStatus['closed-won']}</div></Card>
            </div>
            <Textarea value={smartSummaryText} onChange={e => setSmartSummaryText(e.target.value)} placeholder="Clique em Gerar para obter o resumo" rows={8} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSmartSummaryOpen(false)}>Fechar</Button>
              <Button disabled={smartSummaryBusy} onClick={async () => {
                try {
                  setSmartSummaryBusy(true)
                  const payload = { periodLabel: 'últimos 7 dias', numbers: { newLeads: stats.total, proposals: stats.byStatus['proposal'] || 0, negotiations: stats.byStatus['negotiation'] || 0, won: stats.byStatus['closed-won'] || 0, lost: stats.byStatus['closed-lost'] || 0 } }
                  const r = await apiFetch('/api/dashboard/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                  const js = await r.json().catch(() => ({} as any))
                  const txt = String(js?.text || '').trim()
                  setSmartSummaryText(txt || 'Sem texto gerado.')
                } catch (e: any) {
                  setSmartSummaryText(`Falha ao gerar resumo: ${String(e?.message || e)}`)
                } finally { setSmartSummaryBusy(false) }
              }}>{smartSummaryBusy ? 'Gerando…' : 'Gerar'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Lightweight AI profile viewer
function AILeadProfile({ phone }: { phone: string | null }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    if (!phone) { setData(null); return; }
    let aborted = false;
    (async () => {
      setLoading(true);
      try {
        const r = await apiFetch(`/api/agent/lead-profile?phone=${encodeURIComponent(phone)}`);
        const js = await r.json().catch(() => ({}));
        if (!aborted) setData(r.ok ? js : null);
        if (!r.ok && !aborted) toast({ title: 'Perfil IA indisponível', description: String(js?.error || r.statusText || '—'), variant: 'destructive' });
      } catch (e: any) {
        if (!aborted) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' });
      } finally { if (!aborted) setLoading(false); }
    })();
    return () => { aborted = true; };
  }, [phone]);

  if (!phone) return <p className="text-xs text-muted-foreground">Telefone ausente.</p>;
  if (loading) return <p className="text-xs text-muted-foreground">Carregando…</p>;
  if (!data) return <p className="text-xs text-muted-foreground">Sem dados do agente.</p>;

  const pains = Array.isArray(data.pains) ? data.pains : (Array.isArray(data.principaisDores) ? data.principaisDores : []);
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const interests = Array.isArray(data.interests) ? data.interests : [];
  const emotionalState = data.emotionalState || data.estadoEmocional || null;
  const emotionalConfidence = typeof data.emotionalConfidence === 'number' ? data.emotionalConfidence : null;

  return (
    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
      <div>
        <div className="text-xs text-muted-foreground">Negócio</div>
        <div>{data.businessName || data.nomeDoNegocio || '—'}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Tipo</div>
        <div>{data.businessType || data.tipoDeNegocio || '—'}</div>
      </div>
      <div className="col-span-2">
        <div className="text-xs text-muted-foreground">Dor principal</div>
        <div>{pains[0] || '—'}</div>
      </div>
      <div className="col-span-2">
        <div className="text-xs text-muted-foreground">Resumo</div>
        <div className="bg-muted p-2 rounded-md">{data.lastSummary || data.ultimoResumoDaSituacao || '—'}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Estado emocional</div>
        <div>{emotionalState ? `${emotionalState}${emotionalConfidence != null ? ` (${Math.round(emotionalConfidence*100)}%)` : ''}` : '—'}</div>
      </div>
      {interests.length > 0 && (
        <div className="col-span-2">
          <div className="text-xs text-muted-foreground">Interesses</div>
          <div className="flex flex-wrap gap-1">
            {interests.slice(0,6).map((t: string) => (<Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>))}
          </div>
        </div>
      )}
      {tags.length > 0 && (
        <div className="col-span-2">
          <div className="text-xs text-muted-foreground">Tags IA</div>
          <div className="flex flex-wrap gap-1">
            {tags.slice(0,8).map((t: string) => (<Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>))}
          </div>
        </div>
      )}
    </div>
  );
}

function AILeadScore({ leadId }: { leadId: string }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ score: number; bucket: string; reasons: string[] } | null>(null);

  useEffect(() => {
    if (!leadId) { setData(null); return; }
    let aborted = false;
    (async () => {
      setLoading(true);
      try {
        const r = await apiFetch(`/api/leads/ai-score?lead_id=${encodeURIComponent(leadId)}`);
        const js = await r.json().catch(() => ({}));
        if (!aborted) setData(r.ok ? js : null);
        if (!r.ok && !aborted) toast({ title: 'AI Score indisponível', description: String(js?.error || r.statusText || '—'), variant: 'destructive' });
      } catch (e: any) {
        if (!aborted) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' });
      } finally { if (!aborted) setLoading(false); }
    })();
    return () => { aborted = true; };
  }, [leadId]);

  if (loading) return <p className="text-xs text-muted-foreground">Carregando…</p>;
  if (!data) return <p className="text-xs text-muted-foreground">Sem score.</p>;
  return (
    <div className="mt-2 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{data.bucket}</Badge>
        <div className="font-semibold">{data.score}/100</div>
      </div>
      {Array.isArray(data.reasons) && data.reasons.length > 0 && (
        <ul className="list-disc list-inside text-xs text-muted-foreground">
          {data.reasons.slice(0,3).map((r, i) => (<li key={i}>{r}</li>))}
        </ul>
      )}
    </div>
  );
}

function RankingView({ leads }: { leads: any[] }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Array<{ id: string; name: string; company: string; phone: string | null; status: string; score: number; bucket: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const out: any[] = [];
        for (const l of leads) {
          try {
            const r = await apiFetch(`/api/leads/ai-score?lead_id=${encodeURIComponent(l.id)}`);
            const js = await r.json().catch(() => ({} as any));
            if (r.ok && typeof js?.score === 'number') {
              out.push({ id: l.id, name: l.name, company: l.company, phone: l.phone || null, status: l.status, score: js.score, bucket: js.bucket || '-' });
            } else {
              out.push({ id: l.id, name: l.name, company: l.company, phone: l.phone || null, status: l.status, score: -1, bucket: '-' });
            }
          } catch {
            out.push({ id: l.id, name: l.name, company: l.company, phone: l.phone || null, status: l.status, score: -1, bucket: '-' });
          }
        }
        out.sort((a, b) => (b.score - a.score));
        if (!cancelled) setRows(out);
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' });
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true };
  }, [leads]);

  return (
    <div className="space-y-3">
      {loading && <p className="text-sm text-muted-foreground">Carregando ranking…</p>}
      <div className="grid grid-cols-6 gap-2 text-xs text-muted-foreground">
        <div>Lead</div>
        <div>Empresa</div>
        <div>Status</div>
        <div>Telefone</div>
        <div>Bucket</div>
        <div>Score</div>
      </div>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.id} className="grid grid-cols-6 gap-2 items-center text-sm border-b border-border/40 py-2">
            <div className="truncate">{r.name}</div>
            <div className="truncate">{r.company}</div>
            <div><Badge variant="outline" className="text-[10px]">{r.status}</Badge></div>
            <div className="truncate text-xs text-muted-foreground">{r.phone || '—'}</div>
            <div><Badge variant="secondary" className="text-[10px]">{r.bucket}</Badge></div>
            <div className="font-semibold">{r.score >= 0 ? `${r.score}/100` : '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SmartSummary({ stats }: { stats: any }) {
  const [text, setText] = useState<string>('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const payload = {
          periodLabel: 'últimos 7 dias',
          numbers: {
            newLeads: stats?.trends ? Math.max(0, Math.round(stats.trends.totalDeltaPct)) : 0,
            proposals: stats?.byStatus?.proposal || 0,
            negotiations: stats?.byStatus?.negotiation || 0,
            won: stats?.byStatus?.['closed-won'] || 0,
            lost: stats?.byStatus?.['closed-lost'] || 0,
          }
        }
        const r = await apiFetch('/api/dashboard/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const js = await r.json().catch(() => ({}))
        if (!cancelled) setText(js?.text || '')
      } catch { if (!cancelled) setText('Resumo indisponível no momento.') }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [stats?.total, stats?.trends?.totalDeltaPct, stats?.byStatus?.proposal, stats?.byStatus?.negotiation, stats?.byStatus?.['closed-won'], stats?.byStatus?.['closed-lost']])
  return (
    <div className="text-sm">
      {loading ? <span className="text-muted-foreground">Gerando resumo…</span> : (text || <span className="text-muted-foreground">—</span>)}
    </div>
  )
}

function PipelineHealthSection() {
  const { orgId } = useOrg();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ stages: any[]; avgScore: number; rebalance: string[] } | null>(null);

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await apiFetch(`/api/pipeline/health?organization_id=${encodeURIComponent(orgId)}`)
        const js = await r.json().catch(() => ({} as any))
        if (!cancelled) setData(r.ok ? js : null)
        if (!r.ok && !cancelled) toast({ title: 'Health indisponível', description: String(js?.error || r.statusText || '—'), variant: 'destructive' })
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [orgId])

  if (loading) return <p className="text-sm text-muted-foreground">Calculando saúde do pipeline…</p>
  if (!data) return null

  return (
    <div className="mt-6">
      <div className="mb-2 text-sm text-muted-foreground">Health do Pipeline (heurístico)</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {data.stages.map((s: any) => (
          <Card key={s.stage} className="bg-card border-border/50">
            <CardHeader>
              <CardTitle className="text-sm">{s.stage}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              <div>Leads: {s.count}</div>
              <div>Idade média: {s.avgAgeDays} dias</div>
              <div>Resp. 3d: {s.responseRate}%</div>
              <div>Valor: R$ {Number(s.totalValue||0).toLocaleString('pt-BR')}</div>
              <div>Score: {s.score}/100</div>
              {Array.isArray(s.suggestions) && s.suggestions.length > 0 && (
                <ul className="list-disc list-inside text-xs text-muted-foreground">
                  {s.suggestions.slice(0,2).map((t: string, i: number) => (<li key={i}>{t}</li>))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {Array.isArray(data.rebalance) && data.rebalance.length > 0 && (
        <div className="mt-3 text-xs text-muted-foreground">Reequilíbrio sugerido: {data.rebalance.join('; ')}</div>
      )}
    </div>
  )
}

function FollowupView() {
  const { orgId } = useOrg();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; name: string; company: string; phone: string | null; status: string; value: number; probability: number; suggestion: string; emotion?: string | null; profile?: string | null; breakdown?: { ai: number; recency: number; value: number; stage: number; hotTag: number; agentSignals?: number; bonusStage: number; total: number } }>>([]);
  const [minProb, setMinProb] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { createActivity } = useActivities();

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await apiFetch(`/api/followup/queue?organization_id=${encodeURIComponent(orgId)}`)
        const js = await r.json().catch(() => ({} as any))
        if (!cancelled) setItems(r.ok ? (js?.items || []) : [])
        if (!r.ok && !cancelled) toast({ title: 'Follow-up indisponível', description: String(js?.error || r.statusText || '—'), variant: 'destructive' })
      } catch (e: any) {
        if (!cancelled) toast({ title: 'Erro', description: String(e?.message || e), variant: 'destructive' })
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [orgId])

  const filtered = items.filter(it => it.probability >= minProb && (statusFilter === 'all' || it.status === statusFilter))

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div>
          <Label className="text-[11px] text-foreground/70">Prob. mínima</Label>
          <Input type="number" value={minProb} onChange={(e) => setMinProb(Number(e.target.value || 0))} className="h-9 w-28 bg-background/60 border-sidebar-border" />
        </div>
        <div>
          <Label className="text-[11px] text-foreground/70">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 bg-background/60 border-sidebar-border"><SelectValue placeholder="Todos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="qualified">qualified</SelectItem>
              <SelectItem value="proposal">proposal</SelectItem>
              <SelectItem value="negotiation">negotiation</SelectItem>
              <SelectItem value="closed-won">closed-won</SelectItem>
              <SelectItem value="closed-lost">closed-lost</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-11 gap-2 items-center">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-3 col-span-2" />
              <Skeleton className="h-5 col-span-2" />
              <Skeleton className="h-8" />
              <Skeleton className="h-5" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1 rounded-md border border-sidebar-border/60">
          <div className="grid grid-cols-11 gap-2 text-xs text-muted-foreground sticky top-0 bg-secondary/80 backdrop-blur px-2 py-2 border-b border-sidebar-border/60">
            <div>Lead</div>
            <div>Empresa</div>
            <div>Status</div>
            <div>Telefone</div>
            <div>Valor</div>
            <div>Prob.</div>
            <div>Breakdown</div>
            <div>Ações</div>
            <div>Sugestão</div>
            <div>Sinais</div>
          </div>
          {filtered.map(it => (
            <div key={it.id} className="grid grid-cols-11 gap-2 items-center text-sm px-2 py-2 border-b border-border/30 hover:bg-muted/40 transition-colors">
              <div className="truncate">{it.name}</div>
              <div className="truncate">{it.company}</div>
              <div><Badge variant="outline" className="text-[10px]">{it.status}</Badge></div>
              <div className="truncate text-xs text-muted-foreground">{it.phone || '—'}</div>
              <div className="whitespace-nowrap">R$ {Number(it.value||0).toLocaleString('pt-BR')}</div>
              <div className="space-y-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-help">
                        <div className="text-xs font-medium">{it.probability}%</div>
                        <Progress value={it.probability} className={
                          `h-2 ${it.probability>=75 ? 'bg-green-200' : it.probability>=50 ? 'bg-yellow-200' : 'bg-red-200'}`
                        } />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs space-y-1">
                        <div><span className="text-muted-foreground">AI:</span> {it.breakdown?.ai ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Recência:</span> {it.breakdown?.recency ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Valor:</span> {it.breakdown?.value ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Estágio:</span> {it.breakdown?.stage ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Hot tag:</span> {it.breakdown?.hotTag ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Sinais agente:</span> {it.breakdown?.agentSignals ?? '—'}%</div>
                        <div><span className="text-muted-foreground">Bônus estágio:</span> {it.breakdown?.bonusStage ?? '—'}%</div>
                        <div className="mt-1 font-medium">Total: {it.breakdown?.total ?? '—'}%</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {it.breakdown ? (
                  <div className="flex gap-1 flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">AI {it.breakdown.ai}%</Badge>
                    <Badge variant="secondary" className="text-[10px]">Rec {it.breakdown.recency}%</Badge>
                    <Badge variant="secondary" className="text-[10px]">Val {it.breakdown.value}%</Badge>
                    <Badge variant="secondary" className="text-[10px]">Est {it.breakdown.stage}%</Badge>
                    {(it.breakdown.hotTag ?? 0) > 0 && <Badge variant="outline" className="text-[10px]">Hot +{it.breakdown.hotTag}%</Badge>}
                    {typeof it.breakdown.agentSignals === 'number' && it.breakdown.agentSignals !== 0 && (
                      <Badge variant={it.breakdown.agentSignals > 0 ? 'default' : 'destructive'} className="text-[10px]">
                        Agente {it.breakdown.agentSignals > 0 ? '+' : ''}{it.breakdown.agentSignals}%
                      </Badge>
                    )}
                    {(it.breakdown.bonusStage ?? 0) > 0 && <Badge variant="outline" className="text-[10px]">Bônus +{it.breakdown.bonusStage}%</Badge>}
                  </div>
                ) : '—'}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => {
                  (window as any).crmAgent?.selectLead?.({ leadId: it.id, openDetails: true })
                }}>
                  <Eye className="h-3.5 w-3.5 mr-1" /> Abrir
                </Button>
                <Button variant="default" size="sm" onClick={async () => {
                  try {
                    const res = await (window as any).crmAgent?.dispatchIntent?.('create_task', { leadId: it.id, title: 'Follow-up', description: `Follow-up para ${it.name}` })
                    if (!res?.ok) throw new Error(res?.error || 'Falha ao criar tarefa')
                  } catch {}
                }}>
                  <CheckSquare className="h-3.5 w-3.5 mr-1" /> Tarefa
                </Button>
                <Button variant="secondary" size="sm" onClick={async () => {
                  try {
                    const phoneDigits = String(it.phone || '').replace(/\D/g, '')
                    const r = await apiFetch(`/api/agent/precall?${phoneDigits ? `phone=${encodeURIComponent(phoneDigits)}` : ''}`)
                    const js = await r.json().catch(() => ({} as any))
                    const q = Array.isArray(js?.suggestedQuestions) && js.suggestedQuestions[0] ? String(js.suggestedQuestions[0]) : null
                    if (!q) { toast({ title: 'Sem sugestão', description: 'Nenhuma pergunta sugerida no momento.' }); return }
                    try { await navigator.clipboard.writeText(q) } catch {}
                    toast({ title: 'Sugestão pronta', description: q })
                  } catch (e: any) {
                    toast({ title: 'Falha na Próx. Ação', description: String(e?.message || e), variant: 'destructive' })
                  }
                }}>
                  <Send className="h-3.5 w-3.5 mr-1" /> Próx. Ação
                </Button>
              </div>
              <div className="text-xs text-muted-foreground truncate" title={it.suggestion}>{it.suggestion}</div>
              <div className="text-xs">
                <div className="flex gap-1 flex-wrap">
                  {it.emotion && <Badge variant="outline" className="text-[10px]">{it.emotion}</Badge>}
                  {it.profile && <Badge variant="outline" className="text-[10px]">{it.profile}</Badge>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}