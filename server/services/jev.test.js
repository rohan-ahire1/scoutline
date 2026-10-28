import test from 'node:test'
import assert from 'node:assert/strict'
import { askJev, asChoice, getJevConfig, JEV_ENDPOINT } from './jev.js'

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('Jev is off without a key and on with one', () => {
  withEnv({ TYPESAFE_API_KEY: undefined, JEV_MODEL: undefined, JEV_PASS_THRESHOLD: undefined }, () => {
    assert.equal(getJevConfig().configured, false)
    const config = getJevConfig({ jevApiKey: 'k' })
    assert.equal(config.configured, true)
    assert.equal(config.model, 'jev-latest')
    assert.equal(config.passThreshold, 0.8)
  })
})

test('jev: false turns the gate off even with a key in the environment', () => {
  withEnv({ TYPESAFE_API_KEY: 'k' }, () => {
    assert.equal(getJevConfig().configured, true)
    assert.equal(getJevConfig({ jev: false }).configured, false)
  })
})

test('the Pass threshold is configurable and invalid values fall back to 0.8', () => {
  withEnv({ JEV_PASS_THRESHOLD: '0.9' }, () => assert.equal(getJevConfig({ jevApiKey: 'k' }).passThreshold, 0.9))
  for (const bad of ['abc', '0', '1.5', '-1']) {
    withEnv({ JEV_PASS_THRESHOLD: bad }, () => assert.equal(getJevConfig({ jevApiKey: 'k' }).passThreshold, 0.8))
  }
})

test('askJev posts state, model and questions with Bearer auth', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ model: 'jev-latest', answers: { q: { type: 'choice', choice: 'A', probabilities: { A: 1 }, confidence: 0.9 } } }), { status: 200 })
  }
  const questions = { q: { type: 'choice', instructions: 'Pick', criteria: { A: 'a', B: 'b' } } }
  const response = await askJev({ apiKey: 'secret', model: 'jev-latest', state: 'text', questions, fetchImpl })
  assert.equal(calls[0].url, JEV_ENDPOINT)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: 'text', model: 'jev-latest', questions })
  assert.equal(asChoice(response.answers.q, 'q').choice, 'A')
})

test('askJev throws on a non-2xx response', async () => {
  const fetchImpl = async () => new Response('bad key', { status: 401 })
  await assert.rejects(() => askJev({ apiKey: 'x', state: 's', questions: {}, fetchImpl }), /Jev API 401: bad key/)
})

test('asChoice rejects answers that are not choices', () => {
  assert.throws(() => asChoice(undefined, 'q'), /not a choice answer/)
  assert.throws(() => asChoice({ type: 'noul', noul: 0.5 }, 'q'), /not a choice answer/)
})
