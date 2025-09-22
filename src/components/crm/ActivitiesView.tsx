import { useState } from "react"
import { format } from "date-fns"
import { useActivities } from "@/hooks/useActivities"
import { useLeads } from "@/hooks/useLeads"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Loader2, Plus, CheckCircle2, Trash2, Pencil } from "lucide-react"

interface ActivitiesViewProps {
  onViewLead?: (leadId: string) => void
  title?: string
  lockedType?: 'call' | 'email' | 'meeting' | 'note' | 'task'
}

export function ActivitiesView({ onViewLead, title = "Atividades", lockedType }: ActivitiesViewProps) {
  const { leads } = useLeads()
  const { activities, isLoading, createActivity, updateActivity, deleteActivity } = useActivities()

  const [filters, setFilters] = useState<{ leadId: string | "all"; type: string | "all"; status: "all" | "open" | "completed"; search: string }>(() => ({
    leadId: "all",
    type: lockedType ?? "all",
    status: "all",
    search: "",
  }))

  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const filtered = activities.filter((a) => {
    if (filters.leadId !== "all" && a.lead_id !== filters.leadId) return false
    if (filters.type !== "all" && a.type !== (filters.type as any)) return false
    if (filters.status === "open" && a.completed) return false
    if (filters.status === "completed" && !a.completed) return false
    if (filters.search) {
      const s = filters.search.toLowerCase()
      if (!a.title.toLowerCase().includes(s) && !(a.description || "").toLowerCase().includes(s)) return false
    }
    return true
  })

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const payload = {
      lead_id: fd.get("lead_id") as string,
      type: (lockedType ?? (fd.get("type") as any)) as any,
      title: fd.get("title") as string,
      description: (fd.get("description") as string) || undefined,
      due_date: (fd.get("due_date") as string) || undefined,
      completed: false,
    }
    createActivity(payload, { onSuccess: () => setIsCreateOpen(false) })
  }

  const handleInlineToggle = (id: string, completed: boolean) => {
    const item = activities.find((a) => a.id === id)
    if (!item) return
    updateActivity({ ...item, completed })
  }

  const handleInlineDelete = (id: string) => {
    deleteActivity(id)
  }

  const handleInlineEdit = (e: React.FormEvent<HTMLFormElement>, id: string) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const item = activities.find((a) => a.id === id)
    if (!item) return
    updateActivity({
      ...item,
      lead_id: (fd.get("lead_id") as string) || item.lead_id,
      type: (lockedType ?? ((fd.get("type") as any) || item.type)) as any,
      title: (fd.get("title") as string) || item.title,
      description: (fd.get("description") as string) || item.description,
      due_date: (fd.get("due_date") as string) || item.due_date,
    })
    setEditingId(null)
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">{title}</h2>
          <p className="text-muted-foreground">Gerencie atividades e tarefas com prazo</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" /> Nova {lockedType === 'task' ? 'tarefa' : 'atividade'}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar {lockedType === 'task' ? 'tarefa' : 'atividade'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>Lead</Label>
                  <Select name="lead_id" defaultValue={filters.leadId !== "all" ? filters.leadId : undefined}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione um lead" />
                    </SelectTrigger>
                    <SelectContent>
                      {leads.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name} — {l.company}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!lockedType && (
                  <div>
                    <Label>Tipo</Label>
                    <Select name="type" defaultValue="task">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="task">Tarefa</SelectItem>
                        <SelectItem value="call">Ligação</SelectItem>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="meeting">Reunião</SelectItem>
                        <SelectItem value="note">Nota</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="md:col-span-2">
                  <Label>Título</Label>
                  <Input name="title" required />
                </div>
                <div className="md:col-span-2">
                  <Label>Descrição</Label>
                  <Input name="description" />
                </div>
                <div>
                  <Label>Prazo</Label>
                  <Input type="datetime-local" name="due_date" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit">Salvar</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border/50 shadow-none mb-4">
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <Label>Lead</Label>
            <Select value={filters.leadId} onValueChange={(v) => setFilters((f) => ({ ...f, leadId: v as any }))}>
              <SelectTrigger>
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!lockedType && (
            <div>
              <Label>Tipo</Label>
              <Select value={filters.type} onValueChange={(v) => setFilters((f) => ({ ...f, type: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="task">Tarefa</SelectItem>
                  <SelectItem value="call">Ligação</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="meeting">Reunião</SelectItem>
                  <SelectItem value="note">Nota</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>Status</Label>
            <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v as any }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="open">Abertos</SelectItem>
                <SelectItem value="completed">Concluídos</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Busca</Label>
            <Input placeholder="Buscar por título ou descrição" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Carregando atividades...
          </div>
        ) : (
          filtered.map((a) => {
            const lead = leads.find((l) => l.id === a.lead_id)
            const overdue = a.due_date && !a.completed && new Date(a.due_date) < new Date()
            return (
              <Card key={a.id} className="border-border/50 shadow-none">
                <CardContent className="p-4 flex items-center gap-4">
                  <Checkbox checked={a.completed} onCheckedChange={(v) => handleInlineToggle(a.id, Boolean(v))} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs capitalize">{a.type}</Badge>
                      {overdue && <Badge variant="destructive" className="text-xs">Atrasada</Badge>}
                      {a.due_date && (
                        <span className="text-xs text-muted-foreground">até {format(new Date(a.due_date), "dd/MM/yyyy HH:mm")}</span>
                      )}
                    </div>
                    <div className="font-medium text-foreground truncate">{a.title}</div>
                    {a.description && <div className="text-sm text-muted-foreground truncate">{a.description}</div>}
                    {lead && (
                      <button className="text-xs text-primary hover:underline" onClick={() => onViewLead?.(lead.id)}>
                        {lead.name} — {lead.company}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" onClick={() => setEditingId(a.id)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={() => handleInlineDelete(a.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
                {editingId === a.id && (
                  <CardContent className="pt-0 pb-4">
                    <form onSubmit={(e) => handleInlineEdit(e, a.id)} className="grid grid-cols-1 md:grid-cols-6 gap-3">
                      <div className="md:col-span-2">
                        <Label>Lead</Label>
                        <Select name="lead_id" defaultValue={a.lead_id}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {leads.map((l) => (
                              <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {!lockedType && (
                        <div>
                          <Label>Tipo</Label>
                          <Select name="type" defaultValue={a.type}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="task">Tarefa</SelectItem>
                              <SelectItem value="call">Ligação</SelectItem>
                              <SelectItem value="email">Email</SelectItem>
                              <SelectItem value="meeting">Reunião</SelectItem>
                              <SelectItem value="note">Nota</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="md:col-span-2">
                        <Label>Título</Label>
                        <Input name="title" defaultValue={a.title} />
                      </div>
                      <div className="md:col-span-2">
                        <Label>Descrição</Label>
                        <Input name="description" defaultValue={a.description || ""} />
                      </div>
                      <div>
                        <Label>Prazo</Label>
                        <Input type="datetime-local" name="due_date" defaultValue={a.due_date ? a.due_date.substring(0,16) : ""} />
                      </div>
                      <div className="flex items-end justify-end">
                        <Button type="submit"><CheckCircle2 className="h-4 w-4 mr-2" />Salvar</Button>
                      </div>
                    </form>
                  </CardContent>
                )}
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
} 