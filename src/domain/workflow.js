export const researchStages = [
  { key: 'collected', label: 'Collected', internal: 'Scraped' },
  { key: 'analyzed', label: 'Website analyzed', internal: 'Analyzed' },
  { key: 'ready', label: 'Ready to review', internal: 'Recommended' },
]

export const salesStages = ['Qualified', 'Contacted', 'Replied', 'Meeting', 'Proposal', 'Won']

export const salesStageLabels = {
  Qualified: 'Qualified',
  Contacted: 'Contacted',
  Replied: 'Replied',
  Meeting: 'Meeting',
  Proposal: 'Proposal',
  Won: 'Won',
  Lost: 'Lost',
}

const activeJobStates = ['Queued', 'Running', 'Waiting', 'Analyzing']

export function getResearchState(lead = {}) {
  const analyzed = lead.opportunityScore != null
  const museComplete = lead.museAnalysis?.status === 'Completed' || Boolean(lead.analysisSource)
  // A skipped synthesis (no AI key) is not missing evidence: the deterministic
  // audit stands on its own and manual review is not blocked by it.
  const museSkipped = lead.museAnalysis?.status === 'Skipped'
  const processing = activeJobStates.includes(lead.researchStatus) || activeJobStates.includes(lead.researchJob?.status) || activeJobStates.includes(lead.manualRun?.status)
  const rawStage = Number(lead.researchFailure?.stage)
  const failure = Number.isInteger(rawStage) ? { ...lead.researchFailure, stage: Math.max(0, Math.min(2, rawStage)) } : null
  // Current-job failure is separate from retained evidence: an interrupted
  // attempt leaves a prior opportunityScore untouched, so the saved evidence
  // stays reviewable while the failure stays visible.
  const retainedEvidence = analyzed && Boolean(failure)
  const deterministicReady = analyzed && !failure
  const phase = failure ? failure.stage : museComplete ? 2 : analyzed || processing ? 1 : 0
  const done = [true, analyzed, museComplete]
  return { done, failure, phase, analyzed, museComplete, museSkipped, processing, retainedEvidence, deterministicReady }
}

export function getResearchLabel(lead) {
  const state = getResearchState(lead)
  if (state.failure) return `${researchStages[state.phase].label} failed`
  if (state.processing) return 'In progress'
  return researchStages[state.phase].label
}

export function getMuseGuidance(lead) {
  // Backend enum is Pursue / Review / Pass (advisory only). Pass stays visible
  // as guidance — it never auto-qualifies or auto-rejects the lead.
  const recommendation = lead.museAnalysis?.qualificationRecommendation
  if (recommendation === 'Pursue') return 'Pursue'
  if (recommendation === 'Review') return 'Review manually'
  if (recommendation === 'Pass') return 'Pass'
  return null
}

export function isQualified(lead) {
  return Boolean(lead.qualified || lead.salesStage)
}

export function isOpenPipeline(lead) {
  return Boolean(lead.salesStage && !['Won', 'Lost'].includes(lead.salesStage))
}

export function isContacted(lead) {
  return ['Contacted', 'Replied', 'Meeting', 'Proposal'].includes(lead.salesStage)
}

export function getOutreachState(lead) {
  if (!isQualified(lead) || ['Won', 'Lost'].includes(lead.salesStage)) return 'Not queued'
  if (lead.doNotContact) return 'Suppressed'
  if (isContacted(lead)) return 'Contacted'
  return lead.outreachDraft || Object.keys(lead.outreachDrafts || {}).length ? 'Ready to contact' : 'Needs draft'
}

// Next-action decision table (ROH-25). Evaluated top-down; the first matching
// row wins. Terminal sales states come before any outreach suggestion, and a
// current-job failure never hides retained evidence from an earlier attempt.
const NEXT_ACTION_RULES = [
  ['Won without a contract', (lead) => lead.salesStage === 'Won' && !lead.contract, () => 'Add contract details'],
  ['Won with a contract', (lead) => lead.salesStage === 'Won', (lead) => lead.contract?.nextStep || 'Begin delivery'],
  ['Lost is terminal', (lead) => lead.salesStage === 'Lost', () => 'Review client'],
  ['Failed attempt, saved evidence retained', (lead, research) => research.failure && research.retainedEvidence, () => 'Review saved evidence'],
  ['Failed attempt, no evidence yet', (lead, research) => Boolean(research.failure), () => 'Retry research'],
  ['Do-not-contact suppression', (lead) => Boolean(lead.doNotContact), () => 'Review suppression'],
  ['Research job still active', (lead, research) => research.processing, () => 'Research running'],
  ['No audit yet, no website to audit', (lead, research) => !research.analyzed && !lead.website, () => 'Review business fit'],
  ['No audit yet', (lead, research) => !research.analyzed, () => 'Analyze website'],
  ['Deterministic evidence ready, optional AI skipped', (lead, research) => !research.museComplete && research.museSkipped && !isQualified(lead), () => 'Qualify for outreach'],
  ['Deterministic evidence ready, synthesis pending', (lead, research) => !research.museComplete, () => 'Review research'],
  ['Not qualified yet', (lead) => !isQualified(lead), () => 'Qualify for outreach'],
  ['Qualified, draft ready', (lead) => !isContacted(lead) && Boolean(lead.outreachDraft || Object.keys(lead.outreachDrafts || {}).length), () => 'Review outreach draft'],
  ['Qualified, no draft yet', (lead) => !isContacted(lead), () => 'Prepare outreach'],
  ['Open pipeline with an explicit next step', (lead) => isOpenPipeline(lead) && Boolean(lead.nextAction), (lead) => lead.nextAction],
  ['Open pipeline, no next step set', (lead) => isOpenPipeline(lead), () => 'Set next action'],
]

export function getNextAction(lead) {
  const research = getResearchState(lead || {})
  for (const [, matches, action] of NEXT_ACTION_RULES) if (matches(lead || {}, research)) return action(lead || {})
  return 'Review client'
}

export function getSidebarCounts(leads = []) {
  return {
    Clients: leads.length,
    Research: leads.filter((lead) => getResearchState(lead).failure || (getResearchState(lead).museComplete && !isQualified(lead))).length,
    Outreach: leads.filter((lead) => getOutreachState(lead) === 'Ready to contact').length,
    Pipeline: leads.filter(isOpenPipeline).length,
    Contracts: leads.filter((lead) => lead.salesStage === 'Won' && !lead.contract).length,
  }
}


export function isValidDomain(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  const stripped = trimmed.replace(/^https?:\/\//i, '').split('/')[0].trim()
  if (stripped.length < 3 || stripped.length > 253) return false
  if (stripped.includes(' ')) return false
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(stripped)
}

export function validateLeadDraft(draft) {
  const errors = {}
  const company = String(draft.company || '').trim()
  if (!company) errors.company = 'Company name is required'
  else if (company.length < 2) errors.company = 'Company must be at least 2 characters'
  else if (company.length > 120) errors.company = 'Company must be 120 characters or fewer'
  const websiteRaw = String(draft.website || '').trim()
  if (websiteRaw) {
    if (websiteRaw.length < 3 || websiteRaw.length > 253) errors.website = 'Website must be 3-253 characters'
    else if (!isValidDomain(websiteRaw)) errors.website = 'Enter a valid domain like example.com'
  }
  const email = String(draft.email || '').trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email'
  return { errors, isValid: Object.keys(errors).length === 0 }
}

export function validateRunConfig({ location, categories, limit, maxRecords, connected, latitude = null, longitude = null }) {
  const errors = {}
  const loc = String(location || '').trim()
  if (!loc) errors.location = 'Location is required'
  else if (loc.length < 2) errors.location = 'Location must be at least 2 characters'
  if (!Array.isArray(categories) || categories.length === 0) errors.categories = 'Choose at least one business type'
  const hasLat = latitude !== '' && latitude != null
  const hasLon = longitude !== '' && longitude != null
  if (hasLat || hasLon) {
    const lat = Number(latitude)
    const lon = Number(longitude)
    if (!hasLat || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitude must be -90 to 90'
    if (!hasLon || !Number.isFinite(lon) || lon < -180 || lon > 180) errors.longitude = 'Longitude must be -180 to 180'
  }
  const n = Number(limit)
  if (!Number.isFinite(n) || !Number.isInteger(n)) errors.limit = 'Enter a whole number 1-50'
  else if (n < 1 || n > 50) errors.limit = 'Limit must be 1-50'
  else if (connected && maxRecords && n > maxRecords) errors.limit = `Live runs are capped at ${maxRecords}`
  return { errors, isValid: Object.keys(errors).length === 0 }
}

export function validateSettingsDraft(draft) {
  const errors = {}
  const loc = String(draft.defaultLocation || '').trim()
  if (!loc) errors.defaultLocation = 'Default location is required'
  else if (loc.length < 2) errors.defaultLocation = 'Must be at least 2 characters'
  const resultLimit = Number(draft.resultLimit)
  if (!Number.isFinite(resultLimit) || !Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 50) errors.resultLimit = 'Enter 1-50'
  const deep = Number(draft.deepAuditLimit)
  if (!Number.isFinite(deep) || !Number.isInteger(deep) || deep < 1 || deep > 25) errors.deepAuditLimit = 'Enter 1-25'
  if (draft.discoveryLatitude !== '' && draft.discoveryLatitude != null) {
    const v = Number(draft.discoveryLatitude)
    if (!Number.isFinite(v) || v < -90 || v > 90) errors.discoveryLatitude = 'Latitude must be -90 to 90'
  }
  if (draft.discoveryLongitude !== '' && draft.discoveryLongitude != null) {
    const v = Number(draft.discoveryLongitude)
    if (!Number.isFinite(v) || v < -180 || v > 180) errors.discoveryLongitude = 'Longitude must be -180 to 180'
  }
  return { errors, isValid: Object.keys(errors).length === 0 }
}

export function validateImportRows(rows) {
  const rowErrors = []
  let headerError = ''
  if (!Array.isArray(rows) || rows.length === 0) {
    headerError = 'CSV needs a header and at least one client'
    return { isValid: false, headerError, rowErrors, message: headerError }
  }
  const headers = Object.keys(rows[0] || {}).map((h) => String(h).toLowerCase())
  const hasCompany = headers.some((h) => ['company', 'name', 'business'].includes(h))
  if (!hasCompany) {
    headerError = 'CSV header must include company (company/name/business); website (website/domain) is optional'
    return { isValid: false, headerError, rowErrors, message: headerError }
  }
  rows.forEach((row, idx) => {
    const company = String(row.company || row.name || row.business || '').trim()
    const website = String(row.website || row.domain || '').trim()
    const reasons = []
    if (!company) reasons.push('missing company')
    else if (company.length < 2) reasons.push('company too short')
    else if (company.length > 120) reasons.push('company too long')
    // Website-less rows import consistently; omission stays unknown.
    if (website && (website.length < 3 || website.length > 253)) reasons.push('website length 3-253')
    else if (website && !isValidDomain(website)) reasons.push('invalid website domain')
    if (reasons.length) rowErrors.push({ row: idx + 2, reasons, company: company || '(blank)', website: website || '(blank)' })
  })
  const isValid = rowErrors.length === 0 && !headerError
  const message = headerError || (rowErrors.length ? `${rowErrors.length} row(s) have issues: ${rowErrors.slice(0, 3).map((e) => `row ${e.row} ${e.reasons.join(', ')}`).join('; ')}${rowErrors.length > 3 ? ` +${rowErrors.length - 3} more` : ''}` : '')
  return { isValid, headerError, rowErrors, message }
}

export function getFieldErrorsFromApiError(caught) {
  const body = caught?.details
  if (!body || typeof body !== 'object') {
    const msg = String(caught?.message || '')
    if (/company/i.test(msg)) return { company: msg }
    if (/website|domain/i.test(msg)) return { website: msg }
    if (/location/i.test(msg)) return { location: msg }
    return {}
  }
  if (Array.isArray(body.details)) {
    const map = {}
    body.details.forEach((item) => {
      const field = item.field || item.path || item.param || item.key
      const message = item.message || item.msg || String(item)
      if (field) map[field] = message
    })
    return map
  }
  if (Array.isArray(body.errors)) {
    const map = {}
    body.errors.forEach((item) => {
      if (typeof item === 'string') return
      const field = item.field || item.path || item.param
      const message = item.message || item.msg || String(item)
      if (field) map[field] = message
    })
    if (Object.keys(map).length) return map
  }
  if (body.fieldErrors && typeof body.fieldErrors === 'object') return body.fieldErrors
  if (body.fields && typeof body.fields === 'object') return body.fields
  const msg = String(body.error || body.message || caught.message || '')
  if (/company/i.test(msg)) return { company: msg }
  if (/website|domain/i.test(msg)) return { website: msg }
  if (/location/i.test(msg)) return { location: msg }
  return {}
}
