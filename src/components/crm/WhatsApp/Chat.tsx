import { useEffect, useRef, useState } from 'react'
import { Lead } from '@/lib/supabase'
import { Communication } from '@/hooks/useCommunications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Phone, Send, Loader2, Check, CheckCheck } from 'lucide-react'

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
    <div className="flex flex-col h-[70vh]">
      {/* Header */}
      <div className="h-16 border-b border-border px-4 py-2 flex items-center gap-3 bg-card/80 backdrop-blur">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="text-primary text-xs font-bold">{lead ? lead.name.charAt(0).toUpperCase() : 'W'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{lead ? `${lead.name} — ${lead.company}` : 'Selecione um contato'}</div>
          <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
            <Phone className="h-3 w-3" /> {lead?.phone || ''}
          </div>
          {lead && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {/* status do lead */}
              <Badge variant="secondary" className="text-[10px] uppercase">
                {lead.status}
              </Badge>
              {/* valor */}
              <Badge variant="outline" className="text-[10px]">
                R$ {Number(lead.value || 0).toLocaleString('pt-BR')}
              </Badge>
              {/* tags (limite 3) */}
              {(Array.isArray(lead.tags) ? lead.tags.slice(0, 3) : []).map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
              ))}
              {Array.isArray(lead.tags) && lead.tags.length > 3 && (
                <Badge variant="secondary" className="text-[10px]">+{lead.tags.length - 3}</Badge>
              )}
            </div>
          )}
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
              <div className={`mt-1 text-[10px] flex items-center gap-1 ${m.direction === 'outbound' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                <span>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                {m.direction === 'outbound' && (
                  <span className="ml-1 flex items-center gap-0.5">
                    {m.status === 'sent' && <Check className="h-3 w-3" />}
                    {m.status === 'delivered' && <CheckCheck className="h-3 w-3" />}
                    {m.status === 'read' && <CheckCheck className="h-3 w-3 text-emerald-300" />}
                    {m.status === 'failed' && (
                      <Badge variant="destructive" className="text-[9px]">falhou</Badge>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="h-16 border-t border-border px-3 flex items-center gap-2 bg-card">
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
        <Button size="sm" onClick={handleSend} disabled={!lead || isSending || !text.trim()} className="h-10 px-3">
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
} 