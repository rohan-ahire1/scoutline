import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { checkMx, decodeCfEmail, extractEmails, extractOwnerNames, normalizeEmail, rankEmails, verifyEmails } from './contacts.js';

function cfEncode(email, key = 0x42) {
  return key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

test('decodes Cloudflare-protected emails', () => {
  assert.equal(decodeCfEmail(cfEncode('office@slcroof.com')), 'office@slcroof.com');
  const $ = cheerio.load(`<a href="/cdn-cgi/l/email-protection#${cfEncode('mike@slcroof.com')}">[email&#160;protected]</a><span class="__cf_email__" data-cfemail="${cfEncode('info@slcroof.com')}"></span>`);
  const emails = extractEmails($, '', []).map(e => e.email);
  assert.deepEqual(emails.sort(), ['info@slcroof.com', 'mike@slcroof.com']);
});

test('finds obfuscated and JSON-LD emails, drops junk', () => {
  const $ = cheerio.load('<p>x</p>');
  const text = 'Email us: jake [at] wasatchhvac [dot] com or hello(at)wasatchhvac.com. Logo logo@2x.png, test@example.com, noreply@wasatchhvac.com';
  const emails = extractEmails($, text, [{ '@type': 'HVACBusiness', email: 'mailto:office@wasatchhvac.com' }]);
  const list = emails.map(e => e.email);
  assert.ok(list.includes('jake@wasatchhvac.com'));
  assert.ok(list.includes('hello@wasatchhvac.com'));
  assert.ok(list.includes('office@wasatchhvac.com'));
  assert.ok(!list.some(e => /example|2x\.png|noreply/.test(e)), list.join());
  assert.equal(normalizeEmail('user@domain.com'), null);
});

test('extracts owner names with evidence and ignores headings', () => {
  const owners = extractOwnerNames('About Us. Owner: Mike Jensen has served Salt Lake since 2004. Our Team works hard. Sarah Lund, founder of the company.');
  const names = owners.map(o => o.name);
  assert.ok(names.includes('Mike Jensen'), names.join());
  assert.ok(names.includes('Sarah Lund'), names.join());
  assert.ok(owners.every(o => o.evidence.includes(o.name)));
});

test('ranks owner and same-domain addresses above agency and careers inboxes', () => {
  const ranked = rankEmails([
    { email: 'careers@wasatchhvac.com', source: 'text' },
    { email: 'support@bigagency.com', source: 'text' },
    { email: 'info@wasatchhvac.com', source: 'mailto' },
    { email: 'mike@wasatchhvac.com', source: 'text' },
  ], { siteHost: 'www.wasatchhvac.com', ownerNames: [{ name: 'Mike Jensen' }] });
  assert.deepEqual(ranked.map(e => e.email), ['mike@wasatchhvac.com', 'info@wasatchhvac.com', 'careers@wasatchhvac.com', 'support@bigagency.com']);
  assert.equal(ranked[0].kind, 'owner');
});

test('MX verification drops domains that cannot receive mail and keeps unknowns', async () => {
  const resolver = async (domain) => {
    if (domain === 'good.com') return [{ exchange: 'mx.good.com', priority: 10 }];
    if (domain === 'slow.com') throw Object.assign(new Error('x'), { code: 'ESERVFAIL' });
    throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  };
  const out = await verifyEmails([{ email: 'a@good.com' }, { email: 'b@dead.com' }, { email: 'c@slow.com' }], { resolver });
  assert.deepEqual(out.map(e => [e.email, e.mx]), [['a@good.com', 'ok'], ['c@slow.com', 'unknown']]);
  assert.equal((await checkMx('dead.com', { resolver })).deliverable, false);
});
