import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  auditIdForJob,
  buildAuditManifest,
  listAuditManifests,
  loadAuditForSynthesis,
  renderLeadReportMarkdown,
  saveAuditArtifacts,
  sha256Hex,
  writeFileAtomic,
} from './artifacts.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'scout-artifacts-'))
}

const auditData = {
  opportunityScore: 70, confidence: 80, researchStatus: 'Analyzed',
  auditedAt: '2026-09-05T00:00:00.000Z', auditedUrl: 'https://acme.example/',
  problems: ['Slow mobile load'], evidence: ['Performance 42/100'],
}

test('versioned artifacts link content hashes and the manifest is complete', () => {
  const root = tempRoot()
  const report = { lhr: { categories: { performance: { score: 0.42 } } } }
  const { manifest } = saveAuditArtifacts({ dataDir: root, leadId: 'lead-1', auditId: 'audit-job-1', auditVersion: 1, auditData, lighthouseReport: report })
  assert.equal(manifest.auditId, 'audit-job-1')
  assert.equal(manifest.status, 'complete')
  assert.ok(existsSync(join(root, 'leads', 'lead-1', 'audits', 'audit-job-1', 'audit.json')))
  assert.ok(existsSync(join(root, 'leads', 'lead-1', 'audits', 'audit-job-1', 'lighthouse.json')))
  assert.ok(existsSync(join(root, 'leads', 'lead-1', 'audits', 'audit-job-1', 'manifest.json')))
  assert.equal(manifest.artifacts.auditJson.sha256, sha256Hex(JSON.stringify(auditData, null, 2)))
  assert.equal(manifest.contentHashes.lighthouse, sha256Hex(JSON.stringify(report)))
})

test('a failed Lighthouse attempt never backfills from an older file', () => {
  const root = tempRoot()
  const folder = join(root, 'leads', 'lead-1')
  mkdirSync(folder, { recursive: true })
  // Stale root file from a previous successful attempt.
  writeFileSync(join(folder, 'lighthouse.json'), JSON.stringify({ stale: true }), 'utf8')
  saveAuditArtifacts({ dataDir: root, leadId: 'lead-1', auditId: 'audit-a', auditVersion: 1, auditData, lighthouseReport: { fresh: 1 } })
  const { manifest: manifestB } = saveAuditArtifacts({ dataDir: root, leadId: 'lead-1', auditId: 'audit-b', auditVersion: 2, auditData, lighthouseReport: null })
  assert.ok(manifestB.artifacts.lighthouseJson.missing)
  assert.ok(!existsSync(join(root, 'leads', 'lead-1', 'audits', 'audit-b', 'lighthouse.json')))
  const loaded = loadAuditForSynthesis({ dataDir: root, lead: { id: 'lead-1', currentAuditId: 'audit-b' } })
  assert.equal(loaded.lighthouseReport, null)
  assert.equal(loaded.provenance, 'current')
  assert.equal(loaded.audit.opportunityScore, 70)
})

test('a crash between writes and manifest leaves recoverable state, not false completion', () => {
  const root = tempRoot()
  const dir = join(root, 'leads', 'lead-1', 'audits', 'audit-crash')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'audit.json'), JSON.stringify(auditData), 'utf8')
  // No manifest.json: synthesis must refuse, not trust the partial directory.
  assert.throws(() => loadAuditForSynthesis({ dataDir: root, lead: { id: 'lead-1', currentAuditId: 'audit-crash' } }), /incomplete or missing/)
  assert.deepEqual(listAuditManifests(root, 'lead-1'), [])
})

test('legacy records load with provenance unknown', () => {
  const root = tempRoot()
  const folder = join(root, 'leads', 'lead-9')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'audit.json'), JSON.stringify({ opportunityScore: 55 }), 'utf8')
  const loaded = loadAuditForSynthesis({ dataDir: root, lead: { id: 'lead-9' } })
  assert.equal(loaded.provenance, 'legacy-unversioned')
  assert.equal(loaded.historical, true)
  assert.equal(loaded.audit.opportunityScore, 55)
  assert.throws(() => loadAuditForSynthesis({ dataDir: root, lead: { id: 'lead-empty' }, rootFallback: true }), /No audit artifacts/)
})

test('manual notes never replace the findings report', () => {
  const md = renderLeadReportMarkdown({
    company: 'Acme', mainIssue: 'Slow load', issueDetail: 'LCP 5s', problems: ['Slow mobile load'],
    evidence: ['Performance 42/100'], opportunityScore: 70, confidence: 80, researchStatus: 'Analyzed',
    notes: 'Called the owner; prefers email contact.',
  }, { manifest: null })
  assert.match(md, /## Reviewer notes/)
  assert.match(md, /prefers email contact/)
  const findings = md.split('## Findings')[1].split('## Evidence')[0]
  assert.match(findings, /Slow mobile load/)
  assert.doesNotMatch(findings, /prefers email/)
})

test('atomic writes never leave truncated advertised files', () => {
  const root = tempRoot()
  writeFileAtomic(root, 'report.md', '# hello')
  assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), '# hello')
  assert.equal(auditIdForJob('job 1/2'), 'audit-job-1-2')
  assert.ok(buildAuditManifest({ auditId: 'a', auditVersion: 1, result: auditData, lighthouseReport: null, files: { auditJson: { path: 'x' } } }).artifacts.lighthouseJson.missing)
})
