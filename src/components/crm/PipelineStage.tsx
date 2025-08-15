import { useDroppable } from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { Plus } from "lucide-react"
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
}

export function PipelineStage({ 
  stage, 
  leads, 
  onViewLead, 
  onEditLead, 
  onDeleteLead, 
  onCreateLeadInStage,
}: PipelineStageProps) {
  const { setNodeRef } = useDroppable({
    id: stage.id,
  });

  const totalValue = leads.reduce((sum, l) => sum + (Number(l.value) || 0), 0)

  return (
    <div ref={setNodeRef} className="bg-card rounded-lg p-3 border border-border flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 ${stage.color} rounded-full`} />
          <h3 className="font-medium text-foreground text-sm">{stage.name}</h3>
          <Badge variant="secondary">{leads.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">R$ {totalValue.toLocaleString('pt-BR')}</span>
          <Button variant="ghost" size="sm" onClick={() => onCreateLeadInStage?.(stage.id as Lead['status'])}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border rounded-md p-6">
          <p className="text-xs text-muted-foreground mb-2">Nenhum lead neste estágio</p>
          <Button size="sm" onClick={() => onCreateLeadInStage?.(stage.id as Lead['status'])}>Novo lead</Button>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <SortableContext id={stage.id} items={leads} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {leads.map((lead) => (
                <LeadCard 
                  key={lead.id}
                  lead={lead} 
                  onView={() => onViewLead?.(lead)}
                  onEdit={() => onEditLead?.(lead)}
                  onDelete={() => onDeleteLead?.(lead.id)}
                />
              ))}
            </div>
          </SortableContext>
        </ScrollArea>
      )}
    </div>
  )
}