// Automated outreach: a reviewed send queue with daily caps, spaced sends,
// threaded follow-ups and a permanent suppression list.
//
// One sequence per lead: an initial email plus up to two follow-ups on the
// same thread. A sequence starts in `pending` (waiting for review), moves to
// `approved` (queued), `active` (initial sent, follow-ups pending) and ends as
// `completed`, `replied`, `bounced`, `unsubscribed`, `stopped`, `failed` or
// `rejected`. Everything here takes the database handle and clock as
// arguments so it can be tested against an in-memory database.
import { randomBytes, randomUUID } from 'node:crypto'
import { checkMx } from '../../crawler/src/contacts.js'
import { DEFAULT_OFFER, assertNoInventedClaims, buildChannelDrafts, resolveOffer } from './outreach.js'

export const SEQUENCE_STATUSES = ['pending', 'approved', 'active', 'completed', 'replied', 'bounced', 'unsubscribed', 'stopped', 'failed', 'rejected']
const OPEN_STATUSES = ['pending', 'approved', 'active']
const MAX_SEND_ATTEMPTS = 3

export const DEFAULT_SENDING = {
  enabled: false,
  dailyCap: 20,
  minGapMinutes: 4,
  maxGapMinutes: 11,
  windowStartHour: 9,
  windowEndHour: 16,
  timezone: 'America/Denver',
  weekdaysOnly: true,
  followupDays: [3, 7],
  autoApprove: false,
  autoApproveMinPriority: 70,
  batchSize: 20,
  signature: 'Rohan\ngoodshigoto.com',
}

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'comcast.net', 'att.net', 'proton.me', 'protonmail.com'])
const STAGES_IN_CONVERSATION = new Set(['Replied', 'Meeting', 'Proposal', 'Won', 'Lost'])

const int = (value, fallback, min, max) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export function resolveSending(stored = {}) {
  const s = { ...DEFAULT_SENDING, ...(stored && typeof stored === 'object' ? stored : {}) }
  const minGap = int(s.minGapMinutes, DEFAULT_SENDING.minGapMinutes, 1, 240)
  const followupDays = (Array.isArray(s.followupDays) ? s.followupDays : DEFAULT_SENDING.followupDays)
    .map((d) => int(d, null, 1, 60)).filter((d) => d != null).sort((a, b) => a - b).slice(0, 2)
  let timezone = String(s.timezone || DEFAULT_SENDING.timezone)
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { timezone = DEFAULT_SENDING.timezone }
  return {
    enabled: s.enabled === true,
    dailyCap: int(s.dailyCap, DEFAULT_SENDING.dailyCap, 0, 200),
    minGapMinutes: minGap,
    maxGapMinutes: Math.max(minGap, int(s.maxGapMinutes, DEFAULT_SENDING.maxGapMinutes, 1, 480)),
    windowStartHour: int(s.windowStartHour, DEFAULT_SENDING.windowStartHour, 0, 23),
    windowEndHour: int(s.windowEndHour, DEFAULT_SENDING.windowEndHour, 1, 24),
    timezone,
    weekdaysOnly: s.weekdaysOnly !== false,
    followupDays,
    autoApprove: s.autoApprove === true,
    autoApproveMinPriority: int(s.autoApproveMinPriority, DEFAULT_SENDING.autoApproveMinPriority, 0, 100),
    batchSize: int(s.batchSize, DEFAULT_SENDING.batchSize, 1, 100),
    signature: String(s.signature ?? DEFAULT_SENDING.signature).slice(0, 300),
  }
}

export function validateSendingPatch(patch) {
  const errors = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [{ field: 'sending', message: 'Must be an object' }]
  const known = new Set(Object.keys(DEFAULT_SENDING))
  for (const key of Object.keys(patch)) if (!known.has(key)) errors.push({ field: key, message: 'Unknown sending setting' })
  for (const key of ['enabled', 'weekdaysOnly', 'autoApprove']) if (key in patch && typeof patch[key] !== 'boolean') errors.push({ field: key, message: 'Must be true or false' })
  for (const key of ['dailyCap', 'minGapMinutes', 'maxGapMinutes', 'windowStartHour', 'windowEndHour', 'autoApproveMinPriority', 'batchSize']) {
    if (key in patch && !Number.isFinite(Number(patch[key]))) errors.push({ field: key, message: 'Must be a number' })
  }
  if ('dailyCap' in patch && Number(patch.dailyCap) > 50) errors.push({ field: 'dailyCap', message: 'Keep the cap at 50 or less to protect the sending domain' })
  if ('followupDays' in patch && (!Array.isArray(patch.followupDays) || patch.followupDays.length > 2)) errors.push({ field: 'followupDays', message: 'Must be a list of up to two day offsets' })
  if ('timezone' in patch) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(patch.timezone) }) } catch { errors.push({ field: 'timezone', message: 'Unknown time zone' }) }
  }
  return errors
}

export function ensureMailSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_sequences (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      followups TEXT NOT NULL DEFAULT '[]',
      token TEXT NOT NULL UNIQUE,
      next_send_at TEXT,
      first_sent_at TEXT,
      last_sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      approved_by TEXT,
      stop_reason TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mail_sequences_status_index ON mail_sequences(status, next_send_at);
    CREATE INDEX IF NOT EXISTS mail_sequences_lead_index ON mail_sequences(lead_id);
    CREATE INDEX IF NOT EXISTS mail_sequences_email_index ON mail_sequences(email);
    CREATE TABLE IF NOT EXISTS mail_messages (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      transport TEXT NOT NULL,
      send_day TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mail_messages_day_index ON mail_messages(send_day, status);
    CREATE INDEX IF NOT EXISTS mail_messages_message_index ON mail_messages(message_id);
    CREATE TABLE IF NOT EXISTS mail_suppression (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_inbound (
      message_id TEXT PRIMARY KEY,
      sequence_id TEXT,
      kind TEXT NOT NULL,
      sender TEXT,
      subject TEXT,
      snippet TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

export function readMailState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM mail_state WHERE key = ?').get(key)
  return row ? JSON.parse(row.value) : fallback
}

export function writeMailState(db, key, value) {
  db.prepare('INSERT INTO mail_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

// Wall-clock parts in the recipients' time zone.
export function localClock(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date).map((p) => [p.type, p.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday }
}

export function inSendWindow(date, sending) {
  const clock = localClock(date, sending.timezone)
  if (sending.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return false
  return clock.hour >= sending.windowStartHour && clock.hour < sending.windowEndHour
}

export const normalizeEmail = (value) => String(value || '').trim().toLowerCase()
const domainOf = (email) => normalizeEmail(email).split('@')[1] || ''

export function leadEmail(lead) {
  const candidates = [lead?.qualification?.contact?.email, lead?.email]
  for (const value of candidates) {
    const email = normalizeEmail(value)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email
  }
  return null
}

export function isSuppressed(db, email) {
  return Boolean(db.prepare('SELECT 1 FROM mail_suppression WHERE email = ?').get(normalizeEmail(email)))
}

export function suppress(db, email, reason, source, now = new Date()) {
  const key = normalizeEmail(email)
  if (!key) return false
  db.prepare('INSERT OR IGNORE INTO mail_suppression (email, reason, source, created_at) VALUES (?, ?, ?, ?)').run(key, reason, source, now.toISOString())
  // Anything still queued for this address stops now.
  db.prepare(`UPDATE mail_sequences SET status = 'stopped', stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE email = ? AND status IN ('pending','approved','active')`)
    .run(`Suppressed: ${reason}`, now.toISOString(), key)
  return true
}

function observationFor(lead) {
  const raw = lead?.mainIssue || (lead?.problems || [])[0] || (lead?.qualification?.pitchHooks || [])[0] || ''
  return String(raw).replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
}

function lowerFirst(text) { return text ? text.charAt(0).toLowerCase() + text.slice(1) : text }

// The first email: the selected human-reviewed draft when one exists,
// otherwise the evidence-only channel draft. Follow-ups reference only the
// same observation and the configured call to action.
export function composeSequence(lead, { offer = null } = {}) {
  const resolved = resolveOffer(offer)
  const observation = observationFor(lead)
  const reviewed = typeof lead.outreachDraft === 'string' && lead.outreachDraft.trim() && lead.outreachStatus !== 'Insufficient evidence'
  const body = reviewed ? lead.outreachDraft.trim() : buildChannelDrafts(lead, { observation: observation || null, offer: resolved }).email
  const subject = String(lead.outreachSubject || '').trim() || `Quick note about ${lead.company}'s website`
  const cta = String(resolved.callToAction || DEFAULT_OFFER.callToAction).trim()
  const detail = observation ? ` (${lowerFirst(observation)})` : ''
  const followups = [
    `Hi, following up on my note from earlier this week about ${lead.company}'s website${detail}. ${cta}`,
    "Hi, this is my last note on this. If the website isn't a priority right now, no problem, and I won't follow up again. If it is, just reply and I'll send the outline.",
  ]
  assertNoInventedClaims(subject, 'email subject')
  assertNoInventedClaims(body, 'initial email')
  followups.forEach((text, index) => assertNoInventedClaims(text, `follow-up ${index + 1}`))
  return { subject, body, followups, observation: observation || null }
}

export function unsubscribeUrl(mailer, token) {
  return mailer.publicUrl ? `${mailer.publicUrl}/u/${token}` : null
}

// Adds the signature and the CAN-SPAM footer: who is sending, a postal
// address and a working way to opt out.
export function renderEmail(body, { sending, mailer, token }) {
  const signature = String(sending.signature || '').trim()
  const link = unsubscribeUrl(mailer, token)
  const lines = [String(body).trim()]
  if (signature) lines.push('', signature)
  lines.push('', '--', mailer.physicalAddress || '[sender postal address not configured]')
  lines.push('Not useful? Reply "unsubscribe" and I will not email you again.')
  if (link) lines.push(`Or opt out with one click: ${link}`)
  return lines.join('\n')
}

export function listUnsubscribeHeaders(mailer, token) {
  const targets = []
  const link = unsubscribeUrl(mailer, token)
  if (link) targets.push(`<${link}>`)
  if (mailer.replyTo?.address) targets.push(`<mailto:${mailer.replyTo.address}?subject=unsubscribe>`)
  const headers = {}
  if (targets.length) headers['List-Unsubscribe'] = targets.join(', ')
  if (link) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  return headers
}

const parseSequence = (row) => row ? { ...row, followups: JSON.parse(row.followups || '[]') } : null

export function readSequence(db, id) {
  return parseSequence(db.prepare('SELECT * FROM mail_sequences WHERE id = ?').get(id))
}

// Why a lead can or cannot be queued. MX must be confirmed, not just unknown.
export async function checkEligibility(db, lead, { mxCheck = checkMx, offer = null } = {}) {
  const email = leadEmail(lead)
  if (!email) return { ok: false, reason: 'No email address' }
  if (lead.doNotContact?.status) return { ok: false, reason: 'Marked do not contact' }
  if (STAGES_IN_CONVERSATION.has(lead.salesStage)) return { ok: false, reason: `Already ${lead.salesStage.toLowerCase()}` }
  if (lead.qualification?.play === 'skip') return { ok: false, reason: 'Qualification says skip' }
  if (lead.contactedAt || lead.outreachStatus === 'Contacted') return { ok: false, reason: 'Already contacted manually' }
  if (isSuppressed(db, email)) return { ok: false, reason: 'On the suppression list' }
  const existing = db.prepare(`SELECT status FROM mail_sequences WHERE (lead_id = ? OR email = ?) AND status != 'rejected' LIMIT 1`).get(lead.id, email)
  if (existing) return { ok: false, reason: `Already in the queue (${existing.status})` }
  const domain = domainOf(email)
  if (!FREE_MAIL.has(domain)) {
    const sameDomain = db.prepare(`SELECT company FROM mail_sequences WHERE email LIKE ? AND status != 'rejected' LIMIT 1`).get(`%@${domain}`)
    if (sameDomain) return { ok: false, reason: `Someone at ${domain} is already queued (${sameDomain.company})` }
  }
  let composed
  try { composed = composeSequence(lead, { offer }) } catch (error) { return { ok: false, reason: error.message } }
  const mx = await mxCheck(domain)
  if (mx?.deliverable !== true) return { ok: false, reason: `Mail server for ${domain} not confirmed (${mx?.reason || 'MX unknown'})` }
  return { ok: true, email, composed }
}

export async function enqueueLead(db, lead, { sending, offer = null, mxCheck = checkMx, now = new Date() } = {}) {
  const check = await checkEligibility(db, lead, { mxCheck, offer })
  if (!check.ok) return { queued: false, leadId: lead.id, company: lead.company, reason: check.reason }
  const priority = Number(lead.qualification?.priority ?? lead.opportunityScore ?? 0) || 0
  const auto = sending?.autoApprove && priority >= sending.autoApproveMinPriority
  const at = now.toISOString()
  const id = `seq-${randomUUID()}`
  db.prepare(`INSERT INTO mail_sequences (id, lead_id, email, company, status, step, priority, subject, body, followups, token, approved_at, approved_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, lead.id, check.email, String(lead.company || ''), auto ? 'approved' : 'pending', priority, check.composed.subject, check.composed.body, JSON.stringify(check.composed.followups), randomBytes(18).toString('base64url'), auto ? at : null, auto ? 'auto' : null, at, at)
  return { queued: true, leadId: lead.id, company: lead.company, sequenceId: id, status: auto ? 'approved' : 'pending' }
}

// Fills the review queue from qualified leads, best priority first.
export async function buildBatch(db, leads, { sending, offer = null, mxCheck = checkMx, now = new Date(), limit = null } = {}) {
  const max = limit ?? sending.batchSize
  const candidates = leads
    .filter((lead) => lead.qualification && lead.qualification.play !== 'skip' && leadEmail(lead))
    .sort((a, b) => (b.qualification.priority || 0) - (a.qualification.priority || 0))
  const queued = []
  const skipped = []
  for (const lead of candidates) {
    if (queued.length >= max) break
    const result = await enqueueLead(db, lead, { sending, offer, mxCheck, now })
    if (result.queued) queued.push(result)
    else skipped.push(result)
  }
  return { queued, skipped }
}

export function approveSequences(db, ids, { by = 'user', now = new Date() } = {}) {
  const stmt = db.prepare(`UPDATE mail_sequences SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
  let changed = 0
  for (const id of ids) changed += stmt.run(now.toISOString(), by, now.toISOString(), id).changes
  return changed
}

export function rejectSequences(db, ids, { now = new Date() } = {}) {
  const stmt = db.prepare(`UPDATE mail_sequences SET status = 'rejected', stop_reason = 'Rejected in review', updated_at = ? WHERE id = ? AND status IN ('pending','approved')`)
  let changed = 0
  for (const id of ids) changed += stmt.run(now.toISOString(), id).changes
  return changed
}

export function stopSequence(db, id, reason, { now = new Date() } = {}) {
  return db.prepare(`UPDATE mail_sequences SET status = 'stopped', stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','approved','active')`)
    .run(reason, now.toISOString(), id).changes
}

export function updateSequenceDraft(db, id, { subject, body }, { now = new Date() } = {}) {
  const seq = readSequence(db, id)
  if (!seq) throw Object.assign(new Error('Sequence not found'), { status: 404 })
  if (!['pending', 'approved'].includes(seq.status)) throw Object.assign(new Error('Only unsent emails can be edited'), { status: 409 })
  const nextSubject = subject == null ? seq.subject : String(subject).trim()
  const nextBody = body == null ? seq.body : String(body).trim()
  if (!nextSubject || !nextBody) throw Object.assign(new Error('Subject and body are required'), { status: 400 })
  assertNoInventedClaims(nextSubject, 'email subject')
  assertNoInventedClaims(nextBody, 'initial email')
  db.prepare('UPDATE mail_sequences SET subject = ?, body = ?, updated_at = ? WHERE id = ?').run(nextSubject, nextBody, now.toISOString(), id)
  return readSequence(db, id)
}

export function sentOnDay(db, day) {
  return db.prepare(`SELECT COUNT(*) AS n FROM mail_messages WHERE send_day = ? AND status IN ('sent','dry-run')`).get(day).n
}

function autoApprovePending(db, sending, now) {
  if (!sending.autoApprove) return 0
  return db.prepare(`UPDATE mail_sequences SET status = 'approved', approved_at = ?, approved_by = 'auto', updated_at = ? WHERE status = 'pending' AND priority >= ?`)
    .run(now.toISOString(), now.toISOString(), sending.autoApproveMinPriority).changes
}

function nextDue(db, now) {
  // Follow-ups first: a thread already started matters more than a new one.
  const followup = db.prepare(`SELECT * FROM mail_sequences WHERE status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT 1`).get(now.toISOString())
  if (followup) return parseSequence(followup)
  return parseSequence(db.prepare(`SELECT * FROM mail_sequences WHERE status = 'approved' ORDER BY priority DESC, approved_at ASC LIMIT 1`).get())
}

function messageIdFor(seq, step, mailer) {
  const domain = mailer.from?.address?.split('@')[1] || 'scoutline.local'
  return `<scoutline.${seq.id.replace(/^seq-/, '')}.${step}.${randomBytes(4).toString('hex')}@${domain}>`
}

const DAY_MS = 86_400_000

// Mailbox providers start filtering a domain whose bounce rate climbs past a
// few percent, so sending halts once 5% of 20+ contacted leads bounced.
export function bounceGuardTripped(db) {
  const contacted = db.prepare('SELECT COUNT(*) AS n FROM mail_sequences WHERE step > 0').get().n
  if (contacted < 20) return false
  const bounced = db.prepare(`SELECT COUNT(*) AS n FROM mail_sequences WHERE status = 'bounced'`).get().n
  return bounced / contacted > 0.05
}

// One send per call. The scheduler calls this every few seconds; spacing,
// the window and the daily cap decide whether anything goes out.
export async function runSendTick(db, { sending, mailer, transport, readLead = () => null, onLeadEvent = () => {}, now = new Date(), random = Math.random }) {
  if (!sending.enabled) return { skipped: 'paused' }
  if (!inSendWindow(now, sending)) return { skipped: 'outside-window' }
  const nextSlot = readMailState(db, 'nextSlotAt')
  if (nextSlot && now < new Date(nextSlot)) return { skipped: 'spacing', nextSlotAt: nextSlot }
  const day = localClock(now, sending.timezone).day
  if (sentOnDay(db, day) >= sending.dailyCap) return { skipped: 'daily-cap' }
  if (bounceGuardTripped(db)) return { skipped: 'bounce-guard' }
  autoApprovePending(db, sending, now)
  const seq = nextDue(db, now)
  if (!seq) return { skipped: 'empty' }

  const at = now.toISOString()
  const lead = readLead(seq.lead_id)
  const stopReason = isSuppressed(db, seq.email) ? 'On the suppression list'
    : !lead ? 'Lead was deleted'
      : lead.doNotContact?.status ? 'Marked do not contact'
        : STAGES_IN_CONVERSATION.has(lead.salesStage) ? `Lead moved to ${lead.salesStage}`
          : null
  if (stopReason) {
    stopSequence(db, seq.id, stopReason, { now })
    return { skipped: 'stopped', sequenceId: seq.id, reason: stopReason }
  }

  const step = seq.step + 1
  const isFollowup = step > 1
  const bodyText = isFollowup ? seq.followups[step - 2] : seq.body
  if (!bodyText) {
    db.prepare(`UPDATE mail_sequences SET status = 'completed', next_send_at = NULL, updated_at = ? WHERE id = ?`).run(at, seq.id)
    return { skipped: 'completed', sequenceId: seq.id }
  }
  const previous = db.prepare(`SELECT message_id FROM mail_messages WHERE sequence_id = ? AND status IN ('sent','dry-run') ORDER BY step ASC`).all(seq.id).map((row) => row.message_id)
  const message = {
    to: seq.email,
    subject: isFollowup ? `Re: ${seq.subject}` : seq.subject,
    text: renderEmail(bodyText, { sending, mailer, token: seq.token }),
    messageId: messageIdFor(seq, step, mailer),
    inReplyTo: previous.at(-1) || null,
    references: previous,
    headers: listUnsubscribeHeaders(mailer, seq.token),
  }
  const gapMinutes = sending.minGapMinutes + random() * (sending.maxGapMinutes - sending.minGapMinutes)
  writeMailState(db, 'nextSlotAt', new Date(now.getTime() + gapMinutes * 60_000).toISOString())

  const record = (status, error = null) => db.prepare(`INSERT INTO mail_messages (id, sequence_id, lead_id, step, message_id, recipient, subject, body, status, transport, send_day, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`msg-${randomUUID()}`, seq.id, seq.lead_id, step, message.messageId, message.to, message.subject, message.text, status, transport.kind, day, error, at)

  try {
    const result = await transport.send(message)
    const status = result?.dryRun ? 'dry-run' : 'sent'
    record(status)
    const firstSentAt = seq.first_sent_at || at
    const offset = sending.followupDays[step - 1]
    const hasNext = step <= seq.followups.length && offset != null
    const nextSendAt = hasNext ? new Date(new Date(firstSentAt).getTime() + offset * DAY_MS).toISOString() : null
    db.prepare(`UPDATE mail_sequences SET status = ?, step = ?, attempts = 0, first_sent_at = ?, last_sent_at = ?, next_send_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(hasNext ? 'active' : 'completed', step, firstSentAt, at, nextSendAt, at, seq.id)
    onLeadEvent(seq.lead_id, 'sent', { sequenceId: seq.id, step, to: seq.email, subject: message.subject, dryRun: status === 'dry-run', at })
    return { sent: true, status, sequenceId: seq.id, step, to: seq.email, messageId: message.messageId }
  } catch (error) {
    record('failed', String(error?.message || error).slice(0, 500))
    const attempts = seq.attempts + 1
    const failed = attempts >= MAX_SEND_ATTEMPTS
    db.prepare(`UPDATE mail_sequences SET attempts = ?, last_error = ?, status = ?, stop_reason = ?, updated_at = ? WHERE id = ?`)
      .run(attempts, String(error?.message || error).slice(0, 500), failed ? 'failed' : seq.status, failed ? 'Send failed 3 times' : seq.stop_reason, at, seq.id)
    return { sent: false, error: String(error?.message || error), sequenceId: seq.id, step }
  }
}

// --- Inbound: replies, bounces, opt-outs -----------------------------------

function quotedCut(text) {
  const value = String(text || '')
  const lines = value.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From:\s/.test(line)) break
    out.push(line)
  }
  return out.join('\n').trim()
}

// msg: { messageId, inReplyTo, references[], from, subject, text, headers{lowercase}, contentType }
export function classifyInbound(msg) {
  const headers = msg.headers || {}
  const from = normalizeEmail(msg.from)
  const subject = String(msg.subject || '')
  const text = String(msg.text || '')
  const contentType = String(msg.contentType || headers['content-type'] || '').toLowerCase()
  const isBounce = /^(mailer-daemon|postmaster|mail-daemon|mail-delivery)/i.test(from.split('@')[0] || '') ||
    (contentType.includes('multipart/report') && contentType.includes('delivery-status')) ||
    /^(undeliverable|undelivered mail|delivery status notification \(failure\)|mail delivery failed|failure notice|returned mail)/i.test(subject)
  if (isBounce) {
    const status = text.match(/Status:\s*([245])\.\d{1,3}\.\d{1,3}/i)?.[1]
    const recipient = normalizeEmail(text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+)/i)?.[1] || headers['x-failed-recipients'] || text.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+)/i)?.[1] || '')
    if (status === '2') return { kind: 'ignored', reason: 'delivery report' }
    return { kind: status === '4' ? 'soft-bounce' : 'bounce', recipient: recipient || null }
  }
  const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase()
  const precedence = String(headers.precedence || '').toLowerCase()
  if ((autoSubmitted && autoSubmitted !== 'no') || headers['x-autoreply'] || headers['x-autorespond'] || ['auto_reply', 'bulk', 'junk', 'list'].includes(precedence) ||
    /^(automatic reply|auto(-|\s)?reply|autoreply|out of (the )?office|ooo\b|away from)/i.test(subject)) {
    return { kind: 'auto-reply' }
  }
  const fresh = quotedCut(text)
  if (/^\s*unsubscribe\b/i.test(subject) || /\b(unsubscribe|remove me|stop emailing|do not (email|contact) me|don'?t (email|contact) me|take me off)\b/i.test(fresh.slice(0, 500))) {
    return { kind: 'unsubscribe', snippet: fresh.slice(0, 280) }
  }
  return { kind: 'reply', snippet: fresh.slice(0, 280) }
}

function findSequenceFor(db, msg, classification) {
  const ids = new Set([msg.inReplyTo, ...(msg.references || [])].filter(Boolean).map((id) => String(id).trim()))
  for (const match of String(msg.text || '').matchAll(/<scoutline\.[^>\s]+>/g)) ids.add(match[0])
  for (const id of ids) {
    const row = db.prepare('SELECT sequence_id FROM mail_messages WHERE message_id = ? LIMIT 1').get(id)
    if (row) return readSequence(db, row.sequence_id)
  }
  const address = classification.kind.endsWith('bounce') ? classification.recipient : normalizeEmail(msg.from)
  if (!address) return null
  return parseSequence(db.prepare(`SELECT * FROM mail_sequences WHERE email = ? AND step > 0 ORDER BY last_sent_at DESC LIMIT 1`).get(address))
}

export function handleInbound(db, msg, { onLeadEvent = () => {}, now = new Date() } = {}) {
  const key = String(msg.messageId || '').trim() || `no-id:${normalizeEmail(msg.from)}:${msg.subject}:${String(msg.text || '').slice(0, 80)}`
  if (db.prepare('SELECT 1 FROM mail_inbound WHERE message_id = ?').get(key)) return { duplicate: true }
  const classification = classifyInbound(msg)
  const seq = classification.kind === 'ignored' ? null : findSequenceFor(db, msg, classification)
  const at = now.toISOString()
  db.prepare('INSERT INTO mail_inbound (message_id, sequence_id, kind, sender, subject, snippet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, seq?.id || null, seq ? classification.kind : `unmatched-${classification.kind}`, normalizeEmail(msg.from), String(msg.subject || '').slice(0, 300), classification.snippet || null, at)
  if (!seq) return { kind: classification.kind, matched: false }

  const finish = (status, reason) => db.prepare(`UPDATE mail_sequences SET status = ?, stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('unsubscribed','bounced')`)
    .run(status, reason, at, seq.id)
  if (classification.kind === 'reply') {
    finish('replied', 'They replied')
    onLeadEvent(seq.lead_id, 'replied', { sequenceId: seq.id, from: normalizeEmail(msg.from), subject: msg.subject || '', snippet: classification.snippet || '', at })
  } else if (classification.kind === 'unsubscribe') {
    suppress(db, seq.email, 'Asked to unsubscribe', 'reply', now)
    finish('unsubscribed', 'Asked to unsubscribe')
    onLeadEvent(seq.lead_id, 'unsubscribed', { sequenceId: seq.id, via: 'reply', at })
  } else if (classification.kind === 'bounce') {
    suppress(db, seq.email, 'Hard bounce', 'bounce', now)
    finish('bounced', 'Email bounced')
    onLeadEvent(seq.lead_id, 'bounced', { sequenceId: seq.id, email: seq.email, at })
  }
  // Soft bounces and auto-replies are logged only; the sequence continues.
  return { kind: classification.kind, matched: true, sequenceId: seq.id }
}

export function unsubscribeByToken(db, token, { onLeadEvent = () => {}, now = new Date() } = {}) {
  const seq = parseSequence(db.prepare('SELECT * FROM mail_sequences WHERE token = ?').get(String(token || '')))
  if (!seq) return null
  suppress(db, seq.email, 'Opted out with the link', 'link', now)
  db.prepare(`UPDATE mail_sequences SET status = 'unsubscribed', stop_reason = 'Opted out with the link', next_send_at = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('replied','bounced','unsubscribed')`)
    .run(now.toISOString(), seq.id)
  onLeadEvent(seq.lead_id, 'unsubscribed', { sequenceId: seq.id, via: 'link', at: now.toISOString() })
  return { email: seq.email }
}

// Dry-run sends never reach anyone, so before going live their sequences go
// back to the review queue as if never sent. Real sends are never touched.
export function resetDryRun(db, { now = new Date() } = {}) {
  const at = now.toISOString()
  const reset = db.transaction(() => {
    const ids = db.prepare(`SELECT DISTINCT sequence_id FROM mail_messages WHERE status = 'dry-run'
      AND sequence_id NOT IN (SELECT sequence_id FROM mail_messages WHERE status = 'sent')`).all().map((row) => row.sequence_id)
    const back = db.prepare(`UPDATE mail_sequences SET status = 'pending', step = 0, first_sent_at = NULL, last_sent_at = NULL, next_send_at = NULL, approved_at = NULL, approved_by = NULL, stop_reason = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('replied','bounced','unsubscribed')`)
    let sequences = 0
    for (const id of ids) sequences += back.run(at, id).changes
    const messages = db.prepare(`DELETE FROM mail_messages WHERE status = 'dry-run'`).run().changes
    db.prepare(`DELETE FROM mail_state WHERE key = 'nextSlotAt'`).run()
    return { sequences, messages }
  })
  return reset()
}

// --- Read models for the UI -----------------------------------------------

export function listSequences(db, { status = null, limit = 200 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM mail_sequences WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM mail_sequences ORDER BY updated_at DESC LIMIT ?').all(limit)
  return rows.map(parseSequence)
}

export function mailStats(db, { sending, now = new Date() }) {
  const byStatus = Object.fromEntries(SEQUENCE_STATUSES.map((status) => [status, 0]))
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM mail_sequences GROUP BY status').all()) byStatus[row.status] = row.n
  const day = localClock(now, sending.timezone).day
  const messages = db.prepare(`SELECT status, COUNT(*) AS n FROM mail_messages GROUP BY status`).all()
  const totalOut = messages.filter((m) => m.status === 'sent' || m.status === 'dry-run').reduce((sum, m) => sum + m.n, 0)
  const contacted = db.prepare('SELECT COUNT(*) AS n FROM mail_sequences WHERE step > 0').get().n
  return {
    day,
    sentToday: sentOnDay(db, day),
    dailyCap: sending.dailyCap,
    emailsSent: totalOut,
    dryRunEmails: messages.find((m) => m.status === 'dry-run')?.n || 0,
    failedSends: messages.find((m) => m.status === 'failed')?.n || 0,
    contacted,
    pending: byStatus.pending,
    approved: byStatus.approved,
    active: byStatus.active,
    completed: byStatus.completed,
    replied: byStatus.replied,
    bounced: byStatus.bounced,
    unsubscribed: byStatus.unsubscribed,
    suppressed: db.prepare('SELECT COUNT(*) AS n FROM mail_suppression').get().n,
    replyRate: contacted ? Math.round((byStatus.replied / contacted) * 1000) / 10 : 0,
    bounceRate: contacted ? Math.round((byStatus.bounced / contacted) * 1000) / 10 : 0,
    inWindow: inSendWindow(now, sending),
    bounceGuard: bounceGuardTripped(db),
    nextSlotAt: readMailState(db, 'nextSlotAt'),
    byStatus,
  }
}
