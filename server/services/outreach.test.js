import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalOutreach, extractResponseText, getOutreachConfig, wordCount } from './outreach.js'

const lead = {
  company: 'Acme Roofing',
  mainIssue: 'Enquiry friction',
  issueDetail: 'The quote form is too long.',
  problems: ['The quote form asks for 12 fields', 'No clear mobile call to action', 'No warranty information near the enquiry'],
}

test('local outreach keeps the three versions meaningfully different', () => {
  const result = createLocalOutreach(lead)
  const counts = Object.fromEntries(Object.entries(result.drafts).map(([key, value]) => [key, wordCount(value)]))
  assert.ok(counts.Concise >= 45 && counts.Concise <= 65, `concise was ${counts.Concise} words`)
  assert.ok(counts.Balanced >= 95 && counts.Balanced <= 125, `balanced was ${counts.Balanced} words`)
  assert.ok(counts.Detailed >= 180 && counts.Detailed <= 250, `detailed was ${counts.Detailed} words`)
  assert.ok(counts.Detailed > counts.Balanced + 60)
  assert.ok(counts.Balanced > counts.Concise + 30)
})

test('Meta Model API takes priority when both model providers are configured', () => {
  const config = getOutreachConfig({ metaApiKey: 'meta-test-key', apiKey: 'openai-test-key' })
  assert.equal(config.provider, 'meta')
  assert.equal(config.providerLabel, 'Meta Model API')
  assert.equal(config.model, 'muse-spark-1.2-contributor')
  assert.equal(config.baseURL, 'https://api.meta.ai/v1')
})

test('extracts text from Meta-compatible nested response content', () => {
  const text = extractResponseText({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"subject":"Hello"}' }] }] })
  assert.equal(text, '{"subject":"Hello"}')
})
