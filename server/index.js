import express from 'express'
import Database from 'better-sqlite3'
import 'dotenv/config'
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AUTH_SESSION_TTL_SECONDS, AuthError, clearedSessionCookie, createAuthService, sessionCookie } from './auth.js'
import { auditWebsite, mergeContactCandidates } from './services/audit.js'
import { enrichLead } from './services/enrichment.js'
import { generateMuseAnalysis } from './services/insights.js'
import { buildChannelDrafts, generateOutreach, getOutreachConfig } from './services/outreach.js'
import { businessIdentityFor, describeGeographyCoverage, DiscoveryError, downloadDiscovery, filterSavedClientsByLocation, getBrightDataConfig, legacySearchFromSettings, mapDiscoveryRecord, pollDiscovery, reconcileRecords, resolveSearchDefinition, triggerDiscovery, triggerRecordRefresh } from './services/discovery.js'
import { applyLeadWorkflowChanges, normalizeLeadWorkflow } from './workflow.js'
import { ATTEMPT_OUTCOMES, CONTACT_OUTCOMES, NEXT_TASK_TYPES, TASK_OWNERS, TASK_STATUSES, briefFindings, briefReadiness, buildBriefMarkdown, buildProspectBrief, isValidDayString, reviewStatus } from './services/brief.js'
import { buildQueue, computeReadiness, explainReadiness } from './services/readiness.js'
import { scoreLeadValue } from './services/leadValue.js'
import { formatProvenanceScore, resolveMetricProvenance, resolveNestedProvenance } from './services/measure.js'
import { canRetryJob, classifyJobError, findTimedOutJobs, isActiveJobStatus, isTerminalJobStatus } from './services/jobControl.js'
import { acceptOutreachCandidate, buildRefreshPatch, dismissOutreachCandidates, getRev, resolveOutreachCompletion, resolveSynthesisCompletion, updateLeadFields } from './services/revisions.js'
import { auditIdForJob, buildLeadReport, listAuditManifests, loadAuditForSynthesis, readManifest, renderLeadReportMarkdown, saveAuditArtifacts } from './services/artifacts.js'
import { applyJsonRestore, BACKUP_RESTORE_COLUMNS, BACKUP_TABLES, buildJsonBackup, collectJsonBackupFiles, createBackup, listBackups, planJsonRestore, pruneBackups, storageWritable, validateJsonBackup, verifyBackup } from './services/backup.js'
import { buildLocalRunId, crawlSiteToLeadRow, describeCrawlSite, findLeadByWebsite, isLocalRunId, summarizeCrawlSites, validateCrawlExport, validateLocalScrapeRequest } from './services/crawl.js'
import { LOCAL_RUN_ACTIVE, LOCAL_RUN_VERSION, readLocalRunFile, runLocalScrape, writeLocalRunFile } from './services/crawlRunner.js'
import { findMarket, resolveMarkets } from './services/markets.js'
import { PLAYS } from './services/qualify.js'
import { requalify, scanAndQualify, visualReviewLead } from './services/prospect.js'
import { getVisionConfig } from './services/visual.js'

const serverDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(serverDir, '..')
const dataDir = process.env.SCOUTLINE_DATA_DIR ? resolve(process.env.SCOUTLINE_DATA_DIR) : join(rootDir, 'data')
mkdirSync(dataDir, { recursive: true })
const backupsDir = join(dataDir, 'backups')

// Active background work blocks a live restore (it would wipe the jobs table
// out from under the worker). Shared by both restore endpoints.
function activeJobCount() {
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('Queued', 'Running', 'Waiting')").get().count
  } catch {
    return 0
  }
}

function readBackupTables(database) {
  const tables = {}
  for (const table of BACKUP_TABLES) {
    const columns = BACKUP_RESTORE_COLUMNS[table]
    try {
      tables[table] = database.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()
    } catch {
      tables[table] = []
    }
  }
  return tables
}

const db = new Database(join(dataDir, 'scoutline.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
const auth = createAuthService(db)
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    lead_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    error TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    triggered_by TEXT NOT NULL DEFAULT 'system'
  );
`)
try {
  db.exec("ALTER TABLE jobs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'system'")
} catch {
  // Column already exists on databases created before job provenance.
}
db.exec(`
  CREATE INDEX IF NOT EXISTS jobs_status_index ON jobs(status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS jobs_run_index ON jobs(run_id, status);
  CREATE INDEX IF NOT EXISTS jobs_lead_index ON jobs(lead_id, status);
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_entity_index ON events(entity_type, entity_id, created_at);
`)
for (const row of db.prepare("SELECT * FROM jobs WHERE status = 'Running'").all()) {
  const running = parseJob(row)
  const { startedAt: _dropped, cancelRequested: _cancel, ...payload } = running.payload || {}
  db.prepare('UPDATE jobs SET status = ?, error = NULL, payload = ?, updated_at = ? WHERE id = ?')
    .run('Queued', JSON.stringify(payload), new Date().toISOString(), running.id)
}

const defaultSettings = {
  defaultLocation: 'Salt Lake City, Utah',
  resultLimit: 25,
  deepAuditLimit: 10,
  categories: ['Roofing', 'HVAC', 'Flooring'],
  maxPages: 10,
  requestDelay: 1500,
  respectRobots: true,
  crawlMaxAttempts: 60,
  crawlTimeLimitMs: 120000,
  leadValueWeights: { need: 0.35, businessFit: 0.3, reachability: 0.2, timing: 0.15 },
  offer: {
    version: 1,
    service: 'Website improvements for local service businesses',
    targetCategories: ['Roofing', 'HVAC', 'Flooring', 'Plumbing', 'Electrical'],
    geography: 'Salt Lake City, Utah',
    exclusions: '',
    proofPoints: [],
    callToAction: 'Would it be useful if I shared a short outline of the change?',
    tone: 'direct, calm, helpful, low-pressure',
    channels: ['email', 'phone', 'form'],
  },
  jobTimeoutMs: 600000,
  discoveryPollTimeoutMs: 1800000,
  runTimeoutMs: 7200000,
  blockPrivateNetworks: true,
  discoveryCountry: 'US',
  discoveryLatitude: 40.7608,
  discoveryLongitude: -111.891,
  discoveryZoom: 13,
}
const settingInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
Object.entries(defaultSettings).forEach(([key, value]) => settingInsert.run(key, JSON.stringify(value)))

const app = express()
app.set('trust proxy', 1)

const authCookieOptions = (req) => ({ secure: process.env.NODE_ENV === 'production' || req.secure })
const noStore = (res) => res.set('Cache-Control', 'no-store')

app.get('/api/auth/config', (_req, res) => {
  noStore(res).json({ configured: auth.configured, clientId: auth.configured ? auth.clientId : null })
})

app.get('/api/auth/session', (req, res) => {
  const user = auth.session(req.headers.cookie)
  noStore(res).json({ authenticated: Boolean(user), user })
})

app.post('/api/auth/google', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { token, user } = await auth.login(req.body?.credential)
    res.setHeader('Set-Cookie', sessionCookie(token, { ...authCookieOptions(req), ttlSeconds: AUTH_SESSION_TTL_SECONDS }))
    noStore(res).json({ authenticated: true, user })
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500
    const code = error instanceof AuthError ? error.code : 'AUTH_ERROR'
    const message = error instanceof AuthError ? error.message : 'Scoutline could not complete Google sign-in'
    noStore(res).status(status).json({ error: message, code })
  }
})

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req.headers.cookie)
  res.setHeader('Set-Cookie', clearedSessionCookie(authCookieOptions(req)))
  noStore(res).json({ ok: true })
})

app.use('/api', (req, res, next) => {
  if (!auth.configured) return noStore(res).status(503).json({ error: 'Google login is not configured on this server', code: 'AUTH_NOT_CONFIGURED' })
  const user = auth.session(req.headers.cookie)
  if (!user) {
    res.setHeader('Set-Cookie', clearedSessionCookie(authCookieOptions(req)))
    return noStore(res).status(401).json({ error: 'Sign in with an allowed Google account to continue', code: 'AUTH_REQUIRED' })
  }
  req.user = user
  next()
})

// Portable-backup uploads can legitimately exceed the 1mb API default, so
// this route is registered before the global parser with its own limit.
app.post('/api/backup/restore', express.json({ limit: '160mb' }), (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object with a backup payload')
  const parsed = validateJsonBackup(body.backup ?? body)
  if (!parsed.ok) return res.status(422).json({ error: `Backup is not usable: ${parsed.errors.join('; ')}`, code: 'INVALID_BACKUP', details: parsed.errors.map((message) => ({ message })) })
  if (body.confirm === true) {
    const active = activeJobCount()
    if (active > 0) return conflict(res, `Restore blocked — ${active} background job(s) still active. Cancel or wait for them first.`, null, 'RESTORE_BLOCKED_ACTIVE_JOBS')
    let result
    try {
      result = applyJsonRestore(db, dataDir, parsed.backup, { regenerateLead: (lead) => writeLeadArtifacts(lead) })
    } catch (error) {
      return res.status(422).json({ error: `Restore refused — ${error.message}`, code: 'INVALID_BACKUP' })
    }
    if (!result.ok) return res.status(500).json({ error: `Restore incomplete — ${result.failed.length} file(s) could not be written`, code: 'BACKUP_RESTORE_PARTIAL', restored: result.restored, failed: result.failed })
    recordEvent('system', 'backup', 'restored', { tables: result.restored.tables, files: result.restored.files })
    return res.json({ ok: true, restored: result.restored, failed: [] })
  }
  return res.json({ ok: true, ...planJsonRestore(parsed.backup) })
})
app.use(express.json({ limit: '1mb' }))

// ── Shared validation helpers (structured errors) ─────────────────────────────────
const ALLOWED_CATEGORIES = new Set(['Roofing','HVAC','Flooring','Plumbing','Electrical','Solar','Remodeling','Landscaping','Painting','Cleaning','General','Uncategorized'])
const ALLOWED_SALES_STAGES = new Set(['Qualified','Contacted','Replied','Meeting','Proposal','Won','Lost'])
const ALLOWED_OUTREACH_VERSIONS = new Set(['Concise','Balanced','Detailed'])
const ALLOWED_OUTREACH_STATUS = new Set(['Draft','Contacted','Replied','Meeting','Insufficient evidence'])
const ALLOWED_MANUAL_ACTIONS = new Set(['refresh','audit','muse','outreach','full'])
const ALLOWED_SETTINGS_KEYS = new Set(Object.keys(defaultSettings))
const ALLOWED_LEAD_PATCH_KEYS = new Set(['qualified','salesStage','qualifiedAt','notes','outreachSubject','outreachVersion','outreachDraft','outreachDrafts','outreachStatus','contactedAt','contract','lostReason','nextAction','nextTask','doNotContact','briefRationale','labels','category','location','phone','email','address','rating','reviews','sourceUrl','researchStatus','rev','museStale','outreachStale','website','contactCandidates','duplicateReviewed','outreachChannels','outreachProvenance','starred'])

function isNonEmptyString(v, max = 120) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
}
function isStringWithLength(v, min, max) {
  return typeof v === 'string' && v.trim().length >= min && v.trim().length <= max
}
function isValidDomain(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s.length < 3 || s.length > 253) return false
  if (/\s/.test(s)) return false
  if (!s.includes('.')) return false
  if (s.startsWith('-') || s.startsWith('.') || s.endsWith('-') || s.endsWith('.')) return false
  if (s.includes('..')) return false
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})+$/i.test(s)
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim())
}
function isPhoneLike(v) {
  const s = String(v || '').trim()
  if (s.length < 7 || s.length > 30) return false
  return /^[+\d][\d\s().\-]{5,}$/.test(s)
}
function clampInt(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const i = Math.round(n)
  if (i < min || i > max) return null
  return i
}
function normalizeDomainInput(v) {
  return String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
}
function badRequest(res, field, message, details) {
  const body = { error: message, code: 'VALIDATION_ERROR' }
  if (field) body.field = field
  if (details && details.length) body.details = details
  return res.status(400).json(body)
}
function notFound(res, message, field) {
  const body = { error: message, code: 'NOT_FOUND' }
  if (field) body.field = field
  return res.status(404).json(body)
}
function conflict(res, message, field, code = 'CONFLICT') {
  const body = { error: message, code }
  if (field) body.field = field
  return res.status(409).json(body)
}
function serviceUnavailable(res, message, code = 'PROVIDER_NOT_CONFIGURED', field) {
  const body = { error: message, code }
  if (field) body.field = field
  return res.status(503).json(body)
}
function payloadTooLarge(res, message) {
  return res.status(413).json({ error: message, code: 'PAYLOAD_TOO_LARGE' })
}
function unprocessable(res, message, field) {
  const body = { error: message, code: 'UNPROCESSABLE_ENTITY' }
  if (field) body.field = field
  return res.status(422).json(body)
}
function validateIdParam(id) {
  const s = String(id || '').trim()
  return s.length >= 3 && s.length <= 80 && /^[a-z0-9\-_:]+$/i.test(s)
}


const nowIso = () => new Date().toISOString()
const readRows = (table) => db.prepare(`SELECT payload FROM ${table} ORDER BY rowid ASC`).all().map((row) => JSON.parse(row.payload))
const readLead = (id) => {
  const row = db.prepare('SELECT payload FROM leads WHERE id = ?').get(id)
  return row ? JSON.parse(row.payload) : null
}
const readRun = (id) => {
  const row = db.prepare('SELECT payload FROM runs WHERE id = ?').get(id)
  return row ? JSON.parse(row.payload) : null
}
const saveLead = (lead) => {
  const next = { ...lead, rev: getRev(lead) + 1 }
  db.prepare('UPDATE leads SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(next), lead.id)
  persistLeadArtifacts(next)
  return next
}

// Field-scoped write with optimistic revision checking for async completions:
// merges `patch` into the latest row (never a stale whole object) and bumps
// the revision. Exported for tests via the revisions module contract.
const scopedLeadUpdate = (id, patch, { expectedRev = null } = {}) => {
  const next = updateLeadFields(db, id, patch, { expectedRev })
  persistLeadArtifacts(next)
  return next
}

// Run a completion builder against the latest row; on a revision conflict,
// rebuild once against the truly-latest row and write field-scoped.
const writeJobCompletion = (id, build) => {
  const current = readLead(id)
  if (!current) throw new Error('Lead not found')
  try {
    return scopedLeadUpdate(id, build(current), { expectedRev: getRev(current) })
  } catch (error) {
    if (error?.code !== 'REVISION_CONFLICT') throw error
    const latest = readLead(id)
    if (!latest) throw new Error('Lead not found')
    const rebuilt = scopedLeadUpdate(id, build(latest), {})
    recordEvent('lead', id, 'revision_conflict_resolved', { expectedRev: getRev(current), rev: getRev(latest) })
    return rebuilt
  }
}
const saveRun = (run) => {
  db.prepare('UPDATE runs SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(run), run.id)
  return run
}

function recordEvent(entityType, entityId, type, payload = {}) {
  db.prepare('INSERT INTO events (id, entity_type, entity_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`evt-${randomUUID()}`, entityType, entityId, type, JSON.stringify(payload), nowIso())
}

function touchLeadRun(lead, { runId, source, relationship = 'matched', at = nowIso() } = {}) {
  if (!runId) return lead
  const history = Array.isArray(lead.runHistory) ? [...lead.runHistory] : []
  const exists = history.some((item) => item.runId === runId && item.relationship === relationship)
  if (!exists) history.push({ runId, source: source || 'Research run', relationship, at })
  const updated = {
    ...lead,
    runHistory: history.slice(-30),
    lastRunId: runId,
    lastRunRelationship: relationship,
    lastRunAt: at,
  }
  if (relationship === 'new' && !updated.collectionRunId) updated.collectionRunId = runId
  return updated
}

function runClients(runId) {
  return readRows('leads').filter((lead) => Array.isArray(lead.runHistory) && lead.runHistory.some((item) => item.runId === runId))
}

function decorateRun(run, allRuns = readRows('runs')) {
  if (!run) return run
  const clients = runClients(run.id)
  const relationships = (relationship) => clients.filter((lead) => lead.runHistory.some((item) => item.runId === run.id && item.relationship === relationship))
  const chronological = [...allRuns].sort((a, b) => new Date(a.startedAt || a.createdAt).getTime() - new Date(b.startedAt || b.createdAt).getTime())
  const sequence = chronological.findIndex((item) => item.id === run.id) + 1
  const newClients = relationships('new')
  const matchedClients = relationships('matched')
  const auditedClients = relationships('audited')
  return {
    ...run,
    sequence: sequence > 0 ? sequence : null,
    clientIds: clients.map((lead) => lead.id),
    newClientIds: newClients.map((lead) => lead.id),
    matchedClientIds: matchedClients.map((lead) => lead.id),
    auditedClientIds: auditedClients.map((lead) => lead.id),
    clientCount: clients.length,
    newClients: newClients.length,
    matchedClients: matchedClients.length,
    auditedClients: auditedClients.length,
  }
}

function decorateRuns(runs = readRows('runs')) {
  const synced = runs.map((run) => syncRun(run.id) || run)
  return synced
    .sort((a, b) => new Date(b.startedAt || b.createdAt).getTime() - new Date(a.startedAt || a.createdAt).getTime())
    .map((run) => decorateRun(run, synced))
}

function leadMarkdown(lead) {
  const list = (items = []) => items.length ? items.map((item) => `- ${item}`).join('\n') : '- None recorded'
  const metric = (key) => lead.businessIntelligence?.companyMetrics?.[key]?.value ?? 'Unknown — no source connected'
  const muse = lead.museAnalysis?.status === 'Completed'
    ? `\n## AI synthesis (advisory${lead.museAnalysis.stale ? ' — STALE: a newer audit completed after this synthesis' : ''})\n\n- Recommendation: ${lead.museAnalysis.qualificationRecommendation}\n- Rationale: ${lead.museAnalysis.qualificationRationale}\n- Model: ${lead.museAnalysis.generation?.model || 'Not recorded'}\n- Generated: ${lead.museAnalysis.generation?.generatedAt || 'Not recorded'}\n\n${lead.museAnalysis.summary}\n\n### Prioritized opportunities\n\n${(lead.museAnalysis.topOpportunities || []).map((item) => `- **${item.severity} — ${item.title}:** ${item.evidence} Recommendation: ${item.recommendation}`).join('\n') || '- None recorded'}\n\n### Strengths\n\n${list(lead.museAnalysis.strengths)}\n\n### Unknowns\n\n${list(lead.museAnalysis.unknowns)}\n\nAI is an evidence-synthesis aid. It does not alter the deterministic opportunity score.\n`
    : ''
  return `# ${lead.company}\n\n` +
    (lead.currentAuditId ? `## Audit version\n\n- Audit ID: ${lead.currentAuditId}${lead.auditVersion != null ? ` (version ${lead.auditVersion})` : ''}\n- Provenance: versioned audit artifacts\n\n` : `## Audit version\n\n- Audit ID: legacy (unversioned)\n- Provenance: unknown — pre-versioning record\n\n`) +
    `## Business profile\n\n` +
    `- Category: ${lead.category}\n- Location: ${lead.location}\n- Website: ${lead.website ? `https://${lead.website}` : `Not supplied (${lead.websiteStatus || 'not_supplied'})`}\n- Phone: ${lead.phone}\n- Public email: ${lead.email}\n- Google rating: ${lead.rating} (${lead.reviews} reviews)\n\n` +
    `## Opportunity assessment\n\n- Preliminary opportunity: ${lead.prelimScore}/100\n- Opportunity score: ${lead.opportunityScore ?? 'Not analyzed'}\n- Confidence: ${lead.confidence ?? 'Not analyzed'}\n- Source: ${lead.analysisSource || 'Not recorded'}\n- Research status: ${lead.researchStatus}\n- Commercial value: ${lead.leadValue ? `${lead.leadValue.leadValueScore}/100 (${lead.leadValue.band}, coverage ${Math.round((lead.leadValue.coverage || 0) * 100)}%, rubric ${lead.leadValue.version})` : 'Not scored'}\n- Rebuild feasibility: ${lead.rebuild}${lead.researchFailure ? `\n- Failed stage: ${['Scraped', 'Analyzed', 'Qualified'][lead.researchFailure.stage] || 'Unknown'}\n- Failure reason: ${lead.researchFailure.reason}` : ''}\n\n` +
    `## Website audit\n\n- Mobile performance: ${formatProvenanceScore(resolveMetricProvenance(lead, 'performance'))}\n- Accessibility: ${formatProvenanceScore(resolveMetricProvenance(lead, 'accessibility'))}\n- SEO: ${formatProvenanceScore(resolveMetricProvenance(lead, 'seo'))}\n- Best practices: ${formatProvenanceScore(resolveNestedProvenance(lead?.measureProvenance?.bestPractices, lead?.lighthouse?.scores?.bestPractices))}\n- Same-site pages crawled: ${lead.pageCount ?? 'Not measured'}\n- Internal links checked: ${lead.checkedLinks ?? 'Not measured'}\n- Broken internal links: ${lead.brokenLinks ?? 'Not measured'}${lead.linkSummary ? ` (confirmed 404/410 of ${lead.linkSummary.attempted ?? '?'} attempted; ${lead.linkSummary.reachable ?? 0} reachable, ${lead.linkSummary.unverified ?? 0} unverified — blocked/unreachable links are not called broken)` : ''}\n- Mobile quality: ${lead.mobileQuality}\n- HTTPS: ${lead.https == null ? 'Not measured' : lead.https ? 'Yes' : 'No'}\n- Detected stack: ${(lead.stack || []).join(', ') || 'Unknown'}\n\n` +
    `## Business intelligence\n\n- Digital maturity: ${lead.businessIntelligence?.digitalMaturity?.score ?? 'Not calculated'}/100${lead.businessIntelligence?.digitalMaturity?.band ? ` (${lead.businessIntelligence.digitalMaturity.band})` : ''}${lead.businessIntelligence?.digitalMaturity?.version ? ` [formula v${lead.businessIntelligence.digitalMaturity.version}]` : ''}${lead.businessIntelligence?.digitalMaturity?.coverage ? ` — evidence coverage ${lead.businessIntelligence.digitalMaturity.coverage.measuredComponents}/${lead.businessIntelligence.digitalMaturity.coverage.totalComponents} components (${lead.businessIntelligence.digitalMaturity.coverage.share}% of weighted signals measured)` : ''}\n- Employees: ${metric('employeeCount')}\n- Annual revenue: ${metric('annualRevenue')}\n- Annual profit: ${metric('annualProfit')}\n- Founded: ${metric('foundedYear')}\n- Branch count: ${metric('branchCount')}\n- Locations observed in discovery: ${lead.businessIntelligence?.locationsObserved ?? 'Not observed'}\n- Google profile claimed: ${lead.businessIntelligence?.claimed == null ? 'Unknown' : lead.businessIntelligence.claimed ? 'Yes' : 'No'}\n- Online booking: ${lead.businessIntelligence?.onlineBooking ? 'Detected' : 'Not detected'}\n- Four- and five-star review share: ${lead.businessIntelligence?.positiveReviewShare ?? 'Unknown'}${lead.businessIntelligence?.positiveReviewShare != null ? '%' : ''}\n- Latest sampled review: ${lead.businessIntelligence?.latestObservedReviewAt || 'Unknown'}\n\nSource-backed fields remain unknown when no provider supplies them.\n\n` +
    (lead.captureQuality || lead.researchStatus === 'Inconclusive' ? `## Capture quality\n\n- Assessment: ${lead.researchStatus === 'Inconclusive' ? 'Inconclusive — no defect-derived score is claimed' : lead.researchStatus}\n- Capture: ${lead.captureQuality?.quality || 'Not recorded'} via ${lead.captureQuality?.captureMethod || 'unknown method'}\n- Reason: ${lead.captureQuality?.reason || lead.lastAuditAttempt?.reason || 'Not recorded'}\n- Rendered-page fallback: ${lead.captureQuality?.renderedFallback || 'not applicable'}\n- Last successful audit: ${lead.lastSuccessfulAudit ? `${lead.lastSuccessfulAudit.score}/100 on ${lead.lastSuccessfulAudit.at} (${lead.lastSuccessfulAudit.url || 'URL not recorded'})` : 'None recorded'}\n\n` : '') +
    `## Main observed issue\n\n**${lead.mainIssue}:** ${lead.issueDetail}\n\n` +
    `## Findings\n\n${list(lead.problems)}\n\n` +
    `## Evidence\n\n${list(lead.evidence)}\n\n` +
    muse +
    (lead.notes ? `## Reviewer notes\n\n${lead.notes}\n\n` : '') +
    `## Safety contract\n\nDo not invent revenue, decision-maker names, hosting costs, performance metrics, or unobserved facts. Outreach remains manual and must be reviewed before sending.\n` +
    (lead.contract ? `\n## Won contract\n\n- Approved value: ${lead.contract.currency || 'USD'} ${lead.contract.amount || 0}\n- Scope: ${lead.contract.scope || 'Not recorded'}\n- Terms: ${lead.contract.terms || 'Not recorded'}\n- Signed on: ${lead.contract.signedOn || 'Not recorded'}\n- Start date: ${lead.contract.startDate || 'Not recorded'}\n- Conditions: ${lead.contract.conditions || 'None recorded'}\n- Next step: ${lead.contract.nextStep || 'Not recorded'}\n` : '')
}

function buildAuditData(lead) {
  return {
    preliminaryScore: lead.prelimScore, opportunityScore: lead.opportunityScore, confidence: lead.confidence,
    source: lead.analysisSource, status: lead.researchStatus, mainIssue: lead.mainIssue,
    issueDetail: lead.issueDetail, pageCount: lead.pageCount, sitemapPageCount: lead.sitemapPageCount,
    performance: lead.performance, accessibility: lead.accessibility, seo: lead.seo, measureProvenance: lead.measureProvenance || null, mobileQuality: lead.mobileQuality,
    https: lead.https, checkedLinks: lead.checkedLinks, brokenLinks: lead.brokenLinks, rebuild: lead.rebuild, stack: lead.stack,
    problems: lead.problems, evidence: lead.evidence, auditSummary: lead.auditSummary || null,
    auditStatus: lead.auditStatus || null, auditComponents: lead.auditComponents || null,
    crawlPages: lead.crawlPages || [], crawlErrors: lead.crawlErrors || [], brokenLinkDetails: lead.brokenLinkDetails || [],
    linkSummary: lead.linkSummary || null, unverifiedLinkDetails: lead.unverifiedLinkDetails || [],
    lighthouse: lead.lighthouse || null,
    auditedUrl: lead.auditedUrl || null, auditedAt: lead.auditedAt || null,
    captureQuality: lead.captureQuality || null,
    lastAuditAttempt: lead.lastAuditAttempt || null, lastSuccessfulAudit: lead.lastSuccessfulAudit || null,
    currentAuditId: lead.currentAuditId || null, auditVersion: lead.auditVersion ?? null,
    researchFailure: lead.researchFailure || null, history: lead.auditHistory || [],
  }
}

function writeLeadArtifacts(lead, includeProfile = false, rootDir = dataDir) {
  const folder = join(rootDir, 'leads', lead.id)
  mkdirSync(folder, { recursive: true })
  const businessData = {
    id: lead.id, company: lead.company, category: lead.category, location: lead.location,
    website: lead.website, address: lead.address || null, phone: lead.phone, email: lead.email, rating: lead.rating,
    reviews: lead.reviews, collectedAt: lead.collectedAt, sourceUrl: lead.sourceUrl || null,
    businessIntelligence: lead.businessIntelligence || null,
  }
  const auditData = buildAuditData(lead)
  writeFileSync(join(folder, 'raw.json'), JSON.stringify(businessData, null, 2), 'utf8')
  if (lead.businessIntelligence) writeFileSync(join(folder, 'business-intelligence.json'), JSON.stringify(businessData, null, 2), 'utf8')
  writeFileSync(join(folder, 'audit.json'), JSON.stringify(auditData, null, 2), 'utf8')
  if (lead.opportunityScore != null) {
    const manifest = lead.currentAuditId ? readManifest(rootDir, lead.id, lead.currentAuditId) : null
    writeFileSync(join(folder, 'analysis-v1.md'), renderLeadReportMarkdown(lead, { manifest }), 'utf8')
  }
  if (lead.outreachDraft || Object.keys(lead.outreachDrafts || {}).length) {
    writeFileSync(join(folder, 'outreach.json'), JSON.stringify({
      to: lead.email,
      subject: lead.outreachSubject || `Quick idea for ${lead.company}`,
      body: lead.outreachDraft,
      selectedVersion: lead.outreachVersion || 'Concise',
      versions: lead.outreachDrafts || {},
      generation: lead.outreachGeneration || null,
      status: lead.outreachStatus || 'Draft',
      contactedAt: lead.contactedAt || null,
      editedByHuman: Boolean(lead.outreachEdited),
      updateAvailable: Boolean(lead.outreachUpdateAvailable),
      candidates: lead.outreachCandidates || [],
    }, null, 2), 'utf8')
  }
  if (lead.museAnalysis) writeFileSync(join(folder, 'muse-analysis.json'), JSON.stringify(lead.museAnalysis, null, 2), 'utf8')
  if (lead.contract) writeFileSync(join(folder, 'contract.json'), JSON.stringify(lead.contract, null, 2), 'utf8')
  if (includeProfile) writeFileSync(join(folder, 'profile.md'), leadMarkdown(lead), 'utf8')
  return folder
}

// DB-versus-artifact failures (ROH-29) are never silent: the DB write stands
// (it succeeded), the artifact error is recorded with status, and repair
// rewrites the files from the database row (covered by API-level tests).
function tryWriteLeadArtifacts(lead, rootDir = dataDir) {
  try {
    writeLeadArtifacts(lead, false, rootDir)
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function readArtifactFailures() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('storage_artifact_failures')
    const list = row ? JSON.parse(row.value) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function noteArtifactFailure(leadId, error) {
  const failures = [{ leadId, error: String(error || 'unknown write error'), at: nowIso() }, ...readArtifactFailures().filter((item) => item.leadId !== leadId)].slice(0, 20)
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('storage_artifact_failures', JSON.stringify(failures))
}

function clearArtifactFailure(leadId) {
  const remaining = readArtifactFailures().filter((item) => item.leadId !== leadId)
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('storage_artifact_failures', JSON.stringify(remaining))
}

function persistLeadArtifacts(lead) {
  const written = tryWriteLeadArtifacts(lead)
  if (!written.ok) {
    recordEvent('lead', lead.id, 'artifact_write_failed', { error: written.error, rev: lead.rev })
    noteArtifactFailure(lead.id, written.error)
  } else if (readArtifactFailures().some((item) => item.leadId === lead.id)) {
    clearArtifactFailure(lead.id)
  }
  return written
}

readRows('leads').forEach((lead) => {
  const normalized = normalizeLeadWorkflow(lead)
  if (JSON.stringify(normalized) !== JSON.stringify(lead)) saveLead(normalized)
  else writeLeadArtifacts(lead)
})

function readSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, JSON.parse(row.value)]))
}

function parseJob(row) {
  if (!row) return null
  const createdMs = Date.parse(row.created_at || '')
  const updatedMs = Date.parse(row.updated_at || '')
  return {
    id: row.id, runId: row.run_id, leadId: row.lead_id, type: row.type, status: row.status,
    progress: row.progress, attempts: row.attempts, maxAttempts: row.max_attempts,
    triggeredBy: row.triggered_by || 'system',
    payload: JSON.parse(row.payload || '{}'), result: row.result ? JSON.parse(row.result) : null,
    error: row.error, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at, updatedAt: row.updated_at,
    durationMs: Number.isFinite(createdMs) && Number.isFinite(updatedMs) ? Math.max(0, updatedMs - createdMs) : null,
  }
}

function readJob(id) { return parseJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) }

function queueJob({ type, runId = null, leadId = null, payload = {}, maxAttempts = 1, triggeredBy = 'system' }) {
  const id = `job-${randomUUID()}`
  const createdAt = nowIso()
  db.prepare("INSERT INTO jobs (id, run_id, lead_id, type, status, progress, attempts, max_attempts, payload, created_at, updated_at, triggered_by) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)")
    .run(id, runId, leadId, type, 'Queued', maxAttempts, JSON.stringify(payload), createdAt, createdAt, triggeredBy)
  recordEvent('job', id, 'queued', { type, runId, leadId, triggeredBy })
  return readJob(id)
}

// Live cancellation handles for Running jobs. The AbortController aborts
// in-flight fetches (audit path); the payload.cancelRequested flag covers
// phase-based runners (synthesis/refresh/discovery) between awaits.
const jobSignals = new Map()

function requestJobCancel(id) {
  jobSignals.get(id)?.abort()
  const job = readJob(id)
  if (job && !job.payload?.cancelRequested) updateJob(id, { payload: { ...job.payload, cancelRequested: true } })
}

function releaseJobCancel(id) {
  jobSignals.delete(id)
}

function throwIfJobCancelled(id) {
  const job = readJob(id)
  if (job?.payload?.cancelRequested) {
    const error = new Error('Job cancelled; partial work is preserved')
    error.code = 'CANCELLED'
    throw error
  }
}

function codedProviderError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

// Provider polling total deadline (ROH-23): a snapshot that never becomes
// ready fails with an actionable error instead of polling forever. The
// snapshot id stays in the payload, so a manual retry resumes polling the
// same snapshot instead of triggering (and paying for) a new one.
function assertPollDeadline(job, settings) {
  const startedMs = Date.parse(job.payload?.pollStartedAt || '')
  if (!Number.isFinite(startedMs)) return
  const timeoutMs = Number(settings.discoveryPollTimeoutMs) || 1800000
  if (Date.now() - startedMs <= timeoutMs) return
  throw codedProviderError(
    `Bright Data has not produced a result within ${Math.round(timeoutMs / 60000)} minutes; the snapshot is kept so a retry resumes it instead of starting a new paid request`,
    'PROVIDER_TIMEOUT',
  )
}

function isRunCancelled(runId) {
  if (!runId) return false
  const run = readRun(runId)
  return Boolean(run) && run.status === 'Cancelled'
}

// Run watchdog (ROH-23): every run persists a deadlineAt; a run still active
// past its deadline is marked Timed out with its queued work cancelled, so a
// stuck provider can never leave a run Running forever.
function runRunWatchdog() {
  const timeoutMs = Number(readSettings().runTimeoutMs) || 7200000
  const now = Date.now()
  for (const run of readRows('runs')) {
    if (!['Running', 'Waiting'].includes(run.status)) continue
    const persisted = Date.parse(run.deadlineAt || '')
    const started = Date.parse(run.startedAt || run.createdAt || '')
    const deadlineMs = Number.isFinite(persisted) ? persisted : Number.isFinite(started) ? started + timeoutMs : NaN
    if (!Number.isFinite(deadlineMs) || now <= deadlineMs) continue
    db.prepare("UPDATE jobs SET status = 'Cancelled', progress = 100, error = 'Run exceeded its time budget', updated_at = ? WHERE run_id = ? AND status IN ('Queued', 'Waiting', 'Running')").run(nowIso(), run.id)
    saveRun({ ...run, status: 'Timed out', progress: 100, duration: 'Timed out', completedAt: run.completedAt || nowIso() })
    recordEvent('run', run.id, 'timed_out', { deadlineAt: run.deadlineAt || null })
  }
}

// Completion claim: run functions save terminal results only while their job
// is still Running. A late finish after cancel/timeout is dropped silently so
// it can neither overwrite state, advance the pipeline, nor notify twice.
function claimJobCompletion(id) {
  const job = readJob(id)
  return Boolean(job) && job.status === 'Running'
}

function updateJob(id, changes) {
  const current = readJob(id)
  if (!current) return null
  const next = { ...current, ...changes, updatedAt: nowIso() }
  db.prepare('UPDATE jobs SET status = ?, progress = ?, attempts = ?, payload = ?, result = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?')
    .run(next.status, next.progress, next.attempts, JSON.stringify(next.payload || {}), next.result ? JSON.stringify(next.result) : null, next.error || null, next.nextAttemptAt || null, next.updatedAt, id)
  return readJob(id)
}

function formatDuration(startedAt, completedAt = null) {
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const seconds = Math.max(1, Math.round((end - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function syncRun(runId) {
  if (!runId) return null
  const run = readRun(runId)
  if (!run) return null
  const jobs = db.prepare('SELECT type, status, progress FROM jobs WHERE run_id = ?').all(runId)
  if (!jobs.length) return run
  const audits = jobs.filter((job) => job.type === 'audit')
  const terminal = jobs.filter((job) => ['Completed', 'Failed', 'Error', 'Timed out', 'Cancelled'].includes(job.status)).length
  const averageProgress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + Number(job.progress || 0), 0) / jobs.length) : 100
  const completed = jobs.length > 0 && terminal === jobs.length
  const succeeded = jobs.filter((job) => job.status === 'Completed').length
  const failed = jobs.filter((job) => ['Failed', 'Error', 'Timed out'].includes(job.status)).length
  // Terminal run outcomes are honest: an all-failed run is Failed, a mixed
  // run is Completed with errors, and only a clean run is Completed.
  const terminalOutcome = failed > 0 && succeeded === 0 ? 'Failed' : failed > 0 ? 'Completed with errors' : 'Completed'
  const status = run.status === 'Cancelled' ? 'Cancelled' : run.status === 'Paused' ? 'Paused' : run.status === 'Timed out' ? 'Timed out' : completed ? terminalOutcome : 'Running'
  const updated = {
    ...run,
    status,
    progress: completed ? 100 : averageProgress,
    crawled: audits.filter((job) => ['Completed', 'Failed', 'Error', 'Timed out'].includes(job.status)).length,
    audited: audits.filter((job) => job.status === 'Completed').length,
    failed: jobs.filter((job) => job.status === 'Failed').length,
    datasets: audits.filter((job) => job.status === 'Completed').length,
    qualified: jobs.filter((job) => job.type === 'qualify' && job.status === 'Completed').length,
    duration: completed ? formatDuration(run.startedAt || run.createdAt, run.completedAt || nowIso()) : status,
    completedAt: completed ? (run.completedAt || nowIso()) : null,
  }
  saveRun(updated)
  if (completed && !['Completed', 'Completed with errors', 'Failed', 'Timed out'].includes(run.status)) recordEvent('run', runId, 'completed', { outcome: status, audited: updated.audited, failed: updated.failed })
  return updated
}

function importedLead(row, index = 0, source = 'CSV import') {
  const rating = Number(row.rating || 0)
  const reviews = Number(row.reviews || row.review_count || 0)
  const score = Math.max(35, Math.min(95, Math.round(42 + rating * 6 + Math.log10(Math.max(reviews, 1)) * 8)))
  const website = String(row.website || row.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  // Website state (ROH-5): omission is unknown, never proof of absence.
  const websiteStatus = row.websiteStatus === 'audited' ? 'audited' : website ? (row.websiteStatus || 'supplied') : 'not_supplied'
  const businessId = String(row.businessId || '').trim() || `manual:${randomUUID()}`
  const lead = {
    id: `lead-${Date.now().toString(36)}-${index}-${randomUUID().slice(0, 6)}`,
    company: String(row.company || row.name || row.business || '').trim(),
    website,
    websiteStatus,
    businessId,
    category: row.category || 'Uncategorized', location: row.location || row.address || 'Unknown', address: row.address || row.location || 'Not collected',
    phone: row.phone || 'Not collected', email: row.email || 'Not collected', rating, reviews,
    sourceUrl: row.sourceUrl || null, prelimScore: score, opportunityScore: null, confidence: null,
    researchStatus: 'Collected', salesStage: null, mainIssue: website ? 'Audit pending' : 'No website supplied',
    issueDetail: website ? 'Business data was saved; website evidence has not been collected yet.' : 'Business data was saved without a website; it can be scored, qualified and moved through sales, and audited once a website is added.',
    updated: 'Just now', collectedAt: new Date().toLocaleString('en-US'), pageCount: null, performance: null,
    accessibility: null, seo: null, checkedLinks: null, brokenLinks: null, auditStatus: null, auditComponents: null,
    lighthouse: null, crawlPages: [], crawlErrors: [], brokenLinkDetails: [], mobileQuality: 'Unknown', https: null,
    rebuild: 'Unknown', stack: [], labels: [source], problems: [], evidence: [`Business record saved from ${source}`], notes: '',
  }
  const importedMetric = (value) => ({ value: value == null || value === '' ? null : value, source: value == null || value === '' ? null : source, confidence: value == null || value === '' ? null : 'Imported' })
  const csvIntelligence = {
    source,
    fetchedAt: nowIso(),
    locations: lead.location && lead.location !== 'Unknown' ? [{ address: lead.location }] : [],
    companyMetrics: {
      employeeCount: importedMetric(row.employee_count || row.employees || row.company_size),
      annualRevenue: importedMetric(row.annual_revenue || row.estimated_revenue || row.revenue),
      annualProfit: importedMetric(row.annual_profit || row.estimated_profit || row.profit),
      foundedYear: importedMetric(row.founded_year || row.year_founded || row.founded),
      branchCount: importedMetric(row.branch_count || row.number_of_locations || row.locations_count),
    },
  }
  const hasCsvIntelligence = Object.values(csvIntelligence.companyMetrics).some((item) => item.value != null)
  const assembled = row.businessIntelligence || hasCsvIntelligence ? enrichLead(lead, row.businessIntelligence || csvIntelligence) : lead
  // Business-only signals still produce an honest low-coverage value score.
  assembled.leadValue = scoreLeadValue(assembled, { weights: readSettings().leadValueWeights })
  return assembled
}

function normalizeIdentityText(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  // Placeholder addresses carry no identity evidence.
  return normalized === 'unknown' || normalized === 'not collected' ? '' : normalized
}

// Identity-first duplicate detection (ROH-5). Merge order: exact businessId,
// then shared provider place/cid, then conservative name + (address or
// contact) evidence. A shared domain or bare company name alone never merges —
// two franchise locations on one domain stay distinct, and ambiguous rows stay
// separate for human review instead of being auto-merged.
function findDuplicateLead(lead) {
  const existing = readRows('leads')
  const byBusinessId = lead.businessId && !lead.businessId.startsWith('manual:')
    ? existing.find((item) => item.businessId === lead.businessId)
    : null
  if (byBusinessId) return { lead: byBusinessId, matchBasis: 'business-id' }
  const placeId = lead.businessIntelligence?.placeId || null
  const cid = lead.businessIntelligence?.cid || null
  if (placeId || cid) {
    const byProvider = existing.find((item) => (placeId && item.businessIntelligence?.placeId === placeId) || (cid && item.businessIntelligence?.cid === cid))
    if (byProvider) return { lead: byProvider, matchBasis: 'provider-id' }
  }
  const name = normalizeIdentityText(lead.company)
  const address = normalizeIdentityText(lead.address === 'Not collected' ? '' : lead.address)
  const phone = String(lead.phone || '').replace(/[^0-9]/g, '')
  const email = String(lead.email || '').trim().toLowerCase()
  if (name) {
    const byEvidence = existing.find((item) => {
      if (normalizeIdentityText(item.company) !== name) return false
      const itemAddress = normalizeIdentityText(item.address === 'Not collected' ? '' : item.address)
      const itemPhone = String(item.phone || '').replace(/[^0-9]/g, '')
      const itemEmail = String(item.email || '').trim().toLowerCase()
      if (address && itemAddress && address === itemAddress) return true
      if (phone.length >= 7 && phone === itemPhone) return true
      if (email && email !== 'not collected' && email === itemEmail) return true
      return false
    })
    if (byEvidence) return { lead: byEvidence, matchBasis: 'name-plus-evidence' }
  }
  return null
}

function insertUniqueLead(row, index, source, { runId = null, at = nowIso() } = {}) {
  const lead = importedLead(row, index, source)
  if (!lead.company) return null
  const duplicate = findDuplicateLead(lead)
  if (duplicate) {
    const { lead: existing, matchBasis } = duplicate
    const touched = touchLeadRun(existing, { runId, source, relationship: 'matched', at })
    const enriched = lead.businessIntelligence ? enrichLead({
      ...touched,
      phone: existing.phone === 'Not collected' && lead.phone !== 'Not collected' ? lead.phone : existing.phone,
      email: existing.email === 'Not collected' && lead.email !== 'Not collected' ? lead.email : existing.email,
    }, lead.businessIntelligence) : touched
    // The website attribute follows strong identity: the same Place ID with a
    // new website moves the website (audit re-enabled, history kept), while a
    // weak name-plus-evidence match only fills a missing website, never
    // overwrites one a human may have set.
    const strongMatch = matchBasis === 'business-id' || matchBasis === 'provider-id'
    const websiteChanged = strongMatch && lead.website && lead.website.toLowerCase() !== String(existing.website || '').toLowerCase()
    const websiteAdded = !existing.website && lead.website
    if (websiteChanged) recordEvent('lead', existing.id, 'website_changed', { from: existing.website || null, to: lead.website, matchBasis })
    const withWebsite = (websiteAdded || websiteChanged)
      ? { ...enriched, website: lead.website, websiteStatus: lead.websiteStatus || 'supplied' }
      : enriched
    const next = runId ? touchLeadRun(withWebsite, { runId, source, relationship: 'matched', at }) : withWebsite
    if (next !== existing) {
      next.leadValue = scoreLeadValue(next, { weights: readSettings().leadValueWeights })
      saveLead(next)
    }
    recordEvent('lead', existing.id, 'duplicate_matched', { source, runId, matchBasis, websiteAdded: Boolean(websiteAdded) })
    Object.defineProperty(next, '_runImport', { value: { created: false, relationship: 'matched' }, enumerable: false })
    return next
  }
  const created = touchLeadRun(lead, { runId, source, relationship: 'new', at })
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run(created.id, JSON.stringify(created))
  persistLeadArtifacts(created)
  recordEvent('lead', created.id, 'created', { source, runId, relationship: 'new' })
  Object.defineProperty(created, '_runImport', { value: { created: true, relationship: 'new' }, enumerable: false })
  return created
}

function backfillRunProvenance() {
  const runs = readRows('runs')
  if (!runs.length) return
  const runWindows = db.prepare("SELECT entity_id, type, created_at FROM events WHERE entity_type = 'run' AND type IN ('started', 'discovery_completed') ORDER BY created_at ASC").all()
  const discoveryWindows = runs.map((run) => {
    const started = runWindows.find((event) => event.entity_id === run.id && event.type === 'started')?.created_at || run.startedAt
    const completed = runWindows.filter((event) => event.entity_id === run.id && event.type === 'discovery_completed' && new Date(event.created_at).getTime() >= new Date(started).getTime()).at(-1)?.created_at
    return { run, started, completed }
  })
  const createdEvents = db.prepare("SELECT entity_id, created_at FROM events WHERE entity_type = 'lead' AND type = 'created'").all()
  const createdAtByLead = new Map(createdEvents.map((event) => [event.entity_id, event.created_at]))
  const auditJobs = db.prepare("SELECT run_id, lead_id, updated_at FROM jobs WHERE run_id IS NOT NULL AND lead_id IS NOT NULL AND type = 'audit'").all()
  const changes = new Map()
  readRows('leads').forEach((lead) => {
    let next = lead
    const createdAt = createdAtByLead.get(lead.id)
    if (createdAt) {
      const matched = discoveryWindows
        .filter(({ run, started, completed }) => run.source === 'Bright Data Google Maps' && new Date(started).getTime() <= new Date(createdAt).getTime() && (!completed || new Date(createdAt).getTime() <= new Date(completed).getTime()))
        .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime())[0]
      if (matched) next = touchLeadRun(next, { runId: matched.run.id, source: matched.run.source, relationship: 'new', at: createdAt })
    }
    auditJobs.filter((job) => job.lead_id === lead.id).forEach((job) => {
      const run = runs.find((item) => item.id === job.run_id)
      if (run) {
        const hasNewRelationship = next.runHistory?.some((item) => item.runId === run.id && item.relationship === 'new')
        if (!hasNewRelationship && run.source === 'Bright Data Google Maps') next = touchLeadRun(next, { runId: run.id, source: run.source, relationship: 'matched', at: job.updated_at })
        next = touchLeadRun(next, { runId: run.id, source: run.source || 'Research run', relationship: 'audited', at: job.updated_at })
      }
    })
    if (JSON.stringify(next) !== JSON.stringify(lead)) changes.set(next.id, next)
  })
  changes.forEach((lead) => saveLead(lead))
}

// One-time identity backfill (ROH-5): existing leads gain a stable businessId
// and websiteStatus without touching notes, drafts, stages, contracts or
// suppression. Ambiguous historical rows are left separate, never merged.
function backfillLeadIdentity() {
  let migrated = 0
  for (const lead of readRows('leads')) {
    let next = lead
    if (!next.businessId) {
      const placeId = next.businessIntelligence?.placeId || null
      const cid = next.businessIntelligence?.cid || null
      const domain = String(next.website || '').toLowerCase().replace(/\/$/, '')
      next = { ...next, businessId: placeId ? `brightdata:place:${placeId}` : cid ? `brightdata:cid:${cid}` : domain ? `site:${domain}` : `manual:${randomUUID()}` }
    }
    if (!next.websiteStatus) {
      next = { ...next, websiteStatus: next.opportunityScore != null || next.analysisSource ? 'audited' : next.website ? 'supplied' : 'not_supplied' }
    }
    if (next !== lead) {
      saveLead(next)
      migrated += 1
    }
  }
  if (migrated) recordEvent('system', 'identity-backfill', 'completed', { migrated })
}

backfillRunProvenance()
backfillLeadIdentity()

const manualActionLabels = {
  refresh: 'Refresh business data',
  audit: 'Run website audit',
  muse: 'Run AI analysis',
  outreach: 'Generate outreach',
  full: 'Run full workflow',
}

function manualRunState(lead, action, changes = {}) {
  const previous = !changes.reset && lead.manualRun?.action === action ? lead.manualRun : {}
  return {
    ...previous,
    action,
    label: manualActionLabels[action] || action,
    status: changes.status || previous.status || 'Queued',
    progress: changes.progress ?? previous.progress ?? 0,
    phase: changes.phase || previous.phase || 'Queued',
    jobId: changes.jobId || previous.jobId || null,
    startedAt: previous.startedAt || changes.startedAt || nowIso(),
    completedAt: changes.completedAt ?? previous.completedAt ?? null,
    error: changes.error ?? null,
  }
}

function queueAuditForLead(lead, { workflow = 'audit', manualAction = null, continueRun = false } = {}) {
  // Website-dependent stages are skipped cleanly when no website exists — with
  // a reason, never a failed request against an invented defect.
  if (!lead.website) {
    recordEvent('lead', lead.id, 'audit_skipped', { workflow, manualAction, reason: 'no-website' })
    return { lead, job: null, alreadyQueued: false, skipped: true, skipReason: 'This client has no website to audit yet.' }
  }
  const active = db.prepare("SELECT * FROM jobs WHERE lead_id = ? AND type = 'audit' AND status IN ('Queued', 'Running', 'Waiting') ORDER BY created_at DESC LIMIT 1").get(lead.id)
  if (active) return { lead, job: parseJob(active), alreadyQueued: true }
  const settings = readSettings()
  const job = queueJob({ type: 'audit', leadId: lead.id, payload: { respectRobots: settings.respectRobots, workflow, manualAction }, maxAttempts: 2 })
  const updated = saveLead({
    ...lead,
    researchFailure: null,
    researchStatus: 'Queued',
    researchJob: { id: job.id, status: 'Queued', progress: 0, phase: 'Waiting for website audit' },
    ...(manualAction ? { manualRun: manualRunState(lead, manualAction, { reset: !continueRun, status: 'Queued', progress: continueRun ? 20 : 0, phase: manualAction === 'full' ? 'Website audit queued' : 'Queued', jobId: job.id }) } : {}),
    updated: 'Queued now',
  })
  recordEvent('lead', lead.id, 'audit_queued', { jobId: job.id, workflow, manualAction })
  return { lead: updated, job, alreadyQueued: false }
}

function queueRefreshForLead(lead, { manualAction = 'refresh' } = {}) {
  const active = db.prepare("SELECT * FROM jobs WHERE lead_id = ? AND type = 'refresh' AND status IN ('Queued', 'Running', 'Waiting') ORDER BY created_at DESC LIMIT 1").get(lead.id)
  if (active) return { lead, job: parseJob(active), alreadyQueued: true }
  const job = queueJob({ type: 'refresh', leadId: lead.id, payload: { manualAction }, maxAttempts: 3 })
  const updated = saveLead({
    ...lead,
    refreshJob: { id: job.id, status: 'Queued', progress: 0, phase: 'Waiting for Bright Data' },
    manualRun: manualRunState(lead, manualAction, { reset: true, status: 'Queued', progress: 0, phase: manualAction === 'full' ? 'Refreshing business data' : 'Queued', jobId: job.id }),
    updated: 'Business refresh queued',
  })
  recordEvent('lead', lead.id, 'business_refresh_queued', { jobId: job.id, manualAction })
  return { lead: updated, job, alreadyQueued: false }
}

function queueMuseSynthesis(lead, payload = {}) {
  const active = db.prepare("SELECT * FROM jobs WHERE lead_id = ? AND type = 'synthesize' AND status IN ('Queued', 'Running', 'Waiting') ORDER BY created_at DESC LIMIT 1").get(lead.id)
  if (active) return { lead, job: parseJob(active), alreadyQueued: true }
  const job = queueJob({ type: 'synthesize', leadId: lead.id, payload, maxAttempts: 2 })
  const updated = saveLead({
    ...lead,
    museAnalysis: { ...(lead.museAnalysis || {}), status: 'Queued', error: null },
    museJob: { id: job.id, status: 'Queued', progress: 0 },
    ...(payload.manualAction ? { manualRun: manualRunState(lead, payload.manualAction, { reset: !payload.continueRun, status: 'Queued', progress: payload.manualAction === 'full' ? 72 : 0, phase: 'AI analysis queued', jobId: job.id }) } : {}),
    updated: 'AI synthesis queued',
  })
  recordEvent('lead', lead.id, 'muse_synthesis_queued', { jobId: job.id, auditJobId: payload.auditJobId || null })
  return { lead: updated, job, alreadyQueued: false }
}

async function runAuditJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw new Error('Lead not found')
  const manualAction = job.payload.manualAction || null
  const workflowProgress = (progress) => manualAction === 'full' ? Math.round(20 + progress * 0.5) : progress
  const run = job.runId ? readRun(job.runId) : null
  const runLead = touchLeadRun(lead, { runId: job.runId, source: run?.source || 'Research run', relationship: 'audited' })
  saveLead({
    ...runLead,
    researchFailure: null,
    researchStatus: 'Analyzing',
    researchJob: { id: job.id, status: 'Running', progress: 15 },
    ...(manualAction ? { manualRun: manualRunState(lead, manualAction, { status: 'Running', progress: workflowProgress(15), phase: 'Auditing website', jobId: job.id }) } : {}),
    updated: 'Analyzing now',
  })
  updateJob(job.id, { progress: 15 })
  const settings = readSettings()
  const rawResult = await auditWebsite(lead.website, {
    respectRobots: job.payload.respectRobots !== false,
    maxPages: settings.maxPages || 10,
    requestDelay: settings.requestDelay ?? 500,
    maxLinks: 50,
    maxAttempts: settings.crawlMaxAttempts || 60,
    timeLimitMs: settings.crawlTimeLimitMs || 120000,
    signal: jobSignals.get(job.id)?.signal || null,
    onProgress: ({ progress, phase }) => {
      if (!claimJobCompletion(job.id)) return
      updateJob(job.id, { progress })
      const activeLead = readLead(job.leadId)
      if (activeLead) saveLead({
        ...activeLead,
        researchJob: { id: job.id, status: 'Running', progress, phase },
        ...(manualAction ? { manualRun: manualRunState(activeLead, manualAction, { status: 'Running', progress: workflowProgress(progress), phase, jobId: job.id }) } : {}),
        updated: phase,
      })
    },
  })
  const { _lighthouseReport, ...result } = rawResult
  // A cancel or watchdog timeout that landed mid-audit wins: the stale
  // completion is dropped instead of overwriting it.
  if (!claimJobCompletion(job.id)) return readLead(job.leadId) || lead
  const current = readLead(job.leadId)
  const auditId = auditIdForJob(job.id)
  const auditVersion = (current.auditHistory || []).length + 1
  const history = [...(current.auditHistory || []), {
    auditId, version: auditVersion, jobId: job.id, at: result.auditedAt, url: result.auditedUrl, score: result.opportunityScore,
    performance: result.performance, pages: result.pageCount, brokenLinks: result.brokenLinks,
  }].slice(-10)
  const inconclusive = result.researchStatus === 'Inconclusive'
  const attempt = {
    jobId: job.id, at: result.auditedAt, url: result.auditedUrl,
    status: inconclusive ? 'Inconclusive' : 'Completed',
    reason: result.captureQuality?.reason || null,
    captureQuality: result.captureQuality?.quality || null,
  }
  const lastSuccessfulAudit = result.opportunityScore != null
    ? { at: result.auditedAt, url: result.auditedUrl, score: result.opportunityScore, confidence: result.confidence }
    : current.lastSuccessfulAudit || null
  // A new attempt marks prior synthesis and drafts stale until regenerated or reviewed.
  const synthesisStale = current.museAnalysis?.status === 'Completed' && current.museAnalysis?.auditId && current.museAnalysis.auditId !== auditId
  const draftsStale = Boolean(current.outreachDraft || Object.keys(current.outreachDrafts || {}).length) && current.outreachGeneration?.auditId && current.outreachGeneration.auditId !== auditId
  const pendingBase = enrichLead({
    ...current,
    ...result,
    prelimScore: result.opportunityScore,
    researchFailure: null,
    lastAuditAttempt: attempt,
    lastSuccessfulAudit,
    researchJob: { id: job.id, status: 'Completed', progress: 100 },
    ...(manualAction ? { manualRun: manualRunState(current, manualAction, manualAction === 'full'
      ? { status: 'Running', progress: 70, phase: inconclusive ? 'Capture inconclusive — review needed' : 'Website audit complete', jobId: job.id }
      : { status: 'Completed', progress: 100, phase: inconclusive ? 'Capture inconclusive — review needed' : 'Website audit complete', jobId: job.id, completedAt: nowIso() }) } : {}),
    auditHistory: history,
    museAnalysis: synthesisStale ? { ...current.museAnalysis, stale: true, staleReason: `A newer audit (${auditId}) completed after this synthesis.` } : current.museAnalysis,
    outreachStale: draftsStale ? true : current.outreachStale || false,
    outreachStaleReason: draftsStale ? `A newer audit (${auditId}) completed after these drafts.` : current.outreachStaleReason || null,
    updated: 'Just now',
  })
  // Additive contact merge: re-audits never overwrite manual entries and
  // repeated extraction never multiplies candidates.
  pendingBase.contactCandidates = mergeContactCandidates(current.contactCandidates || [], result.contactCandidates || [])
  // Commercial value is rescored on every completed audit from saved evidence.
  pendingBase.leadValue = scoreLeadValue(pendingBase, { weights: readSettings().leadValueWeights })
  // Persist versioned artifacts BEFORE the DB pointer advertises them. A
  // persistence failure records an explicit attempt failure — a crash here
  // leaves versioned files without a manifest or pointer, which synthesis
  // refuses to trust, instead of a false completion.
  let manifest = null
  try {
    ;({ manifest } = saveAuditArtifacts({
      dataDir, leadId: job.leadId, auditId, auditVersion,
      auditData: { ...buildAuditData(pendingBase), currentAuditId: auditId, auditVersion },
      lighthouseReport: _lighthouseReport || null,
    }))
  } catch (error) {
    if (!claimJobCompletion(job.id)) throw new Error(`Audit artifacts could not be persisted: ${error.message}`)
    saveLead({ ...pendingBase, researchStatus: 'Failed', researchFailure: { stage: 1, reason: `Audit artifacts could not be persisted: ${error.message}`, code: 'ARTIFACT_WRITE_FAILED', retryable: true, at: nowIso(), jobId: job.id }, updated: 'Just now' })
    updateJob(job.id, { status: 'Error', progress: 100, error: `Audit artifacts could not be persisted: ${error.message}`, payload: { ...readJob(job.id)?.payload, jobOutcome: { code: 'ARTIFACT_WRITE_FAILED', retryable: true } } })
    recordEvent('lead', lead.id, 'audit_artifact_failed', { jobId: job.id, auditId, reason: error.message })
    throw new Error(`Audit artifacts could not be persisted: ${error.message}`)
  }
  const updated = saveLead({ ...pendingBase, currentAuditId: auditId, auditVersion })
  if (_lighthouseReport) {
    const folder = join(dataDir, 'leads', lead.id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'lighthouse.json'), JSON.stringify(_lighthouseReport, null, 2), 'utf8')
  }
  updateJob(job.id, { status: 'Completed', progress: 100, result: { opportunityScore: result.opportunityScore, confidence: result.confidence, auditedUrl: result.auditedUrl }, error: null })
  recordEvent('lead', lead.id, 'audit_completed', { jobId: job.id, score: result.opportunityScore, source: result.analysisSource })
  if (['analysis', 'full'].includes(job.payload.workflow) && result.opportunityScore != null && !isRunCancelled(job.runId)) {
    if (getOutreachConfig().configured) return queueMuseSynthesis(updated, { auditJobId: job.id, researchRunId: job.runId || null, workflow: job.payload.workflow, manualAction, continueRun: Boolean(manualAction) }).lead
    // No AI configured: the deterministic audit stands on its own. The full
    // workflow finishes honestly with supported fallback outreach drafts
    // instead of failing the run for a missing optional key.
    if (job.payload.workflow === 'full') {
      const finished = await generateAndSaveOutreach(updated, { manualAction: manualAction || 'full' })
      const current = readLead(job.leadId) || finished
      return saveLead({
        ...current,
        manualRun: manualRunState(current, manualAction || 'full', { status: 'Completed', progress: 100, phase: 'Audit complete with template drafts — AI is not configured', completedAt: nowIso() }),
        updated: 'Just now',
      })
    }
  }
  if (manualAction === 'full') return saveLead({ ...updated, manualRun: manualRunState(updated, 'full', { status: 'Completed', progress: 100, phase: 'Website audit complete — AI is not configured', completedAt: nowIso() }) })
  return updated
}

async function generateAndSaveOutreach(lead, { manualAction = null } = {}) {
  // Snapshot the revision before the provider await; completion merges into
  // the latest row so concurrent user edits are never overwritten.
  const started = readLead(lead.id) || lead
  const startedSnap = { rev: getRev(started), outreachDraft: started.outreachDraft, outreachVersion: started.outreachVersion }
  const generationStartedAt = nowIso()
  const offer = readSettings().offer || null
  const accepted = reviewStatus(started).accepted?.[0] || null
  const observation = accepted?.finding?.detail || started.mainIssue || (started.problems || [])[0] || null
  const primaryContact = (started.contactCandidates || []).find((c) => ['email', 'phone'].includes(c.kind)) || null
  const generated = await generateOutreach(started, { offer, observation })
  // A failed provider throws before any save: previous drafts survive and the caller surfaces retry/manual editing.
  generated.generation = { ...generated.generation, generatedAt: generationStartedAt, offerVersion: offer?.version ?? 1 }
  const provenance = {
    opportunityKey: accepted?.findingKey || null,
    opportunityAccepted: Boolean(accepted),
    auditId: started.currentAuditId || null,
    offerVersion: offer?.version ?? 1,
    contactId: primaryContact?.id || null,
    contactKind: primaryContact?.kind || null,
    generatedAt: generationStartedAt,
  }
  let completionType = 'apply'
  const updated = writeJobCompletion(lead.id, (current) => {
    const decision = resolveOutreachCompletion({ started: startedSnap, current, generated, selectedVersion: current.outreachVersion })
    completionType = decision.type
    const patch = { ...decision.patch, outreachStale: false, outreachStaleReason: null, outreachProvenance: provenance }
    if (decision.type === 'apply' && !generated.insufficientEvidence) {
      // Channel drafts (email/phone/form) sit alongside the versioned email
      // drafts; lengths are labelled from actual word counts.
      const channels = buildChannelDrafts(current, { observation: accepted?.finding?.detail || null, offer, contact: primaryContact })
      patch.outreachChannels = {
        email: generated.drafts?.Concise || channels.email,
        phone: `${channels.phone.opener}\n${channels.phone.question}\nNotes: ${channels.phone.notes}`,
        form: `${channels.form.message}\nPage to open manually: ${channels.form.pageToOpen || 'see contact candidates'}\n${channels.form.note}`,
      }
      patch.outreachChannels._words = {
        ...Object.fromEntries(Object.entries(generated.drafts || {}).map(([k, v]) => [k, String(v || '').trim().split(/\s+/).filter(Boolean).length])),
        ...channels.words,
      }
    }
    if (manualAction) {
      patch.manualRun = manualRunState(current, manualAction, {
        status: 'Completed', progress: 100,
        phase: decision.type === 'apply' ? 'Outreach drafts ready' : decision.type === 'insufficient' ? 'Insufficient evidence for outreach' : 'New outreach kept as a candidate — review required',
        completedAt: nowIso(),
      })
    }
    patch.updated = decision.type === 'apply' ? 'Just now' : current.updated
    return patch
  })
  recordEvent('lead', lead.id, 'outreach_generated', { source: generated.generation.source, model: generated.generation.model, manualAction, completion: completionType, insufficientEvidence: Boolean(generated.insufficientEvidence) })
  return updated
}

async function runSynthesisJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw new Error('Lead not found')
  if (lead.opportunityScore == null) throw new Error('A completed website audit is required before AI synthesis')
  const manualAction = job.payload.manualAction || null
  if (!getOutreachConfig().configured) {
    // Synthesis is optional: without AI the deterministic review stands on
    // its own. The job completes as Skipped — never Failed — so the audit is
    // preserved and a later retry (or a newly added key) needs no re-audit.
    // A full workflow still finishes with supported fallback outreach.
    const skipped = saveLead({
      ...lead,
      museAnalysis: { ...(lead.museAnalysis || {}), status: 'Skipped', skipped: true, skipReason: 'AI is not configured; deterministic audit stands', error: null },
      museJob: { id: job.id, status: 'Completed', progress: 100, phase: 'Skipped — AI is not configured' },
      ...(manualAction && job.payload.workflow !== 'full' ? { manualRun: manualRunState(lead, manualAction, { status: 'Completed', progress: 100, phase: 'AI is not configured — audit stands', completedAt: nowIso() }) } : {}),
      updated: 'Just now',
    })
    updateJob(job.id, { status: 'Completed', progress: 100, result: { skipped: true, reason: 'AI is not configured' }, error: null })
    recordEvent('lead', lead.id, 'muse_synthesis_skipped', { jobId: job.id, reason: 'AI is not configured' })
    if (job.payload.workflow === 'full' && !isRunCancelled(job.runId)) {
      const finished = await generateAndSaveOutreach(skipped, { manualAction: manualAction || 'full' })
      const current = readLead(job.leadId) || finished
      return saveLead({
        ...current,
        manualRun: manualRunState(current, manualAction || 'full', { status: 'Completed', progress: 100, phase: 'Audit complete with template drafts — AI is not configured', completedAt: nowIso() }),
        updated: 'Just now',
      })
    }
    return skipped
  }
  saveLead({
    ...lead,
    museAnalysis: { ...(lead.museAnalysis || {}), status: 'Running', error: null },
    museJob: { id: job.id, status: 'Running', progress: 20, phase: 'Reading saved evidence' },
    ...(manualAction ? { manualRun: manualRunState(lead, manualAction, { status: 'Running', progress: manualAction === 'full' ? 76 : 20, phase: 'Reading saved evidence', jobId: job.id }) } : {}),
    updated: 'AI is analyzing evidence',
  })
  updateJob(job.id, { progress: 20 })
  // Synthesis reads the explicit audit version the pointer names. A previous
  // attempt's report is never substituted without a historical label.
  let scopedAudit
  try {
    scopedAudit = loadAuditForSynthesis({ dataDir, lead: readLead(job.leadId) || lead })
  } catch (error) {
    throw new Error(`Cannot synthesize: ${error.message}`)
  }
  const lighthouseReport = scopedAudit.lighthouseReport
  const synthesisAuditId = scopedAudit.manifest?.auditId || null
  const synthesisProvenance = scopedAudit.provenance
  updateJob(job.id, { progress: 45 })
  const activeLead = readLead(job.leadId)
  if (activeLead) saveLead({
    ...activeLead,
    museJob: { id: job.id, status: 'Running', progress: 45, phase: 'Synthesizing with AI' },
    ...(manualAction ? { manualRun: manualRunState(activeLead, manualAction, { status: 'Running', progress: manualAction === 'full' ? 84 : 45, phase: 'Synthesizing with AI', jobId: job.id }) } : {}),
    updated: 'AI is synthesizing findings',
  })
  const synthesisStartedAt = nowIso()
  throwIfJobCancelled(job.id)
  const result = await generateMuseAnalysis(readLead(job.leadId), { lighthouseReport })
  result.generatedAt = synthesisStartedAt
  if (!claimJobCompletion(job.id)) return readLead(job.leadId) || lead
  const synthesisDecision = resolveSynthesisCompletion({ current: readLead(job.leadId) || {}, result })
  const updated = synthesisDecision.type === 'stale'
    ? readLead(job.leadId)
    : writeJobCompletion(job.leadId, (current) => {
      const rerun = resolveSynthesisCompletion({ current, result })
      if (rerun.type === 'stale') return {}
      return {
        ...rerun.patch,
        museAnalysis: { ...rerun.patch.museAnalysis, auditId: synthesisAuditId, auditProvenance: synthesisProvenance, stale: false, staleReason: null },
        museJob: { id: job.id, status: 'Completed', progress: 100, phase: 'Synthesis complete' },
        ...(manualAction ? { manualRun: manualRunState(current, manualAction, manualAction === 'full'
          ? { status: 'Running', progress: 92, phase: 'Generating outreach drafts', jobId: job.id }
          : { status: 'Completed', progress: 100, phase: 'AI analysis complete', jobId: job.id, completedAt: nowIso() }) } : {}),
        updated: 'Just now',
      }
    })
  updateJob(job.id, {
    status: 'Completed', progress: 100, error: null,
    result: { recommendation: result.qualificationRecommendation, opportunities: result.topOpportunities.length, model: result.generation.model, stale: synthesisDecision.type === 'stale' },
  })
  recordEvent('lead', lead.id, synthesisDecision.type === 'stale' ? 'muse_synthesis_stale' : 'muse_synthesis_completed', { jobId: job.id, recommendation: result.qualificationRecommendation, model: result.generation.model })
  if (job.payload.workflow === 'full' && !isRunCancelled(job.runId)) return generateAndSaveOutreach(updated, { manualAction: 'full' })
  return updated
}

async function runRefreshJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw new Error('Lead not found')
  const manualAction = job.payload.manualAction || 'refresh'
  const settings = readSettings()
  if (!job.payload.snapshotId) {
    const started = await triggerRecordRefresh({ url: lead.sourceUrl, settings })
    updateJob(job.id, { status: 'Waiting', progress: 8, payload: { ...job.payload, ...started, pollStartedAt: nowIso() }, nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    const waiting = readLead(job.leadId) || lead
    saveLead({
      ...waiting,
      refreshJob: { id: job.id, status: 'Waiting', progress: 8, phase: 'Bright Data is refreshing the record' },
      manualRun: manualRunState(waiting, manualAction, { status: 'Waiting', progress: manualAction === 'full' ? 5 : 8, phase: 'Bright Data is refreshing the record', jobId: job.id }),
      updated: 'Refreshing business data',
    })
    return
  }
  throwIfJobCancelled(job.id)
  assertPollDeadline(job, settings)
  const progress = await pollDiscovery(job.payload.snapshotId, settings)
  if (progress.status === 'failed') throw codedProviderError('Bright Data business refresh failed', 'PROVIDER_FAILED')
  if (!['ready', 'completed'].includes(progress.status)) {
    updateJob(job.id, { status: 'Waiting', progress: Math.max(10, job.progress), nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    const current = readLead(job.leadId)
    if (current) saveLead({ ...current, refreshJob: { id: job.id, status: 'Waiting', progress: 10, phase: 'Waiting for Bright Data' }, manualRun: manualRunState(current, manualAction, { status: 'Waiting', progress: manualAction === 'full' ? 8 : 10, phase: 'Waiting for Bright Data', jobId: job.id }) })
    return
  }
  const records = await downloadDiscovery(job.payload.snapshotId, settings)
  throwIfJobCancelled(job.id)
  const fresh = records.map((record) => mapDiscoveryRecord(record, lead.category, lead.location)).find(Boolean)
  if (!fresh) throw new Error('Bright Data returned no usable business record for this client')
  if (!claimJobCompletion(job.id)) return readLead(job.leadId) || lead
  // Merge into the latest row: provider fills only empty contact slots, so
  // concurrent user edits (notes, chosen contacts, stage, contract, drafts)
  // survive the refresh.
  let updated = writeJobCompletion(job.leadId, (current) => enrichLead({
    ...current,
    ...buildRefreshPatch({ current, fresh }),
    refreshJob: { id: job.id, status: 'Completed', progress: 100, phase: 'Business data refreshed' },
    manualRun: manualRunState(current, manualAction, manualAction === 'full'
      ? { status: 'Running', progress: 18, phase: 'Business data refreshed', jobId: job.id }
      : { status: 'Completed', progress: 100, phase: 'Business data refreshed', jobId: job.id, completedAt: nowIso() }),
    updated: 'Just now',
  }, fresh.businessIntelligence))
  updateJob(job.id, { status: 'Completed', progress: 100, result: { snapshotId: job.payload.snapshotId, source: fresh.businessIntelligence?.source }, error: null })
  recordEvent('lead', lead.id, 'business_refresh_completed', { jobId: job.id, snapshotId: job.payload.snapshotId })
  if (manualAction === 'full' && !isRunCancelled(job.runId)) {
    const queued = queueAuditForLead(updated, { workflow: 'full', manualAction: 'full', continueRun: true })
    updated = queued.skipped
      ? saveLead({ ...queued.lead, manualRun: manualRunState(queued.lead, 'full', { status: 'Completed', progress: 100, phase: 'Business data refreshed — no website to audit yet', jobId: job.id, completedAt: nowIso() }), updated: 'Just now' })
      : queued.lead
  }
  return updated
}

async function runDiscoveryJob(job) {
  const run = readRun(job.runId)
  if (!run) throw new Error('Run not found')
  const settings = readSettings()
  // The job always uses the run's immutable search snapshot — never live settings.
  const search = run.searchDefinition || legacySearchFromSettings(run, settings)
  if (!job.payload.snapshotId) {
    const started = await triggerDiscovery({ search, limit: run.limit, settings })
    updateJob(job.id, { status: 'Waiting', progress: 10, payload: { ...job.payload, ...started, pollStartedAt: nowIso() }, nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    saveRun({ ...run, searchDefinition: search, providerSnapshotId: started.snapshotId, submittedGeography: started.submittedGeography, progress: 10, duration: 'Waiting for discovery' })
    recordEvent('run', run.id, 'discovery_started', { snapshotId: started.snapshotId, submittedGeography: started.submittedGeography })
    return
  }
  throwIfJobCancelled(job.id)
  assertPollDeadline(job, settings)
  const progress = await pollDiscovery(job.payload.snapshotId, settings)
  if (progress.status === 'failed') throw codedProviderError('Bright Data discovery failed', 'PROVIDER_FAILED')
  if (!['ready', 'completed'].includes(progress.status)) {
    updateJob(job.id, { status: 'Waiting', progress: Math.max(12, job.progress), nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    return
  }
  const records = await downloadDiscovery(job.payload.snapshotId, settings)
  throwIfJobCancelled(job.id)
  if (!claimJobCompletion(job.id)) return run
  // A run cancelled while the provider answered enqueues nothing further.
  if (isRunCancelled(job.runId)) return readRun(job.runId) || run
  const limit = Math.max(1, Number(run.limit || 25))
  const reconciled = reconcileRecords(records, { fallbackCategory: 'Unknown', fallbackLocation: search.displayLocation, limit })
  const leads = reconciled.retained.map((record, index) => insertUniqueLead(record, index, 'Bright Data Google Maps', { runId: run.id })).filter(Boolean)
  const uniqueLeads = [...new Map(leads.map((lead) => [lead.id, lead])).values()]
  const newClientIds = [...new Set(uniqueLeads.filter((lead) => lead._runImport?.created).map((lead) => lead.id))]
  const matchedClientIds = [...new Set(uniqueLeads.filter((lead) => !lead._runImport?.created).map((lead) => lead.id))]
  if (run.market) uniqueLeads.forEach((lead) => { if (!lead.market) scopedLeadUpdate(lead.id, { market: run.market }) })
  // Every discovered business is qualified, including ones with no website:
  // those are the best free-redesign candidates. Deep Lighthouse audits run
  // on demand for shortlisted leads, or here when the run asks for them.
  uniqueLeads.forEach((lead) => queueJob({ type: 'qualify', runId: run.id, leadId: lead.id, payload: {}, maxAttempts: 2 }))
  if (run.options?.deepAudit) {
    uniqueLeads.filter((lead) => lead.website).slice(0, Math.max(1, Number(run.deepAuditLimit || 10))).forEach((lead) => queueJob({ type: 'audit', runId: run.id, leadId: lead.id, payload: { respectRobots: settings.respectRobots, workflow: 'analysis' }, maxAttempts: 2 }))
  }
  const geography = describeGeographyCoverage(search, reconciled.retained)
  saveRun({ ...readRun(run.id), searchDefinition: search, discovered: uniqueLeads.length, newClients: newClientIds.length, matchedClients: matchedClientIds.length, clientIds: uniqueLeads.map((lead) => lead.id), newClientIds, matchedClientIds, providerSnapshotId: job.payload.snapshotId, duration: 'Qualifying discovered businesses',
    reconciliation: {
      returned: reconciled.returned, mapped: reconciled.mapped, retained: reconciled.retained.length,
      rejected: reconciled.rejectedCount, duplicates: reconciled.duplicates, unusable: reconciled.unusable,
      rejectedRows: reconciled.rejected.slice(0, 20),
    },
    requestedGeography: geography.requested,
    actualGeography: { recordsTotal: geography.recordsTotal, recordsWithCoordinates: geography.recordsWithCoordinates, outOfArea: geography.outOfArea },
    coverageNote: geography.coverageNote,
  })
  updateJob(job.id, { status: 'Completed', progress: 100, result: { records: reconciled.returned, retained: reconciled.retained.length, rejected: reconciled.rejectedCount, imported: uniqueLeads.length }, error: null })
  recordEvent('run', run.id, 'discovery_completed', { records: reconciled.returned, retained: reconciled.retained.length, rejected: reconciled.rejectedCount, imported: uniqueLeads.length, newClients: newClientIds.length, matchedClients: matchedClientIds.length, clientIds: uniqueLeads.map((lead) => lead.id) })
}

// Qualification (lead-quality pipeline): scan the site with the crawler
// engine, find contacts, score business worth and site weakness, pick a
// play. Leads without a website qualify straight away.
async function runQualifyJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw Object.assign(new Error('Lead no longer exists'), { code: 'NOT_FOUND' })
  updateJob(job.id, { progress: 20 })
  const leadDir = join(dataDir, 'leads', lead.id)
  const { siteScan, qualification, patch } = await scanAndQualify(lead, { allLeads: readRows('leads'), leadDir })
  throwIfJobCancelled(job.id)
  if (!claimJobCompletion(job.id)) return
  scopedLeadUpdate(lead.id, { ...patch, siteScan, qualification, updated: 'Just now' })
  updateJob(job.id, { status: 'Completed', progress: 100, result: { play: qualification.play, priority: qualification.priority, email: qualification.contact.email }, error: null })
  recordEvent('lead', lead.id, 'qualified', { jobId: job.id, play: qualification.play, priority: qualification.priority, presence: qualification.presence, emailFound: Boolean(patch.email) })
  const settings = readSettings()
  if (job.payload?.autoVisual !== false && settings.autoVisualReview !== false && qualification.needsVisualReview && getVisionConfig().configured) {
    queueJob({ type: 'visual', runId: job.runId, leadId: lead.id, payload: {}, maxAttempts: 2 })
  }
}

async function runVisualJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw Object.assign(new Error('Lead no longer exists'), { code: 'NOT_FOUND' })
  updateJob(job.id, { progress: 15 })
  const visualReview = await visualReviewLead(lead, { leadDir: join(dataDir, 'leads', lead.id) })
  throwIfJobCancelled(job.id)
  if (!claimJobCompletion(job.id)) return
  const current = readLead(lead.id)
  const qualification = requalify({ ...current, visualReview }, readRows('leads'))
  scopedLeadUpdate(lead.id, { visualReview, qualification, updated: 'Just now' })
  updateJob(job.id, { status: 'Completed', progress: 100, result: { status: visualReview.status, verdict: visualReview.verdict || null, play: qualification.play }, error: null })
  recordEvent('lead', lead.id, 'visual_reviewed', { jobId: job.id, status: visualReview.status, verdict: visualReview.verdict || null, score: visualReview.score })
}

let workerBusy = false
// Maps a terminal job outcome onto the lead so every interruption shows an
// honest state with a clear next action, and the pipeline never advances on
// one: interrupted audits leave opportunityScore untouched, so done[1] stays
// false and qualification stays gated. Shared by the failure path, the cancel
// endpoint and the watchdog so all three stay consistent.
function applyJobOutcomeToLead(job, outcome, cause = null) {
  const lead = job.leadId ? readLead(job.leadId) : null
  if (!lead) return null
  const failure = { stage: 1, reason: outcome.detail, code: outcome.code, retryable: outcome.retryable, ...(cause ? { cause } : {}) }
  if (job.type === 'audit') {
    return saveLead({
      ...lead,
      researchStatus: outcome.status === 'Cancelled' ? 'Cancelled' : 'Failed',
      researchFailure: failure,
      lastAuditAttempt: { jobId: job.id, at: nowIso(), url: lead.website || null, status: outcome.status, reason: outcome.label, captureQuality: null },
      researchJob: { id: job.id, status: outcome.status, progress: 100, phase: outcome.label },
      ...(job.payload.manualAction ? { manualRun: manualRunState(lead, job.payload.manualAction, { status: outcome.status, progress: 100, phase: outcome.label, jobId: job.id, error: outcome.detail, completedAt: nowIso() }) } : {}),
      updated: outcome.status === 'Cancelled' ? 'Audit cancelled' : 'Just now',
    })
  }
  if (job.type === 'synthesize') {
    return saveLead({
      ...lead,
      museAnalysis: { ...(lead.museAnalysis || {}), status: 'Failed', error: outcome.detail },
      museJob: { id: job.id, status: outcome.status, progress: 100, phase: outcome.label, error: outcome.detail, retryable: outcome.retryable },
      ...(job.payload.manualAction ? { manualRun: manualRunState(lead, job.payload.manualAction, { status: outcome.status, progress: 100, phase: outcome.label, jobId: job.id, error: outcome.detail, completedAt: nowIso() }) } : {}),
      updated: 'Just now',
    })
  }
  if (job.type === 'refresh') {
    return saveLead({
      ...lead,
      refreshJob: { id: job.id, status: outcome.status, progress: 100, phase: outcome.label, error: outcome.detail, retryable: outcome.retryable },
      ...(job.payload.manualAction ? { manualRun: manualRunState(lead, job.payload.manualAction, { status: outcome.status, progress: 100, phase: outcome.label, jobId: job.id, error: outcome.detail, completedAt: nowIso() }) } : {}),
      updated: 'Just now',
    })
  }
  return lead
}

// Watchdog: Running jobs past their deadline become Timed out with honest
// lead state and a single terminal event. In-flight work that finishes late
// is ignored by the completion claim, so it cannot resurrect the job.
function runJobWatchdog() {
  const settings = readSettings()
  const timeoutMs = Number(settings.jobTimeoutMs) || 600000
  const running = db.prepare("SELECT * FROM jobs WHERE status = 'Running'").all().map(parseJob)
  for (const job of findTimedOutJobs(running, Date.now(), timeoutMs)) {
    const outcome = classifyJobError({ code: 'TIMEOUT', message: 'Job exceeded its time budget' })
    updateJob(job.id, {
      status: outcome.status, progress: 100, error: outcome.detail, nextAttemptAt: null,
      payload: { ...job.payload, jobOutcome: { code: outcome.code, retryable: outcome.retryable } },
    })
    applyJobOutcomeToLead(job, outcome)
    recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_timed_out`, { jobId: job.id, timeoutMs })
    if (job.runId) syncRun(job.runId)
  }
}

async function processNextJob() {
  if (workerBusy) return
  runJobWatchdog()
  runRunWatchdog()
  // Run eligibility is enforced inside the query (before LIMIT), so jobs
  // parked behind paused or cancelled runs can never hide runnable work.
  const row = db.prepare(`SELECT * FROM jobs
    WHERE (status = 'Queued' OR status = 'Waiting')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE json_extract(payload, '$.status') IN ('Paused', 'Cancelled')))
    ORDER BY created_at ASC LIMIT 1`).get(nowIso())
  if (!row) return
  workerBusy = true
  const job = parseJob(row)
  const attempt = job.attempts + (job.status === 'Queued' ? 1 : 0)
  const { cancelRequested: _staleCancel, startedAt: _staleStart, jobOutcome: _staleOutcome, ...payload } = job.payload || {}
  updateJob(job.id, { status: 'Running', attempts: attempt, error: null, nextAttemptAt: null, payload: { ...payload, startedAt: nowIso() } })
  jobSignals.set(job.id, new AbortController())
  try {
    if (job.type === 'audit') await runAuditJob({ ...job, attempts: attempt })
    else if (job.type === 'synthesize') await runSynthesisJob({ ...job, attempts: attempt })
    else if (job.type === 'discover') await runDiscoveryJob({ ...job, attempts: attempt })
    else if (job.type === 'refresh') await runRefreshJob({ ...job, attempts: attempt })
    else if (job.type === 'qualify') await runQualifyJob({ ...job, attempts: attempt })
    else if (job.type === 'visual') await runVisualJob({ ...job, attempts: attempt })
    else throw new Error(`Unsupported job type: ${job.type}`)
  } catch (error) {
    const current = readJob(job.id)
    // A job that already reached a terminal state (cancelled by the user or
    // timed out by the watchdog while this attempt was in flight) keeps it:
    // the late failure records nothing new.
    if (!current || isTerminalJobStatus(current.status)) {
      // fall through to release
    } else {
      const outcome = classifyJobError(error)
      // A provider trigger that never produced a snapshot id is never
      // auto-retried: replaying the trigger could place (and bill) a second
      // paid request. The failure stays visible; a manual retry is explicit.
      const triggerPhase = ['discover', 'refresh'].includes(job.type) && !current.payload?.snapshotId
      const retry = outcome.autoRetry && !triggerPhase && current.attempts < current.maxAttempts
      // The raw cause is kept next to the plain-language outcome so a failure
      // stays actionable for the user and debuggable for support.
      const cause = String(error?.message || '').trim() || null
      updateJob(job.id, {
        status: retry ? 'Queued' : outcome.status,
        progress: retry ? Math.max(5, current.progress) : 100,
        error: retry ? error.message : outcome.detail,
        nextAttemptAt: retry ? new Date(Date.now() + 2_000).toISOString() : null,
        payload: retry ? current.payload : { ...current.payload, jobOutcome: { code: outcome.code, retryable: outcome.retryable, cause } },
      })
      if (retry) {
        const lead = readLead(job.leadId)
        if (job.type === 'audit' && lead) saveLead({
          ...lead,
          researchStatus: 'Queued',
          researchJob: { id: job.id, status: 'Queued', progress: 5 },
          updated: 'Retrying soon',
        })
        if (job.payload.manualAction && lead) saveLead({
          ...readLead(job.leadId),
          manualRun: manualRunState(lead, job.payload.manualAction, {
            status: 'Queued', progress: Math.max(5, current.progress), phase: 'Retrying soon', jobId: job.id, error: null, completedAt: null,
          }),
        })
      } else {
        applyJobOutcomeToLead({ ...job, payload: current.payload }, outcome, cause)
        recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_${outcome.status === 'Cancelled' ? 'cancelled' : outcome.status === 'Timed out' ? 'timed_out' : outcome.status === 'Error' ? 'errored' : 'failed'}`, { jobId: job.id, code: outcome.code, error: error.message })
      }
    }
  } finally {
    if (job.runId) syncRun(job.runId)
    releaseJobCancel(job.id)
    workerBusy = false
  }
}
setInterval(processNextJob, 500).unref()

app.get('/api/status', (_req, res) => {
  const settings = readSettings()
  const brightData = getBrightDataConfig(settings)
  const outreach = getOutreachConfig()
  const activeJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('Queued', 'Running', 'Waiting')").get().count
  res.json({
    ok: true,
    storage: 'SQLite',
    databasePath: join(dataDir, 'scoutline.db'),
    worker: { activeJobs, busy: workerBusy },
    outreachConfigured: outreach.configured,
    outreachProvider: outreach.provider,
    outreachProviderLabel: outreach.providerLabel,
    outreachModel: outreach.model,
    openAIConfigured: outreach.provider === 'openai',
    openAIModel: outreach.provider === 'openai' ? outreach.model : null,
    brightDataCredentialConfigured: Boolean(brightData.apiKey),
    brightDataAdapterReady: brightData.ready,
    brightDataConnected: brightData.ready,
    brightDataDatasetId: brightData.datasetId,
    brightDataMaxRecords: brightData.maxRecords,
  })
})

// ── Local backup / restore (ROH-29): everything stays on this machine ────────
app.get('/api/storage/health', (_req, res) => {
  const names = listBackups(backupsDir)
  res.json({
    ok: true,
    writable: storageWritable(dataDir),
    databasePath: join(dataDir, 'scoutline.db'),
    artifactFailures: readArtifactFailures(),
    activeJobs: activeJobCount(),
    backups: { count: names.length, latest: names.length ? names[names.length - 1] : null },
  })
})

app.get('/api/backups', (_req, res) => {
  const backups = listBackups(backupsDir).map((name) => {
    try {
      const manifest = JSON.parse(readFileSync(join(backupsDir, name, 'manifest.json'), 'utf8'))
      return { name, createdAt: manifest.createdAt || null, counts: manifest.counts || null, files: Array.isArray(manifest.files) ? manifest.files.length : 0 }
    } catch {
      return { name, createdAt: null, counts: null, files: 0 }
    }
  })
  res.json({ ok: true, backups })
})

app.post('/api/backups', async (_req, res) => {
  try {
    const created = await createBackup({ db, dataDir, backupsDir })
    const pruned = pruneBackups(backupsDir, 5)
    recordEvent('system', 'backup', 'created', { name: created.name, counts: created.manifest.counts })
    res.status(201).json({ ok: true, name: created.name, createdAt: created.manifest.createdAt, counts: created.manifest.counts, files: created.manifest.files.length, pruned })
  } catch (error) {
    res.status(500).json({ error: `Backup failed — ${error.message}`, code: 'BACKUP_FAILED' })
  }
})

app.delete('/api/backups/:name', (req, res) => {
  const name = String(req.params.name || '')
  if (!listBackups(backupsDir).includes(name)) return notFound(res, 'Backup not found', 'name')
  try {
    rmSync(join(backupsDir, name), { recursive: true, force: true })
    recordEvent('system', 'backup', 'deleted', { name })
    res.json({ ok: true, name })
  } catch (error) {
    res.status(500).json({ error: `Could not delete backup — ${error.message}`, code: 'BACKUP_DELETE_FAILED' })
  }
})

// Live restore from an on-disk snapshot: the snapshot is verified, converted
// to the portable format, and applied to the running database.
app.post('/api/backups/:name/restore', async (req, res) => {
  const name = String(req.params.name || '')
  if (!listBackups(backupsDir).includes(name)) return notFound(res, 'Backup not found', 'name')
  if (!req.body || req.body.confirm !== true) return badRequest(res, 'confirm', 'Restoring overwrites current data — send { "confirm": true } to proceed')
  if (activeJobCount() > 0) return conflict(res, 'Restore blocked — background jobs still active. Cancel or wait for them first.', null, 'RESTORE_BLOCKED_ACTIVE_JOBS')
  const backupPath = join(backupsDir, name)
  const verification = await verifyBackup(backupPath, { openDatabase: (path) => new Database(path, { readonly: true }) })
  if (!verification.ok) return res.status(422).json({ error: `Restore refused — backup failed verification: ${verification.errors.join('; ')}`, code: 'INVALID_BACKUP', details: verification.errors.map((message) => ({ message })) })
  let snapshotDb = null
  try {
    snapshotDb = new Database(join(backupPath, 'scoutline.db'), { readonly: true })
    const collected = collectJsonBackupFiles(backupPath)
    if (!collected.ok) return payloadTooLarge(res, collected.error)
    const portable = buildJsonBackup({ tables: readBackupTables(snapshotDb), files: collected.files, createdAt: verification.manifest.createdAt })
    const result = applyJsonRestore(db, dataDir, portable, { regenerateLead: (lead) => writeLeadArtifacts(lead) })
    if (!result.ok) return res.status(500).json({ error: `Restore incomplete — ${result.failed.length} file(s) could not be written`, code: 'BACKUP_RESTORE_PARTIAL', restored: result.restored, failed: result.failed })
    recordEvent('system', 'backup', 'restored', { name, tables: result.restored.tables, files: result.restored.files })
    res.json({ ok: true, name, restored: result.restored, failed: [] })
  } catch (error) {
    res.status(500).json({ error: `Restore failed — ${error.message}`, code: 'BACKUP_RESTORE_FAILED' })
  } finally {
    try { snapshotDb?.close() } catch { /* already closed */ }
  }
})

app.get('/api/backup/export', (_req, res) => {
  const collected = collectJsonBackupFiles(dataDir)
  if (!collected.ok) return payloadTooLarge(res, collected.error)
  const backup = buildJsonBackup({ tables: readBackupTables(db), files: collected.files })
  res.setHeader('Content-Disposition', `attachment; filename="scoutline-backup-${backup.createdAt.replace(/[:.]/g, '-')}.json"`)
  res.json(backup)
})

app.get('/api/leads', (_req, res) => res.json(readRows('leads')))
app.get('/api/leads/:id/events', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const events = db.prepare("SELECT * FROM events WHERE entity_type = 'lead' AND entity_id = ? ORDER BY created_at DESC LIMIT 100").all(req.params.id)
  res.json(events.map((event) => ({ ...event, payload: JSON.parse(event.payload) })))
})
app.get('/api/runs', (_req, res) => res.json(decorateRuns()))
app.get('/api/runs/:id', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid run id format')
  const run = syncRun(req.params.id) || readRun(req.params.id)
  if (!run) return notFound(res, 'Run not found', 'id')
  res.json(decorateRun(run))
})
app.get('/api/jobs/:id', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid job id format')
  const job = readJob(req.params.id)
  if (!job) return notFound(res, 'Job not found', 'id')
  res.json(job)
})

app.post('/api/jobs/:id/cancel', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid job id format')
  const job = readJob(req.params.id)
  if (!job) return notFound(res, 'Job not found', 'id')
  if (!isActiveJobStatus(job.status)) return res.status(409).json({ error: 'This job already finished and cannot be cancelled.', code: 'JOB_TERMINAL' })
  const outcome = classifyJobError({ code: 'CANCELLED', message: 'Cancelled by user' })
  if (job.status === 'Running') {
    // In-flight work stops at the next cancellation point; the completion
    // claim drops anything that finishes afterwards.
    requestJobCancel(job.id)
    const mirror = job.leadId ? readLead(job.leadId) : null
    if (mirror) {
      const patch = {}
      if (job.type === 'audit' && mirror.researchJob?.id === job.id) patch.researchJob = { ...mirror.researchJob, phase: 'Cancelling…' }
      if (job.type === 'synthesize' && mirror.museJob?.id === job.id) patch.museJob = { ...mirror.museJob, phase: 'Cancelling…' }
      if (job.type === 'refresh' && mirror.refreshJob?.id === job.id) patch.refreshJob = { ...mirror.refreshJob, phase: 'Cancelling…' }
      if (Object.keys(patch).length) saveLead({ ...mirror, ...patch, updated: 'Cancelling job' })
    }
    recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_cancel_requested`, { jobId: job.id })
    return res.json({ job: readJob(job.id), cancelling: true, lead: job.leadId ? readLead(job.leadId) : null })
  }
  updateJob(job.id, {
    status: outcome.status, progress: 100, error: outcome.detail, nextAttemptAt: null,
    payload: { ...job.payload, jobOutcome: { code: outcome.code, retryable: outcome.retryable } },
  })
  applyJobOutcomeToLead(job, outcome)
  recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_cancelled`, { jobId: job.id })
  if (job.runId) syncRun(job.runId)
  res.json({ job: readJob(job.id), cancelling: false, lead: job.leadId ? readLead(job.leadId) : null })
})

app.post('/api/jobs/:id/retry', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid job id format')
  const job = readJob(req.params.id)
  if (!job) return notFound(res, 'Job not found', 'id')
  if (!canRetryJob(job)) {
    const reason = !isTerminalJobStatus(job.status)
      ? 'This job is still active; cancel it before starting a replacement.'
      : 'This job cannot be retried; start a fresh run instead.'
    return res.status(409).json({ error: reason, code: 'JOB_NOT_RETRYABLE' })
  }
  if (job.leadId) {
    const active = db.prepare("SELECT id FROM jobs WHERE lead_id = ? AND type = ? AND status IN ('Queued', 'Running', 'Waiting') AND id != ?").get(job.leadId, job.type, job.id)
    if (active) return res.status(409).json({ error: 'A replacement job is already queued for this work.', code: 'JOB_NOT_RETRYABLE' })
  }
  // A retry is a brand-new job: new id, reset attempts, same parameters. The
  // original row and all collected evidence stay untouched, and resume keeps
  // whatever progress the lead already holds.
  const { cancelRequested: _cancel, startedAt: _start, jobOutcome: _outcome, ...payload } = job.payload || {}
  const retry = queueJob({
    type: job.type, runId: job.runId, leadId: job.leadId,
    payload: { ...payload, retriedFrom: job.id },
    maxAttempts: job.maxAttempts, triggeredBy: 'retry',
  })
  recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_retried`, { jobId: retry.id, retriedFrom: job.id })
  res.status(201).json({ job: retry })
})
app.get('/api/settings', (_req, res) => res.json(readSettings()))

app.patch('/api/settings', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Settings body must be a JSON object')
  const keys = Object.keys(body)
  if (keys.length === 0) return badRequest(res, null, 'No settings provided', [{ field: 'body', message: 'At least one setting key is required' }])
  if (keys.length > 20) return payloadTooLarge(res, 'Too many settings keys (max 20)')
  const details = []
  for (const key of keys) {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) details.push({ field: key, message: 'Unknown setting key' })
  }
  if (details.length) return badRequest(res, null, 'Unknown setting keys', details)

  // per-key type validation
  const vdetails = []
  const push = (field, msg) => vdetails.push({ field, message: msg })
  if ('defaultLocation' in body && !isStringWithLength(body.defaultLocation, 1, 120)) push('defaultLocation', 'Must be a non-empty string 1-120 chars')
  if ('resultLimit' in body) { const n = clampInt(body.resultLimit, 1, 50); if (n == null) push('resultLimit', 'Must be an integer 1-50') }
  if ('deepAuditLimit' in body) { const n = clampInt(body.deepAuditLimit, 1, 50); if (n == null) push('deepAuditLimit', 'Must be an integer 1-50') }
  if ('categories' in body) {
    if (!Array.isArray(body.categories)) push('categories', 'Must be an array')
    else if (body.categories.length === 0) push('categories', 'Must be a non-empty array')
    else if (body.categories.length > 20) push('categories', 'Max 20 categories')
    else body.categories.forEach((c, i) => { if (!isStringWithLength(c, 1, 40)) push(`categories[${i}]`, 'Each category must be 1-40 chars'); else if (!/^[A-Za-z0-9 &\-/]+$/.test(String(c).trim())) push(`categories[${i}]`, 'Category contains invalid characters') })
  }
  if ('maxPages' in body) { const n = clampInt(body.maxPages, 1, 50); if (n == null) push('maxPages', 'Must be an integer 1-50') }
  if ('requestDelay' in body) { const n = clampInt(body.requestDelay, 0, 10000); if (n == null) push('requestDelay', 'Must be an integer 0-10000') }
  if ('respectRobots' in body && typeof body.respectRobots !== 'boolean') push('respectRobots', 'Must be a boolean')
  if ('crawlMaxAttempts' in body) { const n = clampInt(body.crawlMaxAttempts, 10, 500); if (n == null) push('crawlMaxAttempts', 'Must be an integer 10-500') }
  if ('crawlTimeLimitMs' in body) { const n = clampInt(body.crawlTimeLimitMs, 15000, 600000); if (n == null) push('crawlTimeLimitMs', 'Must be an integer 15000-600000') }
  if ('leadValueWeights' in body) {
    const w = body.leadValueWeights
    if (!w || typeof w !== 'object' || Array.isArray(w)) push('leadValueWeights', 'Must be an object with need/businessFit/reachability/timing weights')
    else for (const key of ['need', 'businessFit', 'reachability', 'timing']) {
      const n = Number(w[key])
      if (!Number.isFinite(n) || n < 0 || n > 1) push(`leadValueWeights.${key}`, 'Each weight must be a number 0-1')
    }
  }
  if ('jobTimeoutMs' in body) { const n = clampInt(body.jobTimeoutMs, 60000, 3600000); if (n == null) push('jobTimeoutMs', 'Must be an integer 60000-3600000') }
  if ('discoveryPollTimeoutMs' in body) { const n = clampInt(body.discoveryPollTimeoutMs, 300000, 7200000); if (n == null) push('discoveryPollTimeoutMs', 'Must be an integer 300000-7200000') }
  if ('runTimeoutMs' in body) { const n = clampInt(body.runTimeoutMs, 900000, 43200000); if (n == null) push('runTimeoutMs', 'Must be an integer 900000-43200000') }
  if ('blockPrivateNetworks' in body && typeof body.blockPrivateNetworks !== 'boolean') push('blockPrivateNetworks', 'Must be a boolean')
  if ('discoveryCountry' in body && !isStringWithLength(body.discoveryCountry, 2, 3)) push('discoveryCountry', 'Must be 2-3 character country code')
  if ('discoveryLatitude' in body) { const n = Number(body.discoveryLatitude); if (!Number.isFinite(n) || n < -90 || n > 90) push('discoveryLatitude', 'Must be a number -90 to 90') }
  if ('discoveryLongitude' in body) { const n = Number(body.discoveryLongitude); if (!Number.isFinite(n) || n < -180 || n > 180) push('discoveryLongitude', 'Must be a number -180 to 180') }
  if ('discoveryZoom' in body) { const n = clampInt(body.discoveryZoom, 12, 16); if (n == null) push('discoveryZoom', 'Must be an integer 12-16') }
  if ('offer' in body) {
    const o = body.offer
    if (!o || typeof o !== 'object' || Array.isArray(o)) push('offer', 'Must be an object')
    else {
      if ('service' in o && typeof o.service !== 'string') push('offer.service', 'Must be a string')
      else if ('service' in o && o.service.length > 500) push('offer.service', 'Must be <=500 chars')
      if ('geography' in o && typeof o.geography !== 'string') push('offer.geography', 'Must be a string')
      if ('exclusions' in o && typeof o.exclusions !== 'string') push('offer.exclusions', 'Must be a string')
      if ('callToAction' in o && typeof o.callToAction !== 'string') push('offer.callToAction', 'Must be a string')
      else if ('callToAction' in o && o.callToAction.length > 300) push('offer.callToAction', 'Must be <=300 chars')
      if ('tone' in o && typeof o.tone !== 'string') push('offer.tone', 'Must be a string')
      if ('proofPoints' in o && !Array.isArray(o.proofPoints)) push('offer.proofPoints', 'Must be an array')
      else if (Array.isArray(o.proofPoints)) o.proofPoints.forEach((p, i) => { if (typeof p !== 'string' || !p.trim() || p.length > 300) push(`offer.proofPoints[${i}]`, 'Each proof point must be 1-300 chars') })
      if ('channels' in o && (!Array.isArray(o.channels) || o.channels.some((c) => !['email', 'phone', 'form'].includes(c)))) push('offer.channels', 'Must be an array of email, phone, form')
      if ('targetCategories' in o && !Array.isArray(o.targetCategories)) push('offer.targetCategories', 'Must be an array')
      // Editing the offer bumps its version so draft provenance stays honest.
      o.version = Number.isInteger(o.version) && o.version > 0 ? o.version : Date.now()
    }
  }
  if (vdetails.length) return badRequest(res, null, 'Invalid settings values', vdetails)

  // cross-field: deepAuditLimit should not exceed resultLimit if both present
  if ('deepAuditLimit' in body && 'resultLimit' in body) {
    if (Number(body.deepAuditLimit) > Number(body.resultLimit)) return badRequest(res, 'deepAuditLimit', 'deepAuditLimit must be <= resultLimit', [{ field: 'deepAuditLimit', message: 'Must be <= resultLimit' }])
  }

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  db.transaction((entries) => entries.forEach(([key, value]) => { if (ALLOWED_SETTINGS_KEYS.has(key)) upsert.run(key, JSON.stringify(value)) }))(Object.entries(body))
  if ('offer' in body) {
    // A new offer version stales existing drafts without discarding them or
    // human edits: regeneration is offered, never forced.
    const version = body.offer?.version
    let staled = 0
    for (const lead of readRows('leads')) {
      if (!lead.outreachDraft && !Object.keys(lead.outreachDrafts || {}).length) continue
      if (lead.outreachProvenance?.offerVersion === version) continue
      saveLead({ ...lead, outreachStale: true, outreachStaleReason: `Offer settings changed (version ${version ?? 'unknown'}). Regenerate to use the new CTA, or keep the reviewed draft.` })
      recordEvent('lead', lead.id, 'outreach_staled', { reason: 'offer_changed', offerVersion: version ?? null })
      staled += 1
    }
    const settings = readSettings()
    return res.json({ ...settings, _offerStaleDrafts: staled })
  }
  res.json(readSettings())
})

app.post('/api/leads', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const company = String(body.company || '').trim()
  if (!isStringWithLength(company, 2, 120)) return badRequest(res, 'company', 'Company is required and must be 2-120 characters', [{ field: 'company', message: 'Must be 2-120 characters' }])
  // Website is optional enrichment (ROH-5): a business without one is a
  // first-class lead. Omission stays unknown, never an asserted absence.
  const rawWebsite = String(body.website || '').trim()
  const website = rawWebsite ? normalizeDomainInput(rawWebsite) : ''
  if (rawWebsite && (!isStringWithLength(website, 3, 253) || !isValidDomain(website))) return badRequest(res, 'website', 'Website must be a valid domain (e.g. example.com)', [{ field: 'website', message: 'Must be 3-253 chars, domain-like with a TLD' }])
  if (body.phone != null && String(body.phone).trim() && String(body.phone).trim() !== 'Not collected' && !isPhoneLike(String(body.phone))) return badRequest(res, 'phone', 'Phone number format is invalid', [{ field: 'phone', message: 'Must be 7-30 chars, digits, spaces, +, -, (), .' }])
  if (body.email != null && String(body.email).trim() && String(body.email).trim() !== 'Not collected' && !isEmail(String(body.email))) return badRequest(res, 'email', 'Email format is invalid', [{ field: 'email', message: 'Must be a valid email address' }])
  const websiteLower = website.toLowerCase()
  if (website && readRows('leads').some((lead) => String(lead.website || '').toLowerCase() === websiteLower)) {
    return conflict(res, 'A client with this website already exists', 'website', 'DUPLICATE_WEBSITE')
  }
  if (readRows('leads').some((lead) => String(lead.company || '').trim().toLowerCase() === company.toLowerCase())) {
    return conflict(res, 'A client with this company name already exists', 'company', 'DUPLICATE_COMPANY')
  }
  const lead = importedLead({ ...body, company, website }, 0, 'Manual entry')
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run(lead.id, JSON.stringify(lead))
  const artifacts = persistLeadArtifacts(lead)
  recordEvent('lead', lead.id, 'created', { source: 'Manual entry' })
  res.status(201).json(artifacts.ok ? lead : { ...lead, artifactWarning: artifacts.error })
})

app.post('/api/leads/import', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object with rows array')
  if (!Array.isArray(body.rows)) return badRequest(res, 'rows', 'rows must be an array', [{ field: 'rows', message: 'rows must be an array of lead objects' }])
  if (body.rows.length === 0) return badRequest(res, 'rows', 'rows must not be empty', [{ field: 'rows', message: 'Provide at least one row' }])
  if (body.rows.length > 500) return payloadTooLarge(res, 'Import limit is 500 rows (received ' + body.rows.length + ')')
  // Validate each row minimally before insert; per-row errors are counted as skipped
  const rowErrors = []
  body.rows.forEach((row, idx) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { rowErrors.push({ field: `rows[${idx}]`, message: 'Each row must be an object' }); return }
    const c = String(row.company || row.name || row.business || '').trim()
    const rawW = String(row.website || row.domain || '').trim()
    const w = rawW ? normalizeDomainInput(rawW) : ''
    if (!isStringWithLength(c, 2, 120)) rowErrors.push({ field: `rows[${idx}].company`, message: 'Company must be 2-120 chars' })
    if (rawW && (!isStringWithLength(w, 3, 253) || !isValidDomain(w))) rowErrors.push({ field: `rows[${idx}].website`, message: 'Website must be 3-253 chars domain-like' })
    if (row.phone != null && String(row.phone).trim() && String(row.phone).trim() !== 'Not collected' && !isPhoneLike(String(row.phone))) rowErrors.push({ field: `rows[${idx}].phone`, message: 'Invalid phone format' })
    if (row.email != null && String(row.email).trim() && String(row.email).trim() !== 'Not collected' && !isEmail(String(row.email))) rowErrors.push({ field: `rows[${idx}].email`, message: 'Invalid email format' })
  })
  // If more than half rows are invalid, fail fast with 400 and details (helps catch bad CSV). Otherwise we still process valid ones and report skipped.
  const rows = body.rows.slice(0, 500)
  const existingDomains = new Set(readRows('leads').map((lead) => normalizeDomainInput(String(lead.website || ''))))
  const created = []
  let skipped = 0
  const seenInBatch = new Set()
  rows.forEach((row, index) => {
    const company = String(row.company || row.name || row.business || '').trim()
    const rawWebsite = String(row.website || row.domain || '').trim()
    const website = rawWebsite ? normalizeDomainInput(rawWebsite) : ''
    // Website-less rows survive import consistently. Rows with a strong
    // provider identity always go through identity matching (a shared domain
    // never skips them); the domain fast-path only applies to weak rows.
    const rowBusinessId = row.businessId || businessIdentityFor(row) || null
    const strongRow = Boolean(rowBusinessId && !String(rowBusinessId).startsWith('manual:'))
    const batchKey = strongRow ? `id:${rowBusinessId}` : website ? `site:${website.toLowerCase()}` : `row:${normalizeIdentityText(company)}|${normalizeIdentityText(row.address || row.location)}`
    if (!isStringWithLength(company, 2, 120) || (rawWebsite && (!isStringWithLength(website, 3, 253) || !isValidDomain(website)))) { skipped += 1; return }
    if (!strongRow && website && (existingDomains.has(website.toLowerCase()) || seenInBatch.has(batchKey))) { skipped += 1; return }
    if (seenInBatch.has(batchKey)) { skipped += 1; return }
    if (row.phone != null && String(row.phone).trim() && String(row.phone).trim() !== 'Not collected' && !isPhoneLike(String(row.phone))) { skipped += 1; return }
    if (row.email != null && String(row.email).trim() && String(row.email).trim() !== 'Not collected' && !isEmail(String(row.email))) { skipped += 1; return }
    const lead = insertUniqueLead({ ...row, company, website, businessId: row.businessId || businessIdentityFor(row) || undefined }, index, 'CSV import')
    if (!lead) { skipped += 1; return }
    if (website) existingDomains.add(website.toLowerCase())
    seenInBatch.add(batchKey)
    created.push(lead)
  })
  res.status(201).json({ imported: created.length, skipped, leads: created, ...(rowErrors.length ? { rowErrors: rowErrors.slice(0, 20) } : {}) })
})

// VPS crawler export sync. The latest crawl-export.json snapshot is cached
// on disk (derived data — re-importable, excluded from backups).
const crawlDir = join(dataDir, 'crawl')
const crawlLatestPath = join(crawlDir, 'latest.json')
const readCrawlImport = () => {
  try {
    if (!existsSync(crawlLatestPath)) return null
    return JSON.parse(readFileSync(crawlLatestPath, 'utf8'))
  } catch {
    return null
  }
}

app.get('/api/crawl', (_req, res) => {
  const data = readCrawlImport()
  if (!data) return res.json({ imported: false })
  res.json({ imported: true, ...data, siteSummary: summarizeCrawlSites(data.sites) })
})

// Ships the repo's sample snapshot so the Crawl tab can be explored before
// the first real VPS import. Never written to disk automatically.
app.get('/api/crawl/sample', (_req, res) => {
  try {
    const samplePath = join(rootDir, 'crawler', 'crawl-export.sample.json')
    if (!existsSync(samplePath)) return notFound(res, 'Sample snapshot is not available')
    const result = validateCrawlExport(JSON.parse(readFileSync(samplePath, 'utf8')))
    if (!result.ok) return notFound(res, 'Sample snapshot is invalid')
    res.json({ imported: true, ...result.data, siteSummary: summarizeCrawlSites(result.data.sites), sample: true })
  } catch {
    return notFound(res, 'Sample snapshot is not available')
  }
})

app.post('/api/crawl/import', express.json({ limit: '60mb' }), (req, res) => {
  const result = validateCrawlExport(req.body)
  if (!result.ok) return badRequest(res, null, result.error)
  mkdirSync(crawlDir, { recursive: true })
  writeFileSync(crawlLatestPath, JSON.stringify(result.data))
  recordEvent('crawl', 'latest', 'imported', {
    exportedAt: result.data.exportedAt, sites: result.data.sites.length, siteTotal: result.data.siteTotal,
  })
  res.status(201).json({
    imported: true, exportedAt: result.data.exportedAt, sites: result.data.sites.length,
    siteTotal: result.data.siteTotal, siteTruncated: result.data.siteTruncated,
    summary: result.data.summary, siteSummary: summarizeCrawlSites(result.data.sites),
  })
})

// Shared by snapshot and local-run promotion. Crawl rows are weak identity
// (no provider id/address), so a shared domain resolves to the existing
// lead — same fast-path as CSV import — instead of creating a duplicate.
function addCrawledSiteAsLead(site, { company = '', source = 'Crawl import', evidenceSuffix = '' } = {}) {
  const row = crawlSiteToLeadRow(site, { company })
  if (!isStringWithLength(row.company, 2, 120)) return { ok: false, field: 'company', message: 'Company name must be 2-120 characters' }
  const noWebsiteBusiness = !row.website && Boolean(site.business)
  if (!noWebsiteBusiness && !isValidDomain(row.website)) return { ok: false, field: 'website', message: 'Crawled host is not a valid domain' }
  const existingByDomain = noWebsiteBusiness ? null : findLeadByWebsite(readRows('leads'), row.website)
  if (existingByDomain) {
    recordEvent('lead', existingByDomain.id, 'crawl_promoted', { siteId: site.id, host: site.host, matched: true })
    return { ok: true, created: false, lead: existingByDomain }
  }
  const lead = insertUniqueLead(row, 0, source)
  if (!lead) return { ok: false, field: null, message: 'Site could not be added as a lead' }
  const created = lead._runImport?.created !== false
  if (!created) {
    const { _runImport: _dropped, ...publicLead } = lead
    recordEvent('lead', lead.id, 'crawl_promoted', { siteId: site.id, host: site.host, matched: true })
    return { ok: true, created: false, lead: publicLead }
  }
  const annotated = {
    ...lead,
    ...(site.site_scan !== undefined ? { siteScan: site.site_scan } : {}),
    ...(site.qualification ? { qualification: site.qualification } : {}),
    evidence: [...(lead.evidence || []), `Crawl import: ${describeCrawlSite(site)}${evidenceSuffix}`],
    mainIssue: site.last_eligible ? 'Crawl flagged as eligible' : lead.mainIssue,
  }
  saveLead(annotated)
  recordEvent('lead', lead.id, 'crawl_promoted', { siteId: site.id, host: site.host })
  const { _runImport: _dropped, ...publicLead } = annotated
  return { ok: true, created: true, lead: publicLead }
}

app.post('/api/crawl/sites/:siteId/add-lead', (req, res) => {
  const data = readCrawlImport()
  if (!data) return notFound(res, 'No crawl import yet — import a crawl-export.json first')
  const site = (data.sites || []).find((row) => String(row.id) === String(req.params.siteId))
  if (!site) return notFound(res, 'Crawled site not found', 'siteId')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const result = addCrawledSiteAsLead(site, { company: String(body.company || ''), evidenceSuffix: ` (snapshot ${data.exportedAt})` })
  if (!result.ok) return badRequest(res, result.field, result.message)
  res.status(result.created ? 201 : 200).json({ created: result.created, lead: result.lead })
})

// Local scrape runs. Each run is a committable JSON file under data/crawl/local
// (VPS Postgres comes later); the runner updates it in place with progress.
const localRunsDir = join(crawlDir, 'local')
const localRunPath = (id) => join(localRunsDir, `${id}.json`)
const summarizeLocalRun = (run) => ({
  id: run.id,
  mode: run.mode,
  location: run.location || null,
  category: run.category || null,
  limit: run.limit,
  urlCount: (run.urls || []).length,
  status: run.status,
  progress: run.progress || { discovered: 0, scraped: 0, total: 0 },
  counts: run.counts || null,
  error: run.error || null,
  note: run.note || null,
  siteCount: (run.sites || []).length,
  createdAt: run.createdAt,
  finishedAt: run.finishedAt || null,
})
function listLocalRuns() {
  try {
    if (!existsSync(localRunsDir)) return []
    return readdirSync(localRunsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          return summarizeLocalRun(JSON.parse(readFileSync(join(localRunsDir, file), 'utf8')))
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch {
    return []
  }
}
function readLocalRun(id) {
  if (!isLocalRunId(id)) return { error: 'invalid' }
  try {
    if (!existsSync(localRunPath(id))) return { error: 'missing' }
    return { run: readLocalRunFile(localRunPath(id)) }
  } catch {
    return { error: 'unreadable' }
  }
}

app.post('/api/crawl/local-runs', (req, res) => {
  const validated = validateLocalScrapeRequest(req.body)
  if (!validated.ok) return badRequest(res, null, validated.error)
  const request = validated.request
  if (request.mode === 'discovery' && !getBrightDataConfig(readSettings()).apiKey) {
    return badRequest(res, null, 'Bright Data API key is not configured — paste URLs directly, or add the key in Settings')
  }
  const id = buildLocalRunId()
  const now = nowIso()
  const run = {
    version: LOCAL_RUN_VERSION,
    source: 'local',
    id,
    mode: request.mode,
    location: request.location || null,
    category: request.category || null,
    latitude: request.latitude ?? null,
    longitude: request.longitude ?? null,
    limit: request.limit,
    urls: request.urls || [],
    status: 'queued',
    progress: { discovered: 0, scraped: 0, total: request.mode === 'urls' ? request.urls.length : request.limit },
    counts: null,
    sites: [],
    error: null,
    note: null,
    createdAt: now,
    updatedAt: now,
  }
  mkdirSync(localRunsDir, { recursive: true })
  writeFileSync(localRunPath(id), JSON.stringify(run))
  recordEvent('crawl', id, 'local_run_queued', { mode: request.mode, location: run.location, category: run.category, total: run.progress.total })
  setImmediate(() => {
    runLocalScrape({ runPath: localRunPath(id), settings: readSettings() }).catch((error) => {
      console.error(`local run ${id} crashed`, error)
      try {
        writeLocalRunFile(localRunPath(id), { ...readLocalRunFile(localRunPath(id)), status: 'failed', error: 'Runner crashed unexpectedly', finishedAt: new Date().toISOString() })
      } catch {
        // Run file already gone; nothing left to mark.
      }
    })
  })
  res.status(201).json(summarizeLocalRun(run))
})

app.get('/api/crawl/local-runs', (_req, res) => {
  res.json({ runs: listLocalRuns() })
})

app.get('/api/crawl/local-runs/:runId', (req, res) => {
  const { run, error } = readLocalRun(req.params.runId)
  if (error === 'invalid') return badRequest(res, 'runId', 'Invalid run id format')
  if (!run) return notFound(res, 'Local run not found')
  res.json(run)
})

app.delete('/api/crawl/local-runs/:runId', (req, res) => {
  const { run, error } = readLocalRun(req.params.runId)
  if (error === 'invalid') return badRequest(res, 'runId', 'Invalid run id format')
  if (!run) return notFound(res, 'Local run not found')
  if (LOCAL_RUN_ACTIVE.includes(run.status)) return conflict(res, 'Cannot delete a running scrape — wait for it to finish', 'runId', 'RUN_ACTIVE')
  unlinkSync(localRunPath(req.params.runId))
  recordEvent('crawl', req.params.runId, 'local_run_deleted', {})
  res.json({ deleted: true })
})

app.post('/api/crawl/local-runs/:runId/sites/:siteId/add-lead', (req, res) => {
  const { run, error } = readLocalRun(req.params.runId)
  if (error === 'invalid') return badRequest(res, 'runId', 'Invalid run id format')
  if (!run) return notFound(res, 'Local run not found')
  const site = (run.sites || []).find((row) => String(row.id) === String(req.params.siteId))
  if (!site) return notFound(res, 'Scraped site not found', 'siteId')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const result = addCrawledSiteAsLead(site, {
    company: String(body.company || site.company || ''),
    source: 'Crawl import (local)',
    evidenceSuffix: ` (local run ${run.id})`,
  })
  if (!result.ok) return badRequest(res, result.field, result.message)
  res.status(result.created ? 201 : 200).json({ created: result.created, lead: result.lead })
})

// Runs stuck mid-flight when the process stopped can never resume (the
// runner is in-process), so mark them honestly instead of polling forever.
try {
  if (existsSync(localRunsDir)) {
    for (const file of readdirSync(localRunsDir).filter((name) => name.endsWith('.json'))) {
      try {
        const runPath = join(localRunsDir, file)
        const run = readLocalRunFile(runPath)
        if (LOCAL_RUN_ACTIVE.includes(run.status)) {
          writeLocalRunFile(runPath, { ...run, status: 'interrupted', error: 'Server stopped before the run finished', finishedAt: new Date().toISOString() })
        }
      } catch {
        // Leave unreadable run files for explicit deletion.
      }
    }
  }
} catch {
  // Local runs unavailable; endpoints report empty until the directory heals.
}

app.patch('/api/leads/:id', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const keys = Object.keys(body)
  if (keys.length === 0) return badRequest(res, null, 'No fields to update', [{ field: 'body', message: 'Provide at least one allowed field' }])
  if (keys.length > 30) return payloadTooLarge(res, 'Too many fields in patch (max 30)')
  const unknown = keys.filter(k => !ALLOWED_LEAD_PATCH_KEYS.has(k))
  if (unknown.length) return badRequest(res, null, 'Unknown field(s) in lead patch', unknown.map(f => ({ field: f, message: 'Unknown field' })))
  const details = []
  const push = (field, msg) => details.push({ field, message: msg })
  if ('qualified' in body && typeof body.qualified !== 'boolean') push('qualified', 'Must be a boolean')
  if ('salesStage' in body) {
    const v = body.salesStage
    if (v !== null && !ALLOWED_SALES_STAGES.has(v)) push('salesStage', `Must be one of: ${[...ALLOWED_SALES_STAGES].join(', ')} or null`)
  }
  if ('notes' in body && typeof body.notes !== 'string') push('notes', 'Must be a string')
  else if ('notes' in body && String(body.notes).length > 5000) push('notes', 'Must be <=5000 characters')
  if ('lostReason' in body) {
    if (typeof body.lostReason !== 'string' || !body.lostReason.trim()) push('lostReason', 'Must be a non-empty string')
    else if (body.lostReason.length > 500) push('lostReason', 'Must be <=500 characters')
  }
  if ('nextAction' in body) {
    if (typeof body.nextAction !== 'string' || !body.nextAction.trim()) push('nextAction', 'Must be a non-empty string')
    else if (body.nextAction.length > 500) push('nextAction', 'Must be <=500 characters')
  }
  if ('outreachSubject' in body && !isStringWithLength(body.outreachSubject, 3, 100)) push('outreachSubject', 'Must be 3-100 characters')
  if ('outreachVersion' in body && !ALLOWED_OUTREACH_VERSIONS.has(body.outreachVersion)) push('outreachVersion', `Must be one of: ${[...ALLOWED_OUTREACH_VERSIONS].join(', ')}`)
  if ('outreachDraft' in body && typeof body.outreachDraft !== 'string') push('outreachDraft', 'Must be a string')
  else if ('outreachDraft' in body && String(body.outreachDraft).length > 10000) push('outreachDraft', 'Must be <=10000 characters')
  if ('outreachDrafts' in body) {
    if (!body.outreachDrafts || typeof body.outreachDrafts !== 'object' || Array.isArray(body.outreachDrafts)) push('outreachDrafts', 'Must be an object')
    else {
      for (const [k, v] of Object.entries(body.outreachDrafts)) {
        if (!ALLOWED_OUTREACH_VERSIONS.has(k)) push(`outreachDrafts.${k}`, 'Unknown outreach version key')
        else if (typeof v !== 'string' || v.trim().length < 10) push(`outreachDrafts.${k}`, 'Must be a string >=10 chars')
      }
    }
  }
  if ('outreachStatus' in body && !ALLOWED_OUTREACH_STATUS.has(body.outreachStatus)) push('outreachStatus', `Must be one of: ${[...ALLOWED_OUTREACH_STATUS].join(', ')}`)
  if ('nextTask' in body) {
    const task = body.nextTask
    if (!task || typeof task !== 'object' || Array.isArray(task)) push('nextTask', 'Must be an object with type/dueAt/status')
    else {
      if (!NEXT_TASK_TYPES.includes(task.type)) push('nextTask.type', `Must be one of: ${NEXT_TASK_TYPES.join(', ')}`)
      if (task.dueAt != null && !isValidDayString(task.dueAt)) push('nextTask.dueAt', 'Must be a YYYY-MM-DD date or null')
      if (task.status != null && !TASK_STATUSES.includes(task.status)) push('nextTask.status', `Must be one of: ${TASK_STATUSES.join(', ')}`)
      if (task.owner != null && task.owner !== '' && !TASK_OWNERS.includes(task.owner)) push('nextTask.owner', `Must be one of: ${TASK_OWNERS.join(', ')} or empty`)
      if (task.note != null && String(task.note).length > 500) push('nextTask.note', 'Note is limited to 500 chars')
    }
  }
  if ('doNotContact' in body) {
    const suppression = body.doNotContact
    if (!suppression || typeof suppression !== 'object' || Array.isArray(suppression)) push('doNotContact', 'Must be an object with status/reason')
    else {
      if (typeof suppression.status !== 'boolean') push('doNotContact.status', 'Must be a boolean')
      if (suppression.status === true && !String(suppression.reason || '').trim()) push('doNotContact.reason', 'A reason is required when suppressing contact')
      if (suppression.scope != null && !['business', 'contact'].includes(suppression.scope)) push('doNotContact.scope', 'Must be business or contact')
    }
  }
  if ('briefRationale' in body) {
    const rationale = body.briefRationale
    if (!rationale || typeof rationale !== 'object' || Array.isArray(rationale)) push('briefRationale', 'Must be an object with text/by')
    else {
      if (!String(rationale.text || '').trim() || String(rationale.text).length > 2000) push('briefRationale.text', 'Text is required (max 2000 chars)')
      if (rationale.by != null && String(rationale.by).length > 40) push('briefRationale.by', 'Author is limited to 40 chars')
    }
  }
  if ('museStale' in body && typeof body.museStale !== 'boolean') push('museStale', 'Must be a boolean')
  if ('outreachStale' in body && typeof body.outreachStale !== 'boolean') push('outreachStale', 'Must be a boolean')
  if ('contactedAt' in body) {
    const d = new Date(body.contactedAt)
    if (Number.isNaN(d.getTime())) push('contactedAt', 'Must be a valid ISO date string')
  }
  if ('labels' in body) {
    if (!Array.isArray(body.labels)) push('labels', 'Must be an array')
    else if (body.labels.length > 20) push('labels', 'Max 20 labels')
    else body.labels.forEach((l, i) => { if (!isStringWithLength(l, 1, 40)) push(`labels[${i}]`, 'Each label must be 1-40 chars') })
  }
  if ('contract' in body) {
    const c = body.contract
    if (c !== null && (typeof c !== 'object' || Array.isArray(c))) push('contract', 'Must be an object or null')
    else if (c && typeof c === 'object') {
      const allowedContractKeys = new Set(['amount','currency','scope','terms','signedOn','startDate','conditions','nextStep'])
      for (const k of Object.keys(c)) if (!allowedContractKeys.has(k)) push(`contract.${k}`, 'Unknown contract field')
      if ('amount' in c && c.amount != null && (!Number.isFinite(Number(c.amount)) || Number(c.amount) < 0)) push('contract.amount', 'Must be a non-negative number')
      if ('currency' in c && c.currency != null && !/^[A-Z]{3}$/.test(String(c.currency).trim())) push('contract.currency', 'Must be a 3-letter currency code')
      for (const k of ['scope','terms','signedOn','startDate','conditions','nextStep']) if (k in c && c[k] != null && typeof c[k] !== 'string') push(`contract.${k}`, 'Must be a string')
      for (const k of ['scope','terms','conditions','nextStep']) if (k in c && typeof c[k] === 'string' && c[k].length > 1000) push(`contract.${k}`, 'Must be <=1000 characters')
    }
  }
  if ('category' in body && typeof body.category !== 'string') push('category', 'Must be a string')
  if ('location' in body && typeof body.location !== 'string') push('location', 'Must be a string')
  if ('phone' in body && body.phone != null && String(body.phone).trim() && String(body.phone).trim() !== 'Not collected' && !isPhoneLike(String(body.phone))) push('phone', 'Invalid phone format')
  if ('email' in body && body.email != null && String(body.email).trim() && String(body.email).trim() !== 'Not collected' && !isEmail(String(body.email))) push('email', 'Invalid email format')
  if ('duplicateReviewed' in body && typeof body.duplicateReviewed !== 'boolean') push('duplicateReviewed', 'Must be a boolean')
  if ('starred' in body && typeof body.starred !== 'boolean') push('starred', 'Must be a boolean')
  if ('contactCandidates' in body) {
    if (!Array.isArray(body.contactCandidates)) push('contactCandidates', 'Must be an array')
    else if (body.contactCandidates.length > 50) push('contactCandidates', 'Max 50 contact candidates')
    else body.contactCandidates.forEach((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) { push(`contactCandidates[${i}]`, 'Must be an object'); return }
      if (!['email','phone','form','contactPage','booking'].includes(c.kind)) push(`contactCandidates[${i}].kind`, 'Must be email, phone, form, contactPage or booking')
      if (!isStringWithLength(String(c.value || ''), 1, 500)) push(`contactCandidates[${i}].value`, 'Value must be 1-500 chars')
      if (c.source != null && !['website','provider','manual'].includes(c.source)) push(`contactCandidates[${i}].source`, 'Must be website, provider or manual')
    })
  }
  if ('outreachChannels' in body) {
    const ch = body.outreachChannels
    if (ch !== null && (typeof ch !== 'object' || Array.isArray(ch))) push('outreachChannels', 'Must be an object or null')
    else if (ch && typeof ch === 'object') {
      for (const k of Object.keys(ch)) if (!['email','phone','form'].includes(k)) push(`outreachChannels.${k}`, 'Unknown channel key')
      for (const k of ['email','phone','form']) if (k in ch && ch[k] != null && typeof ch[k] !== 'string') push(`outreachChannels.${k}`, 'Must be a string')
      for (const k of ['email','phone','form']) if (k in ch && typeof ch[k] === 'string' && ch[k].length > 10000) push(`outreachChannels.${k}`, 'Must be <=10000 characters')
    }
  }
  if ('outreachProvenance' in body) {
    const p = body.outreachProvenance
    if (p !== null && (typeof p !== 'object' || Array.isArray(p))) push('outreachProvenance', 'Must be an object or null')
  }
  if ('rev' in body && (!Number.isInteger(body.rev) || body.rev < 0)) push('rev', 'Must be a non-negative integer revision')
  if ('website' in body) {
    const raw = String(body.website || '').trim()
    const normalized = raw ? normalizeDomainInput(raw) : ''
    if (raw && (!isStringWithLength(normalized, 3, 253) || !isValidDomain(normalized))) push('website', 'Must be a valid domain or empty')
    else if (normalized && readRows('leads').some((item) => item.id !== req.params.id && String(item.website || '').toLowerCase() === normalized.toLowerCase())) push('website', 'Another client already uses this website')
  }
  if (details.length) return badRequest(res, null, 'Invalid lead patch values', details)

  const { rev: expectedRev, ...changes } = body
  const fresh = readLead(req.params.id)
  if (!fresh) return notFound(res, 'Lead not found', 'id')
  if (expectedRev != null && getRev(fresh) !== expectedRev) {
    return res.status(409).json({
      error: `This client changed while your edit was in flight (expected revision ${expectedRev}, current ${getRev(fresh)}). Reload and reapply the edit.`,
      code: 'REVISION_CONFLICT', expectedRev, rev: getRev(fresh),
    })
  }
  const patched = applyLeadWorkflowChanges(fresh, changes)
  if ('museStale' in changes) {
    patched.museAnalysis = { ...(patched.museAnalysis || {}), stale: changes.museStale === true, staleReason: changes.museStale === true ? (patched.museAnalysis?.staleReason || 'Marked stale by reviewer.') : null }
    delete patched.museStale
  }
  if (changes.outreachStale === false) patched.outreachStaleReason = null
  if ('nextTask' in changes) {
    const task = changes.nextTask
    patched.nextTask = {
      type: task.type,
      dueAt: task.dueAt ?? patched.nextTask?.dueAt ?? null,
      status: task.status ?? 'open',
      owner: task.owner ?? patched.nextTask?.owner ?? '',
      note: String(task.note ?? patched.nextTask?.note ?? ''),
      updatedAt: nowIso(),
    }
  }
  if ('doNotContact' in changes) {
    const suppression = changes.doNotContact
    patched.doNotContact = {
      status: suppression.status,
      reason: String(suppression.reason || '').trim(),
      scope: suppression.scope || patched.doNotContact?.scope || 'business',
      at: suppression.status ? nowIso() : patched.doNotContact?.at || null,
      ...(suppression.status ? {} : { clearedAt: nowIso() }),
    }
  }
  if ('briefRationale' in changes) {
    patched.briefRationale = { text: String(changes.briefRationale.text).trim(), by: String(changes.briefRationale.by || 'Reviewer').slice(0, 40), at: nowIso(), manual: true }
  }
  // Contacted reflects an actual recorded attempt — copying a draft or
  // flipping the status directly never counts.
  if (changes.outreachStatus === 'Contacted' && fresh.outreachStatus !== 'Contacted' && !(fresh.contactAttempts || []).length) {
    return res.status(409).json({ error: 'Record a contact attempt first — copying a draft does not count as contact.', code: 'ATTEMPT_REQUIRED' })
  }
  if ('website' in changes) {
    // Adding or changing the website later keeps the stable business id and
    // all history; only the website attribute moves, which re-enables audit.
    const normalized = String(changes.website || '').trim() ? normalizeDomainInput(String(changes.website)) : ''
    patched.website = normalized
    if (normalized !== String(fresh.website || '')) {
      patched.websiteStatus = 'supplied'
      patched.leadValue = scoreLeadValue({ ...patched, website: normalized }, { weights: readSettings().leadValueWeights })
      if (fresh.opportunityScore != null || fresh.analysisSource) recordEvent('lead', lead.id, 'website_changed', { from: fresh.website || null, to: normalized || null })
    }
  }
  const draftEdited = ('outreachDraft' in changes && String(changes.outreachDraft || '') !== String(fresh.outreachDraft || '')) ||
    ('outreachDrafts' in changes && JSON.stringify(changes.outreachDrafts || {}) !== JSON.stringify(fresh.outreachDrafts || {})) ||
    ('outreachSubject' in changes && String(changes.outreachSubject || '') !== String(fresh.outreachSubject || ''))
  const updated = saveLead({ ...patched, ...(draftEdited ? { outreachEdited: true } : {}), updated: 'Just now' })
  recordEvent('lead', lead.id, 'updated', { fields: Object.keys(changes), draftEdited })
  res.json(updated)
})

app.get('/api/leads/:id', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  res.json(lead)
})

app.post('/api/leads/:id/outreach/candidates', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const action = String(body.action || '').trim().toLowerCase()
  if (!['accept', 'dismiss'].includes(action)) return badRequest(res, 'action', 'Unsupported candidate action', [{ field: 'action', message: 'Must be accept or dismiss' }])
  try {
    let applied
    if (action === 'accept') {
      const index = body.index == null ? 0 : Number(body.index)
      if (!Number.isInteger(index) || index < 0) return badRequest(res, 'index', 'Candidate index must be a non-negative integer')
      applied = acceptOutreachCandidate(lead, index)
    } else {
      applied = dismissOutreachCandidates()
    }
    const updated = saveLead({ ...lead, ...applied, updated: 'Just now' })
    recordEvent('lead', lead.id, action === 'accept' ? 'outreach_candidate_accepted' : 'outreach_candidates_dismissed', { index: body.index ?? null })
    res.json(updated)
  } catch (error) {
    return unprocessable(res, error.message, 'outreachCandidates')
  }
})

app.get('/api/leads/:id/audits', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const manifests = listAuditManifests(dataDir, lead.id).map((manifest) => ({
    auditId: manifest.auditId,
    version: manifest.auditVersion ?? null,
    status: manifest.status || null,
    researchStatus: manifest.researchStatus || null,
    auditedAt: manifest.auditedAt || null,
    auditedUrl: manifest.auditedUrl || null,
    current: manifest.auditId === lead.currentAuditId,
    corrupt: Boolean(manifest.corrupt),
    lighthouse: manifest.artifacts?.lighthouseJson?.missing ? 'missing' : manifest.artifacts?.lighthouseJson ? 'stored' : 'unknown',
  }))
  res.json({ currentAuditId: lead.currentAuditId || null, audits: manifests })
})

// Lead-quality pipeline --------------------------------------------------

function activeJobFor(leadId, type) {
  return db.prepare("SELECT id FROM jobs WHERE lead_id = ? AND type = ? AND status IN ('Queued', 'Running', 'Waiting')").get(leadId, type) || null
}

function queueQualify(lead, { triggeredBy = 'user', autoVisual = true } = {}) {
  const active = activeJobFor(lead.id, 'qualify')
  if (active) return { queued: false, jobId: active.id }
  const job = queueJob({ type: 'qualify', leadId: lead.id, payload: { autoVisual }, maxAttempts: 2, triggeredBy })
  return { queued: true, jobId: job.id }
}

app.post('/api/leads/:id/qualify', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  res.status(202).json(queueQualify(lead, { autoVisual: req.body?.visual !== false }))
})

app.post('/api/leads/:id/visual-review', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (!lead.website) return unprocessable(res, 'Lead has no website to review', 'website')
  const active = activeJobFor(lead.id, 'visual')
  if (active) return res.status(202).json({ queued: false, jobId: active.id })
  const job = queueJob({ type: 'visual', leadId: lead.id, payload: {}, maxAttempts: 2, triggeredBy: 'user' })
  res.status(202).json({ queued: true, jobId: job.id, visionConfigured: getVisionConfig().configured })
})

// Qualify every lead. rescan=false re-scores saved scans without touching
// the network (fast, use after tuning rules); rescan=true crawls again.
app.post('/api/qualify/backfill', (req, res) => {
  const rescan = req.body?.rescan === true
  const leads = readRows('leads')
  let queued = 0
  let rescored = 0
  for (const lead of leads) {
    if (rescan || (lead.website && !lead.siteScan)) {
      if (queueQualify(lead, { triggeredBy: 'backfill', autoVisual: req.body?.visual === true }).queued) queued += 1
    } else {
      scopedLeadUpdate(lead.id, { qualification: requalify(lead, leads) })
      rescored += 1
    }
  }
  recordEvent('qualify', 'backfill', 'started', { rescan, queued, rescored })
  res.status(202).json({ queued, rescored, total: leads.length })
})

function prospectRow(lead) {
  const q = lead.qualification
  const screens = lead.visualReview?.files
    ? Object.fromEntries(Object.entries(lead.visualReview.files).map(([k, file]) => [k, `/api/leads/${lead.id}/screens/${file}`]))
    : null
  return {
    id: lead.id,
    company: lead.company,
    category: lead.category,
    market: lead.market || null,
    location: lead.location,
    website: lead.website || null,
    rating: lead.rating,
    reviews: lead.reviews,
    stage: lead.stage || null,
    play: q.play,
    playReason: q.playReason,
    confidence: q.confidence,
    priority: q.priority,
    presence: q.presence,
    businessWorth: q.businessWorth.score,
    siteWeakness: q.siteWeakness.score,
    weaknessBasis: q.siteWeakness.basis,
    contact: q.contact,
    pitchHooks: q.pitchHooks,
    flags: q.flags,
    needsVisualReview: q.needsVisualReview,
    visualReview: lead.visualReview ? { status: lead.visualReview.status, verdict: lead.visualReview.verdict || null, eraGuess: lead.visualReview.eraGuess || null, summary: lead.visualReview.summary || null, issues: lead.visualReview.issues || [] } : null,
    screens,
    qualifiedAt: q.qualifiedAt,
  }
}

// The shortlist: qualified leads ranked by priority, one row per business.
app.get('/api/prospects', (req, res) => {
  const play = String(req.query.play || 'active')
  if (!['active', 'all', ...PLAYS].includes(play)) return badRequest(res, 'play', `play must be one of active, all, ${PLAYS.join(', ')}`)
  const market = req.query.market ? String(req.query.market) : null
  const withEmail = req.query.contact === 'email'
  const limit = clampInt(req.query.limit ?? 100, 1, 1000) ?? 100
  const seen = new Map()
  for (const lead of readRows('leads')) {
    if (!lead.qualification) continue
    const key = lead.businessId && !String(lead.businessId).startsWith('manual:') ? lead.businessId : `${String(lead.company).toLowerCase()}|${lead.website || ''}`
    const prior = seen.get(key)
    if (!prior || (lead.qualification.priority > prior.qualification.priority)) seen.set(key, lead)
  }
  const rows = [...seen.values()]
    .filter((lead) => play === 'all' || (play === 'active' ? lead.qualification.play !== 'skip' : lead.qualification.play === play))
    .filter((lead) => !market || lead.market === market)
    .filter((lead) => !withEmail || Boolean(lead.qualification.contact?.email))
    .sort((a, b) => b.qualification.priority - a.qualification.priority)
  const counts = { redesign: 0, audit: 0, skip: 0, withEmail: 0 }
  for (const lead of seen.values()) {
    counts[lead.qualification.play] = (counts[lead.qualification.play] || 0) + 1
    if (lead.qualification.play !== 'skip' && lead.qualification.contact?.email) counts.withEmail += 1
  }
  res.json({ counts, total: rows.length, prospects: rows.slice(0, limit).map(prospectRow) })
})

app.get('/api/leads/:id/screens/:file', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  if (!/^(desktop|mobile)-(fold|full)\.jpg$/.test(req.params.file)) return notFound(res, 'Screenshot not found')
  const file = join(dataDir, 'leads', req.params.id, 'screens', req.params.file)
  if (!existsSync(file)) return notFound(res, 'Screenshot not found')
  res.type('image/jpeg').sendFile(file)
})

app.get('/api/markets', (_req, res) => {
  const leads = readRows('leads')
  res.json({
    markets: resolveMarkets(readSettings()).map((market) => ({
      ...market,
      leads: leads.filter((lead) => lead.market === market.id).length,
    })),
  })
})

// One discovery run per area in the market. Bright Data bills per record, so
// the caller picks areas, categories and a per-area limit explicitly.
app.post('/api/markets/:id/discover', (req, res) => {
  const settings = readSettings()
  const market = findMarket(settings, String(req.params.id))
  if (!market) return notFound(res, 'Market not found', 'id')
  if (!getBrightDataConfig(settings).ready) return unprocessable(res, 'Bright Data is not configured, so discovery cannot run', 'provider')
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const areaNames = Array.isArray(body.areas) && body.areas.length ? body.areas.map(String) : null
  const areas = areaNames ? market.areas.filter((area) => areaNames.includes(area.name)) : market.areas
  if (!areas.length) return badRequest(res, 'areas', `No matching areas. Available: ${market.areas.map((a) => a.name).join('; ')}`)
  const categories = Array.isArray(body.categories) && body.categories.length ? body.categories.map((c) => String(c).trim()).slice(0, 20) : market.categories
  const limit = clampInt(body.limit ?? 25, 1, 50) ?? 25
  const runs = []
  const errors = []
  areas.forEach((area, index) => {
    const result = startRun({ location: area.name, latitude: area.latitude, longitude: area.longitude, zoom: market.zoom, country: market.country, categories, limit }, settings, { market: market.id, idSuffix: `-${market.id}${index}` })
    if (result.error) errors.push({ area: area.name, error: result.error })
    else runs.push(result.id)
  })
  recordEvent('market', market.id, 'discovery_started', { areas: areas.map((a) => a.name), categories, limit, runs })
  res.status(202).json({ market: market.id, runs, errors, estimatedRecords: runs.length * limit })
})

app.post('/api/leads/:id/analyze', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  if (req.body && Object.keys(req.body).length > 20) return payloadTooLarge(res, 'Request body too large')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (!lead.website || !isValidDomain(normalizeDomainInput(lead.website))) return unprocessable(res, 'Lead has no valid website to audit', 'website')
  res.status(202).json(queueAuditForLead(lead, { workflow: 'audit' }))
})

app.post('/api/leads/:id/score', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  // Recompute commercial value from saved evidence under current weights.
  // Stored scores keep their own version, so history stays interpretable.
  const scored = scoreLeadValue(lead, { weights: readSettings().leadValueWeights })
  const updated = saveLead({ ...lead, leadValue: scored, updated: 'Just now' })
  recordEvent('lead', lead.id, 'value_rescored', { version: scored.version, score: scored.leadValueScore, band: scored.band })
  res.json(updated)
})

// Versioned, idempotent commercial backfill (M2). Saved evidence only: no
// website research, no model calls. Re-running with unchanged inputs and
// weights reproduces identical scores; only rows whose canonical score
// inputs changed are rewritten, so notes/stages/contracts/attempts survive.
app.post('/api/lead-value/backfill', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const force = body.force === true
  const weights = readSettings().leadValueWeights
  const leads = readRows('leads')
  let scored = 0
  let skipped = 0
  let unchanged = 0
  const results = []
  for (const lead of leads) {
    const next = scoreLeadValue(lead, { weights })
    const prev = lead.leadValue || null
    const same = prev && prev.version === next.version && prev.leadValueScore === next.leadValueScore
      && Math.abs(Number(prev.coverage || 0) - Number(next.coverage || 0)) < 1e-9
      && JSON.stringify(prev.weights || {}) === JSON.stringify(next.weights || {})
    if (same && !force) {
      unchanged += 1
      results.push({ id: lead.id, status: 'unchanged', score: prev.leadValueScore, version: prev.version })
      continue
    }
    // Insufficient-evidence rows are still stored explicitly so the UI can
    // distinguish "scored thin" from "never scored" without refetching.
    saveLead({ ...lead, leadValue: next, updated: lead.updated || 'Just now' })
    recordEvent('lead', lead.id, 'value_backfilled', { version: next.version, score: next.leadValueScore, band: next.band, coverage: next.coverage })
    scored += 1
    results.push({ id: lead.id, status: prev ? 'rescored' : 'scored', score: next.leadValueScore, version: next.version, coverage: next.coverage, band: next.band })
  }
  res.json({ ok: true, total: leads.length, scored, unchanged, skipped, results })
})

app.post('/api/leads/:id/muse/analyze', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before running AI', 'opportunityScore', 'AUDIT_REQUIRED')
  if (!getOutreachConfig().configured) return serviceUnavailable(res, 'AI is not configured', 'MUSE_NOT_CONFIGURED')
  const result = queueMuseSynthesis(lead, { requestedManually: true })
  res.status(202).json(result)
})

app.post('/api/leads/:id/actions/:action', async (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const action = String(req.params.action || '').trim().toLowerCase()
  if (!ALLOWED_MANUAL_ACTIONS.has(action) || !Object.hasOwn(manualActionLabels, action)) return badRequest(res, 'action', 'Unsupported client action', [{ field: 'action', message: `Must be one of: ${[...ALLOWED_MANUAL_ACTIONS].join(', ')}` }])
  if (['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status)) return conflict(res, `${lead.manualRun.label || 'Another client action'} is already running`, 'manualRun', 'ALREADY_RUNNING')
  try {
    if (action === 'refresh') {
      const brightData = getBrightDataConfig(readSettings())
      if (!brightData.ready) return serviceUnavailable(res, 'Bright Data is not configured', 'BRIGHT_DATA_NOT_CONFIGURED', 'brightData')
      if (!lead.sourceUrl) return conflict(res, 'This client has no saved Google Maps source URL to refresh', 'sourceUrl', 'MISSING_SOURCE_URL')
      return res.status(202).json({ ...queueRefreshForLead(lead), message: 'Business data refresh queued' })
    }
    if (action === 'audit') {
      if (!lead.website || !isValidDomain(normalizeDomainInput(lead.website))) return unprocessable(res, 'Lead has no valid website to audit', 'website')
      return res.status(202).json({ ...queueAuditForLead(lead, { workflow: 'audit', manualAction: 'audit' }), message: 'Website audit queued' })
    }
    if (action === 'muse') {
      if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before running AI', 'opportunityScore', 'AUDIT_REQUIRED')
      if (!getOutreachConfig().configured) return serviceUnavailable(res, 'AI is not configured', 'MUSE_NOT_CONFIGURED')
      return res.status(202).json({ ...queueMuseSynthesis(lead, { requestedManually: true, manualAction: 'muse' }), message: 'AI analysis queued' })
    }
    if (action === 'outreach') {
      if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before generating outreach', 'opportunityScore', 'AUDIT_REQUIRED')
      const started = saveLead({ ...lead, manualRun: manualRunState(lead, 'outreach', { reset: true, status: 'Running', progress: 25, phase: 'Generating three outreach drafts' }), updated: 'Generating outreach' })
      const updated = await generateAndSaveOutreach(started, { manualAction: 'outreach' })
      return res.json({ lead: updated, job: null, message: 'Three outreach drafts generated' })
    }
    if (action === 'full') {
      // No website and no refresh source: complete honestly without queueing —
      // there is nothing to audit, synthesize or draft from.
      if (!lead.website && !(getBrightDataConfig(readSettings()).ready && lead.sourceUrl)) {
        const done = saveLead({ ...lead, manualRun: manualRunState(lead, 'full', { reset: true, status: 'Completed', progress: 100, phase: 'No website to audit — business review continues manually', completedAt: nowIso() }), updated: 'Just now' })
        return res.json({ lead: done, job: null, skipped: true, message: 'No website to audit — business review continues manually' })
      }
      // No AI gate: without AI the workflow finishes the deterministic
      // audit plus template outreach drafts and says so honestly.
      const brightData = getBrightDataConfig(readSettings())
      if (brightData.ready && lead.sourceUrl) {
        return res.status(202).json({ ...queueRefreshForLead(lead, { manualAction: 'full' }), message: 'Full workflow queued from business refresh' })
      }
      const queued = queueAuditForLead(lead, { workflow: 'full', manualAction: 'full' })
      if (queued.skipped) {
        const done = saveLead({ ...queued.lead, manualRun: manualRunState(queued.lead, 'full', { status: 'Completed', progress: 100, phase: 'No website to audit — business review continues manually', completedAt: nowIso() }), updated: 'Just now' })
        return res.json({ lead: done, job: null, skipped: true, message: 'No website to audit — business review continues manually' })
      }
      return res.status(202).json({ ...queued, message: 'Full workflow queued from website audit' })
    }
  } catch (error) {
    const current = readLead(lead.id) || lead
    saveLead({ ...current, manualRun: manualRunState(current, action, { status: 'Failed', progress: 100, phase: error.message, error: error.message, completedAt: nowIso() }), updated: `${manualActionLabels[action]} failed` })
    recordEvent('lead', lead.id, 'manual_action_failed', { action, error: error.message })
    res.status(502).json({ error: `${manualActionLabels[action]} failed: ${error.message}`, code: 'ACTION_FAILED' })
  }
})

app.post('/api/enrichment/backfill', async (req, res) => {
  const body = req.body
  if (body && typeof body !== 'object') return badRequest(res, null, 'Request body must be a JSON object')
  if (body && 'regenerateMuse' in body && typeof body.regenerateMuse !== 'boolean') return badRequest(res, 'regenerateMuse', 'regenerateMuse must be a boolean', [{ field: 'regenerateMuse', message: 'Must be a boolean' }])
  const run = readRows('runs').filter((item) => item.providerSnapshotId).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0]
  if (!run) return notFound(res, 'No saved Bright Data discovery snapshot is available')
  try {
    const settings = readSettings()
    const records = await downloadDiscovery(run.providerSnapshotId, settings)
    const mapped = records.map((record) => mapDiscoveryRecord(record, 'Uncategorized', run.location || 'Unknown')).filter(Boolean)
    const leadMap = new Map(readRows('leads').map((lead) => [String(lead.website || '').toLowerCase().replace(/\/$/, ''), lead]))
    const updatedIds = new Set()
    for (const record of mapped) {
      const domain = String(record.website || '').toLowerCase().replace(/\/$/, '')
      const current = leadMap.get(domain)
      if (!current) continue
      const updated = saveLead(enrichLead({
        ...current,
        phone: current.phone === 'Not collected' && record.phone !== 'Not collected' ? record.phone : current.phone,
        email: current.email === 'Not collected' && record.email !== 'Not collected' ? record.email : current.email,
      }, record.businessIntelligence))
      leadMap.set(domain, updated)
      updatedIds.add(updated.id)
      recordEvent('lead', updated.id, 'business_enrichment_updated', { source: record.businessIntelligence.source, snapshotId: run.providerSnapshotId })
    }
    if (req.body?.regenerateMuse !== false && getOutreachConfig().configured) {
      for (const id of updatedIds) queueMuseSynthesis(readLead(id), { enrichmentBackfill: true, snapshotId: run.providerSnapshotId })
    }
    res.json({ records: records.length, updated: updatedIds.size, museQueued: req.body?.regenerateMuse !== false ? updatedIds.size : 0, leads: [...updatedIds].map(readLead) })
  } catch (error) {
    res.status(502).json({ error: `Could not backfill business enrichment: ${error.message}` })
  }
})

app.post('/api/leads/:id/attempts', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const body = req.body
  const details = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  if (!ATTEMPT_OUTCOMES.includes(body.outcome)) details.push({ field: 'outcome', message: `Must be one of: ${ATTEMPT_OUTCOMES.join(', ')}` })
  if (body.channel != null && !['email', 'phone', 'maps', 'in-person', 'other'].includes(body.channel)) details.push({ field: 'channel', message: 'Must be email, phone, maps, in-person or other' })
  if (body.contact != null && String(body.contact).length > 120) details.push({ field: 'contact', message: 'Contact is limited to 120 chars' })
  if (body.notes != null && String(body.notes).length > 1000) details.push({ field: 'notes', message: 'Notes are limited to 1000 chars' })
  if (details.length) return badRequest(res, null, 'Invalid contact attempt', details)
  const attempt = {
    id: `att-${randomUUID().slice(0, 8)}`,
    channel: body.channel || 'other',
    contact: String(body.contact || '').trim(),
    outcome: body.outcome,
    notes: String(body.notes || '').trim(),
    at: nowIso(),
  }
  const attempts = [...(lead.contactAttempts || []), attempt]
  // Only outcomes that prove a human was reached move the status.
  const contacted = CONTACT_OUTCOMES.includes(body.outcome)
  const updated = saveLead({
    ...lead,
    contactAttempts: attempts,
    ...(contacted ? { outreachStatus: 'Contacted', contactedAt: lead.contactedAt || nowIso() } : {}),
    updated: 'Just now',
  })
  recordEvent('lead', lead.id, 'contact_attempt', { attemptId: attempt.id, channel: attempt.channel, outcome: attempt.outcome, contacted })
  res.status(201).json({ lead: updated, attempt })
})

// Lightweight manual contact entry (M3). Additive: website-extracted
// candidates are never removed here; manual entries win on dedupe conflicts.
app.post('/api/leads/:id/contacts', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const body = req.body
  const details = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  if (!['email', 'phone', 'form', 'contactPage', 'booking'].includes(body.kind)) details.push({ field: 'kind', message: 'Must be email, phone, form, contactPage or booking' })
  if (!isStringWithLength(String(body.value || ''), 1, 500)) details.push({ field: 'value', message: 'Value must be 1-500 chars' })
  if (body.kind === 'email' && !isEmail(String(body.value || ''))) details.push({ field: 'value', message: 'Invalid email format' })
  if (body.kind === 'phone' && !isPhoneLike(String(body.value || ''))) details.push({ field: 'value', message: 'Invalid phone format' })
  if (details.length) return badRequest(res, null, 'Invalid contact candidate', details)
  const value = String(body.value).trim()
  const candidate = {
    id: `manual-${randomUUID().slice(0, 8)}`,
    kind: body.kind,
    value,
    normalized: body.kind === 'email' ? value.toLowerCase() : value,
    sourceUrl: 'manual-entry',
    observedAt: nowIso(),
    method: 'manual-entry',
    source: 'manual',
    verification: 'owner-entered',
  }
  const merged = mergeContactCandidates(lead.contactCandidates || [], [candidate])
  const patch = { contactCandidates: merged, updated: 'Just now' }
  // Fill empty top-level slots from manual entry without overwriting set values.
  if (body.kind === 'email' && (!lead.email || lead.email === 'Not collected')) patch.email = value
  if (body.kind === 'phone' && (!lead.phone || lead.phone === 'Not collected')) patch.phone = value
  const updated = saveLead({ ...lead, ...patch })
  recordEvent('lead', lead.id, 'contact_added', { kind: candidate.kind })
  res.status(201).json({ lead: updated, contact: candidate })
})

app.post('/api/leads/:id/findings/review', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const body = req.body
  const details = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  if (!['accepted', 'rejected'].includes(body.decision)) details.push({ field: 'decision', message: 'Must be accepted or rejected' })
  if (body.decision === 'rejected' && !String(body.reason || '').trim()) details.push({ field: 'reason', message: 'A reason is required when rejecting a finding' })
  if (body.reason != null && String(body.reason).length > 1000) details.push({ field: 'reason', message: 'Reason is limited to 1000 chars' })
  if (body.by != null && String(body.by).length > 40) details.push({ field: 'by', message: 'Author is limited to 40 chars' })
  const findings = briefFindings(lead)
  const finding = findings.find((item) => item.key === body.findingKey)
  if (!finding && !details.length) details.push({ field: 'findingKey', message: 'Finding is not part of the current audit' })
  if (details.length) return badRequest(res, null, 'Invalid finding review', details)
  const review = {
    findingKey: finding.key,
    decision: body.decision,
    reason: String(body.reason || '').trim(),
    by: String(body.by || 'Reviewer').slice(0, 40),
    auditId: lead.currentAuditId || null,
    at: nowIso(),
  }
  const reviews = (lead.findingReviews || []).filter((item) => item.findingKey !== review.findingKey || item.auditId !== review.auditId)
  reviews.push(review)
  const updated = saveLead({ ...lead, findingReviews: reviews, updated: 'Just now' })
  recordEvent('lead', lead.id, 'finding_reviewed', { findingKey: review.findingKey, decision: review.decision, auditId: review.auditId })
  res.status(201).json({ lead: updated, review })
})

app.get('/api/leads/:id/brief', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const readiness = briefReadiness(lead)
  const status = reviewStatus(lead)
  res.json({ lead, readiness, reviews: { accepted: status.accepted, rejected: status.rejected, stale: status.stale, pending: status.pending } })
})

function duplicateCountsByName(leads) {
  const groups = new Map()
  for (const lead of leads) {
    const key = String(lead?.company || '').trim().toLowerCase()
    if (!key) continue
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  const counts = new Map()
  for (const lead of leads) {
    const key = String(lead?.company || '').trim().toLowerCase()
    if (key && (groups.get(key) || 0) > 1) counts.set(lead.id, groups.get(key))
  }
  return counts
}

app.get('/api/leads/:id/readiness', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const counts = duplicateCountsByName(readRows('leads'))
  const readiness = computeReadiness(lead, { duplicateCount: counts.get(lead.id) || 0 })
  res.json({ leadId: lead.id, readiness, summary: explainReadiness(readiness) })
})

app.get('/api/queue', (_req, res) => {
  const leads = readRows('leads')
  const counts = duplicateCountsByName(leads)
  const items = buildQueue(leads, { duplicateCounts: counts })
  res.json({ items, generatedAt: nowIso() })
})

app.post('/api/leads/:id/brief-export', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const readiness = briefReadiness(lead)
  if (!readiness.accepted.length) {
    return res.status(409).json({ error: 'No reviewed findings to export — review the audit evidence first.', code: 'NOTHING_REVIEWED' })
  }
  const markdown = buildBriefMarkdown(lead, readiness)
  recordEvent('lead', lead.id, 'brief_exported', { accepted: readiness.accepted.length, ready: readiness.ready })
  res.json({ lead, markdown, readiness })
})

// Prospect-facing one-pager (M7). Snapshot only: returns markdown with a
// date and provenance, never sends or publishes it.
app.post('/api/leads/:id/prospect-brief', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const markdown = buildProspectBrief(lead, { date: nowIso() })
  if (!markdown) {
    return res.status(409).json({ error: 'No reviewed findings to export — review the audit evidence first.', code: 'NOTHING_REVIEWED' })
  }
  recordEvent('lead', lead.id, 'prospect_brief_exported', { auditId: lead.currentAuditId || null })
  res.json({ leadId: lead.id, markdown, exportedAt: nowIso(), auditId: lead.currentAuditId || null })
})

app.post('/api/leads/:id/outreach/generate', async (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (lead.doNotContact?.status) return res.status(409).json({ error: `Outreach is suppressed${lead.doNotContact.reason ? `: ${lead.doNotContact.reason}` : ''}. Clear the suppression explicitly to reopen.`, code: 'SUPPRESSED' })
  if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before generating outreach', 'opportunityScore', 'AUDIT_REQUIRED')
  try {
    res.json(await generateAndSaveOutreach(lead))
  } catch (error) {
    recordEvent('lead', lead.id, 'outreach_generation_failed', { error: error.message })
    res.status(502).json({ error: `Could not generate outreach: ${error.message}` })
  }
})

// Creates a discovery run (Bright Data when configured, otherwise saved
// clients). Shared by POST /api/runs and market discovery.
function startRun(body, settings, extra = {}) {
  const now = new Date()
  const id = `run-${now.getTime().toString(36)}${extra.idSuffix || ''}`
  const categories = Array.isArray(body.categories) && body.categories.length ? body.categories.map(c=>String(c).trim()) : settings.categories
  const brightData = getBrightDataConfig(settings)
  const requestedLimit = clampInt(body.limit ?? settings.resultLimit ?? 25, 1, 50) ?? 25
  const limit = brightData.ready ? Math.min(requestedLimit, brightData.maxRecords) : requestedLimit
  const requestedDeep = clampInt(body.deepAuditLimit ?? settings.deepAuditLimit ?? 10, 1, 50) ?? 10
  const deepAuditLimit = Math.max(1, Math.min(limit, requestedDeep))
  const location = isStringWithLength(String(body.location || ''), 1, 120) ? String(body.location).trim() : settings.defaultLocation
  let searchDefinition
  try {
    searchDefinition = resolveSearchDefinition({
      location,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      country: body.country ?? null,
      zoom: body.zoom ?? null,
      categories,
      settings,
    })
  } catch (error) {
    return { error: error.message }
  }
  const run = {
    id,
    createdAt: now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' ·'),
    startedAt: now.toISOString(),
    location: searchDefinition.displayLocation,
    categories,
    searchDefinition,
    source: brightData.ready ? 'Bright Data Google Maps' : 'Existing client websites',
    status: 'Running', progress: 0, discovered: 0, crawled: 0, audited: 0, failed: 0, datasets: 0, duration: 'Starting',
    deadlineAt: new Date(now.getTime() + (Number(readSettings().runTimeoutMs) || 7200000)).toISOString(),
    limit, deepAuditLimit, options: (body.options && typeof body.options === 'object' && !Array.isArray(body.options)) ? body.options : {},
    ...(extra.market ? { market: extra.market } : {}),
  }
  db.prepare('INSERT INTO runs (id, payload) VALUES (?, ?)').run(id, JSON.stringify(run))
  recordEvent('run', id, 'started', { source: run.source, categories, location: run.location, searchDefinition })
  if (brightData.ready) {
    queueJob({ type: 'discover', runId: id, payload: {}, maxAttempts: 3 })
  } else {
    const normalizedCategories = new Set(categories.map((value) => String(value).toLowerCase()))
    const candidates = readRows('leads')
      .filter((lead) => lead.website && (normalizedCategories.size === 0 || normalizedCategories.has(String(lead.category).toLowerCase())))
    const geoFilter = filterSavedClientsByLocation(candidates, searchDefinition.displayLocation)
    const leads = geoFilter.matched
      .sort((a, b) => Number(a.opportunityScore != null) - Number(b.opportunityScore != null) || Number(b.prelimScore || 0) - Number(a.prelimScore || 0))
      .slice(0, deepAuditLimit)
    leads.forEach((lead) => queueJob({ type: 'audit', runId: id, leadId: lead.id, payload: { respectRobots: settings.respectRobots, workflow: 'analysis' }, maxAttempts: 2 }))
    saveRun({
      ...run,
      discovered: leads.length,
      savedClientFilter: { mode: 'city-text', city: geoFilter.city, scanned: geoFilter.scanned, matched: geoFilter.matched.length, audited: leads.length },
      duration: leads.length ? `Auditing ${leads.length} saved websites near ${geoFilter.city || searchDefinition.displayLocation}` : 'No matching saved websites in this location',
    })
    if (!leads.length) saveRun({ ...readRun(id), status: 'Completed', progress: 100, duration: '0s', completedAt: nowIso() })
  }
  return { id }
}

app.post('/api/runs', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const settings = readSettings()
  const details = []
  if ('location' in body && body.location != null) {
    if (!isStringWithLength(String(body.location), 1, 120)) details.push({ field: 'location', message: 'Location must be a non-empty string 1-120 chars' })
  }
  if ('categories' in body && body.categories != null) {
    if (!Array.isArray(body.categories)) details.push({ field: 'categories', message: 'categories must be an array' })
    else if (body.categories.length === 0) details.push({ field: 'categories', message: 'categories must not be empty' })
    else if (body.categories.length > 20) details.push({ field: 'categories', message: 'Max 20 categories' })
    else body.categories.forEach((c, i) => {
      if (!isStringWithLength(String(c), 1, 40)) details.push({ field: `categories[${i}]`, message: 'Each category must be 1-40 chars' })
      else if (!/^[A-Za-z0-9 &\-/]+$/.test(String(c).trim())) details.push({ field: `categories[${i}]`, message: 'Category contains invalid characters' })
    })
  }
  if ('limit' in body && body.limit != null) {
    const n = clampInt(body.limit, 1, 50)
    if (n == null) details.push({ field: 'limit', message: 'limit must be an integer 1-50' })
  }
  for (const [field, min, max] of [['latitude', -90, 90], ['longitude', -180, 180]]) {
    if (field in body && body[field] != null && body[field] !== '') {
      const n = Number(body[field])
      if (!Number.isFinite(n) || n < min || n > max) details.push({ field, message: `${field} must be a number ${min} to ${max}` })
    }
  }
  if ('country' in body && body.country != null && body.country !== '' && !/^[A-Za-z]{2}$/.test(String(body.country).trim())) {
    details.push({ field: 'country', message: 'country must be a 2-letter code' })
  }
  if ('zoom' in body && body.zoom != null && body.zoom !== '') {
    const n = Number(body.zoom)
    if (!Number.isFinite(n) || n < 12 || n > 16) details.push({ field: 'zoom', message: 'zoom must be a number 12-16' })
  }
  if ('deepAuditLimit' in body && body.deepAuditLimit != null) {
    const n = clampInt(body.deepAuditLimit, 1, 50)
    if (n == null) details.push({ field: 'deepAuditLimit', message: 'deepAuditLimit must be an integer 1-50' })
  }
  if ('options' in body && body.options != null) {
    if (typeof body.options !== 'object' || Array.isArray(body.options)) details.push({ field: 'options', message: 'options must be an object' })
    else if (Object.keys(body.options).length > 20) details.push({ field: 'options', message: 'Too many option keys (max 20)' })
  }
  if (details.length) return badRequest(res, null, 'Invalid run parameters', details)
  if ('deepAuditLimit' in body && 'limit' in body && body.deepAuditLimit != null && body.limit != null) {
    if (Number(body.deepAuditLimit) > Number(body.limit)) return badRequest(res, 'deepAuditLimit', 'deepAuditLimit must be <= limit', [{ field: 'deepAuditLimit', message: 'Must be <= limit' }])
  }

  const result = startRun(body, settings)
  if (result.error) return badRequest(res, 'location', result.error, [{ field: 'location', message: result.error }])
  res.status(201).json(decorateRun(syncRun(result.id) || readRun(result.id)))
})

app.patch('/api/runs/:id', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid run id format')
  const run = readRun(req.params.id)
  if (!run) return notFound(res, 'Run not found', 'id')
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const allowedKeys = new Set(['status','duration'])
  const unknown = Object.keys(body).filter(k=>!allowedKeys.has(k))
  if (unknown.length) return badRequest(res, null, 'Unknown field(s) in run patch', unknown.map(f=>({field:f, message:'Unknown field'})))
  const requested = body.status
  if (typeof requested !== 'string' || !['Running','Paused','Cancelled'].includes(requested)) return badRequest(res, 'status', 'Only run pause, resume, and cancel operations are supported', [{ field: 'status', message: 'Must be one of: Running, Paused, Cancelled' }])
  // validate status transitions
  const current = syncRun(run.id)?.status || run.status
  if (['Completed','Cancelled'].includes(current) && requested !== current) {
    return unprocessable(res, `Cannot transition run from ${current} to ${requested}`, 'status')
  }
  if (current === 'Paused' && !['Running','Cancelled'].includes(requested)) {
    return unprocessable(res, `Invalid transition from Paused to ${requested}`, 'status')
  }
  const updated = saveRun({ ...run, status: requested, duration: requested === 'Cancelled' ? 'Cancelled manually' : requested })
  if (requested === 'Cancelled') {
    db.prepare("UPDATE jobs SET status = 'Cancelled', progress = 100, updated_at = ? WHERE run_id = ? AND status IN ('Queued', 'Waiting')").run(nowIso(), run.id)
    // Running jobs stop at their next cancellation point; their completion
    // claim then drops any late finish, and the guards below prevent any
    // further downstream enqueueing for this run.
    for (const active of db.prepare("SELECT id FROM jobs WHERE run_id = ? AND status = 'Running'").all(run.id)) requestJobCancel(active.id)
  }
  recordEvent('run', run.id, requested.toLowerCase(), {})
  res.json(syncRun(run.id) || updated)
})

app.post('/api/leads/:id/export', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  const folder = writeLeadArtifacts(lead, true)
  const filePath = join(folder, 'profile.md')
  res.json({ markdown: leadMarkdown(lead), filePath })
})

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' })
})

app.use((error, req, res, next) => {
  if (!req.originalUrl.startsWith('/api')) return next(error)
  const invalidJson = error instanceof SyntaxError && error.status === 400 && 'body' in error
  const tooLarge = error.type === 'entity.too.large'
  const status = tooLarge ? 413 : invalidJson ? 400 : Number(error.status) || 500
  const code = tooLarge ? 'PAYLOAD_TOO_LARGE' : invalidJson ? 'INVALID_JSON' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'
  const message = tooLarge ? 'Request body is too large (max 1mb)' : invalidJson ? 'Request body contains invalid JSON' : status >= 500 ? 'The local API could not complete the request' : error.message
  console.error('Scoutline API error', error)
  res.status(status).json({ error: message, code })
})

const distDir = join(rootDir, 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('/{*splat}', (_req, res) => res.sendFile(join(distDir, 'index.html')))
}

const port = Number(process.env.SCOUTLINE_PORT || 8787)
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Scoutline API ready at http://127.0.0.1:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0) }))
}
