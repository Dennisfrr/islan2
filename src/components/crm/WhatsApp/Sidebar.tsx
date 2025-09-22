import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Lead } from '@/lib/supabase'
import { Phone, Check } from 'lucide-react'
import { useMemo, useState } from 'react'

interface WhatsAppSidebarProps {
  leads: Lead[]
  selectedLeadId?: string
  onSelectLead: (leadId: string) => void
}

export function WhatsAppSidebar({ leads, selectedLeadId, onSelectLead }: WhatsAppSidebarProps) {
  const [search, setSearch] = useState('')
  const statusWeight: Record<string, number> = {
    negotiation: 5,
    proposal: 4,
    qualified: 3,
    new: 2,
    'closed-won': 1,
    'closed-lost': 0,
  }
  const filtered = useMemo(() => {
    const list = leads
      .filter(l => (l.phone || '').toString().length > 0)
      .filter(l => (l.name + ' ' + l.company + ' ' + (l.phone || '')).toLowerCase().includes(search.toLowerCase()))
    return list.sort((a, b) => {
      const wa = statusWeight[String(a.status) as keyof typeof statusWeight] ?? 0
      const wb = statusWeight[String(b.status) as keyof typeof statusWeight] ?? 0
      if (wb !== wa) return wb - wa
      const va = Number(a.value || 0)
      const vb = Number(b.value || 0)
      if (vb !== va) return vb - va
      return String(a.name || '').localeCompare(String(b.name || ''))
    })
  }, [leads, search])

  return (
    <div className="w-full lg:w-80 border-r border-border flex flex-col bg-background">
      <div className="p-3 border-b border-border bg-secondary">
        <Input className="rounded-full bg-muted text-foreground placeholder:text-muted-foreground border-0" placeholder="Buscar contatos" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.map(l => (
          <button
            key={l.id}
            onClick={() => onSelectLead(l.id)}
            className={`w-full px-3 py-2 flex items-center gap-3 border-b border-border text-left hover:bg-muted ${selectedLeadId === l.id ? 'bg-muted' : ''}`}
          >
            <div className="w-10 h-10 rounded-full bg-muted text-foreground flex items-center justify-center font-bold">
              {(l.name || 'C').charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium truncate flex items-center gap-2 text-foreground">
                <span className="truncate">{l.name}</span>
                {selectedLeadId === l.id && <Check className="h-3 w-3" />}
              </div>
              <div className="text-[12px] text-muted-foreground truncate flex items-center gap-1">
                <Phone className="h-3 w-3" /> {(l.phone || '').toString() || 'Sem telefone'}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {l.status && (
                  <Badge variant="secondary" className="text-[10px] uppercase">{l.status}</Badge>
                )}
                {Array.isArray(l.tags) && l.tags.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{l.tags[0]}</Badge>
                )}
              </div>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">Nenhum contato encontrado.</div>
        )}
      </div>
    </div>
  )
}