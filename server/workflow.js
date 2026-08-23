export const pipelineStages = ['Qualified', 'Contacted', 'Replied', 'Meeting', 'Proposal', 'Won', 'Lost']

export function normalizeLeadWorkflow(lead, timestamp = new Date().toISOString()) {
  const salesStage = lead.salesStage === 'Approved' ? 'Qualified' : lead.salesStage || null
  const qualified = Boolean(lead.qualified || lead.researchStatus === 'Shortlisted' || salesStage)
  return {
    ...lead,
    researchStatus: lead.researchStatus === 'Shortlisted' && lead.opportunityScore != null ? 'Analyzed' : lead.researchStatus,
    qualified,
    qualifiedAt: qualified ? lead.qualifiedAt || timestamp : lead.qualifiedAt || null,
    salesStage: qualified ? salesStage || 'Qualified' : null,
  }
}

export function applyLeadWorkflowChanges(lead, changes, timestamp = new Date().toISOString()) {
  const requested = { ...changes }
  if (requested.salesStage === 'Approved') requested.salesStage = 'Qualified'
  if (requested.qualified === true && !requested.salesStage && !lead.salesStage) requested.salesStage = 'Qualified'
  if (requested.salesStage) {
    requested.qualified = true
    requested.qualifiedAt = lead.qualifiedAt || timestamp
  }
  return normalizeLeadWorkflow({ ...lead, ...requested }, timestamp)
}

