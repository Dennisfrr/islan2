# Landing - CRM Pro

Landing page independente para venda/assinatura do CRM Pro.

## Rodar local

1. Instale deps

```bash
npm install
```

2. Defina a URL do checkout (Stripe/PagSeguro/Pagar.me etc)

Crie um arquivo `.env` com:

```bash
VITE_PAYMENT_LINK_URL=https://seu-gateway/checkout/xyz
```

3. Suba o dev server

```bash
npm run dev
```

## Build

```bash
npm run build && npm run preview
```

## Estrutura
- src/sections/*: Hero, Features, Pricing, FAQ, Footer
- VITE_PAYMENT_LINK_URL: link do botão “Assinar/Comprar”
