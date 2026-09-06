import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyJsonRestore, buildJsonBackup, collectJsonBackupFiles, planJsonRestore, validateJsonBackup, createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from './backup.js'

function makeSource() {
  const root = mkdtempSync(join(tmpdir(), 'scout-backup-'))
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'leads', 'lead-1'), { recursive: true })
  writeFileSync(join(dataDir, 'leads', 'lead-1', 'audit.json'), JSON.stringify({ id: 'lead-1' }), 'utf8')
  const db = new Database(join(dataDir, 'scoutline.db'))
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE leads (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE jobs (id TEXT PRIMARY KEY); CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE events (id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run('lead-1', JSON.stringify({ id: 'lead-1', company: 'Demo' }))
  db.prepare('INSERT INTO jobs (id) VALUES (?)').run('job-1')
  return { root, dataDir, db }
}

function closeAll(handles) {
  for (const handle of handles) {
    try { handle.close() } catch { /* already closed */ }
  }
}

test('backup during WAL activity restores every committed row', async () => {
  const { root, dataDir, db } = makeSource()
  try {
    // Leave WAL frames uncheckpointed, then back up while a second writer adds a row.
    const writer = new Database(join(dataDir, 'scoutline.db'))
    const created = await createBackup({ db, dataDir, backupsDir: join(root, 'backups'), at: new Date('2026-09-06T00:00:00.000Z') })
    writer.prepare('INSERT INTO events (id) VALUES (?)').run('evt-1')
    writer.close()
    assert.ok(existsSync(join(created.path, 'manifest.json')))
    const restored = join(root, 'restored')
    const result = await restoreBackup(created.path, restored, { openDatabase: (path) => new Database(path, { readonly: true }) })
    assert.equal(result.manifest.counts.leads, 1)
    const check = new Database(join(restored, 'scoutline.db'), { readonly: true })
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 1)
      assert.equal(JSON.parse(check.prepare('SELECT payload AS p FROM leads').get().p).company, 'Demo')
    } finally {
      check.close()
    }
    assert.equal(JSON.parse(readFileSync(join(restored, 'leads', 'lead-1', 'audit.json'), 'utf8')).id, 'lead-1')
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt or incomplete backups are rejected with an explanation', async () => {
  const { root, dataDir, db } = makeSource()
  try {
    const created = await createBackup({ db, dataDir, backupsDir: join(root, 'backups') })
    writeFileSync(join(created.path, 'manifest.json'), '{not json', 'utf8')
    const corrupt = await verifyBackup(created.path)
    assert.equal(corrupt.ok, false)
    assert.ok(corrupt.errors.some((error) => /not valid JSON/i.test(error)))

    rmSync(join(created.path, 'manifest.json'))
    const missing = await verifyBackup(created.path)
    assert.equal(missing.ok, false)
    assert.ok(missing.errors.some((error) => /missing/i.test(error)))
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('tampered database copies fail hash verification', async () => {
  const { root, dataDir, db } = makeSource()
  try {
    const created = await createBackup({ db, dataDir, backupsDir: join(root, 'backups') })
    const tamper = new Database(join(created.path, 'scoutline.db'))
    try {
      tamper.prepare('INSERT INTO jobs (id) VALUES (?)').run('job-evil')
    } finally {
      tamper.close()
    }
    const result = await verifyBackup(created.path)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => /hash does not match/i.test(error)))
    await assert.rejects(restoreBackup(created.path, join(root, 'nope')), /failed verification/)
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore never overwrites an active directory without explicit replace', async () => {
  const { root, dataDir, db } = makeSource()
  try {
    const created = await createBackup({ db, dataDir, backupsDir: join(root, 'backups') })
    const target = join(root, 'active')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'user data', 'utf8')
    await assert.rejects(restoreBackup(created.path, target), /not empty.*explicit replace/)
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'user data')
    const replaced = await restoreBackup(created.path, target, { replace: true })
    assert.equal(replaced.targetDir, target)
    assert.ok(existsSync(join(target, 'scoutline.db')))
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('retention keeps the newest backups and lists only valid ones', async () => {
  const { root, dataDir, db } = makeSource()
  try {
    const backupsDir = join(root, 'backups')
    for (const day of [1, 2, 3, 4]) {
      await createBackup({ db, dataDir, backupsDir, at: new Date(`2026-09-0${day}T00:00:00.000Z`) })
    }
    mkdirSync(join(backupsDir, 'not-a-backup'), { recursive: true })
    assert.equal(listBackups(backupsDir).length, 4)
    const pruned = pruneBackups(backupsDir, 2)
    assert.deepEqual(pruned, { kept: 2, removed: ['2026-09-01T00-00-00-000Z', '2026-09-02T00-00-00-000Z'] })
    assert.deepEqual(listBackups(backupsDir), ['2026-09-03T00-00-00-000Z', '2026-09-04T00-00-00-000Z'])
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

const JSON_SCHEMA = `
  CREATE TABLE leads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT, lead_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE events (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
`

function makeJsonSource() {
  const root = mkdtempSync(join(tmpdir(), 'scout-json-'))
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'leads', 'lead-1'), { recursive: true })
  writeFileSync(join(dataDir, 'leads', 'lead-1', 'lead.json'), JSON.stringify({ id: 'lead-1' }), 'utf8')
  const db = new Database(':memory:')
  db.exec(JSON_SCHEMA)
  db.prepare('INSERT INTO leads (id, payload, updated_at) VALUES (?, ?, ?)').run('lead-1', JSON.stringify({ id: 'lead-1', company: 'Demo' }), '2026-09-06T00:00:00.000Z')
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('defaultLocation', JSON.stringify('Reno, Nevada'))
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('job-1', 'audit', 'Completed', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')").run()
  db.prepare("INSERT INTO events (id, entity_type, entity_id, type, created_at) VALUES ('evt-1', 'lead', 'lead-1', 'created', '2026-09-06T00:00:00.000Z')").run()
  return { root, dataDir, db }
}

function readTables(db) {
  return {
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
    runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
    leads: db.prepare('SELECT * FROM leads ORDER BY id').all(),
    settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
  }
}

function makeJsonBackup(dataDir, db) {
  const collected = collectJsonBackupFiles(dataDir)
  assert.equal(collected.ok, true)
  return buildJsonBackup({ tables: readTables(db), files: collected.files })
}

test('json backup round-trip restores tables and files byte-identical', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const backup = makeJsonBackup(dataDir, db)
    assert.deepEqual(backup.counts, { events: 1, jobs: 1, runs: 0, leads: 1, settings: 1 })
    assert.equal(validateJsonBackup(backup).ok, true)
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    target.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('defaultLocation', JSON.stringify('Elsewhere'))
    const targetDir = join(root, 'target')
    const result = applyJsonRestore(target, targetDir, backup)
    assert.equal(result.ok, true)
    assert.deepEqual(result.restored.tables, { events: 1, jobs: 1, runs: 0, leads: 1, settings: 1 })
    assert.equal(JSON.parse(target.prepare('SELECT payload FROM leads WHERE id = ?').get('lead-1').payload).company, 'Demo')
    assert.equal(JSON.parse(target.prepare('SELECT value FROM settings WHERE key = ?').get('defaultLocation').value), 'Reno, Nevada')
    assert.equal(JSON.parse(readFileSync(join(targetDir, 'leads', 'lead-1', 'lead.json'), 'utf8')).id, 'lead-1')
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('tampered file content fails validation and restore is refused', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const backup = makeJsonBackup(dataDir, db)
    const tampered = structuredClone(backup)
    tampered.files[0].content = Buffer.from(JSON.stringify({ id: 'hacker' })).toString('base64')
    const checked = validateJsonBackup(tampered)
    assert.equal(checked.ok, false)
    assert.match(checked.errors.join('; '), /tampered|hash does not match/)
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    assert.throws(() => applyJsonRestore(target, join(root, 'target'), tampered), /Restore refused/)
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsafe file paths are refused before anything is written', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const backup = makeJsonBackup(dataDir, db)
    for (const badPath of ['../evil.json', '/abs.json', 'backups/x.json', 'scoutline.db', 'leads/../../evil.json']) {
      const candidate = structuredClone(backup)
      candidate.files.push({ path: badPath, size: 3, sha256: 'e'.repeat(64), content: Buffer.from('x').toString('base64') })
      assert.equal(validateJsonBackup(candidate).ok, false, badPath)
    }
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    const candidate = structuredClone(backup)
    candidate.files.push({ path: '../evil.json', size: 3, sha256: 'e'.repeat(64), content: Buffer.from('x').toString('base64') })
    assert.throws(() => applyJsonRestore(target, join(root, 'target'), candidate), /Restore refused/)
    assert.equal(target.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 0)
    assert.equal(existsSync(join(root, 'target', 'evil.json')), false)
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('oversize artifact trees fail closed instead of producing a partial backup', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const collected = collectJsonBackupFiles(dataDir, { maxBytes: 1 })
    assert.equal(collected.ok, false)
    assert.match(collected.error, /too large/i)
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('unwritable file entries are reported with status instead of failing silently', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const backup = makeJsonBackup(dataDir, db)
    // An entry claiming to be the leads directory itself passes path checks
    // but cannot be written as a file — it must surface in `failed`.
    const fileBytes = Buffer.from('collision')
    backup.files.push({ path: 'leads', size: fileBytes.length, sha256: createHash('sha256').update(fileBytes).digest('hex'), content: fileBytes.toString('base64') })
    assert.equal(validateJsonBackup(backup).ok, true)
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    const result = applyJsonRestore(target, join(root, 'target'), backup)
    assert.equal(result.ok, false)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].path, 'leads')
    assert.equal(result.restored.files, backup.files.length - 1)
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore regenerates previously-failed artifacts from the database row', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    // lead-2 exists in the database but never made it to disk, so no backup
    // contains its files. The failure is recorded the way the server does it.
    db.prepare('INSERT INTO leads (id, payload, updated_at) VALUES (?, ?, ?)').run('lead-2', JSON.stringify({ id: 'lead-2', company: 'Ghost' }), '2026-09-06T00:00:00.000Z')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('storage_artifact_failures', JSON.stringify([{ leadId: 'lead-2', error: 'EACCES', at: '2026-09-06T00:00:00.000Z' }]))
    const backup = makeJsonBackup(dataDir, db)
    assert.equal(backup.files.some((file) => file.path.includes('lead-2')), false)
    const regenerated = []
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    const result = applyJsonRestore(target, join(root, 'target'), backup, { regenerateLead: (lead) => { regenerated.push(lead.id) } })
    assert.equal(result.ok, true)
    assert.deepEqual(regenerated, ['lead-2'])
    assert.equal(result.restored.regenerated, 1)
    assert.equal(target.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'storage_artifact_failures'").get().c, 0)
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed regeneration keeps the failure status instead of clearing it', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('storage_artifact_failures', JSON.stringify([{ leadId: 'lead-1', error: 'EACCES', at: '2026-09-06T00:00:00.000Z' }]))
    const backup = makeJsonBackup(dataDir, db)
    const target = new Database(':memory:')
    target.exec(JSON_SCHEMA)
    const result = applyJsonRestore(target, join(root, 'target'), backup, { regenerateLead: () => { throw new Error('disk still broken') } })
    assert.equal(result.ok, false)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /disk still broken/)
    target.close()
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry-run plan reports counts without changing anything', () => {
  const { root, dataDir, db } = makeJsonSource()
  try {
    const backup = makeJsonBackup(dataDir, db)
    const plan = planJsonRestore(validateJsonBackup(backup).backup)
    assert.equal(plan.dryRun, true)
    assert.deepEqual(plan.tables, { events: 1, jobs: 1, runs: 0, leads: 1, settings: 1 })
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 1)
    assert.equal(existsSync(join(dataDir, 'leads', 'lead-1', 'lead.json')), true)
  } finally {
    closeAll([db])
    rmSync(root, { recursive: true, force: true })
  }
})
