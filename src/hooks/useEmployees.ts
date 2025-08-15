import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/auth/AuthProvider'
import { apiFetch } from '@/lib/api'

export interface Employee {
  id: string
  email: string | null
  full_name: string
  role: 'admin' | 'manager' | 'sales'
  phone?: string
  created_at: string
  updated_at: string
}

export function useEmployees() {
  const qc = useQueryClient()
  const { session } = useAuth()

  const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}

  const list = useQuery({
    queryKey: ['employees'],
    queryFn: async (): Promise<Employee[]> => {
      const authHeader = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
      const r = await apiFetch('/api/employees', { headers: authHeader })
      if (!r.ok) throw new Error(await r.text())
      const json = await r.json()
      return json.employees || []
    },
    enabled: !!session?.access_token,
  })

  const create = useMutation({
    mutationFn: async (payload: { email: string; full_name: string; role?: Employee['role']; phone?: string; password?: string; sendInvite?: boolean }) => {
      const authHeader = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
      const r = await apiFetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload)
      })
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] })
  })

  const update = useMutation({
    mutationFn: async ({ id, ...payload }: { id: string; full_name?: string; role?: Employee['role']; phone?: string; email?: string }) => {
      const authHeader = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
      const r = await apiFetch(`/api/employees/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(payload)
      })
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] })
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const authHeader = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
      const r = await apiFetch(`/api/employees/${id}`, { method: 'DELETE', headers: authHeader })
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] })
  })

  return {
    employees: list.data || [],
    isLoading: list.isLoading,
    error: list.error as any,
    refetch: list.refetch,
    createEmployee: create.mutate,
    updateEmployee: update.mutate,
    deleteEmployee: remove.mutate,
    isCreating: create.isPending,
    isUpdating: update.isPending,
    isDeleting: remove.isPending,
  }
} 