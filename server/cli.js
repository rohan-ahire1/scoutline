#!/usr/bin/env node
// Scoutline command line: the standalone way to drive the scraping service.
// Talks to a running Scoutline (local or the VPS) over its API with the
// server-only service token, so the same queue, dedupe and worker handle
// every scrape whether it came from the UI, this CLI or the nightly timer.
//
//   SCOUTLINE_API          default http://127.0.0.1:8787
//   SCOUTLINE_SERVICE_TOKEN  required (same value the server has)
//
//   scout health
//   scout markets
//   scout discover --market slc --areas "Murray, UT;Sandy, UT" --categories "HVAC contractor" --limit 10 [--key K] [--wait]
//   scout run <runId>
//   scout qualify <leadId> | scout backfill [--rescan]
//   scout nightly [--dry-run] [--state FILE]
//
// Exit codes: 0 ok, 1 failure, 2 usage, 3 unhealthy.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { createNotifier } from './services/notify.js'
import { NIGHTLY_DEFAULTS, nightOf, nightlyIdempotencyKey, planNight, summarizeNight } from './services/nightly.js'

const API = (process.env.SCOUTLINE_API || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN = process.env.SCOUTLINE_SERVICE_TOKEN || ''
const log = (...args) => console.log(new Date().toISOString(), ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class UsageError extends Error {}

async function api(method, path, body) {
  if (!TOKEN) throw new UsageError('SCOUTLINE_SERVICE_TOKEN is not set')
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok && !(path === '/api/health' && res.status === 503)) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json.error || 'request failed'}`)
  }
  return json
}

const list = (value, separator) => (value ? String(value).split(separator).map((v) => v.trim()).filter(Boolean) : undefined)

async function waitForRuns(runIds, { minutes = 150 } = {}) {
  const deadline = Date.now() + minutes * 60_000
  let runs = []
  for (;;) {
    runs = await Promise.all(runIds.map((id) => api('GET', `/api/runs/${id}`)))
    if (runs.every((run) => !['Running', 'Waiting'].includes(run.status))) return runs
    if (Date.now() > deadline) return runs
    await sleep(30_000)
  }
}

async function health() {
  const h = await api('GET', '/api/health')
  const w = h.worker || {}
  console.log(`${h.ok ? 'OK' : 'UNHEALTHY'}  worker ${w.alive ? `alive (pid ${w.pid}, ${w.busy ? `running ${w.currentJobId}` : 'idle'}, heartbeat ${w.heartbeatAgeSeconds}s ago)` : 'NOT RUNNING'}`)
  console.log(`queue    queued ${h.queue.queued}, waiting ${h.queue.waiting}, running ${h.queue.running}`)
  for (const job of h.running) console.log(`running  ${job.type} ${job.id} attempt ${job.attempts}/${job.maxAttempts} since ${job.startedAt}`)
  console.log(`failed   last 24h: ${Object.entries(h.failures24h).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`)
  console.log(`success  ${Object.entries(h.lastSuccess).map(([t, at]) => `${t} ${at}`).join('; ') || 'none yet'}`)
  if (h.nightly) console.log(`nightly  ${h.nightly.night || '?'} ${h.nightly.status}: ${h.nightly.message || ''}`)
  return h.ok ? 0 : 3
}

async function discover(values) {
  if (!values.market) throw new UsageError('discover needs --market')
  const started = await api('POST', `/api/markets/${encodeURIComponent(values.market)}/discover`, {
    areas: list(values.areas, ';'),
    categories: list(values.categories, ','),
    limit: values.limit ? Number(values.limit) : undefined,
    idempotencyKey: values.key || undefined,
  })
  for (const err of started.errors || []) log(`area failed to start: ${err.area}: ${err.error}`)
  log(`runs ${started.runs.join(', ') || 'none'}${started.reused?.length ? ` (reused ${started.reused.join(', ')})` : ''}; estimated new records ${started.estimatedRecords}`)
  if (!values.wait || !started.runs.length) return started.runs.length ? 0 : 1
  const runs = await waitForRuns(started.runs)
  const summary = summarizeNight({ runs, leads: await api('GET', '/api/leads') })
  for (const run of runs) log(`run ${run.id}: ${run.status} discovered=${run.discovered} new=${(run.newClientIds || []).length}`)
  log(`new leads ${summary.newLeads} plays ${JSON.stringify(summary.plays)} pitchable-with-email ${summary.pitchableWithEmail}`)
  return summary.failedRuns.length ? 1 : 0
}

function readStateFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeStateFile(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${file}.tmp`, file)
}

// The nightly timer's entry point. Plans tonight's slice, starts discovery
// with a per-night idempotency key (a rerun resumes instead of re-billing),
// waits for the runs and their qualify/visual jobs, then records and alerts.
async function nightly(values) {
  const marketId = process.env.NIGHTLY_MARKET || 'slc'
  const stateFile = values.state || process.env.NIGHTLY_STATE || `${process.env.HOME}/.local/state/scoutline-nightly/state.json`
  const options = {
    areasPerNight: Number(process.env.NIGHTLY_AREAS || NIGHTLY_DEFAULTS.areasPerNight),
    categoriesPerNight: Number(process.env.NIGHTLY_CATEGORIES || NIGHTLY_DEFAULTS.categoriesPerNight),
  }
  const limit = Number(process.env.NIGHTLY_LIMIT || NIGHTLY_DEFAULTS.limitPerArea)
  const notifier = createNotifier()
  const night = nightOf()
  const record = (status, message, extra = {}) => api('PUT', '/api/system/nightly', { night, market: marketId, status, message, ...extra }).catch((error) => log(`could not record nightly state: ${error.message}`))

  try {
    const status = await api('GET', '/api/status')
    const { markets } = await api('GET', '/api/markets')
    const market = markets.find((m) => m.id === marketId)
    if (!market) throw new Error(`market ${marketId} not found`)
    if (!market.enabled) { log(`market ${marketId} is disabled; nothing to do`); return 0 }
    if (!status.brightDataAdapterReady) throw new Error('Bright Data is not configured on the server (BRIGHT_DATA_API_KEY missing)')

    const plan = planNight(market, readStateFile(stateFile), { night, ...options })
    log(`night ${night}${plan.repeat ? ' (rerun)' : ''}: areas=[${plan.areas.join('; ')}] categories=[${plan.categories.join(', ')}] limit/area=${limit}`)
    if (values['dry-run']) { log('dry run: not starting discovery'); return 0 }

    const started = await api('POST', `/api/markets/${marketId}/discover`, {
      areas: plan.areas, categories: plan.categories, limit, idempotencyKey: nightlyIdempotencyKey(marketId, night),
    })
    for (const err of started.errors || []) log(`area failed to start: ${err.area}: ${err.error}`)
    if (!started.runs.length) throw new Error(`no discovery run started: ${(started.errors || []).map((e) => e.error).join('; ')}`)
    // Advance the rotation once tonight's runs exist; a rerun keeps the slice.
    writeStateFile(stateFile, { ...plan.nextState, lastRunAt: new Date().toISOString(), lastRuns: started.runs })
    log(`runs ${started.runs.join(', ')}${started.reused?.length ? ` (reused ${started.reused.join(', ')})` : ''}`)

    const runs = await waitForRuns(started.runs, { minutes: Number(process.env.NIGHTLY_WAIT_MINUTES || 150) })
    for (const run of runs) log(`run ${run.id}: ${run.status} discovered=${run.discovered} new=${(run.newClientIds || []).length} failed=${run.failed}`)
    const summary = summarizeNight({ runs, leads: await api('GET', '/api/leads') })
    const message = `${summary.newLeads} new leads (${Object.entries(summary.plays).map(([p, n]) => `${n} ${p}`).join(', ') || 'none'}), ${summary.pitchableWithEmail} pitchable with email`
    log(message)

    if (summary.failedRuns.length || summary.unfinished.length) {
      const problem = `${summary.failedRuns.length} run(s) failed, ${summary.unfinished.length} unfinished (${[...summary.failedRuns, ...summary.unfinished].join(', ')})`
      await record('failed', `${problem}; ${message}`, { runs: started.runs, summary })
      await notifier.send(`nightly ${night} had problems: ${problem}. ${message}.`)
      return 1
    }
    await record('ok', message, { runs: started.runs, summary })
    // Draft a few redesign concepts for review. Claude Code runs on the
    // subscription, so the nightly cap stays small.
    const conceptLimit = Number(process.env.NIGHTLY_CONCEPTS ?? 3)
    if (conceptLimit > 0) {
      await api('POST', '/api/concepts/queue', { limit: conceptLimit, triggeredBy: 'nightly' })
        .then((queued) => log(`concepts queued: ${queued.queued}`))
        .catch((error) => log(`could not queue concepts: ${error.message}`))
    }
    if (summary.newLeads === 0) await notifier.send(`nightly ${night} found 0 new leads (${plan.areas.join('; ')} × ${plan.categories.join(', ')}).`)
    return 0
  } catch (error) {
    log(`nightly failed: ${error.message}`)
    await record('failed', error.message)
    await notifier.send(`nightly ${night} failed: ${error.message}`)
    return 1
  }
}

const COMMANDS = {
  health: () => health(),
  markets: async () => {
    const { markets } = await api('GET', '/api/markets')
    for (const m of markets) console.log(`${m.id}\t${m.enabled ? 'on ' : 'off'}\t${m.leads} leads\t${m.areas.length} areas\t${m.categories.join(', ')}`)
    return 0
  },
  discover: (values) => discover(values),
  run: async (_values, [id]) => {
    if (!id) throw new UsageError('run needs a run id')
    console.log(JSON.stringify(await api('GET', `/api/runs/${encodeURIComponent(id)}`), null, 2))
    return 0
  },
  qualify: async (_values, [id]) => {
    if (!id) throw new UsageError('qualify needs a lead id')
    console.log(JSON.stringify(await api('POST', `/api/leads/${encodeURIComponent(id)}/qualify`, {})))
    return 0
  },
  backfill: async (values) => {
    console.log(JSON.stringify(await api('POST', '/api/qualify/backfill', { rescan: Boolean(values.rescan) })))
    return 0
  },
  nightly: (values) => nightly(values),
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      market: { type: 'string' }, areas: { type: 'string' }, categories: { type: 'string' },
      limit: { type: 'string' }, key: { type: 'string' }, wait: { type: 'boolean' },
      rescan: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, state: { type: 'string' },
    },
  })
  const run = COMMANDS[command]
  if (!run) throw new UsageError(`usage: scout <${Object.keys(COMMANDS).join('|')}> [options]`)
  return run(values, positionals)
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  console.error(error instanceof UsageError ? error.message : `error: ${error.message}`)
  process.exit(error instanceof UsageError ? 2 : 1)
})

