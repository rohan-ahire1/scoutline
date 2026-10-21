import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bounceGuard, bouncedAddresses, cleanCompany, contentHash, DEFAULT_AUTOPILOT, followUpAt, ineligibleReason, inWindow, isApproved,
  isAutoReply, isOptOut, localDay, nextSendDay, nextWindowAt, pickNewLeads, pickObservation, planSlots, renderStep, templateProblems, zonedTime,
} from './sender.js'

const TZ = 'America/Denver'
const signed = { ...DEFAULT_AUTOPILOT, signature: 'Rohan Ahire\nExample Studio\n123 Main St, Salt Lake City, UT 84101' }

function lead(overrides = {}) {
  return {
    id: 'lead-1',
    company: 'Epic Electric - Salt Lake City | Electrical Contractor',
    category: 'Electrician',
    location: '1895 E Rodeo Walk Dr Ste B200, Sandy, UT 84070, United States',
    website: 'https://www.epicelectric.co/',
    market: 'slc',
    qualification: {
      play: 'redesign',
      priority: 80,
      pitchHooks: [
        'Footer copyright is out of date (© 2013)',
        'The circular back-to-top arrow sits on top of the words Electrician in Salt Lake City (mobile)',
        'The big mint-green welcome headline is so pale and thin it is hard to read',
      ],
      contact: { email: 'Office@EpicElectric.co', ownerName: 'Josh Asher' },
    },
    ...overrides,
  }
}

test('company names lose SEO tails and legal suffixes', () => {
  assert.equal(cleanCompany('Epic Electric - Salt Lake City | Electrical Contractor'), 'Epic Electric')
  assert.equal(cleanCompany('Nexgen Roofing | Roofing, Siding & Gutters'), 'Nexgen Roofing')
  assert.equal(cleanCompany('Roof-It, Inc.'), 'Roof-It')
  assert.equal(cleanCompany('Valley Home Services LLC'), 'Valley Home Services')
})

test('the opening observation prefers a plain visual hook over technical ones', () => {
  assert.equal(pickObservation(lead()), "the big mint-green welcome headline is so pale and thin it's hard to read.")
  const mobileOnly = lead({ qualification: { ...lead().qualification, pitchHooks: ['Uses spacer GIFs for layout (16 spacer images)', 'The chat bubble covers the Call button (mobile)'] } })
  assert.equal(pickObservation(mobileOnly), 'on phones, the chat bubble covers the Call button.')
  const technical = lead({ qualification: { ...lead().qualification, pitchHooks: ['Uses deprecated HTML (font/center/marquee) (13 deprecated elements)'] } })
  assert.equal(pickObservation(technical), null)
})

test('renders the first email with the lead fields and a reply-threaded follow-up', () => {
  const first = renderStep(signed, 0, lead())
  assert.equal(first.subject, 'Idea for Epic Electric')
  assert.match(first.text, /^Hi Josh,/)
  assert.match(first.text, /looking at epicelectric\.co and noticed something: the big mint-green/)
  assert.match(first.text, /123 Main St/)
  const second = renderStep(signed, 1, lead())
  assert.equal(second.subject, 'Re: Idea for Epic Electric')
  const noOwner = renderStep(signed, 0, lead({ qualification: { ...lead().qualification, contact: { email: 'a@b.co', ownerName: null } } }))
  assert.match(noOwner.text, /^Hi there,/)
})

test('per-email overrides replace the observation', () => {
  const email = renderStep(signed, 0, lead(), { overrides: { observation: 'your phone number is hidden on mobile.' } })
  assert.match(email.text, /noticed something: your phone number is hidden on mobile\./)
})

test('approval needs a postal address and is lost on any edit', () => {
  assert.ok(templateProblems(DEFAULT_AUTOPILOT).some((p) => /postal address/.test(p)))
  assert.deepEqual(templateProblems(signed), [])
  const approved = { ...signed, approvedHash: contentHash(signed) }
  assert.equal(isApproved(approved), true)
  const edited = { ...approved, signature: `${signed.signature}!` }
  assert.equal(isApproved(edited), false)
  const unknown = { ...signed, sequence: [{ ...signed.sequence[0], body: 'Hi {{nickname}} {{signature}}' }] }
  assert.ok(templateProblems(unknown).some((p) => /nickname/.test(p)))
  const claims = { ...signed, sequence: [{ ...signed.sequence[0], body: 'We guarantee results {{signature}}' }] }
  assert.ok(templateProblems(claims).some((p) => /guarantee/.test(p)))
})

test('lead picking skips emailed, suppressed, skip-play and duplicate businesses', () => {
  const leads = [
    lead({ id: 'a', qualification: { ...lead().qualification, priority: 50, contact: { email: 'a@x.com' } } }),
    lead({ id: 'b', qualification: { ...lead().qualification, priority: 90, contact: { email: 'b@x.com' } } }),
    lead({ id: 'b2', qualification: { ...lead().qualification, priority: 85, contact: { email: 'b@x.com' } } }),
    lead({ id: 'c', qualification: { ...lead().qualification, play: 'skip', contact: { email: 'c@x.com' } } }),
    lead({ id: 'd', qualification: { ...lead().qualification, contact: { email: 'noreply@x.com' } } }),
    lead({ id: 'e', qualification: { ...lead().qualification, contact: { email: 'e@x.com' } }, salesStage: 'Replied' }),
    lead({ id: 'f', qualification: { ...lead().qualification, contact: { email: 'f@x.com' } } }),
  ].map((item, index) => ({ ...item, businessId: `biz-${index}` }))
  const picked = pickNewLeads(leads, { limit: 10, suppressed: new Set(['f@x.com']) })
  assert.deepEqual(picked.map((item) => item.id), ['b', 'a'])
  assert.equal(ineligibleReason(leads[3]), 'Play is skip')
  assert.equal(ineligibleReason(leads[5]), 'Already in conversation')
})

test('slots fall inside the morning window in the lead time zone, spaced apart', () => {
  const day = '2026-10-14' // a Wednesday
  const slots = planSlots(day, 10, { timeZone: TZ, seed: 'x' })
  assert.equal(slots.length, 10)
  const start = zonedTime(day, 7 * 60, TZ)
  const end = zonedTime(day, 9 * 60 + 30, TZ)
  assert.equal(new Date(start).toISOString(), '2026-10-14T13:00:00.000Z')
  for (let i = 0; i < slots.length; i += 1) {
    assert.ok(slots[i] >= start && slots[i] <= end, `slot ${i} in window`)
    if (i) assert.ok(slots[i] - slots[i - 1] >= 6 * 60_000, 'at least 6 minutes apart')
  }
  assert.deepEqual(planSlots(day, 10, { timeZone: TZ, seed: 'x' }), slots, 'deterministic')
})

test('weekends and closed windows roll to the next weekday', () => {
  assert.equal(nextSendDay('2026-10-17', undefined, { timeZone: TZ }), '2026-10-19') // Sat → Mon
  const afterWindow = Date.parse('2026-10-14T17:00:00Z') // 11:00 Denver
  assert.equal(nextSendDay(localDay(afterWindow, TZ), undefined, { now: afterWindow, timeZone: TZ }), '2026-10-15')
  assert.equal(inWindow(Date.parse('2026-10-14T14:00:00Z'), undefined, TZ), true)
  assert.equal(inWindow(afterWindow, undefined, TZ), false)
  assert.equal(new Date(nextWindowAt(afterWindow, undefined, TZ, 10)).toISOString(), '2026-10-15T13:10:00.000Z')
})

test('follow-ups land on a weekday morning after the delay', () => {
  const first = Date.parse('2026-10-15T13:20:00Z') // Thu 07:20 Denver
  const due = followUpAt(first, 3, { timeZone: TZ, now: first })
  assert.equal(new Date(due).toISOString(), '2026-10-19T13:20:00.000Z') // Sun → Mon, same time
})

test('daylight saving change keeps the local time', () => {
  // US clocks go back on 2026-11-01.
  assert.equal(new Date(zonedTime('2026-11-02', 7 * 60, TZ)).toISOString(), '2026-11-02T14:00:00.000Z')
})

test('reply classification', () => {
  assert.equal(isAutoReply({ subject: 'Automatic reply: Idea for Epic Electric' }), true)
  assert.equal(isAutoReply({ subject: 'Re: Idea', headers: 'Auto-Submitted: auto-replied\r\n' }), true)
  assert.equal(isAutoReply({ subject: 'Re: Idea for Epic Electric' }), false)
  assert.equal(isOptOut('No thanks\n\nOn Tue, Rohan wrote:\n> Hi'), true)
  assert.equal(isOptOut('Please remove me from your list'), true)
  assert.equal(isOptOut('Sure, send it over! No rush.'), false)
})

test('bounces name the failed address', () => {
  assert.deepEqual(bouncedAddresses({ headers: 'X-Failed-Recipients: a@x.com\r\n' }, []), ['a@x.com'])
  assert.deepEqual(bouncedAddresses({ text: "Your message wasn't delivered to b@y.com because" }, ['b@y.com', 'c@z.com']), ['b@y.com'])
})

test('bounce guard trips above 8% once there is a sample', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ firstSentAt: 'x', status: i < 1 ? 'bounced' : 'active' }))
  assert.equal(bounceGuard(rows), null)
  rows[1].status = 'bounced'
  assert.ok(bounceGuard(rows))
  assert.equal(bounceGuard(rows.slice(0, 5)), null)
})
