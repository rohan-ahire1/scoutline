import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createAutopilot } from './autopilot.js'
import { contentHash, DEFAULT_AUTOPILOT } from './sender.js'

const SIGNATURE = 'Rohan Ahire\nGoodShigoto\n123 Main St, Salt Lake City, UT 84101'

function makeLead(id, priority, overrides = {}) {
  return {
    id,
    businessId: `biz-${id}`,
    company: `${id.toUpperCase()} Roofing`,
    category: 'Roofer',
    website: `https://${id}-roofing.com/`,
    market: 'slc',
    qualification: {
      play: 'redesign',
      priority,
      pitchHooks: ['The phone number is tiny and hard to find'],
      contact: { email: `owner@${id}-roofing.com`, ownerName: 'Sam Lee' },
    },
    ...overrides,
  }
}

function setup({ leads = [], start = '2026-10-13T12:00:00Z' } = {}) {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const store = new Map(leads.map((lead) => [lead.id, lead]))
  const clock = { now: Date.parse(start) }
  const sent = []
  const notes = []
  const mailbox = {
    configured: true,
    user: 'rohan@goodshigoto.com',
    inbox: { replies: [], bounces: [] },
    fail: null,
    async send(message) {
      if (this.fail) throw new Error(this.fail)
      sent.push({ ...message, at: clock.now })
      return { messageId: `<m${sent.length}@goodshigoto.com>`, response: '250 OK' }
    },
    async scan() { return this.inbox },
  }
  const autopilot = createAutopilot({
    db,
    mailbox,
    readLead: (id) => store.get(id) || null,
    saveLead: (lead) => { store.set(lead.id, lead); return lead },
    readLeads: () => [...store.values()],
    notifier: { send: (text) => notes.push(text) },
    now: () => clock.now,
    checkMx: async (email) => !email.includes('dead'),
    log: { error() {} },
  })
  return { db, store, clock, sent, notes, mailbox, autopilot }
}

function approveAndRun(autopilot, patch = {}) {
  const config = autopilot.saveTemplates({ signature: SIGNATURE })
  autopilot.saveSchedule(patch)
  autopilot.approve(contentHash(config))
  autopilot.setRunning(true)
}

// Runs the minute loop until `until`, like the worker does.
async function runUntil(env, until) {
  const end = Date.parse(until)
  while (env.clock.now < end) {
    await env.autopilot.tick()
    env.clock.now += 60_000
  }
}

test('nothing is planned or sent until the templates are approved', async () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.equal(env.sent.length, 0)
  assert.throws(() => env.autopilot.setRunning(true), /Approve the templates/)
  assert.throws(() => env.autopilot.approve(contentHash(env.autopilot.readConfig())), /postal address/)
})

test('editing approved templates pauses sending until approved again', () => {
  const env = setup()
  approveAndRun(env.autopilot)
  assert.equal(env.autopilot.readConfig().running, true)
  const sequence = env.autopilot.readConfig().sequence.map((step, i) => (i === 1 ? { ...step, body: step.body.replace('buried', 'lost') } : step))
  const config = env.autopilot.saveTemplates({ sequence })
  assert.equal(config.running, false)
  assert.equal(config.approvedHash, null)
  assert.throws(() => env.autopilot.approve('stale'), /changed since you reviewed/)
})

test('sends the day batch inside the morning window, best leads first, then follows up', async () => {
  const leads = [makeLead('a', 60), makeLead('b', 90), makeLead('c', 70), makeLead('dead', 95)]
  const env = setup({ leads })
  approveAndRun(env.autopilot, { dailyNew: 2 })
  // Tue 06:00 Denver → plans Tuesday and sends both before 09:30.
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.deepEqual(env.sent.map((item) => item.to), ['owner@b-roofing.com', 'owner@c-roofing.com'])
  for (const item of env.sent) {
    const minutes = new Date(item.at).getUTCHours() * 60 + new Date(item.at).getUTCMinutes() - 6 * 60 // Denver is UTC-6 in October
    assert.ok(minutes >= 7 * 60 && minutes < 9 * 60 + 30, `sent at ${new Date(item.at).toISOString()}`)
  }
  assert.equal(env.sent[0].subject, 'Idea for B Roofing')
  assert.match(env.sent[0].text, /^Hi Sam,/)
  const skippedDead = env.db.prepare("SELECT status, reason FROM autopilot_emails WHERE email LIKE '%dead%'").get()
  assert.equal(skippedDead.status, 'skipped')
  // The lead records the send.
  const b = env.store.get('b')
  assert.equal(b.autopilot.status, 'emailed')
  assert.match(b.contactAttempts[0].notes, /Email 1 sent/)

  // Wednesday plans "a" as a new email. Follow-ups wait 3 days.
  await runUntil(env, '2026-10-16T12:00:00Z')
  assert.deepEqual(env.sent.map((item) => item.to).slice(2), ['owner@a-roofing.com'])
  // Friday morning: follow-up 1 for b and c, threaded on email 1.
  await runUntil(env, '2026-10-16T16:00:00Z')
  const followUps = env.sent.filter((item) => item.subject.startsWith('Re: '))
  assert.equal(followUps.length, 2)
  assert.equal(followUps[0].inReplyTo, '<m1@goodshigoto.com>')
})

test('a reply stops the sequence and moves the lead to Replied', async () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  approveAndRun(env.autopilot, { dailyNew: 1 })
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.equal(env.sent.length, 1)
  env.mailbox.inbox = {
    replies: [{ uid: 7, from: 'owner@a-roofing.com', subject: 'Re: Idea for A Roofing', date: '2026-10-13T20:00:00Z', headers: '', text: 'Sure, send it over' }],
    bounces: [],
  }
  await runUntil(env, '2026-10-20T16:00:00Z')
  assert.equal(env.sent.length, 1, 'no follow-up after a reply')
  const lead = env.store.get('a')
  assert.equal(lead.salesStage, 'Replied')
  assert.equal(lead.autopilot.status, 'replied')
  assert.equal(env.notes.length, 1)
})

test('auto-replies are ignored and "no" opts the lead out', async () => {
  const env = setup({ leads: [makeLead('a', 80), makeLead('b', 70)] })
  approveAndRun(env.autopilot, { dailyNew: 2 })
  await runUntil(env, '2026-10-13T16:00:00Z')
  env.mailbox.inbox = {
    replies: [
      { uid: 1, from: 'owner@a-roofing.com', subject: 'Out of office', date: '2026-10-13T20:00:00Z', headers: 'Auto-Submitted: auto-replied\r\n', text: 'I am away' },
      { uid: 2, from: 'owner@b-roofing.com', subject: 'Re: Idea', date: '2026-10-13T20:00:00Z', headers: '', text: 'No thanks' },
    ],
    bounces: [],
  }
  await runUntil(env, '2026-10-16T16:00:00Z')
  const statuses = Object.fromEntries(env.db.prepare('SELECT email, status FROM autopilot_emails').all().map((row) => [row.email, row.status]))
  assert.equal(statuses['owner@a-roofing.com'], 'active')
  assert.equal(statuses['owner@b-roofing.com'], 'opted-out')
  assert.equal(env.sent.filter((item) => item.to === 'owner@b-roofing.com').length, 1)
  assert.equal(env.store.get('b').salesStage, undefined)
})

test('too many bounces pause the autopilot', async () => {
  const leads = Array.from({ length: 10 }, (_, i) => makeLead(`l${i}`, 50 + i))
  const env = setup({ leads })
  approveAndRun(env.autopilot, { dailyNew: 10 })
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.equal(env.sent.length, 10)
  env.mailbox.inbox = {
    replies: [],
    bounces: [{ uid: 9, from: 'mailer-daemon@googlemail.com', date: '2026-10-13T20:00:00Z', headers: 'X-Failed-Recipients: owner@l1-roofing.com\r\n', text: '' }],
  }
  await env.autopilot.scan({ force: true })
  assert.equal(env.autopilot.readConfig().running, false)
  assert.match(env.notes[0], /bounced/)
})

test('a Gmail login failure pauses and alerts', async () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  approveAndRun(env.autopilot, { dailyNew: 1 })
  env.mailbox.fail = '535-5.7.8 Username and Password not accepted'
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.equal(env.autopilot.readConfig().running, false)
  assert.match(env.notes[0], /Gmail refused the login/)
  const row = env.db.prepare('SELECT status, attempts FROM autopilot_emails').get()
  assert.equal(row.status, 'queued')
  assert.equal(row.attempts, 1)
})

test('an interrupted send is parked, never resent', () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  env.db.prepare(`INSERT INTO autopilot_emails (id, lead_id, email, status, step, time_zone, created_at, updated_at)
    VALUES ('x', 'a', 'owner@a-roofing.com', 'sending', 0, 'America/Denver', 'now', 'now')`).run()
  env.autopilot.recoverInterrupted()
  assert.equal(env.autopilot.getRow('x').status, 'failed')
})

test('skipping a queued email plans a replacement', async () => {
  const env = setup({ leads: [makeLead('a', 80), makeLead('b', 70)], start: '2026-10-13T10:00:00Z' })
  approveAndRun(env.autopilot, { dailyNew: 1 })
  await env.autopilot.tick()
  const queued = env.db.prepare("SELECT id, lead_id FROM autopilot_emails WHERE status = 'queued'").all()
  assert.deepEqual(queued.map((row) => row.lead_id), ['a'])
  env.autopilot.skip(queued[0].id)
  await runUntil(env, '2026-10-13T16:00:00Z')
  assert.deepEqual(env.sent.map((item) => item.to), ['owner@b-roofing.com'])
})

test('overview shows who is next before the day is planned', () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  const view = env.autopilot.overview()
  assert.equal(view.config.approved, false)
  assert.equal(view.nextUp.length, 1)
  assert.equal(view.nextUp[0].preview.subject, 'Idea for A Roofing')
  assert.equal(view.stats.eligible, 1)
  assert.ok(DEFAULT_AUTOPILOT.sequence.length >= 2)
})

test('draft preview renders unsaved edits without saving them', () => {
  const env = setup({ leads: [makeLead('a', 80)] })
  const sequence = env.autopilot.readConfig().sequence.map((step, i) => (i === 0 ? { ...step, subject: 'Quick idea for {{company}}' } : step))
  const result = env.autopilot.previewDraft({ sequence, signature: SIGNATURE, step: 0 })
  assert.equal(result.email.subject, 'Quick idea for A Roofing')
  assert.deepEqual(result.problems, [])
  assert.equal(env.autopilot.readConfig().sequence[0].subject, 'Idea for {{company}}')
  const broken = env.autopilot.previewDraft({ sequence: [{ ...sequence[0], body: 'Hi {{nickname}} {{signature}}' }], step: 0 })
  assert.ok(broken.error || broken.problems.length)
})
