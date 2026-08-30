import { load } from 'cheerio'

// ── Constants & caps ──────────────────────────────────────────────────────────
export const CONTACT_ENRICHMENT_MAX_PAGES = 6 // homepage + up to 5 same-origin contact-like pages
export const CONTACT_ENRICHMENT_MAX_BYTES = 2 * 1024 * 1024
export const CONTACT_PATH_PATTERN = /(contact|about|team|staff|leadership|our-?team|about-us|contact-us|meet-the-team|our-people|company|people)/i

const EMAIL_REGEX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi
const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g
const LINKEDIN_REGEX = /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-z0-9\-_%]+\/?/gi

const ROLE_TIER_KEYWORDS = [
  { tier: 0, label: 'owner', pattern: /(owner|founder|co-?founder|principal|president|chief executive|\bceo\b)/i },
  { tier: 1, label: 'gm', pattern: /(general manager|\bgm\b|location manager|branch manager|store manager|operations manager|managing director|area manager)/i },
  { tier: 2, label: 'marketing', pattern: /(marketing|growth|business development|sales manager|outreach|communications|community manager|director of marketing)/i },
]

const ROLE_EMAIL_LOCALS = new Set(['owner','founder','president','ceo','manager','gm','marketing','growth','sales'])

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function extractVisibleTextWithSeparators($) {
  const parts = []
  const isExcludedTag = (name) => ['script', 'style', 'noscript', 'template'].includes(String(name || '').toLowerCase())
  const walk = (node) => {
    if (!node) return
    if (node.type === 'text') {
      const t = cleanText(node.data)
      if (t) parts.push(t)
      return
    }
    if (node.type === 'tag') {
      if (isExcludedTag(node.name)) return
      if (node.children && node.children.length) node.children.forEach(walk)
      return
    }
    if (node.children) node.children.forEach(walk)
  }
  const body = $('body')[0]
  if (body) walk(body)
  else $.root().children().each((_, el) => walk(el))
  return parts.join(' ')
}

function hashString(input) {
  const str = String(input || '')
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) + str.charCodeAt(i)
  return (hash >>> 0).toString(36)
}

// ── Normalizers (deterministic, pure) ──────────────────────────────────────
export function normalizeEmail(value) {
  const v = String(value || '').trim().toLowerCase()
  if (!v) return ''
  // basic email validation: must contain @ and .
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return ''
  return v
}

export function normalizePhone(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length < 10 || digits.length > 15) return ''
  // keep last 10 for US, but preserve full digits for comparison; deterministic: return digits (strip leading 1 for US)
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits
}

export function normalizeLinkedInUrl(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`)
    if (!/linkedin\.com$/i.test(u.hostname) && !/\.linkedin\.com$/i.test(u.hostname)) return ''
    const path = u.pathname.replace(/\/$/, '').toLowerCase()
    // must be /in/... or /company/...
    if (!/^\/(in|company)\/[a-z0-9\-_%]+$/.test(path)) return ''
    return `https://www.linkedin.com${path}`
  } catch { return '' }
}

export function normalizeFormUrl(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`)
    if (!['http:','https:'].includes(u.protocol)) return ''
    return u.href.replace(/\/$/, '')
  } catch { return '' }
}

// ── Role tier helpers (pure) ───────────────────────────────────────────────
export function getRoleTier(role) {
  const text = String(role || '').toLowerCase()
  if (!text.trim()) return null
  for (const entry of ROLE_TIER_KEYWORDS) {
    if (entry.pattern.test(text)) return entry.tier
  }
  return null
}

export function getRoleLabel(role) {
  const tier = getRoleTier(role)
  if (tier == null) return null
  const entry = ROLE_TIER_KEYWORDS.find(e => e.tier === tier)
  return entry ? entry.label : null
}

function isVerifiedRoleEmail(email) {
  const local = String(email || '').split('@')[0]?.toLowerCase() || ''
  return ROLE_EMAIL_LOCALS.has(local)
}

function isLikelyPersonName(value) {
  const text = cleanText(value)
  if (!text) return false
  if (text.length < 3 || text.length > 60) return false
  // Reject obvious non-names
  if (/^(contact|about|team|staff|leadership|services|home|privacy|terms|email|phone|address)/i.test(text)) return false
  // Must be 2-3 words, each capitalised, allow hyphen/apostrophe
  if (!/^[A-Z][a-z]+(?:\s+[A-Z][a-z\-']+){1,2}$/.test(text)) return false
  // Reject if contains digits or @
  if (/[\d@]/.test(text)) return false
  return true
}

function extractRole(text) {
  const cleaned = cleanText(text)
  // find first role keyword occurrence and return the surrounding phrase
  for (const entry of ROLE_TIER_KEYWORDS) {
    const m = cleaned.match(entry.pattern)
    if (m) return cleaned // return full cleaned string as role evidence; keep original phrasing
  }
  return cleaned
}

// ── Stable ID ───────────────────────────────────────────────────────────────
export function stableContactId(contact) {
  const channels = contact.channels || []
  const emails = channels.filter(c => c.type === 'email').map(c => normalizeEmail(c.value)).filter(Boolean).sort()
  const phones = channels.filter(c => c.type === 'phone').map(c => normalizePhone(c.value)).filter(Boolean).sort()
  const linkedins = channels.filter(c => c.type === 'linkedin').map(c => normalizeLinkedInUrl(c.value)).filter(Boolean).sort()
  const nameKey = cleanText(contact.name || '').toLowerCase()
  const roleKey = cleanText(contact.role || '').toLowerCase()
  const primary = emails[0] || phones[0] || linkedins[0] || (nameKey ? `name:${nameKey}|role:${roleKey}` : '')
  if (!primary) return `contact-${hashString(JSON.stringify({ name: nameKey, role: roleKey, channels: channels.map(c=>c.value).sort().join('|') }))}`
  return `contact-${hashString(primary)}`
}

// ── Channel tier for preferred ordering ───────────────────────────────────
export function getContactChannelTier(contact) {
  const roleTier = getRoleTier(contact.role)
  if (roleTier === 0) return 0
  if (roleTier === 1) return 1
  if (roleTier === 2) return 2
  const channels = contact.channels || []
  const hasVerifiedRoleEmail = channels.some(ch => ch.type === 'email' && ch.verified && isVerifiedRoleEmail(ch.value))
  if (hasVerifiedRoleEmail) return 3
  if (channels.some(ch => ch.type === 'email')) return 4
  if (channels.some(ch => ch.type === 'phone')) return 5
  if (channels.some(ch => ch.type === 'linkedin')) return 6
  if (channels.some(ch => ch.type === 'form')) return 7
  return 8
}

function channelCompletenessScore(contact) {
  const types = new Set((contact.channels || []).map(c => c.type))
  return types.size // 1-4
}

function confidenceScore(contact) {
  // average confidence weight: high=3, medium=2, low=1
  const map = { high: 3, medium: 2, low: 1 }
  const channels = contact.channels || []
  if (!channels.length) return 0
  const sum = channels.reduce((s, ch) => s + (map[ch.confidence] || 1), 0)
  return sum / channels.length
}

// ── Preferred contact selection (pure, deterministic) ─────────────────────
export function compareContacts(a, b) {
  const tierA = getContactChannelTier(a)
  const tierB = getContactChannelTier(b)
  if (tierA !== tierB) return tierA - tierB
  const verifiedA = (a.channels || []).some(c => c.verified) ? 1 : 0
  const verifiedB = (b.channels || []).some(c => c.verified) ? 1 : 0
  if (verifiedA !== verifiedB) return verifiedB - verifiedA // verified first
  const confA = confidenceScore(a)
  const confB = confidenceScore(b)
  if (confA !== confB) return confB - confA
  const compA = channelCompletenessScore(a)
  const compB = channelCompletenessScore(b)
  if (compA !== compB) return compB - compA
  const nameA = cleanText(a.name || '').toLowerCase()
  const nameB = cleanText(b.name || '').toLowerCase()
  if (nameA !== nameB) {
    if (!nameA) return 1
    if (!nameB) return -1
    return nameA.localeCompare(nameB)
  }
  const idA = a.id || ''
  const idB = b.id || ''
  return idA.localeCompare(idB)
}

export function selectPreferredContact(contacts) {
  if (!Array.isArray(contacts) || !contacts.length) return null
  const sorted = [...contacts].sort(compareContacts)
  return sorted[0]
}

export const getPreferredContact = selectPreferredContact

// ── Reachability scoring (pure, deterministic, transparent) ────────────────
export function computeReachabilityScore(contacts) {
  const list = Array.isArray(contacts) ? contacts : []
  const allChannels = list.flatMap(c => c.channels || [])
  const hasVerifiedRoleEmail = allChannels.some(ch => ch.type === 'email' && ch.verified && isVerifiedRoleEmail(ch.value))
  const hasVerifiedEmail = allChannels.some(ch => ch.type === 'email' && ch.verified)
  const hasEmail = allChannels.some(ch => ch.type === 'email')
  const hasPhone = allChannels.some(ch => ch.type === 'phone')
  const hasLinkedIn = allChannels.some(ch => ch.type === 'linkedin')
  const hasForm = allChannels.some(ch => ch.type === 'form')
  const hasNamed = list.some(c => c.name && cleanText(c.name).length >= 2 && cleanText(c.name).toLowerCase() !== 'unknown')
  const hasRole = list.some(c => c.role && cleanText(c.role).length >= 2)

  const components = []
  const add = (label, points, maximum, evidence) => components.push({ label, points, maximum, evidence })

  const emailPoints = hasVerifiedRoleEmail ? 30 : hasVerifiedEmail ? 25 : hasEmail ? 20 : 0
  const emailMax = 30
  add('Verified role email', hasVerifiedRoleEmail ? 30 : 0, 30, hasVerifiedRoleEmail ? 'Verified role-based email observed' : hasVerifiedEmail ? 'Verified email observed (not role-based)' : hasEmail ? 'Email observed (plain text)' : 'No email observed')
  // general email complement if verified role not present but email present
  if (!hasVerifiedRoleEmail && hasEmail) {
    // we already counted emailPoints as 20 or 25; represent as separate component for clarity
    // Instead, keep single email component but adjust evidence
  }
  // For transparency, we separate email tier points:
  // Actually we want a single email component: points = emailPoints

  // Rebuild to single email component for simplicity
  components.length = 0
  add('Email', emailPoints, emailMax, hasVerifiedRoleEmail ? 'Verified role email (e.g. owner@, manager@)' : hasVerifiedEmail ? 'Verified email via mailto' : hasEmail ? 'Email found in text' : 'No email found')
  add('Phone', hasPhone ? 20 : 0, 20, hasPhone ? 'Phone via tel: link or explicit text' : 'No phone found')
  add('LinkedIn', hasLinkedIn ? 15 : 0, 15, hasLinkedIn ? 'LinkedIn profile/company URL observed' : 'No LinkedIn found')
  add('Contact form', hasForm ? 10 : 0, 10, hasForm ? 'Contact form detected' : 'No form detected')
  add('Named contact', hasNamed ? 10 : 0, 10, hasNamed ? `Named person: ${list.find(c=>c.name && cleanText(c.name).toLowerCase()!=='unknown')?.name}` : 'No person name linked to channel')
  add('Role identified', hasRole ? 10 : 0, 10, hasRole ? `Role: ${list.find(c=>c.role)?.role}` : 'No role identified')
  const multiBonus = list.length >= 2 ? 5 : 0
  add('Multiple contacts', multiBonus, 5, list.length >= 2 ? `${list.length} distinct contacts` : 'Single contact')

  const score = components.reduce((s, c) => s + c.points, 0)
  const max = components.reduce((s, c) => s + c.maximum, 0) // should be 100
  const normalized = Math.max(0, Math.min(100, Math.round((score / max) * 100)))
  const band = normalized >= 80 ? 'High' : normalized >= 50 ? 'Medium' : normalized >= 20 ? 'Low' : 'Minimal'
  return { score: normalized, rawScore: score, max, components, band }
}

// ── Commercial / lead-value ranking (pure, does not mutate opportunityScore) ─
export function computeCommercialScore(lead) {
  const base = Number.isFinite(Number(lead.opportunityScore)) ? Number(lead.opportunityScore) : Number.isFinite(Number(lead.prelimScore)) ? Number(lead.prelimScore) : 0
  const reach = Number.isFinite(Number(lead.reachabilityScore)) ? Number(lead.reachabilityScore) : Number.isFinite(Number(lead.contactEnrichment?.reachabilityScore)) ? Number(lead.contactEnrichment.reachabilityScore) : null
  const qualifiedBonus = lead.qualified || lead.salesStage ? 5 : 0
  if (reach == null) return Math.max(0, Math.min(100, Math.round(base + qualifiedBonus)))
  // weighted combination: preserve opportunity primacy
  const combined = Math.round(base * 0.65 + reach * 0.35 + qualifiedBonus)
  return Math.max(0, Math.min(100, combined))
}

export function getLeadValueScore(lead) {
  return computeCommercialScore(lead)
}

export function compareLeadsByValue(a, b) {
  const va = computeCommercialScore(a)
  const vb = computeCommercialScore(b)
  if (va !== vb) return vb - va // descending
  const qa = a.qualified || a.salesStage ? 1 : 0
  const qb = b.qualified || b.salesStage ? 1 : 0
  if (qa !== qb) return qb - qa
  const oa = Number(a.opportunityScore ?? a.prelimScore ?? 0)
  const ob = Number(b.opportunityScore ?? b.prelimScore ?? 0)
  if (oa !== ob) return ob - oa
  return String(a.id || '').localeCompare(String(b.id || ''))
}

// ── Deduplication (pure) ───────────────────────────────────────────────────
export function dedupeContacts(contacts) {
  const map = new Map() // key -> contact
  const keyFor = (contact) => {
    const ch = contact.channels || []
    const emails = ch.filter(c=>c.type==='email').map(c=>normalizeEmail(c.value)).filter(Boolean)
    const phones = ch.filter(c=>c.type==='phone').map(c=>normalizePhone(c.value)).filter(Boolean)
    const linkedins = ch.filter(c=>c.type==='linkedin').map(c=>normalizeLinkedInUrl(c.value)).filter(Boolean)
    const nameKey = cleanText(contact.name || '').toLowerCase()
    const roleKey = cleanText(contact.role || '').toLowerCase()
    if (emails.length) return `email:${emails.sort().join('|')}`
    if (phones.length) return `phone:${phones.sort().join('|')}`
    if (linkedins.length) return `linkedin:${linkedins.sort().join('|')}`
    if (nameKey) return `name:${nameKey}|role:${roleKey}`
    return `anon:${hashString(JSON.stringify(contact))}`
  }

  for (const raw of contacts) {
    const key = keyFor(raw)
    if (!map.has(key)) {
      const clone = {
        id: raw.id || stableContactId(raw),
        name: raw.name || null,
        role: raw.role || null,
        roleTier: raw.roleTier ?? (getRoleTier(raw.role) ?? null),
        channels: [...(raw.channels || [])].map(ch => ({ ...ch })),
        sources: [...(raw.sources || [])],
        observedAt: raw.observedAt || null,
        confidence: raw.confidence || 'medium',
      }
      clone.id = stableContactId(clone)
      map.set(key, clone)
    } else {
      const existing = map.get(key)
      // merge channels deduping by normalized value + type
      const existingChannels = existing.channels || []
      for (const ch of (raw.channels || [])) {
        const norm = ch.type === 'email' ? normalizeEmail(ch.value) : ch.type === 'phone' ? normalizePhone(ch.value) : ch.type === 'linkedin' ? normalizeLinkedInUrl(ch.value) : String(ch.value||'').trim().toLowerCase()
        const dup = existingChannels.find(ec => {
          const en = ec.type === 'email' ? normalizeEmail(ec.value) : ec.type === 'phone' ? normalizePhone(ec.value) : ec.type === 'linkedin' ? normalizeLinkedInUrl(ec.value) : String(ec.value||'').trim().toLowerCase()
          return ec.type === ch.type && en === norm && en !== ''
        })
        if (!dup) {
          existingChannels.push({ ...ch })
        } else {
          // merge provenance: keep both sourceUrls in sources array
          dup.sources = [...new Set([...(dup.sources||[]), ...(ch.sources||[]), ch.sourceUrl].filter(Boolean))]
          // keep highest confidence and verified
          const confOrder = { low: 1, medium: 2, high: 3 }
          if ((confOrder[ch.confidence] || 1) > (confOrder[dup.confidence] || 1)) dup.confidence = ch.confidence
          if (ch.verified) dup.verified = true
          // merge observedAt earliest? keep earliest
        }
      }
      existing.channels = existingChannels
      // merge name/role if missing
      if (!existing.name && raw.name) existing.name = raw.name
      if (!existing.role && raw.role) existing.role = raw.role
      // keep most specific role tier (lowest number)
      const tExisting = getRoleTier(existing.role)
      const tRaw = getRoleTier(raw.role)
      if (tRaw != null && (tExisting == null || tRaw < tExisting)) existing.role = raw.role
      const srcSet = new Set([...(existing.sources||[]), ...(raw.sources||[]), raw.sourceUrl].filter(Boolean))
      existing.sources = [...srcSet].sort()
      if (!existing.observedAt && raw.observedAt) existing.observedAt = raw.observedAt
      else if (existing.observedAt && raw.observedAt && String(raw.observedAt) < String(existing.observedAt)) existing.observedAt = raw.observedAt
    }
  }
  const result = [...map.values()].sort(compareContacts)
  result.forEach(c => { c.id = stableContactId(c) })
  return result
}

// ── Provenance helpers ─────────────────────────────────────────────────────
function makeChannel(type, value, sourceUrl, observedAt, confidence, verified, method) {
  return {
    type,
    value: cleanText(value),
    normalized: type === 'email' ? normalizeEmail(value) : type === 'phone' ? normalizePhone(value) : type === 'linkedin' ? normalizeLinkedInUrl(value) : cleanText(value),
    sourceUrl,
    observedAt,
    confidence,
    verified,
    verificationStatus: verified ? 'verified' : method === 'existing-lead' ? 'unverified' : 'observed',
    method,
    sources: [sourceUrl].filter(Boolean),
  }
}

// ── HTML parsing ───────────────────────────────────────────────────────────
export function extractContactsFromHtml(html, pageUrl, observedAt) {
  const $ = load(html)
  const href = pageUrl instanceof URL ? pageUrl.href : String(pageUrl)
  const pageOrigin = (() => { try { return new URL(href).origin } catch { return '' } })()
  const now = observedAt || new Date().toISOString()
  const raws = []
  const associationIds = new WeakMap()
  let associationSequence = 0
  const associationKey = (element) => {
    if (!element) return null
    if (!associationIds.has(element)) associationIds.set(element, `association-${associationSequence += 1}`)
    return associationIds.get(element)
  }

  // 1) Structured data Persons
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).text()
    if (!text.trim()) return
    let data
    try { data = JSON.parse(text) } catch { return }
    const candidates = []
    const collect = (obj) => {
      if (!obj || typeof obj !== 'object') return
      if (Array.isArray(obj)) obj.forEach(collect)
      else {
        if (obj['@type'] === 'Person' || (Array.isArray(obj['@type']) && obj['@type'].includes('Person'))) candidates.push(obj)
        if (Array.isArray(obj['@graph'])) obj['@graph'].forEach(collect)
        // also search nested
        Object.values(obj).forEach(v => { if (v && typeof v === 'object') collect(v) })
      }
    }
    collect(data)
    candidates.forEach(item => {
      const name = cleanText(item.name)
      const role = cleanText(item.jobTitle || item.role || item.title)
      if (!name && !role) return
      // Only include if name looks like person or role contains tier keyword; otherwise skip to avoid false positives
      const hasRoleKeyword = ROLE_TIER_KEYWORDS.some(k => k.pattern.test(role))
      if (!isLikelyPersonName(name) && !hasRoleKeyword) return
      const email = cleanText(item.email)
      const tel = cleanText(item.telephone)
      const sameAs = Array.isArray(item.sameAs) ? item.sameAs : item.sameAs ? [item.sameAs] : []
      const linkedin = sameAs.find(u => /linkedin\.com/i.test(String(u)))
      const channels = []
      if (email && normalizeEmail(email)) channels.push(makeChannel('email', email, href, now, 'high', false, 'ld+json'))
      if (tel && normalizePhone(tel)) channels.push(makeChannel('phone', tel, href, now, 'high', false, 'ld+json'))
      if (linkedin && normalizeLinkedInUrl(linkedin)) channels.push(makeChannel('linkedin', linkedin, href, now, 'high', false, 'ld+json'))
      // Only create person contact if we have at least one channel OR explicit name+role with nearby evidence; skip empty persons
      if (!channels.length && !name) return
      // If person has no channel but we have name+role, we still keep as contact with no channel? We'll keep but with zero channels; later form fallback may handle.
      // To avoid inventing, require defensible association: if ld+json person has no channel, we still keep name+role as contact but mark low reachability.
      raws.push({
        name: isLikelyPersonName(name) ? name : null,
        role: role || null,
        channels,
        sourceUrl: href,
        observedAt: now,
        confidence: 'high',
        verified: channels.some(c=>c.verified),
        sources: [href],
      })
    })
  })

  const TIGHT_PERSON_SELECTOR = '[itemtype*="Person"], .team-member, .member, .staff, .person, .staff-member, .person-card'
  const isTightContainer = ($c) => {
    if (!$c || !$c.length) return false
    const el = $c.get(0)
    if (!el || !el.tagName) return false
    const tag = String(el.tagName).toLowerCase()
    if (['body','html','main','footer','header','nav'].includes(tag)) return false
    return true
  }
  // Helper to find associated name/role for a channel element — tightly scoped only
  const findAssociatedPerson = (element) => {
    const $el = $(element)
    const $explicit = $el.closest(TIGHT_PERSON_SELECTOR)
    if ($explicit && $explicit.length && isTightContainer($explicit)) {
      const nameCandidates = []
      $explicit.find('h1,h2,h3,h4,strong,b,[itemprop="name"],.name,.member-name,.person-name').each((_, ne) => {
        const t = cleanText($(ne).text())
        if (isLikelyPersonName(t)) nameCandidates.push(t)
      })
      const roleCandidates = []
      $explicit.find('[itemprop="jobTitle"], .role, .title, .position, p, small, span, em').each((_, re) => {
        const t = cleanText($(re).text())
        if (t && ROLE_TIER_KEYWORDS.some(k=>k.pattern.test(t))) roleCandidates.push(t)
      })
      const name = nameCandidates[0] || null
      const roleText = roleCandidates[0] || null
      const role = roleText ? extractRole(roleText) : null
      const container = $explicit.get(0)
      if (name || role) return { name, role, associationKey: associationKey(container) }
      return { name: null, role: null, associationKey: associationKey(container) }
    }
    const nearby = $el.prevAll().slice(0, 3).toArray().reverse()
    const name = nearby.map((node) => cleanText($(node).text())).find(isLikelyPersonName) || null
    const roleText = nearby.map((node) => cleanText($(node).text())).find((text) => ROLE_TIER_KEYWORDS.some((item) => item.pattern.test(text))) || null
    if (name || roleText) return { name, role: roleText ? extractRole(roleText) : null, associationKey: associationKey($el.parent().get(0)) }
    return { name: null, role: null, associationKey: null }
  }

  const seenEmails = new Set()
  const seenPhones = new Set()
  const seenLinkedins = new Set()

  // 2) mailto
  $('a[href^="mailto:"]').each((_, el) => {
    const hrefAttr = String($(el).attr('href') || '')
    const emailRaw = hrefAttr.replace(/^mailto:/i, '').split('?')[0].split('#')[0].trim()
    const norm = normalizeEmail(emailRaw)
    if (!norm) return
    if (seenEmails.has(norm)) return
    seenEmails.add(norm)
    const { name, role, associationKey: personAssociationKey } = findAssociatedPerson(el)
    // Only keep name if defensible (we already filtered via container); keep role only if role contains tier keyword
    const channels = [makeChannel('email', norm, href, now, 'high', false, 'mailto')]
    raws.push({
      name: name && isLikelyPersonName(name) ? name : null,
      role: role || null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'high',
      verified: true,
      sources: [href],
      associationKey: personAssociationKey,
    })
  })

  // 3) tel
  $('a[href^="tel:"]').each((_, el) => {
    const hrefAttr = String($(el).attr('href') || '')
    const phoneRaw = hrefAttr.replace(/^tel:/i, '').split('?')[0].trim()
    const norm = normalizePhone(phoneRaw)
    if (!norm) return
    if (seenPhones.has(norm)) return
    seenPhones.add(norm)
    const { name, role, associationKey: personAssociationKey } = findAssociatedPerson(el)
    const channels = [makeChannel('phone', phoneRaw, href, now, 'high', false, 'tel')]
    raws.push({
      name: name && isLikelyPersonName(name) ? name : null,
      role: role || null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'high',
      verified: true,
      sources: [href],
      associationKey: personAssociationKey,
    })
  })

  // 4) linkedin
  $('a[href*="linkedin.com"]').each((_, el) => {
    const hrefAttr = String($(el).attr('href') || '')
    const norm = normalizeLinkedInUrl(hrefAttr)
    if (!norm) return
    if (seenLinkedins.has(norm)) return
    seenLinkedins.add(norm)
    const { name, role, associationKey: personAssociationKey } = findAssociatedPerson(el)
    const channels = [makeChannel('linkedin', norm, href, now, 'high', false, 'linkedin')]
    raws.push({
      name: name && isLikelyPersonName(name) ? name : null,
      role: role || null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'high',
      verified: true,
      sources: [href],
      associationKey: personAssociationKey,
    })
  })

  // 5) Plain text fallback: only if no mailto/tel found? But we should still capture plain text emails not in href, with lower confidence
  // Extract from visible text, but mark verified false, confidence low/medium
  const bodyText = extractVisibleTextWithSeparators($)
  // Emails in text not already seen
  const textEmails = new Set()
  for (const m of (bodyText.match(EMAIL_REGEX) || [])) {
    const norm = normalizeEmail(m)
    if (!norm) continue
    if (seenEmails.has(norm)) continue
    // Filter obvious false positives like "image.jpg" etc - already handled by email regex
    // Ignore emails that look like example.com placeholders
    if (/example\.(com|org|net)$/i.test(norm)) continue
    textEmails.add(norm)
  }
  for (const email of textEmails) {
    // For plain text, do not associate name unless very defensible; keep name null to avoid invention
    const channels = [makeChannel('email', email, href, now, 'low', false, 'text')]
    raws.push({
      name: null,
      role: null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'low',
      verified: false,
      sources: [href],
    })
    seenEmails.add(email)
  }

  // Phones in text (fallback, low confidence)
  // Only if not already have tel links; but even if we have tels, we can add additional distinct numbers
  const textPhones = new Set()
  for (const m of (bodyText.match(PHONE_REGEX) || [])) {
    const norm = normalizePhone(m)
    if (!norm) continue
    if (seenPhones.has(norm)) continue
    // Filter short or invalid
    if (norm.length < 10) continue
    textPhones.add(m.trim())
  }
  for (const phoneRaw of textPhones) {
    const norm = normalizePhone(phoneRaw)
    if (!norm) continue
    const channels = [makeChannel('phone', phoneRaw, href, now, 'low', false, 'text')]
    raws.push({
      name: null,
      role: null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'low',
      verified: false,
      sources: [href],
    })
    seenPhones.add(norm)
  }

  // LinkedIn URLs in text (rare)
  for (const m of (html.match(LINKEDIN_REGEX) || [])) {
    const norm = normalizeLinkedInUrl(m)
    if (!norm) continue
    if (seenLinkedins.has(norm)) continue
    const channels = [makeChannel('linkedin', norm, href, now, 'low', false, 'text')]
    raws.push({
      name: null,
      role: null,
      channels,
      sourceUrl: href,
      observedAt: now,
      confidence: 'low',
      verified: false,
      sources: [href],
    })
    seenLinkedins.add(norm)
  }

  // 6) Form detection: if any form present, create form channel (lowest tier fallback)
  const hasForm = $('form').length > 0 || $('a[href*="contact"]').filter((_, a) => /contact/i.test($(a).text())).length > 0
  // Only create a form contact if we have at least one form element with inputs, or explicit contact link
  if ($('form').length > 0) {
    // Find form action or fallback to page href
    let formUrl = href
    const firstForm = $('form').first()
    const action = firstForm.attr('action')
    if (action) {
      try {
        const resolved = new URL(action, href)
        if (resolved.origin === pageOrigin) formUrl = resolved.href
      } catch {}
    }
    // Only push form contact if no other channels exist at all (fallback) or always as additional contact with form channel?
    // Spec says "contact form fallback" – implies create contact with form when other channels missing, but we can also add form as channel to allow reachability scoring
    // We will push a dedicated form contact; dedupe will merge if needed
    const alreadyHaveForm = raws.some(r => r.channels.some(c=>c.type==='form'))
    if (!alreadyHaveForm) {
      raws.push({
        name: null,
        role: null,
        channels: [makeChannel('form', formUrl, href, now, 'medium', false, 'form')],
        sourceUrl: href,
        observedAt: now,
        confidence: 'medium',
        verified: false,
        sources: [href],
      })
    }
  }

  return raws
}

export function extractAndNormalizeContacts(pages) {
  // pages: [{ html, url, observedAt }]
  const allRaws = []
  for (const page of pages) {
    const url = page.url instanceof URL ? page.url : new URL(page.url)
    const rawList = extractContactsFromHtml(page.html, url, page.observedAt)
    allRaws.push(...rawList)
  }
  if (!allRaws.length) return []
  // Merge same tight person card multi-channel (deterministic): same name+role+container -> one contact
  const containerGroups = new Map()
  for (const r of allRaws) {
    if (r.name && r.role && r.associationKey) {
      const key = `${String(r.name).toLowerCase().trim()}|${String(r.role).toLowerCase().trim()}|${String(r.sourceUrl)}|${r.associationKey}`
      if (!containerGroups.has(key)) containerGroups.set(key, [])
      containerGroups.get(key).push(r)
    }
  }
  for (const [key, group] of containerGroups) {
    if (group.length > 1) {
      const mergedChannels = []
      const seen = new Set()
      for (const g of group) for (const ch of (g.channels||[])) {
        const norm = ch.type==='email'?normalizeEmail(ch.value):ch.type==='phone'?normalizePhone(ch.value):ch.type==='linkedin'?normalizeLinkedInUrl(ch.value):String(ch.value||'').trim().toLowerCase()
        const k = `${ch.type}:${norm}`
        if (norm && !seen.has(k)) { seen.add(k); mergedChannels.push({...ch}) }
      }
      if (mergedChannels.length > 1) {
        const keeper = group[0]
        keeper.channels = mergedChannels
        keeper.sources = [...new Set(group.flatMap(x=>x.sources||[]).concat(group.map(x=>x.sourceUrl)).filter(Boolean))].sort()
        for (let i=1;i<group.length;i++) { const idx = allRaws.indexOf(group[i]); if (idx>=0) allRaws.splice(idx,1) }
      }
    }
  }
  // dedupe and normalize
  const deduped = dedupeContacts(allRaws)
  // Ensure each contact has stable id and normalized fields
  return deduped.map(c => ({
    ...c,
    id: stableContactId(c),
    name: c.name || null,
    role: c.role || null,
    roleTier: getRoleTier(c.role),
    channels: (c.channels || []).map(ch => ({
      type: ch.type,
      value: ch.value,
      normalized: ch.normalized || (ch.type==='email'?normalizeEmail(ch.value):ch.type==='phone'?normalizePhone(ch.value):ch.type==='linkedin'?normalizeLinkedInUrl(ch.value):cleanText(ch.value)),
      sourceUrl: ch.sourceUrl,
      observedAt: ch.observedAt,
      confidence: ch.confidence || 'medium',
      verified: Boolean(ch.verified),
      verificationStatus: ch.verificationStatus || (ch.verified ? 'verified' : 'observed'),
      method: ch.method || 'unknown',
      sources: ch.sources || [ch.sourceUrl].filter(Boolean),
    })),
    sources: c.sources || [],
    provenance: {
      sourceUrls: c.sources || [],
      observedAt: c.observedAt,
      provider: 'public-website',
    }
  }))
}

// ── Provider-agnostic contract & runner ───────────────────────────────────
export function createPublicWebsiteProvider(options = {}) {
  const fetchPublicText = options.fetchPublicText
  const normalizeWebsite = options.normalizeWebsite
  if (!fetchPublicText) throw new Error('fetchPublicText is required for public-website provider')
  if (!normalizeWebsite) throw new Error('normalizeWebsite is required')

  return {
    name: 'public-website',
    async enrich(lead, context = {}) {
      const now = context.now || new Date().toISOString()
      const maxPages = context.maxPages ?? CONTACT_ENRICHMENT_MAX_PAGES
      const maxBytes = context.maxBytes ?? CONTACT_ENRICHMENT_MAX_BYTES
      const website = lead.website
      if (!website) throw new Error('Lead has no website for contact enrichment')

      const startUrl = normalizeWebsite(website)

      const pages = []
      let homepage
      try {
        homepage = await fetchPublicText(startUrl, { maxBytes, timeoutMs: 12_000 })
      } catch (e) {
        throw new Error(`Contact enrichment could not fetch homepage: ${e.message}`)
      }
      pages.push({ html: homepage.text, url: homepage.url, observedAt: now })
      const finalOrigin = (() => {
        try { return new URL(homepage.url).origin } catch { return startUrl.origin }
      })()

      // Discover candidate same-origin contact-like pages from homepage links
      // Use cheerio to extract links, then filter by CONTACT_PATH_PATTERN
      const $ = load(homepage.text)
      const candidates = new Map()
      $('a[href]').each((_, el) => {
        const href = String($(el).attr('href') || '').trim()
        if (!href) return
        try {
          const target = new URL(href, homepage.url)
          if (target.origin !== finalOrigin) return
          if (!CONTACT_PATH_PATTERN.test(target.pathname)) return
          if (target.pathname.length > 80) return
          target.hash = ''
          target.search = ''
          const normalized = target.href.replace(/\/$/, '')
          if (candidates.has(normalized)) return
          candidates.set(normalized, target)
        } catch {}
      })

      const toFetch = [...candidates.values()].slice(0, Math.max(0, maxPages - 1))
      for (const target of toFetch) {
        try {
          const res = await fetchPublicText(target, { maxBytes, timeoutMs: 10_000 })
          // Only keep html pages
          const ct = String(res.contentType || '').toLowerCase()
          if (ct && !/html|xhtml/.test(ct) && !/<html/i.test(res.text)) continue
          pages.push({ html: res.text, url: res.url, observedAt: now })
        } catch {
          // bounded failure is not fatal; continue
        }
        // small delay if provided via context
        if (context.requestDelay) await new Promise(r => setTimeout(r, context.requestDelay))
      }

      const contacts = extractAndNormalizeContacts(pages)
      const reachability = computeReachabilityScore(contacts)
      const preferred = selectPreferredContact(contacts)

      return {
        provider: 'public-website',
        providerSummary: `Crawled ${pages.length} page(s) on ${finalOrigin}`,
        pagesCrawled: pages.length,
        pages,
        contacts,
        preferredContactId: preferred ? preferred.id : null,
        preferredContact: preferred || null,
        reachability,
        reachabilityScore: reachability.score,
        observedAt: now,
        sourceUrls: pages.map(p => p.url instanceof URL ? p.url.href : String(p.url)),
      }
    }
  }
}

// Default runner (provider-agnostic, dependency-injected)
export async function runContactEnrichment(lead, options = {}) {
  const providers = options.providers || []
  const fetchPublicText = options.fetchPublicText
  const normalizeWebsite = options.normalizeWebsite
  if (!providers.length) {
    if (!fetchPublicText || !normalizeWebsite) throw new Error('No providers and no fetch helper for contact enrichment')
    // create default public-website provider
    const def = createPublicWebsiteProvider({ fetchPublicText, normalizeWebsite })
    providers.push(def)
  }
  const errors = []
  for (const provider of providers) {
    try {
      const result = await provider.enrich(lead, options)
      // Ensure result has required shape
      const contacts = Array.isArray(result.contacts) ? result.contacts : []
      const reachability = result.reachability || computeReachabilityScore(contacts)
      const preferred = result.preferredContact || selectPreferredContact(contacts)
      return {
        provider: provider.name || result.provider || 'unknown',
        providerSummary: result.providerSummary || `Enriched via ${provider.name}`,
        pagesCrawled: result.pagesCrawled || 0,
        contacts,
        preferredContactId: preferred ? preferred.id : (result.preferredContactId || null),
        preferredContact: preferred || null,
        reachability,
        reachabilityScore: reachability.score,
        observedAt: result.observedAt || new Date().toISOString(),
        sourceUrls: result.sourceUrls || [],
      }
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`)
    }
  }
  throw new Error(`All contact enrichment providers failed: ${errors.join(' | ')}`)
}

// ── Apply enrichment result to lead ────────────────────────────────────────
export function applyContactEnrichmentToLead(lead, enrichmentResult, options = {}) {
  const now = options.now || new Date().toISOString()
  const existingContacts = Array.isArray(lead.contacts) ? lead.contacts : []
  const incomingContacts = Array.isArray(enrichmentResult.contacts) ? enrichmentResult.contacts : []
  let merged = dedupeContacts([...existingContacts, ...incomingContacts])

  const hasValidLegacyEmail = lead.email && lead.email !== 'Not collected' && String(lead.email).trim() !== '' && normalizeEmail(lead.email)
  const hasValidLegacyPhone = lead.phone && lead.phone !== 'Not collected' && String(lead.phone).trim() !== '' && normalizePhone(lead.phone)
  const emailExists = hasValidLegacyEmail && merged.some(c => (c.channels || []).some(ch => ch.type === 'email' && normalizeEmail(ch.value) === normalizeEmail(lead.email)))
  const phoneExists = hasValidLegacyPhone && merged.some(c => (c.channels || []).some(ch => ch.type === 'phone' && normalizePhone(ch.value) === normalizePhone(lead.phone)))
  const legacyContacts = []
  if (hasValidLegacyEmail && !emailExists) {
    legacyContacts.push({
      name: null,
      role: null,
      channels: [makeChannel('email', String(lead.email).trim(), null, now, 'medium', false, 'existing-lead')],
      sourceUrl: null,
      observedAt: now,
      confidence: 'medium',
      verified: false,
      sources: [],
    })
  }
  if (hasValidLegacyPhone && !phoneExists) {
    legacyContacts.push({
      name: null,
      role: null,
      channels: [makeChannel('phone', String(lead.phone).trim(), null, now, 'medium', false, 'existing-lead')],
      sourceUrl: null,
      observedAt: now,
      confidence: 'medium',
      verified: false,
      sources: [],
    })
  }
  if (legacyContacts.length) merged = dedupeContacts([...merged, ...legacyContacts])

  const preferred = selectPreferredContact(merged)
  const reachability = computeReachabilityScore(merged)
  const commercialScore = computeCommercialScore({ ...lead, contacts: merged, contactEnrichment: { reachabilityScore: reachability.score }, reachabilityScore: reachability.score })

  let derivedEmail = lead.email
  let derivedPhone = lead.phone
  const preferredEmail = preferred ? (preferred.channels || []).find(c => c.type === 'email')?.value : null
  const preferredPhone = preferred ? (preferred.channels || []).find(c => c.type === 'phone')?.value : null
  if ((!derivedEmail || derivedEmail === 'Not collected' || String(derivedEmail).trim() === '') && preferredEmail) derivedEmail = preferredEmail
  if ((!derivedPhone || derivedPhone === 'Not collected' || String(derivedPhone).trim() === '') && preferredPhone) derivedPhone = preferredPhone

  return {
    ...lead,
    contacts: merged,
    preferredContactId: preferred ? preferred.id : null,
    preferredContact: preferred || null,
    contactEnrichment: {
      status: 'Completed',
      provider: enrichmentResult.provider || 'public-website',
      providerSummary: enrichmentResult.providerSummary || '',
      pagesCrawled: enrichmentResult.pagesCrawled || 0,
      contactsCount: merged.length,
      reachabilityScore: reachability.score,
      reachability,
      observedAt: enrichmentResult.observedAt || now,
      updatedAt: now,
      error: null,
      sourceUrls: enrichmentResult.sourceUrls || [],
    },
    contactJob: { ...(lead.contactJob || {}), status: 'Completed', progress: 100, phase: 'Contact enrichment complete' },
    reachabilityScore: reachability.score,
    commercialScore,
    email: derivedEmail,
    phone: derivedPhone,
    updated: 'Just now',
  }
}

// Failure helper
export function applyContactEnrichmentFailure(lead, error, context = {}) {
  const now = context.now || new Date().toISOString()
  const jobId = context.jobId || lead.contactEnrichment?.jobId || null
  const existingScore = lead.reachabilityScore ?? lead.contactEnrichment?.reachabilityScore ?? null
  return {
    ...lead,
    contactEnrichment: {
      ...(lead.contactEnrichment || {}),
      status: 'Failed',
      error: String(error?.message || error || 'Contact enrichment failed'),
      updatedAt: now,
      jobId,
      reachabilityScore: existingScore,
    },
    contactJob: { ...(lead.contactJob||{}), id: jobId, status: 'Failed', progress: 100, phase: String(error?.message || 'Contact enrichment failed').slice(0, 120) },
    updated: 'Contact enrichment failed',
  }
}

// ── Lead normalization helpers ─────────────────────────────────────────────
function deriveStableObservedAt(lead) {
  const candidates = [lead.collectedAt, lead.auditedAt, lead.updatedAt, lead.lastRunAt].filter(Boolean)
  for (const c of candidates) {
    const d = new Date(c)
    if (!isNaN(d.getTime())) return d.toISOString()
    const parsed = Date.parse(String(c))
    if (!isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return null
}
export function ensureLeadContactFields(lead, now = null) {
  const stable = deriveStableObservedAt(lead)
  const effectiveNow = now || stable || null
  const contacts = Array.isArray(lead.contacts) ? lead.contacts : []
  let deduped = contacts.length ? dedupeContacts(contacts) : []

  const hasValidLegacyEmail = lead.email && lead.email !== 'Not collected' && String(lead.email).trim() !== '' && normalizeEmail(lead.email)
  const hasValidLegacyPhone = lead.phone && lead.phone !== 'Not collected' && String(lead.phone).trim() !== '' && normalizePhone(lead.phone)
  const emailExists = hasValidLegacyEmail && deduped.some(c => (c.channels || []).some(ch => ch.type === 'email' && normalizeEmail(ch.value) === normalizeEmail(lead.email)))
  const phoneExists = hasValidLegacyPhone && deduped.some(c => (c.channels || []).some(ch => ch.type === 'phone' && normalizePhone(ch.value) === normalizePhone(lead.phone)))
  const legacyContacts = []
  if (hasValidLegacyEmail && !emailExists) {
    legacyContacts.push({
      name: null,
      role: null,
      channels: [makeChannel('email', String(lead.email).trim(), null, effectiveNow, 'medium', false, 'existing-lead')],
      sourceUrl: null,
      observedAt: effectiveNow,
      confidence: 'medium',
      verified: false,
      sources: [],
    })
  }
  if (hasValidLegacyPhone && !phoneExists) {
    legacyContacts.push({
      name: null,
      role: null,
      channels: [makeChannel('phone', String(lead.phone).trim(), null, effectiveNow, 'medium', false, 'existing-lead')],
      sourceUrl: null,
      observedAt: effectiveNow,
      confidence: 'medium',
      verified: false,
      sources: [],
    })
  }
  if (legacyContacts.length) deduped = dedupeContacts([...deduped, ...legacyContacts])

  const preferred = lead.preferredContact || selectPreferredContact(deduped)
  const reachability = deduped.length ? computeReachabilityScore(deduped) : null
  const finalReachabilityScore = deduped.length ? reachability.score : (lead.reachabilityScore ?? lead.contactEnrichment?.reachabilityScore ?? null)
  const commercialScore = computeCommercialScore({ ...lead, contacts: deduped, reachabilityScore: finalReachabilityScore })
  const baseEnrichment = lead.contactEnrichment || {
    status: deduped.length ? 'Completed' : 'Not enriched',
    provider: legacyContacts.length ? 'existing-lead' : null,
    providerSummary: legacyContacts.length ? 'Existing lead phone/email preserved as structured contact' : '',
    pagesCrawled: 0,
    contactsCount: deduped.length,
    reachabilityScore: finalReachabilityScore,
    reachability,
    observedAt: legacyContacts.length ? effectiveNow : null,
    updatedAt: legacyContacts.length ? effectiveNow : null,
    error: null,
    sourceUrls: [],
  }
  const contactEnrichment = legacyContacts.length && lead.contactEnrichment
    ? {
        ...lead.contactEnrichment,
        contactsCount: deduped.length,
        reachabilityScore: finalReachabilityScore,
        reachability: reachability || lead.contactEnrichment.reachability,
        updatedAt: lead.contactEnrichment.updatedAt || effectiveNow,
      }
    : baseEnrichment
  return {
    ...lead,
    contacts: deduped,
    preferredContactId: lead.preferredContactId || (preferred ? preferred.id : null),
    preferredContact: preferred || null,
    contactEnrichment,
    reachabilityScore: finalReachabilityScore,
    commercialScore,
  }
}

export function getPreferredContactEmail(lead) {
  const pref = lead.preferredContact || selectPreferredContact(lead.contacts || [])
  const ch = pref ? (pref.channels||[]).find(c=>c.type==='email') : null
  if (ch) return ch.value
  // fallback to first email among contacts
  const allEmails = (lead.contacts||[]).flatMap(c=>c.channels||[]).filter(c=>c.type==='email')
  if (allEmails.length) return allEmails[0].value
  return lead.email && lead.email !== 'Not collected' ? lead.email : null
}

export function getPreferredContactPhone(lead) {
  const pref = lead.preferredContact || selectPreferredContact(lead.contacts || [])
  const ch = pref ? (pref.channels||[]).find(c=>c.type==='phone') : null
  if (ch) return ch.value
  const allPhones = (lead.contacts||[]).flatMap(c=>c.channels||[]).filter(c=>c.type==='phone')
  if (allPhones.length) return allPhones[0].value
  return lead.phone && lead.phone !== 'Not collected' ? lead.phone : null
}

// ── Auto-queue selection (pure) ────────────────────────────────────────────
export function selectTopLeadsForContactEnrichment(leads, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 30)))
  const recentHours = Number(options.recentHours ?? 24)
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now()
  const activeLeadIds = new Set(options.activeLeadIds || [])
  const recentlyCompletedIds = new Set(options.recentlyCompletedIds || [])

  // Build sets if not provided but jobs passed
  const activeSet = activeLeadIds
  const recentSet = recentlyCompletedIds
  // Also compute from leads' contactEnrichment if needed
  const eligible = (leads || []).filter(lead => {
    if (!lead.website) return false
    const websiteOk = (() => { try { const u = new URL(lead.website.startsWith('http')?lead.website:`https://${lead.website}`); return ['http:','https:'].includes(u.protocol)} catch { return false } })()
    if (!websiteOk) return false
    if (activeSet.has(lead.id)) return false
    if (recentSet.has(lead.id)) return false
    // Check lead's own contactEnrichment updatedAt recency
    const updatedAt = lead.contactEnrichment?.updatedAt || lead.contactEnrichment?.observedAt
    if (updatedAt) {
      const ageHours = (nowMs - new Date(updatedAt).getTime()) / (1000*60*60)
      if (ageHours >= 0 && ageHours < recentHours) return false
    }
    return true
  })

  eligible.sort(compareLeadsByValue)
  // After sorting, dedupe by website? Keep stable id ordering already handles
  return eligible.slice(0, limit)
}

export function isValidDomainStrict(value) {
  const s = String(value || '').trim().toLowerCase()
  if (s.length < 3 || s.length > 253) return false
  if (/\s/.test(s)) return false
  if (!s.includes('.')) return false
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})+$/i.test(s)
}
