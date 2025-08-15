import { Input } from '@/components/ui/input'
import { Lead } from '@/lib/supabase'
import { Phone } from 'lucide-react'

interface WhatsAppSidebarProps {
  leads: Lead[]
  selectedLeadId?: string
  onSelectLead: (leadId: string) => void
}

export function WhatsAppSidebar({ leads, selectedLeadId, onSelectLead }: WhatsAppSidebarProps) {
  const [search, setSearch] = useState('')
  const filtered = leads.filter(l => (l.phone || '').toString().length > 0)
    .filter(l => (l.name + ' ' + l.company + ' ' + (l.phone || '')).toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="w-full lg:w-80 border-r border-border flex flex-col">
      <div className="p-3">
        <Input placeholder="Buscar contatos" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.map(l => (
          <button
            key={l.id}
            onClick={() => onSelectLead(l.id)}
            className={`w-full px-3 py-2 flex items-center gap-3 border-b border-border text-left hover:bg-muted ${selectedLeadId === l.id ? 'bg-muted' : ''}`}
          >
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-primary text-xs font-bold">{(l.name || 'C').charAt(0)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{l.name}</div>
              <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                <Phone className="h-3 w-3" /> {(l.phone || '').toString() || 'Sem telefone'}
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

import { useState } from 'react' 