// Scraping engine limits (used by siteCrawler/fetchPage/analyze/robots/throttle).
function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  userAgent: process.env.CRAWLER_USER_AGENT || 'ScoutlineCrawler/0.3',
  perHostDelayMs: int('PER_HOST_DELAY_MS', 3000),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 15000),
  maxResponseBytes: int('MAX_RESPONSE_BYTES', 5_000_000),
  maxPagesPerDomain: int('MAX_PAGES_PER_DOMAIN', 5),
  maxTextCharsPerPage: int('MAX_TEXT_CHARS_PER_PAGE', 8000),
  robotsCacheMinutes: int('ROBOTS_CACHE_MINUTES', 360),
  visualRiskEligibilityThreshold: int('VISUAL_RISK_ELIGIBILITY_THRESHOLD', 60),
};

