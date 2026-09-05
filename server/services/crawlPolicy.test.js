import test from 'node:test'
import assert from 'node:assert/strict'
import { CHROME_SAFETY_FLAGS, CRAWL_LIMITS, STOP_REASONS, collectionStopEvidence, createCrawlBounds, isSameSite, splitAllowedUrls, stopReasonLabel } from './crawlPolicy.js'

test('attempt cap stops collection at exactly the configured count', () => {
  const bounds = createCrawlBounds({ maxAttempts: 3 })
  assert.equal(bounds.claimAttempt(), true)
  assert.equal(bounds.claimAttempt(), true)
  assert.equal(bounds.claimAttempt(), true)
  assert.equal(bounds.claimAttempt(), false)
  assert.equal(bounds.state.attempts, 3)
  assert.equal(bounds.state.stoppedBy, STOP_REASONS.ATTEMPT_LIMIT)
})

test('first bound hit wins and later checks keep it', () => {
  const bounds = createCrawlBounds({ maxAttempts: 1, maxTotalBytes: 10 })
  assert.equal(bounds.claimAttempt(), true)
  assert.equal(bounds.addPage(9), true)
  assert.equal(bounds.addPage(9), false)
  assert.equal(bounds.state.stoppedBy, STOP_REASONS.BYTE_LIMIT)
  assert.equal(bounds.checkTime(Date.now() + 10 ** 9), false)
  assert.equal(bounds.state.stoppedBy, STOP_REASONS.BYTE_LIMIT)
})

test('time cap stops long-running collection', () => {
  const bounds = createCrawlBounds({ timeLimitMs: 1000 })
  assert.equal(bounds.checkTime(bounds.state.startedAt + 999), true)
  assert.equal(bounds.checkTime(bounds.state.startedAt + 1001), false)
  assert.equal(bounds.state.stoppedBy, STOP_REASONS.TIME_LIMIT)
})

test('queue overflow is recorded as the stop reason', () => {
  const bounds = createCrawlBounds({ maxQueue: 5 })
  assert.equal(bounds.noteQueue(5), true)
  assert.equal(bounds.noteQueue(6), false)
  assert.equal(bounds.state.stoppedBy, STOP_REASONS.QUEUE_LIMIT)
  assert.equal(bounds.state.queuePeak, 6)
})

test('undefined overrides keep compiled defaults', () => {
  const bounds = createCrawlBounds({ maxAttempts: undefined, timeLimitMs: null })
  assert.equal(bounds.limits.maxAttempts, CRAWL_LIMITS.maxAttempts)
  assert.equal(bounds.limits.timeLimitMs, CRAWL_LIMITS.timeLimitMs)
})

test('robots-disallowed URLs are reported but never passed through', () => {
  const robots = { isAllowed: (href) => !String(href).includes('/private') }
  const urls = [{ href: 'https://a.example/ok' }, { href: 'https://a.example/private' }]
  const { allowed, skipped } = splitAllowedUrls(urls, robots, 'bot')
  assert.deepEqual(allowed.map((u) => u.href), ['https://a.example/ok'])
  assert.deepEqual(skipped.map((u) => u.href), ['https://a.example/private'])
})

test('missing robots object allows everything', () => {
  const urls = [{ href: 'https://a.example/ok' }]
  assert.deepEqual(splitAllowedUrls(urls, null, 'bot').allowed, urls)
})

test('same-site comparison is origin-exact', () => {
  assert.equal(isSameSite('https://a.example:8443/x', 'https://a.example'), false)
  assert.equal(isSameSite('https://a.example/x', 'https://a.example'), true)
  assert.equal(isSameSite('https://evil.example/', 'https://a.example'), false)
  assert.equal(isSameSite('not a url', 'https://a.example'), false)
})

test('stop labels and evidence wording stay honest', () => {
  assert.equal(stopReasonLabel('attempt-limit'), 'attempt limit')
  assert.equal(stopReasonLabel('cancelled'), 'cancellation')
  assert.equal(collectionStopEvidence({ stoppedBy: null }), null)
  assert.equal(
    collectionStopEvidence({ stoppedBy: 'attempt-limit', attempts: 25, pages: 1 }),
    'Collection stopped at the attempt limit (25 attempts, 1 pages kept); remaining candidates were not fetched')
})

test('chrome launches keep the private-network resolver blocklist', () => {
  const rules = CHROME_SAFETY_FLAGS.find((flag) => flag.startsWith('--host-resolver-rules='))
  assert.ok(rules, 'resolver rules flag present')
  for (const blocked of ['localhost', '127.0.0.1', '::1', '10.*', '192.168.*']) {
    assert.ok(rules.includes(blocked), `${blocked} is blocked`)
  }
  assert.ok(CHROME_SAFETY_FLAGS.includes('--disable-background-networking'))
})
