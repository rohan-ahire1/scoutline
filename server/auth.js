import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'

export const AUTH_COOKIE_NAME = 'scoutline_session'
export const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class AuthError extends Error {
  constructor(message, status = 401, code = 'UNAUTHORIZED') {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
  }
}

export function parseAllowedEmails(value) {
  return new Set(
    String(value || '')
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => emailPattern.test(email)),
  )
}

export function readCookie(header, name) {
  const prefix = `${name}=`
  const entry = String(header || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  if (!entry) return null
  try { return decodeURIComponent(entry.slice(prefix.length)) }
  catch { return null }
}

function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionCookie(token, { secure = false, ttlSeconds = AUTH_SESSION_TTL_SECONDS } = {}) {
  return [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ')
}

export function clearedSessionCookie({ secure = false } = {}) {
  return [
    `${AUTH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ')
}

export function createAuthService(db, {
  clientId = process.env.GOOGLE_CLIENT_ID,
  allowedEmails = process.env.SCOUTLINE_ALLOWED_EMAILS,
  ttlSeconds = AUTH_SESSION_TTL_SECONDS,
  verifyIdToken,
} = {}) {
  const allowlist = parseAllowedEmails(allowedEmails)
  const normalizedClientId = String(clientId || '').trim()
  const googleClient = new OAuth2Client(normalizedClientId || undefined)
  const verifier = verifyIdToken || ((credential) => googleClient.verifyIdToken({ idToken: credential, audience: normalizedClientId }))

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_index ON auth_sessions(expires_at);
  `)

  const configured = Boolean(normalizedClientId && allowlist.size)
  const findSession = db.prepare('SELECT google_sub, email, name, expires_at FROM auth_sessions WHERE token_hash = ?')
  const insertSession = db.prepare('INSERT INTO auth_sessions (token_hash, google_sub, email, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  const deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
  const deleteExpired = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?')

  function assertConfigured() {
    if (!configured) throw new AuthError('Google login is not configured on this server', 503, 'AUTH_NOT_CONFIGURED')
  }

  async function login(credential) {
    assertConfigured()
    if (typeof credential !== 'string' || !credential.trim() || credential.length > 12_000) {
      throw new AuthError('A valid Google credential is required', 400, 'INVALID_CREDENTIAL')
    }

    let ticket
    try { ticket = await verifier(credential) }
    catch { throw new AuthError('Google could not verify this sign-in', 401, 'INVALID_GOOGLE_TOKEN') }

    const payload = ticket?.getPayload?.() || ticket?.payload
    const email = String(payload?.email || '').trim().toLowerCase()
    if (!payload?.sub || payload?.email_verified !== true || !emailPattern.test(email)) {
      throw new AuthError('Google did not return a verified email address', 401, 'UNVERIFIED_EMAIL')
    }
    if (!allowlist.has(email)) {
      throw new AuthError('This Google account is not allowed to access Scoutline', 403, 'EMAIL_NOT_ALLOWED')
    }

    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + (ttlSeconds * 1000)
    deleteExpired.run(now)
    insertSession.run(sessionHash(token), String(payload.sub), email, String(payload.name || email).slice(0, 160), expiresAt, new Date(now).toISOString())
    return { token, user: { id: String(payload.sub), email, name: String(payload.name || email) }, expiresAt }
  }

  function session(cookieHeader) {
    if (!configured) return null
    const token = readCookie(cookieHeader, AUTH_COOKIE_NAME)
    if (!token) return null
    const hash = sessionHash(token)
    const row = findSession.get(hash)
    if (!row) return null
    if (row.expires_at <= Date.now() || !allowlist.has(String(row.email).toLowerCase())) {
      deleteSession.run(hash)
      return null
    }
    return { id: row.google_sub, email: row.email, name: row.name, expiresAt: row.expires_at }
  }

  function logout(cookieHeader) {
    const token = readCookie(cookieHeader, AUTH_COOKIE_NAME)
    if (token) deleteSession.run(sessionHash(token))
  }

  return {
    configured,
    clientId: normalizedClientId,
    allowlistCount: allowlist.size,
    login,
    session,
    logout,
  }
}

// Server-to-server access (CLI, nightly timer): `Authorization: Bearer
// <SCOUTLINE_SERVICE_TOKEN>`. Off unless the token is set; tokens shorter than
// 32 characters are refused so a placeholder can never unlock the API.
export const SERVICE_TOKEN_MIN_LENGTH = 32

export function serviceTokenUser(authorizationHeader, expectedToken = process.env.SCOUTLINE_SERVICE_TOKEN) {
  const expected = String(expectedToken || '')
  if (expected.length < SERVICE_TOKEN_MIN_LENGTH) return null
  const match = /^Bearer\s+(\S+)$/i.exec(String(authorizationHeader || '').trim())
  if (!match) return null
  const given = createHash('sha256').update(match[1]).digest()
  const wanted = createHash('sha256').update(expected).digest()
  if (!timingSafeEqual(given, wanted)) return null
  return { email: 'service@scoutline.local', name: 'Service token', service: true }
}

// Proxy login (SCOUTLINE_PROXY_AUTH=1): the gate in front of Scoutline (Caddy +
// phone-login) already let only Tailscale devices or password holders through,
// so everyone who reaches the app is the owner, except a read-only guest, which
// the gate marks with `X-Scoutline-Guest: 1` (Caddy strips any copy a visitor
// sends). Off by default, so a server reachable without that proxy keeps Google login.
export const GUEST_HEADER = 'x-scoutline-guest'
// Caddy sets this only for requests from a Tailscale address (and strips any
// copy a visitor sends). Concept review and publishing need it.
export const TAILNET_HEADER = 'x-scoutline-tailnet'
export const GUEST_USER = Object.freeze({ id: 'guest', email: 'guest@scoutline.local', name: 'Guest (read-only)', guest: true, proxy: true })
export const OWNER_USER = Object.freeze({ id: 'owner', email: 'owner@scoutline.local', name: 'Owner', proxy: true })

export function proxyUser(headers, enabled = process.env.SCOUTLINE_PROXY_AUTH === '1') {
  if (!enabled) return null
  if (headers?.[GUEST_HEADER] === '1') return GUEST_USER
  return headers?.[TAILNET_HEADER] === '1' ? { ...OWNER_USER, tailnet: true } : OWNER_USER
}
