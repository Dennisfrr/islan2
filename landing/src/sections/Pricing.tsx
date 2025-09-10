export function Pricing() {
  const payUrl = (import.meta as any)?.env?.VITE_PAYMENT_LINK_URL || '#'
  return (
    <section className="section alt" id="precos">
      <div className="container">
        <h2>Planos simples</h2>
        <div className="pricing-grid">
          <div className="price-card">
            <div className="price-head">
              <h3>Starter</h3>
              <div className="price">R$ 49<span>/mês</span></div>
            </div>
            <ul>
              <li>1 organização</li>
              <li>Até 3 usuários</li>
              <li>Pipeline e propostas</li>
            </ul>
            <a className="btn primary full" href={payUrl} target="_blank">Assinar</a>
          </div>
          <div className="price-card featured">
            <div className="price-head">
              <h3>Pro</h3>
              <div className="price">R$ 149<span>/mês</span></div>
            </div>
            <ul>
              <li>Tudo do Starter</li>
              <li>WhatsApp e Autentique</li>
              <li>Usuários ilimitados</li>
            </ul>
            <a className="btn primary full" href={payUrl} target="_blank">Assinar</a>
          </div>
          <div className="price-card">
            <div className="price-head">
              <h3>Enterprise</h3>
              <div className="price">Sob consulta</div>
            </div>
            <ul>
              <li>Onboarding dedicado</li>
              <li>Integrações customizadas</li>
              <li>Suporte prioritário</li>
            </ul>
            <a className="btn ghost full" href="#contato">Falar com vendas</a>
          </div>
        </div>
      </div>
    </section>
  )
}

