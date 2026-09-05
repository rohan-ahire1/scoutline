// ROH-15: single nullable finite-number parser + per-metric measurement provenance.
//
// parseMetricNumber: null, undefined, empty and whitespace-only strings remain
// unknown (null). Real numeric zero remains zero. Booleans, objects, arrays,
// NaN and non-finite numbers are unknown, never measured 0.

export const METRIC_SOURCES = Object.freeze({
  LIGHTHOUSE: 'lighthouse',
  HTML_HEURISTIC: 'html_heuristic',
  PROVIDER: 'provider',
  LEGACY: 'legacy',
})

export const METRIC_STATUS = Object.freeze({
  MEASURED: 'measured',
  ESTIMATED: 'estimated',
  UNMEASURED: 'unmeasured',
  LEGACY: 'legacy',
})

export function parseMetricNumber(value) {
  if (value == null) return null
  if (typeof value === 'boolean') return null
  if (typeof value === 'string') {
    if (value.trim() === '') return null
  } else if (typeof value !== 'number') {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

// A metric that already carries provenance ({ value, ... }) unwraps to its
// value; anything else goes through the nullable parser.
export function metricValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return parseMetricNumber(value.value)
  return parseMetricNumber(value)
}

export function makeMetricProvenance({
  value = null,
  source = null,
  status = METRIC_STATUS.UNMEASURED,
  observedAt = null,
  auditId = null,
  version = null,
} = {}) {
  const parsed = parseMetricNumber(value)
  return {
    value: parsed,
    source: parsed == null ? null : source || null,
    status: parsed == null ? METRIC_STATUS.UNMEASURED : status,
    observedAt: observedAt || null,
    auditId: auditId || null,
    version: version || null,
  }
}

// Build provenance for an audit score where legacy records may carry only a
// bare number with no recorded origin. Bare values are NEVER retroactively
// attributed to Lighthouse (or any other source); they are labelled legacy.
export function provenanceForScore({ value, source, status, observedAt = null, auditId = null, version = null, hasProvenance = false }) {
  const parsed = parseMetricNumber(value)
  if (parsed == null) {
    return makeMetricProvenance({ value: null, observedAt, auditId, version })
  }
  if (!hasProvenance) {
    return { value: parsed, source: METRIC_SOURCES.LEGACY, status: METRIC_STATUS.LEGACY, observedAt, auditId, version }
  }
  return makeMetricProvenance({ value: parsed, source, status, observedAt, auditId, version })
}

// Human-safe one-line label for a provenance entry. Never presents heuristic
// or legacy values as Lighthouse results.
export function metricLabel(provenance, unit = '/100') {
  if (!provenance || parseMetricNumber(provenance.value) == null) return 'Not measured'
  if (provenance.status === METRIC_STATUS.MEASURED && provenance.source === METRIC_SOURCES.LIGHTHOUSE) {
    return `Lighthouse ${provenance.value}${unit}`
  }
  if (provenance.status === METRIC_STATUS.ESTIMATED || provenance.source === METRIC_SOURCES.HTML_HEURISTIC) {
    return `HTML estimate ${provenance.value}${unit} (not a Lighthouse measurement)`
  }
  if (provenance.status === METRIC_STATUS.LEGACY || provenance.source === METRIC_SOURCES.LEGACY) {
    return `${provenance.value}${unit} (legacy record, unknown source)`
  }
  if (provenance.source === METRIC_SOURCES.PROVIDER) {
    return `Provider-reported ${provenance.value}${unit}`
  }
  return `${provenance.value}${unit} (source: ${provenance.source || 'unknown'})`
}

// Derive per-metric provenance for the audit scores on a lead. Prefers the
// persisted lead.auditMetrics provenance map; falls back to legacy labelling
// for bare values so old records load and export without fabricated sources.
export function auditMetricsForLead(lead = {}) {
  const stored = lead.auditMetrics && typeof lead.auditMetrics === 'object' ? lead.auditMetrics : {}
  const observedAt = lead.auditedAt || null
  const build = (key, origin) => {
    const entry = stored[key]
    if (entry != null && typeof entry === 'object' && ('source' in entry || 'status' in entry)) {
      return makeMetricProvenance({
        value: entry.value, source: entry.source, status: entry.status,
        observedAt: entry.observedAt || observedAt, auditId: entry.auditId, version: entry.version,
      })
    }
    const fallback = key === 'bestPractices'
      ? (lead.lighthouse?.scores?.bestPractices ?? lead.auditComponents?.lighthouse?.scores?.bestPractices)
      : lead[key]
    const raw = entry !== undefined ? entry : fallback
    // No stored provenance: a bare value is only attributable when the
    // Lighthouse outcome makes its origin unambiguous; otherwise it is legacy.
    if (origin.forceLegacy) return provenanceForScore({ value: raw, observedAt, hasProvenance: false })
    return makeMetricProvenance({ value: raw, source: origin.source, status: origin.status, observedAt })
  }
  const lighthouseStatus = lead.lighthouse?.status || lead.auditComponents?.lighthouse?.status || null
  const lighthouseCompleted = lighthouseStatus === 'Completed'
  // A known failed/skipped Lighthouse run means bare accessibility/seo values
  // can only be the HTML baseline fallback. With no Lighthouse record at all,
  // bare values stay legacy — never retroactively attributed.
  const heuristicOrLegacy = lighthouseStatus == null
    ? { source: METRIC_SOURCES.LEGACY, status: METRIC_STATUS.LEGACY, forceLegacy: true }
    : { source: METRIC_SOURCES.HTML_HEURISTIC, status: METRIC_STATUS.ESTIMATED }
  // Performance/best-practices have no HTML fallback: a bare value without a
  // completed Lighthouse run is stale, so it stays legacy; a missing value is
  // unmeasured.
  const measuredOrLegacy = lighthouseCompleted
    ? { source: METRIC_SOURCES.LIGHTHOUSE, status: METRIC_STATUS.MEASURED }
    : { forceLegacy: true }
  return {
    performance: build('performance', measuredOrLegacy),
    accessibility: build('accessibility', lighthouseCompleted
      ? { source: METRIC_SOURCES.LIGHTHOUSE, status: METRIC_STATUS.MEASURED }
      : heuristicOrLegacy),
    seo: build('seo', lighthouseCompleted
      ? { source: METRIC_SOURCES.LIGHTHOUSE, status: METRIC_STATUS.MEASURED }
      : heuristicOrLegacy),
    bestPractices: build('bestPractices', measuredOrLegacy),
  }
}
