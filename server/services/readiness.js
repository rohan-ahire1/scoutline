// Shared contact-readiness rules (M1). Single source of truth for API + UI.
//
// brief.js owns finding-review pairing and channel enumeration; this module
// owns the cross-cutting "Ready to contact" derivation so every screen and
// endpoint agrees. All helpers are pure and DOM-free so src/ can import them.
import { briefReadiness, reviewStatus, usableChannels } from './brief.js'

export const EVIDENCE_FRESH_DAYS = 60
export const MIN_COVERAGE_KNOWN = 0.5

export function evidenceAgeDays(lead = {}, nowMs = Date.now()) {
  const raw = lead.auditedAt || lead.lastSuccessfulAudit?.at || null
  const ms = raw ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((nowMs - ms) / 86400000))
}

export function researchState(lead = {}) {
  const ageDays = evidenceAgeDays(lead)
  const fresh = ageDays == null ? false : ageDays <= EVIDENCE_FRESH_DAYS
  const audited = lead.opportunityScore != null
  const status = lead.auditStatus || lead.researchStatus || null
  const partial = status === 'Partial'
  const inconclusive = lead.researchStatus === 'Inconclusive' || status === 'Inconclusive'
  return { audited, auditStatus: status || (audited ? 'Completed' : 'none'), partial, inconclusive, ageDays, fresh }
}

export function commercialState(lead = {}) {
  const stored = lead.leadValue || null
  if (!stored) return { status: 'unscored', score: null, coverage: 0, version: null, scoredAt: null }
  const coverage = Number(stored.coverage || 0)
  if (coverage < MIN_COVERAGE_KNOWN) {
    return { status: 'insufficient', score: stored.leadValueScore ?? null, coverage, version: stored.version || null, scoredAt: stored.scoredAt || null }
  }
  const auditAt = lead.auditedAt ? Date.parse(lead.auditedAt) : NaN
  const scoredAt = stored.scoredAt ? Date.parse(stored.scoredAt) : NaN
  const stale = Number.isFinite(auditAt) && Number.isFinite(scoredAt) && auditAt > scoredAt
  if (stale) {
    return { status: 'stale', score: stored.leadValueScore ?? null, coverage, version: stored.version || null, scoredAt: stored.scoredAt || null }
  }
  return { status: 'scored', score: stored.leadValueScore ?? null, coverage, version: stored.version || null, scoredAt: stored.scoredAt || null }
}

export function draftState(lead = {}) {
  const hasDraft = Boolean(lead.outreachDraft || Object.keys(lead.outreachDrafts || {}).length || lead.outreachChannels)
  if (!hasDraft) return { status: 'none' }
  if (lead.outreachEdited) return { status: 'edited', stale: Boolean(lead.outreachStale) }
  if (lead.outreachStale) return { status: 'stale', reason: lead.outreachStaleReason || 'A newer audit or offer change postdates this draft.' }
  const genAudit = lead.outreachGeneration?.auditId || lead.outreachProvenance?.auditId || null
  if (genAudit && lead.currentAuditId && genAudit !== lead.currentAuditId) {
    return { status: 'stale', reason: `A newer audit (${lead.currentAuditId}) completed after these drafts.` }
  }
  const genOffer = lead.outreachProvenance?.offerVersion || null
  if (genOffer && lead.offerVersionAtGeneration != null) return { status: 'draft' }
  return { status: 'draft' }
}

export function channelState(lead = {}) {
  const base = usableChannels(lead)
  const extra = Array.isArray(lead.contactCandidates) ? lead.contactCandidates : []
  const seen = new Set(base.map((c) => `${c.kind}:${String(c.value).toLowerCase()}`))
  const candidates = []
  for (const cand of extra) {
    const kind = cand?.kind
    const value = String(cand?.value || '').trim()
    if (!kind || !value) continue
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ kind, value, source: cand.source || 'website', observedAt: cand.observedAt || null })
  }
  const channels = [...base, ...candidates]
  const primary = channels.find((c) => c.kind === 'email') || channels.find((c) => c.kind === 'phone') || channels.find((c) => c.kind === 'form') || channels[0] || null
  return { channels, primary, hasUsable: channels.length > 0 }
}

// Full readiness. ctx: { nowMs, duplicateCount, duplicateReviewed }.
// Partial audits are NOT blanket-blocked: when the accepted finding cites
// saved evidence, the claim stands even if Lighthouse is missing.
export function computeReadiness(lead = {}, ctx = {}) {
  const base = briefReadiness(lead)
  const research = researchState(lead)
  const reviews = reviewStatus(lead)
  const channels = channelState(lead)
  const commercial = commercialState(lead)
  const draft = draftState(lead)
  const nowMs = ctx.nowMs || Date.now()
  const ageDays = evidenceAgeDays(lead, nowMs)

  const blocks = [...base.blocks]
  const warnings = [...base.warnings]

  // Evidence freshness: explicit policy, but a partial audit with an
  // evidence-backed accepted finding stays sufficient for that claim.
  let freshnessOk = true
  if (reviews.accepted.length && research.audited) {
    const acceptedHasEvidence = reviews.accepted.some((a) => Boolean(a.finding?.evidence))
    if (ageDays == null) {
      freshnessOk = true
      warnings.push({ code: 'EVIDENCE_AGE_UNKNOWN', message: 'Evidence date is unknown; treat recency as unverified.' })
    } else if (ageDays > EVIDENCE_FRESH_DAYS) {
      freshnessOk = false
      blocks.push({ code: 'STALE_EVIDENCE', message: `Supporting evidence is ${ageDays}d old (policy: ${EVIDENCE_FRESH_DAYS}d). Re-audit before contact.` })
    } else if (research.partial && !acceptedHasEvidence) {
      freshnessOk = false
      blocks.push({ code: 'PARTIAL_EVIDENCE', message: 'Partial audit with no evidence-backed accepted finding. Review saved evidence first.' })
    } else if (research.inconclusive) {
      freshnessOk = false
      blocks.push({ code: 'INCONCLUSIVE', message: 'Latest capture was inconclusive; no claim can be supported yet.' })
    }
  } else if (!research.audited) {
    freshnessOk = false
    // base already blocks on NO_REVIEWED_FINDING; add explicit research state
    if (!blocks.some((b) => b.code === 'NO_REVIEWED_FINDING')) {
      blocks.push({ code: 'NO_RESEARCH', message: 'No website audit yet.' })
    }
  }

  // Duplicate review: caller supplies group size; explicit flag resolves it.
  const dupCount = Number(ctx.duplicateCount || 0)
  const dupReviewed = Boolean(lead.duplicateReviewed)
  if (dupCount > 1 && !dupReviewed) {
    blocks.push({ code: 'NEEDS_DUPLICATE_REVIEW', message: `${dupCount} records share this business name. Resolve duplicates before contact.` })
  }

  // Commercial is advisory, never a readiness block: surface as warning only.
  if (commercial.status === 'unscored') {
    warnings.push({ code: 'UNSCORED', message: 'No commercial assessment stored yet.' })
  } else if (commercial.status === 'insufficient') {
    warnings.push({ code: 'THIN_EVIDENCE', message: 'Commercial evidence is thin; approach as unqualified on fit/budget.' })
  } else if (commercial.status === 'stale') {
    warnings.push({ code: 'SCORE_STALE', message: 'Commercial score predates the latest audit.' })
  }

  if (draft.status === 'stale') {
    warnings.push({ code: 'DRAFT_STALE', message: draft.reason || 'Draft predates latest evidence.' })
  }

  const ready = blocks.length === 0
  const preparation = !ready
    ? lead.doNotContact?.status ? 'suppressed'
      : ['Won', 'Lost'].includes(lead.salesStage) ? 'closed'
        : !research.audited ? 'needs-research'
          : dupCount > 1 && !dupReviewed ? 'needs-duplicate-review'
            : !reviews.accepted.length ? 'needs-opportunity-review'
              : !channels.hasUsable ? 'needs-contact'
                : !freshnessOk ? 'needs-updated-evidence'
                  : 'blocked'
    : 'ready'

  return {
    ready,
    preparation,
    blocks,
    warnings,
    unknowns: base.unknowns,
    channels: channels.channels,
    primaryChannel: channels.primary,
    accepted: reviews.accepted,
    pendingCount: reviews.pending.length,
    staleCount: reviews.stale.length,
    research,
    commercial,
    draft: draft.status,
    draftReason: draft.reason || null,
    evidenceAgeDays: ageDays,
    duplicateCount: dupCount,
    duplicateReviewed: dupReviewed,
  }
}

export function explainReadiness(readiness) {
  if (readiness.ready) {
    const opp = readiness.accepted?.[0]?.finding?.detail || readiness.accepted?.[0]?.reason || 'reviewed opportunity'
    const ch = readiness.primaryChannel ? `${readiness.primaryChannel.kind}: ${readiness.primaryChannel.value}` : 'usable contact route'
    return `Ready: ${opp} via ${ch}.`
  }
  return readiness.blocks.map((b) => b.message).join(' ') || 'Not ready.'
}

// Daily queue: overdue follow-ups first, then today, then ready prospects
// ordered by commercial score desc. Suppressed/closed never queue.
export function buildQueue(leads = [], ctx = {}) {
  const today = ctx.today || new Date().toISOString().slice(0, 10)
  const items = []
  for (const lead of leads) {
    if (lead.doNotContact?.status) continue
    if (['Won', 'Lost'].includes(lead.salesStage)) continue
    const readiness = computeReadiness(lead, { ...ctx, duplicateCount: ctx.duplicateCounts?.get?.(lead.id) || 0 })
    const task = lead.nextTask?.status === 'open' ? lead.nextTask : null
    const bucket = !task?.dueAt ? 'none' : task.dueAt < today ? 'overdue' : task.dueAt === today ? 'today' : 'upcoming'
    if (task && (bucket === 'overdue' || bucket === 'today')) {
      items.push({
        kind: bucket === 'overdue' ? 'followup-overdue' : 'followup-today',
        leadId: lead.id,
        company: lead.company,
        reason: bucket === 'overdue' ? `Follow-up overdue (${task.type}${task.dueAt ? ` due ${task.dueAt}` : ''})` : `Follow-up due today (${task.type})`,
        destination: 'activity',
        rank: bucket === 'overdue' ? 0 : 1,
        dueAt: task.dueAt || '',
      })
    } else if (readiness.ready) {
      items.push({
        kind: 'ready',
        leadId: lead.id,
        company: lead.company,
        reason: explainReadiness(readiness),
        destination: 'outreach',
        rank: 2,
        dueAt: '',
        score: readiness.commercial.score ?? 0,
      })
    }
  }
  items.sort((a, b) => a.rank - b.rank || (b.score || 0) - (a.score || 0) || String(a.dueAt).localeCompare(String(b.dueAt)) || String(a.company).localeCompare(String(b.company)))
  return items
}
