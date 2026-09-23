import { claimJob, markJobDone, markJobFailed } from './jobs.js';
import { crawlSite, aggregateSite } from './siteCrawler.js';
import { storeSnapshot } from './store.js';
import { verifyEmails } from './contacts.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processOne() {
  const job = await claimJob();
  if (!job) return false;

  try {
    const pages = await crawlSite(job.url);
    const home = pages[0]?.fetched || { requestedUrl: job.url };
    const analysis = aggregateSite(pages);
    if (analysis) analysis.rankedEmails = await verifyEmails(analysis.rankedEmails || []);
    await storeSnapshot(job, home, analysis);
    await markJobDone(job.id);
    console.log(JSON.stringify({
      event: 'crawl_done',
      jobId: job.id,
      url: job.url,
      pages: pages.length,
      eligible: analysis?.eligible ?? false,
      visualRisk: analysis?.visualRisk?.score ?? 0,
      score: analysis?.opportunityScore ?? 0
    }));
  } catch (err) {
    await markJobFailed(job.id, err?.stack || err);
    console.error(JSON.stringify({ event: 'crawl_failed', jobId: job.id, url: job.url, error: String(err) }));
  }
  return true;
}

export async function workerLoop(slot) {
  while (true) {
    const hadWork = await processOne();
    if (!hadWork) await sleep(1500 + slot * 100);
  }
}

export function startWorkers() {
  const concurrency = Number.parseInt(process.env.CONCURRENCY || '5', 10);
  for (let i = 0; i < concurrency; i += 1) {
    workerLoop(i).catch(err => {
      console.error('worker crashed', err);
      process.exitCode = 1;
    });
  }
}
