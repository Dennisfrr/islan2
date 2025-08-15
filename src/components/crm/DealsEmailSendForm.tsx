import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/components/auth/AuthProvider'
import { apiFetch } from '@/lib/api'

export function EmailSendForm({ dealId, onDone }: { dealId: string; onDone: () => void }) {
  const { session } = useAuth()
  const [loading, setLoading] = useState(false)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('Proposta')
  const [body, setBody] = useState('Olá, segue a proposta. ')

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!to || !subject || !body) return
    setLoading(true)
    try {
      // Para simplificar: precisamos do leadId. Vamos carregar por fetch simples.
      const rDeal = await apiFetch(`/api/deals/${dealId}`, { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} })
      if (!rDeal.ok) throw new Error('Falha ao localizar proposta')
      const d = await rDeal.json()
      const leadId = d?.deal?.lead_id
      if (!leadId) throw new Error('Proposta sem lead vinculado')

      const r = await apiFetch('/api/messages/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ leadId, subject, body: `${body}\n\nLink da proposta: ${window.location.origin}/preview/deal/${dealId}` })
      })
      if (!r.ok) throw new Error(await r.text())
      onDone()
    } catch {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSend} className="space-y-3">
      <div>
        <Label>Para</Label>
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="email@cliente.com" type="email" required />
      </div>
      <div>
        <Label>Assunto</Label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} required />
      </div>
      <div>
        <Label>Mensagem</Label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={loading}>{loading ? 'Enviando...' : 'Enviar'}</Button>
      </div>
    </form>
  )
}


