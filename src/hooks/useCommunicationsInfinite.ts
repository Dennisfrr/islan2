import { useEffect } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { Communication } from './useCommunications'

const PAGE_SIZE = 30

type Page = { items: Communication[]; nextCursor: string | null }

async function fetchPage({ leadId, type, pageParam }: { leadId: string; type?: Communication['type']; pageParam?: string | null }): Promise<Page> {
  if (!leadId) return { items: [], nextCursor: null }
  let q = supabase
    .from('communications')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)
  if (type) q = q.eq('type', type)
  if (pageParam) q = q.lt('created_at', pageParam)
  const { data, error } = await q
  if (error) throw error
  const items = (data || []) as Communication[]
  const nextCursor = items.length === PAGE_SIZE ? items[items.length - 1].created_at : null
  return { items, nextCursor }
}

export function useCommunicationsInfinite(leadId?: string, type?: Communication['type']) {
  const queryClient = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: ['communications-infinite', leadId, type],
    queryFn: ({ pageParam }) => fetchPage({ leadId: leadId as string, type, pageParam: (pageParam ?? null) as string | null }),
    enabled: Boolean(leadId),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: Page) => lastPage.nextCursor,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!leadId) return
    const channel = supabase.channel(`realtime:communications-infinite:${leadId}:${type || 'all'}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'communications',
        filter: [
          `lead_id=eq.${leadId}`,
          ...(type ? [`type=eq.${type}`] : []),
        ].join(','),
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['communications-infinite', leadId, type] })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [leadId, type, queryClient])

  const items = (query.data?.pages as Page[] | undefined)?.flatMap(p => p.items).reverse() || []

  return {
    items,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    refetch: query.refetch,
    status: query.status,
    error: query.error,
    isLoading: query.isLoading,
  }
} 