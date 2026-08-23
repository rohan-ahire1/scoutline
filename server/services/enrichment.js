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
  const scores = lead.lighthouse?.scores || lead.auditComponents?.lighthouse?.scores || {}
  const components = []
  const add = (label, points, maximum, evidence) => components.push({ label, points, maximum, evidence })
  const performance = Number.isFinite(Number(lead.performance)) ? Number(lead.performance) : null
  const accessibility = Number.isFinite(Number(lead.accessibility)) ? Number(lead.accessibility) : null
  const seo = Number.isFinite(Number(lead.seo)) ? Number(lead.seo) : null
  const bestPractices = Number.isFinite(Number(scores.bestPractices)) ? Number(scores.bestPractices) : null
  add('Mobile performance', performance == null ? 0 : performance >= 75 ? 20 : performance >= 50 ? 12 : 4, 20, performance == null ? 'Not measured' : `Lighthouse ${performance}/100`)
  add('Accessibility', accessibility == null ? 0 : accessibility >= 90 ? 10 : accessibility >= 75 ? 6 : 2, 10, accessibility == null ? 'Not measured' : `Lighthouse ${accessibility}/100`)
  add('Search readiness', seo == null ? 0 : seo >= 90 ? 12 : seo >= 70 ? 7 : 2, 12, seo == null ? 'Not measured' : `Lighthouse ${seo}/100`)
  add('Technical best practices', bestPractices == null ? 0 : bestPractices >= 90 ? 8 : bestPractices >= 70 ? 5 : 2, 8, bestPractices == null ? 'Not measured' : `Lighthouse ${bestPractices}/100`)
  add('Structured data', lead.auditSummary?.hasSchema ? 8 : 0, 8, lead.auditSummary?.hasSchema ? 'Detected' : 'Not detected')
  const stack = new Set(lead.stack || [])
  const analyticsPoints = stack.has('GA4') ? 8 : stack.has('Meta Pixel') ? 5 : 0
  add('Measurement stack', analyticsPoints, 8, analyticsPoints ? [...stack].filter((item) => ['GA4', 'Meta Pixel'].includes(item)).join(', ') : 'No analytics signal detected')
  const onlineAction = Boolean(intelligence.onlineBooking || intelligence.onlineEstimates)
  add('Online customer action', onlineAction ? 10 : 0, 10, intelligence.onlineBooking ? 'Booking link detected' : intelligence.onlineEstimates ? 'Online estimates offered' : 'No booking or online-estimate signal')
  add('Business profile ownership', intelligence.claimed === true ? 4 : 0, 4, intelligence.claimed === true ? 'Google profile claimed' : 'Not confirmed')
  add('Mobile foundation', lead.auditSummary?.viewport ? 6 : 0, 6, lead.auditSummary?.viewport ? 'Responsive viewport detected' : 'Not detected')
  add('Site maintenance', lead.brokenLinks === 0 ? 4 : lead.brokenLinks == null ? 0 : 2, 4, lead.brokenLinks == null ? 'Links not checked' : `${lead.brokenLinks} broken of ${lead.checkedLinks || 0} checked`)
  const score = components.reduce((sum, item) => sum + item.points, 0)
  const maximum = components.reduce((sum, item) => sum + item.maximum, 0)
  const normalized = maximum ? Math.round((score / maximum) * 100) : 0
  const band = normalized >= 80 ? 'Advanced' : normalized >= 60 ? 'Established' : normalized >= 40 ? 'Developing' : 'Foundational'
  return { score: normalized, band, version: 1, components, calculatedAt: new Date().toISOString() }
}

export function enrichLead(lead, incoming = {}) {
  const businessIntelligence = mergeBusinessIntelligence(lead.businessIntelligence || {}, incoming)
  const next = { ...lead, businessIntelligence }
  return { ...next, businessIntelligence: { ...businessIntelligence, digitalMaturity: calculateDigitalMaturity(next) } }
}
