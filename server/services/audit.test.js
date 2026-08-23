import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHtml, assertPublicUrl, extractInternalLinks, isPrivateAddress, normalizeWebsite } from './audit.js'

test('normalizes public website inputs', () => {
  assert.equal(normalizeWebsite('example.com').href, 'https://example.com/')
  assert.throws(() => normalizeWebsite('file:///tmp/private'), /Only HTTP and HTTPS/)
})

test('blocks local and private targets before a fetch', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('10.4.3.2'), true)
  assert.equal(isPrivateAddress('192.168.1.8'), true)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  await assert.rejects(() => assertPublicUrl('http://localhost:8787'), (error) => error.code === 'PRIVATE_NETWORK')
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1'), (error) => error.code === 'PRIVATE_NETWORK')
})

test('turns observable homepage markup into evidence and a score', () => {
  const result = analyzeHtml('<html><head><title>Acme</title></head><body><h1>Roofing</h1><form><input><input><input><input><input><input><input><input><input></form><img src="hero.jpg"></body></html>', new URL('https://example.com/'))
  assert.equal(result.analysisSource, 'Deterministic website audit')
  assert.ok(result.opportunityScore >= 60)
  assert.ok(result.problems.some((problem) => /form asks for many details/i.test(problem)))
  assert.ok(result.evidence.some((item) => /Form field count/i.test(item)))
})

test('extracts safe same-site crawl candidates without action routes', () => {
  const links = extractInternalLinks(`
    <a href="/services">Services</a>
    <a href="https://example.com/services#roofing">Duplicate</a>
    <a href="/contact?from=home">Contact</a>
    <a href="/logout">Logout</a>
    <a href="https://other.example/about">External</a>
  `, new URL('https://example.com/'))
  assert.deepEqual(links.map((url) => url.href), ['https://example.com/services', 'https://example.com/contact?from=home'])
})
