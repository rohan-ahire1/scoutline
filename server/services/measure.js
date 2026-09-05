export const MEASURE_SOURCES = {
  LIGHTHOUSE: 'lighthouse',
  HTML_HEURISTIC: 'html_heuristic',
  PROVIDER: 'provider',
  LEGACY: 'legacy',
}

export const DIGITAL_MATURITY_VERSION = 2

// One nullable finite-number parser for every metric consumer.
// null, undefined, empty and whitespace-only strings stay unknown.
// A real numeric zero (0 or '0') stays a measured zero.
export function parseFiniteNumber(value) {
  if (value == null) return null
  if (typeof value === 'string') {
    if (!value.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return null
}

// Provenance record for one measured-or-unmeasured metric.
// source: 'lighthouse' | 'html_heuristic' | 'provider' | 'legacy' | null
// status: 'measured' | 'estimated' | 'unmeasured' | 'legacy'
export function scoreProvenance({ value = null, source = null, status = null, observedAt = null, auditId = null, version = null } = {}) {
  const parsed = parseFiniteNumber(value)
  if (parsed == null) return { value: null, source: source || null, status: 'unmeasured', observedAt: observedAt || null, auditId: auditId || null, version: version ?? null }
  const resolvedSource = source || MEASURE_SOURCES.LEGACY
  const resolvedStatus = status || (resolvedSource === MEASURE_SOURCES.LIGHTHOUSE || resolvedSource === MEASURE_SOURCES.PROVIDER ? 'measured' : resolvedSource === MEASURE_SOURCES.HTML_HEURISTIC ? 'estimated' : 'legacy')
  return { value: parsed, source: resolvedSource, status: resolvedStatus, observedAt: observedAt || null, auditId: auditId || null, version: version ?? null }
}

function sourceLabel(source) {
  if (source === MEASURE_SOURCES.LIGHTHOUSE) return 'Lighthouse'
  if (source === MEASURE_SOURCES.HTML_HEURISTIC) return 'HTML estimate'
  if (source === MEASURE_SOURCES.PROVIDER) return 'Provider'
  if (source === MEASURE_SOURCES.LEGACY) return 'Legacy value (unknown source)'
  return null
}

// Human-readable score fragment, e.g. 'Lighthouse 82/100',
// 'HTML estimate 90/100 (not a Lighthouse measurement)', 'Not measured'.
export function formatProvenanceScore(entry, { unit = '/100' } = {}) {
  const record = entry && typeof entry === 'object' && 'value' in entry ? entry : scoreProvenance({ value: entry })
  if (record.value == null) return 'Not measured'
  if (record.source === MEASURE_SOURCES.HTML_HEURISTIC) return `HTML estimate ${record.value}${unit} (not a Lighthouse measurement)`
  if (record.source === MEASURE_SOURCES.LEGACY || record.status === 'legacy') return `Legacy value ${record.value}${unit} (unknown source)`
  if (record.source === MEASURE_SOURCES.PROVIDER) return `Provider-reported ${record.value}${unit}`
  return `Lighthouse ${record.value}${unit}`
}

// Legacy fallback: a bare stored number with no provenance record must never
// be presented as a fresh Lighthouse measurement.
export function legacyProvenance(value, { observedAt = null } = {}) {
  const parsed = parseFiniteNumber(value)
  if (parsed == null) return scoreProvenance({ observedAt })
  return scoreProvenance({ value: parsed, source: MEASURE_SOURCES.LEGACY, status: 'legacy', observedAt })
}

// Resolve provenance for a nested raw value (e.g. lighthouse bestPractices):
// prefer an explicit record, otherwise treat a stored bare value as legacy.
export function resolveNestedProvenance(recorded, rawValue, { observedAt = null } = {}) {
  if (recorded && typeof recorded === 'object' && 'value' in recorded) {
    const resolved = scoreProvenance({ ...recorded })
    return { ...resolved, observedAt: resolved.observedAt || observedAt }
  }
  return legacyProvenance(rawValue, { observedAt })
}

// Resolve the display provenance for a lead metric: prefer an explicit
// provenance record, otherwise treat a stored bare value as legacy.
export function resolveMetricProvenance(lead, key) {
  const recorded = lead?.measureProvenance?.[key]
  if (recorded && typeof recorded === 'object' && 'value' in recorded) {
    return scoreProvenance({ ...recorded })
  }
  return legacyProvenance(lead?.[key])
}

export function provenanceSourceLabel(source) {
  return sourceLabel(source)
}
