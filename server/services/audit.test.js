import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHtml, assertPublicUrl, checkInternalLinks, classifyCapture, classifyLinkOutcome, composeScoreProvenance, extractInternalLinks, fetchPublicStatus, isPrivateAddress, LINK_OUTCOMES, normalizeWebsite } from './audit.js'

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

test('link outcomes separate broken pages from blocked and failed checks', () => {
  assert.equal(classifyLinkOutcome({ status: 200 }), LINK_OUTCOMES.REACHABLE)
  assert.equal(classifyLinkOutcome({ status: 301 }), LINK_OUTCOMES.REACHABLE)
  assert.equal(classifyLinkOutcome({ status: 404 }), LINK_OUTCOMES.CONFIRMED_BROKEN)
  assert.equal(classifyLinkOutcome({ status: 410 }), LINK_OUTCOMES.CONFIRMED_BROKEN)
  assert.equal(classifyLinkOutcome({ status: 401 }), LINK_OUTCOMES.BLOCKED)
  assert.equal(classifyLinkOutcome({ status: 403 }), LINK_OUTCOMES.BLOCKED)
  assert.equal(classifyLinkOutcome({ status: 429 }), LINK_OUTCOMES.RATE_LIMITED)
  assert.equal(classifyLinkOutcome({ status: 500 }), LINK_OUTCOMES.SERVICE_ERROR)
  assert.equal(classifyLinkOutcome({ status: 503 }), LINK_OUTCOMES.SERVICE_ERROR)
  assert.equal(classifyLinkOutcome({ error: new Error('The link could not be checked: timeout'), code: 'TIMEOUT' }), LINK_OUTCOMES.TIMEOUT)
  assert.equal(classifyLinkOutcome({ error: new Error('Could not resolve host'), code: 'DNS_FAILED' }), LINK_OUTCOMES.NETWORK_ERROR)
  assert.equal(classifyLinkOutcome({ error: new Error('socket hang up'), code: 'FETCH_FAILED' }), LINK_OUTCOMES.NETWORK_ERROR)
  assert.equal(classifyLinkOutcome({ error: new Error('The link redirected too many times'), code: 'TOO_MANY_REDIRECTS' }), LINK_OUTCOMES.UNCHECKED)
})

test('a timeout is unverified and adds zero broken-link score', async () => {
  const timeoutError = new Error('The link could not be checked: operation timed out')
  timeoutError.name = 'TimeoutError'
  timeoutError.code = 'TIMEOUT'
  const checked = await checkInternalLinks([new URL('https://example.com/slow')], {
    checker: () => { throw timeoutError },
  })
  assert.equal(checked.checked, 1)
  assert.equal(checked.broken, 0)
  assert.equal(checked.unverified, 1)
  assert.equal(checked.results[0].outcome, LINK_OUTCOMES.TIMEOUT)
  assert.equal(checked.results[0].broken, false)
  assert.equal(checked.results[0].verified, false)
})

test('mixed link outcomes produce explicit totals and Partial status', async () => {
  const script = [
    { status: 200, url: 'https://example.com/ok' },
    { status: 404, url: 'https://example.com/gone' },
    { status: 410, url: 'https://example.com/removed' },
    { status: 401, url: 'https://example.com/private' },
    { status: 403, url: 'https://example.com/denied' },
    { status: 429, url: 'https://example.com/limited' },
    { status: 500, url: 'https://example.com/error' },
  ]
  const failures = new Map([
    ['https://example.com/timeout', Object.assign(new Error('The link could not be checked: TimeoutError'), { code: 'TIMEOUT' })],
    ['https://example.com/dns', Object.assign(new Error('Could not resolve nowhere.invalid'), { code: 'DNS_FAILED' })],
  ])
  const checked = await checkInternalLinks(
    [...script.map((item) => new URL(item.url)), ...[...failures.keys()].map((href) => new URL(href))],
    {
      checker: (url) => {
        if (failures.has(url.href)) throw failures.get(url.href)
        const hit = script.find((item) => item.url === url.href)
        return { url: url.href, status: hit.status, ok: hit.status < 400 }
      },
    },
  )
  assert.equal(checked.checked, 9)
  assert.equal(checked.broken, 2)
  assert.equal(checked.reachable, 1)
  assert.equal(checked.unverified, 6)
  assert.deepEqual(checked.byOutcome, {
    reachable: 1, confirmed_broken: 2, blocked: 2, rate_limited: 1, service_error: 1, timeout: 1, network_error: 1,
  })
  assert.equal(checked.status, 'Partial')
})

test('all-verified links keep a Completed component status', async () => {
  const checked = await checkInternalLinks([new URL('https://example.com/a'), new URL('https://example.com/b')], {
    checker: (url) => ({ url: url.href, status: url.href.endsWith('/a') ? 200 : 404, ok: url.href.endsWith('/a') }),
  })
  assert.equal(checked.status, 'Completed')
  assert.equal(checked.broken, 1)
})

test('HEAD 405 falls back to a bounded ranged GET', async () => {
  // Public IP literals skip DNS so the transport can be stubbed deterministically.
  const calls = []
  const realFetch = globalThis.fetch
  const response = (status, headers = {}) => ({
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: { cancel: async () => {} },
  })
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ href: String(url), method: options.method, range: options.headers?.Range })
    if (String(url).endsWith('/fallback')) {
      if (options.method === 'HEAD') return response(405)
      return response(200)
    }
    if (String(url).endsWith('/redirect')) {
      return response(301, { location: 'http://93.184.216.34/fallback' })
    }
    return response(200)
  }
  try {
    const direct = await fetchPublicStatus('http://93.184.216.34/fallback', { timeoutMs: 2000 })
    assert.equal(direct.status, 200)
    assert.equal(direct.method, 'GET')
    assert.equal(direct.attempts, 2)
    const viaRedirect = await fetchPublicStatus('http://93.184.216.34/redirect', { timeoutMs: 2000 })
    assert.equal(viaRedirect.status, 200)
    assert.equal(viaRedirect.url, 'http://93.184.216.34/fallback')
    assert.ok(calls.some((call) => call.range === 'bytes=0-1023'), 'GET fallback must be range-limited')
  } finally {
    globalThis.fetch = realFetch
  }
})
