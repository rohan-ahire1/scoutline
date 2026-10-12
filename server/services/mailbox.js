// The Gmail side of the autopilot: send over SMTP, read replies and bounces
// over IMAP. Uses a Google app password (GMAIL_USER + GMAIL_APP_PASSWORD), so
// mail goes out from the real Workspace inbox and lands in its Sent folder.

import { promises as dns } from 'node:dns'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'

export function getMailboxConfig(env = process.env) {
  const user = String(env.GMAIL_USER || '').trim().toLowerCase()
  const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
  const fromName = String(env.GMAIL_FROM_NAME || 'Rohan Ahire').trim()
  return { configured: Boolean(user && pass), user, pass, fromName }
}

export function createMailbox({ config = getMailboxConfig(), transport = null, imapFactory = null } = {}) {
  let transporter = transport

  function smtp() {
    if (!config.configured) throw new Error('Gmail is not connected: set GMAIL_USER and GMAIL_APP_PASSWORD')
    // Port 587 (STARTTLS): many VPS hosts block outbound 465 and 25.
    transporter ||= nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
    })
    return transporter
  }

  async function send({ to, subject, text, inReplyTo = null, references = [] }) {
    const info = await smtp().sendMail({
      from: { name: config.fromName, address: config.user },
      to,
      subject,
      text,
      ...(inReplyTo ? { inReplyTo, references: [...references, inReplyTo].filter(Boolean).join(' ') } : {}),
      headers: { 'List-Unsubscribe': `<mailto:${config.user}?subject=unsubscribe>` },
    })
    const accepted = (info.accepted || []).map((item) => String(item.address || item).toLowerCase())
    if (!accepted.includes(String(to).toLowerCase())) throw new Error(`Gmail did not accept ${to}: ${(info.rejected || []).join(', ') || info.response}`)
    return { messageId: info.messageId, response: info.response }
  }

  async function verify() {
    await smtp().verify()
    return true
  }

  function imap() {
    if (imapFactory) return imapFactory()
    return new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: config.user, pass: config.pass },
      logger: false,
      socketTimeout: 60_000,
    })
  }

  // Messages in All Mail from any of `addresses` (replies) or from the mail
  // system (bounces) newer than `sinceDays`. Gmail's own search syntax keeps
  // it to one query per batch.
  async function scan({ addresses = [], sinceDays = 30 }) {
    if (!config.configured) throw new Error('Gmail is not connected')
    const client = imap()
    await client.connect()
    const found = { replies: [], bounces: [] }
    try {
      const lock = await client.getMailboxLock('[Gmail]/All Mail')
      try {
        for (let i = 0; i < addresses.length; i += 40) {
          const chunk = addresses.slice(i, i + 40)
          const uids = await client.search({ gmraw: `from:(${chunk.join(' OR ')}) newer_than:${sinceDays}d` }, { uid: true })
          found.replies.push(...await fetchAll(client, uids))
        }
        const bounceUids = await client.search({ gmraw: `from:(mailer-daemon OR postmaster) newer_than:${sinceDays}d` }, { uid: true })
        found.bounces.push(...await fetchAll(client, bounceUids, { withText: true }))
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => {})
    }
    return found
  }

  return { configured: config.configured, user: config.user, send, verify, scan }
}

async function fetchAll(client, uids, { withText = false } = {}) {
  if (!uids?.length) return []
  const out = []
  for await (const message of client.fetch(uids.slice(-200), {
    uid: true, envelope: true, internalDate: true,
    headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'x-failed-recipients', 'in-reply-to', 'references'],
    bodyParts: withText ? ['text'] : ['1'],
  }, { uid: true })) {
    const headers = message.headers ? message.headers.toString('utf8') : ''
    const part = message.bodyParts?.get(withText ? 'text' : '1')
    out.push({
      uid: message.uid,
      from: String(message.envelope?.from?.[0]?.address || '').toLowerCase(),
      subject: message.envelope?.subject || '',
      date: (message.internalDate || message.envelope?.date || new Date()).toISOString(),
      messageId: message.envelope?.messageId || null,
      inReplyTo: message.envelope?.inReplyTo || null,
      headers,
      text: part ? part.toString('utf8').slice(0, 20_000) : '',
    })
  }
  return out
}

// The recipient's domain can receive mail at all. Catches typos and dead
// domains before they count as bounces against us.
export async function domainAcceptsMail(email, { resolver = dns } = {}) {
  const domain = String(email || '').split('@')[1]
  if (!domain) return false
  try {
    const records = await resolver.resolveMx(domain)
    return records.some((record) => record.exchange && record.exchange !== '.')
  } catch (error) {
    if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENONAME'].includes(error.code)) {
      // No MX: mail falls back to the A record.
      try { return (await resolver.resolve4(domain)).length > 0 } catch { return false }
    }
    throw error
  }
}
