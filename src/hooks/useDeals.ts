import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, Deal, DealItem, Product } from '@/lib/supabase'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'

// Deals
async function fetchDeals(orgId?: string): Promise<Deal[]> {
  let query = supabase
    .from('deals')
    .select('*')
    .order('created_at', { ascending: false })
  if (orgId) query = query.eq('organization_id', orgId)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

async function createDeal(payload: Omit<Deal, 'id' | 'created_at' | 'updated_at' | 'user_id' | 'total_value'> & { items?: Array<Pick<DealItem, 'product_id' | 'product_name' | 'quantity' | 'unit_price'>> }): Promise<{ deal: Deal; items: DealItem[] }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Usuário não autenticado')

  const { items = [], ...dealBase } = payload
  const { data: deal, error: dErr } = await supabase
    .from('deals')
    .insert([{ ...dealBase, total_value: 0, user_id: user.id }])
    .select()
    .single()
  if (dErr) throw dErr

  let createdItems: DealItem[] = []
  if (items.length) {
    const toInsert = items.map((it) => ({
      deal_id: deal.id,
      product_id: it.product_id ?? null,
      product_name: it.product_name,
      quantity: it.quantity,
      unit_price: it.unit_price,
      total_price: it.quantity * it.unit_price,
    }))
    const { data: ins, error: iErr } = await supabase
      .from('deal_items')
      .insert(toInsert)
      .select('*')
    if (iErr) throw iErr
    createdItems = ins || []
  }

  // recalcular total
  const total = createdItems.reduce((s, it) => s + Number(it.total_price), 0)
  const { data: updated, error: uErr } = await supabase
    .from('deals')
    .update({ total_value: total })
    .eq('id', deal.id)
    .select()
    .single()
  if (uErr) throw uErr

  return { deal: updated!, items: createdItems }
}

async function updateDeal(payload: Partial<Deal> & { id: string }): Promise<Deal> {
  const { data, error } = await supabase
    .from('deals')
    .update(payload)
    .eq('id', payload.id)
    .select()
    .single()
  if (error) throw error
  // Regra: ao aceitar/recusar, atualizar status do lead (se houver)
  try {
    if ((payload.status === 'accepted' || payload.status === 'rejected') && data?.lead_id) {
      const nextLeadStatus = payload.status === 'accepted' ? 'closed-won' : 'closed-lost'
      await supabase
        .from('leads')
        .update({ status: nextLeadStatus })
        .eq('id', data.lead_id)
    }
  } catch {
    // noop
  }
  return data
}

async function deleteDeal(id: string): Promise<void> {
  const { error } = await supabase.from('deals').delete().eq('id', id)
  if (error) throw error
}

// Deal Items
async function fetchDealItems(dealId: string): Promise<DealItem[]> {
  const { data, error } = await supabase
    .from('deal_items')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

async function addDealItem(dealId: string, item: { product_id?: string | null; product_name: string; quantity: number; unit_price: number }): Promise<{ deal: Deal; item: DealItem }> {
  const insertPayload = {
    deal_id: dealId,
    product_id: item.product_id ?? null,
    product_name: item.product_name,
    quantity: item.quantity,
    unit_price: item.unit_price,
    total_price: item.quantity * item.unit_price,
  }
  const { data: created, error: cErr } = await supabase
    .from('deal_items')
    .insert([insertPayload])
    .select()
    .single()
  if (cErr) throw cErr

  // recalc total
  const { data: items } = await supabase
    .from('deal_items')
    .select('total_price')
    .eq('deal_id', dealId)
  const total = (items || []).reduce((s, it: any) => s + Number(it.total_price), 0)
  const { data: updated, error: uErr } = await supabase
    .from('deals')
    .update({ total_value: total })
    .eq('id', dealId)
    .select()
    .single()
  if (uErr) throw uErr

  return { deal: updated!, item: created! }
}

async function updateDealItem(id: string, updates: Partial<DealItem> & { quantity?: number; unit_price?: number; product_name?: string }): Promise<DealItem> {
  const next: any = { ...updates }
  if (typeof updates.quantity === 'number' || typeof updates.unit_price === 'number') {
    // total recalculado pelo próprio update, mas faremos ajuste após
  }
  const { data, error } = await supabase
    .from('deal_items')
    .update({
      ...next,
      ...(typeof updates.quantity === 'number' || typeof updates.unit_price === 'number'
        ? { total_price: Number(updates.quantity ?? 0) * Number(updates.unit_price ?? 0) }
        : {}),
    })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

async function removeDealItem(dealId: string, id: string): Promise<Deal> {
  const { error } = await supabase.from('deal_items').delete().eq('id', id)
  if (error) throw error
  const { data: items } = await supabase
    .from('deal_items')
    .select('total_price')
    .eq('deal_id', dealId)
  const total = (items || []).reduce((s, it: any) => s + Number(it.total_price), 0)
  const { data: updated, error: uErr } = await supabase
    .from('deals')
    .update({ total_value: total })
    .eq('id', dealId)
    .select()
    .single()
  if (uErr) throw uErr
  return updated!
}

export function useDeals() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { orgId } = useOrg()

  const list = useQuery({
    queryKey: ['deals', orgId],
    queryFn: () => fetchDeals(orgId || undefined),
    enabled: !!user && !!orgId,
  })

  const create = useMutation({
    mutationFn: (p: any) => createDeal({ ...p, organization_id: orgId || undefined } as any),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] })
  })

  const update = useMutation({
    mutationFn: updateDeal,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] })
  })

  const remove = useMutation({
    mutationFn: deleteDeal,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] })
  })

  return {
    deals: list.data || [],
    isLoading: list.isLoading,
    error: list.error as any,
    refetch: list.refetch,
    createDeal: create.mutate,
    updateDeal: update.mutate,
    deleteDeal: remove.mutate,
    isCreating: create.isPending,
    isUpdating: update.isPending,
    isDeleting: remove.isPending,
    copyPublicLink: (dealId: string) => {
      const url = `${window.location.origin}/preview/deal/${dealId}`
      navigator.clipboard?.writeText(url)
      return url
    }
  }
}

export function useDealItems(dealId?: string) {
  const qc = useQueryClient()
  const { user } = useAuth()

  const list = useQuery({
    queryKey: ['deal_items', dealId],
    queryFn: () => fetchDealItems(dealId as string),
    enabled: !!user && !!dealId,
  })

  const add = useMutation({
    mutationFn: ({ product_id, product_name, quantity, unit_price }: { product_id?: string | null; product_name: string; quantity: number; unit_price: number }) =>
      addDealItem(dealId as string, { product_id: product_id ?? null, product_name, quantity, unit_price }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deal_items', dealId] })
      qc.invalidateQueries({ queryKey: ['deals'] })
    }
  })

  const update = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<DealItem> }) => updateDealItem(id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deal_items', dealId] })
      qc.invalidateQueries({ queryKey: ['deals'] })
    }
  })

  const remove = useMutation({
    mutationFn: (id: string) => removeDealItem(dealId as string, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deal_items', dealId] })
      qc.invalidateQueries({ queryKey: ['deals'] })
    }
  })

  return {
    items: list.data || [],
    isLoading: list.isLoading,
    error: list.error as any,
    refetch: list.refetch,
    addItem: add.mutate,
    updateItem: update.mutate,
    removeItem: remove.mutate,
    isAdding: add.isPending,
    isUpdating: update.isPending,
    isRemoving: remove.isPending,
  }
}


