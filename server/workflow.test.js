import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLeadWorkflowChanges, normalizeLeadWorkflow } from './workflow.js'

test('migrates legacy approved clients into the qualified pipeline stage', () => {
  const lead = normalizeLeadWorkflow({ id: 'lead-1', researchStatus: 'Shortlisted', opportunityScore: 80, salesStage: 'Approved' }, '2026-08-16T00:00:00.000Z')
  assert.equal(lead.researchStatus, 'Analyzed')
  assert.equal(lead.salesStage, 'Qualified')
  assert.equal(lead.qualified, true)
})

test('qualifying a reviewed client immediately adds it to the pipeline', () => {
  const lead = applyLeadWorkflowChanges({ id: 'lead-2', researchStatus: 'Analyzed', salesStage: null }, { qualified: true }, '2026-08-16T00:00:00.000Z')
  assert.equal(lead.salesStage, 'Qualified')
  assert.equal(lead.qualifiedAt, '2026-08-16T00:00:00.000Z')
})

test('moving a client to any sales stage records it as qualified', () => {
  const lead = applyLeadWorkflowChanges({ id: 'lead-3', researchStatus: 'Analyzed', qualified: false }, { salesStage: 'Meeting' }, '2026-08-16T00:00:00.000Z')
  assert.equal(lead.qualified, true)
  assert.equal(lead.salesStage, 'Meeting')
})

