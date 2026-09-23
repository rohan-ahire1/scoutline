import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPresence, domainCounts, qualifyLead, scoreBusinessWorth } from './qualify.js'
import { compactScan, contactPatch, scanAndQualify } from './prospect.js'

const strongBusiness = {
  company: 'Joshua & Sons Electricians', category: 'Electrician', rating: 4.8, reviews: 143, phone: '(801) 555-0100',
  businessIntelligence: { claimed: true, latestObservedReviewAt: new Date(Date.now() - 10 * 86400000).toISOString() },
}

const datedSite = {
  websiteType: 'static', pagesInspected: 3, signals: { hasPhone: false },
  dated: {
    score: 70, modern: [], placeholder: null, agencyPlatform: null, agencyCredit: null,
    signals: [
      { id: 'table-layout', label: 'Page layout is built from HTML tables', evidence: '4 layout tables', weight: 16 },
      { id: 'no-viewport', label: 'Not set up for phones (no viewport tag)', evidence: 'meta viewport missing', weight: 18 },
      { id: 'stale-copyright', label: 'Footer copyright is out of date', evidence: '© 2014', weight: 18 },
    ],
  },
  visualRisk: { score: 40 },
  rankedEmails: [{ email: 'mike@joshuasons.com', kind: 'owner', source: 'mailto', page: 'https://joshuasons.com/contact', mx: 'ok' }],
  owners: [{ name: 'Mike Joshua', evidence: 'Owner: Mike Joshua' }],
  phones: [], socialLinks: [],
}

test('no website + strong reviews = redesign, reached by phone', () => {
  const q = qualifyLead({ business: strongBusiness })
  assert.equal(q.presence, 'none')
  assert.equal(q.play, 'redesign')
  assert.equal(q.confidence, 'high')
  assert.equal(q.contact.channel, 'phone')
  assert.ok(q.priority > 70, `priority ${q.priority}`)
  assert.ok(q.flags.some((f) => /No email/.test(f)))
})

test('dated own site = redesign with quotable hooks and the owner email', () => {
  const q = qualifyLead({ business: { ...strongBusiness, website: 'joshuasons.com' }, site: datedSite })
  assert.equal(q.play, 'redesign')
  assert.equal(q.contact.email, 'mike@joshuasons.com')
  assert.equal(q.contact.ownerName, 'Mike Joshua')
  assert.ok(q.pitchHooks.some((h) => /© 2014/.test(h)), q.pitchHooks.join(' | '))
})

test('modern site with no markup issues stays an unconfirmed audit until visually reviewed', () => {
  const clean = { ...datedSite, dated: { ...datedSite.dated, score: 0, signals: [] }, visualRisk: { score: 0 } }
  const q = qualifyLead({ business: { ...strongBusiness, website: 'joshuasons.com' }, site: clean })
  assert.equal(q.play, 'audit')
  assert.equal(q.confidence, 'low')
  assert.equal(q.needsVisualReview, true)
  const reviewed = qualifyLead({ business: { ...strongBusiness, website: 'joshuasons.com' }, site: clean, visualReview: { score: 5, issues: [] } })
  assert.equal(reviewed.play, 'skip')
  assert.match(reviewed.playReason, /already looks good/)
})

test('a visual "redesign" verdict outweighs clean markup', () => {
  const clean = { ...datedSite, dated: { ...datedSite.dated, score: 5, signals: [] }, visualRisk: { score: 0 } }
  const q = qualifyLead({ business: { ...strongBusiness, website: 'joshuasons.com' }, site: clean, visualReview: { score: 85, issues: ['The hero is a blurry stock photo'] } })
  assert.equal(q.play, 'redesign')
  assert.ok(q.pitchHooks.includes('The hero is a blurry stock photo'))
})

test('exclusions: franchise, utility, chain location page, huge operation, bad reputation, closed', () => {
  const cases = [
    [{ ...strongBusiness, company: 'Mr. Electric of Salt Lake City' }, /Franchise/],
    [{ ...strongBusiness, company: 'Rocky Mountain Power', category: 'Electric utility company' }, /Not an owner-run/],
    [{ ...strongBusiness, website: 'justrightair.com/city/salt-lake-city-ut' }, /location page/],
    [{ ...strongBusiness, reviews: 10157 }, /Large operation/],
    [{ ...strongBusiness, rating: 3.6 }, /Weak reputation/],
    [{ ...strongBusiness, businessIntelligence: { businessStatus: 'Permanently closed' } }, /closed/],
  ]
  for (const [business, pattern] of cases) {
    const q = qualifyLead({ business, site: datedSite })
    assert.equal(q.play, 'skip', business.company)
    assert.match(q.playReason, pattern)
    assert.equal(q.priority, 0)
  }
})

test('HVAC dealers are not mistaken for the manufacturer brand', () => {
  const q = qualifyLead({ business: { ...strongBusiness, company: 'Wasatch Heating - Carrier Factory Authorized Dealer', category: 'HVAC contractor' } })
  assert.notEqual(q.play, 'skip', q.playReason)
})

test('presence: social, free subdomain, dead domain, unreachable, placeholder', () => {
  assert.equal(classifyPresence({ website: 'facebook.com/joshuasons' }).presence, 'social-only')
  assert.equal(classifyPresence({ website: 'q6lvxf-my-site.wix-vibe-site.com' }).presence, 'free-subdomain')
  assert.equal(classifyPresence({ website: 'gone.com', site: { failed: true, kind: 'dns' } }).presence, 'dead-domain')
  assert.equal(classifyPresence({ website: 'slow.com', site: { failed: true, kind: 'timeout' } }).presence, 'unreachable')
  assert.equal(classifyPresence({ website: 'parked.com', site: { dated: { placeholder: 'parked' } } }).presence, 'placeholder')
  const q = qualifyLead({ business: { ...strongBusiness, website: 'slow.com' }, site: { failed: true, kind: 'timeout', error: 'x' } })
  assert.equal(q.play, 'redesign')
  assert.equal(q.confidence, 'low')
})

test('shared domains: duplicates of one business count once, real chains are excluded', () => {
  const counts = domainCounts([
    { company: 'A Roofing', website: 'aroof.com' }, { company: 'A Roofing', website: 'www.aroof.com' },
    { company: 'Chain North', website: 'chain.com' }, { company: 'Chain South', website: 'chain.com' },
  ])
  assert.equal(counts.get('aroof.com'), 1)
  assert.equal(counts.get('chain.com'), 2)
  const q = qualifyLead({ business: { ...strongBusiness, website: 'chain.com' }, site: datedSite, knownDomains: counts })
  assert.equal(q.play, 'skip')
})

test('thin businesses are skipped rather than given free work', () => {
  const q = qualifyLead({ business: { company: 'New Co', category: 'Painter', rating: 5, reviews: 3 } })
  assert.equal(q.play, 'skip')
  assert.ok(scoreBusinessWorth({ rating: 5, reviews: 3 }).score < 40)
})

test('scanAndQualify fills a missing email and keeps its source', async () => {
  const lead = { ...strongBusiness, id: 'lead-1', website: 'joshuasons.com', email: 'Not collected' }
  const result = await scanAndQualify(lead, { scan: async () => ({ ...datedSite, scannedAt: 'now', pages: [{ finalUrl: 'https://joshuasons.com/' }] }) })
  assert.equal(result.patch.email, 'mike@joshuasons.com')
  assert.equal(result.patch.ownerName, 'Mike Joshua')
  assert.equal(result.qualification.play, 'redesign')
  assert.equal(result.siteScan.pages[0].url, 'https://joshuasons.com/')
  assert.deepEqual(contactPatch({ ...lead, email: 'owner@joshuasons.com', ownerName: 'X' }, result.qualification), {})
  assert.equal(compactScan({ failed: true, kind: 'dns' }).kind, 'dns')
})

test('visual review sends screenshots to Meta via chat completions and maps the rubric', async () => {
  const { reviewScreenshots } = await import('./visual.js')
  const buf = Buffer.from('jpeg')
  const shots = { desktop: { fold: buf, full: buf, overlays: [] }, mobile: { fold: buf, full: buf, overlays: [{ kind: 'popup', text: 'Best of SLC' }] } }
  let request
  const client = { chat: { completions: { create: async (body) => {
    request = body
    return { choices: [{ message: { content: JSON.stringify({ looksDated: 5, visualPolish: 1, mobileExperience: 2, clarity: 2, trust: 2, eraGuess: '2012 WordPress theme', verdict: 'redesign', issues: [{ view: 'mobile', issue: 'The phone number is not tappable' }], strengths: [], summary: 'Old.' }) } }] }
  } } } }
  const review = await reviewScreenshots(shots, { company: 'X', category: 'Roofer', website: 'x.com' }, { metaApiKey: 'k', client })
  assert.equal(review.provider, 'meta')
  assert.equal(request.messages[0].content.filter((part) => part.type === 'image_url').length, 4)
  assert.match(request.messages[0].content[0].text, /Best of SLC/)
  assert.equal(review.verdict, 'redesign')
  assert.ok(review.score >= 80, `score ${review.score}`)
  assert.deepEqual(review.issues, ['The phone number is not tappable (mobile)'])
})
