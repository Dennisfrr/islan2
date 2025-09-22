import { useEffect, useRef, useState } from 'react'
import { Lead } from '@/lib/supabase'
import { Communication } from '@/hooks/useCommunications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Phone, Send, Loader2, Check, CheckCheck, Smile, Paperclip, Mic, MessageSquarePlus, X, Search, Plus, Trash2, ArrowUp, ArrowDown, Clock } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useToast } from '@/hooks/use-toast'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuickReplies, QuickReply, useWhatsAppMedia } from '@/hooks/useCommunications'

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
	const { list, save } = useQuickReplies()
	const { toast } = useToast()
	const [quickOpen, setQuickOpen] = useState(false)
	const [quickItems, setQuickItems] = useState<QuickReply[]>([])
	const [orgQuickItems, setOrgQuickItems] = useState<QuickReply[]>([])
	const [scope, setScope] = useState<'user' | 'org'>('user')
	const [editing, setEditing] = useState(false)
	const [newTitle, setNewTitle] = useState('')
	const [newContent, setNewContent] = useState('')
	const [filter, setFilter] = useState('')
	const [recent, setRecent] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { sendMedia, isSendingMedia } = useWhatsAppMedia()

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages.length])

	useEffect(() => {
		(async () => {
			try {
				const [userItems, orgItems] = await Promise.all([
					list('user').catch(() => []),
					list('org').catch(() => []),
				])
				setQuickItems(userItems || [])
				setOrgQuickItems(orgItems || [])
			} catch {}
			try {
				const stored = JSON.parse(localStorage.getItem('quick-replies:recent') || '[]')
				if (Array.isArray(stored)) setRecent(stored.slice(0, 8))
			} catch {}
		})()
	}, [])

	useEffect(() => {
		const onGlobalKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k')) {
				e.preventDefault()
				setQuickOpen((v) => !v)
			}
		}
		window.addEventListener('keydown', onGlobalKey)
		return () => window.removeEventListener('keydown', onGlobalKey)
	}, [])

	function rememberRecent(item: string) {
		try {
			const merged = [item, ...recent.filter((r) => r !== item)].slice(0, 8)
			setRecent(merged)
			localStorage.setItem('quick-replies:recent', JSON.stringify(merged))
		} catch {}
	}

	function applyTemplateVariables(input: string): string {
		const name = lead?.name || ''
		const phone = lead?.phone || ''
		return input
			.replace(/\{name\}|\{nome\}/gi, name)
			.replace(/\{phone\}|\{telefone\}/gi, phone)
	}

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
	}, {});
	const orderedGroups = Object.entries(groups).sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="h-14 border-b border-border px-4 py-2 flex items-center gap-3 bg-secondary text-secondary-foreground">
				<div className="w-9 h-9 rounded-full bg-muted text-foreground flex items-center justify-center">
					<span className="text-xs font-bold">{lead ? lead.name.charAt(0).toUpperCase() : 'W'}</span>
				</div>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-semibold truncate">{lead ? `${lead.name}` : 'Selecione um contato'}</div>
					<div className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
						<Phone className="h-3 w-3" /> {lead?.phone || ''}
					</div>
					{lead && (
						<div className="mt-1 flex items-center gap-1">
							<Badge variant="secondary" className="text-[10px] uppercase">{lead.status}</Badge>
						</div>
					)}
				</div>
			</div>

			{/* Messages (fundo semelhante ao WhatsApp) */}
			<div
				ref={containerRef}
				className="flex-1 overflow-auto p-4 space-y-2 bg-background"
				style={{
					backgroundImage:
						'radial-gradient(hsl(0 0% 0% / 0.03) 1px, transparent 1px), radial-gradient(hsl(0 0% 0% / 0.03) 1px, transparent 1px)',
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
							<span className="text-[11px] px-3 py-1 rounded-full bg-muted text-muted-foreground">
								{label}
							</span>
						</div>
						{items.map((m) => (
							<div key={m.id} className={`w-full flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
								<div className={`max-w-[80%] px-3 py-2 text-[13px] shadow ${m.direction === 'outbound' ? 'bg-foreground text-background rounded-2xl rounded-br-sm' : 'bg-muted text-foreground rounded-2xl rounded-bl-sm'}`}>
									<div className="whitespace-pre-wrap break-words leading-relaxed">{m.content}</div>
									<div className={`mt-1 text-[10px] flex items-center gap-1 justify-end text-muted-foreground`}>
										<span>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
										{m.direction === 'outbound' && (
											<span className="ml-1 flex items-center gap-0.5">
												{m.status === 'sent' && <Check className="h-3 w-3" />}
												{m.status === 'delivered' && <CheckCheck className="h-3 w-3" />}
												{m.status === 'read' && <CheckCheck className="h-3 w-3" />}
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
			<div className="h-16 border-t border-border px-3 flex items-center gap-2 bg-secondary">
				<Popover open={quickOpen} onOpenChange={setQuickOpen}>
					<PopoverTrigger asChild>
						<Button title="Mensagens rápidas" variant="ghost" size="icon" className="h-10 w-10 rounded-full">
							<MessageSquarePlus className="h-5 w-5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-[520px] p-0" align="start">
						<div className="p-3 border-b border-border flex items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<div className={`px-2 py-1 rounded text-xs cursor-pointer ${scope === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`} onClick={() => setScope('user')}>Pessoais</div>
								<div className={`px-2 py-1 rounded text-xs cursor-pointer ${scope === 'org' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`} onClick={() => setScope('org')}>Organização</div>
							</div>
							<div className="flex items-center gap-2">
								<Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>{editing ? 'Concluir' : 'Editar'}</Button>
							<Button variant="ghost" size="icon" onClick={() => setQuickOpen(false)}><X className="h-4 w-4" /></Button>
						</div>
						</div>
						<div className="p-3 pt-2">
							<Command shouldFilter={false}>
								<div className="relative">
									<Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
									<CommandInput placeholder="Buscar mensagens..." value={filter} onValueChange={setFilter} className="pl-8" />
								</div>
								<CommandList className="max-h-72 overflow-auto">
									{(recent && recent.length > 0) && !editing && (
										<CommandGroup heading={
											<div className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" /> Recentes</div>
										}>
											{recent.filter(r => !filter || r.toLowerCase().includes(filter.toLowerCase())).map((it, idx) => (
												<CommandItem key={`recent-${idx}`} value={it} onSelect={() => {
													const v = applyTemplateVariables(it)
													setText(prev => (prev ? prev + ' ' : '') + v)
													setQuickOpen(false)
												}}>
													{it}
												</CommandItem>
											))}
										</CommandGroup>
									)}
									<CommandGroup heading={scope === 'user' ? 'Pessoais' : 'Organização'}>
										{(scope === 'user' ? quickItems : orgQuickItems)
											.filter((it: any) => !filter || ((it?.title || '').toLowerCase().includes(filter.toLowerCase()) || (it?.content || String(it)).toLowerCase().includes(filter.toLowerCase())))
											.map((it: any, idx) => (
												<CommandItem key={`${scope}-${idx}`} value={`${it?.title || ''} ${it?.content || String(it)}`} className="items-start"
													onSelect={() => {
														const textVal = String(it?.content || String(it))
														const v = applyTemplateVariables(textVal)
														rememberRecent(textVal)
														setText(prev => (prev ? prev + ' ' : '') + v)
														setQuickOpen(false)
													}}>
													<div className="flex flex-col gap-1">
														<div className="text-sm font-medium">{it?.title || String(it).slice(0, 60)}</div>
														<div className="text-xs text-muted-foreground whitespace-pre-wrap">{String(it?.content || String(it))}</div>
													</div>
												</CommandItem>
											))}
										{(scope === 'user' ? quickItems : orgQuickItems).length === 0 && (
											<CommandEmpty>Nenhuma mensagem encontrada</CommandEmpty>
										)}
									</CommandGroup>
								</CommandList>
							</Command>

							{editing && (
								<div className="mt-3 space-y-2">
									<div className="grid grid-cols-1 gap-2">
										<Input placeholder="Título" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
										<Input placeholder="Conteúdo" value={newContent} onChange={(e) => setNewContent(e.target.value)} />
										<Button size="sm" onClick={async () => {
											const title = newTitle.trim()
											const content = newContent.trim(); if (!content) return
											const item = { title: title || (content.length > 60 ? content.slice(0, 60) : content), content }
											if (scope === 'user') {
												const next = [...quickItems, item]
												setQuickItems(next); setNewTitle(''); setNewContent('')
												try { await save(next, 'user'); toast({ title: 'Salvo', description: 'Mensagem adicionada' }) } catch (e: any) { toast({ title: 'Erro', description: e?.message || 'Falha ao salvar', variant: 'destructive' }) }
											} else {
												const next = [...orgQuickItems, item]
												setOrgQuickItems(next); setNewTitle(''); setNewContent('')
												try { await save(next, 'org'); toast({ title: 'Salvo', description: 'Mensagem adicionada na organização' }) } catch (e: any) { toast({ title: 'Erro', description: e?.message || 'Falha ao salvar', variant: 'destructive' }) }
											}
										}}><Plus className="h-4 w-4" /></Button>
									</div>
									<div className="space-y-2">
										{(scope === 'user' ? quickItems : orgQuickItems).map((it: any, idx) => (
											<div key={`${scope}-edit-${idx}`} className="flex items-center gap-2">
												<div className="flex-1 grid grid-cols-1 gap-1">
													<Input value={it?.title || ''} onChange={(e) => {
														if (scope === 'user') { const next: any[] = [...quickItems]; next[idx] = { ...(next[idx] || {}), title: e.target.value }; setQuickItems(next as any) }
														else { const next: any[] = [...orgQuickItems]; next[idx] = { ...(next[idx] || {}), title: e.target.value }; setOrgQuickItems(next as any) }
													}} />
													<Input value={it?.content || ''} onChange={(e) => {
														if (scope === 'user') { const next: any[] = [...quickItems]; next[idx] = { ...(next[idx] || {}), content: e.target.value }; setQuickItems(next as any) }
														else { const next: any[] = [...orgQuickItems]; next[idx] = { ...(next[idx] || {}), content: e.target.value }; setOrgQuickItems(next as any) }
													}} />
												</div>
												<div className="flex items-center gap-1">
													<Button variant="outline" size="icon" onClick={() => {
														if (idx === 0) return
														if (scope === 'user') { const next = [...quickItems]; const t = next[idx - 1]; next[idx - 1] = next[idx]; next[idx] = t; setQuickItems(next) }
														else { const next = [...orgQuickItems]; const t = next[idx - 1]; next[idx - 1] = next[idx]; next[idx] = t; setOrgQuickItems(next) }
													}}><ArrowUp className="h-4 w-4" /></Button>
													<Button variant="outline" size="icon" onClick={() => {
														const arr = scope === 'user' ? quickItems : orgQuickItems
														if (idx >= arr.length - 1) return
														if (scope === 'user') { const next = [...quickItems]; const t = next[idx + 1]; next[idx + 1] = next[idx]; next[idx] = t; setQuickItems(next) }
														else { const next = [...orgQuickItems]; const t = next[idx + 1]; next[idx + 1] = next[idx]; next[idx] = t; setOrgQuickItems(next) }
													}}><ArrowDown className="h-4 w-4" /></Button>
													<Button variant="destructive" size="icon" onClick={() => {
														if (scope === 'user') { const next = quickItems.filter((_, i) => i !== idx); setQuickItems(next) }
														else { const next = orgQuickItems.filter((_, i) => i !== idx); setOrgQuickItems(next) }
													}}><Trash2 className="h-4 w-4" /></Button>
												</div>
											</div>
										))}
									</div>
									<div className="flex justify-end gap-2 pt-2">
										<Button variant="outline" size="sm" onClick={() => setEditing(false)}>Fechar</Button>
										<Button size="sm" onClick={async () => {
											try {
												if (scope === 'user') { await save(quickItems as any, 'user') } else { await save(orgQuickItems as any, 'org') }
												toast({ title: 'Salvo', description: 'Mensagens rápidas atualizadas' })
												setEditing(false)
											} catch (e: any) {
												toast({ title: 'Erro', description: e?.message || 'Falha ao salvar', variant: 'destructive' })
											}
										}}>Salvar</Button>
									</div>
								</div>
							)}
						</div>
					</PopoverContent>
				</Popover>
				<Button variant="ghost" size="icon" className="h-10 w-10 rounded-full">
					<Smile className="h-5 w-5" />
				</Button>
				<input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={async (e) => {
					try {
						const file = e.target.files?.[0]
						if (!file || !lead?.id) return
						// Preferimos enviar por link se for pequeno e já hospedado, mas aqui converteremos para base64 de forma simples
						const asBase64 = await new Promise<string>((resolve, reject) => {
							const reader = new FileReader()
							reader.onload = () => resolve(String(reader.result || ''))
							reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
							reader.readAsDataURL(file)
						})

						// Mapeia mime para tipo W-API
						const mime = file.type || ''
						let type: 'image' | 'video' | 'audio' | 'document' = 'document'
						if (mime.startsWith('image/')) type = 'image'
						else if (mime.startsWith('video/')) type = 'video'
						else if (mime.startsWith('audio/')) type = 'audio'

						// W-API aceita link ou base64. Passaremos dataURL como url; o backend envia para endpoint adequado
						sendMedia({ leadId: lead.id, media: { type, url: asBase64, filename: file.name, caption: text || undefined } })
						e.currentTarget.value = ''
					} catch {}
				}} />
				<Button title="Anexar arquivo" variant="ghost" size="icon" className="h-10 w-10 rounded-full" onClick={() => fileInputRef.current?.click()} disabled={!lead || isSendingMedia}>
					{isSendingMedia ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
				</Button>
				<Input
					placeholder={lead ? 'Mensagem' : 'Selecione um contato para começar'}
					value={text}
					onChange={(e) => setText(e.target.value)}
					disabled={!lead || isSending}
					className="rounded-full bg-muted text-foreground placeholder:text-muted-foreground border-0"
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) return
						if (e.key === 'Enter') {
							e.preventDefault()
							handleSend()
						}
					}}
				/>
				<Button variant="ghost" size="icon" className="h-10 w-10 rounded-full">
					<Mic className="h-5 w-5" />
				</Button>
				<Button size="sm" onClick={handleSend} disabled={!lead || isSending || !text.trim()} className="h-10 px-3 rounded-full">
					{isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
				</Button>
			</div>
		</div>
	)
}



