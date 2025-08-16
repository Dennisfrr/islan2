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
    <div className="w-full lg:w-80 border-r border-border flex flex-col bg-card">
      <div className="p-3">
        <Input placeholder="Buscar contatos" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.map(l => (
          <button
            key={l.id}
            onClick={() => onSelectLead(l.id)}
            className={`w-full px-3 py-2 flex items-center gap-3 border-b border-border text-left hover:bg-primary/5 ${selectedLeadId === l.id ? 'bg-primary/10' : ''}`}
          >
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-primary text-xs font-bold">{(l.name || 'C').charAt(0)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate flex items-center gap-2">
                <span className="truncate">{l.name}</span>
                {selectedLeadId === l.id && <Check className="h-3 w-3 text-primary" />}
              </div>
              <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                <Phone className="h-3 w-3" /> {(l.phone || '').toString() || 'Sem telefone'}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {l.status && (
                  <Badge variant="secondary" className="text-[9px] uppercase">{l.status}</Badge>
                )}
                {typeof l.value === 'number' && !Number.isNaN(l.value) && (
                  <Badge variant="outline" className="text-[9px]">R$ {Number(l.value).toLocaleString('pt-BR')}</Badge>
                )}
                {Array.isArray(l.tags) && l.tags.length > 0 && (
                  <>
                    <Badge variant="secondary" className="text-[9px]">{l.tags[0]}</Badge>
                    {l.tags.length > 1 && (
                      <Badge variant="secondary" className="text-[9px]">+{l.tags.length - 1}</Badge>
                    )}
                  </>
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