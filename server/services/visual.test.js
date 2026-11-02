import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewScreenshots } from './visual.js'

const review = { looksDated: 3, visualPolish: 3, mobileExperience: 3, clarity: 3, trust: 3, eraGuess: '2015', verdict: 'improve', issues: [], strengths: [], summary: 'ok' }

async function promptFor(shot) {
  let seen = null
  const client = { chat: { completions: { create: async (request) => {
    seen = request
    return { choices: [{ message: { content: JSON.stringify(review) } }] }
  } } } }
  const view = { fold: Buffer.from('x'), full: Buffer.from('x'), overlays: [], ...shot }
  await reviewScreenshots({ desktop: view, mobile: view }, { company: 'Harris Air' }, { metaApiKey: 'test', client })
  return seen.messages[0].content[0].text
}

test('the review is told not to report blank areas or use harsh words', async () => {
  const prompt = await promptFor({})
  assert.match(prompt, /Never report a blank, black or empty area/)
  assert.match(prompt, /never call anything cheap/)
  assert.match(prompt, /never "hero"/)
  assert.doesNotMatch(prompt, /This page has video/)
})

test('the review is told when a page has video', async () => {
  assert.match(await promptFor({ videos: 1 }), /This page has video/)
})
