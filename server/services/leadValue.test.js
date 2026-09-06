import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LEAD_VALUE_WEIGHTS, LEAD_VALUE_VERSION, resolveLeadValueWeights, scoreLeadValue } from './leadValue.js'

const strongNoSite = {
  company: 'Busy Plumbing', website: '', websiteStatus: 'not_supplied',
  category: 'Plumbing', rating: 4.8, reviews: 320, phone: '555-0100', email: 'bid@busy.example',
  sourceUrl: 'https://maps.example/busy',
  businessIntelligence: {
    claimed: true, businessStatus: 'Unknown', onlineBooking: false, onlineEstimates: false,
    latestObservedReviewAt: new Date(Date.now() - 86400000 * 6).toISOString(),
    companyMetrics: { foundedYear: { value: 2009 } },
    locations: [{ address: '1 Main St' }, { address: '2 Oak Ave' }],
  },
}

const weakWithSite = {
  company: 'Tiny Fixers', website: 'tiny.example', websiteStatus: 'audited',
  category: 'Plumbing', rating: 3.2, reviews: 4, phone: 'Not collected', email: 'Not collected',
  sourceUrl: null, opportunityScore: 88, confidence: 70,
  problems: ['The homepage title is missing.', 'Common reassurance was not detected in homepage text.'],
  evidence: ['Homepage title length: 4 characters'],
  businessIntelligence: { claimed: false, businessStatus: 'Unknown', latestObservedReviewAt: null, companyMetrics: {}, locations: [{}] },
  auditSummary: { forms: 0, hasTrustLanguage: false },
}

const midAudited = {
  company: 'Steady HVAC', website: 'steady.example', websiteStatus: 'audited',
  category: 'HVAC', rating: 4.2, reviews: 60, phone: '555-0200', email: 'hello@steady.example',
  sourceUrl: 'https://maps.example/steady', opportunityScore: 60, confidence: 70,
  businessIntelligence: {
    claimed: true, businessStatus: 'Unknown', onlineBooking: false, onlineEstimates: true,
    latestObservedReviewAt: new Date(Date.now() - 86400000 * 20).toISOString(),
    companyMetrics: { foundedYear: { value: 2018 } }, locations: [{ address: '5 Pine Rd' }],
  },
  auditSummary: { forms: 1, hasTrustLanguage: true },
}

test('ranked fixtures match human judgment order (evaluation report)', () => {
  const strong = scoreLeadValue(strongNoSite)
  const mid = scoreLeadValue(midAudited)
  const weak = scoreLeadValue(weakWithSite)
  assert.ok(strong.leadValueScore > mid.leadValueScore, `strong ${strong.leadValueScore} should beat mid ${mid.leadValueScore}`)
  assert.ok(mid.leadValueScore > weak.leadValueScore, `mid ${mid.leadValueScore} should beat weak ${weak.leadValueScore}`)
  // Bands stay honest: nobody here has deep enriched evidence, so nobody
  // claims Top Prospect, and the weak business is judged on solid coverage.
  assert.ok(strong.coverage >= 0.5 && weak.coverage >= 0.3)
})

test('opportunityScore survives as the website-need input, distinct from value', () => {
  const scored = scoreLeadValue(weakWithSite)
  assert.ok(scored.need.contributions.some((c) => /Opportunity score: 88/.test(c.evidence)))
  assert.notEqual(scored.leadValueScore, 88)
  assert.equal(scored.version, LEAD_VALUE_VERSION)
})

test('missing facts lower coverage instead of fabricating values', () => {
  const scored = scoreLeadValue({ company: 'Ghost Co', category: 'Plumbing' })
  assert.ok(scored.coverage < 0.4, `coverage ${scored.coverage}`)
  assert.equal(scored.band, 'Review')
  assert.ok(scored.businessFit.unknowns.some((u) => /revenue unknown/i.test(u)))
  assert.ok(scored.reachability.unknowns.some((u) => /decision-maker/i.test(u)))
  assert.ok(!/revenue|budget|intent/i.test(JSON.stringify(scored.businessFit.contributions)))
})

test('thinly observed businesses are never confidently deprioritized', () => {
  const scored = scoreLeadValue({ company: 'Ghost Co', category: 'Cleaning', rating: 2.1, reviews: 1 })
  assert.notEqual(scored.band, 'Low Priority')
})

test('confirmed closed businesses leave the active queue with a reason', () => {
  const scored = scoreLeadValue({ ...strongNoSite, businessIntelligence: { ...strongNoSite.businessIntelligence, businessStatus: 'Permanently closed' } })
  assert.equal(scored.excluded?.closed, true)
  assert.match(scored.excluded.reason, /Permanently closed/)
  assert.equal(scored.band, 'Low Priority')
  const unknown = scoreLeadValue(strongNoSite)
  assert.equal(unknown.excluded, null)
})

test('no-website need requires supported business fit', () => {
  const thin = scoreLeadValue({ ...strongNoSite, rating: 0, reviews: 0, businessIntelligence: { ...strongNoSite.businessIntelligence, claimed: false } })
  const supported = scoreLeadValue(strongNoSite)
  const thinNeed = thin.need.contributions.find((c) => c.signal === 'No website supplied')
  assert.equal(thinNeed, undefined)
  assert.ok(thin.need.unknowns.some((u) => /cannot be judged/i.test(u)))
  assert.ok(supported.need.contributions.some((c) => c.signal === 'No website supplied'))
})

test('newly broken or unreachable websites are dated timing signals', () => {
  const base = { ...midAudited, brokenLinks: 3, auditHistory: [{ at: '2026-08-01T00:00:00.000Z', brokenLinks: 0, score: 55 }] }
  const scored = scoreLeadValue(base)
  assert.ok(scored.timing.contributions.some((c) => c.signal === 'Newly broken links since a clean audit'))
  const down = scoreLeadValue({
    ...midAudited,
    lastSuccessfulAudit: { at: '2026-08-01T00:00:00.000Z', url: 'https://steady.example', score: 60 },
    lastAuditAttempt: { jobId: 'job-1', at: new Date().toISOString(), status: 'Failed', reason: 'unreachable' },
  })
  assert.ok(down.timing.contributions.some((c) => c.signal === 'Website newly unreachable since a good audit'))
  assert.ok(down.leadValueScore > scoreLeadValue(midAudited).leadValueScore)
})

test('growth is never inferred from one review snapshot', () => {
  const scored = scoreLeadValue(strongNoSite)
  assert.ok(!/growth|accelerat|hiring/i.test(JSON.stringify(scored.timing.contributions)))
  assert.ok(scored.timing.unknowns.some((u) => /Expansion, hiring/i.test(u)))
  assert.ok(scored.timing.contributions.some((c) => /within 30 days/i.test(c.signal)))
})

test('changing weights creates a version; defaults stay v1', () => {
  const def = resolveLeadValueWeights(undefined)
  assert.deepEqual(def.weights, DEFAULT_LEAD_VALUE_WEIGHTS)
  assert.equal(def.version, '1')
  const custom = resolveLeadValueWeights({ need: 0.9, businessFit: 0.05, reachability: 0.03, timing: 0.02 })
  assert.match(custom.version, /^1-custom-/)
  const rescored = scoreLeadValue(strongNoSite, { weights: { need: 0.9, businessFit: 0.05, reachability: 0.03, timing: 0.02 } })
  assert.equal(rescored.version, custom.version)
  assert.deepEqual(rescored.weights, custom.weights)
  assert.notEqual(rescored.leadValueScore, scoreLeadValue(strongNoSite).leadValueScore)
})

test('identical evidence under identical weights scores identically', () => {
  const a = scoreLeadValue(strongNoSite)
  const b = scoreLeadValue(JSON.parse(JSON.stringify(strongNoSite)))
  assert.equal(a.leadValueScore, b.leadValueScore)
  assert.equal(a.band, b.band)
})
