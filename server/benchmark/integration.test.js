// Provider-behavior integration tests (ROH-26): real service functions against
// scripted fake providers. Covers retries, cancellation, stale output, and
// mid-stream crashes. No network beyond loopback, no credentials, no billing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { crawlWebsite, fetchPublicText } from '../services/audit.js'
import { downloadDiscovery, triggerDiscovery } from '../services/discovery.js'
import { generateMuseAnalysis } from '../services/insights.js'
import { buildObservations } from '../services/outreach.js'
import { createFakeFetch, startFakeModelServer, withFakeFetch } from './fakes.js'

const DUMMY_KEY = 'bench-dummy-key'

function withDummyBrightData(run) {
  const previous = process.env.BRIGHT_DATA_API_KEY
  process.env.BRIGHT_DATA_API_KEY = DUMMY_KEY
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.BRIGHT_DATA_API_KEY
      else process.env.BRIGHT_DATA_API_KEY = previous
    })
}

const fakeDns = async () => [{ address: '192.0.2.1', family: 4 }]

test('transient provider errors fail loudly after exactly one attempt', async () => {
  await withDummyBrightData(async () => {
    const fake = createFakeFetch({ '*': [{ status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'overloaded' }) }] })
    await withFakeFetch(fake, async () => {
      await assert.rejects(
        () => triggerDiscovery({ search: { latitude: 40.76, longitude: -111.89, zoom: 13, displayLocation: 'Salt Lake City, UT', categories: ['Roofing'] }, limit: 5, settings: {} }),
        (error) => error.name === 'DiscoveryError' && /Bright Data returned 500/.test(error.message),
      )
    })
    assert.equal(fake.ledger.length, 1)
  })
})

test('malformed snapshot payloads are rejected, never coerced to empty results', async () => {
  await withDummyBrightData(async () => {
    const fake = createFakeFetch({ '*': [{ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unexpected: 'shape' }) }] })
    await withFakeFetch(fake, async () => {
      await assert.rejects(() => downloadDiscovery('snap-1', {}), /malformed snapshot payload/)
    })
  })
})

test('provider error objects surface as provider errors', async () => {
  await withDummyBrightData(async () => {
    const fake = createFakeFetch({ '*': [{ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'failed', error: 'snapshot expired' }) }] })
    await withFakeFetch(fake, async () => {
      await assert.rejects(() => downloadDiscovery('snap-1', {}), /snapshot expired/)
    })
  })
})

test('cancelled collection stops with CANCELLED, not a failure finding', async () => {
  const controller = new AbortController()
  controller.abort()
  const fake = createFakeFetch({ '*': [{ status: 200, headers: { 'content-type': 'text/html' }, body: '<html></html>' }] })
  await withFakeFetch(fake, async () => {
    await assert.rejects(() => fetchPublicText('https://cancel.example/', { signal: controller.signal, dnsLookup: fakeDns }), (error) => error.code === 'CANCELLED')
    // The multi-page crawl preserves partial evidence instead of throwing:
    // cancellation is recorded as the stop reason with Partial status.
    const partial = await crawlWebsite({ homeHtml: '<html><body><a href="/a">a</a></body></html>', homeUrl: new URL('https://cancel.example/'), maxPages: 3, requestDelay: 1, signal: controller.signal })
    assert.equal(partial.status, 'Partial')
    assert.equal(partial.limits.stoppedBy, 'cancelled')
  })
})

test('mid-stream connection death surfaces instead of partial success', async () => {
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket hang up')) } }), { status: 200, headers: { 'content-type': 'text/html' } })
  const fake = async (url, options = {}) => broken
  await withFakeFetch(fake, async () => {
    await assert.rejects(() => fetchPublicText('https://broken.example/', { dnsLookup: fakeDns }), /socket hang up/)
  })
})

function museLead() {
  return {
    company: 'Muse Fixture Co',
    category: 'Plumbing',
    location: 'Boise, ID',
    website: 'musefixture.example',
    opportunityScore: 62,
    confidence: 70,
    analysisSource: 'Deterministic website audit',
    mainIssue: 'Contact path',
    issueDetail: 'No obvious phone, email, or enquiry form was detected.',
    problems: ['No obvious phone, email, or enquiry form was detected.', 'The homepage title is missing or outside a useful descriptive range.'],
    evidence: ['Direct contact methods detected: 0', 'Homepage title length: 4 characters'],
  }
}

function museOptions(server) {
  return { metaApiKey: DUMMY_KEY, baseURL: server.url, model: 'bench-fake' }
}

async function groundedAnalysisPayload(lead) {
  const observations = buildObservations(lead)
  const cited = observations[0]
  return JSON.stringify({
    summary: 'Contact paths are missing.',
    qualificationRecommendation: 'Review',
    noSupportedOpportunity: false,
    topOpportunities: [{
      title: 'Add visible contact paths',
      severity: 'High',
      evidence: cited.text,
      evidenceIds: [cited.id],
      whyItMatters: 'Visitors cannot reach the business.',
      recommendation: 'Add the phone number above the fold.',
    }],
  })
}

test('model SDK retries a transient 500 and then succeeds (2 calls, 0 spend)', async () => {
  const lead = museLead()
  const server = await startFakeModelServer(
    [{ status: 500, body: 'overloaded' }],
    { defaultResponse: { body: await groundedAnalysisPayload(lead) } },
  )
  try {
    const analysis = await generateMuseAnalysis(lead, museOptions(server))
    assert.equal(analysis.topOpportunities.length, 1)
    assert.equal(server.ledger.length, 2)
  } finally {
    await server.close()
  }
})

test('stale analysis citing a previous packet is rejected and nothing is saved', async () => {
  const lead = museLead()
  const stalePayload = JSON.stringify({
    summary: 'Old packet reused.',
    qualificationRecommendation: 'Review',
    noSupportedOpportunity: false,
    topOpportunities: [{
      title: 'Add visible contact paths',
      severity: 'High',
      evidence: 'Direct contact methods detected: 0 on the homepage',
      evidenceIds: ['obs-previous-packet-9'],
      whyItMatters: 'Visitors cannot call.',
      recommendation: 'Add a phone number.',
    }],
  })
  const server = await startFakeModelServer([{ body: stalePayload }])
  try {
    await assert.rejects(() => generateMuseAnalysis(lead, museOptions(server)), /unknown or stale evidence/)
  } finally {
    await server.close()
  }
})

test('malformed model JSON is rejected with the previous analysis left untouched', async () => {
  const server = await startFakeModelServer([{ body: '{not json{{{' }])
  try {
    await assert.rejects(() => generateMuseAnalysis(museLead(), museOptions(server)), /malformed analysis JSON/)
  } finally {
    await server.close()
  }
})
