import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  funnelShare, funnelStages, outreachGroups, pipelineColumns, previewScreens,
} from './mockData.js'

describe('concept preview data', () => {
  it('funnel shares derive from the lead total', () => {
    assert.equal(funnelShare(142), 100)
    assert.equal(funnelShare(96), 68)
    assert.equal(funnelShare(48), 34)
    assert.equal(funnelShare(12), 8)
    assert.deepEqual(funnelStages.map((s) => s.label), ['Leads', 'Contacted', 'Qualified', 'Proposal', 'Closed Won'])
  })

  it('outreach group counts match their tasks', () => {
    for (const group of outreachGroups) assert.equal(group.count, group.tasks.length)
  })

  it('pipeline column counts cover their sample deals', () => {
    for (const column of pipelineColumns) assert.ok(column.count >= column.deals.length, column.stage)
  })

  it('every preview screen id is unique', () => {
    const ids = previewScreens.map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})
