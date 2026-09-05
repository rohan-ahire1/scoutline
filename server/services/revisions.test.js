import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  acceptOutreachCandidate,
  buildRefreshPatch,
  dismissOutreachCandidates,
  getRev,
  resolveOutreachCompletion,
  resolveSynthesisCompletion,
  RevisionConflictError,
  updateLeadFields,
} from './revisions.js'

function memoryDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE leads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  return db
}

function seed(db, lead) {
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run(lead.id, JSON.stringify(lead))
  return lead
}

test('revisions start at zero and bump on every field-scoped update', () => {
  const db = memoryDb()
  seed(db, { id: 'a', company: 'Acme', notes: 'hi' })
  assert.equal(getRev({}), 0)
  const first = updateLeadFields(db, 'a', { notes: 'one' })
  assert.equal(first.rev, 1)
  assert.equal(first.notes, 'one')
  assert.equal(first.company, 'Acme')
  const second = updateLeadFields(db, 'a', { salesStage: 'Qualified' })
  assert.equal(second.rev, 2)
  db.close()
})

test('a stale expected revision fails loudly instead of overwriting', () => {
  const db = memoryDb()
  seed(db, { id: 'a', company: 'Acme', rev: 4 })
  assert.throws(() => updateLeadFields(db, 'a', { notes: 'stale' }, { expectedRev: 3 }), (error) => {
    assert.ok(error instanceof RevisionConflictError)
    assert.equal(error.code, 'REVISION_CONFLICT')
    assert.equal(error.status, 409)
    assert.equal(error.expectedRev, 3)
    assert.equal(error.rev, 4)
    return true
  })
  const row = JSON.parse(db.prepare('SELECT payload FROM leads WHERE id = ?').get('a').payload)
  assert.equal(row.notes, undefined)
  assert.equal(updateLeadFields(db, 'a', { notes: 'fresh' }, { expectedRev: 4 }).rev, 5)
  db.close()
})

test('delayed outreach preserves concurrent notes, stage and contract edits', async () => {
  const db = memoryDb()
  const started = seed(db, { id: 'a', company: 'Acme', outreachStatus: 'Draft' })
  const startedSnap = { rev: getRev(started), outreachDraft: started.outreachDraft }
  // Controlled provider promise, resolved only after the user edits mid-flight.
  let resolveProvider
  const pending = new Promise((resolve) => { resolveProvider = resolve })
  const flight = pending.then(() => ({
    subject: 'Quick idea', drafts: { Concise: 'New one', Balanced: 'New two', Detailed: 'New three' },
    generation: { source: 'rules', generatedAt: '2026-09-05T00:00:01.000Z' },
  }))
  updateLeadFields(db, 'a', { notes: 'Called twice', salesStage: 'Qualified', contract: { amount: 500 } })
  resolveProvider()
  const generated = await flight
  const current = JSON.parse(db.prepare('SELECT payload FROM leads WHERE id = ?').get('a').payload)
  const decision = resolveOutreachCompletion({ started: startedSnap, current, generated, selectedVersion: 'Concise' })
  assert.equal(decision.type, 'apply')
  const next = updateLeadFields(db, 'a', decision.patch)
  assert.equal(next.outreachDraft, 'New one')
  assert.equal(next.notes, 'Called twice')
  assert.equal(next.salesStage, 'Qualified')
  assert.deepEqual(next.contract, { amount: 500 })
  db.close()
})

test('a user-edited draft survives regeneration as an explicit candidate', () => {
  const started = { rev: 0, outreachDraft: 'Generated one' }
  const current = { rev: 2, outreachDraft: 'My hand edit', outreachEdited: true, outreachStatus: 'Draft', notes: 'keep me' }
  const generated = {
    subject: 'Quick idea', drafts: { Concise: 'Fresh one', Balanced: 'Fresh two', Detailed: 'Fresh three' },
    generation: { source: 'rules', generatedAt: '2026-09-05T00:00:02.000Z' },
  }
  const decision = resolveOutreachCompletion({ started, current, generated, selectedVersion: 'Concise' })
  assert.equal(decision.type, 'candidate')
  assert.equal(decision.patch.outreachDraft, undefined)
  assert.equal(decision.patch.outreachCandidates.length, 1)
  const accepted = acceptOutreachCandidate({ ...current, ...decision.patch }, 0)
  assert.equal(accepted.outreachDraft, 'Fresh one')
  assert.equal(accepted.outreachCandidates.length, 0)
  assert.deepEqual(dismissOutreachCandidates(), { outreachCandidates: [], outreachUpdateAvailable: false })
  assert.throws(() => acceptOutreachCandidate({ outreachCandidates: [] }, 0), /No generated outreach candidate/)
})

test('two generations finishing in reverse order cannot install the older result', () => {
  const current = {
    rev: 6, outreachDraft: 'Gen two', outreachStatus: 'Draft',
    outreachGeneration: { source: 'rules', generatedAt: '2026-09-05T00:00:02.000Z' },
  }
  const older = {
    subject: 'Quick idea', drafts: { Concise: 'Gen one', Balanced: 'x', Detailed: 'y' },
    generation: { source: 'rules', generatedAt: '2026-09-05T00:00:01.000Z' },
  }
  const decision = resolveOutreachCompletion({ started: { rev: 5 }, current, generated: older, selectedVersion: 'Concise' })
  assert.equal(decision.type, 'candidate')
  assert.equal(decision.patch.outreachDraft, undefined)
})

test('candidates survive an app restart behind the same decision rule', () => {
  const stored = {
    rev: 3, outreachDraft: 'My edit', outreachEdited: true, outreachStatus: 'Draft',
    outreachCandidates: [{ subject: 'Old', drafts: { Concise: 'Old one' }, generation: { generatedAt: '2026-09-04T00:00:00.000Z' }, createdAt: '2026-09-04T00:00:00.000Z' }],
  }
  const rehydrated = JSON.parse(JSON.stringify(stored))
  const generated = {
    subject: 'Quick idea', drafts: { Concise: 'New one', Balanced: 'n', Detailed: 'n' },
    generation: { source: 'rules', generatedAt: '2026-09-05T00:00:03.000Z' },
  }
  const decision = resolveOutreachCompletion({ started: { rev: 0 }, current: rehydrated, generated })
  assert.equal(decision.type, 'candidate')
  assert.equal(decision.patch.outreachCandidates.length, 2)
})

test('concurrent refresh preserves notes and chosen contacts, fills gaps', () => {
  const current = { notes: 'Recent call went well', email: 'chosen@acme.example', phone: 'Not collected', location: 'Unknown', rating: null }
  const fresh = { phone: '+1 555', email: 'other@acme.example', location: 'Miami, Florida', rating: 4.5 }
  const patch = buildRefreshPatch({ current, fresh })
  assert.equal(patch.phone, '+1 555')
  assert.equal(patch.location, 'Miami, Florida')
  assert.equal(patch.rating, 4.5)
  assert.ok(!('notes' in patch))
  assert.ok(!('email' in patch))
})

test('a stale synthesis never becomes current truth', () => {
  const current = { museAnalysis: { status: 'Completed', generatedAt: '2026-09-05T00:00:02.000Z', summary: 'newer' } }
  const stale = resolveSynthesisCompletion({ current, result: { generatedAt: '2026-09-05T00:00:01.000Z', summary: 'older' } })
  assert.equal(stale.type, 'stale')
  assert.equal(stale.patch, null)
  const fresh = resolveSynthesisCompletion({ current: {}, result: { generatedAt: '2026-09-05T00:00:03.000Z', summary: 'x' } })
  assert.equal(fresh.type, 'apply')
  assert.equal(fresh.patch.museAnalysis.status, 'Completed')
})
