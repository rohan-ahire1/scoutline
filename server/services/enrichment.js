import { auditMetricsForLead, parseMetricNumber, METRIC_STATUS } from './metrics.js'

export const DIGITAL_MATURITY_VERSION = 2

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => value != null && String(value).trim()).map((value) => String(value).trim()))]
}

function metric(value = null, source = null, confidence = null) {
  return { value: value == null || value === '' ? null : value, source: source || null, confidence: confidence || null }
}

function metricValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value ?? null
}

function mergeMetric(current, incoming) {
  const next = incoming && typeof incoming === 'object' && 'value' in incoming ? incoming : metric(incoming)
  const previous = current && typeof current === 'object' && 'value' in current ? current : metric(current)
  return metricValue(next) != null ? next : previous
}

export function emptyCompanyMetrics() {
  return {
    employeeCount: metric(),
    annualRevenue: metric(),
    annualProfit: metric(),
    foundedYear: metric(),
    branchCount: metric(),
  }
}

export function mergeBusinessIntelligence(current = {}, incoming = {}) {
  const locationMap = new Map()
  for (const location of [...(current.locations || []), ...(incoming.locations || [])]) {
    const key = location?.placeId || String(location?.address || '').trim().toLowerCase()
    if (key) locationMap.set(key, { ...(locationMap.get(key) || {}), ...location })
  }
  const currentMetrics = { ...emptyCompanyMetrics(), ...(current.companyMetrics || {}) }
  const incomingMetrics = incoming.companyMetrics || {}
  const companyMetrics = Object.fromEntries(Object.keys(emptyCompanyMetrics()).map((key) => [key, mergeMetric(currentMetrics[key], incomingMetrics[key])]))
  return {
    ...current,
    ...incoming,
    source: incoming.source || current.source || null,
    fetchedAt: incoming.fetchedAt || current.fetchedAt || null,
    services: uniqueStrings([...(current.services || []), ...(incoming.services || [])]).slice(0, 30),
    categories: uniqueStrings([...(current.categories || []), ...(incoming.categories || [])]).slice(0, 20),
    locations: [...locationMap.values()].slice(0, 50),
    locationsObserved: locationMap.size,
    companyMetrics,
    evidence: uniqueStrings([...(current.evidence || []), ...(incoming.evidence || [])]).slice(0, 30),
  }
}

export function calculateDigitalMaturity(lead) {
  const intelligence = lead.businessIntelligence || {}
  // Provenance-aware values: null/undefined/empty/whitespace stay unknown
  // (never measured 0); a real Lighthouse 0 remains 0.
  const metrics = auditMetricsForLead(lead)
  const components = []
  const add = (label, points, maximum, evidence, status) => components.push({ label, points, maximum, evidence, status })
  const scoreEvidence = (entry, measuredLabel) => {
    if (entry.value == null) return 'Not measured'
    if (entry.status === METRIC_STATUS.MEASURED) return `${measuredLabel} ${entry.value}/100`
    if (entry.status === METRIC_STATUS.ESTIMATED) return `HTML estimate ${entry.value}/100 (not a Lighthouse measurement)`
    if (entry.status === METRIC_STATUS.LEGACY) return `${entry.value}/100 (legacy record, unknown source)`
    return `${entry.value}/100`
  }
  // Unmeasured components contribute 0 points AND 0 maximum: missing evidence
  // is unavailable, never asserted as poor performance.
  const scored = (label, entry, maximum, bands, measuredLabel) => {
    if (entry.value == null) return add(label, 0, maximum, 'Not measured', METRIC_STATUS.UNMEASURED)
    const points = entry.value >= bands[0][0] ? bands[0][1] : entry.value >= bands[1][0] ? bands[1][1] : bands[2][1]
    return add(label, points, maximum, scoreEvidence(entry, measuredLabel), entry.status)
  }
  scored('Mobile performance', metrics.performance, 20, [[75, 20], [50, 12], [0, 4]], 'Lighthouse')
  scored('Accessibility', metrics.accessibility, 10, [[90, 10], [75, 6], [0, 2]], 'Lighthouse')
  scored('Search readiness', metrics.seo, 12, [[90, 12], [70, 7], [0, 2]], 'Lighthouse')
  scored('Technical best practices', metrics.bestPractices, 8, [[90, 8], [70, 5], [0, 2]], 'Lighthouse')
  // Observation components are only evidence when the producing check actually
  // ran. A positive signal is evidence on its own; an absent signal without an
  // audit/BI source is unavailable, never a confirmed negative.
  const audited = lead.auditSummary != null
  const biSourced = Boolean(intelligence.source)
  const unavailable = (label, maximum) => add(label, 0, maximum, 'Not measured', METRIC_STATUS.UNMEASURED)
  if (lead.auditSummary?.hasSchema) add('Structured data', 8, 8, 'Detected', 'observed')
  else if (audited) add('Structured data', 0, 8, 'Not detected', 'observed')
  else unavailable('Structured data', 8)
  const stack = new Set(lead.stack || [])
  const analyticsPoints = stack.has('GA4') ? 8 : stack.has('Meta Pixel') ? 5 : 0
  if (analyticsPoints) add('Measurement stack', analyticsPoints, 8, [...stack].filter((item) => ['GA4', 'Meta Pixel'].includes(item)).join(', '), 'observed')
  else if (audited || stack.size) add('Measurement stack', 0, 8, 'No analytics signal detected', 'observed')
  else unavailable('Measurement stack', 8)
  const onlineAction = Boolean(intelligence.onlineBooking || intelligence.onlineEstimates)
  if (onlineAction) add('Online customer action', 10, 10, intelligence.onlineBooking ? 'Booking link detected' : 'Online estimates offered', 'observed')
  else if (biSourced) add('Online customer action', 0, 10, 'No booking or online-estimate signal', 'observed')
  else unavailable('Online customer action', 10)
  if (intelligence.claimed === true) add('Business profile ownership', 4, 4, 'Google profile claimed', 'observed')
  else if (biSourced) add('Business profile ownership', 0, 4, 'Not confirmed', 'observed')
  else unavailable('Business profile ownership', 4)
  if (lead.auditSummary?.viewport) add('Mobile foundation', 6, 6, 'Responsive viewport detected', 'observed')
  else if (audited) add('Mobile foundation', 0, 6, 'Not detected', 'observed')
  else unavailable('Mobile foundation', 6)
  const brokenLinks = parseMetricNumber(lead.brokenLinks)
  const checkedLinks = parseMetricNumber(lead.checkedLinks) || 0
  if (brokenLinks == null) add('Site maintenance', 0, 4, 'Links not checked', METRIC_STATUS.UNMEASURED)
  else add('Site maintenance', brokenLinks === 0 ? 4 : 2, 4, `${brokenLinks} broken of ${checkedLinks} checked`, 'observed')
  const maximum = components.reduce((sum, item) => sum + item.maximum, 0)
  const coveredMaximum = components.filter((item) => item.status !== METRIC_STATUS.UNMEASURED).reduce((sum, item) => sum + item.maximum, 0)
  const score = components.filter((item) => item.status !== METRIC_STATUS.UNMEASURED).reduce((sum, item) => sum + item.points, 0)
  const coverage = maximum ? Math.round((coveredMaximum / maximum) * 100) / 100 : 0
  if (!coveredMaximum) {
    return { score: null, band: 'Unknown', version: DIGITAL_MATURITY_VERSION, coverage, coveredMaximum, maximum, components, calculatedAt: new Date().toISOString() }
  }
  const normalized = Math.round((score / coveredMaximum) * 100)
  const band = normalized >= 80 ? 'Advanced' : normalized >= 60 ? 'Established' : normalized >= 40 ? 'Developing' : 'Foundational'
  return { score: normalized, band, version: DIGITAL_MATURITY_VERSION, coverage, coveredMaximum, maximum, components, calculatedAt: new Date().toISOString() }
}

export function enrichLead(lead, incoming = {}) {
  const businessIntelligence = mergeBusinessIntelligence(lead.businessIntelligence || {}, incoming)
  const next = { ...lead, businessIntelligence }
  return { ...next, businessIntelligence: { ...businessIntelligence, digitalMaturity: calculateDigitalMaturity(next) } }
}
