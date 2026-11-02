// Nightly market rotation. Each night covers a slice of one market (a few
// areas × a few categories). Once every slice is done the rotation moves to the
// next market for good: a second pass mostly finds the same businesses.
//
// State file (an older one with no marketId starts at the first market):
//   { marketId, finished, areaCursor, categoryCursor, lastRunAt, lastRuns, night?, slice? }

// About 1 in 10 businesses searched can be pitched, so 100 new emails a week
// takes about 150 businesses a night: 6 areas at 25 each while the autopilot runs.
export const NIGHTLY_DEFAULTS = { areasPerNight: 2, sendingAreasPerNight: 6, categoriesPerNight: 3, limitPerArea: 25 }

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
  const areas = market.areas.slice(areaCursor, areaCursor + areasPerNight).map((a) => a.name)
  const categories = take(market.categories, categoryCursor, categoriesPerNight)
  // Areas advance every night; categories advance when areas reach the end. A
  // short last night is cheaper than searching the first areas twice.
  const nextArea = areaCursor + areasPerNight
  const areasDone = nextArea >= market.areas.length
  const nextCategory = categoryCursor + categoriesPerNight
  const nextState = {
    areaCursor: areasDone ? 0 : nextArea,
    categoryCursor: areasDone ? nextCategory % market.categories.length : categoryCursor,
    night,
    slice: { areas, categories },
  }
  return { night, areas, categories, repeat: false, passDone: areasDone && nextCategory >= market.categories.length, nextState }
}

// Tonight's market and slice, or null once every enabled market has had its pass.
export function planRotation(markets, state = {}, options = {}) {
  const finished = state.finished || []
  const current = markets.find((market) => market.id === state.marketId)
  const rerun = options.night && state.night === options.night && state.slice && current
  const open = (market) => market.enabled && market.areas.length && !finished.includes(market.id)
  const market = rerun || (current && open(current)) ? current : markets.find(open)
  if (!market) return null
  const plan = planNight(market, market === current ? state : {}, options)
  if (plan.repeat) return { ...plan, market }
  return { ...plan, market, nextState: { ...plan.nextState, marketId: market.id, finished: plan.passDone ? [...finished, market.id] : finished } }
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
