// Nightly market rotation. Each night covers a slice of the market (a few
// areas × a few categories), so the whole market is covered over a cycle
// instead of paying for the same top results every night.
//
// State file (compatible with the first ops-nightly script):
//   { areaCursor, categoryCursor, lastRunAt, lastRuns, night?, slice? }

export const NIGHTLY_DEFAULTS = { areasPerNight: 2, categoriesPerNight: 3, limitPerArea: 25 }

function take(list, start, count) {
  return Array.from({ length: Math.min(count, list.length) }, (_, i) => list[(start + i) % list.length])
}

// The calendar night in the market's time zone, e.g. "2026-09-28". A run that
// starts after midnight but is retried later the same day keeps its key.
export function nightOf(date = new Date(), timeZone = 'America/Denver') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function planNight(market, state = {}, { night, areasPerNight = NIGHTLY_DEFAULTS.areasPerNight, categoriesPerNight = NIGHTLY_DEFAULTS.categoriesPerNight } = {}) {
  const areaCursor = Number(state.areaCursor || 0) % Math.max(1, market.areas.length)
  const categoryCursor = Number(state.categoryCursor || 0) % Math.max(1, market.categories.length)
  // Same night again (manual rerun, timer catch-up, crash): repeat the slice
  // that was already started. The API's idempotency key then returns the
  // existing runs instead of paying Bright Data twice.
  if (night && state.night === night && state.slice) {
    return { night, areas: state.slice.areas, categories: state.slice.categories, repeat: true, nextState: state }
  }
  const areas = take(market.areas, areaCursor, areasPerNight).map((a) => a.name)
  const categories = take(market.categories, categoryCursor, categoriesPerNight)
  // Areas advance every night; categories advance each time areas wrap.
  const nextArea = areaCursor + areasPerNight
  const nextState = {
    areaCursor: nextArea % market.areas.length,
    categoryCursor: nextArea >= market.areas.length ? (categoryCursor + categoriesPerNight) % market.categories.length : categoryCursor,
    night,
    slice: { areas, categories },
  }
  return { night, areas, categories, repeat: false, nextState }
}

export function nightlyIdempotencyKey(marketId, night) {
  return `nightly:${marketId}:${night}`
}

// One line for the journal and the alert.
export function summarizeNight({ runs = [], leads = [] }) {
  const newIds = new Set(runs.flatMap((run) => run.newClientIds || []))
  const fresh = leads.filter((lead) => newIds.has(lead.id))
  const plays = {}
  for (const lead of fresh) {
    const play = lead.qualification?.play || 'unqualified'
    plays[play] = (plays[play] || 0) + 1
  }
  const withEmail = fresh.filter((lead) => lead.qualification?.play && lead.qualification.play !== 'skip' && lead.qualification.contact?.email).length
  const failedRuns = runs.filter((run) => ['Failed', 'Timed out', 'Cancelled'].includes(run.status)).map((run) => run.id)
  const unfinished = runs.filter((run) => ['Running', 'Waiting'].includes(run.status)).map((run) => run.id)
  return { newLeads: fresh.length, plays, pitchableWithEmail: withEmail, failedRuns, unfinished }
}
