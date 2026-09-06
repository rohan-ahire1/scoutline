// Offline quality-benchmark runner (ROH-26). Runs every fixture through the
// real service functions with fake transports only. No network, no credentials,
// no billing. Volatile fields (timestamps) are stripped before comparison so
// repeated runs are byte-identical.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { analyzeHtml, classifyCapture, fetchPublicText } from '../services/audit.js'
import { describeGeographyCoverage, mapDiscoveryRecord, reconcileRecords } from '../services/discovery.js'
import { validateMuseAnalysis } from '../services/insights.js'
import { assertNoInventedClaims } from '../services/outreach.js'
import { createFakeFetch, withFakeFetch } from './fakes.js'

export const EVAL_FORMAT = 'scoutline-eval-report'
export const FIXTURE_VERSION = 1

export function loadFixtures(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed.format !== 'scoutline-eval-fixtures' || parsed.version !== FIXTURE_VERSION || !Array.isArray(parsed.cases)) {
    throw new Error(`Unsupported fixtures file (expected format scoutline-eval-fixtures v${FIXTURE_VERSION})`)
  }
  return parsed
}

function mentions(haystack, needles = []) {
  return (needles || []).filter((needle) => !String(haystack).includes(needle))
}

function checkClassifyCapture(cases) {
  const { input, expect } = cases
  const got = classifyCapture({ text: input.html, contentType: input.contentType || '', url: new URL(input.url) })
  const pass = got.quality === expect.captureQuality
  return { pass, detail: pass ? `quality=${got.quality}` : `expected ${expect.captureQuality}, got ${got.quality}` }
}

function auditText(result) {
  return [...(result.problems || []), ...(result.evidence || [])].join('\n')
}

function checkAnalyzeHtml(cases) {
  const { input, expect } = cases
  const got = analyzeHtml(input.html, new URL(input.url), null, { contentType: input.contentType || '' })
  const failures = []
  if (expect.researchStatus && got.researchStatus !== expect.researchStatus) failures.push(`status: expected ${expect.researchStatus}, got ${got.researchStatus}`)
  if (expect.minProblems != null && (got.problems || []).length < expect.minProblems) failures.push(`problems: expected >= ${expect.minProblems}, got ${got.problems.length}`)
  const text = auditText(got)
  for (const missing of mentions(text, expect.mustMention)) failures.push(`missing expected copy: "${missing}"`)
  for (const present of (expect.mustNotMention || []).filter((needle) => text.includes(needle))) failures.push(`forbidden copy present: "${present}"`)
  return { pass: failures.length === 0, detail: failures.join('; ') || `status=${got.researchStatus} problems=${got.problems.length}` }
}

async function checkFetchBehavior(cases, stats) {
  const { input, expect } = cases
  const fake = createFakeFetch({ '*': input.route })
  // DNS never leaves the machine: fixture hosts resolve to a documentation IP
  // and HTTP is fully scripted, so the offline suite needs no real network.
  // dnsFail fixtures exercise the real unresolvable-host path instead.
  const dnsLookup = input.dnsFail
    ? async (hostname) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }) }
    : async () => [{ address: '192.0.2.1', family: 4 }]
  const outcome = await withFakeFetch(fake, async () => {
    try {
      const got = await fetchPublicText(input.url, { timeoutMs: input.timeoutMs ?? 12_000, dnsLookup })
      return { ok: true, finalUrl: String(got.url?.href || got.url), redirects: got.redirects }
    } catch (error) {
      return { ok: false, errorCode: error.code || error.name, message: error.message }
    }
  })
  stats.providerCalls += fake.ledger.length
  const failures = []
  if (Boolean(outcome.ok) !== Boolean(expect.ok)) failures.push(`ok: expected ${expect.ok}, got ${outcome.ok}`)
  if (expect.ok) {
    if (expect.finalUrl && outcome.finalUrl !== expect.finalUrl) failures.push(`finalUrl: expected ${expect.finalUrl}, got ${outcome.finalUrl}`)
    if (expect.redirects != null && outcome.redirects !== expect.redirects) failures.push(`redirects: expected ${expect.redirects}, got ${outcome.redirects}`)
  } else {
    if (expect.errorCode && outcome.errorCode !== expect.errorCode) failures.push(`errorCode: expected ${expect.errorCode}, got ${outcome.errorCode} (${outcome.message})`)
    for (const missing of mentions(outcome.message || '', expect.mustMention)) failures.push(`error missing copy: "${missing}"`)
    for (const present of (expect.mustNotMention || []).filter((needle) => String(outcome.message || '').toLowerCase().includes(String(needle).toLowerCase()))) {
      failures.push(`error frames failure as "${present}": ${outcome.message}`)
    }
  }
  return { pass: failures.length === 0, detail: failures.join('; ') || (outcome.ok ? `final=${outcome.finalUrl} redirects=${outcome.redirects}` : `code=${outcome.errorCode}`) }
}

function checkDiscoveryMapping(cases) {
  const { input, expect } = cases
  const failures = []
  if (input.record) {
    const got = mapDiscoveryRecord(input.record)
    if (!expect.mapped && got !== null) failures.push(`expected unmapped, got ${got.company}`)
    if (expect.mapped && !got) failures.push('expected a mapped record, got null')
    if (expect.mapped && got) {
      for (const field of ['company', 'website', 'category']) {
        if (expect[field] != null && got[field] !== expect[field]) failures.push(`${field}: expected ${expect[field]}, got ${got[field]}`)
      }
    }
  }
  if (input.records) {
    const mapped = input.records.map((record) => mapDiscoveryRecord(record)).filter(Boolean)
    const coverage = JSON.stringify(describeGeographyCoverage(input.search, mapped))
    for (const missing of mentions(coverage, expect.coverageMentions)) failures.push(`coverage missing: "${missing}"`)
    const reconciled = reconcileRecords(input.records)
    if (expect.returned != null && reconciled.returned !== expect.returned) failures.push(`returned: expected ${expect.returned}, got ${reconciled.returned}`)
    if (expect.retained != null && reconciled.retained.length !== expect.retained) failures.push(`retained: expected ${expect.retained}, got ${reconciled.retained.length}`)
  }
  return { pass: failures.length === 0, detail: failures.join('; ') || 'mapping matches' }
}

function checkDiscoveryDedupe(cases) {
  const { input, expect } = cases
  const got = reconcileRecords(input.records)
  const failures = []
  if (expect.returned != null && got.returned !== expect.returned) failures.push(`returned: expected ${expect.returned}, got ${got.returned}`)
  if (expect.retained != null && got.retained.length !== expect.retained) failures.push(`retained: expected ${expect.retained}, got ${got.retained.length}`)
  if (expect.rejectedDuplicates != null && got.duplicates !== expect.rejectedDuplicates) failures.push(`duplicates: expected ${expect.rejectedDuplicates}, got ${got.duplicates}`)
  if (expect.rejectedUnusable != null && got.unusable !== expect.rejectedUnusable) failures.push(`unusable: expected ${expect.rejectedUnusable}, got ${got.unusable}`)
  return { pass: failures.length === 0, detail: failures.join('; ') || `returned=${got.returned} retained=${got.retained.length} duplicates=${got.duplicates}` }
}

function checkMuseGrounding(cases) {
  const { input, expect } = cases
  try {
    validateMuseAnalysis(input.analysis, { observations: input.observations || [] })
    if (!expect.valid) return { pass: false, detail: 'expected rejection, analysis passed validation' }
    return { pass: true, detail: 'grounded analysis accepted' }
  } catch (error) {
    if (expect.valid) return { pass: false, detail: `expected acceptance, rejected: ${error.message}` }
    const match = !expect.errorMatch || new RegExp(expect.errorMatch, 'i').test(error.message)
    return { pass: match, detail: match ? `rejected as expected: ${error.message.slice(0, 120)}` : `wrong rejection reason: ${error.message}` }
  }
}

function checkOutreachGrounding(cases) {
  const { input, expect } = cases
  try {
    assertNoInventedClaims(input.text, 'eval-fixture')
    if (!expect.valid) return { pass: false, detail: 'expected rejection, claim passed' }
    return { pass: true, detail: 'grounded copy accepted' }
  } catch (error) {
    if (expect.valid) return { pass: false, detail: `expected acceptance, rejected: ${error.message}` }
    const match = !expect.errorMatch || new RegExp(expect.errorMatch, 'i').test(error.message)
    return { pass: match, detail: match ? `rejected as expected: ${error.message.slice(0, 120)}` : `wrong rejection reason: ${error.message}` }
  }
}

const RUNNERS = {
  classifyCapture: (c, stats) => checkClassifyCapture(c),
  analyzeHtml: (c, stats) => checkAnalyzeHtml(c),
  fetchBehavior: (c, stats) => checkFetchBehavior(c, stats),
  discoveryMapping: (c, stats) => checkDiscoveryMapping(c),
  discoveryDedupe: (c, stats) => checkDiscoveryDedupe(c),
  museGrounding: (c, stats) => checkMuseGrounding(c),
  outreachGrounding: (c, stats) => checkOutreachGrounding(c),
}

function currentCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export async function runEval(fixturesPath) {
  const startedAt = Date.now()
  const fixtures = loadFixtures(fixturesPath)
  const stats = { providerCalls: 0 }
  const cases = []
  for (const fixture of fixtures.cases) {
    for (const runner of fixture.appliesTo || []) {
      const run = RUNNERS[runner]
      if (!run) {
        cases.push({ id: fixture.id, runner, pass: false, detail: `unknown runner "${runner}"` })
        continue
      }
      try {
        const result = await run(fixture, stats)
        cases.push({ id: fixture.id, runner, pass: result.pass, detail: result.detail })
      } catch (error) {
        cases.push({ id: fixture.id, runner, pass: false, detail: `runner crashed: ${error.message}` })
      }
    }
  }
  const byRunner = {}
  for (const item of cases) {
    byRunner[item.runner] = byRunner[item.runner] || { ran: 0, passed: 0 }
    byRunner[item.runner].ran += 1
    if (item.pass) byRunner[item.runner].passed += 1
  }
  return {
    format: EVAL_FORMAT,
    fixtureVersion: fixtures.version,
    fixtureCases: fixtures.cases.length,
    commit: currentCommit(),
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    totals: { ran: cases.length, passed: cases.filter((item) => item.pass).length },
    byRunner,
    providerCalls: stats.providerCalls,
    cases,
  }
}

// Reports record failures, not only green exit statuses (ROH-26 acceptance).
export function renderMarkdownReport(report) {
  const lines = [
    '# Scoutline offline quality benchmark',
    '',
    `- Fixtures: v${report.fixtureVersion} (${report.fixtureCases} cases, ${report.totals.ran} checks)`,
    `- Commit: ${report.commit} · generated ${report.generatedAt} · ${report.latencyMs}ms`,
    `- Passed: **${report.totals.passed}/${report.totals.ran}** · fake provider calls: ${report.providerCalls}`,
    '',
    '## By area (explicit denominators)',
    '',
  ]
  for (const [runner, counts] of Object.entries(report.byRunner)) {
    lines.push(`- ${runner}: ${counts.passed}/${counts.ran}`)
  }
  const failed = report.cases.filter((item) => !item.pass)
  lines.push('', failed.length ? '## Failing checks' : '## Failing checks (none)')
  lines.push('')
  for (const item of failed) lines.push(`- [ ] ${item.id} / ${item.runner}: ${item.detail}`)
  if (!failed.length) lines.push('No failing checks.')
  lines.push(
    '',
    '## Limitations',
    '',
    '- Offline fixtures only: no live provider, model, or browser involved. A green board does not prove production quality.',
    '- Fixture authors choose the cases; coverage is bounded by the 22 cases in fixtures v1 (static/JS/challenge/empty/multi-form/redirect/timeout/HTTP-500/DNS/discovery/muse/outreach).',
    '- Latency is harness-local (pure functions + fakes), not production latency.',
    '- Provider-call counts come from the scripted fakes, not real billing.',
    '',
  )
  return lines.join('\n')
}

export function writeEvalReports(report, dir) {
  writeFileSync(`${dir}/eval-report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(`${dir}/eval-report.md`, renderMarkdownReport(report), 'utf8')
  return [`${dir}/eval-report.json`, `${dir}/eval-report.md`]
}
