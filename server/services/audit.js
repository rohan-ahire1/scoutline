import { load } from 'cheerio'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import robotsParser from 'robots-parser'
import { MEASURE_SOURCES, scoreProvenance } from './measure.js'
import { CHROME_SAFETY_FLAGS, CRAWL_LIMITS, createCrawlBounds, collectionStopEvidence, isSameSite, splitAllowedUrls } from './crawlPolicy.js'

const MAX_PAGE_BYTES = CRAWL_LIMITS.maxBytesPerPage
const USER_AGENT = 'ScoutlineResearchBot/1.0 (+local, manual research)'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NON_PAGE_EXTENSION = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mov|mp3|mp4|pdf|png|pptx?|rar|rss|svg|tar|tiff?|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i
const ACTION_PATH = /\/(?:account|admin|cart|checkout|login|logout|sign-in|signout|wp-admin)(?:\/|$)/i

export class AuditError extends Error {
  constructor(message, code = 'AUDIT_FAILED') {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

export function normalizeWebsite(value) {
  const input = String(value || '').trim()
  if (!input) throw new AuditError('No website was provided', 'INVALID_URL')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`
  let url
  try { url = new URL(candidate) } catch { throw new AuditError('The website URL is invalid', 'INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AuditError('Only HTTP and HTTPS websites can be audited', 'INVALID_URL')
  if (url.username || url.password) throw new AuditError('Website URLs cannot contain credentials', 'INVALID_URL')
  url.hash = ''
  return url
}

export function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0].replace(/^\[|\]$/g, '')
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (isIP(value) === 6) {
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice(7)
      if (isIP(mapped) === 4) return isPrivateAddress(mapped)
      const groups = mapped.split(':')
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0], 16)
        const low = Number.parseInt(groups[1], 16)
        if (Number.isFinite(high) && Number.isFinite(low)) return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
      }
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('ff') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') ||
      value.startsWith('::ffff:192.168.')
  }
  return false
}

export async function assertPublicUrl(input) {
  const url = input instanceof URL ? input : normalizeWebsite(input)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AuditError('Private and local network targets are blocked', 'PRIVATE_NETWORK')
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new AuditError('Private and local network targets are blocked', 'PRIVATE_NETWORK')
  let addresses
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 3_000)),
    ])
  } catch {
    throw new AuditError(`Could not resolve ${hostname}`, 'DNS_FAILED')
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AuditError('Private and local network targets are blocked', 'PRIVATE_NETWORK')
  }
  return url
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new AuditError('The page is larger than the audit limit', 'PAGE_TOO_LARGE')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new AuditError('The page is larger than the audit limit', 'PAGE_TOO_LARGE')
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => { joined.set(chunk, offset); offset += chunk.byteLength })
  return new TextDecoder().decode(joined)
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new AuditError('Collection was cancelled; partial evidence is preserved', 'CANCELLED')
}

function combineSignals(signals) {
  const active = (signals || []).filter(Boolean)
  if (!active.length) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  return active[0]
}

export async function fetchPublicText(input, options = {}) {
  let url = normalizeWebsite(input)
  const maxRedirects = options.maxRedirects ?? CRAWL_LIMITS.maxRedirects
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES
  let redirects = 0
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    throwIfCancelled(options.signal)
    await assertPublicUrl(url)
    let response
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: combineSignals([options.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.8' },
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new AuditError('The website timed out', 'TIMEOUT')
      if (options.signal?.aborted || error?.name === 'AbortError') throw new AuditError('Collection was cancelled; partial evidence is preserved', 'CANCELLED')
      throw new AuditError(`The website could not be reached: ${error.message}`, 'FETCH_FAILED')
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new AuditError('The website returned an invalid redirect', 'BAD_REDIRECT')
      await response.body?.cancel().catch(() => {})
      url = new URL(location, url)
      redirects += 1
      continue
    }
    if (!response.ok) throw new AuditError(`The website returned HTTP ${response.status}`, 'HTTP_ERROR')
    const text = await readLimitedBody(response, maxBytes)
    return { text, url, status: response.status, contentType: response.headers.get('content-type') || '', redirects, bytes: text.length }
  }
  throw new AuditError('The website redirected too many times', 'TOO_MANY_REDIRECTS')
}

export async function fetchPublicStatus(input, options = {}) {
  let url = normalizeWebsite(input)
  const maxRedirects = options.maxRedirects ?? CRAWL_LIMITS.maxRedirects
  let attempts = 0
  let method = 'HEAD'
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    throwIfCancelled(options.signal)
    await assertPublicUrl(url)
    let response
    try {
      attempts += 1
      response = await fetch(url, {
        method: 'HEAD', redirect: 'manual', signal: combineSignals([options.signal, AbortSignal.timeout(options.timeoutMs ?? 7_000)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8' },
      })
      if ([405, 501].includes(response.status)) {
        // Bounded HEAD-to-GET fallback: one ranged retry, body cancelled.
        await response.body?.cancel().catch(() => {})
        attempts += 1
        method = 'GET'
        response = await fetch(url, {
          method: 'GET', redirect: 'manual', signal: combineSignals([options.signal, AbortSignal.timeout(options.timeoutMs ?? 7_000)]),
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8', Range: 'bytes=0-1023' },
        })
      }
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        const timeout = new AuditError('The link check timed out', 'TIMEOUT')
        timeout.attempts = attempts
        timeout.method = method
        throw timeout
      }
      if (options.signal?.aborted || error?.name === 'AbortError') {
        const cancelled = new AuditError('Link checking was cancelled', 'CANCELLED')
        cancelled.attempts = attempts
        cancelled.method = method
        throw cancelled
      }
      const failure = new AuditError(`The link could not be checked: ${error.message}`, 'FETCH_FAILED')
      failure.attempts = attempts
      failure.method = method
      throw failure
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        const failure = new AuditError('The link returned an invalid redirect', 'BAD_REDIRECT')
        failure.attempts = attempts
        failure.method = method
        throw failure
      }
      await response.body?.cancel().catch(() => {})
      url = new URL(location, url)
      continue
    }
    await response.body?.cancel().catch(() => {})
    return { url: url.href, status: response.status, ok: response.status < 400, attempts, method }
  }
  const failure = new AuditError('The link redirected too many times', 'TOO_MANY_REDIRECTS')
  failure.attempts = attempts
  failure.method = method
  throw failure
}

function normalizeInternalLink(value, baseUrl) {
  try {
    const target = new URL(value, baseUrl)
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== baseUrl.origin) return null
    if (ACTION_PATH.test(target.pathname)) return null
    target.hash = ''
    return target
  } catch { return null }
}

export function extractInternalLinks(html, baseUrl) {
  const $ = load(html)
  const links = new Map()
  $('a[href]').each((_, element) => {
    const target = normalizeInternalLink($(element).attr('href'), baseUrl)
    if (target) links.set(target.href, target)
  })
  return [...links.values()]
}

function pageCandidate(url) {
  if (NON_PAGE_EXTENSION.test(url.pathname)) return null
  const candidate = new URL(url)
  candidate.search = ''
  return candidate
}

function summarizePage(html, url) {
  const $ = load(html)
  const bodyText = cleanText($('body').text())
  return {
    url: url.href,
    path: url.pathname || '/',
    title: cleanText($('title').first().text()),
    h1Count: $('h1').length,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
    forms: $('form').length,
    inputCount: $('form input, form textarea, form select').length,
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export const LINK_OUTCOMES = {
  REACHABLE: 'reachable',
  CONFIRMED_BROKEN: 'confirmed_broken',
  BLOCKED: 'blocked',
  RATE_LIMITED: 'rate_limited',
  SERVICE_ERROR: 'service_error',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  UNCHECKED: 'unchecked',
}

// A failed check is unavailable evidence, not a proven dead page. Only
// definitive missing-resource responses count as confirmed broken.
export function classifyLinkOutcome({ status = null, error = null, code = null } = {}) {
  if (status != null) {
    if (status < 400) return LINK_OUTCOMES.REACHABLE
    if (status === 404 || status === 410) return LINK_OUTCOMES.CONFIRMED_BROKEN
    if (status === 401 || status === 403) return LINK_OUTCOMES.BLOCKED
    if (status === 429) return LINK_OUTCOMES.RATE_LIMITED
    if (status >= 500) return LINK_OUTCOMES.SERVICE_ERROR
    return LINK_OUTCOMES.CONFIRMED_BROKEN
  }
  if (code === 'TIMEOUT') return LINK_OUTCOMES.TIMEOUT
  if (code === 'DNS_FAILED') return LINK_OUTCOMES.NETWORK_ERROR
  if (code === 'FETCH_FAILED') return LINK_OUTCOMES.NETWORK_ERROR
  if (error && /timeout/i.test(error.message || '')) return LINK_OUTCOMES.TIMEOUT
  return LINK_OUTCOMES.UNCHECKED
}

export async function checkInternalLinks(urls, options = {}) {
  const checkOne = options.checker || ((url) => fetchPublicStatus(url, { timeoutMs: options.timeoutMs || 7_000, signal: options.signal }))
  // Robots-disallowed destinations are filtered BEFORE any request so the
  // checker never fetches them; they are reported, not silently dropped.
  const { allowed, skipped } = splitAllowedUrls(urls, options.robots || null, USER_AGENT)
  const skippedRobots = skipped.length
  const targets = [...new Map(allowed.map((url) => [url.href, url])).values()].slice(0, Math.max(1, Math.min(100, Number(options.limit || CRAWL_LIMITS.maxLinks))))
  const observedAt = new Date().toISOString()
  let cancelled = Boolean(options.signal?.aborted)
  const results = await mapConcurrent(targets, Math.max(1, Math.min(8, Number(options.concurrency || CRAWL_LIMITS.maxLinkConcurrency))), async (url) => {
    if (options.signal?.aborted) {
      cancelled = true
      return { __cancelled: true }
    }
    try {
      const result = await checkOne(url)
      const outcome = classifyLinkOutcome({ status: result.status })
      return {
        url: url.href, finalUrl: result.url || url.href, status: result.status, outcome,
        broken: outcome === LINK_OUTCOMES.CONFIRMED_BROKEN, verified: outcome === LINK_OUTCOMES.REACHABLE || outcome === LINK_OUTCOMES.CONFIRMED_BROKEN,
        error: null, code: null, observedAt, attempts: result.attempts || 1, method: result.method || 'HEAD',
      }
    } catch (error) {
      // Fallback exhaustion or a transport failure is unverified — never a
      // broken-link assertion.
      const outcome = classifyLinkOutcome({ error, code: error?.code })
      return {
        url: url.href, finalUrl: url.href, status: null, outcome,
        broken: false, verified: false,
        error: error?.message || 'Link check failed', code: error?.code || 'CHECK_FAILED', observedAt, attempts: error?.attempts || 1, method: error?.method || 'HEAD',
      }
    }
  })
  const completed = results.filter((result) => !result?.__cancelled)
  const byOutcome = {}
  for (const result of completed) byOutcome[result.outcome] = (byOutcome[result.outcome] || 0) + 1
  const confirmed = byOutcome[LINK_OUTCOMES.CONFIRMED_BROKEN] || 0
  const reachable = byOutcome[LINK_OUTCOMES.REACHABLE] || 0
  return {
    checked: completed.length,
    broken: confirmed,
    reachable,
    unverified: completed.length - reachable - confirmed,
    byOutcome,
    results: completed,
    skippedRobots,
    cancelled,
    truncated: allowed.length > targets.length,
    status: cancelled ? 'Partial' : (!completed.length || (completed.every((result) => result.verified) && !completed.some((result) => result.outcome === LINK_OUTCOMES.SERVICE_ERROR)) ? 'Completed' : 'Partial'),
  }
}

export async function crawlWebsite({ homeHtml, homeUrl, sitemapText = '', robots = null, maxPages = 10, requestDelay = 500, maxLinks = 50, onProgress = null, maxAttempts, maxQueue, maxTotalBytes, timeLimitMs, signal = null }) {
  const pageLimit = Math.max(1, Math.min(25, Number(maxPages || CRAWL_LIMITS.maxPages)))
  const delay = Math.max(0, Math.min(3_000, Number(requestDelay || 0)))
  const bounds = createCrawlBounds({ maxAttempts, maxQueue, maxTotalBytes, timeLimitMs })
  const homeOrigin = new URL(homeUrl).origin
  const pages = [summarizePage(homeHtml, homeUrl)]
  const errors = []
  const offOrigin = []
  const visited = new Set([homeUrl.href])
  const discoveredLinks = new Map(extractInternalLinks(homeHtml, homeUrl).map((url) => [url.href, url]))
  const enqueue = (candidate) => {
    if (!candidate || visited.has(candidate.href)) return
    if (queue.length >= bounds.limits.maxQueue) {
      bounds.noteQueue(queue.length + 1)
      return
    }
    queue.push(candidate)
  }
  const queue = []
  extractInternalLinks(homeHtml, homeUrl).map(pageCandidate).filter(Boolean).forEach(enqueue)
  if (sitemapText) {
    const sitemap = load(sitemapText, { xmlMode: true })
    sitemap('loc').each((_, element) => {
      const target = normalizeInternalLink(sitemap(element).text(), homeUrl)
      const candidate = target && pageCandidate(target)
      if (candidate) enqueue(candidate)
    })
  }
  bounds.noteQueue(queue.length)

  while (queue.length && pages.length < pageLimit && !bounds.stopped()) {
    if (signal?.aborted) {
      bounds.cancel()
      break
    }
    if (!bounds.checkTime()) break
    const candidate = queue.shift()
    if (!candidate || visited.has(candidate.href)) continue
    visited.add(candidate.href)
    if (robots?.isAllowed(candidate.href, USER_AGENT) === false) continue
    if (!bounds.claimAttempt()) break
    if (delay) await wait(delay)
    try {
      const page = await fetchPublicText(candidate, { timeoutMs: 12_000, maxBytes: MAX_PAGE_BYTES, signal })
      bounds.noteRedirects(page.redirects)
      if (!isSameSite(page.url, homeOrigin)) {
        // A same-origin candidate redirected off-origin: record it, but never
        // traverse the foreign page as same-site content.
        offOrigin.push({ from: candidate.href, finalUrl: page.url.href })
        continue
      }
      if (!/html|xhtml/i.test(page.contentType) && !/<html[\s>]/i.test(page.text)) continue
      if (!bounds.addPage(page.bytes)) break
      pages.push(summarizePage(page.text, page.url))
      extractInternalLinks(page.text, page.url).forEach((url) => {
        discoveredLinks.set(url.href, url)
        enqueue(pageCandidate(url))
      })
      if (bounds.stopped()) break
      onProgress?.({ phase: 'Crawling pages', pages: pages.length, pageLimit })
    } catch (error) {
      if (error?.code === 'CANCELLED' || signal?.aborted) {
        bounds.cancel()
        break
      }
      errors.push({ url: candidate.href, code: error.code || 'CRAWL_FAILED', error: error.message })
    }
  }

  onProgress?.({ phase: 'Checking links', checked: 0 })
  const links = await checkInternalLinks([...discoveredLinks.values()], { limit: maxLinks, concurrency: 5, robots, signal })
  const limits = bounds.summary()
  return {
    pages,
    errors,
    links,
    offOrigin,
    discoveredPages: visited.size + queue.length,
    pageLimit,
    limits,
    truncated: queue.length > 0,
    status: limits.stoppedBy || errors.length || links.cancelled ? 'Partial' : 'Completed',
  }
}

function auditNumber(lhr, id, digits = 0) {
  const value = lhr?.audits?.[id]?.numericValue
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

export async function runLighthouseAudit(input, options = {}) {
  const url = await assertPublicUrl(input)
  const [{ default: lighthouse }, chromeLauncher] = await Promise.all([import('lighthouse'), import('chrome-launcher')])
  const chrome = await chromeLauncher.launch({
    chromePath: options.chromePath || process.env.CHROME_PATH || undefined,
    chromeFlags: [...CHROME_SAFETY_FLAGS],
  })
  try {
    const result = await lighthouse(url.href, {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      maxWaitForLoad: Math.max(15_000, Math.min(60_000, Number(options.timeoutMs || 35_000))),
    })
    if (!result?.lhr) throw new AuditError('Lighthouse returned no report', 'LIGHTHOUSE_EMPTY')
    if (result.lhr.runtimeError) throw new AuditError(result.lhr.runtimeError.message || 'Lighthouse could not load the page', result.lhr.runtimeError.code || 'LIGHTHOUSE_FAILED')
    const score = (category) => Number.isFinite(result.lhr.categories?.[category]?.score) ? Math.round(result.lhr.categories[category].score * 100) : null
    const summary = {
      status: 'Completed',
      version: result.lhr.lighthouseVersion,
      finalUrl: result.lhr.finalDisplayedUrl || result.lhr.finalUrl,
      fetchedAt: result.lhr.fetchTime,
      scores: {
        performance: score('performance'), accessibility: score('accessibility'),
        bestPractices: score('best-practices'), seo: score('seo'),
      },
      metrics: {
        firstContentfulPaintMs: auditNumber(result.lhr, 'first-contentful-paint'),
        largestContentfulPaintMs: auditNumber(result.lhr, 'largest-contentful-paint'),
        speedIndexMs: auditNumber(result.lhr, 'speed-index'),
        totalBlockingTimeMs: auditNumber(result.lhr, 'total-blocking-time'),
        cumulativeLayoutShift: auditNumber(result.lhr, 'cumulative-layout-shift', 3),
        interactiveMs: auditNumber(result.lhr, 'interactive'),
      },
    }
    return { summary, report: result.lhr }
  } finally {
    await chrome.kill()
  }
}

function robotsAllowsHomepage(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean)
  let applies = false
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':')
    const key = rawKey.toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') applies = value === '*'
    if (applies && key === 'disallow' && value === '/') return false
  }
  return true
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

const SUPPORTED_CONTENT = /html|xhtml/i
const APP_MOUNT_ID = /^(root|app|__next|main|content|app-root)$/i
const CHALLENGE_PATTERNS = [
  /just a moment/i, /attention required/i, /verify you are (a )?human/i, /captcha/i,
  /cf-challenge|__cf_chl|checking your browser/i, /datadome|perimeterx|kasada|arkose/i,
  /access denied/i, /forbidden/i, /request blocked/i, /are you a robot/i,
  /unusual traffic/i, /enable javascript and cookies/i,
]

// Capture-quality gate: negative DOM findings are only valid when the fetched
// page is usable HTML. Anything else is inconclusive, never evidence of defects.
export function classifyCapture({ text = '', contentType = '', url = null } = {}) {
  const body = String(text || '')
  const type = String(contentType || '').split(';')[0].trim()
  if (!body.trim()) {
    return { quality: 'empty-response', reason: `The server returned an empty response body for ${url?.href || 'the homepage'}, so no DOM findings can be assessed.`, captureMethod: 'static-fetch' }
  }
  if (type && !SUPPORTED_CONTENT.test(type) && !/<html[\s>]/i.test(body)) {
    return { quality: 'unsupported-content', reason: `The homepage returned ${type || 'a non-HTML response'} instead of a readable page, so no DOM findings can be assessed.`, captureMethod: 'static-fetch' }
  }
  let title = ''
  let words = 0
  let externalScripts = 0
  let mountNodes = 0
  try {
    const $ = load(body)
    title = cleanText($('title').first().text())
    const bodyText = cleanText($('body').text())
    words = bodyText ? bodyText.split(/\s+/).length : 0
    externalScripts = $('script[src]').length
    mountNodes = $('div[id]').filter((_, element) => APP_MOUNT_ID.test(String($(element).attr('id') || ''))).length
  } catch { /* Unparseable markup is itself a quality signal; fall through to text checks. */ }
  if (CHALLENGE_PATTERNS.some((pattern) => pattern.test(title))) {
    return { quality: 'challenge', reason: `The homepage served a bot challenge or access-control page ("${title.slice(0, 80)}"). Challenge pages are never bypassed, so no DOM findings can be assessed.`, captureMethod: 'static-fetch' }
  }
  const head = body.slice(0, 4000)
  const distinctHits = CHALLENGE_PATTERNS.filter((pattern) => pattern.test(head)).length
  if (distinctHits >= 2) {
    return { quality: 'challenge', reason: 'The homepage served a bot challenge or access-control page. Challenge pages are never bypassed, so no DOM findings can be assessed.', captureMethod: 'static-fetch' }
  }
  if (words < 10 && (externalScripts > 0 || mountNodes > 0)) {
    return { quality: 'js-shell', reason: `The homepage is a JavaScript application shell (${words} readable words, ${externalScripts} external scripts). Static markup cannot show the rendered content, calls to action, or contact paths, so no DOM findings can be assessed.`, captureMethod: 'static-fetch', renderedFallback: 'deferred' }
  }
  return { quality: 'usable-html', reason: null, captureMethod: 'static-fetch' }
}

function detectStack(html) {
  const rules = [
    ['WordPress', /wp-content|wp-includes/i], ['Elementor', /elementor/i], ['Wix', /wixstatic|wix-code/i],
    ['Squarespace', /squarespace/i], ['Webflow', /webflow/i], ['Shopify', /cdn\.shopify|shopify\.theme/i],
    ['GA4', /googletagmanager|gtag\(|G-[A-Z0-9]+/i], ['Meta Pixel', /connect\.facebook\.net|fbq\(/i],
    ['HubSpot', /js\.hs-scripts\.com|hubspot/i],
  ]
  return rules.filter(([, pattern]) => pattern.test(html)).map(([name]) => name)
}

function cap(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(value))) }

export function inconclusiveAssessment({ capture, finalUrl, sitemapPageCount = null }) {
  const checkedAt = new Date().toISOString()
  return {
    opportunityScore: null,
    confidence: null,
    researchStatus: 'Inconclusive',
    analysisSource: null,
    captureQuality: { ...capture, checkedAt },
    mainIssue: 'Capture inconclusive',
    issueDetail: capture.reason,
    problems: [],
    evidence: [capture.reason, `Capture method: ${capture.captureMethod}${capture.renderedFallback ? `; rendered-page fallback: ${capture.renderedFallback}` : ''}`],
    pageCount: sitemapPageCount || null,
    sitemapPageCount: sitemapPageCount || null,
    performance: null,
    accessibility: null,
    seo: null,
    brokenLinks: null,
    checkedLinks: null,
    mobileQuality: null,
    https: finalUrl?.protocol === 'https:',
    rebuild: null,
    stack: [],
    auditSummary: { captureQuality: { ...capture, checkedAt } },
  }
}

export function analyzeHtml(html, finalUrl, sitemapPageCount = null, options = {}) {
  const capture = classifyCapture({ text: html, contentType: options?.contentType || '', url: finalUrl })
  if (capture.quality !== 'usable-html') return inconclusiveAssessment({ capture, finalUrl, sitemapPageCount })
  const $ = load(html)
  const title = cleanText($('title').first().text())
  const description = cleanText($('meta[name="description" i]').attr('content'))
  const viewport = cleanText($('meta[name="viewport" i]').attr('content'))
  const canonical = cleanText($('link[rel="canonical" i]').attr('href'))
  const h1Count = $('h1').length
  const forms = $('form').length
  const inputCount = $('form input, form textarea, form select').length
  const images = $('img').length
  const imagesWithAlt = $('img[alt]').filter((_, element) => cleanText($(element).attr('alt')).length > 0).length
  const altCoverage = images ? Math.round((imagesWithAlt / images) * 100) : 100
  const hasSchema = $('script[type="application/ld+json"]').length > 0
  const hasPhone = $('a[href^="tel:"]').length > 0
  const hasEmail = $('a[href^="mailto:"]').length > 0
  const bodyText = cleanText($('body').text()).toLowerCase()
  const ctaCount = $('a, button').filter((_, element) => /quote|estimate|contact|book|schedule|call|get started|request/i.test(cleanText($(element).text()))).length
  const hasTrustLanguage = /licensed|insured|warranty|guarantee|testimonial|reviews?|financing/.test(bodyText)
  const robotsNoIndex = /noindex/i.test(cleanText($('meta[name="robots" i]').attr('content')))
  const internalLinks = new Set()
  $('a[href]').each((_, element) => {
    try {
      const target = new URL($(element).attr('href'), finalUrl)
      if (target.origin === finalUrl.origin && ['http:', 'https:'].includes(target.protocol)) internalLinks.add(`${target.origin}${target.pathname}`)
    } catch { /* Ignore malformed links found in third-party markup. */ }
  })

  const findings = []
  const evidence = []
  const add = (titleText, detail, evidenceText, weight) => findings.push({ title: titleText, detail, evidence: evidenceText, weight })
  evidence.push(`Homepage returned HTTP 200 at ${finalUrl.href}`)
  evidence.push(`Page title: ${title || 'not found'}`)
  evidence.push(`Internal links observed on homepage: ${internalLinks.size}`)
  if (!viewport) add('Mobile setup', 'The homepage does not declare a responsive viewport.', 'Responsive viewport meta tag: not found', 18)
  if (!title || title.length < 20 || title.length > 65) add('Search clarity', 'The homepage title is missing or outside a useful descriptive range.', `Homepage title length: ${title.length} characters`, 10)
  if (!description || description.length < 70) add('Search messaging', 'The homepage description is missing or too brief to explain the offer clearly.', `Meta description length: ${description.length} characters`, 8)
  if (h1Count !== 1) add('Content hierarchy', 'The homepage does not use one clear primary heading.', `Homepage H1 count: ${h1Count}`, 10)
  if (inputCount > 8) add('Enquiry friction', 'The first website form asks for many details at once.', `Form field count on homepage: ${inputCount}`, 16)
  if (!ctaCount) add('Next step', 'No clear quote, contact, booking, or call action was detected.', 'Primary action phrases detected: 0', 18)
  if (!hasPhone && !hasEmail && forms === 0) add('Contact path', 'No obvious phone, email, or enquiry form was detected.', 'Direct contact methods detected: 0', 18)
  if (altCoverage < 70) add('Image accessibility', 'Many homepage images do not have useful alternative text.', `Image alt-text coverage: ${altCoverage}%`, 9)
  if (!hasSchema) add('Local search context', 'No structured data was detected on the homepage.', 'JSON-LD structured data blocks: 0', 7)
  if (!hasTrustLanguage) add('Trust signals', 'Common reassurance such as licensing, warranties, reviews, or guarantees is not prominent.', 'Trust-language signals detected: 0', 6)
  if (robotsNoIndex) add('Search visibility', 'The homepage asks search engines not to index it.', 'Robots meta contains noindex', 20)
  if (!canonical) evidence.push('Canonical URL: not found')
  evidence.push(`Homepage CTA phrases detected: ${ctaCount}`)
  evidence.push(`Image alt-text coverage: ${altCoverage}%`)
  evidence.push(`Structured data: ${hasSchema ? 'found' : 'not found'}`)

  findings.sort((a, b) => b.weight - a.weight)
  const top = findings.slice(0, 5)
  const opportunityScore = cap(38 + top.reduce((sum, item) => sum + item.weight, 0) * 0.7, 35, 96)
  // Confidence reflects distinct substantive checks that fired — not the number
  // of boilerplate evidence strings — plus sitemap coverage.
  const confidence = cap(55 + top.length * 6 + (sitemapPageCount ? 4 : 0), 55, 91)
  const seo = cap(100 - (!title ? 22 : title.length < 20 || title.length > 65 ? 10 : 0) - (!description ? 18 : description.length < 70 ? 8 : 0) - (!hasSchema ? 10 : 0) - (robotsNoIndex ? 45 : 0) - (h1Count !== 1 ? 10 : 0))
  const accessibility = cap(100 - (100 - altCoverage) * 0.35 - (!viewport ? 20 : 0) - (h1Count !== 1 ? 8 : 0))
  const stack = detectStack(html)
  const main = top[0] || { title: 'Website clarity', detail: 'The homepage passed the lightweight checks; a deeper visual and performance review is still recommended.' }

  return {
    opportunityScore,
    confidence,
    researchStatus: 'Analyzed',
    analysisSource: 'Deterministic website audit',
    captureQuality: { ...capture, checkedAt: new Date().toISOString() },
    mainIssue: main.title,
    issueDetail: main.detail,
    problems: top.map((item) => item.detail),
    evidence: [...new Set([...evidence, ...top.map((item) => item.evidence)])],
    pageCount: sitemapPageCount || Math.max(1, internalLinks.size),
    performance: null,
    accessibility,
    seo,
    brokenLinks: null,
    mobileQuality: viewport ? (altCoverage >= 70 ? 'Good' : 'Fair') : 'Poor',
    https: finalUrl.protocol === 'https:',
    rebuild: stack.some((item) => ['WordPress', 'Wix', 'Squarespace', 'Webflow'].includes(item)) ? 'Easy' : 'Moderate',
    stack,
    auditSummary: { title, description, viewport: Boolean(viewport), canonical: Boolean(canonical), h1Count, forms, inputCount, images, altCoverage, ctaCount, hasSchema, hasPhone, hasEmail, internalLinks: internalLinks.size },
  }
}

export function composeScoreProvenance(lighthouseSummary, baseline = {}, { observedAt = null } = {}) {
  const measured = lighthouseSummary?.status === 'Completed'
  const at = observedAt || new Date().toISOString()
  const lighthouseAt = lighthouseSummary?.fetchedAt || at
  return {
    performance: measured
      ? scoreProvenance({ value: lighthouseSummary.scores?.performance, source: MEASURE_SOURCES.LIGHTHOUSE, status: 'measured', observedAt: lighthouseAt })
      : scoreProvenance({ observedAt: at }),
    accessibility: measured
      ? scoreProvenance({ value: lighthouseSummary.scores?.accessibility, source: MEASURE_SOURCES.LIGHTHOUSE, status: 'measured', observedAt: lighthouseAt })
      : scoreProvenance({ value: baseline.accessibility, source: MEASURE_SOURCES.HTML_HEURISTIC, status: 'estimated', observedAt: at }),
    bestPractices: measured
      ? scoreProvenance({ value: lighthouseSummary.scores?.bestPractices, source: MEASURE_SOURCES.LIGHTHOUSE, status: 'measured', observedAt: lighthouseAt })
      : scoreProvenance({ observedAt: at }),
    seo: measured
      ? scoreProvenance({ value: lighthouseSummary.scores?.seo, source: MEASURE_SOURCES.LIGHTHOUSE, status: 'measured', observedAt: lighthouseAt })
      : scoreProvenance({ value: baseline.seo, source: MEASURE_SOURCES.HTML_HEURISTIC, status: 'estimated', observedAt: at }),
  }
}

export async function auditWebsite(website, options = {}) {
  const startUrl = normalizeWebsite(website)
  const origin = new URL(startUrl.origin)
  let robots = null
  if (options.respectRobots !== false) {
    try {
      const robotsFile = await fetchPublicText(new URL('/robots.txt', origin), { timeoutMs: 7_000, maxBytes: 256_000, maxRedirects: 2 })
      const parsed = robotsParser(new URL('/robots.txt', origin).href, robotsFile.text)
      if (parsed.isAllowed(startUrl.href, USER_AGENT) === false || !robotsAllowsHomepage(robotsFile.text)) throw new AuditError('robots.txt disallows crawling this website', 'ROBOTS_BLOCKED')
      robots = parsed
    } catch (error) {
      if (error?.code === 'ROBOTS_BLOCKED') throw error
      // An unavailable robots file does not block a manual homepage audit.
    }
  }
  const page = await fetchPublicText(startUrl)
  let sitemapPageCount = null
  let sitemapText = ''
  try {
    const sitemap = await fetchPublicText(new URL('/sitemap.xml', page.url), { timeoutMs: 7_000, maxBytes: 1_000_000, maxRedirects: 2 })
    const matches = sitemap.text.match(/<loc(?:\s[^>]*)?>/gi)
    sitemapPageCount = matches?.length || null
    sitemapText = sitemap.text
  } catch { /* Sitemap evidence is optional. */ }
  const baseline = analyzeHtml(page.text, page.url, sitemapPageCount, { contentType: page.contentType })
  const shellCapture = baseline.researchStatus === 'Inconclusive' && baseline.captureQuality?.quality === 'js-shell'
  if (baseline.researchStatus === 'Inconclusive' && !shellCapture) {
    // Challenge pages, unsupported content and empty responses: stop honestly.
    // No crawl, no Lighthouse, no defect-derived claims.
    return {
      ...baseline,
      sitemapPageCount,
      auditedUrl: page.url.href,
      auditedAt: new Date().toISOString(),
    }
  }
  options.onProgress?.({ progress: 30, phase: 'Crawling pages' })
  const crawl = await crawlWebsite({
    homeHtml: page.text,
    homeUrl: page.url,
    sitemapText,
    robots,
    maxPages: options.maxPages || 10,
    requestDelay: options.requestDelay ?? 500,
    maxLinks: options.maxLinks || 50,
    maxAttempts: options.maxAttempts,
    maxQueue: options.maxQueue,
    maxTotalBytes: options.maxTotalBytes,
    timeLimitMs: options.timeLimitMs,
    signal: options.signal || null,
    onProgress: ({ phase, pages = 0, pageLimit = 10 }) => options.onProgress?.({ progress: phase === 'Checking links' ? 58 : Math.min(55, 30 + Math.round((pages / pageLimit) * 25)), phase }),
  })

  options.onProgress?.({ progress: 68, phase: 'Running Lighthouse' })
  let lighthouseResult = null
  let lighthouseSummary
  if (options.runLighthouse === false) {
    lighthouseSummary = { status: 'Skipped', error: 'Lighthouse was disabled for this audit' }
  } else {
    try {
      lighthouseResult = await runLighthouseAudit(page.url, { timeoutMs: options.lighthouseTimeoutMs || 35_000 })
      lighthouseSummary = lighthouseResult.summary
    } catch (error) {
      lighthouseSummary = { status: 'Failed', error: error.message, code: error.code || 'LIGHTHOUSE_FAILED' }
    }
  }

  // Provenance for every score: Lighthouse values are measured, HTML-derived
  // fallbacks are estimates and must never be presented as Lighthouse results.
  const measuredAt = new Date().toISOString()
  const lighthouseMeasured = lighthouseSummary?.status === 'Completed'
  const measureProvenance = composeScoreProvenance(lighthouseSummary, baseline, { observedAt: measuredAt })
  const performance = measureProvenance.performance.value
  const accessibility = measureProvenance.accessibility.value
  const seo = measureProvenance.seo.value
  const brokenLinks = crawl.links.broken
  const problems = [...baseline.problems]
  const evidence = [...baseline.evidence]
  let mainIssue = baseline.mainIssue
  let issueDetail = baseline.issueDetail
  let scoreAdjustment = 0
  if (performance != null) {
    const lcp = lighthouseSummary.metrics?.largestContentfulPaintMs
    evidence.push(`Lighthouse mobile performance: ${performance}/100${lcp != null ? `; largest contentful paint: ${(lcp / 1000).toFixed(1)}s` : ''}`)
    if (performance < 70) {
      const detail = `The measured mobile Lighthouse performance score is ${performance}/100${lcp != null ? ` with a ${(lcp / 1000).toFixed(1)}s largest contentful paint` : ''}.`
      problems.unshift(detail)
      scoreAdjustment += performance < 50 ? 12 : 7
      if (performance < 50) { mainIssue = 'Mobile performance'; issueDetail = detail }
    }
  }
  if (!lighthouseMeasured) {
    evidence.push(`Mobile performance not measured by Lighthouse (${lighthouseSummary?.status || 'Unknown'}${lighthouseSummary?.error ? `: ${lighthouseSummary.error}` : ''})`)
    if (accessibility != null) evidence.push(`Accessibility ${accessibility}/100 is an HTML-structure estimate, not a Lighthouse measurement`)
    if (seo != null) evidence.push(`SEO ${seo}/100 is an HTML-structure estimate, not a Lighthouse measurement`)
  }
  evidence.push(`Crawled ${crawl.pages.length} same-site page${crawl.pages.length === 1 ? '' : 's'} and checked ${crawl.links.checked} internal link${crawl.links.checked === 1 ? '' : 's'}`)
  const stopEvidence = collectionStopEvidence(crawl.limits)
  if (stopEvidence) evidence.push(stopEvidence)
  if (crawl.links.skippedRobots) evidence.push(`${crawl.links.skippedRobots} link${crawl.links.skippedRobots === 1 ? ' was' : 's were'} skipped as robots-disallowed and never requested`)
  if (crawl.offOrigin?.length) evidence.push(`${crawl.offOrigin.length} same-origin candidate${crawl.offOrigin.length === 1 ? '' : 's'} redirected off-origin and ${crawl.offOrigin.length === 1 ? 'was' : 'were'} not traversed as same-site content`)
  const linkSummary = {
    attempted: crawl.links.checked,
    reachable: crawl.links.reachable,
    confirmedBroken: crawl.links.broken,
    unverified: crawl.links.unverified,
    byOutcome: crawl.links.byOutcome,
    truncated: crawl.links.truncated,
    skippedRobots: crawl.links.skippedRobots || 0,
  }
  if (brokenLinks > 0) {
    const detail = `${brokenLinks} confirmed broken internal link${brokenLinks === 1 ? ' was' : 's were'} found across the crawled pages (definitive 404/410 responses).`
    problems.unshift(detail)
    evidence.push(`Confirmed broken internal links: ${brokenLinks} of ${crawl.links.checked} checked`)
    scoreAdjustment += Math.min(12, brokenLinks * 3)
    if (brokenLinks >= 3 && performance >= 50) { mainIssue = 'Broken customer paths'; issueDetail = detail }
  }
  if (linkSummary.unverified > 0) {
    const parts = Object.entries(linkSummary.byOutcome)
      .filter(([outcome]) => ![LINK_OUTCOMES.REACHABLE, LINK_OUTCOMES.CONFIRMED_BROKEN].includes(outcome))
      .map(([outcome, count]) => `${count} ${outcome.replace(/_/g, ' ')}`)
    evidence.push(`Link verification incomplete: ${linkSummary.unverified} of ${linkSummary.attempted} checked links could not be verified (${parts.join(', ')}). Unverified links are not broken and add no score.`)
  }
  if ((linkSummary.byOutcome[LINK_OUTCOMES.SERVICE_ERROR] || 0) > 0) {
    evidence.push(`Observed service errors: ${linkSummary.byOutcome[LINK_OUTCOMES.SERVICE_ERROR]} links returned HTTP 5xx. These are observed service errors, not proven dead pages, and add no score.`)
  }
  if (crawl.errors.length) evidence.push(`Page crawl warnings: ${crawl.errors.length}`)
  const componentStatuses = {
    crawl: { status: crawl.status, pagesCrawled: crawl.pages.length, pageLimit: crawl.pageLimit, errors: crawl.errors.length, truncated: crawl.truncated, stoppedBy: crawl.limits?.stoppedBy || null, attempts: crawl.limits?.attempts ?? null },
    links: { status: crawl.links.status, checked: crawl.links.checked, broken: crawl.links.broken, truncated: crawl.links.truncated, linkSummary },
    lighthouse: lighthouseSummary,
  }
  const auditStatus = lighthouseSummary.status === 'Completed' && crawl.status === 'Completed' && crawl.links.status === 'Completed' ? 'Completed' : 'Partial'
  if (shellCapture) {
    // JavaScript shell: lab measurements are real and kept, but the DOM was
    // never rendered, so no defect-derived opportunity or confidence is claimed.
    const shellEvidence = [
      baseline.captureQuality.reason,
      'Capture method: static-fetch; rendered-page fallback: deferred (no rendered-DOM support claimed)',
      ...(lighthouseSummary.status === 'Completed'
        ? [`Lighthouse mobile performance is a lab measurement of the rendered page: ${performance}/100`]
        : [`Lighthouse ${lighthouseSummary.status === 'Skipped' ? 'was skipped' : 'did not complete'} (${lighthouseSummary.error || lighthouseSummary.status}); no rendered measurement available`]),
      `Crawled ${crawl.pages.length} same-site page${crawl.pages.length === 1 ? '' : 's'} and checked ${crawl.links.checked} internal link${crawl.links.checked === 1 ? '' : 's'} (fetched markup only; shell content not rendered)`,
    ]
    return {
      ...baseline,
      opportunityScore: null,
      confidence: null,
      researchStatus: 'Inconclusive',
      analysisSource: null,
      mainIssue: 'Capture inconclusive',
      issueDetail: baseline.captureQuality.reason,
      problems: [],
      evidence: [...new Set(shellEvidence)],
      pageCount: crawl.pages.length,
      sitemapPageCount,
      performance,
      accessibility,
      seo,
      brokenLinks,
      checkedLinks: crawl.links.checked,
      mobileQuality: performance == null ? null : performance >= 75 ? 'Good' : performance >= 50 ? 'Fair' : 'Poor',
      auditStatus: 'Inconclusive',
      auditComponents: componentStatuses,
      crawlPages: crawl.pages,
      crawlErrors: crawl.errors,
      brokenLinkDetails: crawl.links.results.filter((result) => result.broken).slice(0, 20),
      lighthouse: lighthouseSummary,
      auditSummary: {
        ...baseline.auditSummary,
        sitemapPageCount,
        pagesCrawled: crawl.pages.length,
        linksChecked: crawl.links.checked,
        brokenLinks,
        lighthouse: lighthouseSummary,
      },
      _lighthouseReport: lighthouseResult?.report || null,
      auditedUrl: page.url.href,
      auditedAt: new Date().toISOString(),
    }
  }
  return {
    ...baseline,
    opportunityScore: cap(baseline.opportunityScore + scoreAdjustment, 35, 96),
    confidence: cap(baseline.confidence + Math.min(5, crawl.pages.length) + (lighthouseSummary.status === 'Completed' ? 5 : 0), 55, 96),
    analysisSource: lighthouseMeasured ? 'Multi-page website audit + Lighthouse' : 'Multi-page website audit (Lighthouse unavailable)',
    mainIssue,
    issueDetail,
    problems: [...new Set(problems)].slice(0, 7),
    evidence: [...new Set(evidence)],
    pageCount: crawl.pages.length,
    sitemapPageCount,
    performance,
    accessibility,
    seo,
    measureProvenance,
    brokenLinks,
    checkedLinks: crawl.links.checked,
    linkSummary,
    mobileQuality: performance == null ? baseline.mobileQuality : performance >= 75 ? 'Good' : performance >= 50 ? 'Fair' : 'Poor',
    auditStatus,
    auditComponents: componentStatuses,
    crawlPages: crawl.pages,
    crawlErrors: crawl.errors,
    brokenLinkDetails: crawl.links.results.filter((result) => result.outcome === LINK_OUTCOMES.CONFIRMED_BROKEN).slice(0, 20),
    unverifiedLinkDetails: crawl.links.results.filter((result) => !result.verified).slice(0, 20).map((result) => ({ url: result.url, finalUrl: result.finalUrl, status: result.status, outcome: result.outcome, error: result.error, observedAt: result.observedAt })),
    lighthouse: lighthouseSummary,
    auditSummary: {
      ...baseline.auditSummary,
      sitemapPageCount,
      pagesCrawled: crawl.pages.length,
      linksChecked: crawl.links.checked,
      brokenLinks,
      lighthouse: lighthouseSummary,
    },
    _lighthouseReport: lighthouseResult?.report || null,
    auditedUrl: page.url.href,
    auditedAt: new Date().toISOString(),
  }
}
