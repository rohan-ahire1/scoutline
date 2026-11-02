import test from 'node:test'
import assert from 'node:assert/strict'
import { nightOf, nightlyIdempotencyKey, planNight, planRotation, summarizeNight } from './nightly.js'

const market = {
  id: 'slc',
  areas: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name })),
  categories: ['roof', 'hvac', 'floor', 'plumb'],
}

test('rotation advances areas nightly and categories when areas run out', () => {
  const first = planNight(market, { areaCursor: 0, categoryCursor: 0 }, { night: '2026-09-28' })
  assert.deepEqual(first.areas, ['A', 'B'])
  assert.deepEqual(first.categories, ['roof', 'hvac', 'floor'])
  assert.deepEqual([first.nextState.areaCursor, first.nextState.categoryCursor], [2, 0])
  const third = planNight(market, { areaCursor: 4, categoryCursor: 0 }, { night: '2026-09-30' })
  assert.deepEqual(third.areas, ['E'])
  assert.deepEqual([third.nextState.areaCursor, third.nextState.categoryCursor], [0, 3])
  assert.equal(third.passDone, false)
  const last = planNight(market, third.nextState, { night: '2026-10-01' })
  assert.deepEqual(last.categories, ['plumb', 'roof', 'hvac'])
  assert.equal(planNight(market, { areaCursor: 4, categoryCursor: 3 }, { night: '2026-10-02' }).passDone, true)
})

const city = (id, extra = {}) => ({ ...market, id, enabled: true, ...extra })
const threeByThree = { areasPerNight: 3, categoriesPerNight: 3 }

test('rotation searches a market once, then moves on for good', () => {
  const markets = [city('a', { categories: ['roof', 'hvac', 'floor'] }), city('b')]
  const first = planRotation(markets, {}, { ...threeByThree, night: '2026-11-01' })
  assert.equal(first.market.id, 'a')
  assert.deepEqual(first.areas, ['A', 'B', 'C'])
  const second = planRotation(markets, first.nextState, { ...threeByThree, night: '2026-11-02' })
  assert.equal(second.market.id, 'a')
  assert.deepEqual(second.areas, ['D', 'E'])
  assert.deepEqual(second.nextState.finished, ['a'])
  const third = planRotation(markets, second.nextState, { ...threeByThree, night: '2026-11-03' })
  assert.equal(third.market.id, 'b')
  assert.deepEqual(third.areas, ['A', 'B', 'C'])
  assert.deepEqual(third.categories, ['roof', 'hvac', 'floor'])
  assert.deepEqual([third.nextState.areaCursor, third.nextState.categoryCursor], [3, 0])
})

test('a rerun keeps the market, even on the night it finished', () => {
  const markets = [city('a', { categories: ['roof', 'hvac', 'floor'] }), city('b')]
  const planned = planRotation(markets, { marketId: 'a', areaCursor: 3 }, { ...threeByThree, night: '2026-11-02' })
  assert.deepEqual(planned.nextState.finished, ['a'])
  const again = planRotation(markets, planned.nextState, { ...threeByThree, night: '2026-11-02' })
  assert.equal(again.repeat, true)
  assert.equal(again.market.id, 'a')
  assert.deepEqual(again.areas, ['D', 'E'])
})

test('an old state file starts at the first enabled market', () => {
  const markets = [city('slc', { enabled: false }), city('nyc')]
  const old = { areaCursor: 8, categoryCursor: 6, night: '2026-10-30', slice: { areas: ['X'], categories: ['y'] } }
  const plan = planRotation(markets, old, { night: '2026-11-01' })
  assert.equal(plan.market.id, 'nyc')
  assert.deepEqual(plan.areas, ['A', 'B'])
})

test('more areas a night picks up where the rotation left off', () => {
  const planned = planRotation([city('a')], {}, { areasPerNight: 2, night: '2026-11-01' })
  assert.deepEqual(planRotation([city('a')], planned.nextState, { areasPerNight: 6, night: '2026-11-02' }).areas, ['C', 'D', 'E'])
})

test('the rotation ends when every enabled market is finished', () => {
  const markets = [city('a'), city('b', { enabled: false }), city('c', { areas: [] })]
  assert.equal(planRotation(markets, { finished: ['a'] }, { night: '2026-11-01' }), null)
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
