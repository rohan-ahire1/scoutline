// Prospect brief + outreach readiness (ROH-27/28). Pure helpers: finding
// reviews reference audit/evidence IDs, readiness derives from qualification,
// reviewed findings, usable channel and suppression — never from unreviewed
// or stale facts. The client-facing brief contains reviewed findings only,
// with internal scores always omitted.

export const NEXT_TASK_TYPES = ['call', 'email', 'visit', 'proposal', 'follow-up', 'delivery', 'other']
export const TASK_STATUSES = ['open', 'done', 'snoozed', 'cleared']
export const ATTEMPT_OUTCOMES = ['no-answer', 'conversation', 'replied', 'meeting', 'not-interested', 'wrong-contact', 'other']
// Outcomes that prove a human was reached: only these set Contacted.
export const CONTACT_OUTCOMES = ['conversation', 'replied', 'meeting']
export const TASK_OWNERS = ['Rohan', 'Friend']

export function findingKey(auditId, detail, index) {
  return `${auditId || 'legacy'}::${index}::${String(detail || '').slice(0, 80)}`
}

// Findings as the brief sees them: current-audit details paired with the
// best-matching evidence line by shared significant words (null when no
// line genuinely relates — never a positional guess).
function matchEvidence(detail, evidence) {
  const words = new Set(String(detail || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))
  if (!words.size) return null
  let best = null
  let bestScore = 0
  for (const line of evidence) {
    const lineWords = new Set(String(line || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))
    let shared = 0
    for (const word of words) if (lineWords.has(word)) shared += 1
    if (shared > bestScore) {
      bestScore = shared
      best = line
    }
  }
  return bestScore >= 2 ? best : null
}

export function briefFindings(lead = {}) {
  const details = Array.isArray(lead.problems) ? lead.problems : []
  const evidence = Array.isArray(lead.evidence) ? lead.evidence : []
  const auditId = lead.currentAuditId || null
  return details.map((detail, index) => ({
    key: findingKey(auditId, detail, index),
    detail,
    evidence: matchEvidence(detail, evidence),
    auditId,
  }))
}

export function reviewStatus(lead = {}) {
  const findings = briefFindings(lead)
  const byKey = new Map(findings.map((item) => [item.key, item]))
  const reviews = Array.isArray(lead.findingReviews) ? lead.findingReviews : []
  const accepted = []
  const rejected = []
  const stale = []
  for (const review of reviews) {
    const current = review && review.auditId === (lead.currentAuditId || null) && byKey.has(review.findingKey)
    const entry = { ...review, finding: byKey.get(review?.findingKey) || null }
    if (!current) {
      stale.push(entry)
    } else if (review.decision === 'accepted') {
      accepted.push(entry)
    } else {
      rejected.push(entry)
    }
  }
  // A newer audit invalidates prior approvals: they stay in history as stale
  // and never count toward readiness or the client-facing brief.
  const reviewedKeys = new Set([...accepted, ...rejected].map((item) => item.findingKey))
  const pending = findings.filter((item) => !reviewedKeys.has(item.key))
  return { findings, accepted, rejected, stale, pending }
}

export function usableChannels(lead = {}) {
  const channels = []
  const email = String(lead.email || '').trim()
  if (email && email !== 'Not collected') channels.push({ kind: 'email', value: email })
  const phone = String(lead.phone || '').trim()
  if (phone && phone !== 'Not collected') channels.push({ kind: 'phone', value: phone })
  const forms = Number(lead.auditSummary?.forms || 0)
  if (lead.opportunityScore != null && forms > 0) channels.push({ kind: 'form', value: `${forms} enquiry form${forms === 1 ? '' : 's'} observed` })
  if (lead.sourceUrl) channels.push({ kind: 'profile', value: 'Saved business profile' })
  return channels
}

export function briefReadiness(lead = {}) {
  const blocks = []
  const warnings = []
  const { accepted, stale, pending } = reviewStatus(lead)
  if (!lead.qualified) blocks.push({ code: 'NOT_QUALIFIED', message: 'Qualify this business before outreach.' })
  if (!accepted.length) {
    blocks.push({
      code: 'NO_REVIEWED_FINDING',
      message: pending.length ? `${pending.length} finding${pending.length === 1 ? '' : 's'} still need${pending.length === 1 ? 's' : ''} human review.` : 'No reviewed findings — review the audit evidence first.',
    })
  }
  const channels = usableChannels(lead)
  if (!channels.length) blocks.push({ code: 'NO_CHANNEL', message: 'No usable contact channel (email, phone, enquiry form or profile).' })
  if (lead.doNotContact?.status) {
    blocks.push({ code: 'SUPPRESSED', message: `Do not contact${lead.doNotContact.reason ? `: ${lead.doNotContact.reason}` : ''}. Clear the suppression explicitly to reopen.` })
  }
  if (lead.salesStage === 'Won') blocks.push({ code: 'CLOSED_WON', message: 'Won — outreach queue is closed; delivery continues through the contract.' })
  if (lead.salesStage === 'Lost') blocks.push({ code: 'CLOSED_LOST', message: 'Lost — reopen explicitly before any new outreach.' })
  if (stale.length) warnings.push({ code: 'STALE_REVIEWS', message: `${stale.length} earlier review${stale.length === 1 ? '' : 's'} superseded by a newer audit.` })
  if (lead.museStale || lead.outreachStale) warnings.push({ code: 'STALE_OUTPUT', message: 'Saved synthesis or drafts predate the latest audit.' })
  if (lead.briefRationale?.text) warnings.push({ code: 'MANUAL_RATIONALE', message: `Manual rationale by ${lead.briefRationale.by || 'reviewer'} — human judgment, not measured evidence.` })
  const unknowns = []
  if (!channels.some((c) => c.kind === 'email')) unknowns.push('business email')
  if (!channels.some((c) => c.kind === 'phone')) unknowns.push('business phone')
  if (lead.opportunityScore == null) unknowns.push('website audit')
  return { ready: blocks.length === 0, blocks, warnings, unknowns, channels, accepted, pendingCount: pending.length, staleCount: stale.length }
}

// Local-date helpers for follow-up tasks (ROH-28). dueAt is a YYYY-MM-DD
// date (no time component), so Today/Overdue compare calendar days in the
// viewer's locale — consistent across timezones by construction.
export function localDayString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isValidDayString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function taskBucket(task, today = localDayString()) {
  if (!task || task.status !== 'open' || !task.dueAt) return 'none'
  if (task.dueAt < today) return 'overdue'
  if (task.dueAt === today) return 'today'
  return 'upcoming'
}

export function addDaysString(dayString, days) {
  const [y, m, d] = dayString.split('-').map(Number)
  const date = new Date(y, m - 1, d + days)
  return localDayString(date)
}

export function buildBriefMarkdown(lead = {}, readiness = briefReadiness(lead)) {
  const lines = []
  const date = (lead.collectedAt && String(lead.collectedAt)) || 'unknown date'
  lines.push(`# Opportunity brief — ${lead.company || 'Unnamed business'}`)
  lines.push('')
  lines.push(`- Category: ${lead.category || 'Unknown'}`)
  lines.push(`- Location: ${lead.location || 'Unknown'}`)
  if (lead.website) lines.push(`- Website: https://${lead.website}`)
  else lines.push('- Website: not supplied')
  if (Number(lead.rating || 0) > 0) lines.push(`- Public rating: ${lead.rating}★ from ${lead.reviews ?? 0} reviews`)
  lines.push(`- Source: ${lead.sourceUrl ? 'saved business profile' : lead.labels?.[0] || 'manual entry'} · collected ${date}`)
  lines.push('')
  lines.push('## Reviewed findings')
  lines.push('')
  for (const item of readiness.accepted) {
    lines.push(`- ${item.finding?.detail || item.findingKey}`)
    if (item.finding?.evidence) lines.push(`  - Evidence: ${item.finding.evidence}`)
    lines.push(`  - Reviewed ${item.at || 'on record'}${item.by ? ` by ${item.by}` : ''}${item.reason ? ` — ${item.reason}` : ''}`)
  }
  lines.push('')
  lines.push('## Readiness')
  lines.push('')
  lines.push(`- Status: ${readiness.ready ? 'ready for outreach' : 'not ready'}`)
  for (const block of readiness.blocks) lines.push(`- Blocked: ${block.message}`)
  lines.push(`- Contact channel: ${readiness.channels.map((c) => (c.kind === 'email' || c.kind === 'phone' ? `${c.kind}: ${c.value}` : c.value)).join('; ') || 'none identified'}`)
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  if (readiness.unknowns.length) lines.push(`- Unknown: ${readiness.unknowns.join(', ')}.`)
  if (readiness.staleCount) lines.push(`- ${readiness.staleCount} earlier review${readiness.staleCount === 1 ? '' : 's'} superseded by newer evidence and excluded.`)
  if (lead.briefRationale?.text) lines.push(`- Manual rationale (${lead.briefRationale.by || 'reviewer'}): ${lead.briefRationale.text}`)
  else lines.push('- No manual rationale recorded.')
  lines.push('- Internal scores and commercial estimates are intentionally omitted from this brief.')
  return lines.join('\n')
}
