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
    <div className="w-full lg:w-80 border-r border-border flex flex-col bg-white dark:bg-[#111B21]">
      <div className="p-3 border-b border-border bg-[#F0F2F5] dark:bg-[#202C33]">
        <Input className="rounded-full bg-white dark:bg-[#2A3942] dark:text-[#E9EDEF] placeholder:dark:text-[#8696A0] border-0" placeholder="Buscar contatos" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.map(l => (
          <button
            key={l.id}
            onClick={() => onSelectLead(l.id)}
            className={`w-full px-3 py-2 flex items-center gap-3 border-b border-[#ededed] text-left hover:bg-[#f5f6f6] ${selectedLeadId === l.id ? 'bg-[#ebf3ff]' : ''}`}
          >
            <div className="w-10 h-10 rounded-full bg-[#e0f7ef] dark:bg-[#005C4B] flex items-center justify-center text-[#128C7E] dark:text-[#E9EDEF] font-bold">
              {(l.name || 'C').charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium truncate flex items-center gap-2 text-[#111] dark:text-[#E9EDEF]">
                <span className="truncate">{l.name}</span>
                {selectedLeadId === l.id && <Check className="h-3 w-3 text-[#34B7F1]" />}
              </div>
              <div className="text-[12px] text-[#667781] dark:text-[#8696A0] truncate flex items-center gap-1">
                <Phone className="h-3 w-3" /> {(l.phone || '').toString() || 'Sem telefone'}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {l.status && (
                  <Badge variant="secondary" className="text-[10px] uppercase bg-[#f1f1f1] dark:bg-[#0B141A] text-[#4b5563] dark:text-[#8696A0] border-0">{l.status}</Badge>
                )}
                {Array.isArray(l.tags) && l.tags.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-[#e6f7ff] dark:bg-[#0B141A] text-[#0369a1] dark:text-[#8696A0] border-0">{l.tags[0]}</Badge>
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