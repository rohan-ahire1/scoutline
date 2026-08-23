import OpenAI from 'openai'
import { extractResponseText, getOutreachConfig } from './outreach.js'

const opportunitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'severity', 'evidence', 'whyItMatters', 'recommendation'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 100 },
    severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    evidence: { type: 'string', minLength: 3, maxLength: 400 },
    whyItMatters: { type: 'string', minLength: 3, maxLength: 500 },
    recommendation: { type: 'string', minLength: 3, maxLength: 500 },
  },
}

export const museAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'topOpportunities', 'strengths', 'unknowns', 'qualificationRecommendation', 'qualificationRationale', 'outreachAngles'],
  properties: {
    summary: { type: 'string', minLength: 10, maxLength: 800 },
    topOpportunities: { type: 'array', minItems: 1, maxItems: 5, items: opportunitySchema },
    strengths: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 3, maxLength: 300 } },
    unknowns: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 3, maxLength: 300 } },
    qualificationRecommendation: { type: 'string', enum: ['Pursue', 'Review', 'Pass'] },
    qualificationRationale: { type: 'string', minLength: 3, maxLength: 500 },
    outreachAngles: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 3, maxLength: 300 } },
  },
}

function compactText(value, limit = 400) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

function finiteNumber(value) {
  if (value == null || value === '') return null
  return Number.isFinite(Number(value)) ? Number(value) : null
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
        performance: finiteNumber(lead.performance),
        accessibility: finiteNumber(lead.accessibility),
        bestPractices: finiteNumber(lighthouse?.scores?.bestPractices),
        seo: finiteNumber(lead.seo),
      },
      timings: lighthouse?.metrics || null,
      pageCount: finiteNumber(lead.pageCount),
      sitemapPageCount: finiteNumber(lead.sitemapPageCount),
      linksChecked: finiteNumber(lead.checkedLinks),
      brokenLinks: finiteNumber(lead.brokenLinks),
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
      url: compactText(item.url, 300), status: finiteNumber(item.status), error: compactText(item.error, 200) || null,
    })),
    crawlWarnings: (lead.crawlErrors || []).slice(0, 10).map((item) => ({
      url: compactText(item.url, 300), code: item.code || null, error: compactText(item.error, 200),
    })),
    lighthouseFailures: extractLighthouseEvidence(options.lighthouseReport),
  }
}

export function validateMuseAnalysis(result) {
  if (!result || typeof result !== 'object') throw new Error('Muse returned an invalid analysis payload')
  if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('Muse did not return a summary')
  if (!Array.isArray(result.topOpportunities) || !result.topOpportunities.length) throw new Error('Muse did not return any opportunities')
  if (!['Pursue', 'Review', 'Pass'].includes(result.qualificationRecommendation)) throw new Error('Muse returned an invalid qualification recommendation')
  const topOpportunities = result.topOpportunities.slice(0, 5).map((item) => {
    if (!item || !['High', 'Medium', 'Low'].includes(item.severity)) throw new Error('Muse returned an invalid opportunity severity')
    for (const field of ['title', 'evidence', 'whyItMatters', 'recommendation']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) throw new Error(`Muse returned an opportunity without ${field}`)
    }
    return Object.fromEntries(['title', 'severity', 'evidence', 'whyItMatters', 'recommendation'].map((field) => [field, item[field].trim()]))
  })
  const cleanList = (value, limit) => (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item.trim()).slice(0, limit).map((item) => item.trim())
  const outreachAngles = cleanList(result.outreachAngles, 4)
  if (!outreachAngles.length) throw new Error('Muse did not return an outreach angle')
  return {
    summary: result.summary.trim(),
    topOpportunities,
    strengths: cleanList(result.strengths, 5),
    unknowns: cleanList(result.unknowns, 5),
    qualificationRecommendation: result.qualificationRecommendation,
    qualificationRationale: compactText(result.qualificationRationale, 500),
    outreachAngles,
  }
}

export async function generateMuseAnalysis(lead, options = {}) {
  if (lead.opportunityScore == null) throw new Error('A completed deterministic website audit is required before Muse synthesis')
  const config = getOutreachConfig(options)
  if (!config.configured) throw new Error('Muse is not configured')
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 2 })
  const evidencePacket = buildMuseEvidencePacket(lead, options)
  const developerPrompt = `You are the evidence-synthesis layer for a website opportunity research tool. Analyze only the supplied evidence packet.

Grounding rules:
- Never invent traffic, conversion rates, revenue, customer behavior, decision-maker names, hosting costs, or measurements.
- Treat deterministic scores as immutable inputs. Do not recalculate or replace them.
- Separate observed evidence from reasonable business implications. Phrase implications as possibilities, not measured outcomes.
- Put missing evidence in unknowns instead of guessing.
- Prefer specific measured facts and page observations over generic web-design advice.
- Qualification is advisory for a human reviewer. "Pursue" means the evidence shows clear, addressable website opportunities; "Review" means mixed or incomplete evidence; "Pass" means little addressable opportunity or unreliable evidence.
- Outreach angles must be concise, factual, and suitable for later email generation. Do not claim the business is losing customers.`
  const userPrompt = `Synthesize this saved website research into a prioritized, practical assessment. Return 3-5 opportunities when the evidence supports them, ordered by likely importance. Each evidence field must cite an exact fact from the packet.\n\n${JSON.stringify(evidencePacket, null, 2)}`
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
  if (!responseText) throw new Error('Muse returned no analysis text')
  const analysis = validateMuseAnalysis(JSON.parse(responseText))
  return {
    ...analysis,
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
