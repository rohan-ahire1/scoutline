import { DIGITAL_MATURITY_VERSION, formatProvenanceScore, parseFiniteNumber, resolveMetricProvenance, resolveNestedProvenance } from './measure.js'

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
  const bestPracticesRaw = lead.lighthouse?.scores?.bestPractices ?? lead.auditComponents?.lighthouse?.scores?.bestPractices
  const observedAt = lead.auditedAt || null
  const performance = { ...resolveMetricProvenance(lead, 'performance'), observedAt: resolveMetricProvenance(lead, 'performance').observedAt || observedAt }
  const accessibility = { ...resolveMetricProvenance(lead, 'accessibility'), observedAt: resolveMetricProvenance(lead, 'accessibility').observedAt || observedAt }
  const seo = { ...resolveMetricProvenance(lead, 'seo'), observedAt: resolveMetricProvenance(lead, 'seo').observedAt || observedAt }
  const bestPractices = resolveNestedProvenance(lead?.measureProvenance?.bestPractices, bestPracticesRaw, { observedAt })
  const components = []
  const add = (label, points, maximum, evidence, status, source) => components.push({ label, points, maximum, evidence, status, source: source || null })
  const addScore = (label, entry, maximum, bands) => {
    if (entry.value == null) {
      add(label, 0, maximum, 'Not measured', 'unmeasured', entry.source)
      return
    }
    let points = bands[bands.length - 1][1]
    for (const [threshold, awarded] of bands) {
      if (entry.value >= threshold) { points = awarded; break }
    }
    add(label, points, maximum, formatProvenanceScore(entry), entry.status, entry.source)
  }
  addScore('Mobile performance', performance, 20, [[75, 20], [50, 12], [0, 4]])
  addScore('Accessibility', accessibility, 10, [[90, 10], [75, 6], [0, 2]])
  addScore('Search readiness', seo, 12, [[90, 12], [70, 7], [0, 2]])
  addScore('Technical best practices', bestPractices, 8, [[90, 8], [70, 5], [0, 2]])
  const observed = (label, points, maximum, evidence) => add(label, points, maximum, evidence, 'observed', 'provider')
  observed('Structured data', lead.auditSummary?.hasSchema ? 8 : 0, 8, lead.auditSummary?.hasSchema ? 'Detected' : 'Not detected')
  const stack = new Set(lead.stack || [])
  const analyticsPoints = stack.has('GA4') ? 8 : stack.has('Meta Pixel') ? 5 : 0
  observed('Measurement stack', analyticsPoints, 8, analyticsPoints ? [...stack].filter((item) => ['GA4', 'Meta Pixel'].includes(item)).join(', ') : 'No analytics signal detected')
  const onlineAction = Boolean(intelligence.onlineBooking || intelligence.onlineEstimates)
  observed('Online customer action', onlineAction ? 10 : 0, 10, intelligence.onlineBooking ? 'Booking link detected' : intelligence.onlineEstimates ? 'Online estimates offered' : 'No booking or online-estimate signal')
  observed('Business profile ownership', intelligence.claimed === true ? 4 : 0, 4, intelligence.claimed === true ? 'Google profile claimed' : 'Not confirmed')
  observed('Mobile foundation', lead.auditSummary?.viewport ? 6 : 0, 6, lead.auditSummary?.viewport ? 'Responsive viewport detected' : 'Not detected')
  const brokenLinks = parseFiniteNumber(lead.brokenLinks)
  const checkedLinks = parseFiniteNumber(lead.checkedLinks)
  observed('Site maintenance', brokenLinks === 0 ? 4 : brokenLinks == null ? 0 : 2, 4, brokenLinks == null ? 'Links not checked' : `${brokenLinks} broken of ${checkedLinks || 0} checked`)
  // Unmeasured score components are excluded from the normalization maximum so
  // missing evidence is reported as unavailable instead of proven poor.
  const measured = components.filter((item) => item.status !== 'unmeasured')
  const score = measured.reduce((sum, item) => sum + item.points, 0)
  const measuredMaximum = measured.reduce((sum, item) => sum + item.maximum, 0)
  const totalMaximum = components.reduce((sum, item) => sum + item.maximum, 0)
  const normalized = measuredMaximum ? Math.round((score / measuredMaximum) * 100) : 0
  const band = normalized >= 80 ? 'Advanced' : normalized >= 60 ? 'Established' : normalized >= 40 ? 'Developing' : 'Foundational'
  return {
    score: normalized,
    band,
    version: DIGITAL_MATURITY_VERSION,
    formula: `v${DIGITAL_MATURITY_VERSION}: normalized over measured components only; unmeasured components excluded, never scored as poor`,
    coverage: {
      measuredComponents: measured.length,
      totalComponents: components.length,
      measuredMaximum,
      totalMaximum,
      share: totalMaximum ? Math.round((measuredMaximum / totalMaximum) * 100) : 0,
    },
    components,
    calculatedAt: new Date().toISOString(),
  }
}

export function enrichLead(lead, incoming = {}) {
  const businessIntelligence = mergeBusinessIntelligence(lead.businessIntelligence || {}, incoming)
  const next = { ...lead, businessIntelligence }
  return { ...next, businessIntelligence: { ...businessIntelligence, digitalMaturity: calculateDigitalMaturity(next) } }
}
