import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHtml, assertPublicUrl, AuditError, checkInternalLinks, classifyCapture, classifyLinkOutcome, composeScoreProvenance, crawlWebsite, extractInternalLinks, fetchPublicStatus, fetchPublicText, isPrivateAddress, LINK_OUTCOMES, normalizeWebsite } from './audit.js'

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
  assert.ok(result.problems.some((problem) => /form #1.*asks for 9 details at once/i.test(problem)))
  assert.ok(result.evidence.some((item) => /Form .*field count: 9 visible fields/i.test(item)))
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

const ROH22_HOME = 'http://93.184.216.34'
const ROH22_OFFSITE = 'http://203.0.113.7'

function mockFetchResponse({ status = 200, location = null, contentType = 'text/html', chunks = null } = {}) {
  const text = (chunks || []).join('')
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => {
        const lower = String(name).toLowerCase()
        if (lower === 'location') return location
        if (lower === 'content-type') return contentType
        if (lower === 'content-length') return String(Buffer.byteLength(text))
        return null
      },
    },
    body: chunks ? {
      getReader() {
        const data = chunks.map((chunk) => Buffer.from(chunk))
        let index = 0
        return {
          read: async () => (index < data.length ? { done: false, value: data[index++] } : { done: true, value: undefined }),
          cancel: async () => {},
        }
      },
    } : undefined,
  }
}

function withMockFetch(handler) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push(String(url))
    return handler(new URL(url), options)
  }
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

function sitemapWith(count, host = ROH22_HOME) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  for (let i = 0; i < count; i += 1) xml += `<url><loc>${host}/p${i}</loc></url>`
  return `${xml}</urlset>`
}

test('a sitemap of failing URLs stops at the configured attempt cap', async () => {
  const mocked = withMockFetch(() => { throw new Error('connection refused') })
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body><h1>Home</h1></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      sitemapText: sitemapWith(1000),
      requestDelay: 0,
      maxAttempts: 25,
      maxQueue: 5000,
      timeLimitMs: 60000,
    })
    assert.equal(result.limits.attempts, 25)
    assert.equal(result.limits.stoppedBy, 'attempt-limit')
    assert.equal(result.pages.length, 1)
    assert.equal(result.errors.length, 25)
    assert.equal(mocked.calls.length, 25)
    assert.equal(result.status, 'Partial')
  } finally {
    mocked.restore()
  }
})

test('robots-disallowed links are never requested', async () => {
  const seen = []
  const robots = { isAllowed: (href) => !String(href).includes('/private') }
  const result = await checkInternalLinks(
    [{ href: `${ROH22_HOME}/ok` }, { href: `${ROH22_HOME}/private` }],
    {
      robots,
      checker: async (url) => {
        seen.push(url.href)
        return { url: url.href, status: 200 }
      },
    })
  assert.deepEqual(seen, [`${ROH22_HOME}/ok`])
  assert.equal(result.skippedRobots, 1)
  assert.equal(result.checked, 1)
})

test('same-origin candidates that redirect off-origin are recorded, not traversed', async () => {
  const mocked = withMockFetch((url) => {
    if (url.pathname === '/go') return mockFetchResponse({ status: 301, location: `${ROH22_OFFSITE}/elsewhere` })
    return mockFetchResponse({ chunks: ['<html><body><a href="/far">far</a></body></html>'] })
  })
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body><a href="/go">go</a></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      requestDelay: 0,
      maxAttempts: 10,
    })
    assert.equal(result.offOrigin.length, 1)
    assert.equal(result.offOrigin[0].finalUrl, `${ROH22_OFFSITE}/elsewhere`)
    assert.equal(result.pages.length, 1)
    assert.ok(result.pages.every((page) => !String(page.url).includes('203.0.113.7')))
    assert.equal(result.links.checked, 1)
    assert.ok(result.links.results.every((item) => !String(item.url).includes('203.0.113.7') || String(item.url).includes('93.184.216.34/go')))
  } finally {
    mocked.restore()
  }
})

test('redirect loops stop with an explicit reason', async () => {
  const mocked = withMockFetch(() => mockFetchResponse({ status: 301, location: `${ROH22_HOME}/loop` }))
  try {
    await assert.rejects(() => fetchPublicText(`${ROH22_HOME}/loop`), (error) => error.code === 'TOO_MANY_REDIRECTS')
    assert.equal(mocked.calls.length, 6)
  } finally {
    mocked.restore()
  }
})

test('private destinations are rejected before any request', async () => {
  const mocked = withMockFetch(() => mockFetchResponse({}))
  try {
    await assert.rejects(() => fetchPublicStatus('http://127.0.0.1/internal'), (error) => error.code === 'PRIVATE_NETWORK')
    assert.equal(mocked.calls.length, 0)
  } finally {
    mocked.restore()
  }
})

test('oversized bodies stop before the body is read', async () => {
  let readerCreated = false
  const mocked = withMockFetch(() => ({
    status: 200,
    ok: true,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? '99999999' : 'text/html') },
    body: { getReader: () => { readerCreated = true; throw new Error('should not read') } },
  }))
  try {
    await assert.rejects(() => fetchPublicText(`${ROH22_HOME}/big`), (error) => error.code === 'PAGE_TOO_LARGE')
    assert.equal(readerCreated, false)
  } finally {
    mocked.restore()
  }
})

test('long-running responses stop with a timeout reason', async () => {
  const mocked = withMockFetch((_url, options) => new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })))
  }))
  try {
    await assert.rejects(() => fetchPublicText(`${ROH22_HOME}/slow`, { timeoutMs: 60 }), (error) => error.code === 'TIMEOUT')
  } finally {
    mocked.restore()
  }
})

test('a cancelled crawl keeps partial evidence and says so', async () => {
  const seen = []
  const controller = new AbortController()
  controller.abort()
  const result = await crawlWebsite({
    homeHtml: '<html><body><a href="/a">a</a></body></html>',
    homeUrl: new URL(`${ROH22_HOME}/`),
    requestDelay: 0,
    signal: controller.signal,
  })
  assert.equal(result.pages.length, 1)
  assert.equal(result.limits.stoppedBy, 'cancelled')
  assert.equal(result.status, 'Partial')
  assert.equal(result.links.cancelled, true)
  assert.deepEqual(seen, [])
})

test('a tiny time budget stops collection with a time reason', async () => {
  const mocked = withMockFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    throw new Error('slow failure')
  })
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      sitemapText: sitemapWith(50),
      requestDelay: 0,
      maxAttempts: 1000,
      timeLimitMs: 5,
    })
    assert.equal(result.limits.stoppedBy, 'time-limit')
    assert.ok(result.limits.attempts >= 1 && result.limits.attempts < 50)
    assert.equal(result.status, 'Partial')
  } finally {
    mocked.restore()
  }
})

test('queue flooding stops collection before any page fetch', async () => {
  const mocked = withMockFetch(() => { throw new Error('unreachable') })
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      sitemapText: sitemapWith(100),
      requestDelay: 0,
      maxAttempts: 1000,
      maxQueue: 5,
    })
    assert.equal(result.limits.stoppedBy, 'queue-limit')
    assert.equal(result.limits.attempts, 0)
    assert.equal(result.pages.length, 1)
    assert.equal(mocked.calls.length, 0)
  } finally {
    mocked.restore()
  }
})

test('total byte budget stops collection across many small pages', async () => {
  const mocked = withMockFetch(() => mockFetchResponse({ chunks: ['<html><body><p>012345678901234567890123456789</p></body></html>'] }))
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      sitemapText: sitemapWith(10),
      requestDelay: 0,
      maxAttempts: 100,
      maxPages: 25,
      maxTotalBytes: 100,
    })
    assert.equal(result.limits.stoppedBy, 'byte-limit')
    assert.ok(result.pages.length >= 2 && result.pages.length <= 4)
  } finally {
    mocked.restore()
  }
})

test('two five-field forms do not trigger a single-form friction rule (ROH-24)', () => {
  const form = (id) => `<form id="${id}"><input name="a"><input name="b"><input name="c"><input name="d"><input name="e"></form>`
  const result = analyzeHtml(`<html><head><title>Acme Plumbing Services Company</title></head><body><h1>Plumbing</h1>${form('quote')}${form('contact')}<img src="a.jpg" alt="Technician fixing a sink"></body></html>`, new URL('https://example.com/'))
  assert.equal(result.auditSummary.forms, 2)
  assert.ok(!result.problems.some((problem) => /asks for .* details at once/i.test(problem)))
  assert.deepEqual(result.auditSummary.formDetails.map((item) => item.visibleFields), [5, 5])
  assert.deepEqual(result.auditSummary.formDetails.map((item) => item.locator), ['form#quote', 'form#contact'])
})

test('hidden and disabled inputs never count as user effort (ROH-24)', () => {
  const result = analyzeHtml(`<html><head><title>Acme Plumbing Services Company</title></head><body><h1>Plumbing</h1><form id="q"><input type="hidden" name="csrf" value="x"><input type="text" name="a"><input type="text" name="b" disabled><input type="submit" value="Go"></form><img src="a.jpg" alt="Van"></body></html>`, new URL('https://example.com/'))
  assert.equal(result.auditSummary.formDetails[0].visibleFields, 1)
  assert.equal(result.auditSummary.formDetails[0].hiddenFields, 2)
  assert.ok(!result.problems.some((problem) => /asks for .* details at once/i.test(problem)))
})

test('one genuinely long form is identified with its own locator (ROH-24)', () => {
  const fields = Array.from({ length: 9 }, (_, index) => `<input name="f${index}"${index < 3 ? ' required' : ''}>`).join('')
  const result = analyzeHtml(`<html><head><title>Acme Plumbing Services Company</title></head><body><h1>Plumbing</h1><form id="estimate">${fields}</form><img src="a.jpg" alt="Crew"></body></html>`, new URL('https://example.com/'))
  assert.ok(result.problems.some((problem) => /form#estimate.*asks for 9 details at once/i.test(problem)))
  assert.equal(result.auditSummary.formDetails[0].requiredFields, 3)
  assert.equal(result.auditSummary.formDetails[0].optionalFields, 6)
  assert.equal(result.auditRules.version, 2)
})

test('decorative, missing and descriptive alt produce distinct observations (ROH-24)', () => {
  const result = analyzeHtml('<html><head><title>Acme Plumbing Services Company</title></head><body><h1>Plumbing</h1><img src="a.jpg" alt="Technician on a roof"><img src="b.jpg" alt=""><img src="c.jpg"><img src="d.jpg"></body></html>', new URL('https://example.com/'))
  assert.deepEqual(result.auditSummary.imageAlt, { descriptive: 1, decorative: 1, missing: 2 })
  assert.ok(result.evidence.some((item) => /1 descriptive, 1 decorative \(alt=""\), 2 missing/.test(item)))
  assert.ok(result.problems.some((problem) => /2 homepage images have no alternative text/i.test(problem)))
  const clean = analyzeHtml('<html><head><title>Acme Plumbing Services Company</title></head><body><h1>Plumbing</h1><img src="a.jpg" alt="Crew"><img src="b.jpg" alt=""></body></html>', new URL('https://example.com/'))
  assert.ok(!clean.problems.some((problem) => /alternative text/i.test(problem)))
})

test('malformed and unrelated schema never assert valid LocalBusiness markup (ROH-24)', () => {
  const malformed = analyzeHtml('<html><head><title>Acme Plumbing Services Company</title><script type="application/ld+json">{not json</script></head><body><h1>Plumbing</h1></body></html>', new URL('https://example.com/'))
  assert.deepEqual(malformed.auditSummary.schemaBlocks, { total: 1, valid: 0, types: [] })
  assert.ok(malformed.problems.some((problem) => /could not be parsed as valid JSON-LD/i.test(problem)))
  const unrelated = analyzeHtml('<html><head><title>Acme Plumbing Services Company</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Hi"}</script></head><body><h1>Plumbing</h1></body></html>', new URL('https://example.com/'))
  assert.equal(unrelated.auditSummary.hasLocalBusinessSchema, false)
  assert.deepEqual(unrelated.auditSummary.schemaBlocks.types, ['Article'])
  assert.ok(!unrelated.problems.some((problem) => /LocalBusiness/i.test(problem)))
  const local = analyzeHtml('<html><head><title>Acme Plumbing Services Company</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Acme"}</script></head><body><h1>Plumbing</h1></body></html>', new URL('https://example.com/'))
  assert.equal(local.auditSummary.hasSchema, true)
  assert.equal(local.auditSummary.hasLocalBusinessSchema, true)
  assert.ok(local.evidence.some((item) => /types: Plumber/.test(item)))
})

test('a healthy small crawl still completes without a stop reason', async () => {
  const mocked = withMockFetch((url) => {
    if (url.pathname === '/linked') return mockFetchResponse({ chunks: ['<html><body>linked</body></html>'] })
    return mockFetchResponse({ status: 404 })
  })
  try {
    const result = await crawlWebsite({
      homeHtml: '<html><body><a href="/linked">linked</a></body></html>',
      homeUrl: new URL(`${ROH22_HOME}/`),
      requestDelay: 0,
      maxAttempts: 10,
    })
    assert.equal(result.limits.stoppedBy, null)
    assert.equal(result.pages.length, 2)
    assert.equal(result.status, 'Completed')
  } finally {
    mocked.restore()
  }
})
