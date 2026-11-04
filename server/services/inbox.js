// IMAP polling for replies, bounces and opt-outs. Reads only messages newer
// than the last seen UID and never changes flags (fetches use BODY.PEEK).
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

export function getInboxConfig(env = process.env) {
  const host = env.IMAP_HOST || ''
  return {
    configured: Boolean(host && env.IMAP_USER && env.IMAP_PASS),
    host,
    port: Number(env.IMAP_PORT || 993),
    secure: String(env.IMAP_SECURE || 'true').toLowerCase() !== 'false',
    user: env.IMAP_USER || '',
    pass: env.IMAP_PASS || '',
    mailbox: env.IMAP_MAILBOX || 'INBOX',
  }
}

const headerValue = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value.value) return String(value.value)
  if (value.text) return String(value.text)
  return String(value)
}

// mailparser output -> the plain shape sendQueue.handleInbound expects.
export function normalizeParsed(parsed) {
  const headers = {}
  for (const [key, value] of parsed.headers || []) headers[String(key).toLowerCase()] = headerValue(value)
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? String(parsed.references).split(/\s+/) : []
  const attachedText = (parsed.attachments || [])
    .filter((a) => /delivery-status|rfc822-headers|message\/rfc822|text\/rfc822/i.test(a.contentType || ''))
    .map((a) => a.content?.toString('utf8') || '')
    .join('\n')
  return {
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references,
    from: parsed.from?.value?.[0]?.address || '',
    subject: parsed.subject || '',
    text: [parsed.text || '', attachedText].filter(Boolean).join('\n'),
    contentType: headers['content-type'] || '',
    headers,
  }
}

// Fetches messages with UID > lastUid. Returns the new cursor; on first run
// (no cursor) it starts from the newest message instead of replaying the inbox.
export async function pollInbox(config, { cursor = null, onMessage, log = console.log } = {}) {
  const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass }, logger: false })
  await client.connect()
  const lock = await client.getMailboxLock(config.mailbox)
  try {
    const mailbox = client.mailbox
    const validity = String(mailbox.uidValidity)
    if (!cursor || cursor.uidValidity !== validity) {
      const start = { uidValidity: validity, lastUid: Math.max(0, Number(mailbox.uidNext || 1) - 1) }
      log(`[inbox] starting from UID ${start.lastUid} in ${config.mailbox}`)
      return { cursor: start, processed: 0 }
    }
    let lastUid = cursor.lastUid
    let processed = 0
    for await (const message of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (message.uid <= cursor.lastUid) continue
      const parsed = await simpleParser(message.source)
      await onMessage(normalizeParsed(parsed))
      lastUid = Math.max(lastUid, message.uid)
      processed += 1
    }
    return { cursor: { uidValidity: validity, lastUid }, processed }
  } finally {
    lock.release()
    await client.logout().catch(() => {})
  }
}
