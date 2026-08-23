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
  const processing = activeJobStates.includes(lead.researchStatus) || activeJobStates.includes(lead.researchJob?.status) || activeJobStates.includes(lead.manualRun?.status)
  const rawStage = Number(lead.researchFailure?.stage)
  const failure = Number.isInteger(rawStage) ? { ...lead.researchFailure, stage: Math.max(0, Math.min(2, rawStage)) } : null
  const phase = failure ? failure.stage : museComplete ? 2 : analyzed || processing ? 1 : 0
  const done = [true, analyzed, museComplete]
  return { done, failure, phase, analyzed, museComplete, processing }
}

export function getResearchLabel(lead) {
  const state = getResearchState(lead)
  if (state.failure) return `${researchStages[state.phase].label} failed`
  if (state.processing) return 'In progress'
  return researchStages[state.phase].label
}

export function getMuseGuidance(lead) {
  const recommendation = lead.museAnalysis?.qualificationRecommendation
  if (recommendation === 'Pursue') return 'Pursue'
  if (recommendation === 'Review') return 'Review manually'
  if (recommendation === 'Deprioritize') return 'Deprioritize'
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
  if (isContacted(lead)) return 'Contacted'
  return lead.outreachDraft || Object.keys(lead.outreachDrafts || {}).length ? 'Ready to contact' : 'Needs draft'
}

export function getNextAction(lead) {
  const research = getResearchState(lead)
  if (research.failure) return 'Retry research'
  if (!research.analyzed) return 'Analyze website'
  if (!research.museComplete) return 'Review research'
  if (!isQualified(lead)) return 'Qualify for outreach'
  if (!isContacted(lead)) return 'Prepare outreach'
  if (lead.salesStage === 'Won' && !lead.contract) return 'Add contract details'
  if (isOpenPipeline(lead)) return lead.nextAction || 'Set next action'
  return lead.salesStage === 'Won' ? (lead.contract?.nextStep || 'Begin delivery') : 'Review client'
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

export function validateRunConfig({ location, categories, limit, maxRecords, connected }) {
  const errors = {}
  const loc = String(location || '').trim()
  if (!loc) errors.location = 'Location is required'
  else if (loc.length < 2) errors.location = 'Location must be at least 2 characters'
  if (!Array.isArray(categories) || categories.length === 0) errors.categories = 'Choose at least one business type'
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
  const hasWebsite = headers.some((h) => ['website', 'domain'].includes(h))
  if (!hasCompany || !hasWebsite) {
    headerError = 'CSV header must include company (company/name/business) and website (website/domain)'
    return { isValid: false, headerError, rowErrors, message: headerError }
  }
  rows.forEach((row, idx) => {
    const company = String(row.company || row.name || row.business || '').trim()
    const website = String(row.website || row.domain || '').trim()
    const reasons = []
    if (!company) reasons.push('missing company')
    else if (company.length < 2) reasons.push('company too short')
    else if (company.length > 120) reasons.push('company too long')
    if (!website) reasons.push('missing website')
    else if (website.length < 3 || website.length > 253) reasons.push('website length 3-253')
    else if (!isValidDomain(website)) reasons.push('invalid website domain')
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
