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

