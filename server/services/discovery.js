const GOOGLE_MAPS_DATASET_ID = 'gd_m8ebnr0q2qlklc02fz'
const API_ROOT = 'https://api.brightdata.com/datasets/v3'

export class DiscoveryError extends Error {
  constructor(message, code = 'DISCOVERY_FAILED') {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
  }
}

export function getBrightDataConfig(settings = {}) {
  const latitude = Number(settings.discoveryLatitude)
  const longitude = Number(settings.discoveryLongitude)
  const apiKey = process.env.BRIGHT_DATA_API_KEY || ''
  return {
    apiKey,
    datasetId: process.env.BRIGHT_DATA_DATASET_ID || GOOGLE_MAPS_DATASET_ID,
    country: settings.discoveryCountry || 'US',
    latitude,
    longitude,
    zoom: Math.max(12, Math.min(16, Number(settings.discoveryZoom || 13))),
    maxRecords: Math.max(1, Math.min(100, Number(process.env.BRIGHT_DATA_MAX_RECORDS || 25))),
    ready: Boolean(apiKey && Number.isFinite(latitude) && Number.isFinite(longitude)),
  }
}

export function getDiscoveryLimits(limit, inputCount, maximum = 25) {
  const total = Math.max(1, Math.min(Number(limit || 5), Number(maximum || 25)))
  const perInput = Math.max(1, Math.ceil(total / Math.max(1, Number(inputCount || 1))))
  return { total, perInput }
}

async function brightRequest(path, apiKey, options = {}) {
  let response
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || 45_000),
      headers: { Authorization: `Bearer ${apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    })
  } catch (error) {
    throw new DiscoveryError(`Bright Data request failed: ${error.message}`, 'PROVIDER_UNAVAILABLE')
  }
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
  if (!response.ok) {
    const message = body?.message || body?.error || (typeof body === 'string' ? body.slice(0, 200) : '') || `HTTP ${response.status}`
    throw new DiscoveryError(`Bright Data returned ${response.status}: ${message}`, 'PROVIDER_ERROR')
  }
  return body
}

export async function triggerDiscovery({ categories, location, limit, settings }) {
  const config = getBrightDataConfig(settings)
  if (!config.ready) throw new DiscoveryError('Bright Data needs an API key and discovery coordinates', 'NOT_CONFIGURED')
  const limits = getDiscoveryLimits(limit, categories.length, config.maxRecords)
  const params = new URLSearchParams({
    dataset_id: config.datasetId,
    format: 'json',
    type: 'discover_new',
    discover_by: 'location',
    include_errors: 'true',
    limit_per_input: String(limits.perInput),
    limit_multiple_results: String(limits.total),
  })
  const inputs = categories.map((category) => ({
    country: config.country,
    lat: config.latitude,
    long: config.longitude,
    zoom_level: config.zoom,
    keyword: `${category} ${location}`.trim(),
  }))
  const body = await brightRequest(`/trigger?${params}`, config.apiKey, { method: 'POST', body: JSON.stringify(inputs) })
  if (!body?.snapshot_id) throw new DiscoveryError('Bright Data did not return a snapshot ID', 'BAD_PROVIDER_RESPONSE')
  return { snapshotId: body.snapshot_id, datasetId: config.datasetId, inputCount: inputs.length, requestedRecords: limits.total, recordsPerInput: limits.perInput }
}

export async function triggerRecordRefresh({ url, settings }) {
  const config = getBrightDataConfig(settings)
  if (!config.ready) throw new DiscoveryError('Bright Data needs an API key and discovery coordinates', 'NOT_CONFIGURED')
  if (!url) throw new DiscoveryError('This client has no saved Google Maps source URL', 'SOURCE_URL_MISSING')
  const params = new URLSearchParams({
    dataset_id: config.datasetId,
    format: 'json',
    include_errors: 'true',
  })
  const body = await brightRequest(`/trigger?${params}`, config.apiKey, { method: 'POST', body: JSON.stringify([{ url }]) })
  if (!body?.snapshot_id) throw new DiscoveryError('Bright Data did not return a snapshot ID', 'BAD_PROVIDER_RESPONSE')
  return { snapshotId: body.snapshot_id, datasetId: config.datasetId }
}

export async function pollDiscovery(snapshotId, settings) {
  const config = getBrightDataConfig(settings)
  if (!config.apiKey) throw new DiscoveryError('Bright Data API key is not configured', 'NOT_CONFIGURED')
  const body = await brightRequest(`/progress/${encodeURIComponent(snapshotId)}`, config.apiKey, { method: 'GET', timeoutMs: 20_000 })
  return { status: body?.status || 'running', details: body }
}

export async function downloadDiscovery(snapshotId, settings) {
  const config = getBrightDataConfig(settings)
  if (!config.apiKey) throw new DiscoveryError('Bright Data API key is not configured', 'NOT_CONFIGURED')
  const body = await brightRequest(`/snapshot/${encodeURIComponent(snapshotId)}?format=json`, config.apiKey, { method: 'GET', timeoutMs: 60_000 })
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
}

function firstValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key]
    if (value != null && String(value).trim()) return value
  }
  return ''
}

function businessDetail(record, field) {
  const item = (Array.isArray(record?.business_details) ? record.business_details : []).find((detail) => detail?.field_name === field)
  return item?.details ? String(item.details).trim() : ''
}

function sourceMetric(record, keys, source = 'Bright Data') {
  const value = firstValue(record, keys)
  return { value: value === '' ? null : value, source: value === '' ? null : source, confidence: value === '' ? null : 'Provider supplied' }
}

function reviewIntelligence(record) {
  const distribution = record?.review_distribution && typeof record.review_distribution === 'object' ? record.review_distribution : null
  const total = distribution ? Object.values(distribution).reduce((sum, value) => sum + Number(value || 0), 0) : 0
  const positive = distribution ? Number(distribution['4_star_reviews'] || 0) + Number(distribution['5_star_reviews'] || 0) : 0
  const dates = (Array.isArray(record?.top_reviews) ? record.top_reviews : []).map((review) => review?.review_date).filter(Boolean).sort().reverse()
  return {
    distribution,
    positiveReviewShare: total ? Math.round((positive / total) * 100) : null,
    latestObservedReviewAt: dates[0] || null,
    sampledReviewCount: dates.length,
  }
}

function normalizeDomain(value) {
  const input = String(value || '').trim()
  if (!input || /google\.[^/]+\/maps/i.test(input)) return ''
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '')
  } catch { return '' }
}

export function mapDiscoveryRecord(record, fallbackCategory = 'Uncategorized', fallbackLocation = 'Unknown') {
  const company = String(firstValue(record, ['name', 'title', 'business_name', 'place_name'])).trim()
  const website = normalizeDomain(firstValue(record, ['website', 'website_url', 'open_website', 'domain', 'company_url']))
  if (!company || !website) return null
  const rawReviews = firstValue(record, ['reviews_count', 'review_count', 'reviews', 'user_ratings_total'])
  const reviews = typeof rawReviews === 'object' ? 0 : Number(rawReviews || 0)
  const location = String(firstValue(record, ['full_address', 'address', 'location', 'city']) || fallbackLocation)
  const services = Array.isArray(record.services_provided) ? record.services_provided.filter(Boolean).map(String) : []
  const categories = Array.isArray(record.all_categories) ? record.all_categories.filter(Boolean).map(String) : []
  const phone = firstValue(record, ['phone', 'phone_number', 'international_phone_number']) || businessDetail(record, 'phone')
  const reviewData = reviewIntelligence(record)
  const onlineEstimates = services.some((service) => /online estimates?/i.test(service))
  const onlineBooking = Boolean(record.reservation_link)
  const evidence = [
    record.is_claimed === true ? 'Google Business Profile: claimed' : record.is_claimed === false ? 'Google Business Profile: not claimed' : '',
    onlineBooking ? 'Online booking or request link: detected' : '',
    onlineEstimates ? 'Online estimates: offered' : '',
    reviewData.positiveReviewShare != null ? `Four- and five-star review share: ${reviewData.positiveReviewShare}%` : '',
    reviewData.latestObservedReviewAt ? `Latest sampled Google review: ${reviewData.latestObservedReviewAt}` : '',
  ].filter(Boolean)
  return {
    company,
    website,
    category: String(firstValue(record, ['category', 'primary_category', 'type']) || fallbackCategory),
    location,
    phone: String(phone || 'Not collected'),
    email: String(firstValue(record, ['email', 'business_email']) || 'Not collected'),
    rating: Number(firstValue(record, ['rating', 'reviews_rating', 'stars']) || 0),
    reviews,
    sourceUrl: String(firstValue(record, ['url', 'google_maps_url', 'place_url']) || ''),
    businessIntelligence: {
      source: 'Bright Data Google Maps', fetchedAt: record.timestamp || new Date().toISOString(),
      placeId: record.place_id || null, cid: record.cid || null,
      claimed: typeof record.is_claimed === 'boolean' ? record.is_claimed : null,
      businessStatus: record.permanently_closed ? 'Permanently closed' : record.temporarily_closed ? 'Temporarily closed' : 'Active',
      openHours: record.open_hours && typeof record.open_hours === 'object' ? record.open_hours : null,
      open24Hours: Object.values(record.open_hours || {}).filter(Boolean).length === 7 && Object.values(record.open_hours || {}).every((value) => /open 24 hours/i.test(String(value))),
      services, categories, onlineBooking, onlineEstimates,
      reservationLink: record.reservation_link || null,
      photosObserved: Array.isArray(record.photos_and_videos) ? record.photos_and_videos.length : null,
      ...reviewData,
      locations: [{ placeId: record.place_id || null, cid: record.cid || null, address: location, latitude: Number.isFinite(Number(record.lat)) ? Number(record.lat) : null, longitude: Number.isFinite(Number(record.lon)) ? Number(record.lon) : null, rating: Number(record.rating || 0), reviews }],
      companyMetrics: {
        employeeCount: sourceMetric(record, ['employee_count', 'employees', 'number_of_employees', 'company_size']),
        annualRevenue: sourceMetric(record, ['annual_revenue', 'estimated_revenue', 'revenue']),
        annualProfit: sourceMetric(record, ['annual_profit', 'estimated_profit', 'profit']),
        foundedYear: sourceMetric(record, ['founded_year', 'year_founded', 'founded']),
        branchCount: sourceMetric(record, ['branch_count', 'number_of_locations', 'locations_count']),
      },
      evidence,
    },
  }
}
