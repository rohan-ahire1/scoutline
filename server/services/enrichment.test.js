import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDigitalMaturity, emptyCompanyMetrics, mergeBusinessIntelligence } from './enrichment.js'

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
