import test from 'node:test'
import assert from 'node:assert/strict'
import { canRetryJob, classifyJobError, defaultIdempotencyKey, findTimedOutJobs, isActiveJobStatus, isTerminalJobStatus, jobTimeoutMs, retryDelayMs } from './jobControl.js'

const plain = (label) => {
  assert.ok(!label.includes('_'), `no code fragments in "${label}"`)
  assert.ok(!/ERR[A-Z_]/.test(label), `no error constants in "${label}"`)
}

test('cancellation is terminal, resumable, and never auto-retried', () => {
  const outcome = classifyJobError({ code: 'CANCELLED', message: 'cancelled' })
  assert.equal(outcome.status, 'Cancelled')
  assert.equal(outcome.retryable, true)
  assert.equal(outcome.autoRetry, false)
  plain(outcome.label)
})

test('timeouts are honest and retryable but never silent-retried', () => {
  const outcome = classifyJobError({ code: 'TIMEOUT', message: 'slow' })
  assert.equal(outcome.status, 'Timed out')
  assert.equal(outcome.retryable, true)
  assert.equal(outcome.autoRetry, false)
  plain(outcome.label)
})

test('operational failures are retryable errors with plain copy', () => {
  for (const code of ['FETCH_FAILED', 'DNS_FAILED', 'HTTP_ERROR', 'ARTIFACT_WRITE_FAILED']) {
    const outcome = classifyJobError({ code, message: 'bad' })
    assert.equal(outcome.status, 'Error')
    assert.equal(outcome.retryable, true)
    assert.equal(outcome.autoRetry, true)
    plain(outcome.label)
    plain(outcome.detail)
  }
})

test('provider polling failures resume the same snapshot (ROH-23)', () => {
  for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_FAILED', 'PROVIDER_ERROR', 'BAD_PROVIDER_RESPONSE']) {
    const outcome = classifyJobError({ code, message: 'bad' })
    assert.equal(outcome.status, 'Error')
    assert.equal(outcome.retryable, true)
    assert.match(outcome.detail, /same .*snapshot/i)
    plain(outcome.label)
  }
  const unconfigured = classifyJobError({ code: 'NOT_CONFIGURED', message: 'no key' })
  assert.equal(unconfigured.autoRetry, false)
  assert.equal(unconfigured.retryable, true)
})

test('validation failures are terminal with no retry', () => {
  for (const message of ['Lead not found', 'Unsupported job type: fax', 'A completed website audit is required before AI synthesis']) {
    const outcome = classifyJobError(new Error(message))
    assert.equal(outcome.status, 'Failed')
    assert.equal(outcome.retryable, false)
    assert.equal(outcome.autoRetry, false)
  }
})

test('unknown failures stay retryable rather than stranding work', () => {
  const outcome = classifyJobError(new Error('something odd happened'))
  assert.equal(outcome.status, 'Error')
  assert.equal(outcome.retryable, true)
})

test('manual retry is gated on terminal, retryable-or-cancelled jobs', () => {
  const base = { status: 'Error', payload: { jobOutcome: { code: 'DNS_FAILED', retryable: true } } }
  assert.equal(canRetryJob(base), true)
  assert.equal(canRetryJob({ status: 'Cancelled', payload: {} }), true)
  assert.equal(canRetryJob({ status: 'Completed', payload: {} }), false)
  assert.equal(canRetryJob({ status: 'Running', payload: {} }), false)
  assert.equal(canRetryJob({ status: 'Failed', payload: { jobOutcome: { code: 'VALIDATION', retryable: false } } }), false)
  assert.equal(canRetryJob(null), false)
})

test('watchdog only takes stale running jobs', () => {
  const now = Date.now()
  const jobs = [
    { id: 'old', status: 'Running', payload: { startedAt: new Date(now - 999_999).toISOString() } },
    { id: 'fresh', status: 'Running', payload: { startedAt: new Date(now - 1000).toISOString() } },
    { id: 'done', status: 'Completed', payload: { startedAt: new Date(now - 999_999).toISOString() } },
    { id: 'nostart', status: 'Running', payload: {} },
  ]
  assert.deepEqual(findTimedOutJobs(jobs, now, 600_000).map((job) => job.id), ['old'])
})

test('terminal and active sets partition every status', () => {
  for (const status of ['Queued', 'Waiting', 'Running']) assert.equal(isActiveJobStatus(status), true)
  for (const status of ['Completed', 'Failed', 'Error', 'Timed out', 'Cancelled']) {
    assert.equal(isTerminalJobStatus(status), true)
    assert.equal(isActiveJobStatus(status), false)
  }
  assert.equal(isTerminalJobStatus('Running'), false)
})

test('retry backoff grows 30s → 2m → 8m and caps at 30 minutes', () => {
  const mid = () => 0.5
  assert.equal(retryDelayMs(1, mid), 30_000)
  assert.equal(retryDelayMs(2, mid), 120_000)
  assert.equal(retryDelayMs(3, mid), 480_000)
  assert.equal(retryDelayMs(9, mid), 1_800_000)
  assert.ok(retryDelayMs(1, () => 0) >= 24_000 && retryDelayMs(1, () => 0.999) <= 36_000)
})

test('per-type job timeouts stay under the configured ceiling, except long local scrapes', () => {
  assert.equal(jobTimeoutMs('qualify', { jobTimeoutMs: 600000 }), 300000)
  assert.equal(jobTimeoutMs('audit', { jobTimeoutMs: 120000 }), 120000)
  assert.equal(jobTimeoutMs('local-scrape', { jobTimeoutMs: 600000 }), 2700000)
  assert.equal(jobTimeoutMs('concept', { jobTimeoutMs: 600000 }), 1500000)
  assert.equal(jobTimeoutMs('unknown', {}), 600000)
  const now = Date.now()
  const running = [
    { id: 'q', type: 'qualify', status: 'Running', payload: { startedAt: new Date(now - 400_000).toISOString() } },
    { id: 'l', type: 'local-scrape', status: 'Running', payload: { startedAt: new Date(now - 400_000).toISOString() } },
  ]
  assert.deepEqual(findTimedOutJobs(running, now, (job) => jobTimeoutMs(job.type, {})).map((job) => job.id), ['q'])
})

test('idempotency keys cover lead scans and a run\'s discovery only', () => {
  assert.equal(defaultIdempotencyKey({ type: 'qualify', leadId: 'lead-1' }), 'qualify:lead-1')
  assert.equal(defaultIdempotencyKey({ type: 'visual', leadId: 'lead-1', runId: 'run-1' }), 'visual:lead-1')
  assert.equal(defaultIdempotencyKey({ type: 'discover', runId: 'run-1' }), 'discover:run-1')
  assert.equal(defaultIdempotencyKey({ type: 'audit', leadId: 'lead-1' }), null)
  assert.equal(defaultIdempotencyKey({ type: 'local-scrape' }), null)
})
