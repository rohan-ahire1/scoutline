import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMuseEvidencePacket, extractLighthouseEvidence, validateMuseAnalysis } from './insights.js'

test('builds a bounded Muse packet from saved audit evidence', () => {
  const lead = {
    company: 'Acme Roofing', category: 'Roofing', location: 'Salt Lake City', website: 'acme.example',
    rating: 4.8, reviews: 125, opportunityScore: 76, confidence: 91, analysisSource: 'Multi-page website audit + Lighthouse',
    mainIssue: 'Mobile performance', issueDetail: 'The measured score is low.', performance: 42, accessibility: 93, seo: 100,
    checkedLinks: 12, brokenLinks: 1, pageCount: 3, problems: Array.from({ length: 12 }, (_, index) => `Finding ${index}`),
    evidence: ['Lighthouse mobile performance: 42/100'], crawlPages: [{ url: 'https://acme.example/', path: '/', title: 'Acme', h1Count: 1, wordCount: 400, forms: 1, inputCount: 4 }],
  }
  const packet = buildMuseEvidencePacket(lead)
  assert.equal(packet.measuredAudit.scores.performance.value, 42)
  assert.equal(packet.measuredAudit.scores.performance.source, 'legacy')
  assert.equal(packet.measuredAudit.scores.performance.status, 'legacy')
  assert.equal(packet.deterministicAssessment.opportunityScore, 76)
  assert.equal(packet.deterministicAssessment.findings.length, 8)
  assert.equal(packet.crawledPages[0].h1Count, 1)
})

test('evidence packet carries measurement provenance instead of bare scores', () => {
  const packet = buildMuseEvidencePacket({
    company: 'Acme', performance: null, accessibility: 88, seo: 92,
    measureProvenance: {
      performance: { value: null, source: null, status: 'unmeasured' },
      accessibility: { value: 88, source: 'html_heuristic', status: 'estimated' },
      seo: { value: 92, source: 'html_heuristic', status: 'estimated' },
    },
  })
  assert.equal(packet.measuredAudit.scores.performance.value, null)
  assert.equal(packet.measuredAudit.scores.performance.status, 'unmeasured')
  assert.equal(packet.measuredAudit.scores.accessibility.source, 'html_heuristic')
  assert.equal(packet.measuredAudit.scores.accessibility.status, 'estimated')
  assert.equal(packet.measuredAudit.scores.seo.value, 92)
})

test('whitespace-only metrics never become measured zeros in the packet', () => {
  const packet = buildMuseEvidencePacket({ company: 'Acme', performance: '   ', accessibility: '', seo: null })
  assert.equal(packet.measuredAudit.scores.performance.value, null)
  assert.equal(packet.measuredAudit.scores.accessibility.value, null)
})

test('extracts only failed, useful Lighthouse audits', () => {
  const evidence = extractLighthouseEvidence({ audits: {
    good: { id: 'good', title: 'Good', score: 1, scoreDisplayMode: 'binary' },
    bad: { id: 'bad', title: 'Large images', score: 0, scoreDisplayMode: 'metricSavings', displayValue: 'Potential savings of 400 KiB' },
    info: { id: 'info', title: 'Info', score: null, scoreDisplayMode: 'informative' },
  } })
  assert.deepEqual(evidence.map((item) => item.id), ['bad'])
})

test('validates a structured Muse result without changing the deterministic score', () => {
  const result = validateMuseAnalysis({
    summary: 'The audit shows a clear, measurable mobile performance opportunity.',
    topOpportunities: [{ title: 'Improve load speed', severity: 'High', evidence: 'Performance measured 42/100', whyItMatters: 'A slower page may create friction.', recommendation: 'Optimize large images and render-blocking assets.' }],
    strengths: ['SEO measured 100/100'], unknowns: ['Conversion rate was not measured'],
    qualificationRecommendation: 'Pursue', qualificationRationale: 'There is a specific addressable opportunity.', outreachAngles: ['Lead with the measured mobile performance result.'],
  })
  assert.equal(result.qualificationRecommendation, 'Pursue')
  assert.equal(result.topOpportunities[0].severity, 'High')
  assert.equal('opportunityScore' in result, false)
})
