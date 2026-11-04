// Outbound mail transports for the send queue.
//
// Safety model: nothing leaves the machine unless MAIL_LIVE=yes. Without it,
// every transport except an SMTP server on loopback (a local catcher such as
// Mailpit) is replaced by the dry-run transport, which only records what
// would have been sent. Tests always get dry-run.
import nodemailer from 'nodemailer'

export const TRANSPORT_KINDS = ['dryrun', 'smtp', 'resend']
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase())
}

function parseAddress(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(.*)<([^>]+)>\s*$/)
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim().toLowerCase() }
  return { name: '', address: text.toLowerCase() }
}

// Reads mail configuration from the environment. Returns the effective mode
// plus a list of what is missing for the requested transport.
export function getMailerConfig(env = process.env) {
  const requested = TRANSPORT_KINDS.includes(String(env.MAIL_TRANSPORT || '').toLowerCase()) ? String(env.MAIL_TRANSPORT).toLowerCase() : 'dryrun'
  const live = String(env.MAIL_LIVE || '').toLowerCase() === 'yes' && env.NODE_ENV !== 'test'
  const from = parseAddress(env.MAIL_FROM)
  const replyTo = env.MAIL_REPLY_TO ? parseAddress(env.MAIL_REPLY_TO) : from
  const smtp = {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(env.SMTP_PORT) === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  }
  const missing = []
  if (!from.address.includes('@')) missing.push('MAIL_FROM')
  if (!String(env.MAIL_PHYSICAL_ADDRESS || '').trim()) missing.push('MAIL_PHYSICAL_ADDRESS')
  if (requested === 'smtp' && !smtp.host) missing.push('SMTP_HOST')
  if (requested === 'smtp' && !isLoopbackHost(smtp.host) && (!smtp.user || !smtp.pass)) missing.push('SMTP_USER/SMTP_PASS')
  if (requested === 'resend' && !env.RESEND_API_KEY) missing.push('RESEND_API_KEY')

  // The effective transport: a real provider only with MAIL_LIVE=yes; a
  // loopback SMTP catcher is always allowed because nothing leaves the host.
  let mode = 'dryrun'
  if (requested === 'smtp' && smtp.host && isLoopbackHost(smtp.host)) mode = 'catcher'
  else if (requested !== 'dryrun' && live && !missing.length) mode = 'live'
  return {
    requested,
    mode,
    live: mode === 'live',
    transport: mode === 'dryrun' ? 'dryrun' : requested,
    from,
    replyTo,
    physicalAddress: String(env.MAIL_PHYSICAL_ADDRESS || '').trim(),
    publicUrl: String(env.SCOUTLINE_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    smtp,
    resendKey: env.RESEND_API_KEY || '',
    missing,
  }
}

export function describeMailer(config) {
  return {
    requested: config.requested,
    mode: config.mode,
    transport: config.transport,
    from: config.from.address || null,
    replyTo: config.replyTo.address || null,
    physicalAddress: Boolean(config.physicalAddress),
    publicUnsubscribe: Boolean(config.publicUrl),
    missing: config.missing,
  }
}

function formatAddress({ name, address }) {
  return name ? `"${name.replace(/"/g, '')}" <${address}>` : address
}

// A message is { to, subject, text, messageId, inReplyTo, references, headers }.
export function createDryRunTransport({ log = null } = {}) {
  const sent = []
  return {
    kind: 'dryrun',
    sent,
    async send(message) {
      sent.push(message)
      if (log) log(`[mail dry-run] to=${message.to} subject=${JSON.stringify(message.subject)} id=${message.messageId}`)
      return { accepted: [message.to], providerId: null, dryRun: true }
    },
  }
}

function createSmtpTransport(config) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    ignoreTLS: isLoopbackHost(config.smtp.host),
  })
  return {
    kind: config.mode === 'catcher' ? 'catcher' : 'smtp',
    async send(message) {
      const info = await transporter.sendMail({
        from: formatAddress(config.from),
        replyTo: formatAddress(config.replyTo),
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo || undefined,
        references: message.references?.length ? message.references : undefined,
        headers: message.headers || {},
      })
      return { accepted: info.accepted || [message.to], providerId: info.messageId || null, dryRun: false }
    },
  }
}

function createResendTransport(config, fetchImpl = fetch) {
  return {
    kind: 'resend',
    async send(message) {
      const headers = { ...(message.headers || {}), 'Message-ID': message.messageId }
      if (message.inReplyTo) headers['In-Reply-To'] = message.inReplyTo
      if (message.references?.length) headers.References = message.references.join(' ')
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: formatAddress(config.from), reply_to: formatAddress(config.replyTo), to: [message.to], subject: message.subject, text: message.text, headers }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw Object.assign(new Error(body?.message || `Resend returned HTTP ${response.status}`), { status: response.status })
      return { accepted: [message.to], providerId: body?.id || null, dryRun: false }
    },
  }
}

export function createTransport(config, { log = console.log } = {}) {
  if (config.mode === 'dryrun') return createDryRunTransport({ log })
  if (config.transport === 'smtp') return createSmtpTransport(config)
  if (config.transport === 'resend') return createResendTransport(config)
  return createDryRunTransport({ log })
}
