import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDealItems, useDeals } from '@/hooks/useDeals'
import { useProducts } from '@/hooks/useProducts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Trash2 } from 'lucide-react'

export function DealEditor({ open, onOpenChange, dealId }: { open: boolean; onOpenChange: (open: boolean) => void; dealId: string | null }) {
  const { items, isLoading, addItem, removeItem } = useDealItems(dealId || undefined)
  const { products } = useProducts()
  const { deals } = useDeals()

  const deal = useMemo(() => deals.find(d => d.id === dealId) || null, [deals, dealId])

  const [selectedProductId, setSelectedProductId] = useState<string | undefined>(undefined)
  const [manualName, setManualName] = useState('')
  const [quantity, setQuantity] = useState<number>(1)
  const [price, setPrice] = useState<number>(0)

  useEffect(() => {
    if (!selectedProductId) return
    const p = products.find(p => p.id === selectedProductId)
    if (p) {
      setManualName(p.name)
      setPrice(Number(p.price))
    }
  }, [selectedProductId, products])

  const handleAdd = () => {
    if (!dealId) return
    const name = manualName.trim()
    if (!name || quantity <= 0 || price < 0) return
    addItem({ product_id: selectedProductId || null, product_name: name, quantity, unit_price: price })
    setSelectedProductId(undefined)
    setManualName('')
    setQuantity(1)
    setPrice(0)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Editar Itens da Proposta {deal ? `— ${deal.title}` : ''}</DialogTitle>
        </DialogHeader>
        {!dealId ? (
          <div className="text-sm text-muted-foreground">Selecione uma proposta.</div>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardContent className="p-4 grid grid-cols-1 md:grid-cols-6 gap-3">
                <div className="md:col-span-3">
                  <Label>Produto</Label>
                  <Select value={selectedProductId} onValueChange={(v) => setSelectedProductId(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione um produto (opcional)" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-3">
                  <Label>Nome do item</Label>
                  <Input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Nome personalizado" />
                </div>
                <div>
                  <Label>Qtd</Label>
                  <Input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} min={1} />
                </div>
                <div>
                  <Label>Preço unitário</Label>
                  <Input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} min={0} step={0.01} />
                </div>
                <div className="md:col-span-2 flex items-end">
                  <Button onClick={handleAdd}>
                    <Plus className="h-4 w-4 mr-2" /> Adicionar
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left p-3">Item</th>
                        <th className="text-right p-3">Qtd</th>
                        <th className="text-right p-3">Preço</th>
                        <th className="text-right p-3">Total</th>
                        <th className="p-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoading ? (
                        <tr><td colSpan={5} className="p-6 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mr-2 inline animate-spin" /> Carregando itens...</td></tr>
                      ) : items.length === 0 ? (
                        <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Nenhum item.</td></tr>
                      ) : (
                        items.map(it => (
                          <tr key={it.id} className="border-b border-border">
                            <td className="p-3">{it.product_name}</td>
                            <td className="p-3 text-right">{it.quantity}</td>
                            <td className="p-3 text-right">R$ {Number(it.unit_price).toLocaleString('pt-BR')}</td>
                            <td className="p-3 text-right">R$ {Number(it.total_price).toLocaleString('pt-BR')}</td>
                            <td className="p-3 text-right">
                              <Button variant="ghost" size="icon" className="text-destructive" onClick={() => removeItem(it.id)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}


