import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CRAWL_EXPORT_VERSION,
  buildLocalRunId,
  crawlSiteToLeadRow,
  describeCrawlSite,
  findLeadByWebsite,
  isLocalRunId,
  mapEngineFailureToSite,
  mapEngineResultToSite,
  normalizeLocalScrapeDefaults,
  prettifyHost,
  summarizeCrawlSites,
  validateCrawlExport,
  validateLocalScrapeRequest,
} from './crawl.js'

function sampleSite(overrides = {}) {
  return {
    id: 1,
    url: 'https://acme-roofing.com/',
    host: 'acme-roofing.com',
    crawl_state: 'completed',
    qualification_state: 'eligible',
    website_type: 'static',
    last_status_code: 200,
    last_error: null,
    last_duration_ms: 812,
    last_pages_inspected: 5,
    last_eligible: true,
    last_opportunity_score: 78,
    last_visual_risk_score: 66,
    last_result_at: '2026-09-15T08:00:00.000Z',
    total_crawls: 3,
    title: 'Acme Roofing | Salt Lake City',
    meta_description: 'Roof repair and replacement.',
    emails: ['hello@acme-roofing.com'],
    phones: ['+1-801-555-0100'],
    social_links: ['https://facebook.com/acmeroofs'],
    eligibility_reasons: ['static_candidate', 'high_visual_risk'],
    visual_risk: { score: 66, reasons: ['missing_mobile_viewport'] },
    tech: { staticCandidate: true, wordpress: false },
    signals: { https: true, viewport: false },
    ...overrides,
  }
}

function sampleExport(overrides = {}) {
  return {
    version: CRAWL_EXPORT_VERSION,
    exportedAt: '2026-09-15T09:00:00.000Z',
    workerId: 'vps-1',
    dailyLimit: 1000,
    historyDays: 2,
    summary: {
      dailyLimit: 1000,
      scheduledToday: 120,
      completedToday: 100,
      failedToday: 9,
      processedToday: 109,
      states: { completed: 90, failed: 9, queued: 11 },
      qualifications: { eligible: 40, rejected: 50, not_evaluated: 19 },
      databaseBytes: 123456,
    },
    history: [
      { date: '2026-09-14', completed: 210, failed: 12, eligible: 44 },
      { date: '2026-09-15', completed: 100, failed: 9, eligible: 21 },
    ],
    siteTotal: 2,
    siteTruncated: false,
    sites: [sampleSite(), sampleSite({ id: 2, host: 'plain-wordpress.blog', url: 'https://plain-wordpress.blog/', last_eligible: false, last_opportunity_score: 22, qualification_state: 'rejected', website_type: 'wordpress', title: 'A Blog', emails: [], phones: [] })],
    ...overrides,
  }
}

test('validateCrawlExport accepts a well-formed export and normalizes it', () => {
  const result = validateCrawlExport(sampleExport())
  assert.equal(result.ok, true)
  assert.equal(result.data.version, CRAWL_EXPORT_VERSION)
  assert.equal(result.data.sites.length, 2)
  assert.equal(result.data.history.length, 2)
  assert.equal(result.data.summary.processedToday, 109)
})

test('validateCrawlExport rejects wrong versions and non-objects', () => {
  assert.equal(validateCrawlExport(null).ok, false)
  assert.equal(validateCrawlExport([]).ok, false)
  const wrongVersion = validateCrawlExport(sampleExport({ version: 999 }))
  assert.equal(wrongVersion.ok, false)
  assert.match(wrongVersion.error, /version/)
})

test('validateCrawlExport rejects bad timestamps, history, and sites', () => {
  assert.equal(validateCrawlExport(sampleExport({ exportedAt: 'not-a-date' })).ok, false)
  assert.equal(validateCrawlExport(sampleExport({ history: [{ date: 'tomorrow', completed: 1 }] })).ok, false)
  assert.equal(validateCrawlExport(sampleExport({ sites: [{ id: 1 }] })).ok, false)
  assert.equal(validateCrawlExport(sampleExport({ sites: 'nope' })).ok, false)
})

test('validateCrawlExport enforces size caps', () => {
  const manyDays = Array.from({ length: 91 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, completed: 1, failed: 0, eligible: 0 }))
  assert.match(validateCrawlExport(sampleExport({ history: manyDays })).error, /limited to 90/)
  const manySites = Array.from({ length: 20001 }, (_, i) => sampleSite({ id: i + 1, host: `site-${i}.example.com`, url: `https://site-${i}.example.com/` }))
  assert.match(validateCrawlExport(sampleExport({ sites: manySites })).error, /limited to 20000/)
})

test('validateCrawlExport coerces unknown states instead of failing', () => {
  const result = validateCrawlExport(sampleExport({ sites: [sampleSite({ crawl_state: 'teleporting', qualification_state: 'maybe' })] }))
  assert.equal(result.ok, true)
  assert.equal(result.data.sites[0].crawl_state, 'pending')
  assert.equal(result.data.sites[0].qualification_state, 'not_evaluated')
})

test('summarizeCrawlSites counts types, qualifications, and scores', () => {
  const summary = summarizeCrawlSites(sampleExport().sites)
  assert.equal(summary.total, 2)
  assert.equal(summary.eligible, 1)
  assert.deepEqual(summary.byWebsiteType, { static: 1, wordpress: 1 })
  assert.equal(summary.avgOpportunity, 50)
  assert.equal(summary.topOpportunity.host, 'acme-roofing.com')
})

test('summarizeCrawlSites handles empty input', () => {
  const summary = summarizeCrawlSites([])
  assert.equal(summary.total, 0)
  assert.equal(summary.avgOpportunity, null)
  assert.equal(summary.topOpportunity, null)
})

test('prettifyHost turns a domain into a readable company name', () => {
  assert.equal(prettifyHost('www.acme-roofing.com'), 'Acme Roofing')
  assert.equal(prettifyHost('plain-wordpress.blog'), 'Plain Wordpress')
})

test('crawlSiteToLeadRow maps contacts and prefers explicit company names', () => {
  const row = crawlSiteToLeadRow(sampleSite())
  assert.equal(row.company, 'Acme Roofing | Salt Lake City')
  assert.equal(row.website, 'acme-roofing.com')
  assert.equal(row.phone, '+1-801-555-0100')
  assert.equal(row.email, 'hello@acme-roofing.com')
  assert.equal(row.sourceUrl, 'https://acme-roofing.com/')
  const renamed = crawlSiteToLeadRow(sampleSite(), { company: 'Custom Name' })
  assert.equal(renamed.company, 'Custom Name')
})

test('crawlSiteToLeadRow falls back to the host when no title exists', () => {
  const row = crawlSiteToLeadRow(sampleSite({ title: null }))
  assert.equal(row.company, 'Acme Roofing')
})

test('describeCrawlSite summarizes the crawl verdict', () => {
  assert.equal(describeCrawlSite(sampleSite()), 'static · opportunity 78 · visual-risk 66 · static_candidate, high_visual_risk')
})

test('validateCrawlExport keeps missing scores null (failed crawls show no score)', () => {
  const result = validateCrawlExport(sampleExport({ sites: [sampleSite({ last_opportunity_score: null, last_visual_risk_score: null })] }))
  assert.equal(result.ok, true)
  assert.equal(result.data.sites[0].last_opportunity_score, null)
  assert.equal(result.data.sites[0].last_visual_risk_score, null)
})

test('findLeadByWebsite matches domains case-insensitively (add-lead dedup)', () => {
  const leads = [{ id: 'lead-1', website: 'Acme-Roofing.com' }, { id: 'lead-2', website: '' }]
  assert.equal(findLeadByWebsite(leads, 'acme-roofing.com')?.id, 'lead-1')
  assert.equal(findLeadByWebsite(leads, 'unknown.example.com'), null)
  assert.equal(findLeadByWebsite(leads, ''), null)
  assert.equal(findLeadByWebsite(null, 'acme-roofing.com'), null)
})

test('validateLocalScrapeRequest accepts urls mode and normalizes entries', () => {
  const result = validateLocalScrapeRequest({ urls: ['example.com', 'https://foo.example.com/a#b'], limit: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.request.mode, 'urls')
  assert.deepEqual(result.request.urls, ['https://example.com/', 'https://foo.example.com/a'])
})

test('validateLocalScrapeRequest accepts localhost fixtures', () => {
  const result = validateLocalScrapeRequest({ urls: ['http://127.0.0.1:8899/'] })
  assert.equal(result.ok, true)
  assert.equal(result.request.limit, 10)
})

test('validateLocalScrapeRequest rejects bad urls and over-limit lists', () => {
  assert.match(validateLocalScrapeRequest({ urls: ['not a url'] }).error, /urls\[0\] is not a valid URL/)
  assert.match(validateLocalScrapeRequest({ urls: ['ftp://x.com/'] }).error, /must use http/)
  assert.match(validateLocalScrapeRequest({ urls: [''] }).error, /must not be empty/)
  const many = Array.from({ length: 26 }, (_, i) => `https://site-${i}.example.com/`)
  assert.match(validateLocalScrapeRequest({ urls: many }).error, /limited to 25/)
})

test('validateLocalScrapeRequest accepts discovery mode with optional coordinates', () => {
  const plain = validateLocalScrapeRequest({ location: 'Ogden, Utah', category: 'Roofing' })
  assert.equal(plain.ok, true)
  assert.equal(plain.request.mode, 'discovery')
  assert.equal(plain.request.latitude, null)
  const geo = validateLocalScrapeRequest({ location: 'Ogden, Utah', category: 'Roofing', latitude: 41.2, longitude: -111.9 })
  assert.equal(geo.ok, true)
  assert.equal(geo.request.latitude, 41.2)
})

test('validateLocalScrapeRequest rejects partial discovery input', () => {
  assert.match(validateLocalScrapeRequest({}).error, /location \+ category/)
  assert.match(validateLocalScrapeRequest({ location: 'Ogden' }).error, /location \+ category/)
  assert.match(validateLocalScrapeRequest({ location: 'Ogden', category: 'Roofing', latitude: 41 }).error, /together/)
  assert.match(validateLocalScrapeRequest({ location: 'Ogden', category: 'Roofing', latitude: 999, longitude: 0 }).error, /latitude/)
  assert.match(validateLocalScrapeRequest({ location: 'Ogden', category: 'Roofing', limit: 99 }).error, /limit/)
})

test('mapEngineResultToSite mirrors the snapshot site shape', () => {
  const site = mapEngineResultToSite(
    {
      title: 'Acme', metaDescription: 'Best.', eligible: true, eligibilityReasons: ['static_candidate'],
      opportunityScore: 70, visualRisk: { score: 61, reasons: ['missing_mobile_viewport'] },
      websiteType: 'static', tech: { staticCandidate: true }, signals: { https: true },
      emails: ['a@x.io'], phones: [], socialLinks: [], pagesInspected: 3, pages: [{ statusCode: 200, latencyMs: 400 }],
    },
    { url: 'https://acme.example.com/', runId: 'local-abc', index: 2, company: 'Acme Inc' }
  )
  assert.equal(site.id, 'local-abc-s2')
  assert.equal(site.host, 'acme.example.com')
  assert.equal(site.company, 'Acme Inc')
  assert.equal(site.crawl_state, 'completed')
  assert.equal(site.qualification_state, 'eligible')
  assert.equal(site.last_opportunity_score, 70)
  assert.equal(site.last_visual_risk_score, 61)
  assert.equal(site.last_status_code, 200)
  assert.equal(site.source, 'local')
})

test('mapEngineFailureToSite builds an honest failed row', () => {
  const site = mapEngineFailureToSite({ url: 'https://dead.example.com/', error: 'fetch timeout', runId: 'local-abc', index: 0 })
  assert.equal(site.crawl_state, 'failed')
  assert.equal(site.qualification_state, 'not_evaluated')
  assert.equal(site.last_error, 'fetch timeout')
  assert.equal(site.last_opportunity_score, null)
})

test('normalizeLocalScrapeDefaults coerces numeric settings to strings', () => {
  const form = normalizeLocalScrapeDefaults({ location: 'Ogden, Utah', category: 'Roofing', latitude: 41.223, longitude: -111.9738 })
  assert.deepEqual(form, { location: 'Ogden, Utah', category: 'Roofing', limit: '10', latitude: '41.223', longitude: '-111.9738', urls: '' })
  assert.equal(typeof form.latitude.trim, 'function')
  const fallback = normalizeLocalScrapeDefaults({})
  assert.equal(fallback.location, 'Salt Lake City, Utah')
  assert.equal(fallback.latitude, '')
})

test('local run ids are safe path segments', () => {
  assert.equal(isLocalRunId(buildLocalRunId()), true)
  assert.equal(isLocalRunId('../escape'), false)
  assert.equal(isLocalRunId(''), false)
})
