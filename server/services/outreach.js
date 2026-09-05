import OpenAI from 'openai'

export const OUTREACH_VERSIONS = ['Concise', 'Balanced', 'Detailed']

function cleanFinding(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : ''
}

function findingAdvice(finding) {
  const value = String(finding || '').toLowerCase()
  if (/(speed|slow|seconds|lcp|performance|mb|unoptimized|transfer size|hero video)/.test(value)) return {
    why: 'A slow first experience can lose mobile visitors before they reach the offer.',
    change: 'compress heavy media, remove unnecessary scripts, and prioritize above-the-fold content',
  }
  if (/(form|fields|quote request|budget qualifier|enquiry friction)/.test(value)) return {
    why: 'A long first step creates friction for otherwise interested visitors.',
    change: 'replace it with a shorter staged enquiry that asks only what is needed to begin',
  }
  if (/(cta|call to action|next step|below the fold)/.test(value)) return {
    why: 'Visitors can understand the service but still be unsure what to do next.',
    change: 'use one primary action and repeat it where visitors have enough context to respond',
  }
  if (/(gallery|portfolio|project|images|photos|alt)/.test(value)) return {
    why: 'Strong work is less persuasive when visitors cannot connect it to a service or outcome.',
    change: 'add useful project context and a relevant enquiry action beside the visual proof',
  }
  if (/(seo|schema|title|description|service-area|service pages|local search)/.test(value)) return {
    why: 'Thin page structure makes the offer harder for customers and search engines to understand.',
    change: 'clarify titles and service content, add local context, internal links, and structured data',
  }
  if (/(trust|license|warranty|testimonial|review|financing)/.test(value)) return {
    why: 'Important reassurance is missing where a visitor decides whether to enquire.',
    change: 'move relevant proof and buying information closer to the offer and contact action',
  }
  if (/(mobile|header|navigation|viewport)/.test(value)) return {
    why: 'The interface may make important content and actions harder to find on smaller screens.',
    change: 'simplify the mobile hierarchy and keep the primary action easy to reach',
  }
  return {
    why: 'This creates avoidable uncertainty in the customer journey.',
    change: 'clarify the content hierarchy and give visitors one obvious, low-friction next step',
  }
}

export function wordCount(value) { return String(value || '').trim().split(/\s+/).filter(Boolean).length }

// Stable observation IDs scoped to an audit version so AI references can be
// validated against the exact audit that produced them.
export function auditScope(lead) {
  if (lead?.auditVersion != null && String(lead.auditVersion).trim() !== '') return String(lead.auditVersion)
  return 'legacy'
}

export function buildObservations(lead) {
  const scope = auditScope(lead)
  const source = (lead?.problems?.length ? lead.problems : (lead?.issueDetail ? [lead.issueDetail] : []))
  return source
    .map((text) => cleanFinding(text))
    .filter(Boolean)
    .map((text, index) => ({ id: `obs-${scope}-${index + 1}`, auditScope: scope, text }))
}

// Adversarial guard: rendered outreach and AI claims must never invent business
// metrics or promise outcomes. Evidence-ID membership is necessary but not proof
// of semantic correctness, so the text itself is scanned as well.
const INVENTED_CLAIM_PATTERNS = [
  { pattern: /\$\s?\d[\d,]*/, label: 'a monetary amount' },
  { pattern: /\b\d[\d,.]*\s?%\s?(more|increase|growth|uplift|conversion|revenue|traffic|customers|leads|sales)\b/i, label: 'a percentage outcome' },
  { pattern: /\b(revenue|profit|income|roi|turnover)\b[^.\n]{0,40}\$\s?\d/i, label: 'a revenue figure' },
  { pattern: /\b\d[\d,]*\s?(new\s)?(customers|visitors|leads|sales|calls|bookings)\b[^.\n]{0,30}\b(more|extra|additional|guaranteed|per month|a month)\b/i, label: 'a customer/volume outcome' },
  { pattern: /\b(guarantee[sd]?|guaranteed results)\b/i, label: 'a guarantee' },
  { pattern: /\bwill (increase|double|triple|boost|grow|skyrocket)\b[^.\n]{0,40}\b(revenue|traffic|sales|leads|customers|rankings|conversion)\b/i, label: 'a promised business outcome' },
]

export function assertNoInventedClaims(text, where = 'outreach') {
  const value = String(text || '')
  for (const { pattern, label } of INVENTED_CLAIM_PATTERNS) {
    if (pattern.test(value)) throw new Error(`Unverified ${label} in ${where}: claims must cite measured audit evidence, not invented outcomes`)
  }
  return true
}

export function createLocalOutreach(lead) {
  const observations = buildObservations(lead)
  const generation = { source: 'rules', model: null, generatedAt: new Date().toISOString(), auditId: lead.currentAuditId || null, targets: { Concise: 50, Balanced: 110, Detailed: 210 }, observationIds: observations.map((item) => item.id) }
  if (!observations.length) {
    return {
      subject: `Quick idea for ${lead.company}`,
      drafts: null,
      findings: [],
      observations,
      insufficientEvidence: true,
      reason: 'No verified audit findings for this lead, so no outreach claim can be supported. A redesign is not asserted.',
      generation,
    }
  }
  const findings = observations.map((item) => item.text)
  const mainIssue = String(lead.mainIssue || 'a clearer customer journey').toLowerCase()
  const [first, second] = findings
  const reportCount = Math.min(findings.length, 4)
  const detailedFindings = findings.slice(0, reportCount).map((finding, index) => {
    const advice = findingAdvice(finding)
    return `${index + 1}. ${finding}\nWhy it matters: ${advice.why}\nWhat I would change: I would ${advice.change}.`
  }).join('\n\n')
  const countNoun = findings.length === 1 ? 'one opportunity stood out' : `${findings.length} opportunities stood out`
  const drafts = {
    Concise: `Hi — I reviewed ${lead.company}'s website and noticed ${first.toLowerCase()}. I have a straightforward way to improve that and make the next step easier for visitors. If useful, I can send a free homepage redesign so you can judge the direction before deciding anything. Would you like to see it?`,
    Balanced: second
      ? `Hi —\n\nI reviewed ${lead.company}'s website and two opportunities stood out:\n\n• ${first}\n• ${second}\n\nThese issues can make it harder for visitors to understand the offer and take the next step, especially on mobile. I would focus a redesign on ${mainIssue}, one clear primary action, stronger proof near the enquiry point, and a simpler path from interest to contact.\n\nIf useful, I can create a free homepage concept showing how those changes could work together. You can review the direction before deciding whether to move forward. Would you like me to send it?`
      : `Hi —\n\nI reviewed ${lead.company}'s website and ${countNoun}:\n\n• ${first}\n\nThis can make it harder for visitors to understand the offer and take the next step. I would focus a redesign on ${mainIssue} and a simpler path from interest to contact.\n\nIf useful, I can create a free homepage concept showing how that change could work. You can review the direction before deciding whether to move forward. Would you like me to send it?`,
    Detailed: `Hi —\n\nI reviewed ${lead.company}'s website and prepared a short report on the clearest opportunities:\n\n${detailedFindings}\n\nRecommended direction\nI would build the redesign around ${mainIssue}, a clearer content hierarchy, stronger proof beside the key decision points, and a simpler route from the first visit to an enquiry. The goal would be to preserve the useful business information already present while removing friction and making the offer easier to understand on mobile and desktop.\n\nIf useful, I can turn these findings into a free homepage concept. You can review the proposed structure, message, and visual direction before deciding whether any paid work makes sense. Would you like me to send it over?`,
  }
  for (const [version, text] of Object.entries(drafts)) assertNoInventedClaims(text, `local ${version} draft`)
  return {
    subject: `Quick idea for ${lead.company}`,
    drafts,
    findings,
    observations,
    insufficientEvidence: false,
    generation,
  }
}

// A regenerated draft must never silently destroy human edits. New output is a
// candidate; the current selection only changes explicitly.
export function applyOutreachGeneration(lead, generated, { selectedVersion = null } = {}) {
  const candidate = {
    subject: generated.subject,
    drafts: generated.drafts,
    findings: generated.findings || [],
    observationIds: generated.observationIds || generated.generation?.observationIds || [],
    insufficientEvidence: Boolean(generated.insufficientEvidence),
    reason: generated.reason || null,
    generation: generated.generation,
    createdAt: new Date().toISOString(),
  }
  const candidates = [candidate, ...((lead || {}).outreachCandidates || [])].slice(0, 5)
  if (generated.insufficientEvidence) {
    return {
      outreachCandidates: candidates,
      outreachUpdateAvailable: true,
      outreachStatus: (lead || {}).outreachDraft || Object.keys((lead || {}).outreachDrafts || {}).length ? (lead || {}).outreachStatus || 'Draft' : 'Insufficient evidence',
    }
  }
  const edited = Boolean((lead || {}).outreachEdited) && Boolean((lead || {}).outreachDraft)
  if (edited) {
    return { outreachCandidates: candidates, outreachUpdateAvailable: true }
  }
  const version = ['Concise', 'Balanced', 'Detailed'].includes(selectedVersion) ? selectedVersion : 'Concise'
  return {
    outreachSubject: generated.subject,
    outreachDrafts: generated.drafts,
    outreachVersion: version,
    outreachDraft: generated.drafts[version],
    outreachGeneration: generated.generation,
    outreachCandidates: candidates,
    outreachUpdateAvailable: false,
    outreachEdited: false,
    outreachStatus: (lead || {}).outreachStatus || 'Draft',
  }
}

export function acceptOutreachCandidate(lead, index = 0) {
  const candidates = [...((lead || {}).outreachCandidates || [])]
  const candidate = candidates[index]
  if (!candidate || !candidate.drafts) throw new Error('No generated outreach candidate at that position')
  candidates.splice(index, 1)
  const version = ['Concise', 'Balanced', 'Detailed'].includes(lead?.outreachVersion) ? lead.outreachVersion : 'Concise'
  return {
    outreachSubject: candidate.subject,
    outreachDrafts: candidate.drafts,
    outreachVersion: version,
    outreachDraft: candidate.drafts[version],
    outreachGeneration: candidate.generation,
    outreachCandidates: candidates,
    outreachUpdateAvailable: candidates.length > 0,
    outreachEdited: false,
    outreachStatus: (lead || {}).outreachStatus && (lead || {}).outreachStatus !== 'Insufficient evidence' ? (lead || {}).outreachStatus : 'Draft',
  }
}

export function dismissOutreachCandidates(lead) {
  return { outreachCandidates: [], outreachUpdateAvailable: false }
}

const outreachSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'drafts'],
  properties: {
    subject: { type: 'string', minLength: 3, maxLength: 100 },
    drafts: {
      type: 'object',
      additionalProperties: false,
      required: OUTREACH_VERSIONS,
      properties: Object.fromEntries(OUTREACH_VERSIONS.map((version) => [version, { type: 'string', minLength: 40 }])),
    },
  },
}

export function validateGeneratedOutreach(result) {
  if (!result || typeof result !== 'object') throw new Error('The model returned an invalid outreach payload (expected a JSON object)')
  if (typeof result.subject !== 'string' || !result.subject.trim()) throw new Error('The model returned no outreach subject')
  if (!result.drafts || typeof result.drafts !== 'object') throw new Error('The model returned no outreach drafts')
  OUTREACH_VERSIONS.forEach((version) => {
    if (typeof result.drafts[version] !== 'string' || !result.drafts[version].trim()) throw new Error(`The model did not return a ${version.toLowerCase()} draft`)
  })
  const drafts = Object.fromEntries(OUTREACH_VERSIONS.map((version) => [version, result.drafts[version].trim()]))
  for (const [version, text] of Object.entries(drafts)) assertNoInventedClaims(text, `AI ${version} draft`)
  return { subject: result.subject.trim(), drafts }
}

function validateGenerated(result) {
  return validateGeneratedOutreach(result)
}

export function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text
  const nestedText = (response?.output || [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((content) => content?.text || content?.output_text)
    .find((text) => typeof text === 'string' && text.trim())
  if (nestedText) return nestedText
  const chatText = response?.choices?.[0]?.message?.content
  return typeof chatText === 'string' && chatText.trim() ? chatText : null
}

export function getOutreachConfig(options = {}) {
  const metaKey = options.metaApiKey || process.env.MODEL_API_KEY || process.env.META_MODEL_API_KEY
  if (metaKey) return {
    configured: true,
    provider: 'meta',
    providerLabel: 'Meta Model API',
    apiKey: metaKey,
    baseURL: options.baseURL || process.env.META_MODEL_API_BASE_URL || 'https://api.meta.ai/v1',
    model: options.model || process.env.META_MODEL || 'muse-spark-1.2-contributor',
  }

  const openAIKey = options.apiKey || process.env.OPENAI_API_KEY
  if (openAIKey) return {
    configured: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    apiKey: openAIKey,
    baseURL: undefined,
    model: options.model || process.env.OPENAI_MODEL || 'gpt-5.4-nano',
  }

  return {
    configured: false,
    provider: 'rules',
    providerLabel: 'Evidence templates',
    apiKey: null,
    baseURL: null,
    model: null,
  }
}

export async function generateOutreach(lead, options = {}) {
  const config = getOutreachConfig(options)
  if (!config.configured || options.forceRules) return createLocalOutreach(lead)
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 45_000, maxRetries: 2 })
  const research = {
    company: lead.company,
    category: lead.category,
    location: lead.location,
    mainIssue: lead.mainIssue,
    issueDetail: lead.issueDetail,
    findings: (lead.problems || []).slice(0, 6),
    evidence: (lead.evidence || []).slice(0, 10),
  }
  const developerPrompt = 'Write evidence-based first-contact sales emails for a small web design service. Never invent facts, metrics, people, revenue, or technical details. Keep the tone direct, calm, helpful, and low-pressure. Offer a free homepage concept and require a manual human review before sending.'
  const userPrompt = `Create three meaningfully different outreach versions from this saved research:\n${JSON.stringify(research, null, 2)}\n\nLength guidance—natural phrasing and clarity matter more than an exact count:\nConcise: aim for about 50 words, using only the one or two most important findings.\nBalanced: aim for about 110 words, using two or three findings with a compact proposed direction.\nDetailed: aim for about 210 words, formatted as a small report. Cover three findings and, for each, explain why it matters and what should change.\nAll versions must end with one simple question. Do not mention an AI, crawler, score, or audit software.`
  const requestModel = (prompt) => config.provider === 'meta'
    ? client.chat.completions.create({
      model: config.model,
      max_completion_tokens: 3000,
      reasoning_effort: process.env.META_REASONING_EFFORT || 'minimal',
      messages: [
        { role: 'system', content: developerPrompt },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'scoutline_outreach', strict: true, schema: outreachSchema } },
    })
    : client.responses.create({
      model: config.model,
      max_output_tokens: 1800,
      input: [
        { role: 'developer', content: developerPrompt },
        { role: 'user', content: prompt },
      ],
      text: { format: { type: 'json_schema', name: 'scoutline_outreach', strict: true, schema: outreachSchema } },
    })

  const observations = buildObservations(lead)
  const response = await requestModel(userPrompt)
  const responseText = extractResponseText(response)
  if (!responseText) throw new Error('The model returned no outreach text')
  let parsed
  try {
    parsed = JSON.parse(responseText)
  } catch {
    throw new Error('The model returned malformed outreach JSON; previous drafts are unchanged — retry generation or edit manually')
  }
  const generated = validateGenerated(parsed)
  return {
    ...generated,
    findings: observations.map((item) => item.text),
    observations,
    insufficientEvidence: false,
    generation: {
      source: config.provider,
      provider: config.provider,
      providerLabel: config.providerLabel,
      model: config.model,
      responseId: response.id,
      generatedAt: new Date().toISOString(),
      auditId: lead.currentAuditId || null,
      targets: { Concise: 50, Balanced: 110, Detailed: 210 },
      observationIds: observations.map((item) => item.id),
      wordCounts: Object.fromEntries(OUTREACH_VERSIONS.map((version) => [version, wordCount(generated.drafts[version])])),
    },
  }
}
