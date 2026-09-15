import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateLeadCounts, duplicateLeadIds, getMuseGuidance, getNextAction, getOutreachState, getResearchState } from './workflow.js'

// Contract tests for the ROH-25 next-action decision table. Each sales and
// research state maps to exactly one honest next action; terminal states win
// over outreach, and a failed attempt never hides retained evidence.

test('Won leads ask for the contract before delivery work', () => {
  assert.equal(getNextAction({ qualified: true, salesStage: 'Won', opportunityScore: 70, analysisSource: 'audit' }), 'Add contract details')
  assert.equal(getNextAction({ qualified: true, salesStage: 'Won', opportunityScore: 70, analysisSource: 'audit', contract: { nextStep: 'Kick off homepage build' } }), 'Kick off homepage build')
  assert.equal(getNextAction({ qualified: true, salesStage: 'Won', opportunityScore: 70, analysisSource: 'audit', contract: {} }), 'Begin delivery')
})

test('Lost leads never default back to outreach', () => {
  assert.equal(getNextAction({ qualified: true, salesStage: 'Lost', opportunityScore: 70, analysisSource: 'audit' }), 'Review client')
  assert.equal(getOutreachState({ qualified: true, salesStage: 'Lost' }), 'Not queued')
  assert.equal(getOutreachState({ qualified: true, salesStage: 'Won', contract: {} }), 'Not queued')
})

test('suppressed leads stay out of the contact queue', () => {
  const lead = { qualified: true, salesStage: 'Qualified', opportunityScore: 70, analysisSource: 'audit', doNotContact: true }
  assert.equal(getNextAction(lead), 'Review suppression')
  assert.equal(getOutreachState(lead), 'Suppressed')
})

test('a failed attempt with retained evidence points at the evidence', () => {
  const lead = {
    opportunityScore: 62, analysisSource: 'audit',
    researchFailure: { stage: 1, reason: 'Audit timed out', code: 'TIMEOUT', at: '2026-09-05T00:00:00.000Z', jobId: 'job-1' },
  }
  assert.equal(getResearchState(lead).retainedEvidence, true)
  assert.equal(getNextAction(lead), 'Review saved evidence')
})

test('a failed attempt with no evidence asks for a retry', () => {
  const lead = {
    researchFailure: { stage: 1, reason: 'Audit timed out', code: 'TIMEOUT', at: '2026-09-05T00:00:00.000Z', jobId: 'job-1' },
  }
  assert.equal(getNextAction(lead), 'Retry research')
})

test('an active research job reports running instead of Analyze website', () => {
  assert.equal(getNextAction({ researchStatus: 'Analyzing' }), 'Research running')
  assert.equal(getNextAction({ researchJob: { id: 'job-1', status: 'Running', progress: 40 } }), 'Research running')
})

test('a lead with no website follows the manual review path, not the audit path', () => {
  assert.equal(getNextAction({ company: 'No Site Plumbing' }), 'Review business fit')
  assert.equal(getNextAction({ company: 'Has Site', website: 'example.com' }), 'Analyze website')
})

test('skipped AI synthesis asks for review before qualification', () => {
  const lead = { opportunityScore: 70, website: 'example.com', museAnalysis: { status: 'Skipped' } }
  assert.equal(getResearchState(lead).museSkipped, true)
  assert.equal(getResearchState(lead).deterministicReady, true)
  assert.equal(getNextAction(lead), 'Review findings')
})

test('pending synthesis still asks for review before qualification', () => {
  assert.equal(getNextAction({ opportunityScore: 70, website: 'example.com' }), 'Review research')
})

test('qualified leads distinguish draft readiness', () => {
  const base = { qualified: true, salesStage: 'Qualified', opportunityScore: 70, analysisSource: 'audit' }
  assert.equal(getNextAction(base), 'Prepare outreach')
  assert.equal(getNextAction({ ...base, outreachDraft: 'Hello' }), 'Review outreach draft')
  assert.equal(getOutreachState({ ...base, outreachDraft: 'Hello' }), 'Ready to contact')
})

test('Pass guidance is visible and advisory', () => {
  assert.equal(getMuseGuidance({ museAnalysis: { qualificationRecommendation: 'Pass' } }), 'Pass')
  assert.equal(getMuseGuidance({ museAnalysis: { qualificationRecommendation: 'Pursue' } }), 'Pursue')
  assert.equal(getMuseGuidance({ museAnalysis: { qualificationRecommendation: 'Review' } }), 'Review manually')
  assert.equal(getMuseGuidance({}), null)
})

test('open pipeline stages surface the explicit next step', () => {
  assert.equal(getNextAction({ qualified: true, salesStage: 'Meeting', opportunityScore: 70, analysisSource: 'audit', nextAction: 'Send proposal' }), 'Send proposal')
  assert.equal(getNextAction({ qualified: true, salesStage: 'Proposal', opportunityScore: 70, analysisSource: 'audit' }), 'Set next action')
})

test('duplicate business names resolve to one flagged id set', () => {
  const leads = [
    { id: 'a', company: 'Utah Remodel Works' },
    { id: 'b', company: 'utah remodel works ' },
    { id: 'c', company: 'Roof-It' },
  ]
  assert.deepEqual([...duplicateLeadIds(leads)].sort(), ['a', 'b'])
  assert.deepEqual([...duplicateLeadIds([])], [])
})

test('duplicate flags carry actual group counts', () => {
  const leads = [
    { id: 'a', company: 'Utah Remodel Works' },
    { id: 'b', company: 'utah remodel works ' },
    { id: 'c', company: 'utah remodel works' },
    { id: 'd', company: 'Roof-It' },
  ]
  const counts = duplicateLeadCounts(leads)
  assert.equal(counts.get('a'), 3)
  assert.equal(counts.get('b'), 3)
  assert.equal(counts.get('c'), 3)
  assert.equal(counts.has('d'), false)
  assert.deepEqual([...duplicateLeadCounts([])].length, 0)
})

test('sidebar counts include starred leads', async () => {
  const { getSidebarCounts } = await import('./workflow.js')
  const counts = getSidebarCounts([{ id: 'a', starred: true }, { id: 'b' }, { id: 'c', starred: false }])
  assert.equal(counts.Starred, 1)
  assert.equal(getSidebarCounts([]).Starred, 0)
})

test('collected date helpers rank unknown dates oldest without fabricating', async () => {
  const { leadCollectedTime, formatCollectedDate, collectedSearchText } = await import('./workflow.js')
  const dated = { collectedAt: '8/16/2026, 5:23:25 AM' }
  assert.ok(leadCollectedTime(dated) > 0)
  assert.equal(formatCollectedDate(dated), 'Aug 16, 2026')
  assert.equal(leadCollectedTime({}), 0)
  assert.equal(leadCollectedTime({ collectedAt: 'not a date' }), 0)
  assert.equal(leadCollectedTime(null), 0)
  assert.equal(formatCollectedDate({}), '—')
  assert.equal(formatCollectedDate({ collectedAt: 'not a date' }), '—')
  const rows = [{ id: 'a' }, { id: 'b', collectedAt: '8/16/2026, 5:23:25 AM' }, { id: 'c', collectedAt: '9/1/2026, 1:00:00 PM' }]
  const newest = [...rows].sort((a, b) => leadCollectedTime(b) - leadCollectedTime(a)).map((row) => row.id)
  assert.deepEqual(newest, ['c', 'b', 'a'])
  assert.equal(collectedSearchText({ collectedAt: '8/16/2026, 5:23:25 AM' }), 'August 2026 Aug 2026')
  assert.equal(collectedSearchText({}), '')
})
