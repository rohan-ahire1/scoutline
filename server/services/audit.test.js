import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHtml, assertPublicUrl, classifyCapture, composeScoreProvenance, extractInternalLinks, isPrivateAddress, normalizeWebsite } from './audit.js'

test('normalizes public website inputs', () => {
  assert.equal(normalizeWebsite('example.com').href, 'https://example.com/')
  assert.throws(() => normalizeWebsite('file:///tmp/private'), /Only HTTP and HTTPS/)
})

test('blocks local and private targets before a fetch', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('10.4.3.2'), true)
  assert.equal(isPrivateAddress('192.168.1.8'), true)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  await assert.rejects(() => assertPublicUrl('http://localhost:8787'), (error) => error.code === 'PRIVATE_NETWORK')
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1'), (error) => error.code === 'PRIVATE_NETWORK')
})

test('turns observable homepage markup into evidence and a score', () => {
  const result = analyzeHtml('<html><head><title>Acme</title></head><body><h1>Roofing</h1><form><input><input><input><input><input><input><input><input><input></form><img src="hero.jpg"></body></html>', new URL('https://example.com/'))
  assert.equal(result.analysisSource, 'Deterministic website audit')
  assert.ok(result.opportunityScore >= 60)
  assert.ok(result.problems.some((problem) => /form asks for many details/i.test(problem)))
  assert.ok(result.evidence.some((item) => /Form field count/i.test(item)))
})

test('extracts safe same-site crawl candidates without action routes', () => {
  const links = extractInternalLinks(`
    <a href="/services">Services</a>
    <a href="https://example.com/services#roofing">Duplicate</a>
    <a href="/contact?from=home">Contact</a>
    <a href="/logout">Logout</a>
    <a href="https://other.example/about">External</a>
  `, new URL('https://example.com/'))
  assert.deepEqual(links.map((url) => url.href), ['https://example.com/services', 'https://example.com/contact?from=home'])
})

test('failed Lighthouse audits keep estimates labelled as estimates', () => {
  const failed = composeScoreProvenance({ status: 'Failed', error: 'timeout' }, { accessibility: 88, seo: 92 }, { observedAt: '2026-09-05T00:00:00.000Z' })
  assert.equal(failed.performance.value, null)
  assert.equal(failed.performance.status, 'unmeasured')
  assert.equal(failed.accessibility.value, 88)
  assert.equal(failed.accessibility.source, 'html_heuristic')
  assert.equal(failed.accessibility.status, 'estimated')
  assert.equal(failed.seo.source, 'html_heuristic')
  assert.equal(failed.bestPractices.status, 'unmeasured')
})

test('completed Lighthouse audits record measured provenance', () => {
  const done = composeScoreProvenance({ status: 'Completed', fetchedAt: '2026-09-05T00:00:00.000Z', scores: { performance: 0, accessibility: 93, 'bestPractices': 100, seo: 91 } }, { accessibility: 70, seo: 60 })
  assert.equal(done.performance.value, 0)
  assert.equal(done.performance.source, 'lighthouse')
  assert.equal(done.performance.status, 'measured')
  assert.equal(done.accessibility.value, 93)
  assert.equal(done.accessibility.source, 'lighthouse')
})

test('classifies capture quality before any finding is assessed', () => {
  assert.equal(classifyCapture({ text: '<html><head><title>Acme Roofing</title></head><body><h1>Roofers</h1><p>We fix roofs across the valley with free estimates.</p></body></html>', contentType: 'text/html' }).quality, 'usable-html')
  assert.equal(classifyCapture({ text: '<html><body><div id="root"></div><script src="app.js"></script></body></html>', contentType: 'text/html' }).quality, 'js-shell')
  assert.equal(classifyCapture({ text: '<html><head><title>Just a moment...</title></head><body>Verifying you are human</body></html>', contentType: 'text/html' }).quality, 'challenge')
  assert.equal(classifyCapture({ text: '{"ok":true}', contentType: 'application/json' }).quality, 'unsupported-content')
  assert.equal(classifyCapture({ text: '   \n  ', contentType: 'text/html' }).quality, 'empty-response')
})

test('a JavaScript shell yields no score instead of a high opportunity', () => {
  const result = analyzeHtml('<html><body><div id="root"></div><script src="app.js"></script></body></html>', new URL('https://example.com/'))
  assert.equal(result.researchStatus, 'Inconclusive')
  assert.equal(result.opportunityScore, null)
  assert.equal(result.confidence, null)
  assert.deepEqual(result.problems, [])
  assert.equal(result.captureQuality.quality, 'js-shell')
  assert.equal(result.captureQuality.renderedFallback, 'deferred')
  assert.match(result.issueDetail, /JavaScript application shell/i)
})

test('challenge, JSON and empty captures are inconclusive without defect claims', () => {
  const challenge = analyzeHtml('<html><head><title>Just a moment...</title></head><body>checking your browser</body></html>', new URL('https://example.com/'))
  assert.equal(challenge.researchStatus, 'Inconclusive')
  assert.equal(challenge.opportunityScore, null)
  assert.equal(challenge.captureQuality.quality, 'challenge')
  const json = analyzeHtml('{"data":[]}', new URL('https://example.com/'), null, { contentType: 'application/json' })
  assert.equal(json.captureQuality.quality, 'unsupported-content')
  assert.equal(json.opportunityScore, null)
  const empty = analyzeHtml('  ', new URL('https://example.com/'))
  assert.equal(empty.captureQuality.quality, 'empty-response')
  assert.equal(empty.confidence, null)
})

test('confidence follows fired checks, not boilerplate volume', () => {
  const healthy = analyzeHtml('<html><head><title>Acme Roofing — Free Estimates Across the Valley</title><meta name="description" content="Licensed and insured roofers serving the valley for twenty years with free estimates and warranties on every job we complete here"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"></head><body><h1>Roofers you can trust</h1><a href="tel:+1555">Call now for a free quote today</a><a href="/contact">Contact our licensed team</a><img src="crew.jpg" alt="Our insured roofing crew on a valley home"><script type="application/ld+json">{"@type":"LocalBusiness"}</script><p>Testimonials and financing available with guarantees on every roof we install for valley homeowners today.</p></body></html>', new URL('https://example.com/'))
  assert.equal(healthy.researchStatus, 'Analyzed')
  assert.ok(healthy.opportunityScore < 60, `healthy page scored ${healthy.opportunityScore}`)
  const sparse = analyzeHtml('<html><head><title>Acme</title></head><body><h1>Roofing</h1></body></html>', new URL('https://example.com/'))
  assert.ok(sparse.confidence > healthy.confidence, `sparse ${sparse.confidence} vs healthy ${healthy.confidence}`)
  assert.ok(sparse.opportunityScore > healthy.opportunityScore)
})
