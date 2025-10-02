import { useState } from 'react'
import ReflectionAnalytics from '@/components/analytics/ReflectionAnalytics'

const Index = () => {
  const [plan] = useState('LeadQualificationToMeeting')
  return (
    <div className="min-h-screen p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Lumia Dashboard</h1>
          <p className="text-sm text-muted-foreground">Métricas e logs de reflexão do agente</p>
        </div>
        <ReflectionAnalytics defaultPlan={plan} />
      </div>
    </div>
  );
};

export default Index;
