const fs = require('fs');
const path = require('path');

function loadTemplates() {
  try {
    const p = path.join(__dirname, 'micro_templates.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { opening: {}, body: {}, cta: {} };
  }
}

function pick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildNextMessagePlan(style, signals) {
  const tpls = loadTemplates();
  const openingPool = tpls.opening[String(style.tom || 'consultivo')] || [];
  const bodyPool = [];
  if (style.evidencias) bodyPool.push(...(tpls.body.evidencias || []));
  if (style.exemplos || style.historias) bodyPool.push(...(tpls.body.exemplos || []));
  if (style.diretividade === 'baixa' || signals?.includes('resistencia')) bodyPool.push(...(tpls.body.perguntas_exploratorias || []));
  const ctaPool = (style.cta_pressure === 'alta' || style.soft_close) ? (tpls.cta.soft_close || []) : (tpls.cta.direto || []);

  const opening = pick(openingPool);
  const body = pick(bodyPool);
  const cta = pick(ctaPool);
  const variants = [opening, body, cta].filter(Boolean);
  return { opening, body, cta, variants };
}

module.exports = { buildNextMessagePlan };


