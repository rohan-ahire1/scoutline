#!/usr/bin/env node
// Nightly market discovery for Scoutline, run by scoutline-nightly.timer.
//
// Each night it starts discovery for a slice of the market (a few areas x a
// few trade categories), rotating so the whole market is covered over a cycle
// instead of paying Bright Data for the same top results every night. Runs
// queue their own qualify (+ visual review) jobs, so leads are sorted into
// plays by morning. It waits for the runs and logs a summary to the journal.
//
// The API only accepts Google sessions, so the job mints a short-lived session
// row for an allowed email directly in the app database and deletes it when
// done. Nothing leaves the box.

import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const APP_DIR = process.env.SCOUTLINE_APP_DIR || '/home/rohan/projects/scoutline/current'
const DB_PATH = process.env.SCOUTLINE_DB || '/home/rohan/projects/scoutline/data/scoutline.db'
const API = process.env.SCOUTLINE_API || 'http://127.0.0.1:8787'
const MARKET = process.env.NIGHTLY_MARKET || 'slc'
const AREAS_PER_NIGHT = Number(process.env.NIGHTLY_AREAS || 2)
const CATEGORIES_PER_NIGHT = Number(process.env.NIGHTLY_CATEGORIES || 3)
const LIMIT_PER_AREA = Number(process.env.NIGHTLY_LIMIT || 25)
const WAIT_MINUTES = Number(process.env.NIGHTLY_WAIT_MINUTES || 150)
const STATE_FILE = process.env.NIGHTLY_STATE || '/home/rohan/.local/state/scoutline-nightly/state.json'
const DRY_RUN = process.argv.includes('--dry-run')

const require = createRequire(join(APP_DIR, 'package.json'))
const Database = require('better-sqlite3')

const log = (...args) => console.log(new Date().toISOString(), ...args)

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { areaCursor: 0, categoryCursor: 0 } }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function take(list, start, count) {
  return Array.from({ length: Math.min(count, list.length) }, (_, i) => list[(start + i) % list.length])
}

function mintSession(db) {
  const email = String(process.env.SCOUTLINE_ALLOWED_EMAILS || '').split(/[\s,;]+/).find((e) => e.includes('@'))
  if (!email) throw new Error('SCOUTLINE_ALLOWED_EMAILS is not set')
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const now = Date.now()
  db.prepare('INSERT INTO auth_sessions (token_hash, google_sub, email, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash, 'system:nightly', email.toLowerCase(), 'Nightly job', now + (WAIT_MINUTES + 30) * 60_000, new Date(now).toISOString())
  return { cookie: `scoutline_session=${encodeURIComponent(token)}`, revoke: () => db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash) }
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error || 'request failed'}`)
  return json
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (!existsSync(DB_PATH)) throw new Error(`database not found at ${DB_PATH}`)
  const db = new Database(DB_PATH)
  db.pragma('busy_timeout = 5000')
  const session = mintSession(db)
  try {
    const status = await api(session.cookie, 'GET', '/api/status')
    const { markets } = await api(session.cookie, 'GET', '/api/markets')
    const market = markets.find((m) => m.id === MARKET)
    if (!market) throw new Error(`market ${MARKET} not found`)
    if (!market.enabled) { log(`market ${MARKET} is disabled; nothing to do`); return }

    const state = readState()
    const areas = take(market.areas, state.areaCursor, AREAS_PER_NIGHT)
    const categories = take(market.categories, state.categoryCursor, CATEGORIES_PER_NIGHT)
    log(`slice: areas=[${areas.map((a) => a.name).join('; ')}] categories=[${categories.join(', ')}] limit/area=${LIMIT_PER_AREA}`)

    if (!status.brightDataAdapterReady) {
      log('Bright Data is not configured (BRIGHT_DATA_API_KEY missing), so discovery is skipped. Rescoring saved leads only.')
      const rescored = await api(session.cookie, 'POST', '/api/qualify/backfill', {})
      log(`rescored=${rescored.rescored} queued=${rescored.queued}`)
      return
    }
    if (DRY_RUN) { log('dry run: not starting discovery'); return }

    const leadsBefore = new Set((await api(session.cookie, 'GET', '/api/leads')).map((l) => l.id))
    const started = await api(session.cookie, 'POST', `/api/markets/${MARKET}/discover`, {
      areas: areas.map((a) => a.name), categories, limit: LIMIT_PER_AREA,
    })
    for (const err of started.errors || []) log(`area failed to start: ${err.area}: ${err.error}`)
    log(`started runs=${started.runs.join(',')} estimatedRecords=${started.estimatedRecords}`)

    // Advance the rotation once discovery actually started: areas first, and
    // categories each time the areas wrap around.
    const nextArea = state.areaCursor + AREAS_PER_NIGHT
    writeState({
      areaCursor: nextArea % market.areas.length,
      categoryCursor: nextArea >= market.areas.length ? (state.categoryCursor + CATEGORIES_PER_NIGHT) % market.categories.length : state.categoryCursor,
      lastRunAt: new Date().toISOString(),
      lastRuns: started.runs,
    })

    const deadline = Date.now() + WAIT_MINUTES * 60_000
    let runs = []
    while (Date.now() < deadline) {
      runs = await Promise.all(started.runs.map((id) => api(session.cookie, 'GET', `/api/runs/${id}`)))
      const busy = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('Queued', 'Running', 'Waiting')").get().n > 0
      if (runs.every((r) => r.status !== 'Running') && !busy) break
      await sleep(60_000)
    }
    for (const r of runs) log(`run ${r.id}: ${r.status} discovered=${r.discovered} audited=${r.audited} failed=${r.failed}`)

    const leads = await api(session.cookie, 'GET', '/api/leads')
    const fresh = leads.filter((l) => !leadsBefore.has(l.id))
    const plays = {}
    for (const l of fresh) plays[l.qualification?.play || 'unqualified'] = (plays[l.qualification?.play || 'unqualified'] || 0) + 1
    const withEmail = fresh.filter((l) => l.qualification?.play !== 'skip' && l.qualification?.contact?.email).length
    log(`new leads=${fresh.length} plays=${JSON.stringify(plays)} pitchable-with-email=${withEmail}`)
  } finally {
    session.revoke()
    db.close()
  }
}

main().catch((error) => {
  log(`nightly failed: ${error.message}`)
  process.exit(1)
})
