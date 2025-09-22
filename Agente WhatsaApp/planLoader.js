const fs = require('fs');
const path = require('path');

function getPath(obj, dotPath) {
  return String(dotPath || '')
    .split('.')
    .reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), obj);
}

const predicates = {
  array_nonempty: ({ path }, profile) => {
    const v = getPath(profile, path);
    return Array.isArray(v) && v.length > 0;
  },
  exists: ({ path }, profile) => {
    const v = getPath(profile, path);
    return v !== undefined && v !== null;
  },
  text_includes: ({ path, value, ci }, profile) => {
    const t = String(getPath(profile, path) || '');
    if (ci) return t.toLowerCase().includes(String(value).toLowerCase());
    return t.includes(String(value));
  },
  text_includes_any: ({ path, values = [], ci }, profile) => {
    const t = String(getPath(profile, path) || '');
    const hay = ci ? t.toLowerCase() : t;
    return values.some(v => hay.includes(ci ? String(v).toLowerCase() : String(v)));
  },
  tags_includes_any: ({ values = [], prefixAny }, profile) => {
    const tags = (profile.tags || []).map(x => String(x).toLowerCase());
    const hasTag = values.some(v => tags.includes(String(v).toLowerCase()));
    const hasPrefix = prefixAny ? tags.some(t => t.startsWith(String(prefixAny).toLowerCase())) : false;
    return hasTag || hasPrefix;
  },
  in_list: ({ path, values = [], ci }, profile) => {
    const v = getPath(profile, path);
    if (v == null) return false;
    const target = ci ? String(v).toLowerCase() : String(v);
    const list = values.map(x => (ci ? String(x).toLowerCase() : String(x)));
    return list.includes(target);
  },
  gte: ({ path, value }, profile) => {
    const v = getPath(profile, path);
    const num = typeof v === 'number' ? v : parseFloat(String(v));
    const cmp = typeof value === 'number' ? value : parseFloat(String(value));
    if (Number.isNaN(num) || Number.isNaN(cmp)) return false;
    return num >= cmp;
  },
  entity_detected: ({ path, values = [], ci }, profile) => {
    const v = getPath(profile, path);
    if (Array.isArray(v)) {
      const arr = v.map(x => String(x));
      return values.some(val => arr.includes(String(val)));
    }
    if (v == null) return false;
    const s = String(v);
    if (ci) return values.map(x => String(x).toLowerCase()).includes(s.toLowerCase());
    return values.includes(s);
  }
};

function isStepCompleted(step, profile) {
  const rules = Array.isArray(step.completion) ? step.completion : [];
  if (rules.length === 0) return false;
  const mode = String(step.completionMode || 'any').toLowerCase();
  if (mode === 'all') {
    return rules.every(rule => {
      const fn = rule && predicates[rule.type];
      try { return fn ? !!fn(rule, profile) : false; } catch { return false; }
    });
  }
  // default any
  return rules.some(rule => {
    const fn = rule && predicates[rule.type];
    try { return fn ? !!fn(rule, profile) : false; } catch { return false; }
  });
}

function pickNextIndex(step, plan, profile) {
  const transitions = Array.isArray(step.transitions) ? step.transitions : [];
  for (const t of transitions) {
    const cond = t && t.when;
    const fn = cond && predicates[cond.type];
    try {
      if (fn && fn(cond, profile)) {
        const idx = plan.steps.findIndex(s => s.name === t.goTo);
        if (idx >= 0) return idx;
      }
    } catch {}
  }
  return null;
}

function validatePlansShape(plans) {
  const errors = [];
  if (!plans || typeof plans !== 'object') {
    errors.push('plans must be an object');
    return { ok: false, errors };
  }
  for (const [planId, plan] of Object.entries(plans)) {
    if (!plan || typeof plan !== 'object') { errors.push(`${planId}: plan must be object`); continue; }
    if (!Array.isArray(plan.steps)) { errors.push(`${planId}: steps must be array`); continue; }
    const names = new Set();
    for (const step of plan.steps) {
      if (!step || typeof step !== 'object') { errors.push(`${planId}: step must be object`); continue; }
      if (!step.name || typeof step.name !== 'string') errors.push(`${planId}: step missing name`);
      if (step.name) {
        if (names.has(step.name)) errors.push(`${planId}: duplicated step name '${step.name}'`);
        names.add(step.name);
      }
      if (step.completion && !Array.isArray(step.completion)) errors.push(`${planId}.${step.name}: completion must be array`);
      if (step.transitions && !Array.isArray(step.transitions)) errors.push(`${planId}.${step.name}: transitions must be array`);
    }
    // Validate transitions goTo exists
    const stepNames = plan.steps.map(s => s.name);
    for (const step of plan.steps) {
      for (const t of step.transitions || []) {
        if (t && t.goTo && !stepNames.includes(t.goTo)) errors.push(`${planId}.${step.name}: transition goTo '${t.goTo}' not found`);
      }
      if (step.onFailureNextStep && !stepNames.includes(step.onFailureNextStep)) errors.push(`${planId}.${step.name}: onFailureNextStep '${step.onFailureNextStep}' not found`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadPlans() {
  try {
    const p = path.join(__dirname, 'plans.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    // Normalize defaults → plan-level settings
    for (const [planId, plan] of Object.entries(parsed || {})) {
      if (plan && plan.defaults) {
        if (plan.maxRetriesPerStep === undefined && plan.defaults.maxRetriesPerStep !== undefined) {
          plan.maxRetriesPerStep = plan.defaults.maxRetriesPerStep;
        }
      }
    }
    const v = validatePlansShape(parsed);
    if (!v.ok) {
      console.error('[PlanLoader] Validation errors:', v.errors);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('[PlanLoader] load failed, using fallback:', e.message);
    return null;
  }
}

module.exports = {
  loadPlans,
  validatePlansShape,
  predicates,
  isStepCompleted,
  pickNextIndex,
  getPath
};


