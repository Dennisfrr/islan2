export function FAQ() {
  return (
    <section className="section" id="faq">
      <div className="container">
        <h2>Perguntas frequentes</h2>
        <div className="faq">
          <details>
            <summary>Posso cancelar quando quiser?</summary>
            <p>Sim, o cancelamento é livre e imediato.</p>
          </details>
          <details>
            <summary>O que preciso para usar o Autentique?</summary>
            <p>Somente seu token de API do Autentique. Seus clientes assinam via link, sem conta.</p>
          </details>
          <details>
            <summary>O WhatsApp funciona em qualquer número?</summary>
            <p>Suportamos o oficial (Meta) e integrações não-oficiais (ex.: W-API).</p>
          </details>
          <details>
            <summary>Há suporte?</summary>
            <p>Sim, suporte por e-mail nos planos pagos.</p>
          </details>
        </div>
      </div>
    </section>
  )
}

