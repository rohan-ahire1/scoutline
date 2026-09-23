import test from 'node:test'
import assert from 'node:assert/strict'
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  buildJevQuestions,
  buildJevState,
  deriveJevTriage,
  evaluateJev,
  getJevConfig,
  normalizeJevResponse,
} from './jev.js'

function choiceAnswer(choice, options, confidence = 0.9) {
  return {
    type: 'choice',
    choice,
    probabilities: Object.fromEntries(options.map((item) => [item, item === choice ? 1 : 0])),
    confidence,
  }
}

function scoreAnswer(score, levels = 4, confidence = 0.9) {
  return {
    type: 'score',
    score,
    probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === score ? 1 : 0])),
    confidence,
  }
}

function response(overrides = {}) {
  return {
    model: JEV_MODEL,
    answers: {
      site_archetype: choiceAnswer('local_service', ['local_service', 'ecommerce', 'portfolio_or_agency', 'content_or_publisher', 'other_or_unclear']),
      primary_opportunity: choiceAnswer('redesign', ['redesign', 'conversion', 'performance_or_mobile', 'seo_or_structure', 'maintenance', 'none_or_unclear']),
      redesign_fit: scoreAnswer(3),
      conversion_gap: scoreAnswer(2),
      mobile_friction: scoreAnswer(2),
      clear_contact_path: { type: 'noul', noul: 0.2 },
      should_deep_audit: { type: 'noul', noul: 0.9 },
    },
    usage: { input_tokens: 123, output_tokens: 45 },
    ...overrides,
  }
}

test('Jev configuration uses the server-side TypeSafe key and documented defaults', () => {
  const previous = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const config = getJevConfig()
    assert.equal(config.configured, true)
    assert.equal(config.apiKey, 'test-key')
    assert.equal(config.endpoint, JEV_ENDPOINT)
    assert.equal(config.model, JEV_MODEL)
    assert.equal(getJevConfig({ apiKey: '  ' }).configured, false)
  } finally {
    if (previous == null) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
  }
})

test('buildJevState sends a compact state packet with business context and bounded text', () => {
  const state = buildJevState({
    company: 'Acme Roofing',
    category: 'Roofing',
    location: 'Salt Lake City, Utah',
    website: 'https://acme.example.com/',
    aggregate: {
      title: 'Acme Roofing',
      metaDescription: 'Roof repair and replacement.',
      h1: 'Roofing in Salt Lake City',
      textExcerpt: 'word '.repeat(1000),
      pagesInspected: 3,
      emails: ['hello@acme.example.com'],
      phones: ['+1 801 555 0100'],
      onlineBooking: true,
      tech: { staticCandidate: true },
      signals: { https: true, viewport: false },
      visualRisk: { score: 66, reasons: ['missing_mobile_viewport'] },
      opportunityScore: 78,
      eligible: true,
      eligibilityReasons: ['static_candidate'],
      pages: [{ requestedUrl: 'https://acme.example.com/', title: 'Acme', textExcerpt: 'page '.repeat(300) }],
    },
  })

  assert.deepEqual(state.business, {
    company: 'Acme Roofing',
    category: 'Roofing',
    location: 'Salt Lake City, Utah',
    website: 'https://acme.example.com/',
  })
  assert.equal(state.website.textExcerpt.length, 2400)
  assert.equal(state.website.pages.length, 1)
  assert.equal(state.website.pages[0].path, 'https://acme.example.com/')
  assert.equal(state.contacts.emailsFound, 1)
  assert.equal(state.technical.visualRiskScore, 66)
  assert.equal(state.deterministic.opportunityScore, 78)
  assert.equal(state.deterministic.eligible, true)
  assert.equal('html' in state, false)
})

test('Jev typed answers normalize and route a strong site to a deep audit', () => {
  const normalized = normalizeJevResponse(response())
  const triage = deriveJevTriage(normalized.answers)
  assert.equal(normalized.usage.inputTokens, 123)
  assert.equal(normalized.answers.redesign_fit.legend['3'], 'Exceptionally strong observed need for improvement')
  assert.equal(triage.status, 'completed')
  assert.equal(triage.route, 'deep-audit')
  assert.equal(triage.uncertain, false)
  assert.equal(triage.semanticOpportunityScore, 81)
  assert.equal(triage.componentScores.redesignFit, 100)
})

test('uncertain Jev answers route to review instead of an automatic deep audit', () => {
  const normalized = normalizeJevResponse(response({
    answers: {
      ...response().answers,
      clear_contact_path: { type: 'noul', noul: 0.5 },
      redesign_fit: scoreAnswer(3, 4, 0.4),
    },
  }))
  const triage = deriveJevTriage(normalized.answers)
  assert.equal(triage.route, 'review')
  assert.equal(triage.uncertain, true)
  assert.ok(triage.uncertaintyReasons.includes('redesign_fit_low_confidence'))
  assert.ok(triage.uncertaintyReasons.includes('clear_contact_path_uncertain'))
})

test('evaluateJev calls the documented endpoint without putting the API key in the body', async () => {
  let captured = null
  const events = []
  const result = await evaluateJev({ company: 'Acme Roofing', website: 'https://acme.example.com/' }, {
    apiKey: 'secret-key',
    onEvent: (event) => events.push(event),
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return { ok: true, status: 200, json: async () => response() }
    },
  })

  assert.equal(captured.url, JEV_ENDPOINT)
  assert.equal(captured.options.headers.Authorization, 'Bearer secret-key')
  const body = JSON.parse(captured.options.body)
  assert.equal(body.model, JEV_MODEL)
  assert.equal(body.state.business.company, 'Acme Roofing')
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'apiKey'), false)
  assert.equal(result.route, 'deep-audit')
  assert.equal(result.model, JEV_MODEL)
  assert.deepEqual(events.map((event) => event.type), ['request', 'response', 'completed'])
  assert.equal(events[0].attempt, 1)
  assert.equal(events[2].usage.inputTokens, 123)
})

test('evaluateJev retries a rate-limited response with bounded backoff', async () => {
  let calls = 0
  const events = []
  const result = await evaluateJev({}, {
    apiKey: 'secret-key',
    onEvent: (event) => events.push(event),
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 429, json: async () => ({ error: 'slow down' }) }
      return { ok: true, status: 200, json: async () => response() }
    },
    maxRetries: 1,
    retryBaseMs: 0,
  })
  assert.equal(calls, 2)
  assert.equal(result.status, 'completed')
  assert.deepEqual(events.map((event) => event.type), ['request', 'response', 'request', 'response', 'completed'])
  assert.equal(events[2].attempt, 2)
})

test('malformed Jev probabilities fail closed', () => {
  const malformed = response()
  delete malformed.answers.site_archetype.probabilities.other_or_unclear
  assert.throws(() => normalizeJevResponse(malformed), /full probability distribution/)
})
