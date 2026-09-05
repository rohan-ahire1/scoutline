import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptOutreachCandidate, applyOutreachGeneration, assertNoInventedClaims, buildObservations, createLocalOutreach, dismissOutreachCandidates, extractResponseText, getOutreachConfig, validateGeneratedOutreach, wordCount } from './outreach.js'

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

test('one observation never expands into three alleged defects', () => {
  const result = createLocalOutreach({ company: 'Acme Roofing', auditVersion: 3, problems: ['The homepage description is missing'], issueDetail: 'The homepage description is missing' })
  assert.equal(result.insufficientEvidence, false)
  assert.deepEqual(result.findings, ['The homepage description is missing'])
  const text = Object.values(result.drafts).join('\n')
  assert.doesNotMatch(text, /next step is not prominent/i)
  assert.doesNotMatch(text, /trust proof could be placed closer/i)
  assert.deepEqual(result.generation.observationIds, ['obs-3-1'])
})

test('two observations stay two without invented padding', () => {
  const result = createLocalOutreach({ company: 'Acme', auditVersion: 1, problems: ['First finding here', 'Second finding here'] })
  assert.equal(result.findings.length, 2)
  const text = Object.values(result.drafts).join('\n')
  assert.doesNotMatch(text, /customer journey could be clearer/i)
  assert.doesNotMatch(text, /trust proof/i)
})

test('zero observations return insufficient evidence instead of a redesign claim', () => {
  const result = createLocalOutreach({ company: 'Acme', problems: [], issueDetail: '' })
  assert.equal(result.insufficientEvidence, true)
  assert.equal(result.drafts, null)
  assert.deepEqual(result.findings, [])
  assert.match(result.reason, /no outreach claim can be supported/i)
  assert.doesNotMatch(result.reason, /redesign is needed/i)
})

test('observation IDs are stable and scoped to the audit version', () => {
  const first = buildObservations({ auditVersion: 7, problems: ['Alpha finding', 'Beta finding'] })
  assert.deepEqual(first.map((item) => item.id), ['obs-7-1', 'obs-7-2'])
  const legacy = buildObservations({ problems: ['Alpha finding'] })
  assert.deepEqual(legacy.map((item) => item.id), ['obs-legacy-1'])
})

test('invented business outcomes fail validation with actionable errors', () => {
  assert.throws(() => assertNoInventedClaims('This will add $50,000 in revenue next quarter', 'draft'), /monetary amount|revenue figure/)
  assert.throws(() => assertNoInventedClaims('We guarantee first-page rankings', 'draft'), /guarantee/)
  assert.throws(() => assertNoInventedClaims('This will double your traffic in 30 days', 'draft'), /promised business outcome/)
  assert.equal(assertNoInventedClaims('I would simplify the mobile hierarchy and keep the primary action visible.', 'draft'), true)
})

test('malformed or ungrounded AI outreach fails instead of saving', () => {
  assert.throws(() => validateGeneratedOutreach(null), /invalid outreach payload/)
  assert.throws(() => validateGeneratedOutreach({ subject: 'Hi', drafts: { Concise: 'Short draft here for testing purposes only' } }), /did not return a balanced draft/)
  assert.throws(() => validateGeneratedOutreach({
    subject: 'Quick idea',
    drafts: { Concise: 'A calm factual draft about the homepage description with enough words to pass length checks here.', Balanced: 'A calm factual draft about the homepage description with enough words to pass length checks here.', Detailed: 'We guarantee $90,000 in new revenue within weeks of launch, definitely and assuredly.' },
  }), /guarantee|monetary amount|revenue figure/)
})

test('regeneration preserves edited drafts as explicit candidates', () => {
  const lead = { company: 'Acme', outreachDraft: 'My hand-edited wording', outreachDrafts: { Concise: 'My hand-edited wording' }, outreachVersion: 'Concise', outreachEdited: true, outreachStatus: 'Draft' }
  const fresh = { subject: 'Quick idea for Acme', drafts: { Concise: 'Fresh one', Balanced: 'Fresh two', Detailed: 'Fresh three' }, findings: ['Finding'], generation: { source: 'rules' } }
  const applied = applyOutreachGeneration(lead, fresh, { selectedVersion: 'Concise' })
  assert.equal(applied.outreachDraft, undefined)
  assert.equal(applied.outreachUpdateAvailable, true)
  assert.equal(applied.outreachCandidates.length, 1)
  const accepted = acceptOutreachCandidate({ ...lead, ...applied }, 0)
  assert.equal(accepted.outreachDraft, 'Fresh one')
  assert.equal(accepted.outreachEdited, false)
  assert.equal(accepted.outreachCandidates.length, 0)
  assert.throws(() => acceptOutreachCandidate({ ...lead, outreachCandidates: [] }, 0), /No generated outreach candidate/)
  assert.deepEqual(dismissOutreachCandidates({ ...lead, ...applied }), { outreachCandidates: [], outreachUpdateAvailable: false })
})

test('insufficient evidence never overwrites existing drafts', () => {
  const lead = { company: 'Acme', outreachDraft: 'Existing draft', outreachDrafts: { Concise: 'Existing draft' }, outreachStatus: 'Draft' }
  const applied = applyOutreachGeneration(lead, { subject: 'Quick idea for Acme', drafts: null, findings: [], insufficientEvidence: true, reason: 'No verified findings', generation: { source: 'rules' } })
  assert.equal(applied.outreachDraft, undefined)
  assert.equal(applied.outreachStatus, 'Draft')
  const bare = applyOutreachGeneration({ company: 'Acme' }, { subject: 'Quick idea for Acme', drafts: null, findings: [], insufficientEvidence: true, reason: 'No verified findings', generation: { source: 'rules' } })
  assert.equal(bare.outreachStatus, 'Insufficient evidence')
})
