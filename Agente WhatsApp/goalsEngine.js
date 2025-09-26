const fs = require('fs')
const path = require('path')
const { getSession } = require('./db_neo4j')

const GOALS_PATH = path.join(__dirname, 'goals.json')

let goals = []
let snapshots = [] // { id, at, value, target, direction, status }
let timer = null

function loadGoals() {
  try {
    if (!fs.existsSync(GOALS_PATH)) fs.writeFileSync(GOALS_PATH, '[]', 'utf8')
    const raw = fs.readFileSync(GOALS_PATH, 'utf8')
    goals = JSON.parse(raw)
  } catch (e) {
    console.warn('[Goals] failed to load goals.json:', e.message)
    goals = []
  }
}

function getGoals() { return goals.map(g => ({ ...g })) }
function getSnapshots() { return snapshots.slice(-500) }

function computeStatus(value, target, direction) {
  if (typeof value !== 'number' || typeof target !== 'number') return 'unknown'
  if (direction === '>=') return value >= target ? 'on_track' : 'off_track'
  if (direction === '<=') return value <= target ? 'on_track' : 'off_track'
  return 'unknown'
}

async function evaluateOne(session, g) {
  try {
    if (g?.measure?.cypher) {
      const r = await session.run(g.measure.cypher)
      const rec = r.records[0]
      const value = rec ? Number(rec.get('value')) : NaN
      const status = computeStatus(value, Number(g.target), g.direction || '>=')
      return { id: g.id, title: g.title, value, target: Number(g.target), direction: g.direction || '>=', status }
    }
    return { id: g.id, title: g.title, value: NaN, target: Number(g.target), direction: g.direction || '>=', status: 'unknown' }
  } catch (e) {
    return { id: g.id, title: g.title, error: e.message, value: NaN, target: Number(g.target), direction: g.direction || '>=', status: 'error' }
  }
}

async function evaluateGoals() {
  const session = await getSession()
  try {
    const results = []
    for (const g of goals) {
      const snap = await evaluateOne(session, g)
      results.push(snap)
      snapshots.push({ ...snap, at: Date.now() })
    }
    return results
  } finally {
    await session.close()
  }
}

function start(intervalMs = 5 * 60 * 1000) {
  if (timer) return
  loadGoals()
  timer = setInterval(() => { evaluateGoals().catch(() => {}) }, intervalMs)
}

function stop() { if (timer) clearInterval(timer); timer = null }

module.exports = { loadGoals, getGoals, evaluateGoals, getSnapshots, start, stop }


