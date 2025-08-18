-- ==========================================
-- SCHEMA COMPLETO DO CRM GENÉRICO
-- ==========================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- TABELA DE PERFIS DE USUÁRIO
-- ==========================================
CREATE TABLE public.profiles (
    id UUID REFERENCES auth.users NOT NULL PRIMARY KEY,
    full_name TEXT,
    role TEXT CHECK (role IN ('admin', 'manager', 'sales')) DEFAULT 'admin',
    avatar_url TEXT,
    company_name TEXT,
    phone TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==========================================
-- MULTI-EMPRESA (TENANT) BÁSICO — definir antes das tabelas que referenciam
-- ==========================================
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.organization_members (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users NOT NULL,
    role TEXT CHECK (role IN ('admin','manager','sales')) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(organization_id, user_id)
);

-- ==========================================
-- TABELA DE LEADS
-- ==========================================
CREATE TABLE public.leads (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    ig_username TEXT, -- handler do Instagram para correlação de DMs
    value NUMERIC DEFAULT 0,
    status TEXT CHECK (status IN ('new', 'qualified', 'proposal', 'negotiation', 'closed-won', 'closed-lost')) DEFAULT 'new',
    responsible TEXT NOT NULL,
    source TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_contact TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    user_id UUID REFERENCES auth.users NOT NULL,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL
);

-- ==========================================
-- TABELA DE ATIVIDADES
-- ==========================================
CREATE TABLE public.activities (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users NOT NULL,
    type TEXT CHECK (type IN ('call', 'email', 'meeting', 'note', 'task', 'whatsapp', 'proposal')) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date TIMESTAMP WITH TIME ZONE,
    completed BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL
);

-- ==========================================
-- TABELA DE PRODUTOS/SERVIÇOS
-- ==========================================
CREATE TABLE public.products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price NUMERIC NOT NULL DEFAULT 0,
    category TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    user_id UUID REFERENCES auth.users NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL
);

-- ==========================================
-- TABELA DE PROPOSTAS/DEALS
-- ==========================================
CREATE TABLE public.deals (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    total_value NUMERIC DEFAULT 0,
    status TEXT CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')) DEFAULT 'draft',
    valid_until DATE,
    user_id UUID REFERENCES auth.users NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL
);

-- ==========================================
-- TABELA DE ITENS DA PROPOSTA
-- ==========================================
CREATE TABLE public.deal_items (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    deal_id UUID REFERENCES public.deals(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id),
    product_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    unit_price NUMERIC NOT NULL,
    total_price NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==========================================
-- TABELA DE COMUNICAÇÕES
-- ==========================================
CREATE TABLE public.communications (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users NOT NULL,
    type TEXT CHECK (type IN ('email', 'whatsapp', 'sms', 'call', 'instagram', 'messenger')) NOT NULL,
    direction TEXT CHECK (direction IN ('inbound', 'outbound')) NOT NULL,
    subject TEXT,
    content TEXT,
    status TEXT CHECK (status IN ('sent', 'delivered', 'read', 'failed')) DEFAULT 'sent',
    external_id TEXT, -- ID da mensagem no provedor (WhatsApp, email, etc.)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL
);

-- ==========================================
-- TABELA DE CONFIGURAÇÕES
-- ==========================================
CREATE TABLE public.settings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id UUID REFERENCES auth.users NOT NULL,
    key TEXT NOT NULL,
    value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(user_id, key)
);

-- ==========================================
-- TABELA DE CONFIGURAÇÕES DA ORGANIZAÇÃO
-- ==========================================
CREATE TABLE IF NOT EXISTS public.organization_settings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    organization_id UUID REFERENCES public.organizations(id) NOT NULL,
    key TEXT NOT NULL,
    value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(organization_id, key)
);

-- ==========================================
-- MULTI-EMPRESA (TENANT) BÁSICO
-- ==========================================
-- (Seções antigas de organizations removidas do final para evitar duplicação)

-- ==========================================
-- FUNÇÕES DE TRIGGER PARA UPDATED_AT
-- ==========================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para updated_at
CREATE TRIGGER handle_updated_at_profiles BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_leads BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_activities BEFORE UPDATE ON public.activities FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_products BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_deals BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_settings BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();
CREATE TRIGGER handle_updated_at_organization_settings BEFORE UPDATE ON public.organization_settings FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();

-- Preencher organization_id em leads automaticamente se não fornecido
CREATE OR REPLACE FUNCTION public.set_default_org_on_leads()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.organization_id IS NULL THEN
        SELECT m.organization_id INTO NEW.organization_id
        FROM public.organization_members m
        WHERE m.user_id = NEW.user_id
        ORDER BY m.created_at ASC
        LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER set_default_org_on_leads
BEFORE INSERT ON public.leads
FOR EACH ROW
EXECUTE PROCEDURE public.set_default_org_on_leads();

-- ==========================================
-- ROW LEVEL SECURITY (RLS)
-- ==========================================

-- Habilitar RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- Políticas RLS

-- Profiles: usuários podem ver e editar apenas seu próprio perfil
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Leads: ver/editar próprios; inserir/deletar restrito a manager/admin
CREATE POLICY "Users can view own leads" ON public.leads FOR SELECT USING (auth.uid() = user_id);
-- Admins/Managers podem ver todos os leads da organização
CREATE POLICY "Admins/Managers can view org leads" ON public.leads FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('admin','manager')
      AND m.organization_id = leads.organization_id
  )
);
CREATE POLICY "Managers/Admins can insert leads" ON public.leads FOR INSERT WITH CHECK (
  auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')
  )
);
CREATE POLICY "Users can update own leads" ON public.leads FOR UPDATE USING (auth.uid() = user_id);
-- Admins/Managers podem atualizar leads da organização
CREATE POLICY "Admins/Managers can update org leads" ON public.leads FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('admin','manager')
      AND m.organization_id = leads.organization_id
  )
);
CREATE POLICY "Managers/Admins can delete leads" ON public.leads FOR DELETE USING (
  auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')
  )
);

-- Activities: usuários podem gerenciar apenas suas próprias atividades
CREATE POLICY "Users can view own activities" ON public.activities FOR SELECT USING (auth.uid() = user_id);
-- Admins/Managers podem ver atividades da organização
CREATE POLICY "Admins/Managers can view org activities" ON public.activities FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('admin','manager')
      AND m.organization_id = activities.organization_id
  )
);
CREATE POLICY "Users can insert own activities" ON public.activities FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own activities" ON public.activities FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own activities" ON public.activities FOR DELETE USING (auth.uid() = user_id);

-- Products: visualizar próprios; criar/atualizar/excluir apenas manager/admin
CREATE POLICY "Users can view own products" ON public.products FOR SELECT USING (auth.uid() = user_id);
-- Membros podem ver produtos da organização
CREATE POLICY "Members can view org products" ON public.products FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = products.organization_id
  )
);
CREATE POLICY "Managers/Admins can insert products" ON public.products FOR INSERT WITH CHECK (
  auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')
  )
);
CREATE POLICY "Managers/Admins can update products" ON public.products FOR UPDATE USING (
  auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')
  )
);
CREATE POLICY "Managers/Admins can delete products" ON public.products FOR DELETE USING (
  auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')
  )
);

-- Deals: usuários podem gerenciar apenas seus próprios deals
CREATE POLICY "Users can view own deals" ON public.deals FOR SELECT USING (auth.uid() = user_id);
-- Admins/Managers podem ver deals da organização
CREATE POLICY "Admins/Managers can view org deals" ON public.deals FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('admin','manager')
      AND m.organization_id = deals.organization_id
  )
);
CREATE POLICY "Users can insert own deals" ON public.deals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own deals" ON public.deals FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own deals" ON public.deals FOR DELETE USING (auth.uid() = user_id);

-- Deal Items: acessíveis através dos deals
CREATE POLICY "Users can view deal items through deals" ON public.deal_items FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.deals WHERE id = deal_id AND user_id = auth.uid())
);
CREATE POLICY "Users can insert deal items through deals" ON public.deal_items FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.deals WHERE id = deal_id AND user_id = auth.uid())
);
CREATE POLICY "Users can update deal items through deals" ON public.deal_items FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.deals WHERE id = deal_id AND user_id = auth.uid())
);
CREATE POLICY "Users can delete deal items through deals" ON public.deal_items FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.deals WHERE id = deal_id AND user_id = auth.uid())
);

-- Communications: usuários podem gerenciar apenas suas próprias comunicações
CREATE POLICY "Users can view own communications" ON public.communications FOR SELECT USING (auth.uid() = user_id);
-- Admins/Managers podem ver comunicações da organização
CREATE POLICY "Admins/Managers can view org communications" ON public.communications FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('admin','manager')
      AND m.organization_id = communications.organization_id
  )
);
CREATE POLICY "Users can insert own communications" ON public.communications FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own communications" ON public.communications FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own communications" ON public.communications FOR DELETE USING (auth.uid() = user_id);

-- Settings: usuários podem gerenciar apenas suas próprias configurações
CREATE POLICY "Users can view own settings" ON public.settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own settings" ON public.settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own settings" ON public.settings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own settings" ON public.settings FOR DELETE USING (auth.uid() = user_id);

-- Organization Settings: apenas admins/managers da org podem gerenciar
CREATE POLICY "Org members can view org settings" ON public.organization_settings FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid() AND m.organization_id = organization_id
  )
);
CREATE POLICY "Org admins can insert org settings" ON public.organization_settings FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid() AND m.organization_id = organization_id AND m.role IN ('admin','manager')
  )
);
CREATE POLICY "Org admins can update org settings" ON public.organization_settings FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid() AND m.organization_id = organization_settings.organization_id AND m.role IN ('admin','manager')
  )
);
CREATE POLICY "Org admins can delete org settings" ON public.organization_settings FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = auth.uid() AND m.organization_id = organization_settings.organization_id AND m.role IN ('admin','manager')
  )
);

-- Organizations: somente membros podem ver
CREATE POLICY "Members can view organizations" ON public.organizations FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = id AND m.user_id = auth.uid()
  )
);

-- Helpers sem recursão para checar papel na organização
CREATE OR REPLACE FUNCTION public.is_org_admin(uid uuid, org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.user_id = uid AND m.organization_id = org_id AND m.role IN ('admin','manager')
  );
$$;

-- Organization members: cada usuário vê seus memberships
CREATE POLICY "Users can view own memberships" ON public.organization_members FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage memberships" ON public.organization_members FOR ALL USING (
  public.is_org_admin(auth.uid(), organization_members.organization_id)
) WITH CHECK (
  public.is_org_admin(auth.uid(), organization_members.organization_id)
);

-- ==========================================
-- FUNÇÃO PARA CRIAR PERFIL AUTOMÁTICO
-- ==========================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, role)
    VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', 'admin');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger para criar perfil automaticamente
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ==========================================
-- DADOS INICIAIS DE EXEMPLO
-- ==========================================
-- Seed removido. Use a aplicação para criar dados iniciais.

