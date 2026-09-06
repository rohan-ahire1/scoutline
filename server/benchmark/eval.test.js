// Benchmark harness tests (ROH-26): fixtures are well-formed, the eval is
// deterministic, and the whole offline suite provably touches no real network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FIXTURE_VERSION, loadFixtures, runEval } from './eval.js'
import { GATE_DEFINITIONS, checkGates } from './gates.js'

const FIXTURES = new URL('./fixtures.v1.json', import.meta.url).pathname

test('every fixture declares a known runner with the fields it needs', () => {
  const fixtures = loadFixtures(FIXTURES)
  assert.equal(fixtures.version, FIXTURE_VERSION)
  assert.ok(fixtures.cases.length >= 20, `expected 20+ cases, got ${fixtures.cases.length}`)
  const kinds = new Set(fixtures.cases.map((item) => item.kind))
  for (const required of ['capture', 'fetch', 'discovery', 'muse', 'outreach']) {
    assert.ok(kinds.has(required), `no fixture of kind "${required}"`)
  }
  const ids = new Set()
  for (const fixture of fixtures.cases) {
    assert.ok(fixture.id && !ids.has(fixture.id), `duplicate or missing id: ${fixture.id}`)
    ids.add(fixture.id)
    assert.ok(Array.isArray(fixture.appliesTo) && fixture.appliesTo.length, `${fixture.id}: no runners`)
    assert.ok(fixture.input && typeof fixture.input === 'object', `${fixture.id}: no input`)
    assert.ok(fixture.expect && typeof fixture.expect === 'object', `${fixture.id}: no expectations`)
  }
})

test('eval is deterministic across runs (volatile fields excluded)', async () => {
  const first = await runEval(FIXTURES)
  const second = await runEval(FIXTURES)
  assert.deepEqual(first.cases, second.cases)
  assert.deepEqual(first.totals, second.totals)
  assert.deepEqual(first.byRunner, second.byRunner)
})

test('offline suite uses no real network, credentials, or repository database', async () => {
  const realFetch = globalThis.fetch
  const attempted = []
  globalThis.fetch = async (url) => {
    attempted.push(String(url))
    throw new Error(`real network is forbidden in the offline suite (attempted ${url})`)
  }
  // Even if the developer machine holds real provider keys, the offline suite
  // must not see them: scrub the environment for the duration of the run.
  const scrubbed = {}
  for (const key of ['BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_DATASET_ID', 'OPENAI_API_KEY', 'MODEL_API_KEY', 'META_MODEL_API_KEY']) {
    if (process.env[key] !== undefined) { scrubbed[key] = process.env[key]; delete process.env[key] }
  }
  try {
    const report = await runEval(FIXTURES)
    assert.equal(attempted.length, 0)
    assert.equal(report.providerCalls > 0, true)
    assert.equal(report.totals.passed, report.totals.ran)
  } finally {
    globalThis.fetch = realFetch
    Object.assign(process.env, scrubbed)
  }
  const { readFileSync } = await import('node:fs')
  const sources = ['eval.js', 'fakes.js', 'gates.js', 'run.js', 'integration.test.js', 'eval.test.js']
    .map((file) => readFileSync(join(new URL('./', import.meta.url).pathname, file), 'utf8')).join('\n')
  const dbFile = `scoutline${'.db'}`
  assert.ok(!sources.includes(dbFile), 'benchmark must not reference the repository database')
})

test('every gate evaluates to a recorded pass/fail with evidence', async () => {
  const report = await runEval(FIXTURES)
  const gates = checkGates(report)
  assert.equal(gates.length, GATE_DEFINITIONS.length)
  for (const gate of gates) {
    assert.equal(typeof gate.pass, 'boolean')
    assert.ok(gate.detail && gate.detail.length > 8, `${gate.id}: no evidence recorded`)
  }
})

test('report records commit, versions, and denominators — not just a green run', async () => {
  const report = await runEval(FIXTURES)
  assert.equal(report.format, 'scoutline-eval-report')
  assert.equal(report.fixtureVersion, FIXTURE_VERSION)
  assert.ok(report.commit && report.commit !== 'unknown', 'report must record the code commit')
  assert.ok(report.fixtureCases >= 20)
  for (const counts of Object.values(report.byRunner)) {
    assert.ok(counts.ran > 0 && counts.passed <= counts.ran)
  }
})
