// Email autopilot: picks the day's leads, renders the approved sequence for
// each one, and decides when every email goes out. Pure and deterministic;
// the SMTP/IMAP side lives in mailbox.js and the scheduling loop in index.js.

import { createHash } from 'node:crypto'
import { DEFAULT_MARKETS } from './markets.js'
import { assertNoInventedClaims } from './outreach.js'

export const SENDER_VERSION = 1

// Trade owners read email before they head out to a job and again in the
// evening. Weekday mornings in the lead's own time zone are the best guess
// until our own reply data says otherwise. The window runs to noon so a full
// day of follow-ups still goes out minutes apart.
export const DEFAULT_WINDOW = { startMinute: 7 * 60, endMinute: 12 * 60, days: [1, 2, 3, 4, 5] }
export const DEFAULT_TIMEZONE = 'America/Denver'
export const MARKET_TIMEZONES = Object.fromEntries(DEFAULT_MARKETS.map((market) => [market.id, market.timeZone]))
export const DEFAULT_DAILY_NEW = 20
// Hard ceiling for all sends in one day (new + follow-ups), whatever the settings say.
export const MAX_DAILY_SENDS = 60
// Minimum gap between two sends, so a batch never goes out as a burst.
export const MIN_GAP_MINUTES = 6

export const TEMPLATE_VARIABLES = {
  firstName: 'Owner first name, or "there"',
  company: 'Business name, cleaned up',
  observation: 'One specific thing noticed on their site',
  website: 'Their website address',
  trade: 'Trade, e.g. "plumber"',
  city: 'City',
  conceptUrl: 'Link to their live concept site',
  signature: 'Your signature (Settings below)',
}

const OPT_OUT_LINE = 'If you\'d rather not hear from me, reply "no" and I won\'t email again.'

export const DEFAULT_SEQUENCE = [
  {
    delayDays: 0,
    subject: '{{company}} website',
    body: [
      'Hi {{firstName}},',
      '',
      'I was looking at {{website}} and noticed {{observation}}',
      '',
      'So I made a cleaner, more modern homepage for {{company}}:',
      '{{conceptUrl}}',
      '',
      'Why? We\'re a small studio building our portfolio, and {{company}} is exactly the kind of work we want to show.',
      '',
      'Worth a look? If not, no worries.',
      '',
      '{{signature}}',
      '',
      OPT_OUT_LINE,
    ].join('\n'),
  },
  {
    delayDays: 3,
    subject: '',
    body: [
      'Hi {{firstName}},',
      '',
      'Bumping this in case it got buried. People often look up local businesses on a phone, so try the new homepage on yours:',
      '{{conceptUrl}}',
      '',
      'Still worth a look?',
      '',
      '{{signature}}',
      '',
      OPT_OUT_LINE,
    ].join('\n'),
  },
  {
    delayDays: 7,
    subject: '',
    body: [
      'Hi {{firstName}},',
      '',
      'Last one from me, promise. The {{company}} homepage is still up if you want a look later:',
      '{{conceptUrl}}',
      '',
      'If now\'s not the right time, no worries.',
      '',
      '{{signature}}',
      '',
      OPT_OUT_LINE,
    ].join('\n'),
  },
]

export const DEFAULT_SIGNATURE = 'Rohan Ahire\nGoodShigoto · goodshigoto.com\n[postal address]'

export const DEFAULT_AUTOPILOT = {
  version: SENDER_VERSION,
  running: false,
  dailyNew: DEFAULT_DAILY_NEW,
  window: DEFAULT_WINDOW,
  sequence: DEFAULT_SEQUENCE,
  signature: DEFAULT_SIGNATURE,
  approvedHash: null,
  approvedAt: null,
}

// ---------------------------------------------------------------------------
// Settings

export function normalizeAutopilot(value = {}) {
  const input = value && typeof value === 'object' ? value : {}
  const window = { ...DEFAULT_WINDOW, ...(input.window || {}) }
  return {
    ...DEFAULT_AUTOPILOT,
    ...input,
    dailyNew: clamp(Number(input.dailyNew ?? DEFAULT_DAILY_NEW), 1, 30),
    window: {
      startMinute: clamp(Number(window.startMinute), 0, 23 * 60),
      endMinute: clamp(Number(window.endMinute), 60, 24 * 60),
      days: Array.isArray(window.days) && window.days.length ? [...new Set(window.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : DEFAULT_WINDOW.days,
    },
    sequence: Array.isArray(input.sequence) && input.sequence.length ? input.sequence.slice(0, 5).map((step, index) => ({
      delayDays: index === 0 ? 0 : clamp(Number(step.delayDays) || 1, 1, 30),
      subject: String(step.subject || ''),
      body: String(step.body || ''),
    })) : DEFAULT_SEQUENCE,
    signature: String(input.signature ?? DEFAULT_SIGNATURE),
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

// Approval is tied to the exact words. Any edit to a template, delay or the
// signature changes the hash and sending stops until it is approved again.
export function contentHash(autopilot) {
  const { sequence, signature } = normalizeAutopilot(autopilot)
  return createHash('sha256').update(JSON.stringify({ sequence, signature })).digest('hex').slice(0, 16)
}

export function isApproved(autopilot) {
  return Boolean(autopilot?.approvedHash && autopilot.approvedHash === contentHash(autopilot))
}

// Problems that block approval. Returned as plain sentences for the UI.
export function templateProblems(autopilot) {
  const { sequence, signature } = normalizeAutopilot(autopilot)
  const problems = []
  const known = new Set(Object.keys(TEMPLATE_VARIABLES))
  sequence.forEach((step, index) => {
    const label = index === 0 ? 'Email 1' : `Follow-up ${index}`
    if (index === 0 && !step.subject.trim()) problems.push(`${label} needs a subject`)
    if (!step.body.trim()) problems.push(`${label} is empty`)
    for (const name of variablesIn(`${step.subject}\n${step.body}`)) {
      if (!known.has(name)) problems.push(`${label} uses {{${name}}}, which isn't a known field`)
    }
    if (!/\{\{\s*signature\s*\}\}/.test(step.body)) problems.push(`${label} must include {{signature}} (US law needs your postal address in every email)`)
    if (!/\breply\b[^\n]*\b(no|stop|unsubscribe)\b/i.test(step.body)) problems.push(`${label} must say how to opt out, for example: reply "no" (US law needs this in every email)`)
    try { assertNoInventedClaims(`${step.subject}\n${step.body}`, label) } catch (error) { problems.push(error.message) }
  })
  if (!signature.trim() || /\[postal address\]/i.test(signature)) problems.push('Add your postal address to the signature (US law requires it)')
  if (!/\d/.test(signature)) problems.push('The signature should include a postal address')
  return problems
}

export function variablesIn(text) {
  return [...String(text || '').matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map((match) => match[1])
}

// A sequence that links the concept can only go to leads with one live.
export function usesConcept(autopilot) {
  return normalizeAutopilot(autopilot).sequence.some((step) => variablesIn(`${step.subject}\n${step.body}`).includes('conceptUrl'))
}

// ---------------------------------------------------------------------------
// Per-lead fields

export function cleanCompany(name) {
  let value = String(name || '').trim()
  value = value.split(/\s+[|–—]\s+|\s+-\s+/)[0]
  value = value.replace(/,?\s+(llc|l\.l\.c\.|inc\.?|incorporated|co\.|corp\.?|corporation|ltd\.?|pllc)$/i, '').trim()
  return value || String(name || '').trim()
}

export function firstNameOf(ownerName) {
  const [first = '', last = ''] = String(ownerName || '').trim().split(/\s+/)
  if (!/^[A-Za-z][A-Za-z'-]{1,20}$/.test(first)) return null
  // Scraped names can be page text ("Meet Connor") or a company ("Milne Co").
  if (/^(meet|our|the|about|contact)$/i.test(first) || /^(co|inc|llc)\.?$/i.test(last)) return null
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

export function displayHost(website) {
  try {
    const url = new URL(/^https?:/i.test(String(website)) ? website : `https://${website}`)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function cityOf(lead) {
  const location = String(lead.location || '')
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean)
  // "123 Main St, Sandy, UT 84070, United States" → "Sandy"; "Sandy, UT" → "Sandy"
  const stateIndex = parts.findIndex((part) => /^[A-Z]{2}(\s+\d{5})?$/.test(part))
  if (stateIndex > 0) return parts[stateIndex - 1]
  return parts[0] || ''
}

function tradeOf(category) {
  return String(category || '').replace(/\s+(contractor|service|services|company)$/i, '').toLowerCase().trim()
}

// Hooks from the visual review read like plain observations; hooks from the
// markup scan carry an evidence suffix such as "(© 2013)". Visual ones make a
// better first line, and anything technical is left out.
const TECHNICAL_HOOK = /deprecated|spacer|html|schema|meta |lighthouse|lcp|kb\b|mb\b|last-modified|seconds|tap-to-call|copyright|builder|alt text|viewport/i
// Older reviews saw video, half-run counters and unbuilt sections as broken, so
// these claims may be false. Telling an owner their working site is empty loses
// the reply.
const UNSURE_HOOK = /\b(blank|empty|nothing in it|solid black|black box|loading icon|appears to stop|not a bot|gradient|flat \w+ colou?r|colou?r fade|visible anywhere|entire website|makes no sense|closure notice)\b/i
// A firewall or error page means the review never saw the site at all, so none
// of its hooks can be trusted.
const BLOCKED_HOOK = /\b(403|404|forbidden|cannot be accepted|critical error)\b/i
// A stranger calling your site cheap gets deleted, however true it is.
const HARSH_HOOK = /\b(cheap|ugly|messy|harsh|amateur\w*|unprofessional|unflattering|look(s)? worse|clip-art|shouting|trash|dull|sloppy)\b/i

const HERO_WORDS = String.raw`(?:(?:big|main|top|large|desktop|mobile)\s+)*hero`
const HERO_WITH_NOUN = new RegExp(String.raw`\b${HERO_WORDS}(?=\s+(?:photos?|images?|headline|text|paragraph|buttons?|background|section|area|box|block|slider)\b)`, 'gi')
const HERO_ALONE = new RegExp(String.raw`\b${HERO_WORDS}\b`, 'gi')

// Owners don't call the top of their homepage the "hero".
function plainWords(text) {
  return text
    .replace(/\bin the hero\b/gi, 'at the top of the page')
    .replace(/\bhero at the top\b/gi, 'section at the top')
    .replace(HERO_WITH_NOUN, 'main')
    .replace(HERO_ALONE, 'top of the page')
}

export function pickObservation(lead) {
  const q = lead.qualification || {}
  const hooks = Array.isArray(q.pitchHooks) ? q.pitchHooks : []
  if (hooks.some((hook) => BLOCKED_HOOK.test(hook))) return null
  const ranked = hooks
    .map((hook) => String(hook || '').trim())
    .filter(Boolean)
    .map((hook) => {
      const device = /\((mobile|desktop)\)\s*$/i.exec(hook)?.[1]?.toLowerCase() || null
      const evidence = /\(([^()]+)\)\s*$/.exec(hook)
      const skip = TECHNICAL_HOOK.test(hook) || (evidence && !device) || UNSURE_HOOK.test(hook) || HARSH_HOOK.test(hook)
      return { hook, device, skip }
    })
    .filter((item) => !item.skip)
  const best = ranked.find((item) => !item.device) || ranked[0]
  if (!best) return null
  let text = plainWords(best.hook.replace(/\s*\((mobile|desktop)\)\s*$/i, '').replace(/[.!\s]+$/, ''))
  text = text.charAt(0).toLowerCase() + text.slice(1)
  if (best.device === 'mobile' && !/\b(phones?|mobile)\b/i.test(text)) text = `on phones, ${text}`
  text = text.replace(/\byou cannot\b/g, "you can't").replace(/\bit is\b/g, "it's")
  return `${text}.`
}

export function leadFields(lead, { signature = '', overrides = {} } = {}) {
  const q = lead.qualification || {}
  return {
    firstName: firstNameOf(overrides.ownerName ?? q.contact?.ownerName) || 'there',
    company: overrides.company || cleanCompany(lead.company),
    observation: overrides.observation || pickObservation(lead),
    website: displayHost(lead.website) || 'your website',
    trade: tradeOf(lead.category),
    city: cityOf(lead),
    conceptUrl: lead.concept?.status === 'live' ? lead.concept.url : '',
    signature,
  }
}

export function renderText(template, fields) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, name) => {
    const value = fields[name]
    if (value == null || value === '') throw new Error(`Missing ${name}`)
    return String(value)
  })
}

// Renders one step. Follow-ups reply in the same thread, so they reuse the
// first subject with "Re:".
export function renderStep(autopilot, stepIndex, lead, { overrides = {} } = {}) {
  const config = normalizeAutopilot(autopilot)
  const step = config.sequence[stepIndex]
  if (!step) throw new Error(`No step ${stepIndex}`)
  const fields = leadFields(lead, { signature: config.signature, overrides })
  const firstSubject = renderText(config.sequence[0].subject, fields)
  const subject = stepIndex === 0 || !step.subject.trim() ? (stepIndex === 0 ? firstSubject : `Re: ${firstSubject}`) : renderText(step.subject, fields)
  const text = renderText(step.body, fields).replace(/\n{3,}/g, '\n\n').trim()
  assertNoInventedClaims(`${subject}\n${text}`, 'autopilot email')
  return { subject, text }
}

// ---------------------------------------------------------------------------
// Who gets emailed

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const NEVER_EMAIL = /^(no-?reply|donotreply|do-not-reply|postmaster|abuse|webmaster|privacy|legal|billing|accounts?|careers|jobs|hr|press|media)@/i

// Why a lead can't go into the queue, or null when it can.
export function ineligibleReason(lead, { enrolledEmails = new Set(), suppressed = new Set(), requireConcept = false } = {}) {
  const q = lead.qualification
  if (!q) return 'Not qualified yet'
  if (q.play === 'skip') return 'Play is skip'
  const email = String(q.contact?.email || '').toLowerCase()
  if (!email) return 'No email address'
  if (!EMAIL.test(email)) return 'Email address looks invalid'
  if (NEVER_EMAIL.test(email)) return 'Address is not a person or the main inbox'
  if (suppressed.has(email)) return 'Asked not to be emailed, bounced or already replied'
  if (enrolledEmails.has(email)) return 'Already emailed'
  if (lead.autopilot?.status) return 'Already emailed'
  if (lead.outreachStatus === 'Contacted' || ['Contacted', 'Replied', 'Meeting', 'Proposal', 'Won', 'Lost'].includes(lead.salesStage)) return 'Already in conversation'
  if ((lead.contactAttempts || []).length) return 'Already contacted by hand'
  if (!pickObservation(lead) && !lead.autopilotOverrides?.observation) return 'No clear observation to open with'
  if (requireConcept && lead.concept?.status !== 'live') return 'No live concept yet'
  return null
}

// The next leads to email, best first, one per business and per address.
export function pickNewLeads(leads, { limit = DEFAULT_DAILY_NEW, enrolledEmails = new Set(), suppressed = new Set(), skipped = new Set(), requireConcept = false } = {}) {
  const seenEmail = new Set()
  const seenBusiness = new Set()
  return leads
    .filter((lead) => !skipped.has(lead.id) && !ineligibleReason(lead, { enrolledEmails, suppressed, requireConcept }))
    .sort((a, b) => (b.qualification.priority - a.qualification.priority) || String(a.id).localeCompare(String(b.id)))
    .filter((lead) => {
      const email = lead.qualification.contact.email.toLowerCase()
      const business = lead.businessId || `${String(lead.company).toLowerCase()}|${displayHost(lead.website) || ''}`
      if (seenEmail.has(email) || seenBusiness.has(business)) return false
      seenEmail.add(email)
      seenBusiness.add(business)
      return true
    })
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Time: everything is planned in the lead's local time zone.

export function timezoneFor(lead) {
  return MARKET_TIMEZONES[lead?.market] || DEFAULT_TIMEZONE
}

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(instant))
  const get = (type) => parts.find((part) => part.type === type)?.value
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  }
}

// "YYYY-MM-DD" for the instant in that zone.
export function localDay(instant, timeZone) {
  const p = zonedParts(instant, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// The UTC instant for a wall-clock time in a zone (handles DST by re-checking).
export function zonedTime(day, minuteOfDay, timeZone) {
  const [year, month, date] = day.split('-').map(Number)
  const wanted = Date.UTC(year, month - 1, date, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  let guess = wanted
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, timeZone)
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    guess += wanted - seen
  }
  return guess
}

export function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, date + count))
  return next.toISOString().slice(0, 10)
}

function weekdayOf(day) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay()
}

// First sending day on or after `day`. If today's window has already closed,
// the next one.
export function nextSendDay(day, window = DEFAULT_WINDOW, { now = null, timeZone = DEFAULT_TIMEZONE } = {}) {
  let candidate = day
  for (let i = 0; i < 14; i += 1) {
    const allowed = window.days.includes(weekdayOf(candidate))
    const closed = now != null && zonedTime(candidate, window.endMinute, timeZone) <= now
    if (allowed && !closed) return candidate
    candidate = addDays(candidate, 1)
  }
  return candidate
}

// Spreads `count` sends across the window with jitter, at least MIN_GAP apart.
// `seed` makes it deterministic for tests and stable across restarts.
export function planSlots(day, count, { window = DEFAULT_WINDOW, timeZone = DEFAULT_TIMEZONE, now = 0, seed = day } = {}) {
  if (count <= 0) return []
  const start = Math.max(zonedTime(day, window.startMinute, timeZone), now + 60_000)
  const end = zonedTime(day, window.endMinute, timeZone)
  const span = Math.max(0, end - start)
  const step = span / count
  const random = seeded(seed)
  const slots = []
  for (let i = 0; i < count; i += 1) {
    const base = start + step * i
    let at = Math.round(base + random() * step * 0.8)
    if (slots.length) at = Math.max(at, slots[slots.length - 1] + MIN_GAP_MINUTES * 60_000)
    slots.push(at)
  }
  return slots
}

function seeded(seed) {
  let h = 2166136261
  for (const char of String(seed)) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

// When a follow-up is due: `delayDays` after the first email, moved to the
// next sending day, at the same spot in the window as the first email.
export function followUpAt(firstSentAt, delayDays, { window = DEFAULT_WINDOW, timeZone = DEFAULT_TIMEZONE, now = Date.now() } = {}) {
  const firstDay = localDay(firstSentAt, timeZone)
  const p = zonedParts(firstSentAt, timeZone)
  const minute = clamp(p.hour * 60 + p.minute, window.startMinute, window.endMinute - 5)
  const day = nextSendDay(addDays(firstDay, delayDays), window, { now, timeZone })
  return Math.max(zonedTime(day, minute, timeZone), now + 60_000)
}

// ---------------------------------------------------------------------------
// Replies and bounces

// Out-of-office and other machine replies don't count as a reply.
export function isAutoReply({ subject = '', headers = '' } = {}) {
  const h = String(headers).toLowerCase()
  if (/auto-submitted:\s*auto-(replied|generated)/.test(h)) return true
  if (/^x-autoreply:|^x-autorespond:|precedence:\s*(auto_reply|bulk|junk)/m.test(h)) return true
  return /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|away from (the )?office|autoreply|thank you for (your )?(email|message|contacting))/i.test(String(subject).trim())
}

// Reply text that asks us to stop.
export function isOptOut(text) {
  const first = String(text || '').split(/\n\s*(on .+wrote:|-----original message|from: )/i)[0].trim().toLowerCase()
  return /^(no\b|nope\b|not interested|unsubscribe|remove me|stop\b|please remove|take me off)/.test(first) || /\b(unsubscribe|remove me from|stop emailing|don't email|do not email)\b/.test(first)
}

// Addresses a bounce message says failed.
export function bouncedAddresses({ headers = '', text = '' } = {}, candidates = []) {
  const found = new Set()
  const failed = /x-failed-recipients:\s*([^\r\n]+)/i.exec(String(headers))
  if (failed) failed[1].split(/[,\s]+/).filter((item) => item.includes('@')).forEach((item) => found.add(item.toLowerCase()))
  const body = String(text).toLowerCase()
  for (const email of candidates) if (body.includes(email.toLowerCase())) found.add(email.toLowerCase())
  return [...found]
}

// Pause when too many recent sends bounced: a bad list hurts the domain.
export function bounceGuard(recent = [], { minSample = 10, maxRate = 0.08 } = {}) {
  const sent = recent.filter((item) => item.firstSentAt)
  if (sent.length < minSample) return null
  const bounced = sent.filter((item) => item.status === 'bounced').length
  const rate = bounced / sent.length
  return rate > maxRate ? { bounced, sent: sent.length, rate } : null
}

// Is this instant inside the sending window, in that zone?
export function inWindow(instant, window = DEFAULT_WINDOW, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(instant, timeZone)
  const minute = p.hour * 60 + p.minute
  return window.days.includes(p.weekday) && minute >= window.startMinute && minute < window.endMinute
}

// The next time the window is open, a few minutes in.
export function nextWindowAt(instant, window = DEFAULT_WINDOW, timeZone = DEFAULT_TIMEZONE, offsetMinutes = 0) {
  const day = nextSendDay(localDay(instant, timeZone), window, { now: instant, timeZone })
  const minute = Math.min(window.startMinute + offsetMinutes, window.endMinute - 5)
  return Math.max(zonedTime(day, minute, timeZone), instant + 60_000)
}
