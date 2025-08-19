import { useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLeads } from '@/hooks/useLeads'
import { useCommunications } from '@/hooks/useCommunications'
import { useCommunicationsInfinite } from '@/hooks/useCommunicationsInfinite'
import { WhatsAppChat } from '@/components/crm/WhatsApp/Chat'

interface QuickChatProps {
  leadId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function QuickChat({ leadId, open, onOpenChange }: QuickChatProps) {
  const { leads } = useLeads()
  const lead = useMemo(() => leads.find(l => l.id === leadId), [leads, leadId])
  const { communications, sendMessage, isSending } = useCommunications(leadId, 'whatsapp')
  const infinite = useCommunicationsInfinite(leadId, 'whatsapp')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle>
            WhatsApp — {lead?.name || 'Contato'} {lead?.phone ? `(${lead.phone})` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="h-[70vh]">
          <WhatsAppChat
            lead={lead as any}
            messages={infinite.items.length ? infinite.items : communications}
            onSend={(text) => leadId && sendMessage({ leadId, body: text })}
            isSending={isSending}
            onLoadMore={() => { if (infinite.hasNextPage) infinite.fetchNextPage() }}
            hasMore={Boolean(infinite.hasNextPage)}
            isLoadingMore={infinite.isFetchingNextPage}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}


