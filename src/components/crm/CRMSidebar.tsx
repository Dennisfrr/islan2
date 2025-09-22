import { BarChart3, Target, Users, Calendar, Settings, Package, CheckSquare, MessageSquare, FileText, Bot, Send, LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/components/auth/AuthProvider"
import { Badge } from "@/components/ui/badge"
import { useNavigate } from "react-router-dom"
import React from "react"

interface CRMSidebarProps {
  selectedView: string
  onViewChange: (view: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function CRMSidebar({ selectedView, onViewChange, collapsed, onToggleCollapse }: CRMSidebarProps) {
  const { role, user, signOut } = useAuth()
  const navigate = useNavigate()
  const menuItems = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3 },
    { id: "followups", label: "Follow-ups", icon: Send },
    { id: "pipeline", label: "Pipeline", icon: Target },
    { id: "contacts", label: "Contatos", icon: Users },
    { id: "deals", label: "Propostas", icon: FileText },
    // Produtos removido
    { id: "activities", label: "Atividades", icon: CheckSquare },
    { id: "tasks", label: "Tarefas", icon: Calendar },
    { id: "goals", label: "Metas", icon: Target },
    { id: "strategies", label: "Estratégias", icon: BarChart3 },
    { id: "settings", label: "Configurações", icon: Settings },
    // Employees: admin e manager (alinha com permissões do backend)
    ...(role === 'admin' || role === 'manager' ? [{ id: 'employees', label: 'Funcionários', icon: Users }] as const : []),
  ]

  const indicatorRef = React.useRef<HTMLSpanElement | null>(null)

  return (
    <div
      className={`${collapsed ? 'w-16' : 'w-72'} sidebar-glass text-sidebar-foreground flex flex-col transition-all duration-300 shadow-none`}
    >
      {/* Logo */}
      <div className="p-4 border-b border-sidebar-border bg-sidebar/95">
        <div className="flex items-center justify-between space-x-3">
          {collapsed ? (
            <span className="px-2 py-0.5 rounded-sm bg-sidebar-foreground text-sidebar-primary-foreground text-sm font-extrabold tracking-wide">CRM</span>
          ) : (
            <div className="flex items-center min-w-0">
              <span className="h-10 w-10 rounded-full brand-dot mr-3" />
              <div className="min-w-0">
                <div className="text-[16px] font-semibold text-sidebar-foreground truncate">Comic Apps</div>
                <div className="text-[12px] text-sidebar-foreground/60 truncate">CRM</div>
              </div>
            </div>
          )}
          <Button size="icon" variant="ghost" className="h-8 w-8 hover:bg-sidebar-accent text-sidebar-foreground" onClick={onToggleCollapse}>
            {collapsed ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M9.47 5.97a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 0 1-1.06-1.06L13.94 12 9.47 7.53a.75.75 0 0 1 0-1.06Z"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M14.53 18.03a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 0-1.06l4.5-4.5a.75.75 0 1 1 1.06 1.06L10.06 12l4.47 4.47a.75.75 0 0 1 0 1.06Z"/></svg>
            )}
          </Button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="relative flex-1 p-4 space-y-2">
        <span ref={indicatorRef} className="sidebar-indicator" />
        <TooltipProvider>
          <div className="space-y-2">
            {menuItems.map((item) => {
              const Btn = (
                <div key={item.id} className="relative">
                  <Button
                    variant="ghost"
                    className={`sidebar-item sidebar-pill w-full h-11 justify-start pl-4 text-[14px] ${
                      selectedView === item.id 
                        ? "sidebar-pill-active" 
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    }`}
                    onClick={() => {
                      if (item.id === 'goals') { onViewChange('goals'); }
                      else if (item.id === 'strategies') { navigate('/strategies'); }
                      else if (item.id === 'followups') { navigate('/followups'); }
                      else { onViewChange(item.id) }
                    }}
                    onMouseEnter={(e) => {
                      if (collapsed) return
                      const host = (e.currentTarget.parentElement?.parentElement?.parentElement as HTMLElement) || null
                      const indicator = indicatorRef.current
                      if (!host || !indicator) return
                      const btnRect = e.currentTarget.getBoundingClientRect()
                      const hostRect = host.getBoundingClientRect()
                      const top = btnRect.top - hostRect.top + (e.currentTarget.offsetHeight/2 - 14)
                      indicator.style.top = `${top}px`
                      indicator.style.height = `28px`
                      indicator.style.opacity = '1'
                    }}
                    onMouseLeave={() => {
                      const indicator = indicatorRef.current
                      if (!indicator) return
                      indicator.style.opacity = '0'
                    }}
                  >
                    <item.icon className="h-5 w-5" />
                    {!collapsed && (
                      <span className="ml-2">{item.label}</span>
                    )}
                  </Button>
                </div>
              )

              return collapsed ? (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{Btn}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              ) : (
                Btn
              )
            })}
          </div>
        </TooltipProvider>

        {/* Configurações removida */}
      </nav>

      {/* User Profile */}
      <div className="p-4 bg-sidebar-accent/80 backdrop-blur-md shadow-[0_-10px_30px_-20px_hsl(var(--sidebar-foreground)/0.24)]">
        <div className="flex items-center justify-between gap-3">
          <Avatar className="h-8 w-8 border-2 border-sidebar-border">
            <AvatarImage src="/placeholder.svg" />
            <AvatarFallback className="bg-sidebar-accent text-sidebar-foreground">{(user?.user_metadata?.full_name || user?.email || 'U').charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.user_metadata?.full_name || 'Usuário'}</p>
              <p className="text-xs text-sidebar-foreground/60 truncate">{user?.email || ''}</p>
            </div>
          )}
          {!collapsed && (
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="outline" className="uppercase text-[10px] tracking-wide">
                {role || '—'}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-destructive hover:bg-destructive/10"
                onClick={async () => { try { await signOut?.() } catch {} }}
                title="Sair"
              >
                <LogOut className="h-3.5 w-3.5 mr-1" />
                Sair
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}