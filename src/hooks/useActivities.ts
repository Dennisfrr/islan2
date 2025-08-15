import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, Activity } from '@/lib/supabase'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'

// Funções da API
const fetchActivities = async (leadId?: string, orgId?: string): Promise<Activity[]> => {
  let query = supabase
    .from('activities')
    .select('*')
    .order('created_at', { ascending: false })

  if (leadId) query = query.eq('lead_id', leadId)
  if (orgId) query = query.eq('organization_id', orgId)

  const { data, error } = await query
  if (error) throw error
  return data || []
}

const createActivity = async (newActivity: Omit<Activity, 'id' | 'created_at' | 'updated_at' | 'user_id'> & { organization_id?: string }): Promise<Activity> => {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Usuário não autenticado')

  const { data, error } = await supabase
    .from('activities')
    .insert([{ ...newActivity, user_id: user.id }])
    .select()
    .single()

  if (error) throw error
  return data
}

const updateActivity = async (payload: Partial<Activity> & { id: string }): Promise<Activity> => {
  const { data, error } = await supabase
    .from('activities')
    .update(payload)
    .eq('id', payload.id)
    .select()
    .single()

  if (error) throw error
  return data
}

const deleteActivity = async (activityId: string): Promise<void> => {
  const { error } = await supabase
    .from('activities')
    .delete()
    .eq('id', activityId)

  if (error) throw error
}

// Hook principal
export function useActivities(leadId?: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { orgId } = useOrg()

  const {
    data: activities = [],
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['activities', leadId, orgId],
    queryFn: () => fetchActivities(leadId, orgId || undefined),
    enabled: !!user && !!orgId,
  })

  const createMutation = useMutation({
    mutationFn: (payload: any) => createActivity({ ...payload, organization_id: orgId || undefined } as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities'] })
    },
  })

  const updateMutation = useMutation({
    mutationFn: updateActivity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteActivity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities'] })
    },
  })

  return {
    activities,
    isLoading,
    error,
    refetch,
    createActivity: createMutation.mutate,
    updateActivity: updateMutation.mutate,
    deleteActivity: deleteMutation.mutate,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  }
}

// Hook para atividades pendentes
export function usePendingActivities() {
  const { activities, isLoading, error } = useActivities()

  const pendingActivities = activities.filter(activity => !activity.completed)

  return {
    activities: pendingActivities,
    isLoading,
    error,
  }
}
