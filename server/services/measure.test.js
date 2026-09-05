import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatProvenanceScore,
  legacyProvenance,
  parseFiniteNumber,
  resolveMetricProvenance,
  resolveNestedProvenance,
  scoreProvenance,
} from './measure.js'

test('nullish, empty and whitespace-only inputs stay unknown', () => {
  for (const value of [null, undefined, '', '   ', '\t\n ']) {
    assert.equal(parseFiniteNumber(value), null, JSON.stringify(value))
  }
  assert.equal(parseFiniteNumber('abc'), null)
  assert.equal(parseFiniteNumber(Number.NaN), null)
  assert.equal(parseFiniteNumber(true), null)
})

test('a real numeric zero stays a measured zero', () => {
  assert.equal(parseFiniteNumber(0), 0)
  assert.equal(parseFiniteNumber('0'), 0)
  assert.equal(parseFiniteNumber(' 0 '), 0)
  assert.equal(parseFiniteNumber(82), 82)
  assert.equal(parseFiniteNumber('82.5'), 82.5)
})

test('unmeasured provenance never formats as a measured score', () => {
  assert.equal(formatProvenanceScore(scoreProvenance({})), 'Not measured')
  assert.equal(formatProvenanceScore(null), 'Not measured')
  assert.equal(formatProvenanceScore(''), 'Not measured')
})

test('html-heuristic values are labelled as estimates, never Lighthouse', () => {
  const entry = scoreProvenance({ value: 90, source: 'html_heuristic', status: 'estimated' })
  const text = formatProvenanceScore(entry)
  assert.match(text, /HTML estimate 90\/100/)
  assert.match(text, /not a Lighthouse measurement/)
  assert.doesNotMatch(text, /Lighthouse 90/)
})

test('legacy bare values keep their number but disclose the unknown source', () => {
  const entry = legacyProvenance(75)
  assert.equal(entry.value, 75)
  assert.equal(entry.source, 'legacy')
  assert.equal(entry.status, 'legacy')
  assert.match(formatProvenanceScore(entry), /Legacy value 75\/100 \(unknown source\)/)
  assert.equal(legacyProvenance(null).value, null)
  assert.equal(legacyProvenance('').status, 'unmeasured')
})

test('a genuine Lighthouse zero is still a measured zero', () => {
  const entry = scoreProvenance({ value: 0, source: 'lighthouse', status: 'measured' })
  assert.equal(entry.value, 0)
  assert.equal(formatProvenanceScore(entry), 'Lighthouse 0/100')
})

test('resolveMetricProvenance prefers records and treats bare values as legacy', () => {
  const measured = resolveMetricProvenance({ performance: 10, measureProvenance: { performance: { value: 82, source: 'lighthouse', status: 'measured' } } }, 'performance')
  assert.equal(measured.value, 82)
  assert.equal(measured.source, 'lighthouse')
  const legacy = resolveMetricProvenance({ accessibility: 93 }, 'accessibility')
  assert.equal(legacy.value, 93)
  assert.equal(legacy.source, 'legacy')
  const missing = resolveMetricProvenance({}, 'seo')
  assert.equal(missing.value, null)
  assert.equal(missing.status, 'unmeasured')
})

test('resolveNestedProvenance handles nested lighthouse scores', () => {
  const recorded = resolveNestedProvenance({ value: 100, source: 'lighthouse', status: 'measured' }, 50)
  assert.equal(recorded.value, 100)
  assert.equal(recorded.source, 'lighthouse')
  const fallback = resolveNestedProvenance(null, 70, { observedAt: '2026-09-05T00:00:00.000Z' })
  assert.equal(fallback.value, 70)
  assert.equal(fallback.source, 'legacy')
  assert.equal(fallback.observedAt, '2026-09-05T00:00:00.000Z')
  assert.equal(resolveNestedProvenance(null, null).status, 'unmeasured')
})
