import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, Product } from '@/lib/supabase'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'

// Funções da API
const fetchProducts = async (orgId?: string): Promise<Product[]> => {
  let q = supabase
    .from('products')
    .select('*')
    .eq('active', true)
    .order('name', { ascending: true })
  if (orgId) q = q.eq('organization_id', orgId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

const createProduct = async (newProduct: Omit<Product, 'id' | 'created_at' | 'updated_at' | 'user_id'> & { organization_id?: string }): Promise<Product> => {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Usuário não autenticado')

  const { data, error } = await supabase
    .from('products')
    .insert([{ ...newProduct, user_id: user.id }])
    .select()
    .single()

  if (error) throw error
  return data
}

const updateProduct = async (updatedProduct: Product): Promise<Product> => {
  const { data, error } = await supabase
    .from('products')
    .update(updatedProduct)
    .eq('id', updatedProduct.id)
    .select()
    .single()

  if (error) throw error
  return data
}

const deleteProduct = async (productId: string): Promise<void> => {
  const { error } = await supabase
    .from('products')
    .update({ active: false })
    .eq('id', productId)

  if (error) throw error
}

// Hook principal
export function useProducts() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { orgId } = useOrg()

  const {
    data: products = [],
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['products', orgId],
    queryFn: () => fetchProducts(orgId || undefined),
    enabled: !!user && !!orgId,
  })

  const createMutation = useMutation({
    mutationFn: (payload: any) => createProduct({ ...payload, organization_id: orgId || undefined } as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: updateProduct,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  return {
    products,
    isLoading,
    error,
    refetch,
    createProduct: createMutation.mutate,
    updateProduct: updateMutation.mutate,
    deleteProduct: deleteMutation.mutate,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  }
}

// Hook para produtos por categoria
export function useProductsByCategory(category?: string) {
  const { products, isLoading, error } = useProducts()

  const filteredProducts = category 
    ? products.filter(product => product.category === category)
    : products

  return {
    products: filteredProducts,
    isLoading,
    error,
  }
}

// Hook para categorias únicas
export function useProductCategories() {
  const { products } = useProducts()

  const categories = [...new Set(products.map(product => product.category))].sort()

  return categories
}
