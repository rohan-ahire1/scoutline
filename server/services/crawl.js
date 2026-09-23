// Pure helpers for the VPS crawler export sync (consumed by both the
// Express API and the React Crawl tab — no node-only imports here).
export const CRAWL_EXPORT_VERSION = 1
export const CRAWL_MAX_SITES = 20000
export const CRAWL_MAX_HISTORY_DAYS = 90

export const CRAWL_STATES = ['pending', 'queued', 'crawling', 'completed', 'failed', 'blocked', 'disabled']
export const CRAWL_QUALIFICATIONS = ['not_evaluated', 'eligible', 'rejected']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function toScore(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

function toStringList(value, limit = 30) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, limit)
}

function toStringOrNull(value, limit = 2000) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : null
}

function normalizeSite(site, index) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return { error: `sites[${index}] must be an object` }
  const id = site.id
  if (id == null || (typeof id !== 'number' && typeof id !== 'string') || String(id).trim() === '') {
    return { error: `sites[${index}].id is required` }
  }
  const url = toStringOrNull(site.url)
  const host = toStringOrNull(site.host, 253)
  if (!url) return { error: `sites[${index}].url is required` }
  if (!host) return { error: `sites[${index}].host is required` }
  const crawlState = CRAWL_STATES.includes(site.crawl_state) ? site.crawl_state : 'pending'
  const qualification = CRAWL_QUALIFICATIONS.includes(site.qualification_state) ? site.qualification_state : 'not_evaluated'
  return {
    site: {
      id,
      url,
      host,
      crawl_state: crawlState,
      qualification_state: qualification,
      website_type: toStringOrNull(site.website_type, 50) || 'unknown',
      last_status_code: Number.isFinite(Number(site.last_status_code)) ? Number(site.last_status_code) : null,
      last_error: toStringOrNull(site.last_error),
      last_duration_ms: Number.isFinite(Number(site.last_duration_ms)) ? Number(site.last_duration_ms) : null,
      last_pages_inspected: Number.isFinite(Number(site.last_pages_inspected)) ? Number(site.last_pages_inspected) : null,
      last_eligible: site.last_eligible == null ? null : Boolean(site.last_eligible),
      last_opportunity_score: toScore(site.last_opportunity_score),
      last_visual_risk_score: toScore(site.last_visual_risk_score),
      last_result_at: toStringOrNull(site.last_result_at, 50),
      total_crawls: toCount(site.total_crawls),
      title: toStringOrNull(site.title, 500),
      meta_description: toStringOrNull(site.meta_description),
      emails: toStringList(site.emails),
      phones: toStringList(site.phones),
      social_links: toStringList(site.social_links),
      eligibility_reasons: toStringList(site.eligibility_reasons, 20),
      visual_risk: site.visual_risk && typeof site.visual_risk === 'object' && !Array.isArray(site.visual_risk)
        ? { score: toScore(site.visual_risk.score), reasons: toStringList(site.visual_risk.reasons, 20) }
        : null,
      tech: site.tech && typeof site.tech === 'object' && !Array.isArray(site.tech) ? site.tech : {},
      signals: site.signals && typeof site.signals === 'object' && !Array.isArray(site.signals) ? site.signals : {},
    },
  }
}

function normalizeHistoryDay(day, index) {
  if (!day || typeof day !== 'object' || Array.isArray(day)) return { error: `history[${index}] must be an object` }
  if (typeof day.date !== 'string' || !DATE_RE.test(day.date)) return { error: `history[${index}].date must be YYYY-MM-DD` }
  return { day: { date: day.date, completed: toCount(day.completed), failed: toCount(day.failed), eligible: toCount(day.eligible) } }
}

// Validates + normalizes a crawl-export.json payload. Unknown extra fields
// are dropped so older Scoutline builds tolerate newer exporters.
export function validateCrawlExport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Import body must be a JSON object' }
  }
  if (payload.version !== CRAWL_EXPORT_VERSION) {
    return { ok: false, error: `Unsupported crawl export version ${JSON.stringify(payload.version)} (expected ${CRAWL_EXPORT_VERSION})` }
  }
  if (typeof payload.exportedAt !== 'string' || Number.isNaN(new Date(payload.exportedAt).getTime())) {
    return { ok: false, error: 'exportedAt must be an ISO timestamp' }
  }
  const summary = payload.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return { ok: false, error: 'summary must be an object' }
  }
  if (!Array.isArray(payload.history)) return { ok: false, error: 'history must be an array' }
  if (payload.history.length > CRAWL_MAX_HISTORY_DAYS) {
    return { ok: false, error: `history is limited to ${CRAWL_MAX_HISTORY_DAYS} days (received ${payload.history.length})` }
  }
  if (!Array.isArray(payload.sites)) return { ok: false, error: 'sites must be an array' }
  if (payload.sites.length > CRAWL_MAX_SITES) {
    return { ok: false, error: `sites are limited to ${CRAWL_MAX_SITES} per import (received ${payload.sites.length})` }
  }
  const history = []
  for (let i = 0; i < payload.history.length; i++) {
    const result = normalizeHistoryDay(payload.history[i], i)
    if (result.error) return { ok: false, error: result.error }
    history.push(result.day)
  }
  const sites = []
  for (let i = 0; i < payload.sites.length; i++) {
    const result = normalizeSite(payload.sites[i], i)
    if (result.error) return { ok: false, error: result.error }
    sites.push(result.site)
  }
  const countMap = (value) => {
    const out = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, count] of Object.entries(value)) out[String(key).slice(0, 60)] = toCount(count)
    }
    return out
  }
  return {
    ok: true,
    data: {
      version: CRAWL_EXPORT_VERSION,
      exportedAt: payload.exportedAt,
      workerId: toStringOrNull(payload.workerId, 120),
      dailyLimit: toCount(payload.dailyLimit ?? payload.summary?.dailyLimit),
      historyDays: history.length,
      summary: {
        dailyLimit: toCount(summary.dailyLimit),
        scheduledToday: toCount(summary.scheduledToday),
        completedToday: toCount(summary.completedToday),
        failedToday: toCount(summary.failedToday),
        processedToday: toCount(summary.processedToday),
        states: countMap(summary.states),
        qualifications: countMap(summary.qualifications),
        databaseBytes: toCount(summary.databaseBytes),
      },
      history,
      siteTotal: toCount(payload.siteTotal ?? sites.length),
      siteTruncated: Boolean(payload.siteTruncated) || toCount(payload.siteTotal) > sites.length,
      sites,
    },
  }
}

export function summarizeCrawlSites(sites) {
  const list = Array.isArray(sites) ? sites : []
  const byWebsiteType = {}
  const byQualification = {}
  const byCrawlState = {}
  let eligible = 0
  let scored = 0
  let scoreTotal = 0
  let top = null
  for (const site of list) {
    const type = site.website_type || 'unknown'
    const qual = site.qualification_state || 'not_evaluated'
    const state = site.crawl_state || 'pending'
    byWebsiteType[type] = (byWebsiteType[type] || 0) + 1
    byQualification[qual] = (byQualification[qual] || 0) + 1
    byCrawlState[state] = (byCrawlState[state] || 0) + 1
    if (site.last_eligible) eligible += 1
    if (site.last_opportunity_score != null) {
      scored += 1
      scoreTotal += site.last_opportunity_score
      if (!top || site.last_opportunity_score > top.last_opportunity_score) top = site
    }
  }
  return {
    total: list.length,
    eligible,
    byWebsiteType,
    byQualification,
    byCrawlState,
    avgOpportunity: scored ? Math.round(scoreTotal / scored) : null,
    topOpportunity: top ? { id: top.id, host: top.host, score: top.last_opportunity_score } : null,
  }
}

export function prettifyHost(host) {
  const bare = String(host || '').replace(/^www\./i, '').split('.')[0] || ''
  const words = bare.split(/[-_.\s]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return words.join(' ').slice(0, 120) || String(host || '').slice(0, 120)
}

// Maps a crawled site onto an Scoutline lead row (see importedLead/insertUniqueLead).
export function crawlSiteToLeadRow(site, { company = '' } = {}) {
  // Discovery-backed sites carry the full Google record: keep it.
  if (site.business?.company) {
    const best = site.qualification?.contact?.email
    return {
      ...site.business,
      company: String(company || '').trim() || site.business.company,
      email: String(site.business.email || '').includes('@') ? site.business.email : (best || site.emails?.[0] || 'Not collected'),
      phone: site.business.phone && site.business.phone !== 'Not collected' ? site.business.phone : (site.phones?.[0] || 'Not collected'),
    }
  }
  const name = String(company || '').trim() || site.title || prettifyHost(site.host)
  return {
    company: name.slice(0, 120),
    website: site.host,
    phone: site.phones?.[0] || 'Not collected',
    email: site.emails?.[0] || 'Not collected',
    category: 'Uncategorized',
    location: 'Unknown',
    address: 'Not collected',
    rating: 0,
    reviews: 0,
    sourceUrl: site.url,
  }
}

// Weak-identity domain match (same rule as CSV import): crawl rows carry no
// provider id, so a shared domain resolves to the existing lead instead of
// creating a duplicate. Returns the matched lead or null.
export function findLeadByWebsite(leads, website) {
  const needle = String(website || '').trim().toLowerCase()
  if (!needle) return null
  return (Array.isArray(leads) ? leads : []).find((item) => String(item.website || '').toLowerCase() === needle) || null
}

export const LOCAL_SCRAPE_LIMITS = { maxUrls: 25, maxLimit: 25, defaultLimit: 10, maxCompany: 120 }

// Normalizes settings-backed form defaults to strings: settings store
// coordinates as numbers, and the form calls .trim() on submit.
export function normalizeLocalScrapeDefaults(defaults = {}) {
  const asText = (value) => (value == null ? '' : String(value))
  return {
    location: asText(defaults.location) || 'Salt Lake City, Utah',
    category: asText(defaults.category) || 'Roofing',
    limit: '10',
    latitude: asText(defaults.latitude),
    longitude: asText(defaults.longitude),
    urls: '',
  }
}

export function buildLocalRunId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function isLocalRunId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(id)
}

function normalizeScrapeUrl(value, index) {
  const raw = String(value || '').trim()
  if (!raw) return { error: `urls[${index}] must not be empty` }
  let parsed
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: `urls[${index}] is not a valid URL` }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: `urls[${index}] must use http(s)` }
  if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
    return { error: `urls[${index}] does not look like a website address` }
  }
  parsed.hash = ''
  return { url: parsed.toString() }
}

// Validates a local scrape request. Two modes: explicit urls[] (works
// offline of any provider) or location+category discovery (needs the Bright
// Data key plus coordinates — see resolveSearchDefinition).
export function validateLocalScrapeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }
  const limitRaw = body.limit == null || body.limit === '' ? LOCAL_SCRAPE_LIMITS.defaultLimit : Number(body.limit)
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > LOCAL_SCRAPE_LIMITS.maxLimit) {
    return { ok: false, error: `limit must be an integer from 1 to ${LOCAL_SCRAPE_LIMITS.maxLimit}` }
  }
  const urls = Array.isArray(body.urls) ? body.urls : (body.urls == null ? [] : null)
  if (urls === null) return { ok: false, error: 'urls must be an array of URL strings' }
  if (urls.length > 0) {
    if (urls.length > LOCAL_SCRAPE_LIMITS.maxUrls) {
      return { ok: false, error: `urls are limited to ${LOCAL_SCRAPE_LIMITS.maxUrls} per run (received ${urls.length})` }
    }
    const normalized = []
    for (let i = 0; i < urls.length; i++) {
      const result = normalizeScrapeUrl(urls[i], i)
      if (result.error) return { ok: false, error: result.error }
      normalized.push(result.url)
    }
    return { ok: true, request: { mode: 'urls', limit: limitRaw, urls: [...new Set(normalized)].slice(0, limitRaw) } }
  }
  const location = String(body.location || '').trim()
  const category = String(body.category || '').trim()
  if (!location || !category) {
    return { ok: false, error: 'Provide location + category, or a list of urls to scrape' }
  }
  if (location.length < 2 || location.length > 120) return { ok: false, error: 'location must be 2-120 characters' }
  if (category.length < 2 || category.length > 60) return { ok: false, error: 'category must be 2-60 characters' }
  const hasLat = body.latitude != null && body.latitude !== ''
  const hasLong = body.longitude != null && body.longitude !== ''
  if (hasLat !== hasLong) return { ok: false, error: 'latitude and longitude are required together' }
  let latitude = null
  let longitude = null
  if (hasLat) {
    latitude = Number(body.latitude)
    longitude = Number(body.longitude)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { ok: false, error: 'latitude must be between -90 and 90' }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { ok: false, error: 'longitude must be between -180 and 180' }
  }
  return { ok: true, request: { mode: 'discovery', location, category, latitude, longitude, limit: limitRaw } }
}

function hostOf(url) {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

// Maps the engine's aggregateSite() output onto the snapshot site shape so
// local results render through the same UI and lead promotion.
export function mapEngineResultToSite(aggregate, { url, runId, index, company = '', scrapedAt = new Date().toISOString(), business = null } = {}) {
  const host = hostOf(url) || String(url || '').slice(0, 253)
  const home = aggregate?.pages?.[0] || {}
  const eligible = Boolean(aggregate?.eligible)
  return {
    id: `${runId}-s${index}`,
    url,
    host,
    company: String(company || '').slice(0, LOCAL_SCRAPE_LIMITS.maxCompany),
    crawl_state: 'completed',
    qualification_state: eligible ? 'eligible' : 'rejected',
    website_type: aggregate?.websiteType || 'unknown',
    last_status_code: home.statusCode ?? null,
    last_error: null,
    last_duration_ms: home.latencyMs ?? null,
    last_pages_inspected: aggregate?.pagesInspected ?? null,
    last_eligible: eligible,
    last_opportunity_score: aggregate?.opportunityScore ?? null,
    last_visual_risk_score: aggregate?.visualRisk?.score ?? null,
    last_result_at: scrapedAt,
    total_crawls: 1,
    title: aggregate?.title || null,
    meta_description: aggregate?.metaDescription || null,
    emails: Array.isArray(aggregate?.emails) ? aggregate.emails.filter((item) => typeof item === 'string').slice(0, 30) : [],
    phones: Array.isArray(aggregate?.phones) ? aggregate.phones.filter((item) => typeof item === 'string').slice(0, 30) : [],
    social_links: Array.isArray(aggregate?.socialLinks) ? aggregate.socialLinks.filter((item) => typeof item === 'string').slice(0, 30) : [],
    eligibility_reasons: Array.isArray(aggregate?.eligibilityReasons) ? aggregate.eligibilityReasons.filter((item) => typeof item === 'string').slice(0, 20) : [],
    visual_risk: aggregate?.visualRisk && typeof aggregate.visualRisk === 'object'
      ? {
          score: aggregate.visualRisk.score ?? null,
          reasons: Array.isArray(aggregate.visualRisk.reasons) ? aggregate.visualRisk.reasons.filter((item) => typeof item === 'string').slice(0, 20) : [],
        }
      : null,
    tech: aggregate?.tech && typeof aggregate.tech === 'object' ? aggregate.tech : {},
    signals: aggregate?.signals && typeof aggregate.signals === 'object' ? aggregate.signals : {},
    source: 'local',
    ...(business ? { business } : {}),
  }
}

export function mapEngineFailureToSite({ url, error, runId, index, company = '', scrapedAt = new Date().toISOString(), business = null } = {}) {
  const host = hostOf(url) || String(url || '').slice(0, 253)
  return {
    id: `${runId}-s${index}`,
    url,
    host,
    company: String(company || '').slice(0, LOCAL_SCRAPE_LIMITS.maxCompany),
    crawl_state: 'failed',
    qualification_state: 'not_evaluated',
    website_type: 'unknown',
    last_status_code: null,
    last_error: String(error || 'Scrape failed').slice(0, 2000),
    last_duration_ms: null,
    last_pages_inspected: 0,
    last_eligible: null,
    last_opportunity_score: null,
    last_visual_risk_score: null,
    last_result_at: scrapedAt,
    total_crawls: 1,
    title: null,
    meta_description: null,
    emails: [],
    phones: [],
    social_links: [],
    eligibility_reasons: [],
    visual_risk: null,
    tech: {},
    signals: {},
    source: 'local',
    ...(business ? { business } : {}),
  }
}

export function describeCrawlSite(site) {
  const bits = []
  if (site.website_type && site.website_type !== 'unknown') bits.push(site.website_type)
  if (site.last_opportunity_score != null) bits.push(`opportunity ${site.last_opportunity_score}`)
  if (site.last_visual_risk_score != null) bits.push(`visual-risk ${site.last_visual_risk_score}`)
  if (site.eligibility_reasons?.length) bits.push(site.eligibility_reasons.join(', '))
  return bits.join(' · ') || 'crawled site'
}
