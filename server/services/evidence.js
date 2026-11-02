import { createHash } from 'node:crypto'

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'being', 'but', 'can', 'could', 'does', 'for', 'from', 'have', 'into', 'its', 'may', 'more', 'not', 'only', 'our', 'should', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'too', 'use', 'using', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'you', 'your',
])

function compactText(value, limit = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

function hash(value, size = 12) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, size)
}

function instructionLike(text) {
  return /\b(ignore (?:all |the )?(?:previous|prior)|system prompt|developer message|instructions? (?:above|below|to)|invent|fabricate|pretend|claim that|make up)\b/i.test(String(text || ''))
}

function normalizedTokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .match(/[a-z0-9][a-z0-9-]{2,}/g)?.filter((token) => !STOP_WORDS.has(token)) || [],
  )
}

function hasMeaningfulOverlap(claim, observations) {
  const claimTokens = normalizedTokens(claim)
  if (!claimTokens.size) return true
  const evidenceTokens = new Set(observations.flatMap((observation) => [...normalizedTokens(observation.text)]))
  return [...claimTokens].some((token) => evidenceTokens.has(token))
}

function explicitNumbers(value) {
  return String(value || '').match(/(?:[$£€₹]\s*)?\d+(?:[.,]\d+)*(?:\s*%|\s*(?:ms|s|sec|seconds|kb|mb|gb|kib|mib))?/gi) || []
}

function unsupportedOutcomeClaim(value) {
  return /\b(guarantee(?:d|s)?|will (?:increase|boost|grow|double|generate|drive|improve|raise)|definitely (?:increase|boost|improve)|losing customers|costing (?:you|the business)|revenue loss)\b/i.test(String(value || ''))
}

function businessMetricTerms(value) {
  return String(value || '').toLowerCase().match(/\b(revenue|profit|conversion rate|conversions|traffic|sales|lead volume|lead count)\b/g) || []
}

export function getAuditEvidenceVersion(lead = {}) {
  const identity = compactText(lead.id || lead.website || lead.company || 'unknown-lead', 240)
  const auditMarker = compactText(
    lead.auditEvidenceVersion || lead.auditVersion || lead.auditedAt || lead.auditCompletedAt || lead.analysisSource || 'legacy-audit',
    240,
  )
  return `audit-${hash(`${identity}|${auditMarker}`, 16)}`
}

export function buildEvidenceCatalog(lead = {}, options = {}) {
  const auditVersion = getAuditEvidenceVersion(lead)
  const observations = []
  const seen = new Set()

  const add = (text, { kind = 'observation', source = 'saved-research', actionable = false, trust = 'observed' } = {}) => {
    const clean = compactText(text)
    if (!clean) return null
    const duplicateKey = `${kind}|${clean.toLowerCase()}`
    if (seen.has(duplicateKey)) return null
    seen.add(duplicateKey)
    const observation = {
      id: `obs-${hash(`${auditVersion}|${kind}|${source}|${clean}`)}`,
      auditVersion,
      kind,
      source,
      text: clean,
      actionable: Boolean(actionable),
      trust,
      instructionLike: instructionLike(clean),
    }
    observations.push(observation)
    return observation
  }

  ;(lead.problems || []).slice(0, 12).forEach((item) => add(item, { kind: 'finding', source: 'deterministic-assessment', actionable: true }))
  if (!(lead.problems || []).length && lead.issueDetail) add(lead.issueDetail, { kind: 'finding', source: 'deterministic-assessment', actionable: true })
  ;(lead.evidence || []).slice(0, 24).forEach((item) => add(item, { kind: 'evidence', source: 'deterministic-assessment' }))

  const measured = [
    ['performance', lead.performance, 'Lighthouse mobile performance'],
    ['accessibility', lead.accessibility, 'Lighthouse accessibility'],
    ['seo', lead.seo, 'Lighthouse SEO'],
  ]
  measured.forEach(([key, value, label]) => {
    if (value != null && Number.isFinite(Number(value))) add(`${label}: ${Number(value)}/100`, { kind: 'measurement', source: `lighthouse-${key}`, trust: 'measured' })
  })
  if (lead.pageCount != null && Number.isFinite(Number(lead.pageCount))) add(`Same-site pages crawled: ${Number(lead.pageCount)}`, { kind: 'measurement', source: 'crawler', trust: 'measured' })
  if (lead.checkedLinks != null && Number.isFinite(Number(lead.checkedLinks))) add(`Internal links checked: ${Number(lead.checkedLinks)}`, { kind: 'measurement', source: 'link-checker', trust: 'measured' })
  if (lead.brokenLinks != null && Number.isFinite(Number(lead.brokenLinks))) add(`Broken internal links observed: ${Number(lead.brokenLinks)}`, { kind: 'measurement', source: 'link-checker', trust: 'measured' })

  ;(lead.businessIntelligence?.evidence || []).slice(0, 20).forEach((item) => {
    const text = typeof item === 'string' ? item : item?.text || item?.detail || item?.value || JSON.stringify(item)
    add(text, { kind: 'business-evidence', source: 'business-intelligence', trust: 'public-source' })
  })

  ;(options.lighthouseEvidence || []).slice(0, 25).forEach((item) => {
    if (!item) return
    const detail = [item.title, item.displayValue].filter(Boolean).join(' — ')
    add(detail, { kind: 'lighthouse-audit', source: item.id || 'lighthouse', trust: 'measured' })
  })

  return { auditVersion, observations }
}

export function actionableObservations(catalog) {
  return (catalog?.observations || []).filter((item) => item.actionable && !item.instructionLike)
}

export function resolveEvidenceIds(evidenceIds, catalog, label = 'AI output') {
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error(`${label} did not reference any evidence IDs`)
  const byId = new Map((catalog?.observations || []).map((item) => [item.id, item]))
  return evidenceIds.map((id) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error(`${label} returned a malformed evidence ID`)
    const observation = byId.get(id.trim())
    if (!observation) throw new Error(`${label} referenced unknown or stale evidence ID: ${id}`)
    if (observation.auditVersion !== catalog.auditVersion) throw new Error(`${label} referenced evidence from a different audit version: ${id}`)
    return observation
  })
}

export function assertClaimSupported(claim, evidenceIds, catalog, label = 'AI claim') {
  const text = compactText(claim, 10_000)
  if (!text) throw new Error(`${label} was empty`)
  const observations = resolveEvidenceIds(evidenceIds, catalog, label)

  if (unsupportedOutcomeClaim(text)) throw new Error(`${label} made an unsupported guaranteed business-outcome claim`)

  const evidenceText = observations.map((item) => item.text).join(' ').toLowerCase()
  for (const term of businessMetricTerms(text)) {
    if (!evidenceText.includes(term)) throw new Error(`${label} introduced unsupported business metric: ${term}`)
  }

  const evidenceNumbers = explicitNumbers(evidenceText).map((item) => item.replace(/\s+/g, '').toLowerCase())
  for (const number of explicitNumbers(text)) {
    const normalized = number.replace(/\s+/g, '').toLowerCase()
    if (!evidenceNumbers.includes(normalized)) throw new Error(`${label} introduced a number that is not present in its cited evidence: ${number}`)
  }

  if (observations.some((item) => item.instructionLike) && /\b(revenue|profit|traffic|sales|conversion|customers?|leads?)\b/i.test(text)) {
    throw new Error(`${label} attempted to turn instruction-like page text into a business fact`)
  }

  if (!hasMeaningfulOverlap(text, observations)) throw new Error(`${label} is not semantically connected to its cited evidence`)
  return observations
}

export function serializeEvidenceCatalog(catalog) {
  return {
    auditVersion: catalog.auditVersion,
    observations: (catalog.observations || []).map(({ id, auditVersion, kind, source, text, actionable, trust }) => ({ id, auditVersion, kind, source, text, actionable, trust })),
  }
}
