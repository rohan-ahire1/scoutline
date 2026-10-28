import OpenAI from 'openai'
import { assertNoInventedClaims, buildObservations, extractResponseText, getOutreachConfig } from './outreach.js'
import { parseFiniteNumber as finiteNumber, resolveMetricProvenance, resolveNestedProvenance } from './measure.js'
import { askJev, asChoice, getJevConfig } from './jev.js'

const opportunitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'severity', 'evidence', 'evidenceIds', 'whyItMatters', 'recommendation'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 100 },
    severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    evidence: { type: 'string', minLength: 3, maxLength: 400 },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 60 } },
    whyItMatters: { type: 'string', minLength: 3, maxLength: 500 },
    recommendation: { type: 'string', minLength: 3, maxLength: 500 },
  },
}

export const museAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'topOpportunities', 'strengths', 'unknowns', 'qualificationRecommendation', 'qualificationRationale', 'outreachAngles', 'noSupportedOpportunity'],
  properties: {
    summary: { type: 'string', minLength: 10, maxLength: 800 },
    topOpportunities: { type: 'array', minItems: 0, maxItems: 5, items: opportunitySchema },
    strengths: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 3, maxLength: 300 } },
    unknowns: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 3, maxLength: 300 } },
    qualificationRecommendation: { type: 'string', enum: ['Pursue', 'Review', 'Pass'] },
    qualificationRationale: { type: 'string', minLength: 3, maxLength: 500 },
    outreachAngles: { type: 'array', minItems: 0, maxItems: 4, items: { type: 'string', minLength: 3, maxLength: 300 } },
    noSupportedOpportunity: { type: 'boolean' },
  },
}

const CLAIM_STOPWORDS = new Set('the,a,an,and,or,of,to,in,on,for,with,without,from,by,is,are,was,were,be,as,at,it,its,this,that,these,those,they,their,not,no,do,does,will,would,could,should,may,can,has,have,had,was,were,been,being,your,you,we,our,us,i,my,me,he,she,they,them,his,her,into,over,under,than,then,there,here,when,where,which,who,what,how,all,any,each,more,most,other,some,such,only,own,same,so,too,very,just,about,into,through,during,before,after,above,below,between,again,once,while,because,until,against,among,per,via,lack,missing'.split(','))

function significantTokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 3 && !CLAIM_STOPWORDS.has(token)))
}

// Adversarial claim-to-evidence check: ID membership is necessary but not proof
// of semantic correctness, so the claim text must also share substance with the
// observations it cites — otherwise it fails instead of silently becoming prose.
export function assertOpportunityGrounded(opportunity, observations, { index = 0 } = {}) {
  const refs = Array.isArray(opportunity?.evidenceIds) ? opportunity.evidenceIds : []
  const cited = observations.filter((item) => refs.includes(item.id))
  if (!refs.length) throw new Error(`AI opportunity ${index + 1} cites no evidence IDs; every opportunity must reference the observations it is built from`)
  if (cited.length !== refs.length) {
    const unknown = refs.filter((id) => !observations.some((item) => item.id === id))
    throw new Error(`AI opportunity ${index + 1} references unknown or stale evidence IDs (${unknown.join(', ')}); validation failed instead of saving ungrounded prose`)
  }
  const claimTokens = significantTokens(`${opportunity.title} ${opportunity.evidence}`)
  const citedText = cited.map((item) => item.text).join('\n')
  const citedTokens = significantTokens(citedText)
  const overlap = [...claimTokens].filter((token) => citedTokens.has(token))
  const verbatim = cited.some((item) => {
    const clean = String(item.text || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const claim = `${opportunity.title} ${opportunity.evidence}`.toLowerCase()
    if (clean.length >= 10 && claim.includes(clean.slice(0, Math.min(clean.length, 24)))) return true
    return false
  })
  if (!verbatim && overlap.length < 2) {
    throw new Error(`AI opportunity ${index + 1} ("${opportunity.title}") does not match the evidence it cites; shared substance: ${overlap.slice(0, 5).join(', ') || 'none'}`)
  }
  return true
}

function compactText(value, limit = 400) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

export function extractLighthouseEvidence(report, limit = 15) {
  if (!report?.audits || typeof report.audits !== 'object') return []
  const usefulModes = new Set(['binary', 'numeric', 'metricSavings'])
  return Object.values(report.audits)
    .filter((audit) => audit && usefulModes.has(audit.scoreDisplayMode) && Number.isFinite(audit.score) && audit.score < 1)
    .map((audit) => ({
      id: audit.id,
      title: compactText(audit.title, 140),
      score: finiteNumber(audit.score),
      displayValue: compactText(audit.displayValue, 160) || null,
      numericValue: finiteNumber(audit.numericValue),
      numericUnit: audit.numericUnit || null,
    }))
    .sort((a, b) => a.score - b.score || Number(b.numericValue || 0) - Number(a.numericValue || 0))
    .slice(0, Math.max(1, Math.min(25, Number(limit || 15))))
}

export function buildMuseEvidencePacket(lead, options = {}) {
  const lighthouse = lead.lighthouse || lead.auditComponents?.lighthouse || null
  return {
    evidencePolicy: 'Every conclusion must be supported by this packet. Missing information is unknown, not permission to guess.',
    business: {
      company: compactText(lead.company, 160),
      category: compactText(lead.category, 100),
      location: compactText(lead.location, 180),
      website: compactText(lead.website, 240),
      publicRating: finiteNumber(lead.rating),
      publicReviewCount: finiteNumber(lead.reviews),
    },
    deterministicAssessment: {
      opportunityScore: finiteNumber(lead.opportunityScore),
      confidence: finiteNumber(lead.confidence),
      source: compactText(lead.analysisSource, 160),
      mainIssue: compactText(lead.mainIssue, 240),
      issueDetail: compactText(lead.issueDetail, 600),
      findings: (lead.problems || []).slice(0, 8).map((item) => compactText(item, 400)),
      evidence: (lead.evidence || []).slice(0, 16).map((item) => compactText(item, 400)),
    },
    measuredAudit: {
      status: lead.auditStatus || null,
      auditedUrl: lead.auditedUrl || null,
      auditedAt: lead.auditedAt || null,
      scores: {
        performance: resolveMetricProvenance(lead, 'performance'),
        accessibility: resolveMetricProvenance(lead, 'accessibility'),
        bestPractices: resolveNestedProvenance(lead?.measureProvenance?.bestPractices, lighthouse?.scores?.bestPractices, { observedAt: lead.auditedAt || null }),
        seo: resolveMetricProvenance(lead, 'seo'),
      },
      timings: lighthouse?.metrics || null,
      pageCount: finiteNumber(lead.pageCount),
      sitemapPageCount: finiteNumber(lead.sitemapPageCount),
      linksChecked: finiteNumber(lead.checkedLinks),
      brokenLinks: finiteNumber(lead.brokenLinks),
      linkSummary: lead.linkSummary && typeof lead.linkSummary === 'object' ? {
        attempted: finiteNumber(lead.linkSummary.attempted),
        reachable: finiteNumber(lead.linkSummary.reachable),
        confirmedBroken: finiteNumber(lead.linkSummary.confirmedBroken),
        unverified: finiteNumber(lead.linkSummary.unverified),
        byOutcome: lead.linkSummary.byOutcome || {},
        truncated: Boolean(lead.linkSummary.truncated),
      } : null,
      unverifiedLinks: (lead.unverifiedLinkDetails || []).slice(0, 20).map((item) => ({
        url: compactText(item.url, 300), outcome: item.outcome || null, status: finiteNumber(item.status), error: compactText(item.error, 200) || null,
      })),
      mobileQuality: lead.mobileQuality || null,
      https: typeof lead.https === 'boolean' ? lead.https : null,
      detectedStack: (lead.stack || []).slice(0, 12).map((item) => compactText(item, 100)),
      homepageSignals: lead.auditSummary || null,
      componentStatus: lead.auditComponents || null,
    },
    businessIntelligence: lead.businessIntelligence ? {
      source: lead.businessIntelligence.source || null,
      digitalMaturity: lead.businessIntelligence.digitalMaturity || null,
      claimed: lead.businessIntelligence.claimed ?? null,
      businessStatus: lead.businessIntelligence.businessStatus || null,
      locationsObserved: lead.businessIntelligence.locationsObserved ?? null,
      services: (lead.businessIntelligence.services || []).slice(0, 20),
      onlineBooking: Boolean(lead.businessIntelligence.onlineBooking),
      onlineEstimates: Boolean(lead.businessIntelligence.onlineEstimates),
      positiveReviewShare: lead.businessIntelligence.positiveReviewShare ?? null,
      latestObservedReviewAt: lead.businessIntelligence.latestObservedReviewAt || null,
      photosObserved: lead.businessIntelligence.photosObserved ?? null,
      companyMetrics: lead.businessIntelligence.companyMetrics || null,
      evidence: (lead.businessIntelligence.evidence || []).slice(0, 20),
    } : null,
    crawledPages: (lead.crawlPages || []).slice(0, 15).map((page) => ({
      url: compactText(page.url, 300), path: compactText(page.path, 160), title: compactText(page.title, 180),
      h1Count: finiteNumber(page.h1Count), wordCount: finiteNumber(page.wordCount), forms: finiteNumber(page.forms), inputCount: finiteNumber(page.inputCount),
    })),
    brokenLinkDetails: (lead.brokenLinkDetails || []).slice(0, 20).map((item) => ({
      url: compactText(item.url, 300), outcome: item.outcome || 'confirmed_broken', status: finiteNumber(item.status), error: compactText(item.error, 200) || null,
    })),
    crawlWarnings: (lead.crawlErrors || []).slice(0, 10).map((item) => ({
      url: compactText(item.url, 300), code: item.code || null, error: compactText(item.error, 200),
    })),
    lighthouseFailures: extractLighthouseEvidence(options.lighthouseReport),
  }
}

export function validateMuseAnalysis(result, { observations = null, allowedEvidenceIds = null } = {}) {
  if (!result || typeof result !== 'object') throw new Error('AI returned an invalid analysis payload (expected a JSON object)')
  if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('AI did not return a summary')
  if (!['Pursue', 'Review', 'Pass'].includes(result.qualificationRecommendation)) throw new Error('AI returned an invalid qualification recommendation')
  if (!Array.isArray(result.topOpportunities)) throw new Error('AI returned malformed opportunities; previous analysis is unchanged — retry synthesis or edit manually')
  const allowed = allowedEvidenceIds || (observations || []).map((item) => item.id)
  const topOpportunities = result.topOpportunities.slice(0, 5).map((item, index) => {
    if (!item || !['High', 'Medium', 'Low'].includes(item.severity)) throw new Error('AI returned an invalid opportunity severity')
    for (const field of ['title', 'evidence', 'whyItMatters', 'recommendation']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) throw new Error(`AI returned an opportunity without ${field}`)
    }
    if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.length) {
      throw new Error(`AI opportunity ${index + 1} cites no evidence IDs; every opportunity must reference the observations it is built from`)
    }
    if (allowed.length) {
      const unknown = item.evidenceIds.filter((id) => !allowed.includes(id))
      if (unknown.length) throw new Error(`AI opportunity ${index + 1} references unknown or stale evidence IDs (${unknown.join(', ')}); validation failed instead of saving ungrounded prose`)
    }
    for (const field of ['title', 'evidence', 'whyItMatters', 'recommendation']) {
      assertNoInventedClaims(item[field], `AI opportunity ${index + 1} ${field}`)
    }
    if (observations) assertOpportunityGrounded(item, observations, { index })
    return Object.fromEntries(['title', 'severity', 'evidence', 'evidenceIds', 'whyItMatters', 'recommendation'].map((field) => field === 'evidenceIds' ? [field, [...item.evidenceIds]] : [field, item[field].trim()]))
  })
  const noSupportedOpportunity = result.noSupportedOpportunity === true
  if (!topOpportunities.length && !noSupportedOpportunity) {
    throw new Error('AI returned no opportunities without the explicit no-supported-opportunity outcome; refusing to invent one')
  }
  if (noSupportedOpportunity && topOpportunities.length) {
    throw new Error('AI declared no supported opportunity while returning opportunities; refusing the contradictory payload')
  }
  const cleanList = (value, limit) => (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item.trim()).slice(0, limit).map((item) => item.trim())
  const outreachAngles = cleanList(result.outreachAngles, 4)
  return {
    summary: result.summary.trim(),
    topOpportunities,
    outcome: noSupportedOpportunity ? 'no-supported-opportunity' : 'supported',
    noSupportedOpportunity,
    strengths: cleanList(result.strengths, 5),
    unknowns: cleanList(result.unknowns, 5),
    qualificationRecommendation: result.qualificationRecommendation,
    qualificationRationale: compactText(result.qualificationRationale, 500),
    outreachAngles,
  }
}

// Jev pre-screen. The criteria restate the synthesis prompt's qualification
// rule and the qualify.js rubric (business worth, site weakness, exclusions).
export const JEV_QUALIFICATION_INSTRUCTIONS = 'You are screening one local service business as a lead for website redesign or audit outreach. Using only the evidence packet, choose the qualification a careful human reviewer would give. Missing information is unknown, not evidence either way. Deterministic scores are inputs, not conclusions.'

export const JEV_QUALIFICATION_CRITERIA = {
  Pursue: 'The evidence shows clear, addressable website opportunities: specific measured or observed problems such as poor mobile performance, confirmed broken links, no visible phone, email, form or call to action, a dated, placeholder or free-builder site, or no real website of its own. The business also looks worth pitching: an open, owner-run local service business with a healthy Google rating (4.0 stars or more) and a meaningful number of reviews.',
  Review: 'Mixed or incomplete evidence: some problems are present but they are minor, estimated or unverified; key measurements are missing; the site could not be fully scanned; or business signals such as reviews, rating or category are thin or unknown. A human should look before deciding.',
  Pass: 'Little addressable website opportunity or unreliable evidence: the site already measures and looks good with few or no real problems, or the business is a poor fit for outreach because it is closed, a franchise or national brand, not an owner-run service business (utility, government, bank, school, store, supplier, nonprofit), a large operation with in-house marketing, has a weak reputation under 4.0 stars, or shares its website with other listings; or the audit evidence is too unreliable to act on.',
}

export function jevStateFromPacket(evidencePacket) {
  return `Website opportunity research for one business lead. Evidence packet (JSON):\n${JSON.stringify(evidencePacket, null, 1)}`
}

function cleanProbabilities(probabilities) {
  return Object.fromEntries(['Pursue', 'Review', 'Pass'].map((key) => [key, Number.isFinite(Number(probabilities?.[key])) ? Number(probabilities[key]) : 0]))
}

// Returns { decision: 'pass' } for a confident Pass, { decision: 'continue' }
// for everything else (a low-confidence Pass counts as Review), or
// { decision: 'skipped' } when Jev is not configured or fails, so the caller
// falls back to the full analysis.
export async function runJevGate(evidencePacket, options = {}) {
  const config = getJevConfig(options)
  if (!config.configured) return { decision: 'skipped', reason: 'TYPESAFE_API_KEY is not set' }
  try {
    const response = await askJev({
      apiKey: config.apiKey,
      model: config.model,
      state: jevStateFromPacket(evidencePacket),
      questions: { qualification: { type: 'choice', instructions: JEV_QUALIFICATION_INSTRUCTIONS, criteria: JEV_QUALIFICATION_CRITERIA } },
      signal: AbortSignal.timeout(options.jevTimeoutMs ?? 20_000),
      fetchImpl: options.fetch || fetch,
    })
    const answer = asChoice(response?.answers?.qualification, 'qualification')
    const probabilities = cleanProbabilities(answer.probabilities)
    const result = {
      model: response.model || config.model,
      choice: answer.choice,
      probabilities,
      confidence: finiteNumber(answer.confidence),
      threshold: config.passThreshold,
      usage: response.usage || null,
      checkedAt: new Date().toISOString(),
    }
    if (answer.choice === 'Pass' && probabilities.Pass > config.passThreshold) return { decision: 'pass', ...result }
    return { decision: 'continue', treatedAs: answer.choice === 'Pursue' ? 'Pursue' : 'Review', ...result }
  } catch (error) {
    console.warn(`[jev] gate skipped, running full analysis: ${error.message}`)
    return { decision: 'skipped', reason: `Jev failed: ${error.message}` }
  }
}

// The saved result for a gated lead. It goes through validateMuseAnalysis as
// the existing "no supported opportunity" Pass outcome, so the UI, reports and
// outreach read it like any other completed synthesis.
export function buildJevGatedAnalysis(gate) {
  const percent = (value) => `${Math.round(value * 100)}%`
  const analysis = validateMuseAnalysis({
    summary: `Jev pre-screen rated this lead a clear Pass (${percent(gate.probabilities.Pass)} probability), so the full written AI analysis was skipped. The deterministic audit stands. Regenerate to run the full analysis.`,
    topOpportunities: [],
    strengths: [],
    unknowns: [],
    outreachAngles: [],
    qualificationRecommendation: 'Pass',
    qualificationRationale: `Gated by Jev: ${percent(gate.probabilities.Pass)} Pass, above the ${percent(gate.threshold)} threshold. Little addressable website opportunity or unreliable evidence.`,
    noSupportedOpportunity: true,
  })
  const { decision, ...jevGate } = gate
  return {
    ...analysis,
    gatedBy: 'jev',
    jevGate: { decision, ...jevGate },
    generation: {
      source: 'jev',
      provider: 'typesafe',
      providerLabel: 'TypeSafe Jev',
      model: gate.model,
      responseId: null,
      generatedAt: new Date().toISOString(),
      evidenceVersion: 1,
    },
  }
}

export async function generateMuseAnalysis(lead, options = {}) {
  if (lead.opportunityScore == null) throw new Error('A completed deterministic website audit is required before AI synthesis')
  const config = getOutreachConfig(options)
  if (!config.configured) throw new Error('AI is not configured')
  const observations = buildObservations(lead)
  const evidencePacket = { ...buildMuseEvidencePacket(lead, options), observations }
  const gate = await runJevGate(evidencePacket, options)
  if (gate.decision === 'pass') return buildJevGatedAnalysis(gate)
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 2 })
  const developerPrompt = `You are the evidence-synthesis layer for a website opportunity research tool. Analyze only the supplied evidence packet.

Grounding rules:
- Never invent traffic, conversion rates, revenue, customer behavior, decision-maker names, hosting costs, or measurements.
- Treat deterministic scores as immutable inputs. Do not recalculate or replace them.
- Every opportunity must reference the packet observation IDs it is built from in evidenceIds. Never cite an ID that is not listed.
- When the evidence supports no addressable opportunity, return empty topOpportunities and outreachAngles with noSupportedOpportunity true. Never invent an opportunity to fill the list.
- Separate observed evidence from reasonable business implications. Phrase implications as possibilities, not measured outcomes.
- Put missing evidence in unknowns instead of guessing.
- Prefer specific measured facts and page observations over generic web-design advice.
- Qualification is advisory for a human reviewer. "Pursue" means the evidence shows clear, addressable website opportunities; "Review" means mixed or incomplete evidence; "Pass" means little addressable opportunity or unreliable evidence.
- Outreach angles must be concise, factual, and suitable for later email generation. Do not claim the business is losing customers.`
  const userPrompt = `Synthesize this saved website research into a prioritized, practical assessment. Return up to 5 opportunities when the evidence supports them, ordered by likely importance; return none with noSupportedOpportunity true when it does not. Each evidence field must cite an exact fact from the packet observations listed by ID.\n\n${JSON.stringify(evidencePacket, null, 2)}`
  const response = config.provider === 'meta'
    ? await client.chat.completions.create({
      model: config.model,
      max_completion_tokens: 3500,
      reasoning_effort: process.env.META_REASONING_EFFORT || 'minimal',
      messages: [{ role: 'system', content: developerPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'scoutline_muse_analysis', strict: true, schema: museAnalysisSchema } },
    })
    : await client.responses.create({
      model: config.model,
      max_output_tokens: 2600,
      input: [{ role: 'developer', content: developerPrompt }, { role: 'user', content: userPrompt }],
      text: { format: { type: 'json_schema', name: 'scoutline_muse_analysis', strict: true, schema: museAnalysisSchema } },
    })
  const responseText = extractResponseText(response)
  if (!responseText) throw new Error('AI returned no analysis text; previous analysis is unchanged — retry synthesis or edit manually')
  let parsed
  try {
    parsed = JSON.parse(responseText)
  } catch {
    throw new Error('AI returned malformed analysis JSON; previous analysis is unchanged — retry synthesis or edit manually')
  }
  const analysis = validateMuseAnalysis(parsed, { observations })
  return {
    ...analysis,
    ...(gate.decision === 'continue' ? { jevGate: gate } : {}),
    generation: {
      source: config.provider,
      provider: config.provider,
      providerLabel: config.providerLabel,
      model: config.model,
      responseId: response.id || null,
      generatedAt: new Date().toISOString(),
      evidenceVersion: 1,
    },
  }
}
