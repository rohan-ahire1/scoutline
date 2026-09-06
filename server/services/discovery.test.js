import test from 'node:test'
import assert from 'node:assert/strict'
import { describeGeographyCoverage, downloadDiscovery, filterSavedClientsByLocation, getDiscoveryLimits, mapDiscoveryRecord, reconcileRecords, resolveSearchDefinition, triggerDiscovery } from './discovery.js'

test('caps provider results across category inputs', () => {
  assert.deepEqual(getDiscoveryLimits(5, 3, 25), { total: 5, perInput: 2 })
  assert.deepEqual(getDiscoveryLimits(50, 3, 25), { total: 25, perInput: 9 })
})

test('maps a Bright Data-style place record into a lead', () => {
  const lead = mapDiscoveryRecord({
    name: 'Acme Roofing', open_website: 'https://acme.example/', address: '1 Main St, Salt Lake City, UT',
    phone_number: '+1 801 555 0100', rating: 4.8, reviews_count: 120, category: 'Roofing contractor',
    place_id: 'place-1', is_claimed: true, services_provided: ['Online estimates'], reservation_link: 'https://booking.example/acme',
    review_distribution: { '1_star_reviews': 2, '2_star_reviews': 0, '3_star_reviews': 1, '4_star_reviews': 7, '5_star_reviews': 110 },
    top_reviews: [{ review_date: '2026-08-01T00:00:00.000Z' }], lat: 40.7, lon: -111.9,
  }, 'Roofing', 'Salt Lake City, UT')
  assert.equal(lead.company, 'Acme Roofing')
  assert.equal(lead.website, 'acme.example')
  assert.equal(lead.reviews, 120)
  assert.equal(lead.businessIntelligence.claimed, true)
  assert.equal(lead.businessIntelligence.onlineBooking, true)
  assert.equal(lead.businessIntelligence.onlineEstimates, true)
  assert.equal(lead.businessIntelligence.positiveReviewShare, 98)
  assert.equal(lead.businessIntelligence.locations[0].placeId, 'place-1')
  assert.equal(lead.businessIntelligence.companyMetrics.employeeCount.value, null)
})

test('retains businesses without a website as first-class records (ROH-5)', () => {
  const lead = mapDiscoveryRecord({ name: 'Map only', url: 'https://google.com/maps/place/x', place_id: 'place-9', rating: 4.9, reviews_count: 300 })
  assert.equal(lead.company, 'Map only')
  assert.equal(lead.website, '')
  assert.equal(lead.websiteStatus, 'not_supplied')
  assert.equal(lead.businessId, 'brightdata:place:place-9')
  assert.equal(lead.businessIntelligence.locations[0].placeId, 'place-9')
})

test('provider omission never asserts a business status (ROH-5/ROH-6)', () => {
  const unknown = mapDiscoveryRecord({ name: 'Quiet Shop', place_id: 'place-10' })
  assert.equal(unknown.businessIntelligence.businessStatus, 'Unknown')
  const closed = mapDiscoveryRecord({ name: 'Shut Doors', place_id: 'place-11', permanently_closed: true })
  assert.equal(closed.businessIntelligence.businessStatus, 'Permanently closed')
  const claimed = mapDiscoveryRecord({ name: 'Claimed Co', place_id: 'place-12', is_claimed: true })
  assert.equal(claimed.businessIntelligence.businessStatus, 'Active')
})

test('same placeId reuses identity; shared domains stay distinct (ROH-5)', () => {
  const reconciled = reconcileRecords([
    { name: 'North Branch', place_id: 'place-20', website: 'https://chain.example/north' },
    { name: 'South Branch', place_id: 'place-21', website: 'https://chain.example/south' },
    { name: 'North Branch', place_id: 'place-20', website: 'https://new.example' },
    { name: 'North Branch', website: 'https://chain.example/north' },
  ], { limit: 10 })
  assert.equal(reconciled.retained.length, 3)
  assert.equal(reconciled.duplicates, 1)
  assert.deepEqual(reconciled.retained.map((item) => item.businessId), ['brightdata:place:place-20', 'brightdata:place:place-21', null])
})

test('records without a website survive reconciliation (ROH-5)', () => {
  const reconciled = reconcileRecords([
    { name: 'No Site Plumbing', place_id: 'place-30', rating: 4.8, reviews_count: 210 },
    { name: '', website: 'https://noname.example' },
  ], { limit: 10 })
  assert.equal(reconciled.retained.length, 1)
  assert.equal(reconciled.retained[0].websiteStatus, 'not_supplied')
  assert.equal(reconciled.rejectedCount, 1)
  assert.equal(reconciled.rejected[0].reason, 'missing business name')
})

const SLC_SETTINGS = { defaultLocation: 'Salt Lake City, Utah', discoveryLatitude: 40.7608, discoveryLongitude: -111.891, discoveryCountry: 'US', discoveryZoom: 13 }

test('a new place name never silently reuses unrelated coordinates', () => {
  assert.throws(() => resolveSearchDefinition({ location: 'Miami, Florida', categories: ['Roofing'], settings: SLC_SETTINGS }), /Cannot resolve coordinates for "Miami, Florida"/)
})

test('explicit coordinates need no paid geocoder', () => {
  const search = resolveSearchDefinition({ location: 'Miami, Florida', latitude: 25.7617, longitude: -80.1918, categories: ['Roofing'], settings: SLC_SETTINGS })
  assert.equal(search.displayLocation, 'Miami, Florida')
  assert.equal(search.latitude, 25.7617)
  assert.equal(search.longitude, -80.1918)
  assert.equal(search.coordinateSource, 'manual')
  assert.equal(search.geocoded, false)
  assert.match(search.areaLabel, /25.7617, -80.1918/)
})

test('the configured default location resolves to its saved coordinates', () => {
  const search = resolveSearchDefinition({ location: 'Salt Lake City, Utah', categories: ['Roofing'], settings: SLC_SETTINGS })
  assert.equal(search.latitude, 40.7608)
  assert.equal(search.coordinateSource, 'settings-default')
})

test('invalid and ambiguous geography is rejected with actionable errors', () => {
  assert.throws(() => resolveSearchDefinition({ location: 'Miami, Florida', latitude: 25.7, categories: ['Roofing'], settings: SLC_SETTINGS }), /Longitude is required/)
  assert.throws(() => resolveSearchDefinition({ location: 'Nowhere', latitude: 91, longitude: 0, categories: ['Roofing'], settings: SLC_SETTINGS }), /Latitude must be a number between -90 and 90/)
  assert.throws(() => resolveSearchDefinition({ location: 'Springfield', categories: ['Roofing'], settings: SLC_SETTINGS }), /GEOGRAPHY_UNRESOLVED|Cannot resolve coordinates/)
  assert.throws(() => resolveSearchDefinition({ location: 'Miami, Florida', categories: [], settings: SLC_SETTINGS }), /business category/)
  assert.throws(() => resolveSearchDefinition({ location: 'Miami, Florida', latitude: 25.7, longitude: -80.1, zoom: 5, categories: ['Roofing'], settings: SLC_SETTINGS }), /Zoom must be/)
})

test('the provider request uses the run snapshot, not live settings', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null })
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ snapshot_id: 'snap-1' }), text: async () => '{"snapshot_id":"snap-1"}' }
  }
  const realKey = process.env.BRIGHT_DATA_API_KEY
  process.env.BRIGHT_DATA_API_KEY = 'test-key'
  try {
    const search = resolveSearchDefinition({ location: 'Miami, Florida', latitude: 25.7617, longitude: -80.1918, categories: ['Roofing'], settings: SLC_SETTINGS })
    SLC_SETTINGS.discoveryLatitude = 0
    const started = await triggerDiscovery({ search, limit: 5, settings: SLC_SETTINGS })
    assert.equal(started.snapshotId, 'snap-1')
    assert.equal(seen[0].body[0].lat, 25.7617)
    assert.equal(seen[0].body[0].long, -80.1918)
    assert.ok(seen[0].body[0].keyword.includes('Miami, Florida'))
    assert.deepEqual(started.submittedGeography.coordinateSource, 'manual')
  } finally {
    globalThis.fetch = realFetch
    SLC_SETTINGS.discoveryLatitude = 40.7608
    if (realKey == null) delete process.env.BRIGHT_DATA_API_KEY
    else process.env.BRIGHT_DATA_API_KEY = realKey
  }
})

test('malformed provider payloads fail while valid empty results succeed', async () => {
  const realFetch = globalThis.fetch
  const realKey = process.env.BRIGHT_DATA_API_KEY
  process.env.BRIGHT_DATA_API_KEY = 'test-key'
  const bodies = {
    error: { error: 'snapshot expired' },
    malformed: { unexpected: true },
    empty: [],
  }
  let mode = 'error'
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => bodies[mode], text: async () => JSON.stringify(bodies[mode]),
  })
  try {
    await assert.rejects(() => downloadDiscovery('snap-1', {}), /Bright Data reported an error/)
    mode = 'malformed'
    await assert.rejects(() => downloadDiscovery('snap-1', {}), /malformed snapshot payload/)
    mode = 'empty'
    assert.deepEqual(await downloadDiscovery('snap-1', {}), [])
  } finally {
    globalThis.fetch = realFetch
    if (realKey == null) delete process.env.BRIGHT_DATA_API_KEY
    else process.env.BRIGHT_DATA_API_KEY = realKey
  }
})

test('reconciliation totals add up with per-row reasons (ROH-5 identity)', () => {
  const good = { name: 'Acme', website: 'https://acme.example/', category: 'Roofing' }
  const result = reconcileRecords([
    good,
    { name: 'Acme Copy', website: 'https://acme.example/contact' },
    { name: 'No site' },
    null,
    { name: 'Beta', website: 'https://beta.example/' },
  ], { fallbackCategory: 'Unknown', fallbackLocation: 'Miami, Florida', limit: 10 })
  // Identity-first: same domain without a shared provider id stays distinct,
  // and the website-less business is retained instead of rejected.
  assert.equal(result.returned, 5)
  assert.equal(result.retained.length, 4)
  assert.equal(result.rejectedCount, 1)
  assert.equal(result.duplicates, 0)
  assert.equal(result.unusable, 1)
  assert.equal(result.returned, result.retained.length + result.rejectedCount)
  assert.ok(result.rejected.every((row) => row.reason))
  assert.equal(result.retained[0].categoryProvenance, 'provider')
  assert.equal(result.retained[3].category, 'Unknown')
  assert.equal(result.retained[3].categoryProvenance, 'unknown')
  assert.equal(result.retained[2].websiteStatus, 'not_supplied')
})

test('requested versus actual geography flags out-of-area evidence', () => {
  const search = resolveSearchDefinition({ location: 'Miami, Florida', latitude: 25.7617, longitude: -80.1918, categories: ['Roofing'], settings: SLC_SETTINGS })
  const coverage = describeGeographyCoverage(search, [
    { company: 'Near', website: 'near.example', businessIntelligence: { locations: [{ latitude: 25.77, longitude: -80.19 }] } },
    { company: 'Far', website: 'far.example', businessIntelligence: { locations: [{ latitude: 40.7, longitude: -111.9 }] } },
    { company: 'NoPin', website: 'nopin.example', businessIntelligence: { locations: [{}] } },
  ])
  assert.equal(coverage.requested.displayLocation, 'Miami, Florida')
  assert.equal(coverage.recordsWithCoordinates, 2)
  assert.equal(coverage.outOfArea.length, 1)
  assert.equal(coverage.outOfArea[0].company, 'Far')
  assert.match(coverage.coverageNote, /not an exhaustive search/)
})

test('saved-client mode filters by city text and reports the filter', () => {
  const leads = [
    { company: 'A', location: 'Miami, Florida' },
    { company: 'B', location: 'Salt Lake City, Utah' },
    { company: 'C', location: 'Miami Beach, Florida' },
  ]
  const filtered = filterSavedClientsByLocation(leads, 'Miami, Florida')
  assert.deepEqual(filtered.matched.map((lead) => lead.company), ['A', 'C'])
  assert.equal(filtered.scanned, 3)
  assert.equal(filtered.city, 'miami')
})
