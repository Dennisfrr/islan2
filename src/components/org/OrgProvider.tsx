import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { apiFetch } from '@/lib/api'

type OrgContextType = {
  orgId: string | null
  orgName: string | null
  orgRole: 'admin' | 'manager' | 'sales' | null
  loading: boolean
  refresh: () => Promise<void>
}

const OrgContext = createContext<OrgContextType | undefined>(undefined)

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { session, user } = useAuth()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [orgName, setOrgName] = useState<string | null>(null)
  const [orgRole, setOrgRole] = useState<'admin' | 'manager' | 'sales' | null>(null)
  const [loading, setLoading] = useState(true)

  const authHeader = useMemo(() => (
    session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  ), [session?.access_token])

  const load = async () => {
    if (!user) {
      setOrgId(null); setOrgName(null); setOrgRole(null); setLoading(false)
      return
    }
    setLoading(true)
    try {
      let r = await apiFetch('/api/org/me', { headers: { ...authHeader } })
      if (r.status === 401) { setOrgId(null); setOrgName(null); setOrgRole(null); return }
      if (!r.ok) throw new Error(await r.text())
      let json = await r.json()
      let orgs: Array<{ id: string; name: string; role: 'admin' | 'manager' | 'sales' }> = json.organizations || []
      if (orgs.length === 0) {
        const b = await apiFetch('/api/org/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader } })
        if (!b.ok) throw new Error(await b.text())
        r = await apiFetch('/api/org/me', { headers: { ...authHeader } })
        json = await r.json()
        orgs = json.organizations || []
      }
      const first = orgs[0]
      setOrgId(first?.id || null)
      setOrgName(first?.name || null)
      setOrgRole(first?.role || null)
    } catch {
      setOrgId(null); setOrgName(null); setOrgRole(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [user?.id])

  const value: OrgContextType = {
    orgId, orgName, orgRole, loading,
    refresh: load,
  }

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg() {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used within OrgProvider')
  return ctx
}


