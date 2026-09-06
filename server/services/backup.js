// Local backup/restore for operational lead data (ROH-29). Backups stay on
// disk next to the data directory and are never uploaded anywhere.
//
// Layout of one backup:
//   <backupsDir>/<utc-timestamp>/scoutline.db   (SQLite-consistent copy)
//   <backupsDir>/<utc-timestamp>/leads/         (generated lead artifacts)
//   <backupsDir>/<utc-timestamp>/manifest.json  (hashes, counts, version)
//
// Every backup is verified immediately after creation; a backup that fails
// verification is never advertised as good. Restore always verifies first
// and never overwrites a non-empty directory without an explicit replace.
import { createHash } from 'node:crypto'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const BACKUP_MANIFEST_VERSION = 1

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listFilesRecursive(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

export function collectArtifactFiles(leadsDir) {
  return listFilesRecursive(leadsDir).map((full) => {
    const stats = statSync(full)
    return { path: relative(leadsDir, full), bytes: stats.size, sha256: sha256File(full) }
  })
}

function tableCount(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  } catch {
    return null
  }
}

export function dbCounts(db) {
  return { leads: tableCount(db, 'leads'), jobs: tableCount(db, 'jobs'), runs: tableCount(db, 'runs'), events: tableCount(db, 'events') }
}

function timestampName(at = new Date()) {
  return at.toISOString().replace(/[:.]/g, '-')
}

export async function createBackup({ db, dataDir, backupsDir, at = new Date() }) {
  const name = timestampName(at)
  const target = join(backupsDir, name)
  mkdirSync(target, { recursive: true })
  try {
    // SQLite online backup: transactionally consistent even with WAL activity.
    await db.backup(join(target, 'scoutline.db'))
    if (existsSync(join(dataDir, 'leads'))) cpSync(join(dataDir, 'leads'), join(target, 'leads'), { recursive: true })
    const manifest = {
      version: BACKUP_MANIFEST_VERSION,
      createdAt: at.toISOString(),
      dbSha256: sha256File(join(target, 'scoutline.db')),
      files: collectArtifactFiles(join(target, 'leads')),
      counts: dbCounts(db),
    }
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    const verification = await verifyBackup(target)
    if (!verification.ok) throw new Error(`Backup failed verification: ${verification.errors.join('; ')}`)
    return { path: target, name, manifest }
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

function readManifest(backupPath) {
  const manifestPath = join(backupPath, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: false, errors: ['manifest.json is missing — this backup is incomplete and cannot be trusted'] }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { ok: false, errors: ['manifest.json is corrupt (not valid JSON) — this backup is incomplete and cannot be trusted'] }
  }
  if (!manifest || manifest.version !== BACKUP_MANIFEST_VERSION || !manifest.dbSha256 || !Array.isArray(manifest.files) || !manifest.counts) {
    return { ok: false, errors: ['manifest.json has an unsupported shape — this backup cannot be verified'] }
  }
  return { ok: true, manifest }
}

export async function verifyBackup(backupPath, { openDatabase } = {}) {
  const errors = []
  const parsed = readManifest(backupPath)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const { manifest } = parsed
  const dbPath = join(backupPath, 'scoutline.db')
  if (!existsSync(dbPath)) {
    errors.push('scoutline.db is missing from the backup')
  } else if (sha256File(dbPath) !== manifest.dbSha256) {
    errors.push('scoutline.db hash does not match the manifest — the database copy is corrupt or was modified after backup')
  }
  for (const file of manifest.files) {
    const full = join(backupPath, 'leads', file.path)
    if (!existsSync(full)) errors.push(`artifact missing from backup: ${file.path}`)
    else if (sha256File(full) !== file.sha256) errors.push(`artifact hash mismatch (corrupt or modified): ${file.path}`)
  }
  if (errors.length) return { ok: false, errors, manifest }
  if (openDatabase) {
    let checkDb = null
    try {
      checkDb = openDatabase(dbPath)
      const integrity = checkDb.prepare('PRAGMA integrity_check').get()
      if (!integrity || integrity.integrity_check !== 'ok') errors.push(`backup database failed integrity_check: ${integrity?.integrity_check || 'no result'}`)
      else {
        const counts = dbCounts(checkDb)
        for (const [table, expected] of Object.entries(manifest.counts)) {
          if (expected != null && counts[table] !== expected) errors.push(`backup ${table} count ${counts[table]} does not match manifest ${expected}`)
        }
      }
    } catch (error) {
      errors.push(`backup database could not be opened: ${error.message}`)
    } finally {
      try { checkDb?.close() } catch { /* already closed */ }
    }
  }
  return errors.length ? { ok: false, errors, manifest } : { ok: true, errors: [], manifest }
}

function isEmptyDir(path) {
  return !existsSync(path) || readdirSync(path).length === 0
}

export async function restoreBackup(backupPath, targetDir, { replace = false, openDatabase } = {}) {
  const verification = await verifyBackup(backupPath, { openDatabase })
  if (!verification.ok) throw new Error(`Restore refused — backup failed verification: ${verification.errors.join('; ')}`)
  if (!isEmptyDir(targetDir) && !replace) {
    throw new Error(`Restore refused — ${targetDir} already exists and is not empty. Re-run with an explicit replace to overwrite it.`)
  }
  mkdirSync(targetDir, { recursive: true })
  cpSync(join(backupPath, 'scoutline.db'), join(targetDir, 'scoutline.db'))
  if (existsSync(join(backupPath, 'leads'))) cpSync(join(backupPath, 'leads'), join(targetDir, 'leads'), { recursive: true })
  return { targetDir, manifest: verification.manifest }
}

export function listBackups(backupsDir) {
  if (!existsSync(backupsDir)) return []
  return readdirSync(backupsDir)
    .filter((entry) => {
      try { return statSync(join(backupsDir, entry)).isDirectory() && existsSync(join(backupsDir, entry, 'manifest.json')) } catch { return false }
    })
    .sort()
}

export function pruneBackups(backupsDir, retain = 5) {
  const all = listBackups(backupsDir)
  const remove = all.slice(0, Math.max(0, all.length - Math.max(1, retain)))
  for (const name of remove) rmSync(join(backupsDir, name), { recursive: true, force: true })
  return { kept: all.length - remove.length, removed: remove }
}

export function storageWritable(dataDir) {
  try {
    accessSync(dataDir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

// ── Portable JSON backup: lead data + settings in one downloadable file ──────
// The on-disk snapshot above stays on this machine; the JSON export below is
// the "back up their lead data and settings" flow from ROH-29: a single file
// the owner can download, keep elsewhere, and restore from later. Restore
// always verifies first and only deletes existing data on explicit confirm.

// Tables covered by a JSON backup, in wipe order (children first).
export const BACKUP_JSON_FORMAT = 'scoutline-json-backup'
export const BACKUP_JSON_MAX_BYTES = 150 * 1024 * 1024
export const BACKUP_TABLES = ['events', 'jobs', 'runs', 'leads', 'settings']
export const BACKUP_RESTORE_COLUMNS = {
  events: ['id', 'entity_type', 'entity_id', 'type', 'payload', 'created_at'],
  jobs: ['id', 'run_id', 'lead_id', 'type', 'status', 'progress', 'attempts', 'max_attempts', 'payload', 'result', 'error', 'next_attempt_at', 'created_at', 'updated_at'],
  runs: ['id', 'payload', 'updated_at'],
  leads: ['id', 'payload', 'updated_at'],
  settings: ['key', 'value'],
}

// Files that must never be embedded in (or written by) a JSON backup.
function isBackupSafeRelativePath(path) {
  if (!path || typeof path !== 'string') return false
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false
  const parts = path.split(/[\\/]/)
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  if (parts[0] === 'backups') return false
  return !parts.some((part) => /^scoutline\.db(-wal|-shm|-journal)?$/.test(part))
}

export function collectJsonBackupFiles(dataDir, { maxBytes = BACKUP_JSON_MAX_BYTES } = {}) {
  const leadsDir = join(dataDir, 'leads')
  const files = []
  let totalBytes = 0
  for (const full of existsSync(leadsDir) ? listFilesRecursive(leadsDir) : []) {
    const rel = join('leads', relative(leadsDir, full))
    const size = statSync(full).size
    totalBytes += size
    if (totalBytes > maxBytes) {
      return { ok: false, error: `Backup too large — artifact files exceed the ${Math.round(maxBytes / 1024 / 1024)}MB portable-backup limit` }
    }
    files.push({ path: rel.split(sep).join('/'), size, sha256: sha256File(full), content: readFileSync(full).toString('base64') })
  }
  return { ok: true, files }
}

export function buildJsonBackup({ tables, files, appVersion = null, createdAt = new Date().toISOString() }) {
  const counts = {}
  for (const table of BACKUP_TABLES) counts[table] = Array.isArray(tables?.[table]) ? tables[table].length : 0
  return {
    format: BACKUP_JSON_FORMAT,
    version: BACKUP_MANIFEST_VERSION,
    createdAt,
    appVersion,
    counts,
    tables: Object.fromEntries(BACKUP_TABLES.map((table) => [table, Array.isArray(tables?.[table]) ? tables[table] : []])),
    files: Array.isArray(files) ? files : [],
  }
}

export function validateJsonBackup(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('Backup must be a JSON object')
  else {
    if (value.format !== BACKUP_JSON_FORMAT) errors.push(`Unsupported backup format "${value.format}" — expected "${BACKUP_JSON_FORMAT}"`)
    if (value.version !== BACKUP_MANIFEST_VERSION) errors.push(`Unsupported backup version "${value.version}" — expected ${BACKUP_MANIFEST_VERSION}`)
    if (!value.tables || typeof value.tables !== 'object') errors.push('Backup is missing the tables payload')
    else {
      for (const table of BACKUP_TABLES) {
        if (!Array.isArray(value.tables[table])) errors.push(`Backup tables.${table} must be an array`)
      }
    }
    if (!Array.isArray(value.files)) errors.push('Backup files must be an array')
    else {
      value.files.forEach((file, idx) => {
        if (!file || typeof file !== 'object') { errors.push(`Backup files[${idx}] must be an object`); return }
        if (!isBackupSafeRelativePath(file.path)) errors.push(`Backup files[${idx}] has an unsafe path "${file.path}" — restore refused`)
        if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) errors.push(`Backup files[${idx}] is missing a valid sha256 hash`)
        if (typeof file.content !== 'string') errors.push(`Backup files[${idx}] is missing base64 content`)
      })
    }
  }
  if (errors.length) return { ok: false, errors }
  // Content-after-decode check: base64 that decodes to different bytes is tampering, not transport noise.
  for (const [idx, file] of value.files.entries()) {
    let bytes
    try {
      bytes = Buffer.from(file.content, 'base64')
    } catch {
      errors.push(`Backup files[${idx}] content is not valid base64`)
      continue
    }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      errors.push(`Backup files[${idx}] (${file.path}) hash does not match its content — the backup is corrupt or was tampered with`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], backup: value }
}

export function planJsonRestore(backup) {
  const counts = {}
  for (const table of BACKUP_TABLES) counts[table] = backup.tables[table].length
  return {
    dryRun: true,
    tables: counts,
    files: backup.files.length,
    fileBytes: backup.files.reduce((sum, file) => sum + (file.size || 0), 0),
    createdAt: backup.createdAt || null,
    warnings: backup.version !== BACKUP_MANIFEST_VERSION ? [`Backup version ${backup.version} differs from current ${BACKUP_MANIFEST_VERSION}`] : [],
  }
}

// Applies a validated JSON backup: wipes the covered tables and the managed
// leads/ tree, then rewrites both from the backup and re-verifies every file.
// Leads whose artifacts failed to save before the backup (recorded in the
// storage_artifact_failures setting) may have no file in the backup at all —
// those are regenerated from the restored database row via `regenerateLead`.
// `db` only needs prepare()/exec()/get() (better-sqlite3 in prod and tests).
export function applyJsonRestore(db, dataDir, backup, { regenerateLead = null } = {}) {
  const parsed = validateJsonBackup(backup)
  if (!parsed.ok) throw new Error(`Restore refused — invalid backup: ${parsed.errors.join('; ')}`)
  const clean = parsed.backup
  // Failure leads come from both sides: the live database (a failure recorded
  // after the backup was taken) and the backup itself (restoring onto a fresh
  // machine where the live database knows nothing yet).
  const failedLeadIds = [...new Set([...readFailedLeadIds(db), ...failedLeadIdsInBackup(clean)])]
  for (const table of BACKUP_TABLES) db.prepare(`DELETE FROM ${table}`).run()
  for (const table of [...BACKUP_TABLES].reverse()) {
    const columns = BACKUP_RESTORE_COLUMNS[table]
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const row of clean.tables[table]) {
      insert.run(...columns.map((column) => (row[column] === undefined ? null : row[column])))
    }
  }
  const leadsDir = join(dataDir, 'leads')
  rmSync(leadsDir, { recursive: true, force: true })
  const failed = []
  for (const file of clean.files) {
    const target = join(dataDir, ...file.path.split('/'))
    if (dirname(target) !== dataDir && !target.startsWith(dataDir + sep)) {
      failed.push({ path: file.path, error: 'resolved outside the data directory' })
      continue
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(file.content, 'base64'))
      if (sha256File(target) !== file.sha256) failed.push({ path: file.path, error: 'hash mismatch after write' })
    } catch (error) {
      failed.push({ path: file.path, error: error.message })
    }
  }
  try { db.exec('VACUUM') } catch { /* non-fatal housekeeping */ }
  try {
    db.prepare("UPDATE jobs SET status = 'Queued', error = NULL, updated_at = ? WHERE status = 'Running'").run(new Date().toISOString())
  } catch { /* jobs table always exists in prod */ }
  const regenFailed = regenerateFailedArtifacts(db, failedLeadIds, regenerateLead)
  const allFailed = [...failed, ...regenFailed]
  if (allFailed.length === 0) {
    try {
      db.prepare('DELETE FROM settings WHERE key = ?').run('storage_artifact_failures')
    } catch { /* settings table always exists in prod */ }
  }
  const restored = { tables: planJsonRestore(clean).tables, files: clean.files.length - failed.length, regenerated: failedLeadIds.length - regenFailed.length }
  return allFailed.length ? { ok: false, restored, failed: allFailed } : { ok: true, restored, failed: [] }
}

function failedLeadIdsInList(list) {
  return Array.isArray(list) ? list.map((item) => item?.leadId).filter((id) => typeof id === 'string') : []
}

function readFailedLeadIds(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('storage_artifact_failures')
    return failedLeadIdsInList(row ? JSON.parse(row.value) : [])
  } catch {
    return []
  }
}

function failedLeadIdsInBackup(backup) {
  try {
    const row = (backup.tables.settings || []).find((entry) => entry?.key === 'storage_artifact_failures')
    return failedLeadIdsInList(row ? JSON.parse(row.value) : [])
  } catch {
    return []
  }
}

function regenerateFailedArtifacts(db, failedLeadIds, regenerateLead) {
  if (!regenerateLead) return []
  const regenFailed = []
  for (const leadId of failedLeadIds) {
    try {
      const row = db.prepare('SELECT payload FROM leads WHERE id = ?').get(leadId)
      if (!row) continue
      regenerateLead(JSON.parse(row.payload))
    } catch (error) {
      regenFailed.push({ path: `leads/${leadId}`, error: error.message })
    }
  }
  return regenFailed
}
