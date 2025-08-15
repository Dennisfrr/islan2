import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useEmployees } from '@/hooks/useEmployees'
import { useAuth } from '@/components/auth/AuthProvider'
import { Loader2, Plus, Edit, Trash2, Search } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'

export function EmployeesView() {
  const { role, user } = useAuth()
  const { employees, isLoading, error, createEmployee, updateEmployee, deleteEmployee, isCreating, isUpdating, isDeleting } = useEmployees()
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'manager' | 'sales'>('all')
  const [sortBy, setSortBy] = useState<'name' | 'role' | 'created'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const STORAGE_KEY = 'employees.filters.v1'

  // Carregar filtros do localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed.search === 'string') setSearch(parsed.search)
        if (parsed.roleFilter === 'all' || parsed.roleFilter === 'admin' || parsed.roleFilter === 'manager' || parsed.roleFilter === 'sales') setRoleFilter(parsed.roleFilter)
      }
    } catch {}
  }, [])

  // Persistir filtros
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ search, roleFilter }))
    } catch {}
  }, [search, roleFilter])

  // Debounce da busca
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const filteredEmployees = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    const base = employees.filter(emp => {
      const matchesQuery = !q || emp.full_name.toLowerCase().includes(q) || (emp.email || '').toLowerCase().includes(q)
      const matchesRole = roleFilter === 'all' || emp.role === roleFilter
      return matchesQuery && matchesRole
    })
    const sorted = [...base].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'name') cmp = a.full_name.localeCompare(b.full_name)
      else if (sortBy === 'role') cmp = a.role.localeCompare(b.role)
      else if (sortBy === 'created') cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [employees, debouncedSearch, roleFilter, sortBy, sortDir])

  // Reset de página quando filtros mudam
  useEffect(() => { setPage(1) }, [search, roleFilter])

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize
  const paginatedEmployees = filteredEmployees.slice(start, start + pageSize)

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Funcionários</h2>
          <p className="text-muted-foreground">Gerencie usuários do CRM e suas permissões</p>
        </div>
        {role === 'admin' && (
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" /> Novo funcionário</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo funcionário</DialogTitle>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              createEmployee({
                email: String(fd.get('email') || ''),
                full_name: String(fd.get('full_name') || ''),
                role: (String(fd.get('role') || 'sales') as any),
                phone: String(fd.get('phone') || ''),
                sendInvite: fd.get('sendInvite') === 'on',
                password: String(fd.get('password') || ''),
              }, { onSuccess: () => setIsCreateOpen(false) })
            }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>Nome</Label>
                  <Input name="full_name" required />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input name="email" type="email" required />
                </div>
                <div>
                  <Label>Telefone</Label>
                  <Input name="phone" />
                </div>
                <div>
                  <Label>Perfil</Label>
                  <Select name="role" defaultValue="sales">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="sales">Sales</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2 flex items-center gap-2 pt-1">
                  <Checkbox id="sendInvite" name="sendInvite" defaultChecked />
                  <Label htmlFor="sendInvite">Enviar convite por email (desmarque para definir uma senha agora)</Label>
                </div>
                <div className="md:col-span-2">
                  <Label>Senha (opcional; usada se convite estiver desmarcado)</Label>
                  <Input name="password" type="password" placeholder="Defina uma senha inicial" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={isCreating}>{isCreating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Salvar</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        )}
      </div>

      {error && (
        <Card className="mb-4 border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">Erro ao carregar funcionários ou acesso negado: {String((error as any)?.message || '')}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Lista</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-3 md:items-center mb-4">
            <div className="relative md:w-1/2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou email"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="md:w-40">
              <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="Perfil" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="sales">Sales</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:w-40">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
                <SelectTrigger>
                  <SelectValue>Ordenar por</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">Nome</SelectItem>
                  <SelectItem value="role">Perfil</SelectItem>
                  <SelectItem value="created">Criado em</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}>{sortDir === 'asc' ? 'Asc' : 'Desc'}</Button>
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Carregando...</div>
          ) : filteredEmployees.length === 0 ? (
            <div className="text-center text-muted-foreground py-10">Nenhum funcionário encontrado para os filtros.</div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {paginatedEmployees.map(emp => (
                  <div key={emp.id} className="py-3 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{emp.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">{emp.email || 'Sem email'}</div>
                    </div>
                    <div className="w-32 flex items-center">
                      <span className={`text-xs px-2 py-1 rounded-md capitalize ${emp.role === 'admin' ? 'bg-red-500/10 text-red-600' : emp.role === 'manager' ? 'bg-amber-500/10 text-amber-600' : 'bg-blue-500/10 text-blue-600'}`}>{emp.role}</span>
                    </div>
                    <div className="text-xs text-muted-foreground w-32">{emp.phone || '-'}</div>
                    {role === 'admin' && (
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingId(emp.id)}><Edit className="h-3 w-3 mr-1" /> Editar</Button>
                        {emp.id !== user?.id && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => {
                            if (confirm(`Remover ${emp.full_name}?`)) deleteEmployee(emp.id)
                          }}><Trash2 className="h-3 w-3 mr-1" /> Remover</Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
                <div>
                  {filteredEmployees.length > 0 && (
                    <span>
                      {start + 1}–{Math.min(start + pageSize, filteredEmployees.length)} de {filteredEmployees.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Anterior</Button>
                  <span>Pag. {currentPage} / {totalPages}</span>
                  <Button size="sm" variant="outline" disabled={currentPage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Próxima</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {editingId && role === 'admin' && (
        <Dialog open={true} onOpenChange={() => setEditingId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Editar funcionário</DialogTitle>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              updateEmployee({
                id: editingId,
                full_name: String(fd.get('full_name') || ''),
                email: String(fd.get('email') || ''),
                role: (String(fd.get('role') || 'sales') as any),
                phone: String(fd.get('phone') || ''),
              }, { onSuccess: () => setEditingId(null) })
            }}>
              {(() => { const emp = employees.find(e => e.id === editingId); return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>Nome</Label>
                  <Input name="full_name" required defaultValue={emp?.full_name} />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input name="email" type="email" defaultValue={emp?.email || ''} />
                </div>
                <div>
                  <Label>Telefone</Label>
                  <Input name="phone" defaultValue={emp?.phone || ''} />
                </div>
                <div>
                  <Label>Perfil</Label>
                  <Select name="role" defaultValue={(emp?.role as any) || 'sales'}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="sales">Sales</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              )})()}
              <div className="flex justify-end">
                <Button type="submit" disabled={isUpdating}>{isUpdating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Salvar</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
} 