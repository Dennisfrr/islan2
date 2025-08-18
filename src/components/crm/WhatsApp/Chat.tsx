import { useEffect, useRef, useState } from 'react'
import { Lead } from '@/lib/supabase'
import { Communication } from '@/hooks/useCommunications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Phone, Send, Loader2, Check, CheckCheck, Smile, Paperclip, Mic } from 'lucide-react'

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
		endRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages.length])

	const handleSend = () => {
		const t = text.trim()
		if (!t) return
		onSend(t)
		setText('')
	}

	// Agrupa mensagens por dia (rótulos estilo WhatsApp)
	const groups = messages.reduce<Record<string, Communication[]>>((acc, m) => {
		const d = new Date(m.created_at)
		const label = d.toLocaleDateString()
		acc[label] = acc[label] || []
		acc[label].push(m)
		return acc
	}, {})
	const orderedGroups = Object.entries(groups).sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())

	return (
		<div className="flex flex-col h-[70vh]">
			{/* Header estilo WhatsApp */}
			<div className="h-14 border-b border-border px-4 py-2 flex items-center gap-3 bg-[#128C7E] text-white dark:bg-[#202C33] dark:text-[#E9EDEF]">
				<div className="w-9 h-9 rounded-full bg-white/20 dark:bg-white/10 flex items-center justify-center">
					<span className="text-white text-xs font-bold">{lead ? lead.name.charAt(0).toUpperCase() : 'W'}</span>
				</div>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-semibold truncate">{lead ? `${lead.name}` : 'Selecione um contato'}</div>
					<div className="text-[11px] text-white/80 dark:text-[#8696A0] truncate flex items-center gap-1">
						<Phone className="h-3 w-3" /> {lead?.phone || ''}
					</div>
					{lead && (
						<div className="mt-1 flex items-center gap-1">
							<Badge variant="secondary" className="text-[10px] uppercase bg-white/15 text-white border-white/20">{lead.status}</Badge>
						</div>
					)}
				</div>
			</div>

			{/* Messages (fundo semelhante ao WhatsApp) */}
			<div
				ref={containerRef}
				className="flex-1 overflow-auto p-4 space-y-2 bg-[#E5DDD5] dark:bg-[#0B141A]"
				style={{
					backgroundImage:
						'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)',
					backgroundPosition: '0 0, 25px 25px',
					backgroundSize: '50px 50px',
				}}
			>
				{onLoadMore && hasMore && (
					<div className="w-full flex justify-center mb-2">
						<Button variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
							{isLoadingMore ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
							Carregar mais
						</Button>
					</div>
				)}
				{orderedGroups.map(([label, items]) => (
					<div key={label}>
						{/* Separador de data */}
						<div className="w-full flex justify-center my-2">
							<span className="text-[11px] px-3 py-1 rounded-full bg-black/10 text-black/70 dark:bg-white/10 dark:text-white/70">
								{label}
							</span>
						</div>
						{items.map((m) => (
							<div key={m.id} className={`w-full flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
								<div className={`max-w-[80%] px-3 py-2 text-[13px] shadow ${m.direction === 'outbound' ? 'bg-[#DCF8C6] dark:bg-[#005C4B] text-[#111] dark:text-[#E9EDEF] rounded-2xl rounded-br-sm' : 'bg-white dark:bg-[#202C33] text-[#111] dark:text-[#E9EDEF] rounded-2xl rounded-bl-sm'}`}>
									<div className="whitespace-pre-wrap break-words leading-relaxed">{m.content}</div>
									<div className={`mt-1 text-[10px] flex items-center gap-1 justify-end text-[#667781] dark:text-[#8696A0]`}>
										<span>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
										{m.direction === 'outbound' && (
											<span className="ml-1 flex items-center gap-0.5">
												{m.status === 'sent' && <Check className="h-3 w-3 text-[#667781] dark:text-[#8696A0]" />}
												{m.status === 'delivered' && <CheckCheck className="h-3 w-3 text-[#667781] dark:text-[#8696A0]" />}
												{m.status === 'read' && <CheckCheck className="h-3 w-3 text-[#34B7F1]" />}
												{m.status === 'failed' && (
													<Badge variant="destructive" className="text-[9px]">falhou</Badge>
												)}
											</span>
										)}
									</div>
								</div>
							</div>
						))}
					</div>
				))}
				<div ref={endRef} />
			</div>

			{/* Composer */}
			<div className="h-16 border-t border-border px-3 flex items-center gap-2 bg-[#F0F2F5] dark:bg-[#202C33]">
				<Button variant="ghost" size="icon" className="h-10 w-10 rounded-full text-[#54656F] hover:bg-black/5 dark:text-[#8696A0]">
					<Smile className="h-5 w-5" />
				</Button>
				<Button variant="ghost" size="icon" className="h-10 w-10 rounded-full text-[#54656F] hover:bg-black/5 dark:text-[#8696A0]">
					<Paperclip className="h-5 w-5" />
				</Button>
				<Input
					placeholder={lead ? 'Mensagem' : 'Selecione um contato para começar'}
					value={text}
					onChange={(e) => setText(e.target.value)}
					disabled={!lead || isSending}
					className="rounded-full bg-white dark:bg-[#2A3942] dark:text-[#E9EDEF] placeholder:dark:text-[#8696A0] border-0"
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) return
						if (e.key === 'Enter') {
							e.preventDefault()
							handleSend()
						}
					}}
				/>
				<Button variant="ghost" size="icon" className="h-10 w-10 rounded-full text-[#54656F] hover:bg-black/5 dark:text-[#8696A0]">
					<Mic className="h-5 w-5" />
				</Button>
				<Button size="sm" onClick={handleSend} disabled={!lead || isSending || !text.trim()} className="h-10 px-3 rounded-full bg-[#128C7E] hover:bg-[#0f7b70] dark:bg-[#00A884] hover:dark:bg-[#05977d]">
					{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
				</Button>
			</div>
		</div>
	)
}


