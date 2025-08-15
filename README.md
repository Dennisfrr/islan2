# 🚀 Kommo CRM - Sistema Completo de Gestão de Vendas

Um CRM moderno e completo construído com React, TypeScript, Supabase e shadcn/ui.

## ✨ Funcionalidades Principais

### 🔐 **Autenticação e Usuários**
- Sistema de login/registro completo
- Perfis de usuário personalizáveis
- Controle de acesso por usuário
- Logout seguro

### 📊 **Pipeline de Vendas**
- 6 estágios configuráveis (Novos → Qualificados → Proposta → Negociação → Fechados → Perdidos)
- Drag & drop para movimentar leads
- Contadores automáticos por estágio
- Interface visual intuitiva

### 👥 **Gestão de Leads**
- CRUD completo de leads
- Campos personalizáveis (nome, empresa, valor, responsável, origem)
- Sistema de tags para categorização
- Histórico de contatos
- Busca e filtros avançados

### 🛍️ **Catálogo de Produtos**
- Gestão completa de produtos/serviços
- Categorização automática
- Preços e descrições
- Filtros por categoria

### 📈 **Dashboard e Relatórios**
- Métricas em tempo real
- Taxa de conversão
- Valor total do pipeline
- Deals fechados
- Atividades recentes

### 🎨 **Interface Moderna**
- Design responsivo com Tailwind CSS
- Componentes shadcn/ui
- Tema dark/light
- Animações e transições suaves

## 🛠️ Tecnologias Utilizadas

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Supabase (PostgreSQL + Auth + Real-time)
- **UI**: Tailwind CSS + shadcn/ui
- **Estado**: React Query (TanStack Query)
- **Drag & Drop**: @dnd-kit
- **Ícones**: Lucide React
- **Formulários**: React Hook Form
- **Validação**: Zod

## 🚀 Setup Rápido

### 1. Clone o Repositório
```bash
git clone <seu-repositorio>
cd krisp-comm-crm-76
```

### 2. Instale as Dependências
```bash
npm install
```

### 3. Configure o Supabase

1. Acesse [https://supabase.com](https://supabase.com)
2. Crie uma conta ou faça login
3. Crie um novo projeto
4. Vá em **Settings > API**
5. Copie a **Project URL** e **anon public key**

### 4. Configure as Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon

# Backend
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
JWT_SECRET=dev-secret
CORS_ORIGIN=http://localhost:8080

# Meta App (Facebook/Instagram/WhatsApp)
META_APP_ID=xxxxxxxx
META_APP_SECRET=xxxxxxxx

# Redirects por canal (recomendado). Fallback: META_REDIRECT_URI
META_REDIRECT_URI_WHATSAPP=http://localhost:3000/auth/whatsapp/callback
META_REDIRECT_URI_INSTAGRAM=http://localhost:3000/auth/instagram/callback
META_REDIRECT_URI_MESSENGER=http://localhost:3000/auth/messenger/callback

# Webhook verify tokens
WHATSAPP_WEBHOOK_VERIFY_TOKEN=seu_token
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=seu_token
MESSENGER_WEBHOOK_VERIFY_TOKEN=seu_token
```

### 5. Execute o Schema do Banco

1. No painel do Supabase, vá em **SQL Editor**
2. Cole o conteúdo do arquivo `database_schema.sql`
3. Execute o script

### 6. Inicie o Desenvolvimento
```bash
npm run dev
```

## 📁 Estrutura do Projeto

```
src/
├── components/
│   ├── auth/           # Componentes de autenticação
│   ├── crm/            # Componentes do CRM
│   └── ui/             # Componentes shadcn/ui
├── hooks/              # Hooks personalizados
├── lib/                # Configurações e utilitários
├── pages/              # Páginas da aplicação
└── App.tsx             # Componente principal
```

## 🔧 Funcionalidades Implementadas

### ✅ **Completamente Funcional**
- [x] Autenticação com Supabase
- [x] Pipeline de vendas com drag & drop
- [x] CRUD completo de leads
- [x] Gestão de produtos/serviços
- [x] Dashboard com métricas
- [x] Sistema de busca e filtros
- [x] Interface responsiva
- [x] Real-time updates

### 🚧 **Em Desenvolvimento**
- [ ] Sistema de atividades e tarefas
- [ ] Histórico de interações
- [ ] Integração com WhatsApp
- [ ] Sistema de email marketing
- [ ] Relatórios avançados
- [ ] Automação de workflows

## 📊 Banco de Dados

O sistema utiliza as seguintes tabelas principais:

- **profiles**: Perfis de usuário
- **leads**: Dados dos leads
- **activities**: Atividades e tarefas
- **products**: Catálogo de produtos
- **deals**: Propostas e negócios
- **communications**: Histórico de comunicações
- **settings**: Configurações do usuário

## 🔐 Segurança

- **Row Level Security (RLS)** habilitado
- Usuários só acessam seus próprios dados
- Autenticação JWT com Supabase
- Validação de dados com Zod
- Sanitização de inputs

## 🎯 Próximos Passos

1. **Configurar Supabase** seguindo as instruções acima
2. **Executar o schema** do banco de dados
3. **Testar a autenticação** criando uma conta
4. **Adicionar leads** e produtos de exemplo
5. **Explorar o pipeline** e dashboard

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📝 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 🆘 Suporte

Se você encontrar algum problema ou tiver dúvidas:

1. Verifique se o Supabase está configurado corretamente
2. Confirme se as variáveis de ambiente estão definidas
3. Execute o schema do banco de dados
4. Verifique os logs do console para erros

---

**Desenvolvido com ❤️ usando tecnologias modernas**
