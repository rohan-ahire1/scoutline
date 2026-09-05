import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditMetricsForLead,
  makeMetricProvenance,
  metricLabel,
  parseMetricNumber,
  provenanceForScore,
} from './metrics.js'

test('null, undefined, empty and whitespace-only inputs remain unknown', () => {
  for (const input of [null, undefined, '', '   ', '\t\n ']) {
    assert.equal(parseMetricNumber(input), null, `expected null for ${JSON.stringify(input)}`)
  }
})

test('a real numeric zero remains zero', () => {
  assert.equal(parseMetricNumber(0), 0)
  assert.equal(parseMetricNumber('0'), 0)
  assert.equal(parseMetricNumber(' 0 '), 0)
})

test('finite numbers and numeric strings parse; anything else is unknown', () => {
  assert.equal(parseMetricNumber(85), 85)
  assert.equal(parseMetricNumber('85'), 85)
  assert.equal(parseMetricNumber(72.5), 72.5)
  assert.equal(parseMetricNumber(Number.NaN), null)
  assert.equal(parseMetricNumber(Infinity), null)
  assert.equal(parseMetricNumber('abc'), null)
  assert.equal(parseMetricNumber(true), null)
  assert.equal(parseMetricNumber(false), null)
  assert.equal(parseMetricNumber({}), null)
  assert.equal(parseMetricNumber([42]), null)
})

test('stored provenance round-trips; null values are unmeasured', () => {
  const measured = makeMetricProvenance({ value: 90, source: 'lighthouse', status: 'measured', observedAt: '2026-01-01' })
  assert.deepEqual(measured, { value: 90, source: 'lighthouse', status: 'measured', observedAt: '2026-01-01', auditId: null, version: null })
  const missing = makeMetricProvenance({ value: null, source: 'lighthouse', status: 'measured' })
  assert.equal(missing.value, null)
  assert.equal(missing.status, 'unmeasured')
  assert.equal(missing.source, null)
})

test('bare values without provenance are labelled legacy, never attributed', () => {
  const legacy = provenanceForScore({ value: 82, hasProvenance: false })
  assert.equal(legacy.value, 82)
  assert.equal(legacy.source, 'legacy')
  assert.equal(legacy.status, 'legacy')
  assert.match(metricLabel(legacy), /legacy record, unknown source/)
  assert.doesNotMatch(metricLabel(legacy), /Lighthouse/)
})

test('a failed Lighthouse audit separates unmeasured Lighthouse from HTML estimates', () => {
  const metrics = auditMetricsForLead({
    performance: null, accessibility: 82, seo: 77,
    lighthouse: { status: 'Failed', error: 'TIMEOUT' },
  })
  assert.equal(metrics.performance.value, null)
  assert.equal(metrics.performance.status, 'unmeasured')
  assert.equal(metricLabel(metrics.performance), 'Not measured')
  assert.equal(metrics.accessibility.value, 82)
  assert.equal(metrics.accessibility.source, 'html_heuristic')
  assert.equal(metrics.accessibility.status, 'estimated')
  assert.match(metricLabel(metrics.accessibility), /HTML estimate 82\/100 \(not a Lighthouse measurement\)/)
  assert.equal(metrics.seo.source, 'html_heuristic')
  assert.match(metricLabel(metrics.seo), /HTML estimate 77\/100/)
  assert.equal(metrics.bestPractices.value, null)
})

test('a completed Lighthouse audit attributes all scores to Lighthouse', () => {
  const metrics = auditMetricsForLead({
    performance: 42, accessibility: 93, seo: 100,
    lighthouse: { status: 'Completed', scores: { bestPractices: 96 } },
  })
  for (const key of ['performance', 'accessibility', 'seo', 'bestPractices']) {
    assert.equal(metrics[key].source, 'lighthouse')
    assert.equal(metrics[key].status, 'measured')
  }
  assert.equal(metrics.bestPractices.value, 96)
  assert.equal(metricLabel(metrics.performance), 'Lighthouse 42/100')
})

test('a legacy record with no Lighthouse history loads without fabricated sources', () => {
  const metrics = auditMetricsForLead({ performance: 55, accessibility: 80, seo: 90 })
  assert.equal(metrics.performance.status, 'legacy')
  assert.equal(metrics.accessibility.status, 'legacy')
  assert.equal(metrics.seo.status, 'legacy')
  assert.doesNotMatch(metricLabel(metrics.accessibility), /Lighthouse|HTML estimate/)
})

test('fresh stored provenance is preferred over bare-field inference', () => {
  const metrics = auditMetricsForLead({
    performance: 10, accessibility: 10, seo: 10,
    lighthouse: { status: 'Failed' },
    auditMetrics: {
      performance: { value: 91, source: 'lighthouse', status: 'measured', observedAt: '2026-02-01' },
    },
  })
  assert.equal(metrics.performance.value, 91)
  assert.equal(metrics.performance.source, 'lighthouse')
  assert.equal(metrics.accessibility.source, 'html_heuristic')
})
