import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/auth/AuthProvider'
import { useOrg } from '@/components/org/OrgProvider'
import { apiFetch } from '@/lib/api'

export interface Communication {
  id: string
  lead_id: string
  user_id: string
  type: 'email' | 'whatsapp' | 'sms' | 'call'
  direction: 'inbound' | 'outbound'
  subject: string | null
  content: string | null
  status: 'sent' | 'delivered' | 'read' | 'failed'
  external_id: string | null
  created_at: string
  organization_id?: string
}

async function fetchCommunications(
  leadId: string,
  type: Communication['type'] | undefined = 'whatsapp',
  orgId?: string
): Promise<Communication[]> {
  if (!leadId) return []
  let q = supabase
    .from('communications')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true })
  if (type) q = q.eq('type', type)
  if (orgId) q = q.eq('organization_id', orgId)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

export function useCommunications(leadId?: string, type: Communication['type'] | undefined = 'whatsapp') {
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const { orgId } = useOrg()

  const { data: communications = [], isLoading, error, refetch } = useQuery({
    queryKey: ['communications', leadId, type, orgId],
    queryFn: () => fetchCommunications(leadId as string, type, orgId || undefined),
    enabled: Boolean(leadId) && Boolean(orgId),
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!leadId) return
    const channel = supabase.channel(`realtime:communications:${leadId}:${type || 'all'}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'communications',
        filter: [
          `lead_id=eq.${leadId}`,
          ...(type ? [`type=eq.${type}`] : []),
        ].join(','),
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['communications', leadId, type] })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [leadId, type, queryClient])

  const sendMutation = useMutation({
    mutationFn: async ({ leadId, body }: { leadId: string; body: string }) => {
      const endpoint = '/api/messages/whatsapp'
      const r = await apiFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ leadId, body }),
      })
      if (!r.ok) {
        const txt = await r.text()
        throw new Error(txt || 'Falha ao enviar mensagem')
      }
      return r.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communications', leadId, type] })
    },
  })

  return {
    communications,
    isLoading,
    error,
    refetch,
    sendMessage: sendMutation.mutate,
    isSending: sendMutation.isPending,
  }
} 