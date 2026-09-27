import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from './notify.js'

const quiet = () => {}

test('without Telegram settings alerts are only logged', async () => {
  const lines = []
  const notifier = createNotifier({ env: {}, log: (line) => lines.push(line), fetchImpl: () => assert.fail('must not call out') })
  assert.equal(notifier.configured, false)
  assert.deepEqual(await notifier.send('nightly failed'), { sent: false, reason: 'telegram-not-configured' })
  assert.match(lines[0], /nightly failed/)
})

test('sends to the configured chat and never throws on network errors', async () => {
  const calls = []
  const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' }
  const ok = createNotifier({ env, log: quiet, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true } } })
  assert.deepEqual(await ok.send('0 new leads'), { sent: true })
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage')
  assert.equal(calls[0].body.chat_id, '42')
  assert.match(calls[0].body.text, /^Scoutline: 0 new leads/)
  const down = createNotifier({ env, log: quiet, fetchImpl: async () => { throw new Error('offline') } })
  assert.deepEqual(await down.send('x'), { sent: false, reason: 'network' })
})

test('job failure alerts are throttled to one per 10 minutes and report what was folded', async () => {
  let t = 0
  const texts = []
  const notifier = createNotifier({
    env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' }, log: quiet, now: () => t,
    fetchImpl: async (_url, init) => { texts.push(JSON.parse(init.body).text); return { ok: true } },
  })
  const job = { id: 'job-1', type: 'visual', attempts: 2, maxAttempts: 2, leadId: 'lead-1' }
  t = 1_000_000
  await notifier.jobFailed(job, 'browser crashed')
  t += 60_000
  assert.equal((await notifier.jobFailed(job, 'again')).reason, 'throttled')
  await notifier.jobFailed(job, 'again')
  t += 10 * 60_000
  await notifier.jobFailed(job, 'still failing')
  assert.equal(texts.length, 2)
  assert.match(texts[0], /visual job failed after 2\/2 attempts for lead-1: browser crashed/)
  assert.match(texts[1], /\+2 more since the last alert/)
})
