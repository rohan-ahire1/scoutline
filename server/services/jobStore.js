// SQLite side of the job queue: idempotent inserts, cross-process state and
// the health snapshot. Shared by the web process (which only enqueues) and
// the worker process (which claims and runs jobs); both open the same WAL
// database.

export const ACTIVE_STATUSES_SQL = "('Queued', 'Running', 'Waiting')"

export function ensureQueueSchema(db) {
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN idempotency_key TEXT')
  } catch {
    // Column already exists.
  }
  // One active job per key; finished jobs keep their key as history, so the
  // same work can be queued again once the previous attempt is done.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_active
      ON jobs(idempotency_key)
      WHERE idempotency_key IS NOT NULL AND status IN ${ACTIVE_STATUSES_SQL};
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

// Inserts a job unless an active job already holds its idempotency key.
// Returns { id, created }: the new job's id, or the existing active job's.
export function insertJobOnce(db, row) {
  const info = db.prepare(`INSERT OR IGNORE INTO jobs
    (id, run_id, lead_id, type, status, progress, attempts, max_attempts, payload, created_at, updated_at, triggered_by, idempotency_key)
    VALUES (@id, @runId, @leadId, @type, 'Queued', 0, 0, @maxAttempts, @payload, @createdAt, @createdAt, @triggeredBy, @idempotencyKey)`)
    .run(row)
  if (info.changes > 0) return { id: row.id, created: true }
  const existing = db.prepare(`SELECT id FROM jobs WHERE idempotency_key = ? AND status IN ${ACTIVE_STATUSES_SQL}`).get(row.idempotencyKey)
  if (!existing) throw new Error(`Job insert ignored without an active duplicate (key ${row.idempotencyKey})`)
  return { id: existing.id, created: false }
}

export function readState(db, key) {
  const row = db.prepare('SELECT value, updated_at FROM system_state WHERE key = ?').get(key)
  if (!row) return null
  try {
    return { ...JSON.parse(row.value), updatedAt: row.updated_at }
  } catch {
    return null
  }
}

export function writeState(db, key, value, at = new Date().toISOString()) {
  db.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), at)
}

// A worker that has not written a heartbeat for this long is reported down.
export const WORKER_STALE_MS = 60_000

export function queueHealth(db, nowMs = Date.now()) {
  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ${ACTIVE_STATUSES_SQL} GROUP BY status`).all().map((r) => [r.status, r.n]))
  const since = new Date(nowMs - 24 * 3600_000).toISOString()
  const failures24h = db.prepare("SELECT type, COUNT(*) AS n FROM jobs WHERE status IN ('Failed', 'Error', 'Timed out') AND updated_at >= ? GROUP BY type").all(since)
  const lastSuccess = db.prepare("SELECT type, MAX(updated_at) AS at FROM jobs WHERE status = 'Completed' GROUP BY type").all()
  const running = db.prepare("SELECT id, type, lead_id, run_id, attempts, max_attempts, payload FROM jobs WHERE status = 'Running'").all()
    .map((r) => ({ id: r.id, type: r.type, leadId: r.lead_id, runId: r.run_id, attempts: r.attempts, maxAttempts: r.max_attempts, startedAt: JSON.parse(r.payload || '{}').startedAt || null }))
  const worker = readState(db, 'worker')
  const heartbeatMs = Date.parse(worker?.at || '')
  const ageMs = Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs : null
  const workerAlive = ageMs != null && ageMs <= WORKER_STALE_MS
  const queued = (counts.Queued || 0) + (counts.Waiting || 0)
  return {
    ok: workerAlive || (queued === 0 && running.length === 0),
    worker: worker ? { ...worker, alive: workerAlive, heartbeatAgeSeconds: ageMs == null ? null : Math.round(ageMs / 1000) } : { alive: false, heartbeatAgeSeconds: null },
    queue: { queued: counts.Queued || 0, waiting: counts.Waiting || 0, running: counts.Running || 0 },
    running,
    lastSuccess: Object.fromEntries(lastSuccess.map((r) => [r.type, r.at])),
    failures24h: Object.fromEntries(failures24h.map((r) => [r.type, r.n])),
    nightly: readState(db, 'nightly'),
  }
}
