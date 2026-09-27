import test from 'node:test'
import assert from 'node:assert/strict'
import { nightOf, nightlyIdempotencyKey, planNight, summarizeNight } from './nightly.js'

const market = {
  id: 'slc',
  areas: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name })),
  categories: ['roof', 'hvac', 'floor', 'plumb'],
}

test('rotation advances areas nightly and categories when areas wrap (old state file works)', () => {
  const first = planNight(market, { areaCursor: 0, categoryCursor: 0 }, { night: '2026-09-28' })
  assert.deepEqual(first.areas, ['A', 'B'])
  assert.deepEqual(first.categories, ['roof', 'hvac', 'floor'])
  assert.deepEqual([first.nextState.areaCursor, first.nextState.categoryCursor], [2, 0])
  const third = planNight(market, { areaCursor: 4, categoryCursor: 0 }, { night: '2026-09-30' })
  assert.deepEqual(third.areas, ['E', 'A'])
  assert.deepEqual([third.nextState.areaCursor, third.nextState.categoryCursor], [1, 3])
  assert.deepEqual(planNight(market, third.nextState, { night: '2026-10-01' }).categories, ['plumb', 'roof', 'hvac'])
})

test('a rerun on the same night repeats the slice instead of advancing', () => {
  const planned = planNight(market, {}, { night: '2026-09-28' })
  const again = planNight(market, planned.nextState, { night: '2026-09-28' })
  assert.equal(again.repeat, true)
  assert.deepEqual(again.areas, planned.areas)
  assert.deepEqual(again.nextState, planned.nextState)
  assert.equal(planNight(market, planned.nextState, { night: '2026-09-29' }).repeat, false)
  assert.equal(nightlyIdempotencyKey('slc', '2026-09-28'), 'nightly:slc:2026-09-28')
})

test('night is the Salt Lake City calendar date', () => {
  // 02:10 in Denver is 08:10 UTC; 23:30 Denver on the 27th is the 28th in UTC.
  assert.equal(nightOf(new Date('2026-09-28T08:10:00Z')), '2026-09-28')
  assert.equal(nightOf(new Date('2026-09-28T05:30:00Z')), '2026-09-27')
})

test('summary counts only leads the runs created, and flags failed or unfinished runs', () => {
  const runs = [{ id: 'r1', status: 'Completed', newClientIds: ['l1', 'l2'] }, { id: 'r2', status: 'Failed', newClientIds: [] }, { id: 'r3', status: 'Running' }]
  const leads = [
    { id: 'l1', qualification: { play: 'redesign', contact: { email: 'a@b.co' } } },
    { id: 'l2', qualification: { play: 'skip', contact: { email: 'c@d.co' } } },
    { id: 'old', qualification: { play: 'audit', contact: { email: 'e@f.co' } } },
  ]
  assert.deepEqual(summarizeNight({ runs, leads }), { newLeads: 2, plays: { redesign: 1, skip: 1 }, pitchableWithEmail: 1, failedRuns: ['r2'], unfinished: ['r3'] })
})
