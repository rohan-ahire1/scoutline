import express from 'express'
import Database from 'better-sqlite3'
import 'dotenv/config'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { auditWebsite } from './services/audit.js'
import { enrichLead } from './services/enrichment.js'
import { generateMuseAnalysis } from './services/insights.js'
import { acceptOutreachCandidate, applyOutreachGeneration, dismissOutreachCandidates, generateOutreach, getOutreachConfig } from './services/outreach.js'
import { describeGeographyCoverage, downloadDiscovery, filterSavedClientsByLocation, getBrightDataConfig, legacySearchFromSettings, mapDiscoveryRecord, pollDiscovery, reconcileRecords, resolveSearchDefinition, triggerDiscovery, triggerRecordRefresh } from './services/discovery.js'
import { applyLeadWorkflowChanges, normalizeLeadWorkflow } from './workflow.js'
import { formatProvenanceScore, resolveMetricProvenance, resolveNestedProvenance } from './services/measure.js'

const serverDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(serverDir, '..')
const dataDir = process.env.SCOUTLINE_DATA_DIR ? resolve(process.env.SCOUTLINE_DATA_DIR) : join(rootDir, 'data')
mkdirSync(dataDir, { recursive: true })

const db = new Database(join(dataDir, 'scoutline.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
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
    updated_at TEXT NOT NULL
  );
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
db.prepare("UPDATE jobs SET status = 'Queued', error = NULL, updated_at = ? WHERE status = 'Running'").run(new Date().toISOString())

const defaultSettings = {
  defaultLocation: 'Salt Lake City, Utah',
  resultLimit: 25,
  deepAuditLimit: 10,
  categories: ['Roofing', 'HVAC', 'Flooring'],
  maxPages: 10,
  requestDelay: 1500,
  respectRobots: true,
  blockPrivateNetworks: true,
  discoveryCountry: 'US',
  discoveryLatitude: 40.7608,
  discoveryLongitude: -111.891,
  discoveryZoom: 13,
}
const settingInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
Object.entries(defaultSettings).forEach(([key, value]) => settingInsert.run(key, JSON.stringify(value)))

const app = express()
app.use(express.json({ limit: '1mb' }))

// ── Shared validation helpers (structured errors) ─────────────────────────────────
const ALLOWED_CATEGORIES = new Set(['Roofing','HVAC','Flooring','Plumbing','Electrical','Solar','Remodeling','Landscaping','Painting','Cleaning','General','Uncategorized'])
const ALLOWED_SALES_STAGES = new Set(['Qualified','Contacted','Replied','Meeting','Proposal','Won','Lost'])
const ALLOWED_OUTREACH_VERSIONS = new Set(['Concise','Balanced','Detailed'])
const ALLOWED_OUTREACH_STATUS = new Set(['Draft','Contacted','Replied','Meeting','Insufficient evidence'])
const ALLOWED_MANUAL_ACTIONS = new Set(['refresh','audit','muse','outreach','full'])
const ALLOWED_SETTINGS_KEYS = new Set(Object.keys(defaultSettings))
const ALLOWED_LEAD_PATCH_KEYS = new Set(['qualified','salesStage','qualifiedAt','notes','outreachSubject','outreachVersion','outreachDraft','outreachDrafts','outreachStatus','contactedAt','contract','lostReason','nextAction','labels','category','location','phone','email','address','rating','reviews','sourceUrl','researchStatus'])

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
  db.prepare('UPDATE leads SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(lead), lead.id)
  writeLeadArtifacts(lead)
  return lead
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
    ? `\n## Muse synthesis (advisory)\n\n- Recommendation: ${lead.museAnalysis.qualificationRecommendation}\n- Rationale: ${lead.museAnalysis.qualificationRationale}\n- Model: ${lead.museAnalysis.generation?.model || 'Not recorded'}\n- Generated: ${lead.museAnalysis.generation?.generatedAt || 'Not recorded'}\n\n${lead.museAnalysis.summary}\n\n### Prioritized opportunities\n\n${(lead.museAnalysis.topOpportunities || []).map((item) => `- **${item.severity} — ${item.title}:** ${item.evidence} Recommendation: ${item.recommendation}`).join('\n') || '- None recorded'}\n\n### Strengths\n\n${list(lead.museAnalysis.strengths)}\n\n### Unknowns\n\n${list(lead.museAnalysis.unknowns)}\n\nMuse is an evidence-synthesis aid. It does not alter the deterministic opportunity score.\n`
    : ''
  return `# ${lead.company}\n\n` +
    `## Business profile\n\n` +
    `- Category: ${lead.category}\n- Location: ${lead.location}\n- Website: https://${lead.website}\n- Phone: ${lead.phone}\n- Public email: ${lead.email}\n- Google rating: ${lead.rating} (${lead.reviews} reviews)\n\n` +
    `## Opportunity assessment\n\n- Preliminary opportunity: ${lead.prelimScore}/100\n- Opportunity score: ${lead.opportunityScore ?? 'Not analyzed'}\n- Confidence: ${lead.confidence ?? 'Not analyzed'}\n- Source: ${lead.analysisSource || 'Not recorded'}\n- Research status: ${lead.researchStatus}\n- Rebuild feasibility: ${lead.rebuild}${lead.researchFailure ? `\n- Failed stage: ${['Scraped', 'Analyzed', 'Qualified'][lead.researchFailure.stage] || 'Unknown'}\n- Failure reason: ${lead.researchFailure.reason}` : ''}\n\n` +
    `## Website audit\n\n- Mobile performance: ${formatProvenanceScore(resolveMetricProvenance(lead, 'performance'))}\n- Accessibility: ${formatProvenanceScore(resolveMetricProvenance(lead, 'accessibility'))}\n- SEO: ${formatProvenanceScore(resolveMetricProvenance(lead, 'seo'))}\n- Best practices: ${formatProvenanceScore(resolveNestedProvenance(lead?.measureProvenance?.bestPractices, lead?.lighthouse?.scores?.bestPractices))}\n- Same-site pages crawled: ${lead.pageCount ?? 'Not measured'}\n- Internal links checked: ${lead.checkedLinks ?? 'Not measured'}\n- Broken internal links: ${lead.brokenLinks ?? 'Not measured'}${lead.linkSummary ? ` (confirmed 404/410 of ${lead.linkSummary.attempted ?? '?'} attempted; ${lead.linkSummary.reachable ?? 0} reachable, ${lead.linkSummary.unverified ?? 0} unverified — blocked/unreachable links are not called broken)` : ''}\n- Mobile quality: ${lead.mobileQuality}\n- HTTPS: ${lead.https == null ? 'Not measured' : lead.https ? 'Yes' : 'No'}\n- Detected stack: ${(lead.stack || []).join(', ') || 'Unknown'}\n\n` +
    `## Business intelligence\n\n- Digital maturity: ${lead.businessIntelligence?.digitalMaturity?.score ?? 'Not calculated'}/100${lead.businessIntelligence?.digitalMaturity?.band ? ` (${lead.businessIntelligence.digitalMaturity.band})` : ''}${lead.businessIntelligence?.digitalMaturity?.version ? ` [formula v${lead.businessIntelligence.digitalMaturity.version}]` : ''}${lead.businessIntelligence?.digitalMaturity?.coverage ? ` — evidence coverage ${lead.businessIntelligence.digitalMaturity.coverage.measuredComponents}/${lead.businessIntelligence.digitalMaturity.coverage.totalComponents} components (${lead.businessIntelligence.digitalMaturity.coverage.share}% of weighted signals measured)` : ''}\n- Employees: ${metric('employeeCount')}\n- Annual revenue: ${metric('annualRevenue')}\n- Annual profit: ${metric('annualProfit')}\n- Founded: ${metric('foundedYear')}\n- Branch count: ${metric('branchCount')}\n- Locations observed in discovery: ${lead.businessIntelligence?.locationsObserved ?? 'Not observed'}\n- Google profile claimed: ${lead.businessIntelligence?.claimed == null ? 'Unknown' : lead.businessIntelligence.claimed ? 'Yes' : 'No'}\n- Online booking: ${lead.businessIntelligence?.onlineBooking ? 'Detected' : 'Not detected'}\n- Four- and five-star review share: ${lead.businessIntelligence?.positiveReviewShare ?? 'Unknown'}${lead.businessIntelligence?.positiveReviewShare != null ? '%' : ''}\n- Latest sampled review: ${lead.businessIntelligence?.latestObservedReviewAt || 'Unknown'}\n\nSource-backed fields remain unknown when no provider supplies them.\n\n` +
    (lead.captureQuality || lead.researchStatus === 'Inconclusive' ? `## Capture quality\n\n- Assessment: ${lead.researchStatus === 'Inconclusive' ? 'Inconclusive — no defect-derived score is claimed' : lead.researchStatus}\n- Capture: ${lead.captureQuality?.quality || 'Not recorded'} via ${lead.captureQuality?.captureMethod || 'unknown method'}\n- Reason: ${lead.captureQuality?.reason || lead.lastAuditAttempt?.reason || 'Not recorded'}\n- Rendered-page fallback: ${lead.captureQuality?.renderedFallback || 'not applicable'}\n- Last successful audit: ${lead.lastSuccessfulAudit ? `${lead.lastSuccessfulAudit.score}/100 on ${lead.lastSuccessfulAudit.at} (${lead.lastSuccessfulAudit.url || 'URL not recorded'})` : 'None recorded'}\n\n` : '') +
    `## Main observed issue\n\n**${lead.mainIssue}:** ${lead.issueDetail}\n\n` +
    `## Findings\n\n${list(lead.problems)}\n\n` +
    `## Evidence\n\n${list(lead.evidence)}\n\n` +
    muse +
    `## Safety contract\n\nDo not invent revenue, decision-maker names, hosting costs, performance metrics, or unobserved facts. Outreach remains manual and must be reviewed before sending.\n` +
    (lead.contract ? `\n## Won contract\n\n- Approved value: ${lead.contract.currency || 'USD'} ${lead.contract.amount || 0}\n- Scope: ${lead.contract.scope || 'Not recorded'}\n- Terms: ${lead.contract.terms || 'Not recorded'}\n- Signed on: ${lead.contract.signedOn || 'Not recorded'}\n- Start date: ${lead.contract.startDate || 'Not recorded'}\n- Conditions: ${lead.contract.conditions || 'None recorded'}\n- Next step: ${lead.contract.nextStep || 'Not recorded'}\n` : '')
}

function writeLeadArtifacts(lead, includeProfile = false) {
  const folder = join(dataDir, 'leads', lead.id)
  mkdirSync(folder, { recursive: true })
  const businessData = {
    id: lead.id, company: lead.company, category: lead.category, location: lead.location,
    website: lead.website, address: lead.address || null, phone: lead.phone, email: lead.email, rating: lead.rating,
    reviews: lead.reviews, collectedAt: lead.collectedAt, sourceUrl: lead.sourceUrl || null,
    businessIntelligence: lead.businessIntelligence || null,
  }
  const auditData = {
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
    researchFailure: lead.researchFailure || null, history: lead.auditHistory || [],
  }
  writeFileSync(join(folder, 'raw.json'), JSON.stringify(businessData, null, 2), 'utf8')
  if (lead.businessIntelligence) writeFileSync(join(folder, 'business-intelligence.json'), JSON.stringify(lead.businessIntelligence, null, 2), 'utf8')
  writeFileSync(join(folder, 'audit.json'), JSON.stringify(auditData, null, 2), 'utf8')
  if (lead.opportunityScore != null) {
    writeFileSync(join(folder, 'analysis-v1.md'), `# Analysis — ${lead.company}\n\n- Opportunity score: ${lead.opportunityScore}/100\n- Confidence: ${lead.confidence}/100\n- Source: ${lead.analysisSource || 'Not recorded'}\n- Status: ${lead.researchStatus}\n\n${lead.notes || lead.issueDetail || 'No manual analysis note recorded.'}\n`, 'utf8')
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
  return {
    id: row.id, runId: row.run_id, leadId: row.lead_id, type: row.type, status: row.status,
    progress: row.progress, attempts: row.attempts, maxAttempts: row.max_attempts,
    payload: JSON.parse(row.payload || '{}'), result: row.result ? JSON.parse(row.result) : null,
    error: row.error, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function readJob(id) { return parseJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) }

function queueJob({ type, runId = null, leadId = null, payload = {}, maxAttempts = 1 }) {
  const id = `job-${randomUUID()}`
  const createdAt = nowIso()
  db.prepare('INSERT INTO jobs (id, run_id, lead_id, type, status, progress, attempts, max_attempts, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)')
    .run(id, runId, leadId, type, 'Queued', maxAttempts, JSON.stringify(payload), createdAt, createdAt)
  recordEvent('job', id, 'queued', { type, runId, leadId })
  return readJob(id)
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
  const terminal = jobs.filter((job) => ['Completed', 'Failed', 'Cancelled'].includes(job.status)).length
  const averageProgress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + Number(job.progress || 0), 0) / jobs.length) : 100
  const completed = jobs.length > 0 && terminal === jobs.length
  const status = run.status === 'Cancelled' ? 'Cancelled' : run.status === 'Paused' ? 'Paused' : completed ? 'Completed' : 'Running'
  const updated = {
    ...run,
    status,
    progress: completed ? 100 : averageProgress,
    crawled: audits.filter((job) => ['Completed', 'Failed'].includes(job.status)).length,
    audited: audits.filter((job) => job.status === 'Completed').length,
    failed: jobs.filter((job) => job.status === 'Failed').length,
    datasets: audits.filter((job) => job.status === 'Completed').length,
    duration: completed ? formatDuration(run.startedAt || run.createdAt, run.completedAt || nowIso()) : status,
    completedAt: completed ? (run.completedAt || nowIso()) : null,
  }
  saveRun(updated)
  if (completed && run.status !== 'Completed') recordEvent('run', runId, 'completed', { audited: updated.audited, failed: updated.failed })
  return updated
}

function importedLead(row, index = 0, source = 'CSV import') {
  const rating = Number(row.rating || 0)
  const reviews = Number(row.reviews || row.review_count || 0)
  const score = Math.max(35, Math.min(95, Math.round(42 + rating * 6 + Math.log10(Math.max(reviews, 1)) * 8)))
  const lead = {
    id: `lead-${Date.now().toString(36)}-${index}-${randomUUID().slice(0, 6)}`,
    company: String(row.company || row.name || row.business || '').trim(),
    website: String(row.website || row.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
    category: row.category || 'Uncategorized', location: row.location || row.address || 'Unknown', address: row.address || row.location || 'Not collected',
    phone: row.phone || 'Not collected', email: row.email || 'Not collected', rating, reviews,
    sourceUrl: row.sourceUrl || null, prelimScore: score, opportunityScore: null, confidence: null,
    researchStatus: 'Collected', salesStage: null, mainIssue: 'Audit pending',
    issueDetail: 'Business data was saved; website evidence has not been collected yet.',
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
  return row.businessIntelligence || hasCsvIntelligence ? enrichLead(lead, row.businessIntelligence || csvIntelligence) : lead
}

function insertUniqueLead(row, index, source, { runId = null, at = nowIso() } = {}) {
  const lead = importedLead(row, index, source)
  if (!lead.company || !lead.website) return null
  const domain = lead.website.toLowerCase().replace(/\/$/, '')
  const duplicate = readRows('leads').find((item) => String(item.website || '').toLowerCase().replace(/\/$/, '') === domain)
  if (duplicate) {
    const touched = touchLeadRun(duplicate, { runId, source, relationship: 'matched', at })
    const enriched = lead.businessIntelligence ? enrichLead({
      ...touched,
      phone: duplicate.phone === 'Not collected' && lead.phone !== 'Not collected' ? lead.phone : duplicate.phone,
      email: duplicate.email === 'Not collected' && lead.email !== 'Not collected' ? lead.email : duplicate.email,
    }, lead.businessIntelligence) : duplicate
    const next = runId ? touchLeadRun(enriched, { runId, source, relationship: 'matched', at }) : enriched
    if (next !== duplicate) saveLead(next)
    Object.defineProperty(next, '_runImport', { value: { created: false, relationship: 'matched' }, enumerable: false })
    return next
  }
  const created = touchLeadRun(lead, { runId, source, relationship: 'new', at })
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run(created.id, JSON.stringify(created))
  writeLeadArtifacts(created)
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

backfillRunProvenance()

const manualActionLabels = {
  refresh: 'Refresh business data',
  audit: 'Run website audit',
  muse: 'Run Muse analysis',
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
    ...(payload.manualAction ? { manualRun: manualRunState(lead, payload.manualAction, { reset: !payload.continueRun, status: 'Queued', progress: payload.manualAction === 'full' ? 72 : 0, phase: 'Muse analysis queued', jobId: job.id }) } : {}),
    updated: 'Muse synthesis queued',
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
    onProgress: ({ progress, phase }) => {
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
  const current = readLead(job.leadId)
  const history = [...(current.auditHistory || []), {
    jobId: job.id, at: result.auditedAt, url: result.auditedUrl, score: result.opportunityScore,
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
  const updated = saveLead(enrichLead({
    ...current,
    ...result,
    prelimScore: result.opportunityScore,
    auditVersion: (current.auditVersion || 0) + 1,
    researchFailure: null,
    lastAuditAttempt: attempt,
    lastSuccessfulAudit,
    researchJob: { id: job.id, status: 'Completed', progress: 100 },
    ...(manualAction ? { manualRun: manualRunState(current, manualAction, manualAction === 'full'
      ? { status: 'Running', progress: 70, phase: inconclusive ? 'Capture inconclusive — review needed' : 'Website audit complete', jobId: job.id }
      : { status: 'Completed', progress: 100, phase: inconclusive ? 'Capture inconclusive — review needed' : 'Website audit complete', jobId: job.id, completedAt: nowIso() }) } : {}),
    auditHistory: history,
    updated: 'Just now',
  }))
  if (_lighthouseReport) {
    const folder = join(dataDir, 'leads', lead.id)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'lighthouse.json'), JSON.stringify(_lighthouseReport, null, 2), 'utf8')
  }
  updateJob(job.id, { status: 'Completed', progress: 100, result: { opportunityScore: result.opportunityScore, confidence: result.confidence, auditedUrl: result.auditedUrl }, error: null })
  recordEvent('lead', lead.id, 'audit_completed', { jobId: job.id, score: result.opportunityScore, source: result.analysisSource })
  if (['analysis', 'full'].includes(job.payload.workflow) && getOutreachConfig().configured && result.opportunityScore != null) return queueMuseSynthesis(updated, { auditJobId: job.id, researchRunId: job.runId || null, workflow: job.payload.workflow, manualAction, continueRun: Boolean(manualAction) }).lead
  if (manualAction === 'full') return saveLead({ ...updated, manualRun: manualRunState(updated, 'full', { status: 'Failed', progress: 70, phase: 'Muse is not configured', error: 'Muse is not configured', completedAt: nowIso() }) })
  return updated
}

async function generateAndSaveOutreach(lead, { manualAction = null } = {}) {
  const generated = await generateOutreach(lead)
  // A failed model call throws before any save, so previous drafts survive and
  // the caller surfaces retry/manual editing.
  const applied = applyOutreachGeneration(lead, generated, { selectedVersion: lead.outreachVersion })
  const updated = saveLead({
    ...lead,
    ...applied,
    ...(manualAction ? { manualRun: manualRunState(lead, manualAction, { status: 'Completed', progress: 100, phase: generated.insufficientEvidence ? 'Insufficient evidence for outreach' : 'Outreach drafts ready', completedAt: nowIso() }) } : {}),
    updated: 'Just now',
  })
  recordEvent('lead', lead.id, 'outreach_generated', { source: generated.generation.source, model: generated.generation.model, manualAction, insufficientEvidence: Boolean(generated.insufficientEvidence), preservedEdits: Boolean(applied.outreachUpdateAvailable && !generated.insufficientEvidence) })
  return updated
}

async function runSynthesisJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw new Error('Lead not found')
  if (lead.opportunityScore == null) throw new Error('A completed website audit is required before Muse synthesis')
  const manualAction = job.payload.manualAction || null
  saveLead({
    ...lead,
    museAnalysis: { ...(lead.museAnalysis || {}), status: 'Running', error: null },
    museJob: { id: job.id, status: 'Running', progress: 20, phase: 'Reading saved evidence' },
    ...(manualAction ? { manualRun: manualRunState(lead, manualAction, { status: 'Running', progress: manualAction === 'full' ? 76 : 20, phase: 'Reading saved evidence', jobId: job.id }) } : {}),
    updated: 'Muse is analyzing evidence',
  })
  updateJob(job.id, { progress: 20 })
  let lighthouseReport = null
  const lighthousePath = join(dataDir, 'leads', lead.id, 'lighthouse.json')
  if (existsSync(lighthousePath)) {
    try { lighthouseReport = JSON.parse(readFileSync(lighthousePath, 'utf8')) } catch { /* The saved summary remains sufficient if the full report is unreadable. */ }
  }
  updateJob(job.id, { progress: 45 })
  const activeLead = readLead(job.leadId)
  if (activeLead) saveLead({
    ...activeLead,
    museJob: { id: job.id, status: 'Running', progress: 45, phase: 'Synthesizing with Muse' },
    ...(manualAction ? { manualRun: manualRunState(activeLead, manualAction, { status: 'Running', progress: manualAction === 'full' ? 84 : 45, phase: 'Synthesizing with Muse', jobId: job.id }) } : {}),
    updated: 'Muse is synthesizing findings',
  })
  const result = await generateMuseAnalysis(readLead(job.leadId), { lighthouseReport })
  const current = readLead(job.leadId)
  const updated = saveLead({
    ...current,
    museAnalysis: { status: 'Completed', ...result, error: null },
    museJob: { id: job.id, status: 'Completed', progress: 100, phase: 'Synthesis complete' },
    ...(manualAction ? { manualRun: manualRunState(current, manualAction, manualAction === 'full'
      ? { status: 'Running', progress: 92, phase: 'Generating outreach drafts', jobId: job.id }
      : { status: 'Completed', progress: 100, phase: 'Muse analysis complete', jobId: job.id, completedAt: nowIso() }) } : {}),
    updated: 'Just now',
  })
  updateJob(job.id, {
    status: 'Completed', progress: 100, error: null,
    result: { recommendation: result.qualificationRecommendation, opportunities: result.topOpportunities.length, model: result.generation.model },
  })
  recordEvent('lead', lead.id, 'muse_synthesis_completed', { jobId: job.id, recommendation: result.qualificationRecommendation, model: result.generation.model })
  if (job.payload.workflow === 'full') return generateAndSaveOutreach(updated, { manualAction: 'full' })
  return updated
}

async function runRefreshJob(job) {
  const lead = readLead(job.leadId)
  if (!lead) throw new Error('Lead not found')
  const manualAction = job.payload.manualAction || 'refresh'
  const settings = readSettings()
  if (!job.payload.snapshotId) {
    const started = await triggerRecordRefresh({ url: lead.sourceUrl, settings })
    updateJob(job.id, { status: 'Waiting', progress: 8, payload: { ...job.payload, ...started }, nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    saveLead({
      ...lead,
      refreshJob: { id: job.id, status: 'Waiting', progress: 8, phase: 'Bright Data is refreshing the record' },
      manualRun: manualRunState(lead, manualAction, { status: 'Waiting', progress: manualAction === 'full' ? 5 : 8, phase: 'Bright Data is refreshing the record', jobId: job.id }),
      updated: 'Refreshing business data',
    })
    return
  }
  const progress = await pollDiscovery(job.payload.snapshotId, settings)
  if (progress.status === 'failed') throw new Error('Bright Data business refresh failed')
  if (!['ready', 'completed'].includes(progress.status)) {
    updateJob(job.id, { status: 'Waiting', progress: Math.max(10, job.progress), nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    const current = readLead(job.leadId)
    if (current) saveLead({ ...current, refreshJob: { id: job.id, status: 'Waiting', progress: 10, phase: 'Waiting for Bright Data' }, manualRun: manualRunState(current, manualAction, { status: 'Waiting', progress: manualAction === 'full' ? 8 : 10, phase: 'Waiting for Bright Data', jobId: job.id }) })
    return
  }
  const records = await downloadDiscovery(job.payload.snapshotId, settings)
  const fresh = records.map((record) => mapDiscoveryRecord(record, lead.category, lead.location)).find(Boolean)
  if (!fresh) throw new Error('Bright Data returned no usable business record for this client')
  let updated = saveLead(enrichLead({
    ...lead,
    phone: fresh.phone !== 'Not collected' ? fresh.phone : lead.phone,
    email: fresh.email !== 'Not collected' ? fresh.email : lead.email,
    location: fresh.location !== 'Unknown' ? fresh.location : lead.location,
    rating: fresh.rating || lead.rating,
    reviews: fresh.reviews || lead.reviews,
    refreshJob: { id: job.id, status: 'Completed', progress: 100, phase: 'Business data refreshed' },
    manualRun: manualRunState(lead, manualAction, manualAction === 'full'
      ? { status: 'Running', progress: 18, phase: 'Business data refreshed', jobId: job.id }
      : { status: 'Completed', progress: 100, phase: 'Business data refreshed', jobId: job.id, completedAt: nowIso() }),
    updated: 'Just now',
  }, fresh.businessIntelligence))
  updateJob(job.id, { status: 'Completed', progress: 100, result: { snapshotId: job.payload.snapshotId, source: fresh.businessIntelligence?.source }, error: null })
  recordEvent('lead', lead.id, 'business_refresh_completed', { jobId: job.id, snapshotId: job.payload.snapshotId })
  if (manualAction === 'full') updated = queueAuditForLead(updated, { workflow: 'full', manualAction: 'full', continueRun: true }).lead
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
    updateJob(job.id, { status: 'Waiting', progress: 10, payload: { ...job.payload, ...started }, nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    saveRun({ ...run, searchDefinition: search, providerSnapshotId: started.snapshotId, submittedGeography: started.submittedGeography, progress: 10, duration: 'Waiting for discovery' })
    recordEvent('run', run.id, 'discovery_started', { snapshotId: started.snapshotId, submittedGeography: started.submittedGeography })
    return
  }
  const progress = await pollDiscovery(job.payload.snapshotId, settings)
  if (progress.status === 'failed') throw new Error('Bright Data discovery failed')
  if (!['ready', 'completed'].includes(progress.status)) {
    updateJob(job.id, { status: 'Waiting', progress: Math.max(12, job.progress), nextAttemptAt: new Date(Date.now() + 10_000).toISOString() })
    return
  }
  const records = await downloadDiscovery(job.payload.snapshotId, settings)
  const limit = Math.max(1, Number(run.limit || 25))
  const reconciled = reconcileRecords(records, { fallbackCategory: 'Unknown', fallbackLocation: search.displayLocation, limit })
  const leads = reconciled.retained.map((record, index) => insertUniqueLead(record, index, 'Bright Data Google Maps', { runId: run.id })).filter(Boolean)
  const uniqueLeads = [...new Map(leads.map((lead) => [lead.id, lead])).values()]
  const newClientIds = [...new Set(uniqueLeads.filter((lead) => lead._runImport?.created).map((lead) => lead.id))]
  const matchedClientIds = [...new Set(uniqueLeads.filter((lead) => !lead._runImport?.created).map((lead) => lead.id))]
  uniqueLeads.slice(0, Math.max(1, Number(run.deepAuditLimit || 10))).forEach((lead) => queueJob({ type: 'audit', runId: run.id, leadId: lead.id, payload: { respectRobots: settings.respectRobots, workflow: 'analysis' }, maxAttempts: 2 }))
  const geography = describeGeographyCoverage(search, reconciled.retained)
  saveRun({ ...readRun(run.id), searchDefinition: search, discovered: uniqueLeads.length, newClients: newClientIds.length, matchedClients: matchedClientIds.length, clientIds: uniqueLeads.map((lead) => lead.id), newClientIds, matchedClientIds, providerSnapshotId: job.payload.snapshotId, duration: 'Auditing discovered websites',
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

let workerBusy = false
async function processNextJob() {
  if (workerBusy) return
  const rows = db.prepare("SELECT * FROM jobs WHERE (status = 'Queued' OR status = 'Waiting') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT 20").all(nowIso())
  const row = rows.find((candidate) => {
    if (!candidate.run_id) return true
    const run = readRun(candidate.run_id)
    return run && !['Paused', 'Cancelled'].includes(run.status)
  })
  if (!row) return
  workerBusy = true
  const job = parseJob(row)
  const attempt = job.attempts + (job.status === 'Queued' ? 1 : 0)
  updateJob(job.id, { status: 'Running', attempts: attempt, error: null, nextAttemptAt: null })
  try {
    if (job.type === 'audit') await runAuditJob({ ...job, attempts: attempt })
    else if (job.type === 'synthesize') await runSynthesisJob({ ...job, attempts: attempt })
    else if (job.type === 'discover') await runDiscoveryJob({ ...job, attempts: attempt })
    else if (job.type === 'refresh') await runRefreshJob({ ...job, attempts: attempt })
    else throw new Error(`Unsupported job type: ${job.type}`)
  } catch (error) {
    const current = readJob(job.id)
    const retry = current.attempts < current.maxAttempts
    updateJob(job.id, {
      status: retry ? 'Queued' : 'Failed',
      progress: retry ? Math.max(5, current.progress) : 100,
      error: error.message,
      nextAttemptAt: retry ? new Date(Date.now() + 2_000).toISOString() : null,
    })
    if (job.type === 'audit') {
      const lead = readLead(job.leadId)
      if (lead) saveLead({
        ...lead,
        researchStatus: retry ? 'Queued' : 'Failed',
        researchFailure: retry ? null : { stage: 1, reason: error.message, code: error.code || 'AUDIT_FAILED', at: nowIso(), jobId: job.id },
        lastAuditAttempt: retry ? lead.lastAuditAttempt || null : { jobId: job.id, at: nowIso(), url: lead.website || null, status: 'Failed', reason: error.message, captureQuality: null },
        researchJob: { id: job.id, status: retry ? 'Queued' : 'Failed', progress: retry ? 5 : 100 },
        updated: retry ? 'Retrying soon' : 'Just now',
      })
    }
    if (job.type === 'synthesize') {
      const lead = readLead(job.leadId)
      if (lead) saveLead({
        ...lead,
        museAnalysis: { ...(lead.museAnalysis || {}), status: retry ? 'Queued' : 'Failed', error: retry ? null : error.message },
        museJob: { id: job.id, status: retry ? 'Queued' : 'Failed', progress: retry ? Math.max(5, current.progress) : 100, phase: retry ? 'Retrying soon' : 'Synthesis failed' },
        updated: retry ? 'Muse retrying soon' : 'Muse synthesis failed',
      })
    }
    if (job.type === 'refresh') {
      const lead = readLead(job.leadId)
      if (lead) saveLead({
        ...lead,
        refreshJob: { id: job.id, status: retry ? 'Queued' : 'Failed', progress: retry ? Math.max(5, current.progress) : 100, phase: retry ? 'Retrying soon' : 'Business refresh failed' },
        updated: retry ? 'Business refresh retrying soon' : 'Business refresh failed',
      })
    }
    if (job.payload.manualAction) {
      const lead = readLead(job.leadId)
      if (lead) saveLead({
        ...lead,
        manualRun: manualRunState(lead, job.payload.manualAction, {
          status: retry ? 'Queued' : 'Failed',
          progress: retry ? Math.max(5, current.progress) : 100,
          phase: retry ? 'Retrying soon' : error.message,
          jobId: job.id,
          error: retry ? null : error.message,
          completedAt: retry ? null : nowIso(),
        }),
      })
    }
    if (!retry) recordEvent(job.leadId ? 'lead' : 'run', job.leadId || job.runId, `${job.type}_failed`, { jobId: job.id, error: error.message })
  } finally {
    if (job.runId) syncRun(job.runId)
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
  if ('blockPrivateNetworks' in body && typeof body.blockPrivateNetworks !== 'boolean') push('blockPrivateNetworks', 'Must be a boolean')
  if ('discoveryCountry' in body && !isStringWithLength(body.discoveryCountry, 2, 3)) push('discoveryCountry', 'Must be 2-3 character country code')
  if ('discoveryLatitude' in body) { const n = Number(body.discoveryLatitude); if (!Number.isFinite(n) || n < -90 || n > 90) push('discoveryLatitude', 'Must be a number -90 to 90') }
  if ('discoveryLongitude' in body) { const n = Number(body.discoveryLongitude); if (!Number.isFinite(n) || n < -180 || n > 180) push('discoveryLongitude', 'Must be a number -180 to 180') }
  if ('discoveryZoom' in body) { const n = clampInt(body.discoveryZoom, 12, 16); if (n == null) push('discoveryZoom', 'Must be an integer 12-16') }
  if (vdetails.length) return badRequest(res, null, 'Invalid settings values', vdetails)

  // cross-field: deepAuditLimit should not exceed resultLimit if both present
  if ('deepAuditLimit' in body && 'resultLimit' in body) {
    if (Number(body.deepAuditLimit) > Number(body.resultLimit)) return badRequest(res, 'deepAuditLimit', 'deepAuditLimit must be <= resultLimit', [{ field: 'deepAuditLimit', message: 'Must be <= resultLimit' }])
  }

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  db.transaction((entries) => entries.forEach(([key, value]) => { if (ALLOWED_SETTINGS_KEYS.has(key)) upsert.run(key, JSON.stringify(value)) }))(Object.entries(body))
  res.json(readSettings())
})

app.post('/api/leads', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, null, 'Request body must be a JSON object')
  const company = String(body.company || '').trim()
  if (!isStringWithLength(company, 2, 120)) return badRequest(res, 'company', 'Company is required and must be 2-120 characters', [{ field: 'company', message: 'Must be 2-120 characters' }])
  const rawWebsite = String(body.website || '').trim()
  if (!rawWebsite) return badRequest(res, 'website', 'Website is required', [{ field: 'website', message: 'Website is required (3-253 chars, domain-like)' }])
  const website = normalizeDomainInput(rawWebsite)
  if (!isStringWithLength(website, 3, 253) || !isValidDomain(website)) return badRequest(res, 'website', 'Website must be a valid domain (e.g. example.com)', [{ field: 'website', message: 'Must be 3-253 chars, domain-like with a TLD' }])
  if (body.phone != null && String(body.phone).trim() && String(body.phone).trim() !== 'Not collected' && !isPhoneLike(String(body.phone))) return badRequest(res, 'phone', 'Phone number format is invalid', [{ field: 'phone', message: 'Must be 7-30 chars, digits, spaces, +, -, (), .' }])
  if (body.email != null && String(body.email).trim() && String(body.email).trim() !== 'Not collected' && !isEmail(String(body.email))) return badRequest(res, 'email', 'Email format is invalid', [{ field: 'email', message: 'Must be a valid email address' }])
  const websiteLower = website.toLowerCase()
  if (readRows('leads').some((lead) => String(lead.website || '').toLowerCase() === websiteLower)) {
    return conflict(res, 'A client with this website already exists', 'website', 'DUPLICATE_WEBSITE')
  }
  if (readRows('leads').some((lead) => String(lead.company || '').trim().toLowerCase() === company.toLowerCase())) {
    return conflict(res, 'A client with this company name already exists', 'company', 'DUPLICATE_COMPANY')
  }
  const lead = importedLead({ ...body, company, website }, 0, 'Manual entry')
  db.prepare('INSERT INTO leads (id, payload) VALUES (?, ?)').run(lead.id, JSON.stringify(lead))
  writeLeadArtifacts(lead)
  recordEvent('lead', lead.id, 'created', { source: 'Manual entry' })
  res.status(201).json(lead)
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
    const w = normalizeDomainInput(String(row.website || row.domain || ''))
    if (!isStringWithLength(c, 2, 120)) rowErrors.push({ field: `rows[${idx}].company`, message: 'Company must be 2-120 chars' })
    if (!isStringWithLength(w, 3, 253) || !isValidDomain(w)) rowErrors.push({ field: `rows[${idx}].website`, message: 'Website must be 3-253 chars domain-like' })
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
    const website = normalizeDomainInput(String(row.website || row.domain || ''))
    if (!isStringWithLength(company, 2, 120) || !isStringWithLength(website, 3, 253) || !isValidDomain(website) || existingDomains.has(website.toLowerCase()) || seenInBatch.has(website.toLowerCase())) { skipped += 1; return }
    if (row.phone != null && String(row.phone).trim() && String(row.phone).trim() !== 'Not collected' && !isPhoneLike(String(row.phone))) { skipped += 1; return }
    if (row.email != null && String(row.email).trim() && String(row.email).trim() !== 'Not collected' && !isEmail(String(row.email))) { skipped += 1; return }
    const lead = insertUniqueLead({ ...row, company, website }, index, 'CSV import')
    if (!lead) { skipped += 1; return }
    existingDomains.add(website.toLowerCase())
    seenInBatch.add(website.toLowerCase())
    created.push(lead)
  })
  res.status(201).json({ imported: created.length, skipped, leads: created, ...(rowErrors.length ? { rowErrors: rowErrors.slice(0, 20) } : {}) })
})

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
  if (details.length) return badRequest(res, null, 'Invalid lead patch values', details)

  const patched = applyLeadWorkflowChanges(lead, body)
  const draftEdited = ('outreachDraft' in body && String(body.outreachDraft || '') !== String(lead.outreachDraft || '')) ||
    ('outreachDrafts' in body && JSON.stringify(body.outreachDrafts || {}) !== JSON.stringify(lead.outreachDrafts || {})) ||
    ('outreachSubject' in body && String(body.outreachSubject || '') !== String(lead.outreachSubject || ''))
  const updated = saveLead({ ...patched, ...(draftEdited ? { outreachEdited: true } : {}), updated: 'Just now' })
  recordEvent('lead', lead.id, 'updated', { fields: Object.keys(body), draftEdited })
  res.json(updated)
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
      applied = dismissOutreachCandidates(lead)
    }
    const updated = saveLead({ ...lead, ...applied, updated: 'Just now' })
    recordEvent('lead', lead.id, action === 'accept' ? 'outreach_candidate_accepted' : 'outreach_candidates_dismissed', { index: body.index ?? null })
    res.json(updated)
  } catch (error) {
    return unprocessable(res, error.message, 'outreachCandidates')
  }
})

app.post('/api/leads/:id/analyze', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  if (req.body && Object.keys(req.body).length > 20) return payloadTooLarge(res, 'Request body too large')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (!lead.website || !isValidDomain(normalizeDomainInput(lead.website))) return unprocessable(res, 'Lead has no valid website to audit', 'website')
  res.status(202).json(queueAuditForLead(lead, { workflow: 'audit' }))
})

app.post('/api/leads/:id/muse/analyze', (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before running Muse', 'opportunityScore', 'AUDIT_REQUIRED')
  if (!getOutreachConfig().configured) return serviceUnavailable(res, 'Muse is not configured', 'MUSE_NOT_CONFIGURED')
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
      if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before running Muse', 'opportunityScore', 'AUDIT_REQUIRED')
      if (!getOutreachConfig().configured) return serviceUnavailable(res, 'Muse is not configured', 'MUSE_NOT_CONFIGURED')
      return res.status(202).json({ ...queueMuseSynthesis(lead, { requestedManually: true, manualAction: 'muse' }), message: 'Muse analysis queued' })
    }
    if (action === 'outreach') {
      if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before generating outreach', 'opportunityScore', 'AUDIT_REQUIRED')
      const started = saveLead({ ...lead, manualRun: manualRunState(lead, 'outreach', { reset: true, status: 'Running', progress: 25, phase: 'Generating three outreach drafts' }), updated: 'Generating outreach' })
      const updated = await generateAndSaveOutreach(started, { manualAction: 'outreach' })
      return res.json({ lead: updated, job: null, message: 'Three outreach drafts generated' })
    }
    if (action === 'full') {
      if (!getOutreachConfig().configured) return serviceUnavailable(res, 'Muse must be configured before running the full workflow', 'MUSE_NOT_CONFIGURED')
      const brightData = getBrightDataConfig(readSettings())
      const queued = brightData.ready && lead.sourceUrl
        ? queueRefreshForLead(lead, { manualAction: 'full' })
        : queueAuditForLead(lead, { workflow: 'full', manualAction: 'full' })
      return res.status(202).json({ ...queued, message: brightData.ready && lead.sourceUrl ? 'Full workflow queued from business refresh' : 'Full workflow queued from website audit' })
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

app.post('/api/leads/:id/outreach/generate', async (req, res) => {
  if (!validateIdParam(req.params.id)) return badRequest(res, 'id', 'Invalid lead id format')
  const lead = readLead(req.params.id)
  if (!lead) return notFound(res, 'Lead not found', 'id')
  if (lead.opportunityScore == null) return conflict(res, 'Complete the website audit before generating outreach', 'opportunityScore', 'AUDIT_REQUIRED')
  try {
    res.json(await generateAndSaveOutreach(lead))
  } catch (error) {
    recordEvent('lead', lead.id, 'outreach_generation_failed', { error: error.message })
    res.status(502).json({ error: `Could not generate outreach: ${error.message}` })
  }
})

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

  const now = new Date()
  const id = `run-${now.getTime().toString(36)}`
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
    return badRequest(res, 'location', error.message, [{ field: 'location', message: error.message }])
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
    limit, deepAuditLimit, options: (body.options && typeof body.options === 'object' && !Array.isArray(body.options)) ? body.options : {},
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
  res.status(201).json(decorateRun(syncRun(id) || readRun(id)))
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
