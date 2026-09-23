// Lead qualification for GoodShigoto outreach. Answers three questions:
//   1. Is the business worth pitching? (businessWorth, from Google reviews)
//   2. Is its web presence weak enough to pitch? (siteWeakness, from the crawl)
//   3. Which play fits: a free redesign, an audit email, or skip?
// Pure and deterministic. Every reason names the evidence behind it, and
// unknown inputs add nothing instead of costing points.

export const QUALIFY_VERSION = 1

export const PLAYS = ['redesign', 'audit', 'skip']

// Home-service franchises and national brands: corporate marketing owns the
// website, so a local pitch goes nowhere.
const FRANCHISES = [
  'mr. electric', 'mr electric', 'mr. rooter', 'mr rooter', 'mr. handyman', 'mr handyman', 'mr. appliance',
  'roto-rooter', 'one hour heating', 'benjamin franklin plumbing', 'aire serv', 'ars rescue rooter', 'rescue rooter',
  'servpro', 'servicemaster', 'stanley steemer', 'chem-dry', 'molly maid', 'merry maids', 'the maids',
  'five star painting', 'certapro', 'handyman connection', 'bath fitter', 're-bath', 'kitchen tune-up',
  'floor coverings international', 'empire today', '50 floor', 'precision garage door', 'glass doctor',
  'rainbow restoration', 'two men and a truck', 'lawn doctor', 'trugreen', 'weed man', 'terminix', 'orkin',
  'truly nolen', 'aptive', 'window genie', 'mosquito joe', 'sears home', 'home depot', "lowe's", 'lowes',
  'budget blinds', 'dryer vent wizard', 'mister sparky', 'plumbing paramedics', 'horizon services',
  'len the plumber', 'service experts', 'sunrun', 'vivint', 'abc home', 'window world', 'renewal by andersen', 'leaffilter', 'leaf filter', 'bath planet',
  'jb-weld', 'puroclean', 'paul davis', 'belfor', 'neighborly', 'dwyer', 'authority brands', 'wrench group',
]

// Categories that are never small owner-run service businesses.
const EXCLUDED_CATEGORY = /utility|government|city hall|department|bank|credit union|hospital|school|university|church|supply|supplier|wholesaler|store|warehouse|manufacturer|distributor|dealer(?!ship)|rental|association|non-?profit/i

// Ticket size by category. It is a hypothesis about typical job value, not
// a measurement.
const TICKET = [
  [/roof|hvac|heating|air condition|furnace|solar|remodel|kitchen|bath|custom home|home builder|general contractor|foundation|basement|pool/i, 'high', 15],
  [/plumb|electric|floor|tile|carpet|concrete|masonry|fence|garage door|window|siding|gutter|landscap|hardscap|paving|asphalt|excavat|insulation|drywall|cabinet|countertop/i, 'mid', 10],
  [/paint|tree|lawn|clean|pest|handyman|moving|mover|junk|pressure wash|locksmith|appliance/i, 'low', 5],
]

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linktr\.ee|yelp\.com|nextdoor\.com|business\.site|g\.page|google\.com|tiktok\.com|x\.com|twitter\.com|linkedin\.com|angi\.com|homeadvisor\.com|thumbtack\.com|houzz\.com|bbb\.org)$/i
const FREE_SUBDOMAIN = /\.(wixsite\.com|wix-vibe-site\.com|weebly\.com|godaddysites\.com|square\.site|carrd\.co|webnode\.\w+|jimdosite\.com|site123\.me|squarespace\.com|wordpress\.com|blogspot\.com|mystrikingly\.com|business\.site|webflow\.io|netlify\.app|vercel\.app)$/i

const LARGE_OPERATION_REVIEWS = 1500

function hostAndPath(website) {
  const input = String(website || '').trim()
  if (!input) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`)
    return { host: url.hostname.toLowerCase().replace(/^www\./, ''), path: url.pathname.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

function matchFranchise(company) {
  const name = String(company || '').toLowerCase()
  return FRANCHISES.find((brand) => {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(name)
  }) || null
}

function ticketFor(category, services = []) {
  const text = [category, ...services].join(' ')
  for (const [pattern, tier, points] of TICKET) if (pattern.test(text)) return { tier, points }
  return null
}

// What does the business have online? Ordered from "nothing" to "own site".
export function classifyPresence({ website, site }) {
  const parsed = hostAndPath(website)
  if (!parsed) return { presence: 'none', detail: 'No website listed on Google' }
  if (SOCIAL_HOSTS.test(parsed.host)) return { presence: 'social-only', detail: `Website link points to ${parsed.host}` }
  if (FREE_SUBDOMAIN.test(parsed.host)) return { presence: 'free-subdomain', detail: `Site lives on a free builder subdomain (${parsed.host})` }
  if (site?.failed) {
    if (site.kind === 'dns') return { presence: 'dead-domain', detail: `Listed domain ${parsed.host} no longer resolves: the site is gone` }
    return { presence: 'unreachable', detail: `Listed site could not be loaded (${site.kind || 'error'}): ${String(site.error || 'no response').slice(0, 120)}` }
  }
  if (site?.dated?.placeholder) return { presence: 'placeholder', detail: `Listed site is a ${site.dated.placeholder.replace('-', ' ')} page` }
  // A deep path such as brand.com/city/salt-lake is a chain's location page.
  if (parsed.path && /\/(city|cities|location|locations|areas?|service-areas?|[a-z]{2}\/[a-z-]+)(\/|$)/i.test(parsed.path)) {
    return { presence: 'location-page', detail: `Website is a location page on a larger brand's site (${parsed.host}${parsed.path})` }
  }
  return { presence: 'own-site', detail: parsed.host }
}

export function scoreBusinessWorth(business = {}) {
  const reasons = []
  const unknowns = []
  let score = 0
  const reviews = Number(business.reviews || 0)
  const rating = Number(business.rating || 0)
  const bi = business.businessIntelligence || {}

  if (reviews > 0) {
    const points = reviews >= 800 ? 34 : reviews >= 250 ? 40 : reviews >= 100 ? 38 : reviews >= 50 ? 32 : reviews >= 25 ? 26 : reviews >= 10 ? 18 : 8
    score += points
    reasons.push({ text: `${reviews.toLocaleString('en-US')} Google reviews`, points })
  } else unknowns.push('No review count')

  if (rating > 0) {
    const points = rating >= 4.8 ? 25 : rating >= 4.6 ? 22 : rating >= 4.4 ? 18 : rating >= 4.2 ? 12 : rating >= 4.0 ? 6 : 0
    score += points
    reasons.push({ text: `${rating.toFixed(1)}★ rating`, points })
  } else unknowns.push('No rating')

  const latest = bi.latestObservedReviewAt ? Date.parse(bi.latestObservedReviewAt) : NaN
  if (Number.isFinite(latest)) {
    const days = (Date.now() - latest) / 86400000
    if (days <= 60) { score += 10; reasons.push({ text: 'Reviewed in the last 60 days (active)', points: 10 }) }
    else if (days <= 180) { score += 5; reasons.push({ text: 'Reviewed in the last 6 months', points: 5 }) }
    else reasons.push({ text: `Latest review ${Math.round(days)} days ago`, points: 0 })
  } else unknowns.push('Review recency')

  const ticket = ticketFor(business.category, bi.services || [])
  if (ticket) { score += ticket.points; reasons.push({ text: `${ticket.tier}-ticket trade (${business.category})`, points: ticket.points }) }
  else unknowns.push(`Ticket size for "${business.category || 'unknown'}"`)

  if (bi.claimed === true) { score += 5; reasons.push({ text: 'Claimed Google profile', points: 5 }) }
  if (Number(bi.photosObserved || 0) >= 20) { score += 5; reasons.push({ text: `${bi.photosObserved} profile photos`, points: 5 }) }

  return { score: Math.min(100, score), reasons, unknowns }
}

// How weak the web presence is, 0 (great) to 100 (nothing usable).
export function scoreSiteWeakness({ presence, site, visualReview = null }) {
  if (presence.presence !== 'own-site') {
    return { score: 100, basis: 'presence', reasons: [{ text: presence.detail, weight: 100 }] }
  }
  if (!site) return { score: null, basis: 'unscanned', reasons: [] }
  const reasons = []
  const dated = site.dated || { score: 0, signals: [] }
  for (const signal of dated.signals || []) reasons.push({ text: signal.label, evidence: signal.evidence, weight: signal.weight })
  let markup = dated.score || 0
  const visualRisk = Number(site.visualRisk?.score || 0)
  markup += Math.round(visualRisk * 0.25)
  const hasEmail = (site.rankedEmails || site.emails || []).length > 0
  const hasForm = (site.visualRisk?.metrics?.forms ?? null) > 0 || site.signals?.hasForm
  if (!hasEmail && !site.signals?.hasPhone && !hasForm) {
    markup += 10
    reasons.push({ text: 'No email, click-to-call or form found for customers', evidence: `${site.pagesInspected || 1} pages checked`, weight: 10 })
  }
  markup = Math.min(100, markup)
  if (visualReview?.score != null) {
    // A reviewed screenshot says more than markup about how the site looks.
    for (const issue of visualReview.issues || []) reasons.push({ text: issue, evidence: 'visual review', weight: 0 })
    return { score: Math.round(visualReview.score * 0.65 + markup * 0.35), basis: 'visual+markup', markupScore: markup, reasons }
  }
  return { score: markup, basis: 'markup', markupScore: markup, reasons: reasons.sort((a, b) => b.weight - a.weight) }
}

function pickContact(business, site) {
  const ranked = (site?.rankedEmails || []).filter((e) => e.kind !== 'low-value-role')
  const listed = String(business.email || '').includes('@') ? String(business.email).toLowerCase() : null
  const best = ranked[0] || (listed ? { email: listed, kind: 'listed', source: 'google' } : null)
  const phone = [business.phone, ...(site?.phones || [])].find((p) => p && p !== 'Not collected') || null
  const facebook = (site?.socialLinks || []).find((u) => /facebook\.com/i.test(u)) ||
    (/facebook\.com/i.test(String(business.website || '')) ? business.website : null)
  const channel = best ? 'email' : facebook ? 'facebook' : phone ? 'phone' : 'none'
  return {
    channel,
    email: best?.email || null,
    emailKind: best?.kind || null,
    emailSource: best?.page || best?.source || null,
    alternates: ranked.slice(1, 4).map((e) => e.email),
    ownerName: site?.owners?.[0]?.name || null,
    ownerEvidence: site?.owners?.[0]?.evidence || null,
    phone,
    facebook,
  }
}

// Main entry. `business` is a lead or mapped discovery record; `site` is the
// crawler's aggregateSite() output ({ failed: true, error } when the crawl
// failed, null when not crawled yet).
export function qualifyLead({ business = {}, site = null, visualReview = null, knownDomains = null } = {}) {
  const presence = classifyPresence({ website: business.website, site })
  const worth = scoreBusinessWorth(business)
  const weakness = scoreSiteWeakness({ presence, site, visualReview })
  const contact = pickContact(business, site)
  const flags = []

  const exclusions = []
  const status = business.businessIntelligence?.businessStatus
  if (/closed/i.test(status || '')) exclusions.push(`Google lists it as ${status.toLowerCase()}`)
  const franchise = matchFranchise(business.company)
  if (franchise) exclusions.push(`Franchise or national brand (${franchise})`)
  if (EXCLUDED_CATEGORY.test(business.category || '')) exclusions.push(`Not an owner-run service business (${business.category})`)
  if (presence.presence === 'location-page') exclusions.push(presence.detail)
  if (Number(business.reviews || 0) >= LARGE_OPERATION_REVIEWS) exclusions.push(`Large operation (${Number(business.reviews).toLocaleString('en-US')} reviews), probably has in-house marketing`)
  const rating = Number(business.rating || 0)
  if (rating > 0 && rating < 4.0) exclusions.push(`Weak reputation (${rating.toFixed(1)}★): a new site will not fix that`)
  const domain = hostAndPath(business.website)?.host
  if (domain && knownDomains && (knownDomains.get(domain) || 0) > 1) exclusions.push(`Shares its website with ${knownDomains.get(domain) - 1} other listing(s): multi-location brand`)

  const agency = site?.dated?.agencyPlatform || site?.dated?.agencyCredit || null
  if (agency) flags.push(`Site credited to an agency (${agency}): they already pay someone`)
  if (site?.familyOwned) flags.push('Says it is family/locally owned')
  if (contact.channel !== 'email') flags.push(contact.channel === 'none' ? 'No contact route found' : `No email, reach by ${contact.channel}`)

  let play
  let playReason
  let confidence = 'high'
  if (exclusions.length) {
    play = 'skip'
    playReason = exclusions[0]
  } else if (worth.score < 40) {
    play = 'skip'
    playReason = `Business signals too thin to justify free work (worth ${worth.score}/100)`
  } else if (presence.presence !== 'own-site') {
    play = 'redesign'
    // A timeout can be a bad hour, not a dead site: re-check before pitching.
    if (presence.presence === 'unreachable') confidence = 'low'
    playReason = `${presence.detail}, with ${worth.reasons.slice(0, 2).map((r) => r.text).join(' and ')}`
  } else if (weakness.score == null) {
    play = 'audit'
    playReason = 'Site not scanned yet'
    confidence = 'low'
  } else if (weakness.score >= 55) {
    play = 'redesign'
    playReason = `Dated site: ${weakness.reasons.slice(0, 3).map((r) => r.text.toLowerCase()).join('; ')}`
  } else if (weakness.score >= 20 || weakness.basis === 'markup') {
    // Markup alone cannot see a bland template, so an unreviewed site
    // stays in the audit pile for a human or visual review to judge.
    play = 'audit'
    playReason = weakness.reasons.length
      ? `Fixable issues: ${weakness.reasons.slice(0, 3).map((r) => r.text.toLowerCase()).join('; ')}`
      : 'No markup problems found; needs a visual review'
    if (weakness.basis === 'markup' && weakness.score < 20) confidence = 'low'
  } else {
    play = 'skip'
    playReason = `Site already looks good (weakness ${weakness.score}/100)`
  }

  const priority = play === 'skip'
    ? 0
    : Math.max(0, Math.round(worth.score * 0.55 + (weakness.score ?? 40) * 0.45 - (agency ? 10 : 0) - (contact.channel === 'none' ? 15 : 0) - (confidence === 'low' ? 10 : 0)))

  // The strongest, most specific observations: what the email opens with.
  const pitchHooks = play === 'skip' ? [] : [
    ...(presence.presence !== 'own-site' ? [presence.detail] : []),
    ...weakness.reasons.filter((r) => r.weight >= 8 || r.evidence === 'visual review').slice(0, 4).map((r) => (r.evidence && r.evidence !== 'visual review' ? `${r.text} (${r.evidence})` : r.text)),
  ]

  return {
    version: QUALIFY_VERSION,
    qualifiedAt: new Date().toISOString(),
    play,
    playReason,
    confidence,
    priority,
    presence: presence.presence,
    presenceDetail: presence.detail,
    businessWorth: worth,
    siteWeakness: weakness,
    contact,
    exclusions,
    flags,
    pitchHooks,
    needsVisualReview: play !== 'skip' && presence.presence === 'own-site' && !visualReview,
  }
}

// Counts distinct businesses per website domain so shared-domain chains can
// be excluded. Duplicate imports of one business count once.
export function domainCounts(businesses = []) {
  const names = new Map()
  for (const business of businesses) {
    const host = hostAndPath(business.website)?.host
    if (!host) continue
    const key = business.businessId || String(business.company || '').trim().toLowerCase()
    if (!names.has(host)) names.set(host, new Set())
    names.get(host).add(key)
  }
  return new Map([...names].map(([host, set]) => [host, set.size]))
}
