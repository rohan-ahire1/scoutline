function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  userAgent: process.env.CRAWLER_USER_AGENT || 'ScoutlineCrawler/0.3',
  workerId: process.env.WORKER_ID || `worker-${process.pid}`,
  concurrency: int('CONCURRENCY', 5),
  perHostDelayMs: int('PER_HOST_DELAY_MS', 3000),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 15000),
  maxResponseBytes: int('MAX_RESPONSE_BYTES', 5_000_000),
  maxPagesPerDomain: int('MAX_PAGES_PER_DOMAIN', 5),
  maxTextCharsPerPage: int('MAX_TEXT_CHARS_PER_PAGE', 8000),
  dailySiteLimit: int('DAILY_SITE_LIMIT', 1000),
  defaultIntervalMinutes: int('DEFAULT_INTERVAL_MINUTES', 1440),
  schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 30000),
  robotsCacheMinutes: int('ROBOTS_CACHE_MINUTES', 360),
  visualRiskEligibilityThreshold: int('VISUAL_RISK_ELIGIBILITY_THRESHOLD', 60),
  staleJobMinutes: int('STALE_JOB_MINUTES', 30),
  dashboardPort: int('DASHBOARD_PORT', 8791),
  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1'
};

// NOTE: DATABASE_URL is intentionally not required here. The scraping engine
// (siteCrawler/fetchPage/analyze/robots/throttle) works without a database so
// Scoutline can scrape locally; db.js throws when a database is actually used.
config.databaseUrl = config.databaseUrl || null;
