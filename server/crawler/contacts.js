import { resolveMx } from 'node:dns/promises';

// Contact extraction for outreach. Small-business sites hide addresses behind
// Cloudflare email protection, "name [at] domain [dot] com" spellings and
// JSON-LD, so plain mailto scraping misses most of them.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const OBFUSCATED_RE = /([A-Z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+)\s*([A-Z0-9-]+(?:(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*|\s+dot\s+|\.)[A-Z0-9-]+)+)/gi;

// Addresses that belong to the site's vendors, examples or asset filenames,
// never to the business itself.
const JUNK_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.com|yourdomain\.com|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|squarespace\.com|godaddy\.com|secureserver\.net|weebly\.com|schema\.org|w3\.org|googlegroups\.com|mysite\.com|company\.com|address\.com)$/i;
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|hostmaster|abuse|privacy|dmca|test|user|username|name|your(name|email)?|email|johndoe|john\.doe|jane\.doe)$/i;
const ASSET_TLD = /\.(png|jpe?g|gif|webp|svg|avif|css|js|ico)$/i;

const ROLE_LOCAL = /^(info|contact|office|hello|hi|admin|service|services|sales|support|help|team|mail|enquiries|inquiries|quotes?|estimates?|booking|bookings|schedule|scheduling|dispatch|customerservice|billing|accounts|jobs|careers|hr)$/i;
const PREFERRED_ROLE = /^(info|contact|office|hello|hi|quotes?|estimates?|service|sales)$/i;
const LOW_VALUE_ROLE = /^(jobs|careers|hr|billing|accounts|support|help)$/i;
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|me|msn|live|comcast|att|sbcglobal|bellsouth|protonmail|ymail)\.[a-z.]+$/i;

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0].replace(/[.,;:]+$/, '');
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  const [local, domain] = email.split('@');
  if (ASSET_TLD.test(email) || JUNK_DOMAINS.test(domain) || JUNK_LOCAL.test(local)) return null;
  if (local.length > 40 || /^[a-f0-9]{16,}$/.test(local)) return null;
  return email;
}

// Cloudflare "email protection" encodes the address as hex XOR'd with the first byte.
export function decodeCfEmail(hex) {
  const value = String(hex || '').trim();
  if (!/^[0-9a-f]{4,}$/i.test(value) || value.length % 2) return null;
  const key = Number.parseInt(value.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < value.length; i += 2) out += String.fromCharCode(Number.parseInt(value.slice(i, i + 2), 16) ^ key);
  return out;
}

function jsonLdEmails(jsonLd) {
  const out = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return node.forEach(item => visit(item, depth + 1));
    for (const [key, value] of Object.entries(node)) {
      if (key.toLowerCase() === 'email' && typeof value === 'string') out.push(value);
      else if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(jsonLd);
  return out;
}

// Returns [{ email, source }] with the first source that produced each address.
export function extractEmails($, visibleText, jsonLd = []) {
  const found = new Map();
  const add = (raw, source) => {
    const email = normalizeEmail(raw);
    if (email && !found.has(email)) found.set(email, source);
  };
  $('a[href^="mailto:" i]').each((_, el) => add(decodeURIComponent($(el).attr('href') || ''), 'mailto'));
  $('[data-cfemail]').each((_, el) => add(decodeCfEmail($(el).attr('data-cfemail')), 'cloudflare'));
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => add(decodeCfEmail(($(el).attr('href') || '').split('#')[1]), 'cloudflare'));
  for (const raw of jsonLdEmails(jsonLd)) add(raw, 'json-ld');
  for (const match of visibleText.matchAll(EMAIL_RE)) add(match[0], 'text');
  for (const match of visibleText.matchAll(OBFUSCATED_RE)) {
    const domain = match[2].replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '');
    add(`${match[1]}@${domain}`, 'obfuscated');
  }
  return [...found].map(([email, source]) => ({ email, source }));
}

// Owner / founder names stated on the site ("Owner: Mike Jensen",
// "Mike Jensen, founder"). Conservative: two capitalised words only, with the
// sentence kept as evidence so a human can check it.
const NAME = "([A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\\s+(?:[A-Z]\\.\\s+)?[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)";
// Case-insensitive roles without an /i flag, which would also let NAME match lowercase words.
const ROLE = '(?:[Oo]wner|OWNER|[Cc]o-[Oo]wner|[Ff]ounder|FOUNDER|[Cc]o-[Ff]ounder|[Pp]resident|PRESIDENT|[Pp]roprietor|[Pp]rincipal)';
const OWNER_PATTERNS = [
  new RegExp(`\\b${ROLE}\\s*(?:[:,\\-–—]|is|and\\s+${ROLE})\\s*${NAME}`, 'g'),
  new RegExp(`${NAME}\\s*(?:[,\\-–—(]|\\bis\\b)\\s*(?:the\\s+|our\\s+)?${ROLE}\\b`, 'g'),
  new RegExp(`\\b(?:[Ff]ounded|[Ss]tarted|[Oo]wned|[Rr]un)\\s+(?:in\\s+\\d{4}\\s+)?by\\s+${NAME}`, 'g'),
];
const NOT_NAMES = /^(Our|The|We|About|Contact|Home|Services|Free|Call|Get|Salt|Lake|City|New|York|Family|Local|Licensed|Owner|Founder|President|Read|More|Learn)\b/;

export function extractOwnerNames(visibleText) {
  const out = new Map();
  for (const pattern of OWNER_PATTERNS) {
    for (const match of visibleText.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (!name || NOT_NAMES.test(name) || name.split(/\s+/).some(part => NOT_NAMES.test(part))) continue;
      const start = Math.max(0, match.index - 40);
      if (!out.has(name)) out.set(name, visibleText.slice(start, match.index + match[0].length + 40).trim());
    }
  }
  return [...out].slice(0, 5).map(([name, evidence]) => ({ name, evidence }));
}

export function isFamilyOwned(visibleText) {
  return /\b(family[- ]owned|family[- ]operated|locally owned|owner[- ]operated|veteran[- ]owned|woman[- ]owned|women[- ]owned)\b/i.test(visibleText);
}

function hostRoot(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

// Ranks addresses for a cold first touch: a named person at the business
// domain beats info@, which beats a free-mail inbox, which beats careers@.
export function rankEmails(entries, { siteHost = '', ownerNames = [] } = {}) {
  const site = hostRoot(siteHost);
  const ownerTokens = ownerNames.flatMap(o => o.name.toLowerCase().split(/\s+/));
  return entries.map(entry => {
    const [local, domain] = entry.email.split('@');
    const sameDomain = site && (domain === site || site.endsWith(`.${domain}`) || domain.endsWith(`.${site}`));
    const freeMail = FREE_MAIL.test(domain);
    const role = ROLE_LOCAL.test(local);
    const owner = ownerTokens.some(token => token.length > 2 && local.includes(token));
    let score = 0;
    let kind = 'other';
    if (owner) { score += 50; kind = 'owner'; }
    else if (!role && (sameDomain || freeMail)) { score += 35; kind = 'person'; }
    else if (PREFERRED_ROLE.test(local)) { score += 30; kind = 'role'; }
    else if (LOW_VALUE_ROLE.test(local)) { score += 5; kind = 'low-value-role'; }
    else if (role) { score += 20; kind = 'role'; }
    if (sameDomain) score += 30;
    else if (freeMail) score += 15;
    else score -= 20; // Another company's domain — often the web agency.
    if (entry.source === 'mailto' || entry.source === 'cloudflare') score += 5;
    return { ...entry, kind, sameDomain: Boolean(sameDomain), freeMail, score };
  }).sort((a, b) => b.score - a.score);
}

const mxCache = new Map();

// MX lookup per domain: a domain with no mail exchanger cannot receive mail.
export async function checkMx(domain, { resolver = resolveMx, timeoutMs = 4000 } = {}) {
  const key = String(domain || '').toLowerCase();
  if (!key) return { domain: key, deliverable: false, reason: 'no domain' };
  if (mxCache.has(key)) return mxCache.get(key);
  let result;
  try {
    const records = await Promise.race([
      resolver(key),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('MX lookup timed out'), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    result = records?.length
      ? { domain: key, deliverable: true, mx: records.sort((a, b) => a.priority - b.priority)[0].exchange }
      : { domain: key, deliverable: false, reason: 'no MX records' };
  } catch (error) {
    // Timeouts are unknown, not undeliverable.
    result = error?.code === 'ETIMEOUT' || error?.code === 'ESERVFAIL'
      ? { domain: key, deliverable: null, reason: 'MX lookup failed' }
      : { domain: key, deliverable: false, reason: error?.code === 'ENOTFOUND' || error?.code === 'ENODATA' ? 'no MX records' : 'MX lookup failed' };
  }
  if (result.deliverable !== null) mxCache.set(key, result);
  return result;
}

// Adds MX results to ranked emails and drops undeliverable ones.
export async function verifyEmails(ranked, options = {}) {
  const out = [];
  for (const entry of ranked) {
    const mx = await checkMx(entry.email.split('@')[1], options);
    if (mx.deliverable === false) continue;
    out.push({ ...entry, mx: mx.deliverable === true ? 'ok' : 'unknown' });
  }
  return out;
}
