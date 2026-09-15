import test from 'node:test'
import assert from 'node:assert/strict'
import { canRetryJob, classifyJobError, findTimedOutJobs, isActiveJobStatus, isTerminalJobStatus } from './jobControl.js'

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
