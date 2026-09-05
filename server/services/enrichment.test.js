import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDigitalMaturity, DIGITAL_MATURITY_VERSION, emptyCompanyMetrics, mergeBusinessIntelligence } from './enrichment.js'

test('merges observed locations without presenting them as a total branch count', () => {
  const merged = mergeBusinessIntelligence(
    { locations: [{ placeId: 'a', address: '1 Main St' }], companyMetrics: emptyCompanyMetrics() },
    { locations: [{ placeId: 'a', address: '1 Main Street' }, { placeId: 'b', address: '2 Main St' }] },
  )
  assert.equal(merged.locationsObserved, 2)
  assert.equal(merged.companyMetrics.branchCount.value, null)
})

test('keeps source-backed company metrics and does not fabricate missing ones', () => {
  const merged = mergeBusinessIntelligence({}, { companyMetrics: { employeeCount: { value: '11-50', source: 'Licensed enrichment feed', confidence: 'Medium' } } })
  assert.equal(merged.companyMetrics.employeeCount.value, '11-50')
  assert.equal(merged.companyMetrics.annualRevenue.value, null)
  assert.equal(merged.companyMetrics.annualProfit.value, null)
})

test('calculates digital maturity from transparent observed components', () => {
  const result = calculateDigitalMaturity({
    performance: 60, accessibility: 95, seo: 100, brokenLinks: 0, checkedLinks: 20,
    lighthouse: { scores: { bestPractices: 100 } }, auditSummary: { hasSchema: true, viewport: true },
    stack: ['GA4'], businessIntelligence: { claimed: true, onlineBooking: true },
  })
  assert.equal(result.score, 91)
  assert.equal(result.band, 'Advanced')
  assert.equal(result.components.reduce((sum, item) => sum + item.maximum, 0), 90)
})

test('null lighthouse inputs never produce measured 0 and expose coverage', () => {
  const result = calculateDigitalMaturity({
    performance: null, accessibility: null, seo: null, brokenLinks: 1, checkedLinks: 8,
    auditSummary: { hasSchema: false, viewport: true }, stack: [], businessIntelligence: { source: 'CSV import' },
  })
  assert.equal(result.version, DIGITAL_MATURITY_VERSION)
  const lighthouseComponents = result.components.slice(0, 4)
  assert.ok(lighthouseComponents.every((item) => item.status === 'unmeasured'))
  assert.ok(lighthouseComponents.every((item) => item.evidence === 'Not measured'))
  assert.ok(!result.components.some((item) => /Lighthouse 0\/100/.test(item.evidence)))
  assert.ok(result.coverage < 1)
  assert.ok(result.coveredMaximum < result.maximum)
  // Missing evidence is excluded from the denominator, not scored as poor.
  const covered = result.components.filter((item) => item.status !== 'unmeasured')
  const expected = Math.round((covered.reduce((sum, item) => sum + item.points, 0) / covered.reduce((sum, item) => sum + item.maximum, 0)) * 100)
  assert.equal(result.score, expected)
})

test('a never-audited lead is unavailable, never asserted as poor', () => {
  const result = calculateDigitalMaturity({ performance: null, accessibility: null, seo: null })
  assert.equal(result.score, null)
  assert.equal(result.band, 'Unknown')
  assert.equal(result.coverage, 0)
  assert.equal(result.coveredMaximum, 0)
  assert.ok(result.components.every((item) => item.status === 'unmeasured'))
})

test('empty and whitespace-only metric inputs remain unknown', () => {
  for (const value of [undefined, '', '   ']) {
    const result = calculateDigitalMaturity({ performance: value, accessibility: value, seo: value })
    assert.equal(result.components[0].status, 'unmeasured')
    assert.equal(result.components[0].evidence, 'Not measured')
  }
})

test('an actual Lighthouse score of 0 stays 0 and is scored, not skipped', () => {
  const result = calculateDigitalMaturity({
    performance: 0, accessibility: 0, seo: 0, brokenLinks: 2, checkedLinks: 10,
    lighthouse: { status: 'Completed', scores: { bestPractices: 0 } },
    auditSummary: { hasSchema: false, viewport: false }, stack: [], businessIntelligence: { source: 'Test feed' },
  })
  assert.equal(result.components[0].status, 'measured')
  assert.equal(result.components[0].evidence, 'Lighthouse 0/100')
  assert.equal(result.components[0].points, 4)
  assert.equal(result.coverage, 1)
  assert.ok(Number.isFinite(result.score))
})

test('HTML estimates after a failed Lighthouse audit are labelled, not Lighthouse', () => {
  const result = calculateDigitalMaturity({
    performance: null, accessibility: 82, seo: 77, brokenLinks: 1, checkedLinks: 8,
    lighthouse: { status: 'Failed', error: 'TIMEOUT' },
    auditSummary: { hasSchema: false, viewport: true }, stack: [], businessIntelligence: {},
  })
  assert.equal(result.components[0].status, 'unmeasured')
  assert.equal(result.components[1].status, 'estimated')
  assert.match(result.components[1].evidence, /HTML estimate 82\/100 \(not a Lighthouse measurement\)/)
  assert.equal(result.components[2].status, 'estimated')
  assert.match(result.components[3].evidence, /Not measured/)
})
