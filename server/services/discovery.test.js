import test from 'node:test'
import assert from 'node:assert/strict'
import { getDiscoveryLimits, mapDiscoveryRecord } from './discovery.js'

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

test('ignores records without a business website', () => {
  assert.equal(mapDiscoveryRecord({ name: 'Map only', url: 'https://google.com/maps/place/x' }), null)
})
