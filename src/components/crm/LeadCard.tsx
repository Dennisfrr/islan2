import React, { useState } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Phone, Mail, MessageCircle, Eye, Edit, Trash2, MoreHorizontal } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import type { Lead } from "@/lib/supabase"
import { useAuth } from "@/components/auth/AuthProvider"

interface LeadCardProps {
  lead: Lead
  onView?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onUpdateStatus?: (leadId: string, newStatus: Lead['status']) => void
}

const statusOptions = [
  { value: "new", label: "Novo" },
  { value: "qualified", label: "Qualificado" },
  { value: "proposal", label: "Proposta" },
  { value: "negotiation", label: "Negociação" },
  { value: "closed-won", label: "Fechado" },
  { value: "closed-lost", label: "Perdido" },
]

export function LeadCard({ lead, onView, onEdit, onDelete }: LeadCardProps) {
  const { role } = useAuth()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 0,
  } as React.CSSProperties

  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState(`Olá ${lead.name}, tudo bem?`)
  const [isSending, setIsSending] = useState(false)

  const toPhone = lead.phone ?? ""

  const handleSend = async () => {
    if (!toPhone) {
      toast({ title: "Sem telefone", description: "Este lead não possui número para WhatsApp.", variant: "destructive" })
      return
    }
    setIsSending(true)
    try {
      const digits = toPhone.replace(/\D/g, "")
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank")
      setOpen(false)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Card className="hover:shadow-md transition-shadow">
        <CardContent className="p-3">
          <div className="flex justify-between items-start mb-2">
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-foreground text-sm truncate">{lead.name}</h4>
              <p className="text-xs text-muted-foreground truncate">{lead.company}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onPointerDown={(e) => e.stopPropagation()}>
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
             <DropdownMenuContent align="end" className="w-48" onPointerDown={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onView?.() }}>
                  <Eye className="h-4 w-4 mr-2" /> Ver detalhes
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onEdit?.() }}>
                  <Edit className="h-4 w-4 mr-2" /> Editar
                </DropdownMenuItem>
                <DropdownMenuSeparator />
               {(role === 'admin' || role === 'manager') && (
                 <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onDelete?.() }} className="text-destructive">
                   <Trash2 className="h-4 w-4 mr-2" /> Excluir
                 </DropdownMenuItem>
               )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <p className="text-base font-semibold text-success">R$ {lead.value.toLocaleString('pt-BR')}</p>
            <Badge variant="outline" className="text-[10px] uppercase">{lead.status}</Badge>
          </div>

          {Array.isArray(lead.tags) && lead.tags.length > 0 && (
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              {lead.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {lead.phone && (
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(true)} aria-label="Enviar WhatsApp">
                  <MessageCircle className="h-3 w-3" />
                </Button>
              )}
              {lead.email && (
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onPointerDown={(e) => e.stopPropagation()}>
                  <Mail className="h-3 w-3" />
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onPointerDown={(e) => e.stopPropagation()}>
                <Phone className="h-3 w-3" />
              </Button>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {Math.floor((Date.now() - new Date(lead.lastContact).getTime()) / (1000 * 60 * 60))}h
            </span>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Enviar WhatsApp</DialogTitle>
                <DialogDescription>Enviar via WhatsApp Web</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <div className="space-y-1">
                  <Label htmlFor="to">Para</Label>
                  <Input id="to" value={toPhone} disabled />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="msg">Mensagem</Label>
                  <Textarea id="msg" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button onClick={handleSend} disabled={isSending || !toPhone}>{isSending ? "Enviando..." : "Enviar"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  )
}