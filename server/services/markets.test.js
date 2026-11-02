import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MARKETS } from './markets.js'
import { MARKET_TIMEZONES } from './sender.js'

test('every market has a real time zone and areas inside the US', () => {
  for (const market of DEFAULT_MARKETS) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: market.timeZone }), market.id)
    assert.ok(market.areas.length, market.id)
    for (const area of market.areas) {
      assert.ok(area.latitude > 24 && area.latitude < 50, area.name)
      assert.ok(area.longitude > -125 && area.longitude < -66, area.name)
    }
  }
})

test('market ids and area names are unique', () => {
  const ids = DEFAULT_MARKETS.map((market) => market.id)
  const areas = DEFAULT_MARKETS.flatMap((market) => market.areas.map((area) => area.name))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(areas).size, areas.length)
})

test('leads email on their own market time', () => {
  assert.equal(MARKET_TIMEZONES.slc, 'America/Denver')
  assert.equal(MARKET_TIMEZONES.nyc, 'America/New_York')
  assert.equal(MARKET_TIMEZONES.phx, 'America/Phoenix')
})

test('Salt Lake stays out of the rotation and the next market is ready', () => {
  assert.equal(DEFAULT_MARKETS.find((market) => market.id === 'slc').enabled, false)
  assert.equal(DEFAULT_MARKETS.find((market) => market.enabled).id, 'nyc')
})
