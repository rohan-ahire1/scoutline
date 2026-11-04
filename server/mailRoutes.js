// HTTP routes and background loops for automated outreach. Kept out of
// index.js; index.js passes in its lead storage helpers.
import { createTransport, describeMailer, getMailerConfig } from './services/mailer.js'
import { getInboxConfig, pollInbox } from './services/inbox.js'
import {
  approveSequences, buildBatch, enqueueLead, ensureMailSchema, handleInbound, listSequences, listUnsubscribeHeaders, mailStats,
  readMailState, readSequence, rejectSequences, renderEmail, resetDryRun, resolveSending, runSendTick, stopSequence, suppress,
  unsubscribeByToken, updateSequenceDraft, validateSendingPatch, writeMailState,
} from './services/sendQueue.js'

const IN_CONVERSATION = new Set(['Replied', 'Meeting', 'Proposal', 'Won', 'Lost'])
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function setupMail({ app, db, readLead, readRows, updateLead, recordEvent, readSettings, env = process.env, log = console.log }) {
  ensureMailSchema(db)
  const mailer = getMailerConfig(env)
  const transport = createTransport(mailer, { log })
  const inbox = getInboxConfig(env)
  const readSending = () => resolveSending(readMailState(db, 'sending', {}))
  const offer = () => readSettings().offer || null
  log(`[mail] transport=${mailer.transport} mode=${mailer.mode}${mailer.missing.length ? ` missing=${mailer.missing.join(',')}` : ''} inbox=${inbox.configured ? inbox.host : 'off'}`)

  // Moves the lead on the pipeline when something happens to its email.
  function onLeadEvent(leadId, kind, detail = {}) {
    const lead = readLead(leadId)
    if (!lead) return
    if (kind === 'sent') {
      recordEvent('lead', leadId, detail.dryRun ? 'email_dry_run' : detail.step === 1 ? 'email_sent' : 'followup_sent', detail)
      if (detail.dryRun || detail.step !== 1) return
      updateLead(leadId, {
        outreachStatus: 'Contacted',
        contactedAt: lead.contactedAt || detail.at,
        salesStage: !lead.salesStage || lead.salesStage === 'Qualified' ? 'Contacted' : lead.salesStage,
        nextAction: 'Wait for a reply; follow-ups go out automatically',
      })
    } else if (kind === 'replied') {
      recordEvent('lead', leadId, 'email_replied', detail)
      updateLead(leadId, {
        outreachStatus: 'Replied',
        salesStage: IN_CONVERSATION.has(lead.salesStage) ? lead.salesStage : 'Replied',
        nextAction: 'Read the reply and respond',
      })
    } else if (kind === 'bounced') {
      recordEvent('lead', leadId, 'email_bounced', detail)
      updateLead(leadId, { nextAction: 'Email bounced: find another contact route' })
    } else if (kind === 'unsubscribed') {
      recordEvent('lead', leadId, 'email_unsubscribed', detail)
      updateLead(leadId, { doNotContact: { status: true, reason: 'Opted out of email', scope: 'contact', at: detail.at } })
    }
  }

  let ticking = false
  async function tick() {
    if (ticking) return null
    ticking = true
    try {
      const result = await runSendTick(db, { sending: readSending(), mailer, transport, readLead, onLeadEvent })
      if (result?.sent) log(`[mail] ${result.status} step ${result.step} to ${result.to}`)
      if (result?.error) log(`[mail] send failed: ${result.error}`)
      return result
    } catch (error) {
      log(`[mail] tick error: ${error.message}`)
      return { error: error.message }
    } finally {
      ticking = false
    }
  }

  let polling = false
  const inboxState = { lastPollAt: null, lastError: null, processed: 0 }
  async function poll() {
    if (!inbox.configured || polling) return { skipped: true }
    polling = true
    try {
      const { cursor, processed } = await pollInbox(inbox, {
        cursor: readMailState(db, 'imapCursor'),
        log,
        onMessage: async (msg) => {
          const outcome = handleInbound(db, msg, { onLeadEvent })
          if (outcome.matched) log(`[inbox] ${outcome.kind} on ${outcome.sequenceId}`)
        },
      })
      writeMailState(db, 'imapCursor', cursor)
      Object.assign(inboxState, { lastPollAt: new Date().toISOString(), lastError: null, processed: inboxState.processed + processed })
      return { processed }
    } catch (error) {
      Object.assign(inboxState, { lastPollAt: new Date().toISOString(), lastError: error.message })
      log(`[inbox] poll failed: ${error.message}`)
      return { error: error.message }
    } finally {
      polling = false
    }
  }

  const sendLoop = setInterval(tick, 20_000)
  sendLoop.unref()
  const inboxLoop = inbox.configured ? setInterval(poll, 180_000) : null
  inboxLoop?.unref()

  const preview = (seq, sending) => ({
    ...seq,
    token: undefined,
    rendered: [seq.body, ...seq.followups].map((text, index) => ({
      step: index + 1,
      subject: index ? `Re: ${seq.subject}` : seq.subject,
      text: renderEmail(text, { sending, mailer, token: seq.token }),
    })),
    headers: listUnsubscribeHeaders(mailer, seq.token),
  })
  const publicSeq = ({ token: _token, ...seq }) => seq
  const idList = (body) => (Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string').slice(0, 500) : [])

  app.get('/api/mail/status', (_req, res) => {
    const sending = readSending()
    res.json({
      mailer: describeMailer(mailer),
      inbox: { configured: inbox.configured, host: inbox.host || null, mailbox: inbox.mailbox, ...inboxState },
      sending,
      stats: mailStats(db, { sending }),
    })
  })

  app.patch('/api/mail/settings', (req, res) => {
    const errors = validateSendingPatch(req.body)
    if (errors.length) return res.status(400).json({ error: errors[0].message, field: errors[0].field, details: errors })
    const next = resolveSending({ ...readMailState(db, 'sending', {}), ...req.body })
    writeMailState(db, 'sending', next)
    recordEvent('mail', 'settings', 'sending_settings_changed', { changes: req.body, by: req.user?.email || null })
    res.json(next)
  })

  app.post('/api/mail/batch', async (req, res, next) => {
    try {
      const sending = readSending()
      const limit = Number.isFinite(Number(req.body?.limit)) ? Math.min(100, Math.max(1, Number(req.body.limit))) : null
      const result = await buildBatch(db, readRows('leads'), { sending, offer: offer(), limit })
      res.json(result)
    } catch (error) { next(error) }
  })

  app.post('/api/mail/leads/:id/enqueue', async (req, res, next) => {
    try {
      const lead = readLead(req.params.id)
      if (!lead) return res.status(404).json({ error: 'Lead not found', code: 'NOT_FOUND' })
      const result = await enqueueLead(db, lead, { sending: readSending(), offer: offer() })
      res.status(result.queued ? 201 : 422).json(result.queued ? result : { error: result.reason, ...result })
    } catch (error) { next(error) }
  })

  app.get('/api/mail/sequences', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null
    res.json(listSequences(db, { status, limit: 500 }).map(publicSeq))
  })

  app.get('/api/mail/sequences/:id', (req, res) => {
    const seq = readSequence(db, req.params.id)
    if (!seq) return res.status(404).json({ error: 'Sequence not found', code: 'NOT_FOUND' })
    const messages = db.prepare('SELECT step, recipient, subject, status, transport, error, created_at FROM mail_messages WHERE sequence_id = ? ORDER BY created_at').all(seq.id)
    const inbound = db.prepare('SELECT kind, sender, subject, snippet, created_at FROM mail_inbound WHERE sequence_id = ? ORDER BY created_at').all(seq.id)
    res.json({ ...preview(seq, readSending()), messages, inbound })
  })

  app.patch('/api/mail/sequences/:id', (req, res) => {
    try {
      res.json(publicSeq(updateSequenceDraft(db, req.params.id, { subject: req.body?.subject, body: req.body?.body })))
    } catch (error) {
      res.status(error.status || 422).json({ error: error.message })
    }
  })

  app.post('/api/mail/sequences/approve', (req, res) => {
    const approved = approveSequences(db, idList(req.body), { by: req.user?.email || 'user' })
    res.json({ approved })
  })

  app.post('/api/mail/sequences/reject', (req, res) => {
    res.json({ rejected: rejectSequences(db, idList(req.body)) })
  })

  app.post('/api/mail/sequences/:id/stop', (req, res) => {
    const stopped = stopSequence(db, req.params.id, String(req.body?.reason || 'Stopped by hand').slice(0, 200))
    if (!stopped) return res.status(409).json({ error: 'Only queued or active sequences can be stopped' })
    res.json({ stopped })
  })

  app.get('/api/mail/suppression', (_req, res) => {
    res.json(db.prepare('SELECT * FROM mail_suppression ORDER BY created_at DESC LIMIT 1000').all())
  })

  app.post('/api/mail/suppression', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required', field: 'email' })
    suppress(db, email, String(req.body?.reason || 'Added by hand').slice(0, 200), 'manual')
    res.status(201).json({ email })
  })

  app.post('/api/mail/dry-run/reset', (_req, res) => {
    res.json(resetDryRun(db))
  })

  app.post('/api/mail/tick', async (_req, res) => {
    res.json(await tick() || { skipped: 'busy' })
  })

  app.post('/api/mail/inbox/poll', async (_req, res) => {
    if (!inbox.configured) return res.status(503).json({ error: 'Set IMAP_HOST, IMAP_USER and IMAP_PASS to track replies', code: 'INBOX_NOT_CONFIGURED' })
    res.json(await poll())
  })

  // Public opt-out (outside /api, so no login). GET only confirms, because
  // link scanners follow GETs; POST is the RFC 8058 one-click endpoint.
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}button{font:inherit;padding:.6rem 1.1rem;border-radius:.4rem;border:1px solid #222;background:#222;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`
  app.get('/u/:token', (req, res) => {
    const seq = db.prepare('SELECT email FROM mail_sequences WHERE token = ?').get(String(req.params.token))
    res.set('Cache-Control', 'no-store')
    if (!seq) return res.status(404).send(page('Link expired', '<p>This opt-out link is not valid. Reply "unsubscribe" to the email instead.</p>'))
    res.send(page('Unsubscribe', `<h1>Stop these emails?</h1><p>${escapeHtml(seq.email)} will not get any more email from me.</p><form method="post"><button type="submit">Unsubscribe</button></form>`))
  })
  app.post('/u/:token', (req, res) => {
    const done = unsubscribeByToken(db, req.params.token, { onLeadEvent })
    res.set('Cache-Control', 'no-store')
    if (!done) return res.status(404).send(page('Link expired', '<p>This opt-out link is not valid.</p>'))
    res.send(page('Unsubscribed', `<h1>Done</h1><p>${escapeHtml(done.email)} is unsubscribed and will not be emailed again.</p>`))
  })

  return { tick, poll, onLeadEvent, mailer, stop: () => { clearInterval(sendLoop); if (inboxLoop) clearInterval(inboxLoop) } }
}
