# Setup do Supabase

## 1. Criar Projeto no Supabase

1. Acesse https://supabase.com
2. Crie uma conta ou faça login
3. Clique em "New project"
4. Escolha uma organização
5. Nomeie o projeto (ex: "krisp-crm")
6. Escolha uma senha para o banco
7. Selecione uma região próxima

## 2. Configurar Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto com:

```
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon
```

Para encontrar essas informações:
1. No painel do Supabase, vá em Settings > API
2. Copie a "Project URL" para VITE_SUPABASE_URL
3. Copie a "Project API keys" > "anon public" para VITE_SUPABASE_ANON_KEY

## 3. Executar SQL Schema

Execute o arquivo `database_schema.sql` no editor SQL do Supabase:
1. Vá para SQL Editor no painel
2. Cole o conteúdo do arquivo
3. Execute o script

## 4. Configurar RLS (Row Level Security)

As políticas RLS já estão incluídas no schema para:
- Usuários só podem ver seus próprios dados
- Isolamento por user_id
- Segurança automática

