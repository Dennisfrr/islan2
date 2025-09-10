export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="foot-grid">
          <div>
            <div className="logo">CRM Pro</div>
            <div className="muted">© {new Date().getFullYear()} CRM Pro. Todos os direitos reservados.</div>
          </div>
          <nav>
            <a href="#recursos">Recursos</a>
            <a href="#precos">Preços</a>
            <a href="#faq">FAQ</a>
          </nav>
        </div>
      </div>
    </footer>
  )
}

