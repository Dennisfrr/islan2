import { useEffect, useRef, useState } from 'react'
import { Lead } from '@/lib/supabase'
import { Communication } from '@/hooks/useCommunications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Phone, Send, Loader2 } from 'lucide-react'

interface WhatsAppChatProps {
  lead?: Lead
  messages: Communication[]
  onSend: (text: string) => void
  isSending?: boolean
  onLoadMore?: () => void
  hasMore?: boolean
  isLoadingMore?: boolean
}

export function WhatsAppChat({ lead, messages, onSend, isSending, onLoadMore, hasMore, isLoadingMore }: WhatsAppChatProps) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Scroll para o fim apenas quando novas mensagens chegam
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSend = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="flex-1 flex flex-col h-[70vh]">
      {/* Header */}
      <div className="h-14 border-b border-border px-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="text-primary text-xs font-bold">{lead ? lead.name.charAt(0) : 'W'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{lead ? `${lead.name} — ${lead.company}` : 'Selecione um contato'}</div>
          <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
            <Phone className="h-3 w-3" /> {lead?.phone || ''}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-auto p-4 space-y-2 bg-muted/30">
        {onLoadMore && hasMore && (
          <div className="w-full flex justify-center mb-2">
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
              {isLoadingMore ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Carregar mais
            </Button>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`w-full flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow ${m.direction === 'outbound' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card border border-border rounded-bl-sm'}`}>
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
              <div className={`mt-1 text-[10px] ${m.direction === 'outbound' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="h-14 border-t border-border px-3 flex items-center gap-2 bg-card">
        <Input
          placeholder={lead ? 'Escreva uma mensagem...' : 'Selecione um contato para começar'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!lead || isSending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <Button onClick={handleSend} disabled={!lead || isSending || !text.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
} 