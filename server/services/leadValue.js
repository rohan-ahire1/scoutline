// Commercial lead-value scoring (ROH-6). A pure, versioned, evidence-only
// scorer that is deliberately separate from the deterministic website
// opportunityScore (audit quality) — this answers "which business is worth
// sales effort", not "how broken is the website".
//
// Design rules (from the ticket):
// - Every contribution cites saved evidence. Unknown inputs stay unknown:
//   they lower coverage, never fabricate points.
// - Initial weights are hypotheses, not a sales forecast. Nothing here
//   predicts budget, intent or revenue; "business fit" is a heuristic fit
//   label, never purchase likelihood.
// - Growth is never inferred from a single review snapshot; timing needs
//   dated, source-backed events.
// - Thinly observed businesses can never be labelled confidently poor:
//   the Low Priority band requires minimum coverage.
// - Changing weights creates a new version; stored scores keep the version
//   and weights they were computed with, so old scores stay interpretable.

export const LEAD_VALUE_VERSION = '1'

export const DEFAULT_LEAD_VALUE_WEIGHTS = {
  need: 0.35,
  businessFit: 0.3,
  reachability: 0.2,
  timing: 0.15,
}

// Static category-ticket hypothesis: high-ticket trades get more fit points.
// Documented default rubric — retune only against held-out outcome data.
const CATEGORY_TICKET_POINTS = {
  roofing: 10, hvac: 10, plumbing: 10, solar: 10, electrical: 10,
  remodeling: 8, flooring: 6, painting: 5, landscaping: 5, cleaning: 4,
}

const MIN_COVERAGE_FOR_LOW_PRIORITY = 0.5
const MIN_COVERAGE_FOR_TOP_PROSPECT = 0.6

function shortHash(value) {
  const text = JSON.stringify(value)
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash * 31 + text.charCodeAt(i)) | 0)
  return Math.abs(hash).toString(36).slice(0, 6).padStart(4, '0')
}

export function resolveLeadValueWeights(custom) {
  const merged = { ...DEFAULT_LEAD_VALUE_WEIGHTS, ...(custom && typeof custom === 'object' ? custom : {}) }
  for (const key of Object.keys(DEFAULT_LEAD_VALUE_WEIGHTS)) {
    const n = Number(merged[key])
    merged[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_VALUE_WEIGHTS[key]
  }
  const total = merged.need + merged.businessFit + merged.reachability + merged.timing
  const round4 = (value) => Math.round(value * 10000) / 10000
  const weights = total > 0
    ? { need: round4(merged.need / total), businessFit: round4(merged.businessFit / total), reachability: round4(merged.reachability / total), timing: round4(merged.timing / total) }
    : { ...DEFAULT_LEAD_VALUE_WEIGHTS }
  const isDefault = Object.keys(DEFAULT_LEAD_VALUE_WEIGHTS).every((key) => weights[key] === DEFAULT_LEAD_VALUE_WEIGHTS[key])
  return { weights, version: isDefault ? LEAD_VALUE_VERSION : `${LEAD_VALUE_VERSION}-custom-${shortHash(weights)}` }
}

function component() {
  return { score: 0, contributions: [], unknowns: [], considered: 0, observed: 0 }
}

function observe(bucket, signal, points, evidence, max) {
  bucket.considered += 1
  if (!evidence) {
    bucket.unknowns.push(signal)
    return bucket
  }
  bucket.observed += 1
  bucket.score = Math.min(max, bucket.score + points)
  bucket.contributions.push({ signal, points, evidence })
  return bucket
}

function cap100(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function scoreNeed(lead) {
  const bucket = component()
  // Website need starts from the deterministic audit score (kept independent).
  if (lead.opportunityScore != null) {
    observe(bucket, 'Deterministic website-need score', Math.round(lead.opportunityScore * 0.4), `Opportunity score: ${lead.opportunityScore}/100`, 40)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No website audit yet — website need is unmeasured')
  }
  // No website supplied: contributes only when business fit is supported, and
  // omission is recorded as omission — absence is never asserted.
  const fitSupport = Number(lead.reviews || 0) >= 10 || Number(lead.rating || 0) >= 4 || lead.businessIntelligence?.claimed === true
  if (!lead.website) {
    bucket.considered += 1
    if (fitSupport) {
      bucket.observed += 1
      bucket.score = Math.min(70, bucket.score + 20)
      bucket.contributions.push({ signal: 'No website supplied', points: 20, evidence: 'Website: not supplied (omission — absence not asserted)' })
    } else {
      bucket.unknowns.push('No website supplied and business fit is thin — need cannot be judged')
    }
  }
  if (Number(lead.brokenLinks || 0) > 0) {
    observe(bucket, 'Confirmed broken links', 10, `Broken internal links: ${lead.brokenLinks}`, 100)
  }
  const bi = lead.businessIntelligence || {}
  if (bi.onlineBooking === false && bi.onlineEstimates === false) {
    observe(bucket, 'No booking or estimate flow', 10, 'Online booking or request link: not detected; online estimates: not offered', 100)
  } else if (bi.onlineBooking != null || bi.onlineEstimates != null) {
    bucket.considered += 1
    bucket.observed += 1
  } else {
    bucket.considered += 1
    bucket.unknowns.push('Booking / estimate flow unobserved')
  }
  // Trust uses the persisted audit flag — never text-sniffing, which cannot
  // tell "detected" apart from "not detected" in saved finding strings.
  const trust = lead.auditSummary?.hasTrustLanguage
  if (trust === true) {
    bucket.considered += 1
    bucket.observed += 1
  } else if (trust === false && lead.opportunityScore != null) {
    observe(bucket, 'Weak trust signals', 8, 'Trust-language signals: none detected in homepage text', 100)
  } else if (lead.opportunityScore != null) {
    bucket.considered += 1
    bucket.unknowns.push('Trust signals unobserved')
  }
  bucket.score = cap100(bucket.score)
  return bucket
}

function scoreBusinessFit(lead) {
  const bucket = component()
  const rating = Number(lead.rating || 0)
  if (rating > 0) {
    observe(bucket, 'Review rating', rating >= 4.5 ? 15 : rating >= 4 ? 10 : rating >= 3.5 ? 5 : 0, `Rating: ${lead.rating}★`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No rating observed')
  }
  const reviews = Number(lead.reviews || 0)
  if (reviews > 0) {
    observe(bucket, 'Review volume', reviews >= 500 ? 20 : reviews >= 100 ? 15 : reviews >= 25 ? 10 : reviews >= 10 ? 5 : 2, `Reviews: ${reviews}`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No review count observed')
  }
  const bi = lead.businessIntelligence || {}
  if (bi.claimed === true) {
    observe(bucket, 'Claimed business profile', 10, 'Google Business Profile: claimed', 100)
  } else if (bi.claimed === false) {
    bucket.considered += 1
    bucket.observed += 1
  } else {
    bucket.considered += 1
    bucket.unknowns.push('Profile claim state unknown')
  }
  const locations = Number(bi.companyMetrics?.branchCount?.value || bi.locations?.length || 0)
  if (locations > 1) {
    observe(bucket, 'Multiple locations', 10, `Locations observed: ${locations}`, 100)
  } else {
    bucket.considered += 1
    if (locations === 1) bucket.observed += 1
    else bucket.unknowns.push('Location count unknown')
  }
  const ticket = CATEGORY_TICKET_POINTS[String(lead.category || '').toLowerCase()]
  if (ticket != null) {
    observe(bucket, 'Category ticket hypothesis', ticket, `Category: ${lead.category} (default rubric, uncalibrated)`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push(`No ticket hypothesis for category "${lead.category || 'unknown'}"`)
  }
  const founded = Number(bi.companyMetrics?.foundedYear?.value || 0)
  if (founded > 0) {
    const age = new Date().getFullYear() - founded
    observe(bucket, 'Business maturity', age >= 10 ? 8 : age >= 5 ? 5 : 2, `Founded: ${founded}`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('Business age unknown')
  }
  if (bi.companyMetrics?.employeeCount?.value != null || bi.companyMetrics?.annualRevenue?.value != null) {
    observe(bucket, 'Source-backed size signal', 5, 'Company size or revenue present from a named source', 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('Company size and revenue unknown — never guessed')
  }
  bucket.score = cap100(bucket.score)
  return bucket
}

function scoreReachability(lead) {
  const bucket = component()
  const email = String(lead.email || '').trim()
  if (email && email !== 'Not collected') {
    observe(bucket, 'Business email collected (unverified)', 20, `Email: ${email}`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No business email collected')
  }
  const phone = String(lead.phone || '').trim()
  if (phone && phone !== 'Not collected') {
    observe(bucket, 'Business phone collected', 20, `Phone: ${phone}`, 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No business phone collected')
  }
  const forms = Number(lead.auditSummary?.forms || 0)
  if (lead.opportunityScore != null) {
    bucket.considered += 1
    if (forms > 0) {
      bucket.observed += 1
      bucket.score = Math.min(100, bucket.score + 20)
      bucket.contributions.push({ signal: 'Website contact form observed', points: 20, evidence: `Enquiry forms observed: ${forms}` })
    } else {
      bucket.unknowns.push('No website contact form observed')
    }
  } else {
    bucket.considered += 1
    bucket.unknowns.push('Contact form unobserved (no audit yet)')
  }
  if (lead.sourceUrl) {
    observe(bucket, 'Mappable business profile', 10, 'Google Maps source URL saved', 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No mappable source URL saved')
  }
  const bi = lead.businessIntelligence || {}
  if (bi.onlineBooking || bi.reservationLink) {
    observe(bucket, 'Direct booking channel', 15, 'Online booking or reservation link detected', 100)
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No direct booking channel detected')
  }
  bucket.considered += 1
  bucket.unknowns.push('No decision-maker source connected — never guessed')
  bucket.score = cap100(bucket.score)
  return bucket
}

function scoreTiming(lead) {
  const bucket = component()
  const latest = lead.businessIntelligence?.latestObservedReviewAt || null
  if (latest) {
    const days = (Date.now() - Date.parse(latest)) / 86400000
    if (Number.isFinite(days) && days >= 0) {
      bucket.considered += 1
      bucket.observed += 1
      if (days <= 30) {
        bucket.score = Math.min(100, bucket.score + 25)
        bucket.contributions.push({ signal: 'Dated review activity within 30 days', points: 25, evidence: `Latest sampled Google review: ${latest}` })
      } else if (days <= 90) {
        bucket.score = Math.min(100, bucket.score + 15)
        bucket.contributions.push({ signal: 'Dated review activity within 90 days', points: 15, evidence: `Latest sampled Google review: ${latest}` })
      }
    } else {
      bucket.considered += 1
      bucket.unknowns.push('Latest review date unparseable')
    }
  } else {
    bucket.considered += 1
    bucket.unknowns.push('No dated review activity observed')
  }
  // A site that was good and is now broken is dated (audit history) and
  // source-backed — a genuine reason to contact now.
  const history = Array.isArray(lead.auditHistory) ? lead.auditHistory : []
  const brokenNow = Number(lead.brokenLinks || 0) > 0
  const brokenBefore = history.some((entry) => Number(entry?.brokenLinks || 0) > 0)
  const wasClean = history.some((entry) => entry && Number(entry?.brokenLinks) === 0)
  if (brokenNow && wasClean && !brokenBefore) {
    bucket.considered += 1
    bucket.observed += 1
    bucket.score = Math.min(100, bucket.score + 25)
    bucket.contributions.push({ signal: 'Newly broken links since a clean audit', points: 25, evidence: `Broken internal links: ${lead.brokenLinks} (a prior audit recorded 0)` })
  } else if (lead.opportunityScore != null || history.length > 0) {
    bucket.considered += 1
    bucket.unknowns.push('No newly-broken-website event in audit history')
  }
  const lastGood = lead.lastSuccessfulAudit || null
  const lastAttempt = lead.lastAuditAttempt || null
  if (lastGood && lastAttempt && ['Failed', 'Error', 'Timed out'].includes(lastAttempt.status)) {
    bucket.considered += 1
    bucket.observed += 1
    bucket.score = Math.min(100, bucket.score + 30)
    bucket.contributions.push({ signal: 'Website newly unreachable since a good audit', points: 30, evidence: `Last successful audit ${lastGood.score ?? '—'}/100 at ${lastGood.at}; latest attempt ${lastAttempt.status}` })
  } else if (lastGood || lastAttempt) {
    bucket.considered += 1
    bucket.unknowns.push('No newly-unreachable event since the last good audit')
  }
  // Single snapshots cannot show growth, launches, hiring or ads.
  bucket.considered += 1
  bucket.unknowns.push('Expansion, hiring, advertising and rebrand signals need a connected source')
  bucket.score = cap100(bucket.score)
  return bucket
}

function bandFor(score, coverage) {
  if (coverage < MIN_COVERAGE_FOR_LOW_PRIORITY) return { band: 'Review', reason: 'Thin evidence — collect more before judging this business' }
  if (score >= 70 && coverage >= MIN_COVERAGE_FOR_TOP_PROSPECT) return { band: 'Top Prospect', reason: 'Strong commercial signals on solid evidence' }
  if (score >= 60) return { band: 'Strong', reason: 'Worth human sales effort' }
  if (score >= 40) return { band: 'Review', reason: 'Mixed or incomplete commercial signals' }
  return { band: 'Low Priority', reason: 'Low commercial signals on solid evidence' }
}

export function scoreLeadValue(lead = {}, options = {}) {
  const { weights, version } = resolveLeadValueWeights(options.weights)
  const need = scoreNeed(lead)
  const businessFit = scoreBusinessFit(lead)
  const reachability = scoreReachability(lead)
  const timing = scoreTiming(lead)
  const considered = need.considered + businessFit.considered + reachability.considered + timing.considered
  const observed = need.observed + businessFit.observed + reachability.observed + timing.observed
  const coverage = considered ? Math.round((observed / considered) * 100) / 100 : 0
  const leadValueScore = cap100(
    need.score * weights.need +
    businessFit.score * weights.businessFit +
    reachability.score * weights.reachability +
    timing.score * weights.timing,
  )
  const status = lead.businessIntelligence?.businessStatus || 'Unknown'
  const excluded = ['Permanently closed', 'Temporarily closed'].includes(status)
    ? { closed: true, reason: `Provider reports this business as "${status}" — excluded from the active queue` }
    : null
  const { band, reason } = excluded
    ? { band: 'Low Priority', reason: `Provider reports this business as "${status}"` }
    : bandFor(leadValueScore, coverage)
  return {
    version,
    weights,
    scoredAt: options.at || new Date().toISOString(),
    need: { score: need.score, contributions: need.contributions, unknowns: need.unknowns },
    businessFit: { score: businessFit.score, contributions: businessFit.contributions, unknowns: businessFit.unknowns },
    reachability: { score: reachability.score, contributions: reachability.contributions, unknowns: reachability.unknowns },
    timing: { score: timing.score, contributions: timing.contributions, unknowns: timing.unknowns },
    coverage,
    leadValueScore,
    band,
    bandReason: reason,
    excluded,
  }
}
