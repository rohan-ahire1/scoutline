import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQueue, commercialState, computeReadiness, explainReadiness } from './readiness.js'
import { briefFindings } from './brief.js'

const base = {
  id: 'lead-1', company: 'Acme Plumbing', category: 'Plumbing',
  website: 'acme.example', qualified: true, salesStage: 'Qualified',
  phone: '555-0100', email: '', sourceUrl: null,
  opportunityScore: 70, currentAuditId: 'audit-9',
  auditedAt: new Date().toISOString(),
  problems: ['The homepage title is missing or outside a useful descriptive range.'],
  evidence: ['Homepage title length: 4 characters', 'Homepage returned HTTP 200 at https://acme.example/'],
  auditSummary: { forms: 0 },
  leadValue: { leadValueScore: 55, coverage: 0.7, version: '1', scoredAt: new Date().toISOString() },
}

function accepted(lead) {
  return { ...lead, findingReviews: [{ findingKey: briefFindings(lead)[0].key, decision: 'accepted', auditId: 'audit-9', at: new Date().toISOString() }] }
}

test('ready when accepted finding, fresh evidence, channel, no suppression', () => {
  const r = computeReadiness(accepted(base), { duplicateCount: 0 })
  assert.equal(r.ready, true)
  assert.equal(r.preparation, 'ready')
  assert.equal(r.primaryChannel.kind, 'phone')
})

test('partial audit with evidence-backed claim stays sufficient', () => {
  const lead = accepted({ ...base, auditStatus: 'Partial' })
  const r = computeReadiness(lead, {})
  assert.equal(r.ready, true)
})

test('incomplete records explain what is missing', () => {
  const noReview = computeReadiness(base, {})
  assert.equal(noReview.ready, false)
  assert.ok(noReview.blocks.some((b) => b.code === 'NO_REVIEWED_FINDING'))
  assert.equal(noReview.preparation, 'needs-opportunity-review')
  const noChannel = computeReadiness(accepted({ ...base, phone: 'Not collected', auditSummary: { forms: 0 } }), {})
  assert.ok(noChannel.blocks.some((b) => b.code === 'NO_CHANNEL'))
  const supp = computeReadiness(accepted({ ...base, doNotContact: { status: true, reason: 'stop' } }), {})
  assert.ok(supp.blocks.some((b) => b.code === 'SUPPRESSED'))
  assert.equal(supp.preparation, 'suppressed')
  const dupe = computeReadiness(accepted(base), { duplicateCount: 3 })
  assert.ok(dupe.blocks.some((b) => b.code === 'NEEDS_DUPLICATE_REVIEW'))
})

test('stale evidence blocks with explicit policy', () => {
  const old = new Date(Date.now() - 90 * 86400000).toISOString()
  const lead = accepted({ ...base, auditedAt: old })
  const r = computeReadiness(lead, {})
  assert.ok(r.blocks.some((b) => b.code === 'STALE_EVIDENCE'))
  assert.equal(r.preparation, 'needs-updated-evidence')
})

test('commercial unscored/insufficient never blocks, only warns', () => {
  const unscored = computeReadiness(accepted({ ...base, leadValue: null }), {})
  assert.equal(unscored.ready, true)
  assert.ok(unscored.warnings.some((w) => w.code === 'UNSCORED'))
  assert.equal(commercialState({}).status, 'unscored')
  assert.equal(commercialState({ leadValue: { leadValueScore: 20, coverage: 0.2, version: '1' } }).status, 'insufficient')
})

test('queue orders overdue follow-ups before ready prospects, skips suppressed', () => {
  const ready = accepted(base)
  const overdue = { ...accepted({ ...base, id: 'lead-2', company: 'Beta Co', phone: 'Not collected', auditSummary: { forms: 0 } }), doNotContact: null, nextTask: { status: 'open', type: 'follow-up', dueAt: '2000-01-01' } }
  // overdue has no channel so not ready, but its open overdue task still queues
  const suppressed = { ...ready, id: 'lead-3', company: 'Gamma', doNotContact: { status: true, reason: 'x' } }
  const q = buildQueue([ready, overdue, suppressed], { today: '2026-09-08', duplicateCounts: new Map() })
  assert.equal(q[0].kind, 'followup-overdue')
  assert.ok(q.some((i) => i.kind === 'ready' && i.leadId === 'lead-1'))
  assert.ok(!q.some((i) => i.leadId === 'lead-3'))
  assert.ok(explainReadiness(computeReadiness(ready, {})).startsWith('Ready'))
})
