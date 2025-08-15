import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { supabase } from '@/lib/supabase'
import { useActivities } from '@/hooks/useActivities'
import { useCommunications } from '@/hooks/useCommunications'

type TimelineItem = {
  id: string
  kind: 'activity' | 'communication' | 'deal'
  title: string
  subtitle?: string
  created_at: string
}

export function LeadTimeline({ leadId }: { leadId: string }) {
  const { activities } = useActivities(leadId)
  const { communications } = useCommunications(leadId, undefined)
  const [deals, setDeals] = useState<Array<{ id: string; title: string; status: string; created_at: string }>>([])

  useEffect(() => {
    let mounted = true
    async function loadDeals() {
      const { data } = await supabase
        .from('deals')
        .select('id,title,status,created_at')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(10)
      if (mounted) setDeals(data || [])
    }
    loadDeals()
    return () => { mounted = false }
  }, [leadId])

  const items: TimelineItem[] = useMemo(() => {
    const acts: TimelineItem[] = (activities || []).map(a => ({
      id: a.id,
      kind: 'activity',
      title: a.title,
      subtitle: a.type,
      created_at: a.created_at,
    }))
    const comms: TimelineItem[] = (communications || []).map(c => ({
      id: c.id,
      kind: 'communication',
      title: c.subject || (c.content ? c.content.slice(0, 80) : '(sem conteúdo)'),
      subtitle: `${c.type} • ${c.direction}`,
      created_at: c.created_at,
    }))
    const ds: TimelineItem[] = deals.map(d => ({
      id: d.id,
      kind: 'deal',
      title: d.title,
      subtitle: `proposta • ${d.status}`,
      created_at: d.created_at,
    }))
    return [...acts, ...comms, ...ds]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5)
  }, [activities, communications, deals])

  if (!items.length) {
    return <div className="text-sm text-muted-foreground">Sem registros ainda.</div>
  }

  return (
    <Card className="bg-muted/30 border-border">
      <CardContent className="p-3 space-y-2">
        {items.map((it) => (
          <div key={`${it.kind}:${it.id}`} className="flex items-start gap-2">
            <Badge variant="secondary" className="capitalize text-xs min-w-[88px] text-center">
              {it.kind}
            </Badge>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground truncate">{it.title}</div>
              {it.subtitle && <div className="text-xs text-muted-foreground truncate">{it.subtitle}</div>}
            </div>
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(it.created_at).toLocaleString('pt-BR')}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}


