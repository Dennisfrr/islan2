import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, Lead } from '@/lib/supabase'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'

// Funções da API
const fetchLeads = async (orgId?: string): Promise<Lead[]> => {
  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  if (orgId) query = query.eq('organization_id', orgId)

  const { data, error } = await query
  if (error) throw error
  return data || []
}

const createLead = async (newLead: Omit<Lead, 'id' | 'created_at' | 'updated_at' | 'user_id'> & { organization_id?: string }): Promise<Lead> => {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Usuário não autenticado')

  const { data, error } = await supabase
    .from('leads')
    .insert([{ ...newLead, user_id: user.id }])
    .select()
    .single()

  if (error) throw error
  return data
}

const updateLead = async (payload: Partial<Lead> & { id: string }): Promise<Lead> => {
  const { data, error } = await supabase
    .from('leads')
    .update(payload)
    .eq('id', payload.id)
    .select()
    .single()

  if (error) throw error
  return data
}

const deleteLead = async (leadId: string): Promise<void> => {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', leadId)

  if (error) throw error
}

// Hook principal
export function useLeads() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { orgId } = useOrg()

  const {
    data: leads = [],
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['leads', orgId],
    queryFn: () => fetchLeads(orgId || undefined),
    enabled: !!user && !!orgId,
  })

  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      if (!orgId) {
        throw new Error('Organização ainda não carregada. Aguarde alguns segundos e tente novamente.')
      }
      return createLead({ ...payload, organization_id: orgId } as any)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: updateLead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteLead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  return {
    leads,
    isLoading,
    error,
    refetch,
    createLead: createMutation.mutate,
    updateLead: updateMutation.mutate,
    deleteLead: deleteMutation.mutate,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  }
}

// Hook para leads filtrados
export function useFilteredLeads(filters: {
  status?: string
  search?: string
  responsible?: string
}) {
  const { leads, isLoading, error } = useLeads()

  const filteredLeads = leads.filter(lead => {
    if (filters.status && filters.status !== 'all' && lead.status !== filters.status) {
      return false
    }
    
    if (filters.responsible && lead.responsible !== filters.responsible) {
      return false
    }
    
    if (filters.search) {
      const searchLower = filters.search.toLowerCase()
      return (
        lead.name.toLowerCase().includes(searchLower) ||
        lead.company.toLowerCase().includes(searchLower) ||
        (lead.email && lead.email.toLowerCase().includes(searchLower))
      )
    }
    
    return true
  })

  return {
    leads: filteredLeads,
    isLoading,
    error,
  }
}

// Hook para estatísticas
export function useLeadStats() {
  const { leads } = useLeads()

  const stats = {
    total: leads.length,
    totalValue: leads.reduce((sum, lead) => sum + Number(lead.value), 0),
    byStatus: {
      new: leads.filter(l => l.status === 'new').length,
      qualified: leads.filter(l => l.status === 'qualified').length,
      proposal: leads.filter(l => l.status === 'proposal').length,
      negotiation: leads.filter(l => l.status === 'negotiation').length,
      'closed-won': leads.filter(l => l.status === 'closed-won').length,
      'closed-lost': leads.filter(l => l.status === 'closed-lost').length,
    },
    conversionRate: leads.length > 0 
      ? (leads.filter(l => l.status === 'closed-won').length / leads.length) * 100 
      : 0,
  }

  return stats
}
