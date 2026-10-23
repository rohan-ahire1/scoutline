import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { AUTH_COOKIE_NAME, AuthError, clearedSessionCookie, createAuthService, parseAllowedEmails, proxyUser, readCookie, serviceTokenUser, sessionCookie } from './auth.js'

test('normalizes a comma, semicolon, or whitespace-separated email allowlist', () => {
  assert.deepEqual([...parseAllowedEmails(' Alice@Example.com, bob@example.com;\ninvalid ')], ['alice@example.com', 'bob@example.com'])
})

test('creates, reads, and revokes an opaque session for an allowed verified email', async () => {
  const db = new Database(':memory:')
  const auth = createAuthService(db, {
    clientId: 'test-client',
    allowedEmails: 'allowed@example.com',
    verifyIdToken: async () => ({ getPayload: () => ({ sub: 'google-123', email: 'Allowed@Example.com', email_verified: true, name: 'Allowed User' }) }),
  })

  const created = await auth.login('google-id-token')
  const cookie = sessionCookie(created.token)
  assert.equal(readCookie(cookie, AUTH_COOKIE_NAME), created.token)
  assert.deepEqual(auth.session(cookie), { id: 'google-123', email: 'allowed@example.com', name: 'Allowed User', expiresAt: created.expiresAt })

  auth.logout(cookie)
  assert.equal(auth.session(cookie), null)
  db.close()
})

test('rejects a verified Google account that is not allowlisted', async () => {
  const db = new Database(':memory:')
  const auth = createAuthService(db, {
    clientId: 'test-client',
    allowedEmails: 'allowed@example.com',
    verifyIdToken: async () => ({ getPayload: () => ({ sub: 'google-456', email: 'other@example.com', email_verified: true }) }),
  })

  await assert.rejects(auth.login('google-id-token'), (error) => error instanceof AuthError && error.status === 403 && error.code === 'EMAIL_NOT_ALLOWED')
  db.close()
})

test('session cookies are HTTP-only, same-site, and clearable', () => {
  assert.match(sessionCookie('secret', { secure: true }), /HttpOnly; Path=\/; SameSite=Lax; Max-Age=\d+; Secure/)
  assert.match(clearedSessionCookie(), /Max-Age=0/)
})

test('service token: bearer match only, and only when a long token is configured', () => {
  const token = 'a'.repeat(40)
  assert.equal(serviceTokenUser(`Bearer ${token}`, token).service, true)
  assert.equal(serviceTokenUser(`bearer ${token}`, token).service, true)
  assert.equal(serviceTokenUser(`Bearer ${token}x`, token), null)
  assert.equal(serviceTokenUser(token, token), null)
  assert.equal(serviceTokenUser('Bearer short', 'short'), null)
  assert.equal(serviceTokenUser('Bearer ', ''), null)
  assert.equal(serviceTokenUser(undefined, token), null)
})

test('trusts the login proxy only when it is turned on', () => {
  assert.equal(proxyUser({ 'x-scoutline-guest': '1' }, true).guest, true)
  assert.equal(proxyUser({ 'x-scoutline-guest': '' }, true).id, 'owner')
  assert.equal(proxyUser({}, true).guest, undefined)
  assert.equal(proxyUser({ 'x-scoutline-guest': '1' }, false), null)
  assert.equal(proxyUser({}, false), null)
})
