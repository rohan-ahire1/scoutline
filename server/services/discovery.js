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

export const PROVIDER_CONFIG_VERSION = 1
const ZOOM_RADIUS_KM = { 12: 20, 13: 10, 14: 5, 15: 2.5, 16: 1.2 }

function parseCoordinate(value, { min, max, name }) {
  if (value == null || value === '') throw new DiscoveryError(`${name} is required alongside an explicit location`, 'GEOGRAPHY_UNRESOLVED')
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new DiscoveryError(`${name} must be a number between ${min} and ${max}`, 'INVALID_GEOGRAPHY')
  }
  return parsed
}

function defaultSettingsGeo(settings = {}) {
  return {
    label: String(settings.defaultLocation || '').trim(),
    latitude: Number(settings.discoveryLatitude),
    longitude: Number(settings.discoveryLongitude),
  }
}

// A run-level immutable search definition. The provider job uses this snapshot;
// later edits to global settings can never alter a queued run's request.
// Without a paid geocoding adapter, free-text locations only resolve when they
// match the configured default geography — anything else needs explicit
// coordinates (manual, no-paid-provider path) or a geocoder result.
export function resolveSearchDefinition({ location = null, latitude = null, longitude = null, country = null, zoom = null, categories = [], settings = {}, geocode = null } = {}) {
  if (!Array.isArray(categories) || !categories.length) throw new DiscoveryError('At least one business category is required', 'INVALID_GEOGRAPHY')
  const displayLocation = String(location || '').trim() || String(settings.defaultLocation || '').trim()
  if (!displayLocation) throw new DiscoveryError('A search location is required', 'INVALID_GEOGRAPHY')
  const resolvedCountry = String(country || settings.discoveryCountry || 'US').trim() || 'US'
  const parsedZoom = zoom == null || zoom === '' ? Number(settings.discoveryZoom ?? 13) : Number(zoom)
  if (!Number.isFinite(parsedZoom) || parsedZoom < 12 || parsedZoom > 16) {
    throw new DiscoveryError('Zoom must be a number between 12 and 16', 'INVALID_GEOGRAPHY')
  }
  const hasExplicit = (latitude != null && latitude !== '') || (longitude != null && longitude !== '')
  let coords
  let coordinateSource
  if (geocode && Number.isFinite(Number(geocode.latitude)) && Number.isFinite(Number(geocode.longitude))) {
    coords = {
      latitude: parseCoordinate(geocode.latitude, { min: -90, max: 90, name: 'Geocoded latitude' }),
      longitude: parseCoordinate(geocode.longitude, { min: -180, max: 180, name: 'Geocoded longitude' }),
    }
    coordinateSource = 'geocoder'
  } else if (hasExplicit) {
    coords = {
      latitude: parseCoordinate(latitude, { min: -90, max: 90, name: 'Latitude' }),
      longitude: parseCoordinate(longitude, { min: -180, max: 180, name: 'Longitude' }),
    }
    coordinateSource = 'manual'
  } else {
    const fallback = defaultSettingsGeo(settings)
    const matchesDefault = fallback.label && fallback.label.toLowerCase() === displayLocation.toLowerCase() &&
      Number.isFinite(fallback.latitude) && Number.isFinite(fallback.longitude)
    if (!matchesDefault) {
      throw new DiscoveryError(
        `Cannot resolve coordinates for "${displayLocation}" without a geocoding provider: refusing to silently reuse unrelated coordinates. Supply explicit latitude/longitude or update the default discovery geography in Settings.`,
        'GEOGRAPHY_UNRESOLVED',
      )
    }
    coords = { latitude: fallback.latitude, longitude: fallback.longitude }
    coordinateSource = 'settings-default'
  }
  const radiusKm = ZOOM_RADIUS_KM[Math.round(parsedZoom)] || 10
  return {
    displayLocation,
    country: resolvedCountry,
    latitude: coords.latitude,
    longitude: coords.longitude,
    zoom: Math.round(parsedZoom),
    radiusKm,
    areaLabel: `${coords.latitude}, ${coords.longitude} · zoom ${Math.round(parsedZoom)} (~${radiusKm} km radius)`,
    categories: [...categories],
    provider: {
      datasetId: process.env.BRIGHT_DATA_DATASET_ID || GOOGLE_MAPS_DATASET_ID,
      maxRecords: Math.max(1, Math.min(100, Number(process.env.BRIGHT_DATA_MAX_RECORDS || 25))),
      configVersion: PROVIDER_CONFIG_VERSION,
    },
    coordinateSource,
    geocoded: coordinateSource === 'geocoder',
    resolvedAt: new Date().toISOString(),
  }
}

// Pre-existing runs stored only text; rebuild an explicit legacy snapshot
// instead of silently rereading live settings at job time.
export function legacySearchFromSettings(run, settings = {}) {
  const fallback = defaultSettingsGeo(settings)
  return {
    displayLocation: run.location || fallback.label || 'Unknown',
    country: settings.discoveryCountry || 'US',
    latitude: fallback.latitude,
    longitude: fallback.longitude,
    zoom: Math.max(12, Math.min(16, Number(settings.discoveryZoom ?? 13))),
    radiusKm: 10,
    areaLabel: 'legacy run — coordinates reread from settings at migration time, not guaranteed original',
    categories: [...(run.categories || [])],
    provider: { datasetId: process.env.BRIGHT_DATA_DATASET_ID || GOOGLE_MAPS_DATASET_ID, maxRecords: 25, configVersion: PROVIDER_CONFIG_VERSION },
    coordinateSource: 'legacy-settings',
    geocoded: false,
    resolvedAt: new Date().toISOString(),
  }
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

export async function triggerDiscovery({ search, limit, settings = {} }) {
  if (!search || !Number.isFinite(Number(search.latitude)) || !Number.isFinite(Number(search.longitude))) {
    throw new DiscoveryError('Discovery needs a resolved search definition with coordinates', 'NOT_CONFIGURED')
  }
  const apiKey = process.env.BRIGHT_DATA_API_KEY || ''
  if (!apiKey) throw new DiscoveryError('Bright Data API key is not configured', 'NOT_CONFIGURED')
  const datasetId = search.provider?.datasetId || process.env.BRIGHT_DATA_DATASET_ID || GOOGLE_MAPS_DATASET_ID
  const maxRecords = search.provider?.maxRecords || Math.max(1, Math.min(100, Number(process.env.BRIGHT_DATA_MAX_RECORDS || 25)))
  const categories = Array.isArray(search.categories) && search.categories.length ? search.categories : []
  if (!categories.length) throw new DiscoveryError('At least one business category is required', 'INVALID_GEOGRAPHY')
  const limits = getDiscoveryLimits(limit, categories.length, maxRecords)
  const params = new URLSearchParams({
    dataset_id: datasetId,
    format: 'json',
    type: 'discover_new',
    discover_by: 'location',
    include_errors: 'true',
    limit_per_input: String(limits.perInput),
    limit_multiple_results: String(limits.total),
  })
  const inputs = categories.map((category) => ({
    country: search.country || settings.discoveryCountry || 'US',
    lat: search.latitude,
    long: search.longitude,
    zoom_level: search.zoom,
    keyword: `${category} ${search.displayLocation}`.trim(),
  }))
  const body = await brightRequest(`/trigger?${params}`, apiKey, { method: 'POST', body: JSON.stringify(inputs) })
  if (!body?.snapshot_id) throw new DiscoveryError('Bright Data did not return a snapshot ID', 'BAD_PROVIDER_RESPONSE')
  return {
    snapshotId: body.snapshot_id, datasetId, inputCount: inputs.length, requestedRecords: limits.total, recordsPerInput: limits.perInput,
    submittedGeography: { displayLocation: search.displayLocation, latitude: search.latitude, longitude: search.longitude, zoom: search.zoom, coordinateSource: search.coordinateSource },
  }
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
  // A valid empty result ([]) is successful empty results. Anything else that
  // is not a record array is a malformed/error payload and must fail loudly —
  // never coerce provider errors into "no results".
  if (Array.isArray(body)) return body
  if (body && Array.isArray(body.data)) return body.data
  if (body && typeof body === 'object' && (body.error || body.message || body.status === 'failed' || body.status === 'error')) {
    throw new DiscoveryError(`Bright Data reported an error: ${body.error || body.message || body.status}`, 'PROVIDER_ERROR')
  }
  throw new DiscoveryError('Bright Data returned a malformed snapshot payload (expected a record array)', 'BAD_PROVIDER_RESPONSE')
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
  const providerCategory = String(firstValue(record, ['category', 'primary_category', 'type']) || '').trim()
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
    category: providerCategory || String(fallbackCategory || 'Unknown'),
    categoryProvenance: providerCategory ? 'provider' : (fallbackCategory && fallbackCategory !== 'Unknown' ? 'run-fallback' : 'unknown'),
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

// Reconcile a provider payload into retained records with per-row rejection
// reasons, so result totals always add up: returned = retained + rejected
// (rejected splits into duplicates vs unusable rows).
export function reconcileRecords(records, { fallbackCategory = 'Unknown', fallbackLocation = 'Unknown', limit = 25 } = {}) {
  const rows = Array.isArray(records) ? records : []
  const rejected = []
  const seen = new Set()
  const mapped = []
  rows.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      rejected.push({ index, reason: 'row is not a provider record object', kind: 'unusable' })
      return
    }
    const out = mapDiscoveryRecord(record, fallbackCategory, fallbackLocation)
    if (!out) {
      const company = String(record.name || record.title || record.business_name || '').trim()
      rejected.push({ index, reason: company ? `missing usable website for "${company.slice(0, 60)}"` : 'missing business name and website', kind: 'unusable' })
      return
    }
    const key = String(out.website).toLowerCase().split('/')[0]
    if (seen.has(key)) {
      rejected.push({ index, reason: `duplicate website in provider payload: ${out.website}`, kind: 'duplicate' })
      return
    }
    seen.add(key)
    mapped.push(out)
  })
  const cap = Math.max(1, Number(limit || 25))
  return {
    returned: rows.length,
    mapped: mapped.length,
    retained: mapped.slice(0, cap),
    rejected,
    rejectedCount: rejected.length,
    duplicates: rejected.filter((item) => item.kind === 'duplicate').length,
    unusable: rejected.filter((item) => item.kind !== 'duplicate').length,
  }
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (value) => (value * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

function recordCoordinates(mapped) {
  const pin = mapped?.businessIntelligence?.locations?.[0]
  const latitude = Number(pin?.latitude)
  const longitude = Number(pin?.longitude)
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
}

// Requested versus actual geography: out-of-area provider records are kept as
// evidence and flagged, never silently dropped; coverage is a provider sample,
// never claimed exhaustive.
export function describeGeographyCoverage(search, mappedRecords) {
  const records = Array.isArray(mappedRecords) ? mappedRecords : []
  const withCoords = records.filter((item) => recordCoordinates(item))
  const radius = Number(search?.radiusKm) || 10
  const outOfArea = []
  for (const item of withCoords) {
    const pin = recordCoordinates(item)
    const distanceKm = haversineKm(search.latitude, search.longitude, pin.latitude, pin.longitude)
    if (distanceKm > radius * 2) {
      outOfArea.push({ company: item.company, website: item.website, distanceKm: Math.round(distanceKm * 10) / 10, latitude: pin.latitude, longitude: pin.longitude })
    }
  }
  return {
    requested: {
      displayLocation: search?.displayLocation || 'Unknown',
      latitude: search?.latitude ?? null,
      longitude: search?.longitude ?? null,
      radiusKm: radius,
      coordinateSource: search?.coordinateSource || null,
    },
    recordsTotal: records.length,
    recordsWithCoordinates: withCoords.length,
    outOfArea,
    coverageNote: 'Provider sample for the requested area; not an exhaustive search. Out-of-area records are flagged evidence, not removed.',
  }
}

// Saved-client mode has no provider geography: filter the workspace by city
// text so the location control means what it says.
export function filterSavedClientsByLocation(leads, displayLocation) {
  const city = String(displayLocation || '').split(',')[0].trim().toLowerCase()
  if (!city) return { matched: [...leads], city: '', scanned: leads.length }
  const matched = (leads || []).filter((lead) => {
    const home = String(lead?.location || '').toLowerCase()
    const homeCity = home.split(',')[0].trim()
    return home.includes(city) || (homeCity && city.includes(homeCity))
  })
  return { matched, city, scanned: (leads || []).length }
}
