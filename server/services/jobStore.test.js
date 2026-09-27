import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureQueueSchema, insertJobOnce, queueHealth, readState, writeState } from './jobStore.js'

function freshDb() {
  const db = new Database(':memory:')
  // The jobs table as server/index.js creates it before the queue migration.
  db.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, run_id TEXT, lead_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, next_attempt_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, triggered_by TEXT NOT NULL DEFAULT 'system')`)
  ensureQueueSchema(db)
  ensureQueueSchema(db) // idempotent on restart
  return db
}

const row = (id, key, extra = {}) => ({
  id, runId: null, leadId: 'lead-1', type: 'qualify', maxAttempts: 2, payload: '{}',
  createdAt: new Date().toISOString(), triggeredBy: 'test', idempotencyKey: key, ...extra,
})

test('a second job with the same key returns the active one instead of queueing twice', () => {
  const db = freshDb()
  assert.deepEqual(insertJobOnce(db, row('job-a', 'qualify:lead-1')), { id: 'job-a', created: true })
  assert.deepEqual(insertJobOnce(db, row('job-b', 'qualify:lead-1')), { id: 'job-a', created: false })
  db.prepare("UPDATE jobs SET status = 'Running' WHERE id = 'job-a'").run()
  assert.deepEqual(insertJobOnce(db, row('job-c', 'qualify:lead-1')), { id: 'job-a', created: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1)
})

test('the key frees up once the job finishes, and keyless jobs never collide', () => {
  const db = freshDb()
  insertJobOnce(db, row('job-a', 'qualify:lead-1'))
  db.prepare("UPDATE jobs SET status = 'Completed' WHERE id = 'job-a'").run()
  assert.deepEqual(insertJobOnce(db, row('job-b', 'qualify:lead-1')), { id: 'job-b', created: true })
  assert.equal(insertJobOnce(db, row('job-c', null)).created, true)
  assert.equal(insertJobOnce(db, row('job-d', null)).created, true)
  // A different lead or type is different work.
  assert.equal(insertJobOnce(db, row('job-e', 'qualify:lead-2', { leadId: 'lead-2' })).created, true)
  assert.equal(insertJobOnce(db, row('job-f', 'visual:lead-1', { type: 'visual' })).created, true)
})

test('health reports queue depth, failures, last success and a stale worker', () => {
  const db = freshDb()
  const now = Date.parse('2026-09-27T12:00:00Z')
  const at = (ms) => new Date(now - ms).toISOString()
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('q1', 'qualify', 'Queued', ?, ?)").run(at(0), at(0))
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('d1', 'discover', 'Waiting', ?, ?)").run(at(0), at(0))
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('v1', 'visual', 'Error', ?, ?)").run(at(3600_000), at(3600_000))
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('v0', 'visual', 'Error', ?, ?)").run(at(3 * 86400_000), at(3 * 86400_000))
  db.prepare("INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES ('q0', 'qualify', 'Completed', ?, ?)").run(at(600_000), at(600_000))

  writeState(db, 'worker', { pid: 1, at: at(5 * 60_000) })
  let health = queueHealth(db, now)
  assert.deepEqual(health.queue, { queued: 1, waiting: 1, running: 0 })
  assert.deepEqual(health.failures24h, { visual: 1 })
  assert.equal(health.lastSuccess.qualify, at(600_000))
  assert.equal(health.worker.alive, false)
  assert.equal(health.ok, false, 'work is waiting and nobody is running it')

  writeState(db, 'worker', { pid: 1, at: at(5_000) })
  health = queueHealth(db, now)
  assert.equal(health.worker.alive, true)
  assert.equal(health.ok, true)
  assert.equal(readState(db, 'worker').pid, 1)
})
