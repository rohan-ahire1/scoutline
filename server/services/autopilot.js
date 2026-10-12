// Email autopilot engine: stores each lead's sequence, plans the day's batch,
// sends what is due, and stops a sequence when the lead replies or bounces.
// The worker process calls tick() every minute; the web process only reads
// and edits state through the routes.

import { randomUUID } from 'node:crypto'
import {
  bounceGuard, bouncedAddresses, contentHash, DEFAULT_TIMEZONE, followUpAt, ineligibleReason, inWindow, isApproved, isAutoReply,
  isOptOut, localDay, MAX_DAILY_SENDS, MIN_GAP_MINUTES, nextSendDay, nextWindowAt, normalizeAutopilot, pickNewLeads, planSlots, renderStep, templateProblems,
  TEMPLATE_VARIABLES, timezoneFor,
} from './sender.js'
import { domainAcceptsMail } from './mailbox.js'

const SCAN_EVERY_MS = 10 * 60_000
const SCAN_DAYS = 30
const SEND_RETRY_MS = 30 * 60_000
const MAX_SEND_ATTEMPTS = 3
// Statuses that still need a send or a reply check.
const LIVE = ['queued', 'active', 'finished']
const STOPPED = ['replied', 'opted-out', 'bounced', 'stopped', 'skipped', 'failed']

export function ensureAutopilotSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_emails (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      batch_day TEXT,
      time_zone TEXT NOT NULL,
      first_sent_at TEXT,
      last_sent_at TEXT,
      thread_message_id TEXT,
      message_ids TEXT NOT NULL DEFAULT '[]',
      overrides TEXT NOT NULL DEFAULT '{}',
      history TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS autopilot_due_index ON autopilot_emails(status, next_at);
    CREATE INDEX IF NOT EXISTS autopilot_email_index ON autopilot_emails(email);
    CREATE INDEX IF NOT EXISTS autopilot_lead_index ON autopilot_emails(lead_id);
  `)
}

function parseRow(row) {
  if (!row) return null
  return {
    id: row.id, leadId: row.lead_id, email: row.email, status: row.status, step: row.step, nextAt: row.next_at,
    batchDay: row.batch_day, timeZone: row.time_zone, firstSentAt: row.first_sent_at, lastSentAt: row.last_sent_at,
    threadMessageId: row.thread_message_id, messageIds: JSON.parse(row.message_ids || '[]'),
    overrides: JSON.parse(row.overrides || '{}'), history: JSON.parse(row.history || '[]'),
    attempts: row.attempts, error: row.error, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function createAutopilot({ db, mailbox, readLead, saveLead, readLeads, recordEvent = () => {}, notifier = null, now = () => Date.now(), checkMx = domainAcceptsMail, log = console }) {
  ensureAutopilotSchema(db)
  const iso = (ms = now()) => new Date(ms).toISOString()
  let busy = false
  let lastScanAt = 0

  // ---- state
  function readConfig() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'autopilot'").get()
    return normalizeAutopilot(row ? JSON.parse(row.value) : {})
  }
  function writeConfig(config) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('autopilot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(config))
    return config
  }
  const getRow = (id) => parseRow(db.prepare('SELECT * FROM autopilot_emails WHERE id = ?').get(id))
  const rowsWhere = (sql, ...args) => db.prepare(`SELECT * FROM autopilot_emails ${sql}`).all(...args).map(parseRow)
  function updateRow(id, patch) {
    const map = {
      status: 'status', step: 'step', nextAt: 'next_at', firstSentAt: 'first_sent_at', lastSentAt: 'last_sent_at',
      threadMessageId: 'thread_message_id', attempts: 'attempts', error: 'error', reason: 'reason', batchDay: 'batch_day',
    }
    const sets = ['updated_at = ?']
    const values = [iso()]
    for (const [key, column] of Object.entries(map)) if (key in patch) { sets.push(`${column} = ?`); values.push(patch[key]) }
    for (const key of ['messageIds', 'overrides', 'history']) if (key in patch) { sets.push(`${key === 'messageIds' ? 'message_ids' : key} = ?`); values.push(JSON.stringify(patch[key])) }
    db.prepare(`UPDATE autopilot_emails SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return getRow(id)
  }
  function addHistory(row, entry) {
    return [...row.history, { at: iso(), ...entry }]
  }
  function insertRow({ lead, status, nextAt = null, batchDay = null, reason = null }) {
    const id = `ap-${randomUUID().slice(0, 12)}`
    db.prepare(`INSERT INTO autopilot_emails (id, lead_id, email, status, step, next_at, batch_day, time_zone, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(id, lead.id, String(lead.qualification.contact.email).toLowerCase(), status, nextAt, batchDay, timezoneFor(lead), reason, iso(), iso())
    return getRow(id)
  }

  function knownEmails() {
    const enrolled = new Set()
    const suppressed = new Set()
    for (const row of db.prepare('SELECT email, status FROM autopilot_emails').all()) {
      enrolled.add(row.email)
      if (['replied', 'opted-out', 'bounced'].includes(row.status)) suppressed.add(row.email)
    }
    return { enrolledEmails: enrolled, suppressed }
  }
  const enrolledLeadIds = () => new Set(db.prepare('SELECT lead_id FROM autopilot_emails').all().map((row) => row.lead_id))

  function setLeadAutopilot(leadId, patch, extra = {}) {
    const lead = readLead(leadId)
    if (!lead) return null
    return saveLead({ ...lead, ...extra, autopilot: { ...(lead.autopilot || {}), ...patch, updatedAt: iso() } })
  }

  // ---- planning
  function targetDay(config, at = now()) {
    return nextSendDay(localDay(at, DEFAULT_TIMEZONE), config.window, { now: at, timeZone: DEFAULT_TIMEZONE })
  }

  function candidates(config, limit) {
    const known = knownEmails()
    const enrolled = enrolledLeadIds()
    return pickNewLeads(readLeads(), { limit, ...known, skipped: enrolled })
  }

  // Queues the next sending day's new emails, once per day. Runs as soon as
  // the previous window closes, so tomorrow's batch can be reviewed tonight.
  async function planBatch(config) {
    const day = targetDay(config)
    // First emails that never went out (autopilot was off) move to this day.
    const carried = rowsWhere("WHERE status = 'queued' AND step = 0 AND batch_day < ?", day)
    for (const row of carried) updateRow(row.id, { batchDay: day })
    const already = db.prepare("SELECT COUNT(*) AS count FROM autopilot_emails WHERE batch_day = ? AND (status = 'queued' OR first_sent_at IS NOT NULL)").get(day).count
    const wanted = config.dailyNew - already
    if (wanted <= 0) {
      if (carried.length) reslot(day, config)
      return []
    }
    const picked = []
    const known = knownEmails()
    const skip = enrolledLeadIds()
    // Look a little past the limit: some addresses fail the MX check.
    for (const lead of pickNewLeads(readLeads(), { limit: wanted * 3, ...known, skipped: skip })) {
      if (picked.length >= wanted) break
      let ok = true
      try { ok = await checkMx(lead.qualification.contact.email) } catch { ok = true }
      if (!ok) {
        insertRow({ lead, status: 'skipped', reason: 'Email domain cannot receive mail' })
        continue
      }
      picked.push(lead)
    }
    const created = picked.map((lead) => {
      setLeadAutopilot(lead.id, { status: 'queued', step: 0 })
      return insertRow({ lead, status: 'queued', batchDay: day })
    })
    if (created.length || carried.length) reslot(day, config)
    if (created.length) recordEvent('autopilot', day, 'autopilot_planned', { count: created.length })
    return created
  }

  // Spreads the day's unsent first emails across what is left of the window,
  // best lead first.
  function reslot(day, config) {
    const rows = rowsWhere("WHERE batch_day = ? AND status = 'queued' AND step = 0", day)
      .map((row) => ({ row, priority: readLead(row.leadId)?.qualification?.priority ?? 0 }))
      .sort((a, b) => b.priority - a.priority)
    const byZone = new Map()
    for (const item of rows) byZone.set(item.row.timeZone, [...(byZone.get(item.row.timeZone) || []), item.row])
    for (const [timeZone, group] of byZone) {
      const slots = planSlots(day, group.length, { window: config.window, timeZone, now: now(), seed: `${day}:${timeZone}` })
      group.forEach((row, index) => updateRow(row.id, { nextAt: iso(slots[index]) }))
    }
  }

  // ---- sending
  function sentTodayCount(timeZone = DEFAULT_TIMEZONE) {
    const today = localDay(now(), timeZone)
    return rowsWhere('WHERE last_sent_at IS NOT NULL')
      .reduce((sum, row) => sum + row.history.filter((item) => item.type === 'sent' && localDay(Date.parse(item.at), timeZone) === today).length, 0)
  }

  async function sendDue(config) {
    if (sentTodayCount() >= MAX_DAILY_SENDS) return null
    const due = rowsWhere("WHERE status IN ('queued', 'active') AND next_at <= ? ORDER BY next_at LIMIT 1", iso())[0]
    if (!due) return null
    // Never send outside the lead's morning window (e.g. after the autopilot
    // was off for a while): move it to the next window instead.
    if (!inWindow(now(), config.window, due.timeZone)) {
      return updateRow(due.id, { nextAt: iso(nextWindowAt(now(), config.window, due.timeZone, 5 + Math.floor(Math.random() * 40))) })
    }
    const lastSend = db.prepare('SELECT MAX(last_sent_at) AS at FROM autopilot_emails').get().at
    if (lastSend && now() - Date.parse(lastSend) < MIN_GAP_MINUTES * 60_000 / 2) return null
    const lead = readLead(due.leadId)
    if (!lead) return updateRow(due.id, { status: 'stopped', reason: 'Lead was deleted', nextAt: null })
    // A lead handled by hand since it was queued is left alone.
    if (due.step === 0) {
      const reason = ineligibleReason({ ...lead, autopilot: null }, { suppressed: knownEmails().suppressed })
      if (reason || String(lead.qualification?.contact?.email || '').toLowerCase() !== due.email) {
        setLeadAutopilot(lead.id, { status: 'stopped' })
        return updateRow(due.id, { status: 'stopped', reason: reason || 'Email address changed', nextAt: null })
      }
    } else if (['Replied', 'Meeting', 'Proposal', 'Won', 'Lost'].includes(lead.salesStage)) {
      setLeadAutopilot(lead.id, { status: 'stopped' })
      return updateRow(due.id, { status: 'stopped', reason: `Moved to ${lead.salesStage} by hand`, nextAt: null })
    }

    const claimed = db.prepare("UPDATE autopilot_emails SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('queued', 'active')").run(iso(), due.id).changes
    if (!claimed) return null
    let email
    try {
      email = renderStep(config, due.step, lead, { overrides: due.overrides })
    } catch (error) {
      setLeadAutopilot(lead.id, { status: 'stopped' })
      return updateRow(due.id, { status: 'failed', reason: `Couldn't write the email: ${error.message}`, nextAt: null })
    }
    try {
      const sent = await mailbox.send({ to: due.email, subject: email.subject, text: email.text, inReplyTo: due.step ? due.threadMessageId : null, references: due.messageIds })
      const at = now()
      const firstSentAt = due.firstSentAt || iso(at)
      const nextIndex = due.step + 1
      const more = nextIndex < config.sequence.length
      const row = updateRow(due.id, {
        status: more ? 'active' : 'finished',
        step: nextIndex,
        firstSentAt,
        lastSentAt: iso(at),
        threadMessageId: due.threadMessageId || sent.messageId,
        messageIds: [...due.messageIds, sent.messageId],
        nextAt: more ? iso(followUpAt(Date.parse(firstSentAt), config.sequence[nextIndex].delayDays, { window: config.window, timeZone: due.timeZone, now: at })) : null,
        attempts: 0,
        error: null,
        history: addHistory(due, { type: 'sent', step: due.step, subject: email.subject, messageId: sent.messageId }),
      })
      const label = due.step === 0 ? 'Email 1' : `Follow-up ${due.step}`
      const fresh = readLead(lead.id)
      saveLead({
        ...fresh,
        autopilot: { ...(fresh.autopilot || {}), status: more ? 'emailed' : 'sequence done', step: nextIndex, lastSentAt: iso(at), updatedAt: iso(at) },
        contactAttempts: [...(fresh.contactAttempts || []), { id: `att-${randomUUID().slice(0, 8)}`, channel: 'email', contact: due.email, outcome: 'other', notes: `Autopilot: ${label} sent`, at: iso(at) }],
        lastOutreachAt: iso(at),
      })
      recordEvent('lead', lead.id, 'autopilot_sent', { step: due.step, email: due.email })
      return row
    } catch (error) {
      const attempts = due.attempts + 1
      const authFailed = /auth|credentials|535|534|username and password/i.test(String(error.message))
      log.error?.(`autopilot: send to ${due.email} failed`, error.message)
      if (authFailed) {
        writeConfig({ ...readConfig(), running: false })
        notifier?.send(`Email autopilot paused: Gmail refused the login (${String(error.message).slice(0, 120)}). Check GMAIL_APP_PASSWORD.`)
      }
      const giveUp = attempts >= MAX_SEND_ATTEMPTS
      if (giveUp) setLeadAutopilot(lead.id, { status: 'failed' })
      return updateRow(due.id, {
        status: giveUp ? 'failed' : due.step ? 'active' : 'queued',
        attempts,
        error: String(error.message).slice(0, 300),
        reason: giveUp ? 'Gmail kept refusing this email' : null,
        nextAt: giveUp ? null : iso(now() + SEND_RETRY_MS),
      })
    }
  }

  // ---- replies and bounces
  async function scan({ force = false } = {}) {
    if (!mailbox.configured) return null
    if (!force && now() - lastScanAt < SCAN_EVERY_MS) return null
    const since = iso(now() - SCAN_DAYS * 86_400_000)
    const watched = rowsWhere("WHERE status IN ('active', 'finished', 'sending') AND first_sent_at IS NOT NULL AND first_sent_at >= ?", since)
    lastScanAt = now()
    if (!watched.length) return { replies: 0, bounces: 0 }
    const result = await mailbox.scan({ addresses: [...new Set(watched.map((row) => row.email))], sinceDays: SCAN_DAYS })
    const byEmail = new Map(watched.map((row) => [row.email, row]))
    let replies = 0
    let bounces = 0
    for (const message of result.replies) {
      if (message.from === mailbox.user) continue
      const row = byEmail.get(message.from)
      if (!row || Date.parse(message.date) <= Date.parse(row.firstSentAt)) continue
      const current = getRow(row.id)
      if (current.history.some((item) => item.uid === message.uid)) continue
      if (isAutoReply(message)) {
        updateRow(row.id, { history: addHistory(current, { type: 'auto-reply', uid: message.uid, subject: message.subject }) })
        continue
      }
      const optOut = isOptOut(message.text)
      const status = optOut ? 'opted-out' : 'replied'
      updateRow(row.id, { status, nextAt: null, history: addHistory(current, { type: status, uid: message.uid, subject: message.subject, at: message.date }) })
      byEmail.delete(message.from)
      replies += 1
      const lead = readLead(row.leadId)
      if (lead) {
        saveLead({
          ...lead,
          autopilot: { ...(lead.autopilot || {}), status, repliedAt: message.date, updatedAt: iso() },
          contactAttempts: [...(lead.contactAttempts || []), { id: `att-${randomUUID().slice(0, 8)}`, channel: 'email', contact: row.email, outcome: optOut ? 'not-interested' : 'replied', notes: `Autopilot: ${optOut ? 'asked not to be emailed' : 'replied'}`, at: message.date }],
          ...(optOut ? {} : { outreachStatus: 'Contacted', contactedAt: lead.contactedAt || message.date, salesStage: 'Replied' }),
        })
        recordEvent('lead', lead.id, optOut ? 'autopilot_opted_out' : 'autopilot_replied', { email: row.email })
        if (!optOut) notifier?.send(`${lead.company} replied to your email (${row.email}). Check Gmail.`)
      }
    }
    const candidatesList = [...byEmail.keys()]
    for (const message of result.bounces) {
      for (const email of bouncedAddresses(message, candidatesList)) {
        const row = byEmail.get(email)
        if (!row || Date.parse(message.date) <= Date.parse(row.firstSentAt)) continue
        updateRow(row.id, { status: 'bounced', nextAt: null, history: addHistory(getRow(row.id), { type: 'bounced', uid: message.uid }) })
        setLeadAutopilot(row.leadId, { status: 'bounced' })
        byEmail.delete(email)
        bounces += 1
      }
    }
    const recent = rowsWhere('WHERE first_sent_at IS NOT NULL ORDER BY first_sent_at DESC LIMIT 50')
    const guard = bounceGuard(recent)
    const config = readConfig()
    if (guard && config.running) {
      writeConfig({ ...config, running: false })
      notifier?.send(`Email autopilot paused: ${guard.bounced} of the last ${guard.sent} emails bounced. Check the list before turning it back on.`)
    }
    return { replies, bounces }
  }

  // ---- the loop
  async function tick() {
    if (busy) return
    busy = true
    try {
      try { await scan() } catch (error) { log.error?.('autopilot: mailbox scan failed', error.message) }
      const config = readConfig()
      if (!config.running || !isApproved(config) || !mailbox.configured) return
      await planBatch(config)
      // Re-read: a scan or the web app may have paused it meanwhile.
      if (readConfig().running) await sendDue(config)
    } catch (error) {
      log.error?.('autopilot tick failed', error)
    } finally {
      busy = false
    }
  }

  // A send interrupted by a crash may or may not have gone out. Never resend
  // blind: park it for a human to check the Sent folder.
  function recoverInterrupted() {
    for (const row of rowsWhere("WHERE status = 'sending'")) {
      updateRow(row.id, { status: 'failed', reason: 'Interrupted while sending. Check Gmail Sent before retrying.', nextAt: null })
    }
  }

  // ---- views for the API
  function emailView(row, config, lead = readLead(row.leadId)) {
    let preview = null
    if (lead && ['queued', 'active'].includes(row.status)) {
      try { preview = renderStep(config, row.step, lead, { overrides: row.overrides }) } catch (error) { preview = { error: error.message } }
    }
    return {
      id: row.id, leadId: row.leadId, company: lead?.company || '(deleted lead)', email: row.email, status: row.status,
      step: row.step, steps: config.sequence.length, nextAt: row.nextAt, timeZone: row.timeZone, batchDay: row.batchDay,
      firstSentAt: row.firstSentAt, lastSentAt: row.lastSentAt, overrides: row.overrides, reason: row.reason, error: row.error,
      history: row.history.slice(-6), preview, priority: lead?.qualification?.priority ?? null,
    }
  }

  function overview() {
    const config = readConfig()
    const all = rowsWhere('ORDER BY updated_at DESC')
    const counts = {}
    for (const row of all) counts[row.status] = (counts[row.status] || 0) + 1
    const sent = all.filter((row) => row.firstSentAt).length
    const upcoming = all.filter((row) => ['queued', 'active'].includes(row.status)).sort((a, b) => String(a.nextAt).localeCompare(String(b.nextAt)))
    const day = targetDay(config)
    const plannedForDay = upcoming.filter((row) => row.batchDay === day && row.status === 'queued').length
    // Before the batch is planned (or while off), show who would be next.
    const nextUp = plannedForDay ? [] : candidates(config, config.dailyNew).map((lead) => {
      let preview = null
      try { preview = renderStep(config, 0, lead) } catch (error) { preview = { error: error.message } }
      return { leadId: lead.id, company: lead.company, email: lead.qualification.contact.email, priority: lead.qualification.priority, preview }
    })
    const eligible = candidates(config, 10_000).length
    return {
      config: { ...config, approved: isApproved(config), hash: contentHash(config), problems: templateProblems(config), variables: TEMPLATE_VARIABLES },
      mailbox: { configured: mailbox.configured, user: mailbox.user || null },
      day,
      timeZone: DEFAULT_TIMEZONE,
      stats: { sent, replied: counts.replied || 0, optedOut: counts['opted-out'] || 0, bounced: counts.bounced || 0, inSequence: (counts.queued || 0) + (counts.active || 0), sentToday: sentTodayCount(), eligible },
      upcoming: upcoming.slice(0, 60).map((row) => emailView(row, config)),
      nextUp,
      recent: all.filter((row) => !['queued', 'active'].includes(row.status) || row.firstSentAt).slice(0, 40).map((row) => emailView(row, config)),
    }
  }

  // ---- edits from the web app
  function saveTemplates({ sequence, signature }) {
    const config = readConfig()
    const next = normalizeAutopilot({ ...config, ...(sequence ? { sequence } : {}), ...(signature != null ? { signature } : {}) })
    const changed = contentHash(next) !== contentHash(config)
    return writeConfig({ ...next, ...(changed ? { approvedHash: null, approvedAt: null, running: false } : {}) })
  }
  function saveSchedule({ dailyNew, window }) {
    const config = readConfig()
    return writeConfig(normalizeAutopilot({ ...config, ...(dailyNew != null ? { dailyNew } : {}), ...(window ? { window: { ...config.window, ...window } } : {}) }))
  }
  function approve(hash) {
    const config = readConfig()
    const problems = templateProblems(config)
    if (problems.length) throw Object.assign(new Error(problems[0]), { status: 400 })
    if (hash !== contentHash(config)) throw Object.assign(new Error('The templates changed since you reviewed them. Review again.'), { status: 409 })
    return writeConfig({ ...config, approvedHash: hash, approvedAt: iso() })
  }
  function setRunning(running) {
    const config = readConfig()
    if (running && !mailbox.configured) throw Object.assign(new Error('Connect Gmail first (GMAIL_USER and GMAIL_APP_PASSWORD)'), { status: 400 })
    if (running && !isApproved(config)) throw Object.assign(new Error('Approve the templates first'), { status: 400 })
    return writeConfig({ ...config, running: Boolean(running) })
  }
  function skip(id) {
    const row = getRow(id)
    if (!row) return null
    if (row.status !== 'queued') throw Object.assign(new Error('Only emails that have not gone out yet can be skipped'), { status: 409 })
    setLeadAutopilot(row.leadId, { status: 'skipped' })
    return updateRow(id, { status: 'skipped', reason: 'Skipped by you', nextAt: null })
  }
  // Keeps a lead out of the queue without one being planned first.
  function skipLead(leadId) {
    const lead = readLead(leadId)
    if (!lead?.qualification?.contact?.email) return null
    if (enrolledLeadIds().has(leadId)) throw Object.assign(new Error('This lead is already in the autopilot'), { status: 409 })
    setLeadAutopilot(leadId, { status: 'skipped' })
    return insertRow({ lead, status: 'skipped', reason: 'Skipped by you' })
  }
  function stop(id) {
    const row = getRow(id)
    if (!row) return null
    if (!['queued', 'active', 'finished'].includes(row.status)) throw Object.assign(new Error('This sequence already stopped'), { status: 409 })
    setLeadAutopilot(row.leadId, { status: 'stopped' })
    return updateRow(id, { status: 'stopped', reason: 'Stopped by you', nextAt: null })
  }
  function editOverrides(id, overrides) {
    const row = getRow(id)
    if (!row) return null
    if (!['queued', 'active'].includes(row.status)) throw Object.assign(new Error('This email already went out'), { status: 409 })
    const clean = {}
    for (const key of ['observation', 'ownerName', 'company']) {
      if (overrides[key] == null) continue
      const value = String(overrides[key]).replace(/\s+/g, ' ').trim().slice(0, 400)
      if (value) clean[key] = value
    }
    return updateRow(id, { overrides: clean })
  }
  function previewFor(leadId, step = 0) {
    const lead = readLead(leadId)
    if (!lead) return null
    return renderStep(readConfig(), step, lead)
  }
  // Renders unsaved template edits, so the editor can show the real email.
  function previewDraft({ sequence, signature, leadId, step = 0 }) {
    const config = normalizeAutopilot({ ...readConfig(), ...(sequence ? { sequence } : {}), ...(signature != null ? { signature } : {}) })
    const lead = leadId ? readLead(leadId) : candidates(config, 1)[0]
    const problems = templateProblems(config)
    if (!lead) return { lead: null, problems, email: null, error: 'No lead with an email to preview yet' }
    try {
      return { lead: { id: lead.id, company: lead.company }, problems, email: renderStep(config, step, lead), error: null }
    } catch (error) {
      return { lead: { id: lead.id, company: lead.company }, problems, email: null, error: error.message }
    }
  }

  return {
    readConfig, writeConfig, tick, scan, planBatch, sendDue, recoverInterrupted, overview, saveTemplates, saveSchedule, approve, setRunning,
    skip, skipLead, stop, editOverrides, previewFor, previewDraft, getRow, isBusy: () => busy, candidates,
    LIVE, STOPPED,
  }
}
