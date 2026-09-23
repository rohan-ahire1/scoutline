// Glue between a saved lead and the qualification pipeline:
//   scan (crawler engine, same one the VPS crawler runs) -> verify emails ->
//   qualify -> optional visual review -> re-qualify.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateSite, crawlSite } from '../../crawler/src/siteCrawler.js'
import { verifyEmails } from '../../crawler/src/contacts.js'
import { domainCounts, qualifyLead } from './qualify.js'
import { captureScreenshots, getVisionConfig, reviewScreenshots, saveScreenshots } from './visual.js'

export const SCAN_VERSION = 1

// What the lead keeps inline; the full aggregate (page text etc.) goes to disk.
export function compactScan(aggregate) {
  if (!aggregate || aggregate.failed) return aggregate
  return {
    version: SCAN_VERSION,
    scannedAt: aggregate.scannedAt,
    websiteType: aggregate.websiteType,
    title: aggregate.title,
    pagesInspected: aggregate.pagesInspected,
    pages: (aggregate.pages || []).map((p) => ({ url: p.finalUrl || p.requestedUrl, status: p.statusCode, title: p.title })),
    homeFallback: aggregate.homeFallback,
    dated: aggregate.dated,
    visualRisk: aggregate.visualRisk ? { score: aggregate.visualRisk.score, reasons: aggregate.visualRisk.reasons } : null,
    signals: aggregate.signals,
    tech: aggregate.tech,
    rankedEmails: (aggregate.rankedEmails || []).slice(0, 6),
    owners: aggregate.owners || [],
    familyOwned: Boolean(aggregate.familyOwned),
    phones: (aggregate.phones || []).slice(0, 5),
    socialLinks: (aggregate.socialLinks || []).slice(0, 10),
  }
}

export async function scanWebsite(website, { crawl = crawlSite, verify = verifyEmails } = {}) {
  const scannedAt = new Date().toISOString()
  if (!website) return null
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`
  try {
    const pages = await crawl(url)
    const aggregate = aggregateSite(pages)
    if (!aggregate) {
      const blocked = pages[0]?.fetched?.blockedByRobots
      return { failed: true, kind: blocked ? 'robots' : 'no-html', error: blocked ? 'Blocked by robots.txt' : 'No readable HTML (non-HTML, empty or blocked response)', scannedAt }
    }
    aggregate.rankedEmails = await verify(aggregate.rankedEmails || [])
    aggregate.scannedAt = scannedAt
    return aggregate
  } catch (error) {
    return { failed: true, kind: error.kind || 'network', error: String(error.message || error).slice(0, 400), attempts: error.attempts || [], scannedAt }
  }
}

// Fills in a lead's email from the scan when none was collected, keeping
// where it came from so outreach can say how the address was found.
export function contactPatch(lead, qualification) {
  const patch = {}
  const contact = qualification.contact
  const missing = !String(lead.email || '').includes('@')
  if (missing && contact.email) {
    patch.email = contact.email
    patch.emailSource = { kind: contact.emailKind, found: contact.emailSource, at: new Date().toISOString() }
  }
  if (contact.ownerName && !lead.ownerName) patch.ownerName = contact.ownerName
  if ((!lead.phone || lead.phone === 'Not collected') && contact.phone) patch.phone = contact.phone
  return patch
}

export function requalify(lead, allLeads = []) {
  return qualifyLead({
    business: lead,
    site: lead.siteScan || null,
    visualReview: lead.visualReview?.score != null ? lead.visualReview : null,
    knownDomains: domainCounts(allLeads),
  })
}

export async function scanAndQualify(lead, { allLeads = [], leadDir = null, scan = scanWebsite } = {}) {
  const aggregate = await scan(lead.website)
  if (leadDir && aggregate) {
    mkdirSync(leadDir, { recursive: true })
    writeFileSync(join(leadDir, 'site-scan.json'), JSON.stringify(aggregate, null, 1))
  }
  const siteScan = compactScan(aggregate)
  const next = { ...lead, siteScan }
  const qualification = requalify(next, allLeads)
  return { siteScan, qualification, patch: contactPatch(lead, qualification) }
}

// Screenshots always (they are the "before" image for outreach); the model
// review only when a vision provider is configured.
export async function visualReviewLead(lead, { leadDir, capture = captureScreenshots, review = reviewScreenshots } = {}) {
  const url = lead.siteScan?.pages?.[0]?.url || (lead.website ? `https://${lead.website}` : null)
  if (!url) throw Object.assign(new Error('Lead has no website to screenshot'), { code: 'NO_WEBSITE' })
  const shots = await capture(url)
  const dir = join(leadDir, 'screens')
  const files = saveScreenshots(dir, shots)
  const overlays = Object.fromEntries(Object.entries(shots).map(([view, shot]) => [view, shot.overlays || []]))
  const base = { capturedAt: new Date().toISOString(), url, files, overlays }
  if (!getVisionConfig().configured) return { ...base, status: 'screenshots-only', score: null }
  const result = await review(shots, { company: lead.company, category: lead.category, website: lead.website })
  return { ...base, status: 'reviewed', ...result }
}
