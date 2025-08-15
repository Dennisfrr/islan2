import { useState } from 'react'
import { Plus, Edit, Trash2, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useProducts, useProductCategories } from '@/hooks/useProducts'
import { useAuth } from '@/components/auth/AuthProvider'
import { useToast } from '@/hooks/use-toast'

export function ProductsManager() {
  const { role } = useAuth()
  const { products, isLoading, createProduct, updateProduct, deleteProduct, isCreating, isUpdating, isDeleting } = useProducts()
  const categories = useProductCategories()
  const { toast } = useToast()

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<any>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')

  const handleCreateProduct = (formData: FormData) => {
    if (!(role === 'admin' || role === 'manager')) return
    const newProduct = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      price: Number(formData.get('price')),
      category: formData.get('category') as string,
      active: true,
    }

    createProduct(newProduct, {
      onSuccess: () => {
        setIsCreateModalOpen(false)
        toast({
          title: 'Produto criado!',
          description: 'O produto foi adicionado com sucesso.',
        })
      },
      onError: (error: any) => {
        toast({
          title: 'Erro!',
          description: error.message,
          variant: 'destructive',
        })
      }
    })
  }

  const handleEditProduct = (formData: FormData) => {
    if (!(role === 'admin' || role === 'manager')) return
    if (!selectedProduct) return

    const updatedProduct = {
      ...selectedProduct,
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      price: Number(formData.get('price')),
      category: formData.get('category') as string,
    }

    updateProduct(updatedProduct, {
      onSuccess: () => {
        setIsEditModalOpen(false)
        setSelectedProduct(null)
        toast({
          title: 'Produto atualizado!',
          description: 'O produto foi atualizado com sucesso.',
        })
      },
      onError: (error: any) => {
        toast({
          title: 'Erro!',
          description: error.message,
          variant: 'destructive',
        })
      }
    })
  }

  const handleDeleteProduct = (productId: string) => {
    if (!(role === 'admin' || role === 'manager')) return
    deleteProduct(productId, {
      onSuccess: () => {
        toast({
          title: 'Produto removido!',
          description: 'O produto foi removido com sucesso.',
          variant: 'destructive'
        })
      },
      onError: (error: any) => {
        toast({
          title: 'Erro!',
          description: error.message,
          variant: 'destructive',
        })
      }
    })
  }

  const filteredProducts = filterCategory === 'all' 
    ? products 
    : products.filter(product => product.category === filterCategory)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-foreground">Carregando produtos...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Produtos & Serviços</h2>
          <p className="text-muted-foreground">Gerencie seu catálogo de produtos e serviços</p>
        </div>
        
        <div className="flex items-center space-x-4">
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Categoria" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(role === 'admin' || role === 'manager') && (
          <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Novo Produto
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Criar Novo Produto</DialogTitle>
              </DialogHeader>
              <form onSubmit={(e) => {
                e.preventDefault()
                const formData = new FormData(e.currentTarget)
                handleCreateProduct(formData)
              }} className="space-y-4">
                <div>
                  <Label htmlFor="name">Nome *</Label>
                  <Input id="name" name="name" required />
                </div>
                <div>
                  <Label htmlFor="description">Descrição</Label>
                  <Textarea id="description" name="description" rows={3} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="price">Preço (R$) *</Label>
                    <Input id="price" name="price" type="number" step="0.01" required />
                  </div>
                  <div>
                    <Label htmlFor="category">Categoria *</Label>
                    <Select name="category" defaultValue="">
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category} value={category}>{category}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end space-x-2">
                  <Button type="button" variant="outline" onClick={() => setIsCreateModalOpen(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={isCreating}>
                    {isCreating ? "Criando..." : "Criar Produto"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredProducts.map((product) => (
          <Card key={product.id} className="hover:shadow-glow transition-all duration-300">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start">
                <div className="flex items-center space-x-2">
                  <Package className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">{product.name}</CardTitle>
                </div>
                {(role === 'admin' || role === 'manager') && (
                <div className="flex space-x-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => {
                      setSelectedProduct(product)
                      setIsEditModalOpen(true)
                    }}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    onClick={() => handleDeleteProduct(product.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {product.description && (
                  <p className="text-sm text-muted-foreground">{product.description}</p>
                )}
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{product.category}</Badge>
                  <span className="text-lg font-bold text-primary">
                    R$ {product.price.toLocaleString('pt-BR')}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredProducts.length === 0 && (
        <div className="text-center py-12">
          <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">Nenhum produto encontrado</h3>
          <p className="text-muted-foreground mb-4">
            {filterCategory === 'all' 
              ? 'Comece criando seu primeiro produto ou serviço.'
              : `Nenhum produto encontrado na categoria "${filterCategory}".`
            }
          </p>
          {filterCategory === 'all' && (role === 'admin' || role === 'manager') && (
            <Button onClick={() => setIsCreateModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Criar Primeiro Produto
            </Button>
          )}
        </div>
      )}

      {/* Edit Product Modal */}
      {(role === 'admin' || role === 'manager') && (
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Produto</DialogTitle>
          </DialogHeader>
          {selectedProduct && (
            <form onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              handleEditProduct(formData)
            }} className="space-y-4">
              <div>
                <Label htmlFor="edit-name">Nome *</Label>
                <Input id="edit-name" name="name" defaultValue={selectedProduct.name} required />
              </div>
              <div>
                <Label htmlFor="edit-description">Descrição</Label>
                <Textarea id="edit-description" name="description" rows={3} defaultValue={selectedProduct.description} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-price">Preço (R$) *</Label>
                  <Input id="edit-price" name="price" type="number" step="0.01" defaultValue={selectedProduct.price} required />
                </div>
                <div>
                  <Label htmlFor="edit-category">Categoria *</Label>
                    <Select name="category" defaultValue={selectedProduct.category}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category} value={category}>{category}</SelectItem>
                        ))}
                      </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setIsEditModalOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={isUpdating}>
                  {isUpdating ? "Salvando..." : "Salvar Alterações"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      )}
    </div>
  )
}
