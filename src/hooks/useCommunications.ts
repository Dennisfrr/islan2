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

export interface QuickReply {
  title: string
  content: string
}

export interface WhatsAppMedia {
  type: 'image' | 'video' | 'audio' | 'document'
  url: string
  caption?: string | null
  filename?: string | null
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

  const queryKey = ['communications', leadId, type, orgId] as const
  const { data: communications = [], isLoading, error, refetch } = useQuery({
    queryKey,
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
        filter: `lead_id=eq.${leadId}`,
      }, (payload) => {
        const row = (payload as any)?.new || (payload as any)?.old || null
        if (row && type && row.type && row.type !== type) return
        queryClient.invalidateQueries({ queryKey })
        queryClient.invalidateQueries({ queryKey: ['communications-infinite', leadId, type] })
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
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['communications-infinite', leadId, type] })
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

// Quick replies
export function useQuickReplies() {
  const { session } = useAuth()
  const { orgId } = useOrg()
  const queryClient = useQueryClient()

  async function list(scope: 'user' | 'org' = 'user'): Promise<QuickReply[]> {
    const qs = new URLSearchParams()
    if (scope === 'org' && orgId) qs.set('scope', 'org'), qs.set('organization_id', orgId)
    const r = await apiFetch(`/api/whatsapp/quick-replies?${qs.toString()}`, {
      headers: {
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
    })
    if (!r.ok) throw new Error('Falha ao listar mensagens rápidas')
    const js = await r.json()
    const items = Array.isArray(js.items) ? js.items : []
    return items.map((it: any) => {
      if (typeof it === 'string') {
        const t = it.length > 60 ? it.slice(0, 60) : it
        return { title: t, content: it }
      }
      const content = String(it?.content ?? it?.text ?? '')
      const title = String(it?.title || '').trim()
      const finalTitle = title || (content ? (content.length > 60 ? content.slice(0, 60) : content) : '')
      return { title: finalTitle, content }
    }).filter((x: QuickReply) => x && x.content)
  }

  async function save(items: QuickReply[], scope: 'user' | 'org' = 'user'): Promise<void> {
    const payload: any = { scope, items }
    if (scope === 'org' && orgId) payload.organization_id = orgId
    const r = await apiFetch('/api/whatsapp/quick-replies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      const t = await r.text(); throw new Error(t || 'Falha ao salvar mensagens rápidas')
    }
    queryClient.invalidateQueries({ queryKey: ['quick-replies', scope, orgId] })
  }

  return { list, save }
}

export function useWhatsAppMedia() {
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const { orgId } = useOrg()

  const sendMediaMutation = useMutation({
    mutationFn: async ({ leadId, media }: { leadId: string; media: WhatsAppMedia }) => {
      const r = await apiFetch('/api/messages/whatsapp/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ leadId, media }),
      })
      if (!r.ok) {
        const t = await r.text()
        throw new Error(t || 'Falha ao enviar mídia')
      }
      return r.json()
    },
    onSuccess: (_data, variables) => {
      const { leadId } = variables
      queryClient.invalidateQueries({ queryKey: ['communications', leadId, 'whatsapp', orgId] })
      queryClient.invalidateQueries({ queryKey: ['communications-infinite', leadId, 'whatsapp'] })
    },
  })

  return {
    sendMedia: sendMediaMutation.mutate,
    isSendingMedia: sendMediaMutation.isPending,
  }
}