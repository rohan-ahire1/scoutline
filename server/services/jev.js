// TypeSafe Jev adapter. Jev supplies typed decisions for software workflows;
// it is deliberately kept separate from Scoutline's evidence and score logic.

export const JEV_MODEL = 'jev-latest'
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_SCHEMA_VERSION = 1

const MAX_TEXT = 2400
const MAX_LIST = 12
const MAX_PAGES = 6
const LOW_CONFIDENCE = 0.55
const NOUL_UNCERTAIN_MIN = 0.35
const NOUL_UNCERTAIN_MAX = 0.65
const MAX_RETRIES = 2

const QUESTION_DEFINITIONS = {
  site_archetype: {
    type: 'choice',
    instructions: 'What kind of website is represented by this state? Use only the observed business and website signals.',
    criteria: {
      local_service: 'A local service business where calls, enquiries, bookings, or estimates are central.',
      ecommerce: 'A product catalogue or online store where products or checkout are central.',
      portfolio_or_agency: 'A portfolio, agency, freelancer, or professional-services site selling expertise or projects.',
      content_or_publisher: 'A content, media, education, or publishing site.',
      other_or_unclear: 'No category fits or the available state is insufficient to classify it.',
    },
  },
  primary_opportunity: {
    type: 'choice',
    instructions: 'Which single website-service opportunity is most addressable from the observed evidence? Do not infer business outcomes.',
    criteria: {
      redesign: 'The main opportunity is visual hierarchy, content structure, or general modernization.',
      conversion: 'The offer exists but the next step, CTA, contact, booking, or estimate path is weak or unclear.',
      performance_or_mobile: 'The main opportunity is speed, mobile usability, or technical friction.',
      seo_or_structure: 'The main opportunity is discoverability, metadata, hierarchy, or structured data.',
      maintenance: 'The main opportunity is broken links, stale pages, or maintenance issues.',
      none_or_unclear: 'No single addressable opportunity is supported or the evidence is too thin.',
    },
  },
  redesign_fit: {
    type: 'score',
    instructions: 'How strong is the case for substantial website improvement based only on the observed state?',
    criteria: [
      'No supported improvement case',
      'Possible case, but evidence is thin',
      'Clear addressable improvement case',
      'Exceptionally strong observed need for improvement',
    ],
  },
  conversion_gap: {
    type: 'score',
    instructions: 'How large is the observed gap between the site offer and an easy next step for a prospective customer?',
    criteria: [
      'No clear gap observed',
      'Small or possible gap',
      'Clear gap in the next step or contact path',
      'Strong gap with several observed friction signals',
    ],
  },
  mobile_friction: {
    type: 'score',
    instructions: 'How much mobile or technical friction is observable in this state?',
    criteria: [
      'No material friction observed',
      'Small or possible friction',
      'Clear mobile or technical friction',
      'Strong friction across multiple observed signals',
    ],
  },
  clear_contact_path: {
    type: 'noul',
    instructions: 'Does the website show a clear, low-friction path for a prospective customer to call, contact, book, or request an estimate?',
    criteria: {
      true: 'A clear contact, booking, estimate, or phone path is observed.',
      false: 'No clear low-friction customer contact path is observed in the supplied state.',
    },
  },
  should_deep_audit: {
    type: 'noul',
    instructions: 'Would a deeper website audit likely reveal useful additional evidence for deciding whether this site is worth pursuing for web work?',
    criteria: {
      true: 'A deeper audit is likely to clarify or substantiate an addressable opportunity.',
      false: 'The supplied state is sufficient, or a deeper audit is unlikely to add useful evidence.',
    },
  },
}

export class JevError extends Error {
  constructor(message, code = 'JEV_ERROR', { status = null, retryable = false, cause = null } = {}) {
    super(message)
    this.name = 'JevError'
    this.code = code
    this.status = status
    this.retryable = retryable
    if (cause) this.cause = cause
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function compactText(value, limit = MAX_TEXT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, limit) : null
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function boundedNumber(value, min, max) {
  const number = finite(value)
  return number == null ? null : Math.max(min, Math.min(max, number))
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values, limit = MAX_LIST, maxLength = 180) {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().slice(0, maxLength)))]
    .slice(0, limit)
}

function boolFlags(value, limit = MAX_LIST) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => typeof item === 'boolean')
    .slice(0, limit))
}

function sourceFor(input = {}) {
  if (input.aggregate && typeof input.aggregate === 'object') return input.aggregate
  if (input.site && typeof input.site === 'object') return input.site
  if (input.lead && typeof input.lead === 'object') return input.lead
  return input
}

function firstValue(values) {
  return values.find((value) => value != null && String(value).trim() !== '') ?? null
}

export function getJevConfig(options = {}) {
  const apiKey = hasOwn(options, 'apiKey') ? options.apiKey : (process.env.TYPESAFE_API_KEY || null)
  const endpoint = hasOwn(options, 'endpoint') ? options.endpoint : (process.env.JEV_API_URL || JEV_ENDPOINT)
  const model = hasOwn(options, 'model') ? options.model : (process.env.JEV_MODEL || JEV_MODEL)
  return {
    configured: Boolean(String(apiKey || '').trim()),
    provider: 'typesafe',
    providerLabel: 'TypeSafe Jev',
    apiKey: apiKey ? String(apiKey) : null,
    endpoint: String(endpoint || JEV_ENDPOINT),
    model: String(model || JEV_MODEL),
  }
}

// Build a compact, non-HTML state packet. The crawler already extracted the
// useful signals; Jev should classify those signals rather than receive a
// page dump or any credentials.
export function buildJevState(input = {}) {
  const source = sourceFor(input)
  const lead = input.lead && typeof input.lead === 'object' ? input.lead : {}
  const aggregatePages = Array.isArray(source.pages) ? source.pages : []
  const leadPages = Array.isArray(lead.crawlPages) ? lead.crawlPages : []
  const pages = (aggregatePages.length ? aggregatePages : leadPages).slice(0, MAX_PAGES).map((page) => ({
    path: compactText(page.path || page.requestedUrl || page.url, 180),
    statusCode: finite(page.statusCode),
    latencyMs: finite(page.latencyMs),
    title: compactText(page.title, 180),
    h1: compactText(page.h1, 180),
    textExcerpt: compactText(page.textExcerpt, 700),
    textLength: finite(page.textLength ?? page.wordCount),
    forms: finite(page.forms),
    inputCount: finite(page.inputCount),
    fetchError: compactText(page.fetchError, 240),
  }))

  const signals = source.signals || lead.auditSummary || {}
  const tech = source.tech || lead.stack || {}
  const visualRisk = source.visualRisk || lead.visualRisk || null
  const eligibilityReasons = source.eligibilityReasons || lead.eligibilityReasons || []
  const title = firstValue([source.title, lead.company, input.company])
  const textExcerpt = firstValue([source.textExcerpt, source.text, lead.issueDetail])

  return {
    business: {
      company: compactText(input.company ?? lead.company ?? source.company, 160),
      category: compactText(input.category ?? lead.category ?? source.category, 100),
      location: compactText(input.location ?? lead.location ?? source.location, 160),
      website: compactText(input.website ?? lead.website ?? source.url ?? source.website, 240),
    },
    website: {
      type: compactText(source.websiteType || source.website_type || lead.websiteType, 60),
      title: compactText(title, 180),
      metaDescription: compactText(source.metaDescription || source.meta_description, 500),
      h1: compactText(source.h1, 180),
      textExcerpt: compactText(textExcerpt, MAX_TEXT),
      pagesInspected: finite(source.pagesInspected ?? source.last_pages_inspected ?? lead.pageCount),
      linksCount: finite(source.linksCount),
      internalLinksCount: finite(source.internalLinksCount),
      forms: finite(source.forms),
      pages,
    },
    contacts: {
      emailsFound: Array.isArray(source.emails) ? source.emails.length : 0,
      phonesFound: Array.isArray(source.phones) ? source.phones.length : 0,
      hasBookingOrEstimate: boolOrNull(source.onlineBooking || source.onlineEstimates),
    },
    technical: {
      signals: boolFlags(signals),
      technology: Array.isArray(tech) ? uniqueStrings(tech) : boolFlags(tech),
      visualRiskScore: boundedNumber(visualRisk?.score ?? source.last_visual_risk_score, 0, 100),
      visualRiskReasons: uniqueStrings(visualRisk?.reasons, MAX_LIST, 120),
    },
    deterministic: {
      opportunityScore: boundedNumber(source.opportunityScore ?? source.last_opportunity_score ?? lead.opportunityScore, 0, 100),
      eligible: boolOrNull(source.eligible ?? source.last_eligible),
      eligibilityReasons: uniqueStrings(eligibilityReasons, MAX_LIST, 120),
    },
  }
}

export function buildJevQuestions() {
  return JSON.parse(JSON.stringify(QUESTION_DEFINITIONS))
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JevError(message, 'JEV_INVALID_RESPONSE')
}

function assertProbabilityMap(value, allowed, id) {
  assertObject(value, `Jev answer ${id} has no probability distribution`)
  if (Object.keys(value).length !== allowed.length || allowed.some((key) => !hasOwn(value, key))) {
    throw new JevError(`Jev answer ${id} did not return the full probability distribution`, 'JEV_INVALID_RESPONSE')
  }
  let total = 0
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new JevError(`Jev answer ${id} returned an unknown probability key`, 'JEV_INVALID_RESPONSE')
    const number = finite(value[key])
    if (number == null || number < 0 || number > 1) throw new JevError(`Jev answer ${id} returned an invalid probability`, 'JEV_INVALID_RESPONSE')
    total += number
  }
  if (Math.abs(total - 1) > 0.02) throw new JevError(`Jev answer ${id} returned probabilities that do not sum to 1`, 'JEV_INVALID_RESPONSE')
}

export function normalizeJevResponse(payload, questions = buildJevQuestions()) {
  assertObject(payload, 'Jev returned an invalid response')
  assertObject(payload.answers, 'Jev returned no answers')
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = payload.answers[id]
    assertObject(answer, `Jev returned no answer for ${id}`)
    if (answer.type !== question.type) throw new JevError(`Jev answer ${id} has the wrong type`, 'JEV_INVALID_RESPONSE')
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria)
      if (!options.includes(answer.choice)) throw new JevError(`Jev answer ${id} selected an unknown option`, 'JEV_INVALID_RESPONSE')
      assertProbabilityMap(answer.probabilities, options, id)
      const confidence = boundedNumber(answer.confidence, 0, 1)
      if (confidence == null) throw new JevError(`Jev answer ${id} has no valid confidence`, 'JEV_INVALID_RESPONSE')
      answers[id] = { type: 'choice', choice: answer.choice, probabilities: Object.fromEntries(options.map((key) => [key, boundedNumber(answer.probabilities[key], 0, 1) ?? 0])), confidence }
    } else if (question.type === 'score') {
      const max = question.criteria.length - 1
      const score = boundedNumber(answer.score, 0, max)
      const confidence = boundedNumber(answer.confidence, 0, 1)
      if (score == null || confidence == null) throw new JevError(`Jev answer ${id} has an invalid score or confidence`, 'JEV_INVALID_RESPONSE')
      assertProbabilityMap(answer.probabilities, question.criteria.map((_, index) => String(index)), id)
      answers[id] = { type: 'score', score, legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])), probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), boundedNumber(answer.probabilities[String(index)], 0, 1) ?? 0])), confidence }
    } else {
      const noul = boundedNumber(answer.noul, 0, 1)
      if (noul == null) throw new JevError(`Jev answer ${id} has an invalid noul value`, 'JEV_INVALID_RESPONSE')
      answers[id] = { type: 'noul', noul }
    }
  }
  const usage = payload.usage && typeof payload.usage === 'object'
    ? { inputTokens: finite(payload.usage.input_tokens), outputTokens: finite(payload.usage.output_tokens) }
    : { inputTokens: null, outputTokens: null }
  return { model: compactText(payload.model, 100), responseId: compactText(payload.id, 120), answers, usage }
}

function round(value) {
  return Math.round(value * 10) / 10
}

function scorePercent(answer, max) {
  return round(((answer?.score ?? 0) / Math.max(max, 1)) * 100)
}

function isNoulUncertain(answer) {
  return answer?.type === 'noul' && answer.noul > NOUL_UNCERTAIN_MIN && answer.noul < NOUL_UNCERTAIN_MAX
}

export function deriveJevTriage(answers) {
  assertObject(answers, 'Cannot derive Jev triage without answers')
  const redesignFit = scorePercent(answers.redesign_fit, 3)
  const conversionGap = scorePercent(answers.conversion_gap, 3)
  const mobileFriction = scorePercent(answers.mobile_friction, 3)
  const contactGap = round((1 - (answers.clear_contact_path?.noul ?? 0)) * 100)
  const semanticOpportunityScore = Math.round(
    (0.35 * redesignFit) +
    (0.25 * conversionGap) +
    (0.20 * mobileFriction) +
    (0.20 * contactGap),
  )
  const confidenceAnswers = ['site_archetype', 'primary_opportunity', 'redesign_fit', 'conversion_gap', 'mobile_friction']
    .map((id) => answers[id]?.confidence)
    .filter((value) => Number.isFinite(value))
  const uncertaintyReasons = []
  for (const id of confidenceAnswers.length ? ['site_archetype', 'primary_opportunity', 'redesign_fit', 'conversion_gap', 'mobile_friction'] : []) {
    if (answers[id]?.confidence < LOW_CONFIDENCE) uncertaintyReasons.push(`${id}_low_confidence`)
  }
  for (const id of ['clear_contact_path', 'should_deep_audit']) {
    if (isNoulUncertain(answers[id])) uncertaintyReasons.push(`${id}_uncertain`)
  }
  const uncertain = uncertaintyReasons.length > 0
  const deepAuditProbability = answers.should_deep_audit?.noul ?? 0
  const route = !uncertain && semanticOpportunityScore >= 60 && deepAuditProbability >= 0.55
    ? 'deep-audit'
    : uncertain || semanticOpportunityScore >= 40
      ? 'review'
      : 'pass'
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    status: 'completed',
    route,
    uncertain,
    uncertaintyReasons,
    archetype: answers.site_archetype?.choice || null,
    primaryOpportunity: answers.primary_opportunity?.choice || null,
    semanticOpportunityScore,
    decisionConfidence: confidenceAnswers.length ? round(confidenceAnswers.reduce((sum, value) => sum + value, 0) / confidenceAnswers.length) : null,
    shouldDeepAuditProbability: round(deepAuditProbability),
    componentScores: { redesignFit, conversionGap, mobileFriction, contactGap },
  }
}

export function normalizeJevTriage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.status === 'failed') {
    return {
      status: 'failed',
      code: compactText(value.code, 60),
      error: compactText(value.error, 300) || 'Jev triage failed',
      retryable: Boolean(value.retryable),
    }
  }
  if (value.status !== 'completed') return null
  const route = ['deep-audit', 'review', 'pass'].includes(value.route) ? value.route : null
  const archetypeOptions = Object.keys(QUESTION_DEFINITIONS.site_archetype.criteria)
  const opportunityOptions = Object.keys(QUESTION_DEFINITIONS.primary_opportunity.criteria)
  const componentScores = value.componentScores && typeof value.componentScores === 'object' ? value.componentScores : {}
  const answers = value.answers && typeof value.answers === 'object' ? value.answers : null
  return {
    schemaVersion: Number.isInteger(value.schemaVersion) ? value.schemaVersion : JEV_SCHEMA_VERSION,
    status: 'completed',
    model: compactText(value.model, 100),
    generatedAt: compactText(value.generatedAt, 50),
    route,
    uncertain: Boolean(value.uncertain),
    uncertaintyReasons: uniqueStrings(value.uncertaintyReasons, 8, 80),
    archetype: archetypeOptions.includes(value.archetype) ? value.archetype : null,
    primaryOpportunity: opportunityOptions.includes(value.primaryOpportunity) ? value.primaryOpportunity : null,
    semanticOpportunityScore: boundedNumber(value.semanticOpportunityScore, 0, 100),
    decisionConfidence: boundedNumber(value.decisionConfidence, 0, 1),
    shouldDeepAuditProbability: boundedNumber(value.shouldDeepAuditProbability, 0, 1),
    componentScores: {
      redesignFit: boundedNumber(componentScores.redesignFit, 0, 100),
      conversionGap: boundedNumber(componentScores.conversionGap, 0, 100),
      mobileFriction: boundedNumber(componentScores.mobileFriction, 0, 100),
      contactGap: boundedNumber(componentScores.contactGap, 0, 100),
    },
    ...(answers ? { answers: normalizeJevAnswersForStorage(answers) } : {}),
  }
}

function normalizeJevAnswersForStorage(answers) {
  const out = {}
  for (const id of Object.keys(QUESTION_DEFINITIONS)) {
    const answer = answers[id]
    if (!answer || typeof answer !== 'object') continue
    if (answer.type === 'choice') {
      out[id] = { type: 'choice', choice: compactText(answer.choice, 80), probabilities: boundedProbabilityMap(answer.probabilities), confidence: boundedNumber(answer.confidence, 0, 1) }
    } else if (answer.type === 'score') {
      out[id] = { type: 'score', score: finite(answer.score), probabilities: boundedProbabilityMap(answer.probabilities), confidence: boundedNumber(answer.confidence, 0, 1) }
    } else if (answer.type === 'noul') {
      out[id] = { type: 'noul', noul: boundedNumber(answer.noul, 0, 1) }
    }
  }
  return out
}

function boundedProbabilityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => [String(key).slice(0, 80), boundedNumber(item, 0, 1)]))
}

export function jevFailure(error) {
  return {
    status: 'failed',
    code: compactText(error?.code, 60) || 'JEV_ERROR',
    error: compactText(error?.message || error, 300) || 'Jev triage failed',
    retryable: Boolean(error?.retryable),
  }
}

async function responseError(response) {
  let detail = ''
  try {
    const body = await response.json()
    detail = body?.error?.message || body?.error || body?.message || ''
  } catch {
    try { detail = await response.text() } catch { detail = '' }
  }
  const suffix = compactText(detail, 220)
  return suffix ? `TypeSafe Jev returned HTTP ${response.status}: ${suffix}` : `TypeSafe Jev returned HTTP ${response.status}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function evaluateJev(input, options = {}) {
  const emit = (event) => {
    if (typeof options.onEvent !== 'function') return
    try { options.onEvent(event) } catch { /* accounting must never break a classification */ }
  }
  const config = getJevConfig(options)
  if (!config.configured) {
    const error = new JevError('TypeSafe Jev is not configured; add TYPESAFE_API_KEY to .env', 'JEV_NOT_CONFIGURED')
    emit({ type: 'failure', code: error.code, message: error.message })
    throw error
  }
  const state = options.state || buildJevState(input)
  const questions = options.questions || buildJevQuestions()
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    const error = new JevError('No fetch implementation is available for Jev', 'JEV_CLIENT_ERROR')
    emit({ type: 'failure', code: error.code, message: error.message })
    throw error
  }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15_000)
  const retryLimit = Math.max(0, Math.min(MAX_RETRIES, Number(options.maxRetries ?? MAX_RETRIES)))
  const retryBaseMs = Math.max(0, Math.min(5000, Number(options.retryBaseMs ?? 150)))
  const request = { state, model: config.model, questions }
  let lastError = null
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    let response
    emit({ type: 'request', attempt: attempt + 1, at: new Date().toISOString() })
    try {
      response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const jevError = error?.name === 'TimeoutError'
        ? new JevError('TypeSafe Jev timed out', 'JEV_TIMEOUT', { retryable: true, cause: error })
        : new JevError(`TypeSafe Jev request failed: ${error?.message || error}`, 'JEV_NETWORK_ERROR', { retryable: true, cause: error })
      emit({ type: 'failure', code: jevError.code, message: jevError.message })
      throw jevError
    }
    emit({ type: 'response', attempt: attempt + 1, status: response.status })
    if (response.ok) {
      try {
        const payload = await response.json()
        const normalized = normalizeJevResponse(payload, questions)
        const derived = deriveJevTriage(normalized.answers)
        const result = {
          ...derived,
          model: normalized.model || config.model,
          answers: normalized.answers,
          usage: normalized.usage,
          responseId: normalized.responseId,
          generatedAt: new Date().toISOString(),
        }
        emit({ type: 'completed', route: result.route, uncertain: result.uncertain, usage: result.usage })
        return result
      } catch (error) {
        const jevError = error instanceof JevError
          ? error
          : new JevError('TypeSafe Jev returned invalid JSON', 'JEV_INVALID_RESPONSE', { cause: error })
        emit({ type: 'failure', code: jevError.code, message: jevError.message })
        throw jevError
      }
    }
    const retryable = response.status === 429 || response.status === 529
    const message = await responseError(response)
    lastError = new JevError(message, retryable ? 'JEV_RATE_LIMITED' : 'JEV_PROVIDER_ERROR', { status: response.status, retryable })
    if (!retryable || attempt >= retryLimit) {
      emit({ type: 'failure', code: lastError.code, message: lastError.message })
      throw lastError
    }
    await sleep(retryBaseMs * (2 ** attempt))
  }
  throw lastError || new JevError('TypeSafe Jev request failed', 'JEV_PROVIDER_ERROR', { retryable: true })
}
