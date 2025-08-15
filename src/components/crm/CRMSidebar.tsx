import { BarChart3, Target, Users, Calendar, MessageCircle, Settings, Package, CheckSquare, MessageSquare, Instagram, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/components/auth/AuthProvider"

interface CRMSidebarProps {
  selectedView: string
  onViewChange: (view: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

export function CRMSidebar({ selectedView, onViewChange, collapsed }: CRMSidebarProps) {
  const { role, user } = useAuth()
  const menuItems = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3 },
    { id: "pipeline", label: "Pipeline", icon: Target },
    { id: "contacts", label: "Contatos", icon: Users },
    { id: "deals", label: "Propostas", icon: FileText },
    // Products: somente manager/admin
    ...(role === 'admin' || role === 'manager' ? [{ id: 'products', label: 'Produtos', icon: Package }] as const : []),
    { id: "activities", label: "Atividades", icon: CheckSquare },
    { id: "tasks", label: "Tarefas", icon: Calendar },
    { id: "whatsapp", label: "WhatsApp", icon: MessageSquare },
    { id: "instagram", label: "Instagram", icon: Instagram },
    { id: "messenger", label: "Messenger", icon: MessageCircle },
    // Employees: admin e manager (alinha com permissões do backend)
    ...(role === 'admin' || role === 'manager' ? [{ id: 'employees', label: 'Funcionários', icon: Users }] as const : []),
  ]

  return (
    <div className={`${collapsed ? 'w-16' : 'w-64'} bg-card border-r border-border flex flex-col transition-all duration-300 shadow-card`}>
      {/* Logo */}
      <div className="p-4 border-b border-border bg-gradient-primary">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-background rounded-lg flex items-center justify-center shadow-lg">
            <span className="text-primary font-bold text-sm">R</span>
          </div>
          {!collapsed && (
            <span className="text-lg font-semibold text-primary-foreground">Rmidia CRM</span>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        <TooltipProvider>
          <div className="space-y-1">
            {menuItems.map((item) => {
              const Btn = (
                <Button
                  key={item.id}
                  variant={selectedView === item.id ? "secondary" : "ghost"}
                  className={`w-full justify-start transition-all duration-200 ${
                    selectedView === item.id 
                      ? "bg-primary/10 text-primary shadow-primary/20 border-primary/20" 
                      : "text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  }`}
                  onClick={() => onViewChange(item.id)}
                >
                  <item.icon className={`h-4 w-4 ${selectedView === item.id ? "animate-pulse-glow" : ""}`} />
                  {!collapsed && (
                    <span className="ml-2">{item.label}</span>
                  )}
                </Button>
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

        <Separator className="bg-border mt-2" />
        
        <div className="space-y-1 mt-2">
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:bg-primary/5 hover:text-primary transition-all duration-200"
          >
            <Settings className="h-4 w-4" />
            {!collapsed && <span className="ml-2">Configurações</span>}
          </Button>
        </div>
      </nav>

      {/* User Profile */}
      <div className="p-4 border-t border-border bg-gradient-card">
        <div className="flex items-center space-x-3">
          <Avatar className="h-8 w-8 border-2 border-primary/20">
            <AvatarImage src="/placeholder.svg" />
            <AvatarFallback className="bg-primary text-primary-foreground">{(user?.user_metadata?.full_name || user?.email || 'U').charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{user?.user_metadata?.full_name || 'Usuário'}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email || ''}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}