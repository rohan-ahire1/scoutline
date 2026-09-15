import test from 'node:test'
import assert from 'node:assert/strict'
import { addDaysString, briefFindings, briefReadiness, buildBriefMarkdown, isValidDayString, reviewStatus, taskBucket, usableChannels } from './brief.js'

const audited = {
  id: 'lead-1', company: 'Acme Plumbing', category: 'Plumbing', location: 'Austin, TX',
  website: 'acme.example', qualified: true, salesStage: 'Qualified',
  phone: '555-0100', email: 'bid@acme.example', sourceUrl: 'https://maps.example/acme',
  opportunityScore: 70, currentAuditId: 'audit-9',
  problems: ['The homepage title is missing or outside a useful descriptive range.', 'No phone link, email link, or enquiry form was detected in homepage markup.'],
  evidence: ['Homepage title length: 4 characters', 'Direct contact methods detected: 0', 'Homepage returned HTTP 200 at https://acme.example/'],
  auditSummary: { forms: 1 },
}

test('unreviewed findings cannot appear as reviewed', () => {
  const status = reviewStatus(audited)
  assert.equal(status.accepted.length, 0)
  assert.equal(status.pending.length, 2)
  const readiness = briefReadiness(audited)
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blocks.some((b) => b.code === 'NO_REVIEWED_FINDING'))
  const markdown = buildBriefMarkdown(audited, readiness)
  assert.ok(!markdown.includes('homepage title is missing'))
  assert.match(markdown, /Status: not ready/)
})

test('accepted findings pair with genuinely related evidence only', () => {
  const lead = {
    ...audited,
    findingReviews: [
      { findingKey: briefFindings(audited)[0].key, decision: 'accepted', reason: 'Title is empty, verified in export', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z', by: 'Rohan' },
      { findingKey: briefFindings(audited)[1].key, decision: 'rejected', reason: 'Phone is in the footer image', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z' },
    ],
  }
  const status = reviewStatus(lead)
  assert.equal(status.accepted.length, 1)
  assert.equal(status.rejected.length, 1)
  assert.match(status.accepted[0].finding.evidence || '', /Homepage title length/)
  const readiness = briefReadiness(lead)
  assert.equal(readiness.ready, true)
  const markdown = buildBriefMarkdown(lead, readiness)
  assert.ok(markdown.includes('homepage title is missing'))
  assert.ok(!markdown.includes('enquiry form was detected'))
  assert.ok(!/opportunityScore|leadValue|prelimScore|[0-9]+\/100 \(/.test(markdown), 'internal scores omitted')
})

test('a newer audit invalidates prior approvals without losing history', () => {
  const reviewed = {
    ...audited,
    findingReviews: [{ findingKey: briefFindings(audited)[0].key, decision: 'accepted', reason: 'ok', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z' }],
  }
  const changed = { ...reviewed, currentAuditId: 'audit-10', problems: ['A brand new finding appeared.'], evidence: ['Something else entirely observed here.'] }
  const status = reviewStatus(changed)
  assert.equal(status.accepted.length, 0)
  assert.equal(status.stale.length, 1)
  assert.equal(status.pending.length, 1)
  const readiness = briefReadiness(changed)
  assert.equal(readiness.ready, false)
  assert.ok(readiness.warnings.some((w) => w.code === 'STALE_REVIEWS'))
  assert.ok(!buildBriefMarkdown(changed, readiness).includes('homepage title is missing'))
})

test('suppression and missing channel block with clear reasons', () => {
  const suppressed = { ...audited, doNotContact: { status: true, reason: 'Asked to stop calling', at: '2026-09-05', scope: 'business' }, findingReviews: [{ findingKey: briefFindings(audited)[0].key, decision: 'accepted', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z' }] }
  const readiness = briefReadiness(suppressed)
  assert.equal(readiness.ready, false)
  assert.ok(readiness.blocks.some((b) => b.code === 'SUPPRESSED' && /Asked to stop calling/.test(b.message)))
  const noChannel = { ...audited, phone: 'Not collected', email: 'Not collected', sourceUrl: null, auditSummary: { forms: 0 }, opportunityScore: null }
  assert.ok(briefReadiness(noChannel).blocks.some((b) => b.code === 'NO_CHANNEL'))
  assert.deepEqual(usableChannels(audited).map((c) => c.kind), ['email', 'phone', 'form', 'profile'])
})

test('manual rationale is labelled manual and retained in the brief', () => {
  const lead = { ...audited, briefRationale: { text: 'Owner mentioned a redesign at the trade show.', by: 'Rohan', at: '2026-09-05T00:00:00.000Z', manual: true } }
  const markdown = buildBriefMarkdown(lead, briefReadiness(lead))
  assert.ok(markdown.includes('Manual rationale (Rohan): Owner mentioned a redesign'))
  assert.ok(briefReadiness(lead).warnings.some((w) => w.code === 'MANUAL_RATIONALE'))
})

test('one finding stays concise and never pads', () => {
  const lead = { ...audited, problems: ['Single supported finding here.'], evidence: ['Single supported evidence line here.'], findingReviews: [{ findingKey: briefFindings({ ...audited, problems: ['Single supported finding here.'] })[0].key, decision: 'accepted', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z' }] }
  const markdown = buildBriefMarkdown(lead, briefReadiness(lead))
  const reviewedSection = markdown.split('## Reviewed findings')[1].split('## Readiness')[0]
  assert.equal((reviewedSection.match(/^- /gm) || []).length, 1, 'exactly one finding bullet, nothing padded')
  assert.ok(reviewedSection.includes('  - Evidence: Single supported evidence line here.'))
  assert.ok(reviewedSection.includes('  - Reviewed '))
  assert.ok(markdown.includes('Single supported finding here.'))
  assert.ok(!markdown.includes('Direct contact methods'))
})

test('task buckets handle overdue, today, upcoming and no-date consistently', () => {
  assert.equal(isValidDayString('2026-09-05'), true)
  assert.equal(isValidDayString('2026-13-40'), false)
  assert.equal(isValidDayString('tomorrow'), false)
  assert.equal(taskBucket({ status: 'open', dueAt: '2026-09-04' }, '2026-09-05'), 'overdue')
  assert.equal(taskBucket({ status: 'open', dueAt: '2026-09-05' }, '2026-09-05'), 'today')
  assert.equal(taskBucket({ status: 'open', dueAt: '2026-09-06' }, '2026-09-05'), 'upcoming')
  assert.equal(taskBucket({ status: 'open', dueAt: null }, '2026-09-05'), 'none')
  assert.equal(taskBucket({ status: 'done', dueAt: '2026-09-01' }, '2026-09-05'), 'none')
  assert.equal(taskBucket({ status: 'snoozed', dueAt: '2026-09-01' }, '2026-09-05'), 'none')
  assert.equal(addDaysString('2026-09-05', 7), '2026-09-12')
})

test('recommended opportunity ranks customer tasks above metadata', async () => {
  const { describeOpportunity, rankFindingsForOutreach } = await import('./brief.js')
  const findings = [
    { detail: 'The homepage title is missing or outside a useful descriptive range.', evidence: 'Homepage title length: 4 characters' },
    { detail: 'No phone link, email link, or enquiry form was detected in homepage markup.', evidence: 'Direct contact methods detected: 0' },
  ]
  const ranked = rankFindingsForOutreach(findings)
  assert.match(ranked[0].detail, /phone link/)
  const opp = describeOpportunity(ranked[0], { analysisSource: 'Deterministic website audit', auditedUrl: 'https://acme.example/', auditedAt: '2026-09-01T00:00:00.000Z', auditStatus: 'Partial' })
  assert.match(opp.relevance, /interpretation, not measured/)
  assert.ok(opp.evidence.excerpt && opp.evidence.url && opp.evidence.date)
  assert.ok(opp.limitations.some((l) => /Partial audit/.test(l)))
  assert.ok(!/revenue|conversion|urgent/i.test(JSON.stringify(opp)))
})

test('prospect brief is a dated snapshot without internal details', async () => {
  const { buildProspectBrief, briefFindings } = await import('./brief.js')
  const lead = {
    ...audited,
    notes: 'Internal: looks price-sensitive, call after 5pm.',
    briefRationale: { text: 'Internal rationale here.', by: 'Rohan' },
    leadValue: { leadValueScore: 77, coverage: 0.8, version: '1' },
    opportunityScore: 70,
    findingReviews: [{ findingKey: briefFindings(audited)[0].key, decision: 'accepted', auditId: 'audit-9', at: '2026-09-05T00:00:00.000Z' }],
    contactAttempts: [{ id: 'att-1', outcome: 'no-answer' }],
  }
  const md = buildProspectBrief(lead, { date: '2026-09-08T00:00:00.000Z' })
  assert.match(md, /Acme Plumbing/)
  assert.match(md, /2026-09-08/)
  assert.match(md, /Snapshot of saved evidence/)
  assert.ok(md.includes('homepage title is missing'))
  assert.ok(!md.includes('77/100') && !md.includes('Internal: looks price-sensitive') && !md.includes('Internal rationale'))
  assert.ok(!md.includes('enquiry form was detected'), 'rejected/unreviewed findings stay out')
  assert.equal(buildProspectBrief(audited), null, 'no accepted finding means no brief')
})
