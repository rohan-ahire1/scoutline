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
  assert.equal(result.coverage.measuredComponents, result.coverage.totalComponents)
})

test('null, empty and whitespace metrics never produce a measured zero', () => {
  const result = calculateDigitalMaturity({ performance: null, accessibility: '', seo: '   ', brokenLinks: null })
  const byLabel = Object.fromEntries(result.components.map((item) => [item.label, item]))
  for (const label of ['Mobile performance', 'Accessibility', 'Search readiness', 'Technical best practices']) {
    assert.equal(byLabel[label].status, 'unmeasured')
    assert.equal(byLabel[label].points, 0)
    assert.equal(byLabel[label].evidence, 'Not measured')
  }
  assert.equal(result.version, 2)
  assert.ok(result.coverage.measuredMaximum < result.coverage.totalMaximum)
})

test('unmeasured components are excluded instead of scored as poor', () => {
  const partial = calculateDigitalMaturity({
    performance: 80, accessibility: null, seo: null,
    auditSummary: { hasSchema: true, viewport: true }, stack: ['GA4'],
    businessIntelligence: { claimed: true, onlineBooking: true }, brokenLinks: 0, checkedLinks: 5,
  })
  // 80 performance is strong evidence; missing signals must not drag it to poor.
  assert.ok(partial.score >= 60, `score ${partial.score} penalizes missing evidence`)
  assert.equal(partial.coverage.share < 100, true)
  const none = calculateDigitalMaturity({})
  assert.equal(none.coverage.measuredMaximum > 0, true) // detections still observed
  assert.ok(none.components.some((item) => item.status === 'unmeasured'))
})

test('html-heuristic scores are labelled as estimates in maturity evidence', () => {
  const result = calculateDigitalMaturity({
    performance: null,
    accessibility: 88, seo: 92,
    measureProvenance: {
      accessibility: { value: 88, source: 'html_heuristic', status: 'estimated' },
      seo: { value: 92, source: 'html_heuristic', status: 'estimated' },
    },
    auditSummary: {}, stack: [], businessIntelligence: {},
  })
  const byLabel = Object.fromEntries(result.components.map((item) => [item.label, item]))
  assert.match(byLabel.Accessibility.evidence, /HTML estimate 88\/100/)
  assert.match(byLabel['Search readiness'].evidence, /not a Lighthouse measurement/)
  assert.equal(byLabel.Accessibility.status, 'estimated')
  assert.equal(byLabel['Mobile performance'].evidence, 'Not measured')
})

test('legacy stored numbers disclose the unknown source', () => {
  const result = calculateDigitalMaturity({ performance: 42, accessibility: 93, seo: 100 })
  const byLabel = Object.fromEntries(result.components.map((item) => [item.label, item]))
  assert.match(byLabel['Mobile performance'].evidence, /Legacy value 42\/100 \(unknown source\)/)
  assert.equal(byLabel['Mobile performance'].status, 'legacy')
})

test('a genuine Lighthouse zero stays zero and keeps its source', () => {
  const result = calculateDigitalMaturity({
    performance: 0,
    measureProvenance: { performance: { value: 0, source: 'lighthouse', status: 'measured' } },
    auditSummary: {}, stack: [], businessIntelligence: {},
  })
  const mobile = result.components.find((item) => item.label === 'Mobile performance')
  assert.equal(mobile.evidence, 'Lighthouse 0/100')
  assert.equal(mobile.points, 4)
})
