import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { Plus, Pencil, ListPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LeadCard } from "./LeadCard"
import type { Lead } from "@/lib/supabase"

interface PipelineStageProps {
  stage: {
    id: string
    name: string
    color: string
    count: number
  }
  leads: Lead[]
  onViewLead?: (lead: Lead) => void
  onEditLead?: (lead: Lead) => void
  onDeleteLead?: (leadId: string) => void
  onUpdateStatus?: (leadId: string, newStatus: Lead['status']) => void
  onCreateLeadInStage?: (status: Lead['status']) => void
  onOpenChat?: (leadId: string) => void
  onEditStages?: (stageId: string) => void
  onBulkCreateInStage?: (status: Lead['status']) => void
}

export function PipelineStage({ 
  stage, 
  leads, 
  onViewLead, 
  onEditLead, 
  onDeleteLead, 
  onCreateLeadInStage,
  onOpenChat,
  onEditStages,
  onBulkCreateInStage,
}: PipelineStageProps) {
  const { setNodeRef } = useDroppable({
    id: stage.id,
  });

  const totalValue = leads.reduce((sum, l) => sum + (Number(l.value) || 0), 0)

  return (
    <div ref={setNodeRef} className="rounded-lg p-3 border border-border/50 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 bg-foreground/40 rounded-full`} />
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] tracking-wide uppercase text-foreground/80">{stage.name}</h3>
            {onEditStages && (
              <Button
                title="Editar estágios"
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0 text-foreground/60 hover:text-foreground"
                onClick={() => onEditStages?.(stage.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] border-border/60 text-foreground/80">{leads.length}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground/60 font-medium">R$ {totalValue.toLocaleString('pt-BR')}</span>
          <Button variant="ghost" size="sm" className="text-foreground/70 hover:bg-sidebar-accent" onClick={() => onCreateLeadInStage?.(stage.id as Lead['status'])}>
            <Plus className="h-4 w-4" />
          </Button>
          {onBulkCreateInStage && (
            <Button title="Criar vários" variant="ghost" size="sm" className="text-foreground/70 hover:bg-sidebar-accent" onClick={() => onBulkCreateInStage?.(stage.id as Lead['status'])}>
              <ListPlus className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border/60 rounded-md p-6">
          <p className="text-xs text-muted-foreground mb-2">Nenhum lead neste estágio</p>
          <Button size="sm" onClick={() => onCreateLeadInStage?.(stage.id as Lead['status'])}>Novo lead</Button>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {/* dnd-kit espera items como IDs dos sortables */}
          <SortableContext id={stage.id} items={leads.map(l => l.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {leads.map((lead) => (
                <LeadCard 
                  key={lead.id}
                  lead={lead} 
                  onView={() => onViewLead?.(lead)}
                  onEdit={() => onEditLead?.(lead)}
                  onDelete={() => onDeleteLead?.(lead.id)}
                  onOpenChat={(leadId) => onOpenChat?.(leadId)}
                />
              ))}
            </div>
          </SortableContext>
        </ScrollArea>
      )}
    </div>
  )
}