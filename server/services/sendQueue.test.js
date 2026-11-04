import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDryRunTransport, createTransport, getMailerConfig } from './mailer.js'
import {
  approveSequences, buildBatch, classifyInbound, composeSequence, enqueueLead, ensureMailSchema, handleInbound, inSendWindow,
  isSuppressed, mailStats, readSequence, rejectSequences, renderEmail, resetDryRun, resolveSending, runSendTick, suppress,
  unsubscribeByToken, updateSequenceDraft, validateSendingPatch,
} from './sendQueue.js'

// Tuesday 2026-11-03 10:00 in Salt Lake City (MST, UTC-7).
const TUESDAY_10AM = new Date('2026-11-03T17:00:00Z')
const minutes = (date, n) => new Date(date.getTime() + n * 60_000)
const days = (date, n) => new Date(date.getTime() + n * 86_400_000)

const mxOk = async () => ({ deliverable: true, mx: 'mx.example.com' })
const mxNone = async () => ({ deliverable: false, reason: 'no MX records' })
const mailer = getMailerConfig({ MAIL_FROM: 'Rohan <rohan@send.goodshigoto.test>', MAIL_PHYSICAL_ADDRESS: '1 Test St, Pune 411001, India', SCOUTLINE_PUBLIC_URL: 'https://scoutline.example.test' })

function setup(overrides = {}) {
  const db = new Database(':memory:')
  ensureMailSchema(db)
  const sending = resolveSending({ enabled: true, dailyCap: 20, minGapMinutes: 4, maxGapMinutes: 4, ...overrides })
  const transport = createDryRunTransport()
  const leads = new Map()
  const events = []
  const ctx = (now, extra = {}) => ({ sending, mailer, transport, now, random: () => 0, readLead: (id) => leads.get(id) || null, onLeadEvent: (id, kind, detail) => events.push({ id, kind, detail }), ...extra })
  return { db, sending, transport, leads, events, ctx }
}

function lead(id, overrides = {}) {
  return {
    id,
    company: `Company ${id}`,
    mainIssue: 'The contact form asks for nine fields before a quote',
    qualification: { play: 'redesign', priority: 80, contact: { email: `owner@${id}.test` }, pitchHooks: [] },
    ...overrides,
  }
}

async function queueApproved(env, id, overrides = {}) {
  const item = lead(id, overrides)
  env.leads.set(id, item)
  const result = await enqueueLead(env.db, item, { sending: env.sending, mxCheck: mxOk })
  assert.equal(result.queued, true, result.reason)
  approveSequences(env.db, [result.sequenceId])
  return result.sequenceId
}

test('dry-run is forced unless MAIL_LIVE=yes, and tests never go live', () => {
  const base = { MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.test', MAIL_PHYSICAL_ADDRESS: 'x' }
  assert.equal(getMailerConfig(base).mode, 'dryrun')
  assert.equal(getMailerConfig({ ...base, MAIL_LIVE: 'yes', NODE_ENV: 'test' }).mode, 'dryrun')
  assert.equal(getMailerConfig({ ...base, MAIL_LIVE: 'yes' }).mode, 'live')
  assert.equal(getMailerConfig({ ...base, MAIL_LIVE: 'yes', MAIL_PHYSICAL_ADDRESS: '' }).mode, 'dryrun', 'no postal address, no live mail')
  assert.equal(getMailerConfig({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' }).mode, 'catcher')
  assert.equal(getMailerConfig({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.real.test', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'a@b.test', MAIL_PHYSICAL_ADDRESS: 'x' }).mode, 'dryrun')
  assert.equal(createTransport(getMailerConfig(base), { log: null }).kind, 'dryrun')
})

test('dry-run logs instead of sending', async () => {
  const env = setup()
  await queueApproved(env, 'a')
  const result = await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  assert.equal(result.status, 'dry-run')
  assert.equal(env.transport.sent.length, 1)
  const row = env.db.prepare('SELECT status, transport FROM mail_messages').get()
  assert.deepEqual(row, { status: 'dry-run', transport: 'dryrun' })
  assert.equal(env.events[0].detail.dryRun, true)
})

test('only MX-confirmed, emailable, uncontacted leads are queued', async () => {
  const env = setup()
  const check = (item, mxCheck = mxOk) => enqueueLead(env.db, item, { sending: env.sending, mxCheck })
  assert.match((await check(lead('nomx'), mxNone)).reason, /not confirmed/)
  assert.match((await check(lead('unknown'), async () => ({ deliverable: null, reason: 'MX lookup failed' }))).reason, /not confirmed/)
  assert.match((await check(lead('noemail', { qualification: { play: 'audit', priority: 50, contact: {} } }))).reason, /No email/)
  assert.match((await check(lead('skip', { qualification: { play: 'skip', priority: 0, contact: { email: 'a@skip.test' } } }))).reason, /skip/)
  assert.match((await check(lead('dnc', { doNotContact: { status: true, reason: 'asked' } }))).reason, /do not contact/)
  assert.match((await check(lead('manual', { contactedAt: '2026-10-01T00:00:00Z' }))).reason, /contacted manually/)
  assert.match((await check(lead('claim', { outreachDraft: 'We guarantee 40% more leads for $500.' }))).reason, /Unverified/)
  assert.equal((await check(lead('good'))).queued, true)
  assert.match((await check(lead('good'))).reason, /Already in the queue/)
  assert.match((await check(lead('twin', { qualification: { play: 'audit', priority: 60, contact: { email: 'office@good.test' } } }))).reason, /already queued/)
})

test('auto-approve only approves leads above the threshold', async () => {
  const env = setup({ autoApprove: true, autoApproveMinPriority: 70 })
  const high = await enqueueLead(env.db, lead('high'), { sending: env.sending, mxCheck: mxOk })
  const low = await enqueueLead(env.db, lead('low', { qualification: { play: 'audit', priority: 40, contact: { email: 'x@low.test' } } }), { sending: env.sending, mxCheck: mxOk })
  assert.equal(high.status, 'approved')
  assert.equal(low.status, 'pending')
})

test('build batch takes the best leads first, up to the batch size', async () => {
  const env = setup({ batchSize: 2 })
  const leads = [lead('p50', { qualification: { play: 'audit', priority: 50, contact: { email: 'a@p50.test' } } }), lead('p90', { qualification: { play: 'redesign', priority: 90, contact: { email: 'a@p90.test' } } }), lead('p70', { qualification: { play: 'redesign', priority: 70, contact: { email: 'a@p70.test' } } })]
  const result = await buildBatch(env.db, leads, { sending: env.sending, mxCheck: mxOk })
  assert.deepEqual(result.queued.map((r) => r.leadId), ['p90', 'p70'])
})

test('pending and rejected emails are never sent', async () => {
  const env = setup()
  env.leads.set('a', lead('a'))
  const queued = await enqueueLead(env.db, lead('a'), { sending: env.sending, mxCheck: mxOk })
  assert.equal((await runSendTick(env.db, env.ctx(TUESDAY_10AM))).skipped, 'empty')
  rejectSequences(env.db, [queued.sequenceId])
  assert.equal(approveSequences(env.db, [queued.sequenceId]), 0)
  assert.equal((await runSendTick(env.db, env.ctx(TUESDAY_10AM))).skipped, 'empty')
  assert.equal(env.transport.sent.length, 0)
})

test('daily cap, spacing and send window are enforced', async () => {
  const env = setup({ dailyCap: 2, minGapMinutes: 5, maxGapMinutes: 5 })
  for (const id of ['a', 'b', 'c']) await queueApproved(env, id)
  assert.equal((await runSendTick(env.db, env.ctx(TUESDAY_10AM))).sent, true)
  assert.equal((await runSendTick(env.db, env.ctx(minutes(TUESDAY_10AM, 2)))).skipped, 'spacing')
  assert.equal((await runSendTick(env.db, env.ctx(minutes(TUESDAY_10AM, 5)))).sent, true)
  assert.equal((await runSendTick(env.db, env.ctx(minutes(TUESDAY_10AM, 30)))).skipped, 'daily-cap')
  // Saturday and 8pm local are outside the window.
  assert.equal(inSendWindow(new Date('2026-11-07T17:00:00Z'), env.sending), false)
  assert.equal(inSendWindow(new Date('2026-11-04T03:00:00Z'), env.sending), false)
  // Next weekday morning the cap resets.
  assert.equal((await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 1)))).sent, true)
  assert.equal(env.transport.sent.length, 3)
})

test('paused queue sends nothing', async () => {
  const env = setup({ enabled: false })
  await queueApproved(env, 'a')
  assert.equal((await runSendTick(env.db, env.ctx(TUESDAY_10AM))).skipped, 'paused')
})

test('follow-ups go out on day 3 and day 7 on the same thread', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  assert.equal((await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 2)))).skipped, 'empty')
  const first = await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 3)))
  assert.equal(first.step, 2)
  const second = await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 7)))
  assert.equal(second.step, 3)
  const [initial, fu1, fu2] = env.transport.sent
  assert.equal(fu1.subject, `Re: ${initial.subject}`)
  assert.equal(fu1.inReplyTo, initial.messageId)
  assert.deepEqual(fu2.references, [initial.messageId, fu1.messageId])
  assert.equal(readSequence(env.db, id).status, 'completed')
  assert.equal((await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 14)))).skipped, 'empty')
})

test('a reply stops the sequence and moves the lead to Replied', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  const initial = env.transport.sent[0]
  const outcome = handleInbound(env.db, { messageId: '<r1@x>', inReplyTo: initial.messageId, references: [initial.messageId], from: 'owner@a.test', subject: `Re: ${initial.subject}`, text: 'Sure, send it over.\n\nOn Tue, Rohan wrote:\n> Hi', headers: {} }, { onLeadEvent: (leadId, kind, detail) => env.events.push({ id: leadId, kind, detail }) })
  assert.deepEqual([outcome.kind, outcome.matched], ['reply', true])
  assert.equal(readSequence(env.db, id).status, 'replied')
  assert.equal(env.events.at(-1).kind, 'replied')
  assert.equal(env.events.at(-1).detail.snippet, 'Sure, send it over.')
  assert.equal((await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 3)))).skipped, 'empty', 'no follow-up after a reply')
  assert.equal(handleInbound(env.db, { messageId: '<r1@x>', from: 'owner@a.test', text: 'dup' }).duplicate, true)
})

test('a reply from the same address without thread headers still matches', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  handleInbound(env.db, { messageId: '<r2@x>', from: 'Owner@A.test', subject: 'website', text: 'Call me', headers: {} })
  assert.equal(readSequence(env.db, id).status, 'replied')
})

test('a lead moved on the board by hand stops its follow-ups', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  env.leads.set('a', { ...env.leads.get('a'), salesStage: 'Meeting' })
  const result = await runSendTick(env.db, env.ctx(days(TUESDAY_10AM, 3)))
  assert.equal(result.skipped, 'stopped')
  assert.equal(readSequence(env.db, id).status, 'stopped')
})

test('hard bounces suppress the address; soft bounces and auto-replies do not stop it', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  const sent = env.transport.sent[0]
  handleInbound(env.db, { messageId: '<ooo@x>', from: 'owner@a.test', subject: 'Automatic reply: out of office', text: 'Back Monday', headers: { 'auto-submitted': 'auto-replied' } })
  handleInbound(env.db, { messageId: '<soft@x>', from: 'MAILER-DAEMON@mx.test', subject: 'Delivery delayed', contentType: 'multipart/report; report-type=delivery-status', text: `Final-Recipient: rfc822; owner@a.test\nStatus: 4.2.2\n\nMessage-ID: ${sent.messageId}`, headers: {} })
  assert.equal(readSequence(env.db, id).status, 'active')
  handleInbound(env.db, { messageId: '<hard@x>', from: 'mailer-daemon@mx.test', subject: 'Undeliverable: hi', text: `Final-Recipient: rfc822; owner@a.test\nStatus: 5.1.1\n\n${sent.messageId}`, headers: {} })
  assert.equal(readSequence(env.db, id).status, 'bounced')
  assert.equal(isSuppressed(env.db, 'owner@a.test'), true)
})

test('opt-out by reply or link suppresses forever', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  handleInbound(env.db, { messageId: '<u@x>', from: 'owner@a.test', subject: 'Re: hi', text: 'Please remove me from your list', headers: {} })
  assert.equal(readSequence(env.db, id).status, 'unsubscribed')
  assert.equal(isSuppressed(env.db, 'owner@a.test'), true)
  // Never queued again, even if the lead is re-imported under another id.
  const again = await enqueueLead(env.db, lead('a2', { qualification: { play: 'redesign', priority: 90, contact: { email: 'OWNER@a.test' } } }), { sending: env.sending, mxCheck: mxOk })
  assert.match(again.reason, /suppression/)

  const id2 = await queueApproved(env, 'b')
  const token = env.db.prepare('SELECT token FROM mail_sequences WHERE id = ?').get(id2).token
  assert.equal(unsubscribeByToken(env.db, token).email, 'owner@b.test')
  assert.equal(readSequence(env.db, id2).status, 'unsubscribed')
  assert.equal(unsubscribeByToken(env.db, 'nope'), null)
})

test('suppressing an address stops anything already queued for it', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  suppress(env.db, 'owner@a.test', 'manual', 'manual')
  assert.equal(readSequence(env.db, id).status, 'stopped')
  assert.equal((await runSendTick(env.db, env.ctx(TUESDAY_10AM))).skipped, 'empty')
})

test('every email carries a postal address and an opt-out', async () => {
  const env = setup()
  await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  const message = env.transport.sent[0]
  assert.match(message.text, /1 Test St, Pune/)
  assert.match(message.text, /Reply "unsubscribe"/)
  assert.match(message.text, /https:\/\/scoutline\.example\.test\/u\//)
  assert.match(message.headers['List-Unsubscribe'], /mailto:rohan@send\.goodshigoto\.test\?subject=unsubscribe/)
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  const noLink = renderEmail('Hi', { sending: env.sending, mailer: { ...mailer, publicUrl: '' }, token: 't' })
  assert.doesNotMatch(noLink, /one click/)
})

test('follow-ups are evidence-only and edits are checked for invented claims', async () => {
  const composed = composeSequence(lead('a'))
  assert.match(composed.followups[0], /contact form asks for nine fields/)
  assert.equal(composed.followups.length, 2)
  const env = setup()
  const id = await queueApproved(env, 'a')
  assert.throws(() => updateSequenceDraft(env.db, id, { body: 'This will double your sales leads.' }), /Unverified/)
  assert.equal(updateSequenceDraft(env.db, id, { subject: 'Your quote form' }).subject, 'Your quote form')
})

test('bounce guard pauses sending when more than 5% bounce', async () => {
  const env = setup({ dailyCap: 50, minGapMinutes: 1, maxGapMinutes: 1 })
  for (let i = 0; i < 20; i += 1) await queueApproved(env, `l${i}`)
  for (let i = 0; i < 20; i += 1) await runSendTick(env.db, env.ctx(minutes(TUESDAY_10AM, i)))
  await queueApproved(env, 'next')
  for (const id of ['l0', 'l1']) handleInbound(env.db, { messageId: `<b-${id}@x>`, from: 'mailer-daemon@x.test', subject: 'Undeliverable', text: `Final-Recipient: rfc822; owner@${id}.test\nStatus: 5.1.1`, headers: {} })
  assert.equal((await runSendTick(env.db, env.ctx(minutes(TUESDAY_10AM, 30)))).skipped, 'bounce-guard')
  assert.equal(mailStats(env.db, { sending: env.sending, now: TUESDAY_10AM }).bounceGuard, true)
})

test('resetting dry-run returns simulated sequences to review', async () => {
  const env = setup()
  const id = await queueApproved(env, 'a')
  await runSendTick(env.db, env.ctx(TUESDAY_10AM))
  assert.deepEqual(resetDryRun(env.db), { sequences: 1, messages: 1 })
  const seq = readSequence(env.db, id)
  assert.deepEqual([seq.status, seq.step], ['pending', 0])
})

test('classifier separates replies, opt-outs, auto-replies and bounces', () => {
  assert.equal(classifyInbound({ from: 'a@b.test', subject: 'Re: x', text: 'Yes please' }).kind, 'reply')
  assert.equal(classifyInbound({ from: 'a@b.test', subject: 'unsubscribe', text: '' }).kind, 'unsubscribe')
  assert.equal(classifyInbound({ from: 'a@b.test', subject: 'Re: x', text: 'Sounds good\n> unsubscribe link below' }).kind, 'reply', 'quoted footer text is not an opt-out')
  assert.equal(classifyInbound({ from: 'a@b.test', subject: 'Out of Office', text: '' }).kind, 'auto-reply')
  assert.equal(classifyInbound({ from: 'postmaster@b.test', subject: 'Returned mail', text: 'Status: 5.0.0' }).kind, 'bounce')
})

test('sending settings are validated and clamped', () => {
  assert.equal(validateSendingPatch({ dailyCap: 500 })[0].field, 'dailyCap')
  assert.equal(validateSendingPatch({ nope: 1 })[0].field, 'nope')
  assert.equal(validateSendingPatch({ timezone: 'Mars/Base' })[0].field, 'timezone')
  assert.deepEqual(validateSendingPatch({ dailyCap: 25, autoApprove: true }), [])
  const resolved = resolveSending({ minGapMinutes: 10, maxGapMinutes: 2 })
  assert.equal(resolved.maxGapMinutes, 10)
  assert.equal(resolveSending({}).dailyCap, 20)
})
