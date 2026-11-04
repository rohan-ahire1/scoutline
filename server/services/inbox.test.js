import test from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import { getInboxConfig, normalizeParsed } from './inbox.js'
import { classifyInbound } from './sendQueue.js'

const reply = [
  'From: Mike <mike@joshuasons.test>',
  'To: rohan@send.goodshigoto.test',
  'Subject: Re: Quick note about your website',
  'Message-ID: <reply-1@joshuasons.test>',
  'In-Reply-To: <scoutline.abc.1.ff@send.goodshigoto.test>',
  'References: <scoutline.abc.1.ff@send.goodshigoto.test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Yes, send the outline.',
  '',
].join('\r\n')

const bounce = [
  'From: Mail Delivery System <MAILER-DAEMON@mx.test>',
  'To: rohan@send.goodshigoto.test',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <dsn-1@mx.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'Your message could not be delivered.',
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.test',
  '',
  'Final-Recipient: rfc822; gone@joshuasons.test',
  'Action: failed',
  'Status: 5.1.1',
  '--b1--',
  '',
].join('\r\n')

test('parsed replies keep their thread headers', async () => {
  const msg = normalizeParsed(await simpleParser(reply))
  assert.equal(msg.from, 'mike@joshuasons.test')
  assert.equal(msg.inReplyTo, '<scoutline.abc.1.ff@send.goodshigoto.test>')
  assert.deepEqual(msg.references, ['<scoutline.abc.1.ff@send.goodshigoto.test>'])
  assert.equal(classifyInbound(msg).kind, 'reply')
})

test('parsed DSN bounces expose the failed recipient', async () => {
  const msg = normalizeParsed(await simpleParser(bounce))
  const result = classifyInbound(msg)
  assert.equal(result.kind, 'bounce')
  assert.equal(result.recipient, 'gone@joshuasons.test')
})

test('inbox is off until IMAP credentials are set', () => {
  assert.equal(getInboxConfig({}).configured, false)
  assert.equal(getInboxConfig({ IMAP_HOST: 'imap.test', IMAP_USER: 'u', IMAP_PASS: 'p' }).configured, true)
})
