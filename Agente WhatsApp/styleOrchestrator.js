const fs = require('fs');
const path = require('path');

function loadPolicies() {
  try {
    const p = path.join(__dirname, 'style_policies.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { persona: {}, context: {}, defaults: {}, guardrails: {} };
  }
}

function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function detectPersonaFromProfile(profile) {
  const tags = (profile?.tags || []).map(normalize);
  const personaInferida = normalize(profile?.personaInferida || '');
  if (tags.some(t => t.includes('objetiv'))) return 'objetiva';
  if (tags.some(t => t.includes('relacion'))) return 'relacional';
  if (tags.some(t => t.includes('analit'))) return 'analitica';
  if (personaInferida.includes('objet')) return 'objetiva';
  if (personaInferida.includes('relac')) return 'relacional';
  if (personaInferida.includes('analit')) return 'analitica';
  return null;
}

function detectContextSignals(reflectionResult, profile) {
  const out = new Set();
  const s = normalize(reflectionResult?.sentimentoInferidoDoLead || '');
  const intent = normalize(reflectionResult?.intencaoDetectada || '');
  if (s.includes('cetic') || s.includes('resist')) out.add('resistencia');
  if (s.includes('indecis')) out.add('indeciso');
  if (intent.includes('marcar_reuniao') || intent.includes('proposta')) out.add('interesse_forte');
  if (s.includes('cetic')) out.add('cetico');
  return Array.from(out);
}

function mergeProfiles(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) out[k] = v;
  return out;
}

function buildToneDirectives(style) {
  const d = [];
  if (style.tom === 'direto') d.push('Use frases curtas e diretas.');
  if (style.tom === 'caloroso') d.push('Abra com empatia genuína.');
  if (style.evidencias) d.push('Traga 1 dado objetivo ou fato verificável.');
  if (style.exemplos || style.historias) d.push('Inclua 1 exemplo curto e concreto.');
  if (style.cta_pressure === 'alta') d.push('Inclua um CTA claro com senso de prioridade, sem pressão excessiva.');
  if (style.diretividade === 'baixa') d.push('Faça 1–2 perguntas exploratórias em vez de afirmar.');
  return d.slice(0, 4);
}

function applyGuardrails(style, guardrails) {
  const s = { ...style };
  // limitar pressão do CTA
  const levels = ['baixa', 'media', 'alta'];
  if (levels.indexOf(s.cta_pressure) > levels.indexOf(guardrails.max_cta_pressure || 'alta')) {
    s.cta_pressure = guardrails.max_cta_pressure;
  }
  if (guardrails.limit_emojis) s.emojis_on = !!s.emojis_on && s.tom === 'caloroso';
  return s;
}

function orchestrateStyle(profile, reflectionResult) {
  const policies = loadPolicies();
  const personaKey = detectPersonaFromProfile(profile);
  const contextKeys = detectContextSignals(reflectionResult, profile);

  let style = { ...(policies.defaults || {}) };
  if (personaKey && policies.persona[personaKey]) style = mergeProfiles(style, policies.persona[personaKey]);
  for (const ck of contextKeys) {
    if (policies.context[ck]) style = mergeProfiles(style, policies.context[ck]);
  }
  style = applyGuardrails(style, policies.guardrails || {});
  const toneDirectives = buildToneDirectives(style);
  const policyId = `persona:${personaKey || 'none'}|ctx:${contextKeys.join('+') || 'none'}`;
  const complianceFlags = { forbid_promises: !!(policies.guardrails && policies.guardrails.forbid_promises) };
  return { style, toneDirectives, policyId, complianceFlags };
}

module.exports = { orchestrateStyle };


