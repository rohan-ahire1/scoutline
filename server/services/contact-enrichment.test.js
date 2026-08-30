import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCommercialScore,
  computeReachabilityScore,
  dedupeContacts,
  ensureLeadContactFields,
  extractAndNormalizeContacts,
  extractContactsFromHtml,
  getRoleTier,
  normalizeEmail,
  normalizeLinkedInUrl,
  normalizePhone,
  selectPreferredContact,
  selectTopLeadsForContactEnrichment,
  stableContactId,
} from './contact-enrichment.js'
import { createPublicWebsiteProvider, runContactEnrichment } from './contact-enrichment.js'
import { normalizeWebsite } from './audit.js'

// Helpers
function makeLead(over) {
  return {
    id: 'lead-1',
    company: 'Acme',
    website: 'example.com',
    prelimScore: 70,
    opportunityScore: 80,
    contacts: [],
    ...over,
  }
}

test('multiple structured contacts persist', async () => {
  const fakeFetch = async (input) => {
    const url = input instanceof URL ? input : new URL(input)
    if (url.pathname === '/' || url.pathname === '') {
      return {
        text: `<html><body>
          <a href="mailto:owner@example.com">owner@example.com</a>
          <div class="team-member"><h3>Jane Doe</h3><p>Founder</p><a href="mailto:jane@example.com">jane@example.com</a></div>
          <a href="/contact">Contact</a>
          <a href="/team">Team</a>
        </body></html>`,
        url: new URL('https://example.com/'),
        contentType: 'text/html',
      }
    }
    if (url.pathname === '/contact') {
      return {
        text: `<html><body><a href="mailto:info@example.com">info@example.com</a> <a href="tel:+1-555-010-1100">555-010-1100</a></body></html>`,
        url: new URL('https://example.com/contact'),
        contentType: 'text/html',
      }
    }
    if (url.pathname === '/team') {
      return {
        text: `<html><body><a href="https://www.linkedin.com/in/jane-doe">LinkedIn</a></body></html>`,
        url: new URL('https://example.com/team'),
        contentType: 'text/html',
      }
    }
    return { text: '<html></html>', url, contentType: 'text/html' }
  }
  const provider = createPublicWebsiteProvider({ fetchPublicText: fakeFetch, normalizeWebsite })
  const lead = makeLead({ website: 'example.com' })
  const result = await runContactEnrichment(lead, { providers: [provider], fetchPublicText: fakeFetch, normalizeWebsite })
  assert.ok(result.contacts.length >= 2, `expected multiple contacts, got ${result.contacts.length}`)
  assert.ok(result.contacts.some(c => c.channels.some(ch => ch.type === 'email')), 'should have email')
  // ensure no invented name for plain info address without nearby markup
  const infoContact = result.contacts.find(c => c.channels.some(ch => ch.value === 'info@example.com'))
  assert.equal(infoContact?.name, null, 'generic email without nearby person should have unknown name')
})

test('missing contacts stays explicit unknown, no invented data', async () => {
  const fakeFetch = async () => ({
    text: '<html><head><title>No contact</title></head><body><p>Welcome to our site. We do great work.</p></body></html>',
    url: new URL('https://empty.example/'),
    contentType: 'text/html',
  })
  const provider = createPublicWebsiteProvider({ fetchPublicText: fakeFetch, normalizeWebsite })
  const lead = makeLead({ website: 'empty.example' })
  const result = await provider.enrich(lead)
  // Even without contacts, reachability is minimal and preferred is null or unknown
  if (result.contacts.length === 0) {
    assert.equal(result.preferredContact, null)
    assert.equal(result.reachability.score < 30, true)
  } else {
    // if form fallback created, it should still be unknown person
    const pref = result.preferredContact
    if (pref) assert.equal(pref.name == null || pref.name === 'Unknown person' || pref.name === null, true)
  }
  // ensure no email invented
  const hasInvented = result.contacts.some(c => (c.channels||[]).some(ch => /example/.test(ch.value) && !ch.sourceUrl))
  assert.equal(hasInvented, false)
})

test('dedupe is deterministic case-insensitive email and normalized phones/urls', () => {
  const a = { name: 'Alice', role: 'Owner', channels: [{ type: 'email', value: 'Owner@Example.COM', normalized: normalizeEmail('Owner@Example.COM'), sourceUrl: 'https://example.com/', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'high', verified: true }] , sources: ['https://example.com/'] }
  const b = { name: null, role: null, channels: [{ type: 'email', value: 'owner@example.com', normalized: normalizeEmail('owner@example.com'), sourceUrl: 'https://example.com/contact', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'low', verified: false }], sources: ['https://example.com/contact'] }
  const c = { name: null, role: null, channels: [{ type: 'phone', value: '(555) 010-1100', normalized: normalizePhone('(555)0101100'), sourceUrl: 'https://example.com/', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'high', verified: true }], sources: ['https://example.com/'] }
  const d = { name: null, role: null, channels: [{ type: 'phone', value: '5550101100', normalized: normalizePhone('5550101100'), sourceUrl: 'https://example.com/contact', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'low', verified: false }], sources: ['https://example.com/contact'] }
  const e = { name: null, role: null, channels: [{ type: 'linkedin', value: 'https://www.linkedin.com/in/jane-doe/', normalized: normalizeLinkedInUrl('https://www.linkedin.com/in/jane-doe/'), sourceUrl: 'https://example.com/', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'high', verified: true }], sources: ['https://example.com/'] }
  const f = { name: null, role: null, channels: [{ type: 'linkedin', value: 'https://www.linkedin.com/in/JANE-DOE', normalized: normalizeLinkedInUrl('https://www.linkedin.com/in/JANE-DOE'), sourceUrl: 'https://example.com/team', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'low', verified: false }], sources: ['https://example.com/team'] }
  const deduped = dedupeContacts([a,b,c,d,e,f,b,a])
  // emails dedup to 1, phones to 1, linkedins to 1 -> 3 contacts
  assert.equal(deduped.length, 3)
  const emailContact = deduped.find(x => x.channels.some(ch=>ch.type==='email'))
  assert.equal(emailContact.channels.length, 1, 'email channels merged not duplicated')
  assert.ok(emailContact.sources.includes('https://example.com/') && emailContact.sources.includes('https://example.com/contact'), 'sources merged')
  // deterministic ids
  const id1 = stableContactId(a)
  const id2 = stableContactId(b)
  assert.equal(id1, id2, 'same normalized email yields stable id')
  // order deterministic despite input shuffle
  const deduped2 = dedupeContacts([f,e,d,c,b,a])
  assert.deepEqual(deduped.map(x=>x.id), deduped2.map(x=>x.id))
})

test('preferred selection deterministic hierarchy with tie breakers', () => {
  const mk = (name, role, channels, id) => ({ id: id || `c-${name}`, name, role, channels })
  const owner = mk('Alice Owner', 'Owner', [{ type:'email', value:'alice@example.com', verified:true, confidence:'high' }], 'c-1')
  const gm = mk('Bob Manager', 'General Manager', [{ type:'email', value:'bob@example.com', verified:true, confidence:'high' }], 'c-2')
  const marketing = mk('Carol', 'Marketing Lead', [{ type:'email', value:'carol@example.com', verified:true, confidence:'high' }], 'c-3')
  const verifiedRole = mk(null, null, [{ type:'email', value:'manager@example.com', verified:true, confidence:'high' }], 'c-4')
  const generalEmail = mk(null, null, [{ type:'email', value:'info@example.com', verified:true, confidence:'high' }], 'c-5')
  const phoneOnly = mk(null, null, [{ type:'phone', value:'5550101100', verified:true, confidence:'high' }], 'c-6')
  const linkedinOnly = mk(null, null, [{ type:'linkedin', value:'https://www.linkedin.com/in/foo', verified:true, confidence:'high' }], 'c-7')
  const formOnly = mk(null, null, [{ type:'form', value:'https://example.com/contact', verified:false, confidence:'medium' }], 'c-8')

  const all = [formOnly, linkedinOnly, phoneOnly, generalEmail, verifiedRole, marketing, gm, owner]
  assert.equal(selectPreferredContact(all)?.id, 'c-1', 'owner should win')
  assert.equal(selectPreferredContact([gm, marketing])?.id, 'c-2', 'gm beats marketing')
  assert.equal(selectPreferredContact([marketing, verifiedRole])?.id, 'c-3', 'marketing beats verified role')
  assert.equal(selectPreferredContact([verifiedRole, generalEmail])?.id, 'c-4', 'verified role email beats general')
  assert.equal(selectPreferredContact([generalEmail, phoneOnly])?.id, 'c-5', 'email beats phone')
  assert.equal(selectPreferredContact([phoneOnly, linkedinOnly])?.id, 'c-6', 'phone beats linkedin')
  assert.equal(selectPreferredContact([linkedinOnly, formOnly])?.id, 'c-7', 'linkedin beats form')

  // Tie breakers: same tier, confidence/verification/channel completeness/name/id - confidence before completeness per implementation
  const tieA = mk('Alice', null, [{ type:'email', value:'a@example.com', verified:true, confidence:'high' }, { type:'phone', value:'5550101100', verified:true, confidence:'high' }], 'c-a')
  const tieB = mk('Bob', null, [{ type:'email', value:'b@example.com', verified:true, confidence:'high' }], 'c-b')
  const prefTie = selectPreferredContact([tieB, tieA])
  assert.equal(prefTie.id, 'c-a', 'channel completeness should break tie within same tier when confidence equal')

  // Stable id tie break when everything else equal
  const dupA = mk('Zoe', null, [{ type:'email', value:'z@example.com', verified:true, confidence:'high' }], 'c-zzz')
  const dupB = mk('Zoe', null, [{ type:'email', value:'z2@example.com', verified:true, confidence:'high' }], 'c-aaa')
  // different email, same tier, same completeness, same name -> id sort decides
  const prefId = selectPreferredContact([dupA, dupB])
  // sorted by id, aaa before zzz
  assert.equal(prefId.id, 'c-aaa')
})

test('parser provenance retains source and confidence', () => {
  const html = `
    <html><body>
      <a href="mailto:owner@example.com">owner@example.com</a>
      <a href="tel:+15550101100">Call</a>
      <a href="https://www.linkedin.com/company/acme">Company</a>
      <form action="/contact"><input name="email"></form>
    </body></html>`
  const raws = extractContactsFromHtml(html, new URL('https://example.com/'), '2026-01-02T00:00:00.000Z')
  const emailRaw = raws.find(r => r.channels.some(c=>c.type==='email'))
  assert.ok(emailRaw)
  const emailCh = emailRaw.channels.find(c=>c.type==='email')
  assert.equal(emailCh.sourceUrl, 'https://example.com/')
  assert.equal(emailCh.confidence, 'high')
  assert.equal(emailCh.verified, false)
  assert.equal(emailCh.verificationStatus, 'observed')
  assert.equal(emailCh.method, 'mailto')

  const phoneRaw = raws.find(r => r.channels.some(c=>c.type==='phone'))
  assert.equal(phoneRaw.channels[0].confidence, 'high')
  assert.equal(phoneRaw.channels[0].verified, false)
  assert.equal(phoneRaw.channels[0].verificationStatus, 'observed')

  const linkedRaw = raws.find(r => r.channels.some(c=>c.type==='linkedin'))
  assert.equal(linkedRaw.channels[0].confidence, 'high')

  // plain text low confidence case (non-placeholder domain to test text provenance; example.com is deliberately rejected for plain text)
  const html2 = `<html><body>Reach us at plain@acme-corp.com or 555-010-1200</body></html>`
  const raws2 = extractContactsFromHtml(html2, new URL('https://example.com/'), '2026-01-02T00:00:00.000Z')
  const plainEmail = raws2.find(r=>r.channels.some(c=>c.value==='plain@acme-corp.com'))
  assert.ok(plainEmail, 'plain text email should be extracted with provenance')
  assert.equal(plainEmail.channels[0].confidence, 'low')
  assert.equal(plainEmail.channels[0].verified, false)
  assert.equal(plainEmail.channels[0].method, 'text')
})

test('parser separates visible text and does not invent concatenated emails', () => {
  const html = '<html><body><h3>Alice Johnson</h3><p>General Manager</p><a href="mailto:alice@acme-corp.com">Email</a><span>info@acme-corp.com</span></body></html>'
  const raws = extractContactsFromHtml(html, new URL('https://acme-corp.com/'), '2026-01-02T00:00:00.000Z')
  const emails = raws.flatMap((contact) => contact.channels).filter((channel) => channel.type === 'email').map((channel) => channel.value)
  assert.ok(emails.includes('alice@acme-corp.com'))
  assert.ok(emails.includes('info@acme-corp.com'))
  assert.equal(emails.some((email) => /manageralice|cominfo/i.test(email)), false)
})

test('person association stays inside explicit cards and isolated channels remain unknown', () => {
  const html = `<html><body>
    <div class="team-member"><h3>Jane Doe</h3><p>Founder</p><a href="mailto:jane@acme-corp.com">Jane</a><a href="tel:+15550101100">Call Jane</a></div>
    <div><h3>Remote Person</h3><p>Owner</p><div>Unrelated content</div><div>More unrelated content</div><div>Still unrelated</div><a href="mailto:office@acme-corp.com">Office</a></div>
  </body></html>`
  const raw = extractContactsFromHtml(html, new URL('https://acme-corp.com/team'), '2026-01-02T00:00:00.000Z')
  const office = raw.find((contact) => contact.channels.some((channel) => channel.value === 'office@acme-corp.com'))
  assert.equal(office?.name, null)
  assert.equal(office?.role, null)
  const normalized = extractAndNormalizeContacts([{ html, url: new URL('https://acme-corp.com/team'), observedAt: '2026-01-02T00:00:00.000Z' }])
  const jane = normalized.find((contact) => contact.name === 'Jane Doe')
  assert.deepEqual(new Set(jane?.channels.map((channel) => channel.type)), new Set(['email', 'phone']))
})

test('public website provider ignores external contact-page links', async () => {
  const fetched = []
  const fakeFetch = async (input) => {
    const url = input instanceof URL ? input : new URL(input)
    fetched.push(url.href)
    if (url.pathname === '/') return { text: '<a href="/contact">Contact</a><a href="https://evil.example/contact">External</a>', url, contentType: 'text/html' }
    return { text: '<p>Contact us</p>', url, contentType: 'text/html' }
  }
  const provider = createPublicWebsiteProvider({ fetchPublicText: fakeFetch, normalizeWebsite })
  await provider.enrich(makeLead({ website: 'acme-corp.example' }))
  assert.ok(fetched.some((url) => url === 'https://acme-corp.example/contact'))
  assert.equal(fetched.some((url) => url.includes('evil.example')), false)
})

test('legacy contact normalization uses stable timestamps', () => {
  const lead = makeLead({ contacts: undefined, email: 'owner@acme-corp.com', phone: '555-010-1100', collectedAt: '2026-01-01T12:00:00.000Z' })
  const first = ensureLeadContactFields(lead)
  const second = ensureLeadContactFields(lead)
  assert.deepEqual(first.contacts, second.contacts)
  assert.equal(first.contacts[0].observedAt, '2026-01-01T12:00:00.000Z')
  assert.ok(first.contacts.every((contact) => contact.channels.every((channel) => channel.sourceUrl === null && channel.verificationStatus === 'unverified')))
})

test('reachability scoring is transparent and commercial ranking combines without corrupting opportunity', () => {
  const contacts = [
    { channels: [{ type:'email', value:'owner@example.com', verified:true, confidence:'high' }, { type:'phone', value:'5550101100', verified:true, confidence:'high' }], name:'Owner', role:'Owner' },
    { channels: [{ type:'linkedin', value:'https://www.linkedin.com/in/foo', verified:true, confidence:'high' }], name:null, role:null },
  ]
  const reach = computeReachabilityScore(contacts)
  assert.ok(reach.score >= 50, `reach ${reach.score} should reflect email+phone+linkedin+name+role`)
  assert.equal(reach.max, 100)
  assert.ok(Array.isArray(reach.components) && reach.components.length > 0)
  assert.ok(reach.components.some(c=>c.label==='Email'))
  const lead = { opportunityScore: 80, prelimScore: 70, contacts, reachabilityScore: reach.score, contactEnrichment: { reachabilityScore: reach.score } }
  const commercial = computeCommercialScore(lead)
  assert.ok(commercial !== 80, 'commercial should combine but not equal raw opportunity')
  assert.ok(commercial > 70 && commercial <= 100)
  // opportunity unchanged
  assert.equal(lead.opportunityScore, 80)
})

test('auto selection filters active/recent and sorts by lead value then stable id', () => {
  const leads = [
    { id:'lead-a', website:'a.example', opportunityScore: 90, prelimScore: 90, qualified:true },
    { id:'lead-b', website:'b.example', opportunityScore: 90, prelimScore: 90, qualified:true },
    { id:'lead-c', website:'c.example', opportunityScore: 70, prelimScore: 70 },
    { id:'lead-d', website:'', opportunityScore: 100 }, // no website -> ineligible
  ]
  const now = '2026-01-02T00:00:00.000Z'
  const selected = selectTopLeadsForContactEnrichment(leads, { limit: 10, recentHours: 24, now, activeLeadIds: new Set(['lead-a']), recentlyCompletedIds: new Set(['lead-c']) })
  assert.ok(!selected.some(l=>l.id==='lead-a'), 'active filtered')
  assert.ok(!selected.some(l=>l.id==='lead-c'), 'recently completed filtered')
  assert.ok(!selected.some(l=>l.id==='lead-d'), 'no website filtered')
  assert.equal(selected[0].id, 'lead-b', 'remaining top sorted by value then id')

  // tie sorting by stable id
  const tieLeads = [
    { id:'lead-z', website:'z.example', opportunityScore: 80 },
    { id:'lead-a2', website:'a2.example', opportunityScore: 80 },
  ]
  const tieSel = selectTopLeadsForContactEnrichment(tieLeads, { limit:2, recentHours:24, now, activeLeadIds:new Set(), recentlyCompletedIds:new Set() })
  assert.deepEqual(tieSel.map(l=>l.id), ['lead-a2','lead-z'])
})

test('getRoleTier mapping', () => {
  assert.equal(getRoleTier('Founder & CEO'), 0)
  assert.equal(getRoleTier('General Manager'), 1)
  assert.equal(getRoleTier('Marketing Manager'), 2)
  assert.equal(getRoleTier('Engineer'), null)
})
