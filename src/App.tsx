import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { OrgProvider } from "@/components/org/OrgProvider";
import KommoCRM from "./pages/KommoCRM";
import { DealPreview } from "./pages/DealPreview";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import ResetPassword from "./pages/ResetPassword";
import AgentPage from "./pages/Agent";
import GoalsPage from "./pages/Goals";
import FollowupsPage from "./pages/Followups";
// import StrategiesPage from "./pages/Strategies";
import StarfieldBackground from "@/components/background/Starfield";
import GoalCoach from "@/components/goals/GoalCoach";
import AgentChat from "@/components/crm/AgentChat";

const queryClient = new QueryClient();

// Componente para rotas protegidas
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-dark flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <OrgProvider>
                <KommoCRM />
              </OrgProvider>
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/agent" 
          element={
            <ProtectedRoute>
              <OrgProvider>
                <AgentPage />
              </OrgProvider>
            </ProtectedRoute>
          }
        />
        <Route 
          path="/goals" 
          element={
            <ProtectedRoute>
              <OrgProvider>
                <GoalsPage />
              </OrgProvider>
            </ProtectedRoute>
          }
        />
        <Route 
          path="/followups" 
          element={
            <ProtectedRoute>
              <OrgProvider>
                <FollowupsPage />
              </OrgProvider>
            </ProtectedRoute>
          }
        />
        {false && (
          <Route 
            path="/strategies" 
            element={
              <ProtectedRoute>
                <OrgProvider>
                  {/* <StrategiesPage /> */}
                </OrgProvider>
              </ProtectedRoute>
            }
          />
        )}
        <Route path="/preview/deal/:id" element={<DealPreview />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <StarfieldBackground />
        <Toaster />
        <Sonner />
        <GlobalCoachMount />
        <GlobalAgentChatMount />
        <AppRoutes />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;

function GlobalCoachMount() {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <GoalCoach open={open} onOpenChange={setOpen} />
}

function GlobalAgentChatMount() {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <AgentChat open={open} onOpenChange={setOpen} />
}
