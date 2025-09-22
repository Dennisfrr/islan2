import React, { useState } from 'react'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import ExtractionProfile from '@/components/agent/ExtractionProfile'
import { CRMSidebar } from '@/components/crm/CRMSidebar'

export default function Strategies() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  return (
    <div className="min-h-screen bg-background">
      <div className="h-screen flex">
        <CRMSidebar
          selectedView={'strategies'}
          onViewChange={() => {}}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        />
        <div className="flex-1 p-6 overflow-auto">
          <div className="max-w-5xl mx-auto space-y-6">
            <Card className="bg-card/60 backdrop-blur-sm border-none shadow-[0_6px_24px_-18px_hsl(var(--foreground)/0.22)]">
              <CardHeader><CardTitle>Perfil de Extração</CardTitle></CardHeader>
              <ExtractionProfile />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}


