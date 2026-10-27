import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkConcept, conceptCandidates, conceptFacts, conceptKey, conceptPreviewHtml, conceptPrompt, generateConcept, imageCandidates, publishConcept, takenKeys } from './concept.js'

const lead = {
  id: 'lead-1',
  company: 'Harris Air Systems, Inc.',
  category: 'HVAC contractor',
  location: '123 Main St, Murray, UT 84107, United States',
  phone: '(801) 555-0142',
  email: 'karli@harrisair.example',
  website: 'harrisair.example',
  rating: 4.8,
  reviews: 210,
  visualReview: { issues: ['Full-screen popup on arrival'], eraGuess: '2015' },
  qualification: { play: 'redesign', priority: 70, contact: { email: 'karli@harrisair.example' } },
}

const goodPage = (extra = '') => `<!doctype html><html><head><title>Harris Air Systems | HVAC in Murray</title>
<meta name="robots" content="noindex, nofollow"></head><body>
<div>A redesign concept by <a href="https://goodshigoto.com">GoodShigoto</a> · Not the live website.</div>
<a href="tel:+18015550142">(801) 555-0142</a><img src="assets/logo.png" alt="">
<form><input name="name"></form>${extra}</body></html>`

function site(html, files = ['assets/logo.png']) {
  const dir = mkdtempSync(join(tmpdir(), 'concept-'))
  mkdirSync(join(dir, 'assets'))
  for (const file of files) writeFileSync(join(dir, file), 'x')
  writeFileSync(join(dir, 'index.html'), html)
  return dir
}

test('concept keys are short, readable and unique', () => {
  assert.equal(conceptKey('Harris Air Systems, Inc.'), 'harrisair')
  assert.equal(conceptKey('A H Bracken Construction'), 'brackenconstruction')
  assert.equal(conceptKey("Larry's Lawns LLC"), 'larryslawns')
  assert.equal(conceptKey('Harris Air', new Set(['harrisair'])), 'harrisair2')
  assert.equal(conceptKey('1st Choice Roofing'), 'c1stchoice')
  assert.equal(conceptKey('&&&'), 'concept')
})

test('facts carry only what we collected', () => {
  const facts = conceptFacts(lead, { pages: [{ finalUrl: 'https://harrisair.example', title: 'Home', h1: 'Heating', textExcerpt: 'We repair furnaces.' }] })
  assert.equal(facts.city, 'Murray')
  assert.equal(facts.website, 'https://harrisair.example')
  assert.deepEqual(facts.currentSiteProblems, ['Full-screen popup on arrival'])
  assert.equal(facts.pages[0].text, 'We repair furnaces.')
  assert.equal(conceptFacts({ ...lead, phone: 'Not collected', email: '' }).phone, null)
})

test('the prompt names the real phone and forbids invented claims', () => {
  const prompt = conceptPrompt({ facts: conceptFacts(lead), images: [{ file: 'assets/logo.png', role: 'logo', bytes: 4096 }], key: 'harrisair' })
  assert.match(prompt, /\(801\) 555-0142/)
  assert.match(prompt, /Do not invent/)
  assert.match(prompt, /https:\/\/harrisair\.goodshigoto\.com/)
  assert.match(prompt, /assets\/logo\.png \(logo, 4 KB\)/)
})

test('image candidates put the logo first and skip badges and pixels', () => {
  const html = `<meta property="og:image" content="/og.jpg"><img src="/hero.jpg"><img class="site-logo" src="/logo.png"><img src="https://www.facebook.com/tr?id=1"><img src="/bbb-seal.png"><img src="/tiny.jpg" width="40">`
  assert.deepEqual(imageCandidates(html, 'https://a.example/').map((item) => [item.url, item.role]), [
    ['https://a.example/logo.png', 'logo'],
    ['https://a.example/og.jpg', 'social'],
    ['https://a.example/hero.jpg', 'photo'],
  ])
})

test('a clean page passes the checks', () => {
  assert.deepEqual(checkConcept(site(goodPage()), conceptFacts(lead)), [])
})

test('checks catch wrong numbers, invented emails, external code and missing parts', () => {
  const facts = conceptFacts(lead)
  const bad = site(`<html><head><title>Cool HVAC</title></head><body>Call 801-555-9999 or bob@other.example
<a href="tel:8015559999">call</a><script src="https://cdn.example/x.js"></script><form action="https://evil.example/collect"></form>
<img src="assets/missing.jpg"><img src="https://other.example/a.jpg"> Lorem ipsum</body></html>`)
  const problems = checkConcept(bad, facts).join('\n')
  for (const expected of [/concept by GoodShigoto/, /noindex/, /title does not name/, /dials 8015559999/, /not theirs: 8015559999/, /bob@other\.example/, /External script/, /submits to/, /missing: assets\/missing\.jpg/, /another site/, /placeholder/]) {
    assert.match(problems, expected)
  }
  assert.deepEqual(checkConcept(mkdtempSync(join(tmpdir(), 'concept-')), facts), ['No index.html was written'])
})

test('an image path cannot point outside the site folder', () => {
  const problems = checkConcept(site(goodPage('<img src="../../facts.json">')), conceptFacts(lead))
  assert.match(problems.join('\n'), /missing: \.\.\/\.\.\/facts\.json/)
})

test('generateConcept writes facts, runs the agent and strips stray files', async () => {
  const leadDir = mkdtempSync(join(tmpdir(), 'lead-'))
  let seen = null
  const concept = await generateConcept(lead, {
    leadDir,
    key: 'harrisair',
    collect: async (_url, dir) => { writeFileSync(join(dir, 'assets', 'logo.png'), 'x'); return [{ file: 'assets/logo.png', role: 'logo', bytes: 1 }] },
    run: async ({ cwd, prompt }) => {
      seen = { cwd, prompt }
      writeFileSync(join(cwd, 'site', 'index.html'), goodPage())
      writeFileSync(join(cwd, 'site', 'notes.md'), 'draft')
      return { costUsd: 0.4, durationMs: 1000, turns: 9 }
    },
  })
  assert.equal(seen.cwd, join(leadDir, 'concept'))
  assert.equal(JSON.parse(readFileSync(join(leadDir, 'concept', 'facts.json'), 'utf8')).images.length, 1)
  assert.equal(existsSync(join(leadDir, 'concept', 'site', 'notes.md')), false)
  assert.equal(concept.status, 'review')
  assert.equal(concept.url, 'https://harrisair.goodshigoto.com')
  assert.deepEqual(concept.problems, [])
})

test('publishing replaces the live folder in one step', () => {
  const webRoot = mkdtempSync(join(tmpdir(), 'web-'))
  const first = publishConcept({ siteDir: site(goodPage('v1')), key: 'harrisair', webRoot })
  publishConcept({ siteDir: site(goodPage('v2')), key: 'harrisair', webRoot })
  assert.equal(first.url, 'https://harrisair.goodshigoto.com')
  assert.match(readFileSync(join(webRoot, 'harrisair.goodshigoto.com', 'index.html'), 'utf8'), /v2/)
  assert.throws(() => publishConcept({ siteDir: site(goodPage()), key: '../etc', webRoot }), /Invalid concept key/)
  assert.ok(takenKeys([], { webRoot }).has('harrisair'))
})

test('candidates are redesign leads with an email and no concept, best first', () => {
  const leads = [
    { ...lead, id: 'a', qualification: { ...lead.qualification, priority: 40 } },
    { ...lead, id: 'b' },
    { ...lead, id: 'c', concept: { status: 'review' } },
    { ...lead, id: 'd', concept: { status: 'failed' }, qualification: { ...lead.qualification, priority: 10 } },
    { ...lead, id: 'e', qualification: { play: 'audit', priority: 99, contact: { email: 'x@y.example' } } },
    { ...lead, id: 'f', qualification: { ...lead.qualification, contact: { email: null } } },
  ]
  assert.deepEqual(conceptCandidates(leads).map((item) => item.id), ['b', 'a', 'd'])
  assert.deepEqual(conceptCandidates(leads, { limit: 1 }).map((item) => item.id), ['b'])
})

test('the preview inlines the page images', () => {
  const dir = site(goodPage('<div style="background:url(assets/logo.png)"></div><img src="assets/nope.png">'))
  const html = conceptPreviewHtml(dir)
  assert.equal((html.match(/data:image\/png;base64,eA==/g) || []).length, 2)
  assert.match(html, /src="assets\/nope\.png"/)
  assert.equal(conceptPreviewHtml(mkdtempSync(join(tmpdir(), 'concept-'))), null)
})
