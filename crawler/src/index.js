import { config } from './config.js';
import { scheduleDueTargets } from './scheduler.js';
import { startWorkers } from './worker.js';
import { pool } from './db.js';
import { recoverStaleJobs } from './jobs.js';
import { startDashboardServer } from './dashboardServer.js';

console.log(`Starting ${config.workerId} with concurrency=${config.concurrency}`);

const recovered = await recoverStaleJobs();
if (recovered) console.log(`recovered ${recovered} stale crawl job(s)`);

startWorkers();
const dashboardServer = startDashboardServer();

async function schedulerLoop() {
  while (true) {
    try {
      const count = await scheduleDueTargets();
      if (count) console.log(`scheduled ${count} crawl(s)`);
    } catch (err) {
      console.error('scheduler error', err);
    }
    await new Promise(resolve => setTimeout(resolve, config.schedulerIntervalMs));
  }
}

schedulerLoop();

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  dashboardServer.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
