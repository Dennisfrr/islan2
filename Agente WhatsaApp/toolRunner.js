const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

function loadTools() {
  try {
    const p = path.join(__dirname, 'tools.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed.tools) ? parsed.tools : [];
    const map = new Map(arr.map(t => [t.id, t]));
    return map;
  } catch (e) {
    console.warn('[ToolRunner] tools.json load failed:', e.message);
    return new Map();
  }
}

const toolsCache = { map: null, at: 0 };
function getToolsMap() {
  const ttlMs = 60 * 1000;
  if (toolsCache.map && (Date.now() - toolsCache.at) < ttlMs) return toolsCache.map;
  toolsCache.map = loadTools();
  toolsCache.at = Date.now();
  return toolsCache.map;
}

async function callWebhook(toolDef, payload) {
  const method = (toolDef.method || 'POST').toUpperCase();
  const url = toolDef.url;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, toolDef.headers || {});
  const opts = { method, headers };
  if (method !== 'GET') opts.body = JSON.stringify(payload || {});
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

async function runToolById(id, context) {
  try {
    const tools = getToolsMap();
    const def = tools.get(id);
    if (!def) return { ok: false, error: `tool_not_found:${id}` };
    if (def.type === 'webhook') {
      const payload = {
        tool: id,
        when: context.when,
        leadId: context.leadId,
        step: context.step,
        planId: context.planId,
        params: context.params || {},
        profile: context.profile || null,
        ts: Date.now()
      };
      const r = await callWebhook(def, payload);
      return { ok: r.ok, status: r.status };
    }
    return { ok: false, error: `unsupported_tool_type:${def.type}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function runToolsForEvent(toolsArr, when, contextBase) {
  if (!Array.isArray(toolsArr) || toolsArr.length === 0) return [];
  const results = [];
  for (const t of toolsArr) {
    try {
      if (!t || t.when !== when) continue;
      const ctx = Object.assign({}, contextBase, { when, params: t.params || {} });
      const r = await runToolById(t.id, ctx);
      results.push({ id: t.id, ok: r.ok, status: r.status || null, error: r.error || null });
    } catch (e) {
      results.push({ id: t && t.id ? t.id : 'unknown', ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

module.exports = { runToolById, runToolsForEvent };


