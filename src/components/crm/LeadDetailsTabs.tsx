import { useActivities } from '@/hooks/useActivities'
import { useCommunications } from '@/hooks/useCommunications'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface LeadDetailsTabsProps {
  leadId: string
}

export function LeadDetailsTabs({ leadId }: LeadDetailsTabsProps) {
  const { activities } = useActivities(leadId)
  const { communications } = useCommunications(leadId)

  return (
    <Tabs defaultValue="overview" className="mt-4">
      <TabsList>
        <TabsTrigger value="overview">Visão Geral</TabsTrigger>
        <TabsTrigger value="activities">Atividades <Badge variant="secondary" className="ml-2">{activities.length}</Badge></TabsTrigger>
        <TabsTrigger value="comms">Comunicações <Badge variant="secondary" className="ml-2">{communications.length}</Badge></TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <Card className="bg-gradient-card border-border"><CardContent className="p-4 text-sm text-muted-foreground">Resumo do lead e campos principais.</CardContent></Card>
      </TabsContent>
      <TabsContent value="activities">
        <div className="space-y-2">
          {activities.map(a => (
            <Card key={a.id} className="bg-card border-border"><CardContent className="p-3 text-sm"><span className="capitalize">[{a.type}]</span> {a.title} {a.due_date ? `— até ${new Date(a.due_date).toLocaleString('pt-BR')}` : ''}</CardContent></Card>
          ))}
          {activities.length === 0 && <p className="text-xs text-muted-foreground">Sem atividades.</p>}
        </div>
      </TabsContent>
      <TabsContent value="comms">
        <div className="space-y-2">
          {communications.map(c => (
            <Card key={c.id} className="bg-card border-border"><CardContent className="p-3 text-sm">[{c.type} • {c.direction}] {c.content}</CardContent></Card>
          ))}
          {communications.length === 0 && <p className="text-xs text-muted-foreground">Sem comunicações.</p>}
        </div>
      </TabsContent>
    </Tabs>
  )
} 