import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function sha256Hex(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
}

// Atomic file write: crash mid-write leaves the temp file, never a truncated
// advertised artifact.
export function writeFileAtomic(dir, name, content) {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, target)
  return target
}

export function auditIdForJob(jobId) {
  return `audit-${String(jobId || 'manual').replace(/[^a-z0-9-_:.]/gi, '-').slice(0, 80)}`
}

// Immutable manifest for one audit attempt: links every output to content
// hashes under a single version. Written LAST so a crash can never advertise
// incomplete artifacts as complete.
export function buildAuditManifest({ auditId, auditVersion, result, lighthouseReport, files }) {
  const canonicalScores = JSON.stringify({
    score: result.opportunityScore ?? null,
    confidence: result.confidence ?? null,
    problems: result.problems || [],
    evidence: result.evidence || [],
  })
  return {
    auditId,
    auditVersion,
    status: result.researchStatus === 'Inconclusive' ? 'inconclusive' : 'complete',
    researchStatus: result.researchStatus || null,
    auditedAt: result.auditedAt || null,
    auditedUrl: result.auditedUrl || null,
    createdAt: new Date().toISOString(),
    artifacts: {
      auditJson: files.auditJson,
      lighthouseJson: lighthouseReport ? files.lighthouseJson : { missing: true, reason: 'No Lighthouse report for this attempt; missing stays missing, never backfilled from an older audit.' },
    },
    contentHashes: {
      scores: sha256Hex(canonicalScores),
      lighthouse: lighthouseReport ? sha256Hex(JSON.stringify(lighthouseReport)) : null,
    },
    failure: null,
  }
}

export function leadAuditsDir(dataDir, leadId) {
  return join(dataDir, 'leads', leadId, 'audits')
}

// Persists one attempt: versioned files, then the manifest, and returns the
// manifest plus the DB pointer value the caller must store with the result.
// Throws before any manifest exists when persistence fails, so the caller can
// record an explicit attempt failure instead of a false completion.
export function saveAuditArtifacts({ dataDir, leadId, auditId, auditVersion, auditData, lighthouseReport }) {
  const dir = join(leadAuditsDir(dataDir, leadId), auditId)
  const auditContent = JSON.stringify(auditData, null, 2)
  const files = {
    auditJson: { path: `audits/${auditId}/audit.json`, sha256: sha256Hex(auditContent), bytes: Buffer.byteLength(auditContent) },
  }
  writeFileAtomic(dir, 'audit.json', auditContent)
  if (lighthouseReport) {
    const lighthouseContent = JSON.stringify(lighthouseReport)
    files.lighthouseJson = { path: `audits/${auditId}/lighthouse.json`, sha256: sha256Hex(lighthouseContent), bytes: Buffer.byteLength(lighthouseContent) }
    writeFileAtomic(dir, 'lighthouse.json', lighthouseContent)
  }
  const manifest = buildAuditManifest({
    auditId, auditVersion,
    result: auditData, lighthouseReport,
    files,
  })
  writeFileAtomic(dir, 'manifest.json', JSON.stringify(manifest, null, 2))
  return { manifest, dir }
}

export function readManifest(dataDir, leadId, auditId) {
  const path = join(leadAuditsDir(dataDir, leadId), auditId, 'manifest.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { auditId, corrupt: true }
  }
}

export function listAuditManifests(dataDir, leadId) {
  const root = leadAuditsDir(dataDir, leadId)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifest(dataDir, leadId, entry.name))
    .filter(Boolean)
    .sort((a, b) => (b.auditVersion || 0) - (a.auditVersion || 0))
}

// Resolve exactly which audit synthesis, drafts and export must read. Missing
// artifacts stay missing; a prior attempt's files are never substituted
// without an explicit historical label.
export function loadAuditForSynthesis({ dataDir, lead, rootFallback = true } = {}) {
  const attempted = []
  const explicitId = lead?.currentAuditId || null
  if (explicitId) {
    const manifest = readManifest(dataDir, lead.id, explicitId)
    if (!manifest) {
      throw new Error(`Audit artifacts for ${explicitId} are incomplete or missing; re-run the audit instead of trusting a partial result.`)
    }
    if (manifest.corrupt) {
      throw new Error(`Audit manifest for ${explicitId} is unreadable; re-run the audit instead of trusting a partial result.`)
    }
    attempted.push({ manifest, provenance: 'current' })
  } else {
    const manifests = listAuditManifests(dataDir, lead.id)
    if (manifests.length) attempted.push({ manifest: manifests[0], provenance: 'latest-versioned' })
  }
  if (attempted.length) {
    const { manifest, provenance } = attempted[0]
    const dir = join(leadAuditsDir(dataDir, lead.id), manifest.auditId)
    const auditPath = join(dir, 'audit.json')
    if (!existsSync(auditPath)) {
      throw new Error(`Audit file for ${manifest.auditId} is missing; re-run the audit instead of trusting a partial result.`)
    }
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
    let lighthouseReport = null
    if (manifest.artifacts?.lighthouseJson && !manifest.artifacts.lighthouseJson.missing) {
      const lighthousePath = join(dir, 'lighthouse.json')
      if (existsSync(lighthousePath)) lighthouseReport = JSON.parse(readFileSync(lighthousePath, 'utf8'))
    }
    return { audit, lighthouseReport, manifest, provenance, historical: provenance !== 'current' }
  }
  if (rootFallback) {
    // Legacy records predate versioned audits: load the old stable-path files
    // with provenance explicitly unknown instead of refusing to open history.
    const folder = join(dataDir, 'leads', lead.id)
    const legacyAuditPath = join(folder, 'audit.json')
    const legacyLighthousePath = join(folder, 'lighthouse.json')
    const legacyAudit = existsSync(legacyAuditPath) ? JSON.parse(readFileSync(legacyAuditPath, 'utf8')) : null
    let legacyLighthouse = null
    try {
      if (existsSync(legacyLighthousePath)) legacyLighthouse = JSON.parse(readFileSync(legacyLighthousePath, 'utf8'))
    } catch { legacyLighthouse = null }
    if (legacyAudit || legacyLighthouse) {
      return { audit: legacyAudit, lighthouseReport: legacyLighthouse, manifest: null, provenance: 'legacy-unversioned', historical: true }
    }
  }
  throw new Error('No audit artifacts exist for this client yet; run an audit first.')
}

// Shared report model for the saved internal report and the export: findings
// first, reviewer notes as a labelled section that never replaces evidence,
// staleness and artifact identity always visible.
export function buildLeadReport(lead, { manifest = null } = {}) {
  const list = (items = []) => items.length ? items.map((item) => `- ${item}`).join('\n') : '- None recorded'
  const muse = lead.museAnalysis?.status === 'Completed'
    ? { recommendation: lead.museAnalysis.qualificationRecommendation, stale: Boolean(lead.museAnalysis.stale) }
    : null
  return {
    company: lead.company,
    audit: {
      id: manifest?.auditId || lead.currentAuditId || null,
      version: manifest?.auditVersion ?? null,
      status: manifest?.status || lead.researchStatus || null,
      auditedAt: manifest?.auditedAt || lead.auditedAt || null,
      auditedUrl: manifest?.auditedUrl || lead.auditedUrl || null,
      provenance: manifest ? 'versioned' : 'legacy-unversioned',
    },
    assessment: {
      opportunityScore: lead.opportunityScore ?? null,
      confidence: lead.confidence ?? null,
      source: lead.analysisSource || 'Not recorded',
      researchStatus: lead.researchStatus,
    },
    museStale: muse?.stale || false,
    outreachStale: Boolean(lead.outreachStale),
    notes: lead.notes || null,
  }
}

export function renderLeadReportMarkdown(lead, { manifest = null } = {}) {
  const model = buildLeadReport(lead, { manifest })
  const list = (items = []) => items.length ? items.map((item) => `- ${item}`).join('\n') : '- None recorded'
  const lines = [
    `# ${lead.company}`,
    '',
    `## Audit version`,
    '',
    `- Audit ID: ${model.audit.id || 'legacy (unversioned)'}`,
    `- Status: ${model.audit.status || lead.researchStatus}`,
    `- Audited: ${model.audit.auditedAt || 'Not recorded'}`,
    `- Provenance: ${model.audit.provenance}`,
    '',
    `## Opportunity assessment`,
    '',
    `- Opportunity score: ${lead.opportunityScore ?? 'Not analyzed'}`,
    `- Confidence: ${lead.confidence ?? 'Not analyzed'}`,
    `- Source: ${lead.analysisSource || 'Not recorded'}`,
    `- Research status: ${lead.researchStatus}`,
    `- Commercial value: ${lead.leadValue ? `${lead.leadValue.leadValueScore}/100 (${lead.leadValue.band}, coverage ${Math.round((lead.leadValue.coverage || 0) * 100)}%, rubric ${lead.leadValue.version})` : 'Not scored'}`,
    `- Website: ${lead.website || 'Not supplied'}${lead.websiteStatus && lead.websiteStatus !== 'supplied' ? ` (${lead.websiteStatus})` : ''}`,
    '',
    `## Website audit`,
    '',
    `- Lighthouse mobile performance: ${lead.performance ?? 'Not measured'}`,
    `- Lighthouse accessibility: ${lead.accessibility ?? 'Not measured'}`,
    `- Lighthouse SEO: ${lead.seo ?? 'Not measured'}`,
    `- Same-site pages crawled: ${lead.pageCount ?? 'Not measured'}`,
    `- Internal links checked: ${lead.checkedLinks ?? 'Not measured'}`,
    `- Broken internal links: ${lead.brokenLinks ?? 'Not measured'}`,
    `- Mobile quality: ${lead.mobileQuality}`,
    `- HTTPS: ${lead.https == null ? 'Not measured' : lead.https ? 'Yes' : 'No'}`,
    `- Detected stack: ${(lead.stack || []).join(', ') || 'Unknown'}`,
    '',
    `## Main observed issue`,
    '',
    `**${lead.mainIssue}:** ${lead.issueDetail}`,
    '',
    `## Findings`,
    '',
    list(lead.problems),
    '',
    `## Evidence`,
    '',
    list(lead.evidence),
    '',
  ]
  if (lead.museAnalysis?.status === 'Completed') {
    lines.push(
      `## AI synthesis (advisory${lead.museAnalysis.stale ? ' — STALE: a newer audit completed after this synthesis' : ''})`,
      '',
      `- Recommendation: ${lead.museAnalysis.qualificationRecommendation}`,
      `- Rationale: ${lead.museAnalysis.qualificationRationale}`,
      `- Model: ${lead.museAnalysis.generation?.model || 'Not recorded'}`,
      `- Generated: ${lead.museAnalysis.generation?.generatedAt || 'Not recorded'}`,
      '',
      String(lead.museAnalysis.summary || ''),
      '',
    )
  }
  if (lead.notes) {
    lines.push(`## Reviewer notes`, '', String(lead.notes), '')
  }
  lines.push(
    `## Safety contract`,
    '',
    `Do not invent revenue, decision-maker names, hosting costs, performance metrics, or unobserved facts. Outreach remains manual and must be reviewed before sending.`,
  )
  return lines.join('\n') + '\n'
}
