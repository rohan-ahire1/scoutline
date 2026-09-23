// Server-only local scrape runner: location/category discovery (Bright Data)
// or explicit URLs -> crawler engine -> committable JSON run file.
import { readFileSync, writeFileSync } from 'node:fs'
import { aggregateSite, crawlSite } from '../../crawler/src/siteCrawler.js'
import { DiscoveryError, downloadDiscovery, mapDiscoveryRecord, pollDiscovery, resolveSearchDefinition, triggerDiscovery } from './discovery.js'
import { createJevUsage, mapEngineFailureToSite, mapEngineResultToSite, recordJevUsageEvent, sanitizeJevUsage } from './crawl.js'
import { evaluateJev, getJevConfig, jevFailure } from './jev.js'
import { verifyEmails } from '../../crawler/src/contacts.js'
import { domainCounts, qualifyLead } from './qualify.js'
import { compactScan } from './prospect.js'

export const LOCAL_RUN_VERSION = 1
export const LOCAL_RUN_ACTIVE = ['queued', 'discovering', 'scraping']
const DISCOVERY_POLL_MS = 10_000
const DISCOVERY_TIMEOUT_MS = 10 * 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readLocalRunFile(runPath) {
  return JSON.parse(readFileSync(runPath, 'utf8'))
}

export function writeLocalRunFile(runPath, run) {
  const next = { ...run, updatedAt: new Date().toISOString() }
  writeFileSync(runPath, JSON.stringify(next))
  return next
}

async function waitForSnapshot(snapshotId, settings) {
  const startedAt = Date.now()
  for (;;) {
    const progress = await pollDiscovery(snapshotId, settings)
    if (progress.status === 'failed') throw new DiscoveryError('Bright Data discovery failed', 'PROVIDER_FAILED')
    if (['ready', 'completed'].includes(progress.status)) return downloadDiscovery(snapshotId, settings)
    if (Date.now() - startedAt > DISCOVERY_TIMEOUT_MS) {
      throw new DiscoveryError('Bright Data discovery timed out after 10 minutes', 'PROVIDER_TIMEOUT')
    }
    await sleep(DISCOVERY_POLL_MS)
  }
}

// Keeps the full Google business record with each target: review count and
// rating decide whether a business is worth pitching. Businesses without a
// website are kept too, since they are the free-redesign candidates.
function scrapeTargetsFromRecords(records, { category, location, limit }) {
  const mapped = records.map((record) => mapDiscoveryRecord(record, category, location)).filter(Boolean)
  const seen = new Set()
  const targets = []
  let noWebsite = 0
  for (const lead of mapped) {
    const key = lead.website ? String(lead.website).split('/')[0].toLowerCase() : `name:${lead.company.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!lead.website) noWebsite += 1
    targets.push({ url: lead.website ? `https://${lead.website}` : null, company: lead.company, business: lead })
    if (targets.length >= limit) break
  }
  return { targets, discoveredTotal: mapped.length, noWebsite }
}

export async function runLocalScrape({ runPath, settings = {} }) {
  const update = (patch) => writeLocalRunFile(runPath, { ...readLocalRunFile(runPath), ...patch })
  let jevUsage = null
  const persist = (patch) => update({
    ...patch,
    ...(jevUsage ? { jev: sanitizeJevUsage(jevUsage) } : {}),
  })
  const fail = (error) => persist({
    status: 'failed',
    error: String(error?.message || error || 'Local scrape failed').slice(0, 2000),
    finishedAt: new Date().toISOString(),
  })
  try {
    const run = readLocalRunFile(runPath)
    const jevConfig = getJevConfig()
    jevUsage = createJevUsage(jevConfig, run.jev)
    persist({})
    const limit = Math.max(1, Number(run.limit || 10))
    let targets = []
    if (run.mode === 'urls') {
      targets = (run.urls || []).map((url) => ({ url, company: '' }))
      persist({ status: 'scraping', progress: { discovered: targets.length, scraped: 0, total: targets.length } })
    } else {
      persist({ status: 'discovering', progress: { discovered: 0, scraped: 0, total: limit } })
      const search = resolveSearchDefinition({
        location: run.location,
        latitude: run.latitude,
        longitude: run.longitude,
        categories: [run.category],
        settings,
      })
      const started = await triggerDiscovery({ search, limit, settings })
      persist({ snapshotId: started.snapshotId, submittedGeography: started.submittedGeography })
      const records = await waitForSnapshot(started.snapshotId, settings)
      const resolved = scrapeTargetsFromRecords(records, { category: run.category, location: run.location, limit })
      targets = resolved.targets
      persist({
        status: 'scraping',
        progress: { discovered: targets.length, scraped: 0, total: targets.length },
        discoveredTotal: resolved.discoveredTotal,
        noWebsite: resolved.noWebsite,
      })
      if (!targets.length) {
        return persist({ status: 'done', finishedAt: new Date().toISOString(), note: 'Discovery found no businesses.' })
      }
    }
    const knownDomains = domainCounts(targets.map((target) => target.business).filter(Boolean))
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      const scrapedAt = new Date().toISOString()
      const base = { url: target.url, runId: run.id, index, company: target.company, scrapedAt, business: target.business || null }
      let site
      let aggregateForQualify = null
      if (!target.url) {
        site = mapEngineFailureToSite({ ...base, url: '', error: 'No website listed on Google' })
      } else try {
        const pages = await crawlSite(target.url)
        const aggregate = aggregateSite(pages)
        if (aggregate) aggregate.rankedEmails = await verifyEmails(aggregate.rankedEmails || [])
        aggregateForQualify = aggregate ? { ...aggregate, scannedAt: scrapedAt } : { failed: true, kind: pages[0]?.fetched?.blockedByRobots ? 'robots' : 'no-html', error: 'No analyzable HTML' }
        if (aggregate) {
          site = mapEngineResultToSite(aggregate, base)
          if (jevConfig.configured) {
            try {
              const triage = await evaluateJev({
                aggregate,
                company: target.company,
                category: run.category,
                location: run.location,
                website: target.url,
              }, { onEvent: (event) => recordJevUsageEvent(jevUsage, event) })
              site = mapEngineResultToSite(aggregate, { ...base, jev_triage: triage })
            } catch (err) {
              site = mapEngineResultToSite(aggregate, { ...base, jev_triage: jevFailure(err) })
            }
          }
        } else if (pages[0]?.fetched?.blockedByRobots) {
          site = mapEngineFailureToSite({ ...base, error: 'Blocked by robots.txt' })
        } else {
          site = mapEngineFailureToSite({ ...base, error: 'No analyzable HTML found (non-HTML, blocked, or empty response)' })
        }
      } catch (error) {
        site = mapEngineFailureToSite({ ...base, error: error?.message || 'Scrape failed' })
        aggregateForQualify = { failed: true, kind: error?.kind || 'network', error: String(error?.message || 'Scrape failed').slice(0, 400) }
      }
      site.site_scan = compactScan(aggregateForQualify)
      site.qualification = qualifyLead({
        business: target.business || { company: target.company, website: target.url },
        site: aggregateForQualify,
        knownDomains,
      })
      const current = readLocalRunFile(runPath)
      const sites = [...(current.sites || []), site]
      persist({
        status: 'scraping',
        sites,
        progress: { discovered: targets.length, scraped: sites.length, total: targets.length },
      })
    }
    const final = readLocalRunFile(runPath)
    const sites = final.sites || []
    return persist({
      status: 'done',
      finishedAt: new Date().toISOString(),
      counts: {
        total: sites.length,
        completed: sites.filter((site) => site.crawl_state === 'completed').length,
        failed: sites.filter((site) => site.crawl_state === 'failed').length,
        eligible: sites.filter((site) => site.last_eligible).length,
      },
    })
  } catch (error) {
    return fail(error)
  }
}
