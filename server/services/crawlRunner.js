// Server-only local scrape runner: location/category discovery (Bright Data)
// or explicit URLs -> crawler engine -> committable JSON run file.
import { readFileSync, writeFileSync } from 'node:fs'
import { aggregateSite, crawlSite } from '../../crawler/src/siteCrawler.js'
import { DiscoveryError, downloadDiscovery, mapDiscoveryRecord, pollDiscovery, resolveSearchDefinition, triggerDiscovery } from './discovery.js'
import { mapEngineFailureToSite, mapEngineResultToSite } from './crawl.js'

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

function scrapeTargetsFromRecords(records, { category, location, limit }) {
  const mapped = records.map((record) => mapDiscoveryRecord(record, category, location)).filter(Boolean)
  const seen = new Set()
  const targets = []
  let skippedNoWebsite = 0
  for (const lead of mapped) {
    if (!lead.website) {
      skippedNoWebsite += 1
      continue
    }
    const domain = String(lead.website).split('/')[0].toLowerCase()
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    targets.push({ url: `https://${domain}`, company: lead.company })
    if (targets.length >= limit) break
  }
  return { targets, discoveredTotal: mapped.length, skippedNoWebsite }
}

export async function runLocalScrape({ runPath, settings = {} }) {
  const update = (patch) => writeLocalRunFile(runPath, { ...readLocalRunFile(runPath), ...patch })
  const fail = (error) => update({
    status: 'failed',
    error: String(error?.message || error || 'Local scrape failed').slice(0, 2000),
    finishedAt: new Date().toISOString(),
  })
  try {
    const run = readLocalRunFile(runPath)
    const limit = Math.max(1, Number(run.limit || 10))
    let targets = []
    if (run.mode === 'urls') {
      targets = (run.urls || []).map((url) => ({ url, company: '' }))
      update({ status: 'scraping', progress: { discovered: targets.length, scraped: 0, total: targets.length } })
    } else {
      update({ status: 'discovering', progress: { discovered: 0, scraped: 0, total: limit } })
      const search = resolveSearchDefinition({
        location: run.location,
        latitude: run.latitude,
        longitude: run.longitude,
        categories: [run.category],
        settings,
      })
      const started = await triggerDiscovery({ search, limit, settings })
      update({ snapshotId: started.snapshotId, submittedGeography: started.submittedGeography })
      const records = await waitForSnapshot(started.snapshotId, settings)
      const resolved = scrapeTargetsFromRecords(records, { category: run.category, location: run.location, limit })
      targets = resolved.targets
      update({
        status: 'scraping',
        progress: { discovered: targets.length, scraped: 0, total: targets.length },
        discoveredTotal: resolved.discoveredTotal,
        skippedNoWebsite: resolved.skippedNoWebsite,
      })
      if (!targets.length) {
        return update({ status: 'done', finishedAt: new Date().toISOString(), note: 'Discovery found no businesses with websites to scrape.' })
      }
    }
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      const scrapedAt = new Date().toISOString()
      const base = { url: target.url, runId: run.id, index, company: target.company, scrapedAt }
      let site
      try {
        const pages = await crawlSite(target.url)
        const aggregate = aggregateSite(pages)
        if (aggregate) {
          site = mapEngineResultToSite(aggregate, base)
        } else if (pages[0]?.fetched?.blockedByRobots) {
          site = mapEngineFailureToSite({ ...base, error: 'Blocked by robots.txt' })
        } else {
          site = mapEngineFailureToSite({ ...base, error: 'No analyzable HTML found (non-HTML, blocked, or empty response)' })
        }
      } catch (error) {
        site = mapEngineFailureToSite({ ...base, error: error?.message || 'Scrape failed' })
      }
      const current = readLocalRunFile(runPath)
      const sites = [...(current.sites || []), site]
      update({
        status: 'scraping',
        sites,
        progress: { discovered: targets.length, scraped: sites.length, total: targets.length },
      })
    }
    const final = readLocalRunFile(runPath)
    const sites = final.sites || []
    return update({
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
