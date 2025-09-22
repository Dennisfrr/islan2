export const API_BASE_URL: string = (import.meta as any)?.env?.VITE_API_BASE_URL || ''

import { supabase } from '@/lib/supabase'

async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data?.session?.access_token || null
    if (token) return token
  } catch {}
  try {
    // Fallback: tenta pegar do localStorage (diferentes projetos Supabase)
    const keys = Object.keys(localStorage).filter(k => k.startsWith('sb-') && (k.endsWith('-auth-token') || k.endsWith('-auth')))
    for (const k of keys) {
      try {
        const v = JSON.parse(localStorage.getItem(k) || 'null')
        const t = v?.access_token || v?.currentSession?.access_token || v?.session?.access_token
        if (typeof t === 'string' && t) return t
      } catch {}
    }
  } catch {}
  return null
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = input.startsWith('http') ? input : `${API_BASE_URL}${input}`
  const headers = new Headers(init?.headers || {})
  if (!headers.has('Authorization')) {
    const token = await getAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }
  return fetch(url, { ...(init || {}), headers })
}


