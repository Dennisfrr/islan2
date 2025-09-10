export function Hero() {
  const payUrl = (import.meta as any)?.env?.VITE_PAYMENT_LINK_URL || '#'
  return (
    <header className="hero">
      <div className="container">
        <nav className="nav">
          <div className="logo">CRM Pro</div>
          <div className="nav-actions">
            <a className="btn ghost" href="#precos">Preços</a>
            <a className="btn primary" href={payUrl} target="_blank">Começar agora</a>
          </div>
        </nav>

        <div className="hero-content">
          <h1>Acelere suas vendas com um CRM simples e poderoso</h1>
          <p>Leads, propostas, WhatsApp, contratos Autentique e relatórios — tudo em um só lugar.</p>
          <div className="cta-group">
            <a className="btn primary" href={payUrl} target="_blank">Assine em 2 minutos</a>
            <a className="btn ghost" href="#recursos">Ver recursos</a>
          </div>
        </div>
      </div>
    </header>
  )
}

