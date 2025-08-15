import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'

export function DealPreview() {
  const { id } = useParams<{ id: string }>()
  const [loading, setLoading] = useState(true)
  const [deal, setDeal] = useState<any>(null)
  const [items, setItems] = useState<any[]>([])

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      try {
        const d = await apiFetch(`/api/deals/${id}`).then(r => r.json())
        const restUrl = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/deal_items?select=*&deal_id=eq.${id}`
        const it = await fetch(restUrl, {
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY as string}`,
          }
        }).then(r => r.json())
        if (!mounted) return
        setDeal(d.deal)
        setItems(it || [])
      } finally {
        setLoading(false)
      }
    }
    if (id) load()
    return () => { mounted = false }
  }, [id])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Carregando...</div>
  if (!deal) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Proposta não encontrada.</div>

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto">
        <Card className="border-border shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>{deal.title}</span>
              <span className="text-sm text-muted-foreground capitalize">{deal.status}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {deal.description && <p className="text-sm text-foreground">{deal.description}</p>}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left py-2">Item</th>
                  <th className="text-right py-2">Qtd</th>
                  <th className="text-right py-2">Preço</th>
                  <th className="text-right py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className="border-b border-border">
                    <td className="py-2">{it.product_name}</td>
                    <td className="py-2 text-right">{it.quantity}</td>
                    <td className="py-2 text-right">R$ {Number(it.unit_price).toLocaleString('pt-BR')}</td>
                    <td className="py-2 text-right">R$ {Number(it.total_price).toLocaleString('pt-BR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-right text-lg font-bold">Total: R$ {Number(deal.total_value || 0).toLocaleString('pt-BR')}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default DealPreview


