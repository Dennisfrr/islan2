import React, { useEffect, useRef, useState } from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch } from '@/lib/api'

type Message = { role: 'user' | 'assistant'; content: string }

export default function AgentChat({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast()
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  async function send() {
    const t = text.trim()
    if (!t) return
    setMessages(prev => [...prev, { role: 'user', content: t }])
    setText('')
    try {
      const r = await apiFetch('/api/agent/crm-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: t }) })
      const js = await r.json().catch(() => ({} as any))
      const reply = String(js?.reply || 'Ok.')
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e: any) {
      toast({ title: 'Falha ao enviar', description: String(e?.message || e), variant: 'destructive' })
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md bg-secondary/80 backdrop-blur-md border-none p-0 flex flex-col">
        <div className="p-4 border-b border-border/20">
          <div className="text-sm text-muted-foreground">Agente CRM</div>
          <div className="text-lg font-semibold">Como posso ajudar?</div>
        </div>
        <div ref={listRef} className="flex-1 overflow-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`max-w-[85%] rounded-xl px-3 py-2 ${m.role==='user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-card/60 backdrop-blur-sm border border-border/30'}`}>
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-sm text-muted-foreground">Diga algo como: "Resuma meus leads da semana" ou "Crie uma meta de conversão".</div>
          )}
        </div>
        <div className="p-3 border-t border-border/20 flex items-center gap-2">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Digite sua mensagem" onKeyDown={(e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <Button onClick={send}>Enviar</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}


