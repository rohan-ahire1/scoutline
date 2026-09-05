// Bounded-collection policy for website crawling (ROH-22).
//
// Guarantees provided here:
// - Every collection loop is governed by explicit, separately configured caps
//   (attempts, successful pages, queue size, redirects per fetch, bytes per
//   page, total bytes, total elapsed time) and records which bound stopped it.
// - Robots/action-route/destination policies are applied to page fetches, link
//   checks and redirect hops; off-origin redirect targets are never traversed
//   as same-site pages and robots-disallowed links are never requested.
// - A caller cancellation signal (shared with the jobs ticket, ROH-23) stops
//   collection promptly while preserving already collected evidence.
//
// Honest limitations (deliberately NOT claimed):
// - DNS is re-resolved before every request, but the resolved address cannot
//   be pinned to the connection with the stdlib fetch transport, so a narrow
//   DNS-rebinding (TOCTOU) window remains. Private destinations are still
//   rejected at resolve time and inside Chrome via the safety flags below.
// - Robots rules are evaluated per queued candidate against the fetched
//   robots file; robots files are NOT re-fetched per redirect hop (same-origin
//   redirects share the same file; off-origin targets are not traversed).
// - Rendered (browser) collection is Lighthouse only: the initial URL is
//   validated with assertPublicUrl and Chrome launches with CHROME_SAFETY_FLAGS
//   blocking private/local resolution. Subresource loads inside Chrome are
//   subject to the same resolver rules, but there is no per-subresource audit.

export const CRAWL_LIMITS = {
  maxAttempts: 60,
  maxPages: 10,
  maxQueue: 500,
  maxRedirects: 5,
  maxBytesPerPage: 2 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  timeLimitMs: 120_000,
  maxLinks: 50,
  maxLinkConcurrency: 5,
}

export const STOP_REASONS = {
  PAGE_LIMIT: 'page-limit',
  ATTEMPT_LIMIT: 'attempt-limit',
  QUEUE_LIMIT: 'queue-limit',
  BYTE_LIMIT: 'byte-limit',
  TIME_LIMIT: 'time-limit',
  CANCELLED: 'cancelled',
}

const STOP_LABELS = {
  'page-limit': 'page limit',
  'attempt-limit': 'attempt limit',
  'queue-limit': 'queue limit',
  'byte-limit': 'size limit',
  'time-limit': 'time limit',
  cancelled: 'cancellation',
}

export function stopReasonLabel(reason) {
  return STOP_LABELS[reason] || reason || 'unknown limit'
}

// Honest one-line evidence fragment for a bounded stop, or null when the
// collection ran to completion. Pure so the wording is unit-tested.
export function collectionStopEvidence(limits) {
  if (!limits?.stoppedBy) return null
  return `Collection stopped at the ${stopReasonLabel(limits.stoppedBy)} (${limits.attempts} attempts, ${limits.pages} pages kept); remaining candidates were not fetched`
}

// Chrome is only ever launched for Lighthouse with these resolver/network
// guardrails. Kept as a pure constant so policy coverage does not require
// launching a browser in tests.
export const CHROME_SAFETY_FLAGS = [
  '--headless',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--host-resolver-rules=MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND, MAP *.local ~NOTFOUND, MAP 127.0.0.1 ~NOTFOUND, MAP ::1 ~NOTFOUND, MAP 10.* ~NOTFOUND, MAP 192.168.* ~NOTFOUND',
]

// Mutable per-run bound accounting. The first bound hit wins and is kept as
// `stoppedBy` so callers can persist and report exactly what ended collection.
export function createCrawlBounds(overrides = {}) {
  const defined = Object.fromEntries(Object.entries(overrides || {}).filter(([, value]) => value !== undefined && value !== null))
  const limits = { ...CRAWL_LIMITS, ...defined }
  const startedAt = Date.now()
  const state = {
    attempts: 0,
    pages: 0,
    bytesTotal: 0,
    redirects: 0,
    queuePeak: 0,
    stoppedBy: null,
    startedAt,
  }
  const stop = (reason) => {
    if (!state.stoppedBy) state.stoppedBy = reason
    return false
  }
  return {
    limits,
    state,
    stopped: () => state.stoppedBy != null,
    // One page-fetch attempt (success or failure). At most maxAttempts fetches run.
    claimAttempt() {
      if (state.stoppedBy) return false
      if (state.attempts >= limits.maxAttempts) return stop(STOP_REASONS.ATTEMPT_LIMIT)
      state.attempts += 1
      return true
    },
    // One successfully collected page of `byteLength` decoded bytes.
    addPage(byteLength = 0) {
      if (state.stoppedBy) return false
      state.pages += 1
      state.bytesTotal += Math.max(0, Number(byteLength) || 0)
      if (state.bytesTotal > limits.maxTotalBytes) return stop(STOP_REASONS.BYTE_LIMIT)
      return true
    },
    noteRedirects(count = 1) {
      state.redirects += Math.max(0, Number(count) || 0)
    },
    noteQueue(size = 0) {
      state.queuePeak = Math.max(state.queuePeak, size)
      if (size > limits.maxQueue) return stop(STOP_REASONS.QUEUE_LIMIT)
      return true
    },
    checkTime(now = Date.now()) {
      if (state.stoppedBy) return false
      if (now - startedAt > limits.timeLimitMs) return stop(STOP_REASONS.TIME_LIMIT)
      return true
    },
    cancel() {
      return stop(STOP_REASONS.CANCELLED)
    },
    summary(now = Date.now()) {
      return { ...state, elapsedMs: Math.max(0, now - startedAt) }
    },
  }
}

// Split link targets into fetchable vs robots-disallowed without requesting
// anything. Disallowed targets are returned for honest reporting, never fetched.
export function splitAllowedUrls(urls, robots, userAgent) {
  const allowed = []
  const skipped = []
  for (const url of urls) {
    const href = typeof url === 'string' ? url : url?.href
    try {
      if (robots && robots.isAllowed(href, userAgent) === false) {
        skipped.push(url)
        continue
      }
    } catch {
      skipped.push(url)
      continue
    }
    allowed.push(url)
  }
  return { allowed, skipped }
}

export function isSameSite(url, homeOrigin) {
  try {
    return new URL(url).origin === homeOrigin
  } catch {
    return false
  }
}
