import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Validação das variáveis de ambiente
if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_URL') {
  throw new Error('VITE_SUPABASE_URL não está configurada. Configure no arquivo .env')
}

if (!supabaseAnonKey || supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY') {
  throw new Error('VITE_SUPABASE_ANON_KEY não está configurada. Configure no arquivo .env')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Types para o banco de dados
export interface Lead {
  id: string
  name: string
  company: string
  email?: string
  phone?: string
  ig_username?: string
  value: number
  status: 'new' | 'qualified' | 'proposal' | 'negotiation' | 'closed-won' | 'closed-lost'
  responsible: string
  source: string
  tags: string[]
  notes?: string
  created_at: string
  updated_at: string
  last_contact: string
  user_id: string
}

export interface Activity {
  id: string
  lead_id: string
  user_id: string
  type: 'call' | 'email' | 'meeting' | 'note' | 'task'
  title: string
  description?: string
  due_date?: string
  completed: boolean
  created_at: string
  updated_at: string
}

export interface Product {
  id: string
  name: string
  description?: string
  price: number
  category: string
  active: boolean
  user_id: string
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
  full_name: string
  role: 'admin' | 'manager' | 'sales'
  avatar_url?: string
  created_at: string
  updated_at: string
}

// Deals (Propostas)
export interface Deal {
  id: string
  lead_id: string | null
  title: string
  description?: string | null
  total_value: number
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'
  valid_until?: string | null
  user_id: string
  created_at: string
  updated_at: string
}

export interface DealItem {
  id: string
  deal_id: string
  product_id: string | null
  product_name: string
  quantity: number
  unit_price: number
  total_price: number
  created_at: string
}

