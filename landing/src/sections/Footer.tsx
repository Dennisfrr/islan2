export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="foot-grid">
          <div>
            <div className="logo">lumia</div>
            <div className="muted">© {new Date().getFullYear()} lumia. Todos os direitos reservados.</div>
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

