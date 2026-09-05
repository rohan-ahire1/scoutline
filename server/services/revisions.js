export class RevisionConflictError extends Error {
  constructor({ id, expectedRev, rev }) {
    super(`This client changed while your edit was in flight (expected revision ${expectedRev}, current ${rev}). Reload and reapply the edit.`)
    this.name = 'RevisionConflictError'
    this.code = 'REVISION_CONFLICT'
    this.status = 409
    this.leadId = id
    this.expectedRev = expectedRev
    this.rev = rev
  }
}

export function getRev(lead) {
  const rev = lead?.rev
  return Number.isInteger(rev) && rev >= 0 ? rev : 0
}

// Field ownership: background jobs own generated outputs. Users own notes,
// qualification, sales/contract state, contact values they set, and edited
// drafts. Job patches must never write user-owned fields; builders below
// enforce this so a stale job cannot last-write-wins over a human edit.
export const USER_OWNED_FIELDS = new Set([
  'notes', 'qualified', 'salesStage', 'qualifiedAt', 'labels',
  'contract', 'lostReason', 'nextAction', 'contactedAt',
])

const EMPTY_CONTACT_VALUES = new Set(['', 'Unknown', 'Not collected'])

export function isEmptyContactValue(value) {
  if (value == null) return true
  if (typeof value === 'number') return false
  return EMPTY_CONTACT_VALUES.has(String(value).trim())
}

// Atomic field-scoped update: merges `patch` into the latest stored row inside
// a transaction and bumps the revision. With expectedRev set, a concurrent
// writer fails loudly instead of silently losing.
export function updateLeadFields(db, id, patch, { expectedRev = null } = {}) {
  const apply = db.transaction(() => {
    const row = db.prepare('SELECT payload FROM leads WHERE id = ?').get(id)
    if (!row) {
      const missing = new Error('Lead not found')
      missing.code = 'NOT_FOUND'
      missing.status = 404
      throw missing
    }
    const current = JSON.parse(row.payload)
    const rev = getRev(current)
    if (expectedRev != null && rev !== expectedRev) {
      throw new RevisionConflictError({ id, expectedRev, rev })
    }
    const { rev: _rev, id: _id, ...safePatch } = patch || {}
    const next = { ...current, ...safePatch, rev: rev + 1 }
    db.prepare('UPDATE leads SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(next), id)
    return next
  })
  return apply()
}

export function buildOutreachCandidate(generated) {
  return {
    subject: generated.subject,
    drafts: generated.drafts,
    findings: generated.findings || [],
    observationIds: generated.observationIds || generated.generation?.observationIds || [],
    insufficientEvidence: Boolean(generated.insufficientEvidence),
    reason: generated.reason || null,
    generation: generated.generation,
    createdAt: new Date().toISOString(),
  }
}

// Decide what a finished outreach generation may touch. Pure: `started` is the
// lead snapshot from before the provider await, `current` is the latest row.
// Stale or surprising output becomes a candidate — never current truth.
export function resolveOutreachCompletion({ started = {}, current = {}, generated, selectedVersion = null }) {
  const candidates = [buildOutreachCandidate(generated), ...((current || {}).outreachCandidates || [])].slice(0, 5)
  if (generated.insufficientEvidence) {
    const hasDrafts = Boolean(current.outreachDraft) || Object.keys(current.outreachDrafts || {}).length > 0
    return {
      type: 'insufficient',
      patch: {
        outreachCandidates: candidates,
        outreachUpdateAvailable: true,
        outreachStatus: hasDrafts ? current.outreachStatus || 'Draft' : 'Insufficient evidence',
      },
    }
  }
  const incomingAt = generated.generation?.generatedAt || null
  const currentAt = current.outreachGeneration?.generatedAt || null
  const olderThanCurrent = Boolean(incomingAt && currentAt && incomingAt < currentAt)
  const userEdited = current.outreachEdited === true ||
    (current.outreachDraft != null && started.outreachDraft !== undefined && current.outreachDraft !== started.outreachDraft)
  if (olderThanCurrent || userEdited) {
    return { type: 'candidate', patch: { outreachCandidates: candidates, outreachUpdateAvailable: true } }
  }
  const version = ['Concise', 'Balanced', 'Detailed'].includes(selectedVersion) ? selectedVersion : 'Concise'
  return {
    type: 'apply',
    patch: {
      outreachSubject: generated.subject,
      outreachDrafts: generated.drafts,
      outreachVersion: version,
      outreachDraft: generated.drafts[version],
      outreachGeneration: generated.generation,
      outreachCandidates: candidates,
      outreachUpdateAvailable: false,
      outreachEdited: false,
      outreachStatus: current.outreachStatus || 'Draft',
    },
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

export function dismissOutreachCandidates() {
  return { outreachCandidates: [], outreachUpdateAvailable: false }
}

// Provider refresh may only fill empty contact slots and provider-provenance
// outputs. Notes, user-chosen contacts and sales state are never in the patch.
export function buildRefreshPatch({ current = {}, fresh = {} }) {
  const patch = {}
  for (const field of ['phone', 'email', 'location', 'rating', 'reviews']) {
    if (isEmptyContactValue(current[field]) && !isEmptyContactValue(fresh[field])) patch[field] = fresh[field]
  }
  return patch
}

// A finished synthesis older than the stored one is stale: keep current truth.
export function resolveSynthesisCompletion({ current = {}, result }) {
  const incomingAt = result?.generatedAt || null
  const currentAt = current.museAnalysis?.generatedAt || null
  if (incomingAt && currentAt && incomingAt < currentAt) return { type: 'stale', patch: null }
  return {
    type: 'apply',
    patch: {
      museAnalysis: { status: 'Completed', ...result, error: null },
    },
  }
}
