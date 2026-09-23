import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Home,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  PanelLeftClose,
  Radar,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Star,
  Trophy,
  X,
} from 'lucide-react'
import {
  getFieldErrorsFromApiError,
  collectedSearchText,
  duplicateLeadCounts,
  duplicateLeadGroups,
  formatCollectedDate,
  getMuseGuidance,
  getNextAction,
  getOutreachState,
  getResearchLabel,
  getResearchState,
  getSidebarCounts,
  isContacted,
  isOpenPipeline,
  isQualified,
  leadCollectedTime,
  researchStages,
  salesStages,
  validateImportRows,
  validateLeadDraft,
  validateRunConfig,
  validateSettingsDraft,
} from './domain/workflow'
import { ATTEMPT_OUTCOMES, NEXT_TASK_TYPES, TASK_OWNERS, addDaysString, describeOpportunity, localDayString, rankFindingsForOutreach, taskBucket } from '../server/services/brief.js'
import { buildQueue, computeReadiness, explainReadiness } from '../server/services/readiness.js'
import PreviewPage from './preview/PreviewPage.jsx'
import CrawlPage from './CrawlPage.jsx'
import LandingPage from './LandingPage.jsx'

const navItems = [
  { label: 'Overview', Icon: Home },
  { label: 'Clients', Icon: Building2 },
  { label: 'Starred', Icon: Star },
  { label: 'Research', Icon: Sparkles },
  { label: 'Crawl', Icon: Radar },
  { label: 'Outreach', Icon: Mail },
  { label: 'Pipeline', Icon: BarChart3 },
  { label: 'Contracts', Icon: Trophy },
]

const researchLabels = researchStages.map((stage) => stage.label)
const pipelineStages = [...salesStages]
const pagePaths = { Overview: '/overview', Clients: '/clients', Starred: '/starred', Research: '/research', Review: '/review', Crawl: '/crawl', Outreach: '/outreach', Pipeline: '/pipeline', Contracts: '/contracts', Won: '/won', Settings: '/settings', Preview: '/preview' }
const pathPages = Object.fromEntries(Object.entries(pagePaths).map(([page, path]) => [path.slice(1), page]))
pathPages.won = 'Contracts'

function readRoute() {
  const search = window.location.search || ''
  let segments
  try { segments = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent) }
  catch { return { page: 'NotFound', clientId: null, requestedPath: window.location.pathname, canonical: true, search } }
  if (!segments.length) return { page: 'Overview', clientId: null, requestedPath: null, canonical: false, search }
  const page = pathPages[segments[0].toLowerCase()]
  if (!page || segments.length > 2 || (page === 'Settings' && segments.length > 1)) return { page: 'NotFound', clientId: null, requestedPath: window.location.pathname, canonical: true, search }
  return { page, clientId: segments[1] || null, requestedPath: null, canonical: true, search }
}

function routePath(page, clientId = null) {
  const base = pagePaths[page] || pagePaths.Clients
  return clientId ? `${base}/${encodeURIComponent(clientId)}` : base
}

class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 75_000)
  try {
    const { timeoutMs: _timeoutMs, ...requestOptions } = options
    const response = await fetch(path, { ...requestOptions, signal: controller.signal })
    const raw = await response.text()
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    if (response.status === 401) window.dispatchEvent(new Event('scoutline:auth-required'))
    if (!response.ok) throw new ApiError(body?.error || `Request failed with HTTP ${response.status}`, response.status, body)
    return body
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('The request took too long. Please try again.')
    if (error instanceof ApiError) throw error
    throw new ApiError(navigator.onLine ? 'The local API could not be reached.' : 'You appear to be offline.')
  } finally {
    window.clearTimeout(timeout)
  }
}

function isValidHttpUrl(value) {
  const v = String(value || '').trim()
  if (!v) return false
  try { const u = new URL(v.startsWith('http') ? v : `https://${v}`); return ['http:', 'https:'].includes(u.protocol) } catch { return false }
}

function validateContractDraft(draft) {
  const errors = {}
  const amountRaw = String(draft.amount ?? '').trim()
  if (amountRaw === '') errors.amount = 'Approved amount is required'
  else { const n = Number(amountRaw); if (!Number.isFinite(n) || n < 0) errors.amount = 'Amount must be 0 or more'; else if (n > 10000000) errors.amount = 'Amount is too large' }
  const cur = String(draft.currency || '').trim()
  if (cur && !['USD','INR','GBP','EUR'].includes(cur)) errors.currency = 'Currency must be USD, INR, GBP, or EUR'
  const scope = String(draft.scope || '').trim()
  if (!scope) errors.scope = 'Approved scope is required'
  else if (scope.length < 5) errors.scope = 'Scope must be at least 5 characters'
  else if (scope.length > 2000) errors.scope = 'Scope must be 2000 characters or fewer'
  const sOn = String(draft.signedOn || '').trim()
  const sDate = String(draft.startDate || '').trim()
  if (sOn && Number.isNaN(Date.parse(sOn))) errors.signedOn = 'Enter a valid date'
  if (sDate && Number.isNaN(Date.parse(sDate))) errors.startDate = 'Enter a valid date'
  if (sOn && sDate && !errors.signedOn && !errors.startDate) {
    if (new Date(sDate) < new Date(sOn)) errors.startDate = 'Start date cannot be before signed date'
  }
  return { errors, isValid: Object.keys(errors).length === 0 }
}

function validateInsightDraft({ score, confidence, insight }) {
  const errors = {}
  const s = score === '' || score == null ? '' : String(score).trim()
  const c = confidence === '' || confidence == null ? '' : String(confidence).trim()
  const note = String(insight || '').trim()
  if (s === '') errors.score = 'Score is required'
  else { const n = Number(s); if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) errors.score = 'Score must be 0-100' }
  if (c === '') errors.confidence = 'Confidence is required'
  else { const n = Number(c); if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) errors.confidence = 'Confidence must be 0-100' }
  if (!note) errors.insight = 'Review note is required'
  else if (note.length < 5) errors.insight = 'Note must be at least 5 characters'
  else if (note.length > 2000) errors.insight = 'Note must be 2000 characters or fewer'
  return { errors, isValid: Object.keys(errors).length === 0 }
}

function validateFailureDraft({ reason }) {
  const errors = {}
  const r = String(reason || '').trim()
  if (!r) errors.reason = 'Describe what went wrong'
  else if (r.length < 5) errors.reason = 'Reason must be at least 5 characters'
  else if (r.length > 2000) errors.reason = 'Reason must be 2000 characters or fewer'
  return { errors, isValid: Object.keys(errors).length === 0 }
}


const statusTone = {
  Qualified: 'indigo', Contacted: 'blue', Replied: 'cyan', Meeting: 'amber', Proposal: 'pink', Won: 'green', Lost: 'gray',
  Running: 'orange', Queued: 'purple', Waiting: 'amber', Paused: 'amber', Completed: 'green', Cancelled: 'gray', Failed: 'red',
  Error: 'red', 'Timed out': 'amber', 'Completed with errors': 'amber', Skipped: 'gray',
}

const categoryTone = {
  Roofing: 'orange', HVAC: 'cyan', Flooring: 'purple', Remodeling: 'pink', Electrical: 'amber', Landscaping: 'green',
  Concrete: 'slate', Plumbing: 'blue', Windows: 'indigo', Decking: 'brown', Fencing: 'amber', 'Garage Doors': 'blue',
}

function cn(...values) { return values.filter(Boolean).join(' ') }

// Tab cycles inside the given dialog container so keyboard users never slip
// behind an open overlay. Escape is handled globally (see the App keydown
// effect); this only traps Tab.
function trapTabIn(ref, event) {
  if (event.key !== 'Tab' || !ref.current) return
  const items = ref.current.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

// Commercial rank uses the persisted commercial score only (M2): an
// unscored business ranks 0, never borrowing the website-opportunity score.
// "Highest score" below is the separate, explicitly labelled
// website-need sort.
function leadRankValue(lead = {}) {
  return Number(lead.leadValue?.leadValueScore ?? 0) || 0
}

// Named-score rank for the "Highest score" sort: the opportunity score
// leads, commercial value only breaks ties.
function opportunityRankValue(lead = {}) {
  return Number(lead.opportunityScore ?? lead.leadValue?.leadValueScore ?? lead.prelimScore ?? 0) || 0
}

// Shared table sort (Clients + Research). Recommended keeps the caller's
// commercial order; every table also sorts by name, score, and date, both
// directions, driven by the sort select or the clickable column headers.
const TABLE_SORTS = ['Recommended', 'Company A–Z', 'Company Z–A', 'Highest score', 'Lowest score', 'Newest first', 'Oldest first']
function sortTableRows(rows, sortMode, recommendedRank) {
  const list = [...rows]
  if (sortMode === 'Company A–Z') list.sort((a, b) => String(a.company || '').localeCompare(String(b.company || '')))
  else if (sortMode === 'Company Z–A') list.sort((a, b) => String(b.company || '').localeCompare(String(a.company || '')))
  else if (sortMode === 'Highest score') list.sort((a, b) => opportunityRankValue(b) - opportunityRankValue(a))
  else if (sortMode === 'Lowest score') list.sort((a, b) => opportunityRankValue(a) - opportunityRankValue(b))
  else if (sortMode === 'Newest first') list.sort((a, b) => leadCollectedTime(b) - leadCollectedTime(a))
  else if (sortMode === 'Oldest first') list.sort((a, b) => leadCollectedTime(a) - leadCollectedTime(b))
  else if (recommendedRank) list.sort(recommendedRank)
  return list
}

// Clickable table headers. Each sortable column owns a natural/reverse mode
// pair; clicking toggles direction, clicking another column starts natural.
const TABLE_COLUMNS = {
  client: { label: 'Client', natural: 'Company A–Z', reverse: 'Company Z–A' },
  score: { label: 'Score', natural: 'Highest score', reverse: 'Lowest score' },
  added: { label: 'Added', natural: 'Newest first', reverse: 'Oldest first' },
}
function nextColumnSort(column, sortMode) {
  const def = TABLE_COLUMNS[column]
  if (!def) return sortMode
  if (sortMode === def.natural) return def.reverse
  return def.natural
}
function SortHeader({ column, sortMode, onSort }) {
  const def = TABLE_COLUMNS[column]
  const active = sortMode === def.natural || sortMode === def.reverse
  // Name sorts A→Z ascending; score and date lead with the largest first.
  const ascending = column === 'client' ? sortMode === def.natural : sortMode === def.reverse
  return <button type="button" className={cn('sortable-head', active && 'is-active')} onClick={() => onSort(nextColumnSort(column, sortMode))} aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'} title={active ? `Sorted ${sortMode}; activate to reverse` : `Sort by ${def.label.toLowerCase()}`}><span>{def.label}</span>{active ? (ascending ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null}</button>
}

function commercialStatusLabel(lead = {}) {
  const stored = lead.leadValue || null
  if (!stored) return 'Unscored'
  if (Number(stored.coverage || 0) < 0.5) return 'Insufficient evidence'
  if (stored.scoredAt && lead.auditedAt && Date.parse(lead.auditedAt) > Date.parse(stored.scoredAt)) return 'Stale'
  return 'Scored'
}

function websiteUrl(website) {
  const value = String(website || '').trim()
  if (!value) return null
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function mapsUrl(lead) {
  const source = String(lead?.sourceUrl || '').trim()
  if (/^https?:\/\//i.test(source)) return source
  const query = [lead?.company, lead?.address, lead?.location].filter((value) => value && value !== 'Unknown' && value !== 'Not collected').join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

function auditAge(iso) {
  const time = new Date(iso || '').getTime()
  if (Number.isNaN(time)) return 'unknown age'
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function parseCsv(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell.trim()); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row) }
  if (rows.length < 2) return []
  const headers = rows[0].map((header) => header.toLowerCase().replace(/\s+/g, '_'))
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])))
}

function downloadText(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

const researchState = getResearchState
const isQualifiedLead = isQualified
const isOpenPipelineLead = isOpenPipeline

function currency(amount, code = 'USD') {
  if (!Number(amount)) return 'Not recorded'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(Number(amount))
}

function outreachSubject(lead) {
  return lead.outreachSubject || `Quick idea for ${lead.company}`
}

const outreachVersions = ['Concise', 'Balanced', 'Detailed']

function outreachVersion(lead) {
  if (outreachVersions.includes(lead.outreachVersion)) return lead.outreachVersion
  return lead.outreachDraft ? 'Balanced' : 'Concise'
}

function findingAdvice(finding) {
  const value = String(finding || '').toLowerCase()
  if (/(speed|slow|seconds|lcp|performance|mb|unoptimized|transfer size|hero video)/.test(value)) return {
    why: 'A slow first experience can make mobile visitors leave before they reach the offer.',
    change: 'Compress heavy media, remove unnecessary scripts, and prioritize the content needed above the fold.',
  }
  if (/(form|fields|quote request|budget qualifier)/.test(value)) return {
    why: 'A long or unclear first step can create unnecessary friction for otherwise interested visitors.',
    change: 'Use a shorter staged enquiry flow that asks only for the information needed to begin the conversation.',
  }
  if (/(cta|call to action|next step|below the fold)/.test(value)) return {
    why: 'Visitors may understand the service but still be unsure what action to take next.',
    change: 'Choose one primary action and repeat it at the moments where a visitor has enough context to respond.',
  }
  if (/(gallery|portfolio|project|images|photos)/.test(value)) return {
    why: 'Strong work is less persuasive when visitors cannot connect it to a service, material, or outcome.',
    change: 'Add project context, useful filtering, and a relevant enquiry action alongside the visual proof.',
  }
  if (/(seo|schema|title|description|service-area|service pages|local business)/.test(value)) return {
    why: 'Thin or inconsistent page structure can make services harder for both customers and search engines to understand.',
    change: 'Create focused service pages with clear titles, local context, internal links, and appropriate structured data.',
  }
  if (/(trust|license|warranty|testimonial|review|financing)/.test(value)) return {
    why: 'Important reassurance is missing at the point where a visitor is deciding whether to enquire.',
    change: 'Move the most relevant proof and buying information closer to the primary offer and contact action.',
  }
  if (/(mobile|header|navigation)/.test(value)) return {
    why: 'The interface can obscure important content or make the next step harder to find on smaller screens.',
    change: 'Simplify the mobile hierarchy, reduce persistent interface height, and keep the primary action visible.',
  }
  return {
    why: 'This creates avoidable uncertainty in the customer journey.',
    change: 'Clarify the content hierarchy and give visitors one obvious, low-friction next step.',
  }
}

function outreachBody(lead, version = 'Concise', offer = null) {
  if (lead.outreachDrafts?.[version]) return lead.outreachDrafts[version]
  if (lead.outreachDraft && outreachVersion(lead) === version) return lead.outreachDraft
  // Client-side preview only renders verified findings; with none, it renders
  // nothing instead of inventing default defects. The close uses the
  // configured offer CTA — never a hardcoded free-homepage promise.
  const findings = (lead.problems?.length ? lead.problems : (lead.issueDetail ? [lead.issueDetail] : [])).filter(Boolean).slice(0, 3).map((item) => {
    const clean = String(item).trim().replace(/[.!?]+$/, '')
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : ''
  }).filter(Boolean)
  if (!findings.length) return ''
  const cta = String(offer?.callToAction || 'Would it be useful if I shared a short outline of the change?').trim()
  const [first, second, third] = findings
  if (version === 'Detailed') {
    const observations = [first, second, third].filter(Boolean)
    const report = observations.map((finding, index) => {
      const advice = findingAdvice(finding)
      return `${index + 1}. ${finding}\nWhy it matters: ${advice.why}\nHow I’d improve it: ${advice.change}`
    }).join('\n\n')
    return `Hi —\n\nI reviewed ${lead.company}'s website and pulled together a short audit of the main areas I’d improve:\n\n${report}\n\nOverall direction\nI’d shape the redesign around ${String(lead.mainIssue || 'a clearer customer journey').toLowerCase()}, a stronger visual hierarchy, and a simpler path from interest to enquiry.\n\n${cta}`
  }
  if (version === 'Balanced') {
    const observations = [first, second].filter(Boolean)
    const list = observations.map((finding) => `• ${finding}`).join('\n')
    return `Hi —\n\nI reviewed ${lead.company}'s website and ${observations.length > 1 ? 'two things' : 'one thing'} stood out:\n${list}\n\nThese issues can make it harder for visitors to understand the offer and take the next step, especially on mobile. I’d focus the redesign on ${String(lead.mainIssue || 'a clearer customer journey').toLowerCase()}, a clearer primary action, stronger proof near the enquiry point, and a simpler mobile path.\n\n${cta}`
  }
  return `Hi — I reviewed ${lead.company}'s website and noticed one clear opportunity: ${first}. I have a straightforward idea to improve it and make the next step easier for visitors. ${cta}`
}

function Logo() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
}

function GoogleSignInButton({ clientId, onCredential, onError }) {
  const buttonRef = useRef(null)
  const callbackRef = useRef(onCredential)
  callbackRef.current = onCredential

  useEffect(() => {
    let stopped = false
    const render = () => {
      if (stopped || !buttonRef.current || !window.google?.accounts?.id) return
      buttonRef.current.replaceChildren()
      window.google.accounts.id.initialize({ client_id: clientId, callback: (response) => callbackRef.current(response.credential) })
      window.google.accounts.id.renderButton(buttonRef.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300 })
    }

    const existing = document.querySelector('script[data-scoutline-google-identity]')
    if (window.google?.accounts?.id) render()
    else if (existing) {
      existing.addEventListener('load', render, { once: true })
      existing.addEventListener('error', onError, { once: true })
    } else {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.dataset.scoutlineGoogleIdentity = 'true'
      script.addEventListener('load', render, { once: true })
      script.addEventListener('error', onError, { once: true })
      document.head.appendChild(script)
    }
    return () => { stopped = true; existing?.removeEventListener('load', render); existing?.removeEventListener('error', onError) }
  }, [clientId, onError])

  return <div className="google-signin" ref={buttonRef} aria-label="Sign in with Google" />
}

function LoginPage({ configured, clientId, error, signingIn, onCredential, onRetry }) {
  const handleScriptError = useCallback(() => onRetry('Google sign-in could not be loaded. Check your connection and try again.'), [onRetry])
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand"><Logo /><span>Scoutline</span></div>
        <Badge tone="blue">Private workspace</Badge>
        <h1 id="auth-title">Sign in to continue</h1>
        <p>Use a Google account that has been added to this workspace’s email allowlist.</p>
        {!configured ? <div className="auth-setup" role="alert"><strong>Google login needs configuration</strong><span>Add <code>GOOGLE_CLIENT_ID</code> and <code>SCOUTLINE_ALLOWED_EMAILS</code> to <code>.env</code>, then restart the server.</span></div> : <GoogleSignInButton clientId={clientId} onCredential={onCredential} onError={handleScriptError} />}
        {signingIn && <div className="auth-progress" role="status"><LoaderCircle className="spin" size={15} />Checking account…</div>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <small>Access is checked by the server after Google verifies the account.</small>
      </section>
    </main>
  )
}

const Badge = memo(function Badge({ children, tone = 'gray', dot = false }) {
  return <span className={cn('badge', `badge-${tone}`)}>{dot && <i />}{children}</span>
})

const Score = memo(function Score({ value, size = 'normal' }) {
  const score = value ?? 0
  const tone = score >= 88 ? 'great' : score >= 80 ? 'good' : score >= 70 ? 'fair' : 'low'
  return <span className={cn('score', `score-${tone}`, `score-${size}`)} title={value == null ? 'Not analyzed yet' : `Opportunity score ${value}`}>{value ?? '—'}</span>
})

const Avatar = memo(function Avatar({ name, size = 'normal' }) {
  const initials = name.split(' ').map((part) => part[0]).slice(0, 2).join('')
  return <span className={cn('avatar', `avatar-${size}`)}>{initials}</span>
})

function IconButton({ children, label, className, ...props }) {
  return <button className={cn('icon-button', className)} aria-label={label} {...props}>{children}</button>
}

function ResearchProgress({ lead, compact = false, labels = true }) {
  const { done, failure, phase } = researchState(lead)
  return (
    <div className={cn('research-progress', compact && 'research-progress-compact')} aria-label={`Research phase: ${researchLabels[phase]}${failure ? ' failed' : ''}`}>
      {researchLabels.map((label, index) => {
        const state = failure?.stage === index ? 'Failed' : done[index] && index === phase ? 'Completed · Current stage' : done[index] ? 'Completed' : index === phase ? 'Current stage' : 'Upcoming'
        return <div key={label} className={cn(failure?.stage === index ? 'is-failed' : done[index] ? 'is-complete' : index === phase ? 'is-current' : 'is-upcoming', index === phase && 'is-current')} aria-current={index === phase ? 'step' : undefined}>
          <span tabIndex="0" data-tooltip={`${label} · ${state}`} aria-label={`${label}: ${state}`}>{failure?.stage === index ? <X size={9} /> : done[index] ? <Check size={9} /> : index + 1}</span>
          {labels && <small><b>{label}</b>{failure?.stage === index ? <em className="failed-label">Failed</em> : index === phase && <em>Current</em>}</small>}
        </div>
      })}
    </div>
  )
}

function Sidebar({ page, setPage, open, close, counts, currentUser, onLogout }) {
  const go = (next) => { setPage(next); close() }
  return (
    <>
      {open && <button className="nav-scrim" aria-label="Close navigation" onClick={close} />}
      <aside className={cn('sidebar', open && 'sidebar-open')}>
        <div className="brand-row">
          <button className="brand-button" onClick={() => go('Clients')}><Logo /><span>Scoutline</span><Badge tone="blue">Local</Badge></button>
          <IconButton label="Close sidebar" className="sidebar-close" onClick={close}><PanelLeftClose size={15} /></IconButton>
        </div>
        <div className="workspace-label"><span>Client workspace</span></div>
        <nav className="main-nav" aria-label="Client workflow">
          {navItems.map(({ label, Icon }) => (
            <button key={label} className={cn('nav-item', page === label && 'nav-item-active')} aria-current={page === label ? 'page' : undefined} onClick={() => go(label)}>
              <span className="nav-emoji" aria-hidden="true"><Icon size={16} /></span><span>{label}</span>
              {counts[label] > 0 && <small>{counts[label]}</small>}
            </button>
          ))}
        </nav>
        <div className="workflow-key">
          <span>Up next</span>
          <button onClick={() => go('Research')}><span className="key-emoji" aria-hidden="true"><Check size={12} /></span>{counts.Research} to review</button>
          <button onClick={() => go('Outreach')}><span className="key-emoji" aria-hidden="true"><Mail size={12} /></span>{counts.Outreach} to contact</button>
          <button onClick={() => go('Pipeline')}><span className="key-emoji" aria-hidden="true"><BarChart3 size={12} /></span>{counts.Pipeline} open deals</button>
        </div>
        <div className="sidebar-bottom">
          <button className={cn('nav-item', page === 'Settings' && 'nav-item-active')} aria-current={page === 'Settings' ? 'page' : undefined} onClick={() => go('Settings')}><span className="nav-emoji" aria-hidden="true"><SettingsIcon size={16} /></span><span>Settings</span></button>
          <div className="profile-row auth-profile-row"><Avatar name={currentUser.name || currentUser.email} /><span><strong>{currentUser.name || currentUser.email}</strong><small>{currentUser.email}</small></span><IconButton label="Sign out" onClick={onLogout}><LogOut size={13} /></IconButton></div>
        </div>
      </aside>
    </>
  )
}

function Topbar({ title, meta, actions, onMenu, onSearch, theme, toggleTheme, onAdd }) {
  return (
    <header className="topbar">
      <div className="topbar-left"><IconButton label="Open navigation" className="mobile-menu" onClick={onMenu}><Menu size={17} /></IconButton><span className="topbar-title">{title}</span>{meta ? <span className="topbar-meta">{meta}</span> : null}</div>
      <div className="top-actions">{actions}
        <button className="global-search" onClick={onSearch}><span className="e e14" aria-hidden="true">🔍</span><span>Find a client</span><kbd>⌘ K</kbd></button>
        <IconButton label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={toggleTheme}>{theme === 'light' ? '🌙' : '☀️'}</IconButton>
        <button className="button button-primary top-run" onClick={onAdd}><span className="e" aria-hidden="true">➕</span>Create</button>
      </div>
    </header>
  )
}

function NewMenu({ close, onRun, onImport, onManual }) {
  return <div className="modal-overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="new-menu" role="dialog" aria-modal="true" aria-label="Create menu"><div className="new-menu-head"><div><span className="detail-label">Create</span><h2>What are you adding?</h2></div><IconButton label="Close create menu" onClick={close} autoFocus><X size={15} /></IconButton></div><button onClick={() => { close(); onRun() }}><span><span className="e e16" aria-hidden="true">▶️</span></span><div><strong>Start research run</strong><small>Discover businesses and audit their websites.</small></div><ArrowRight size={13} /></button><button onClick={() => { close(); onImport() }}><span><span className="e e16" aria-hidden="true">📥</span></span><div><strong>Import CSV</strong><small>Add a prepared list of clients and evidence.</small></div><ArrowRight size={13} /></button><button onClick={() => { close(); onManual() }}><span><span className="e e16" aria-hidden="true">➕</span></span><div><strong>Add client manually</strong><small>Save one client now and research it later.</small></div><ArrowRight size={13} /></button></div></div>
}



function overviewStats(leads, runs) {
  const inPipeline = leads.filter(isOpenPipelineLead)
  const won = leads.filter((lead) => lead.salesStage === 'Won')
  const ready = leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead))
  const analyzed = leads.filter((lead) => researchState(lead).analyzed && !researchState(lead).failure)
  const qualified = leads.filter(isQualifiedLead)
  return {
    inPipeline, won, ready,
    summary: [
      { label: 'Total clients', value: leads.length, detail: `${new Set(leads.map((lead) => lead.category)).size} categories`, emoji: '🏢', tone: 'blue' },
      { label: 'Ready to review', value: ready.length, detail: 'Research complete · decision needed', emoji: '✅', tone: 'purple' },
      { label: 'Open pipeline', value: inPipeline.length, detail: `${inPipeline.filter((lead) => lead.salesStage === 'Proposal').length} at proposal`, emoji: '💼', tone: 'orange' },
      { label: 'Won', value: won.length, detail: won.some((lead) => Number(lead.contract?.amount)) ? `${currency(won.reduce((total, lead) => total + Number(lead.contract?.amount || 0), 0))} recorded` : 'No contract value yet', emoji: '🏆', tone: 'green' },
    ],
    funnel: [
      { label: 'Total clients', count: leads.length, tone: 'blue' },
      { label: 'Researched', count: analyzed.length, tone: 'purple' },
      { label: 'Qualified', count: qualified.length, tone: 'indigo' },
      { label: 'Proposal', count: inPipeline.filter((lead) => lead.salesStage === 'Proposal').length, tone: 'pink' },
      { label: 'Won', count: won.length, tone: 'green' },
    ],
    latestRuns: [...runs].sort((a, b) => new Date(b.startedAt || b.createdAt || 0).getTime() - new Date(a.startedAt || a.createdAt || 0).getTime()).slice(0, 2),
    topLeads: [...leads].sort((a, b) => leadRankValue(b) - leadRankValue(a)).slice(0, 3),
  }
}

function OverviewPage({ leads, runs, onOpen, onImport, onExport, goTo, onNewRun }) {
  const stats = overviewStats(leads, runs)
  const funnelTop = leads.length || 0
  const funnelLastActive = stats.funnel.reduce((acc, s, i) => (s.count > 0 ? i : acc), -1)
  const funnelActive = funnelLastActive < 0 ? [] : stats.funnel.slice(0, funnelLastActive + 1)
  const funnelTail = funnelLastActive < 0 ? stats.funnel : stats.funnel.slice(funnelLastActive + 1)
  let funnelDrop = null
  for (let i = 2; i < stats.funnel.length; i++) {
    const d = stats.funnel[i - 1].count - stats.funnel[i].count
    if (d > 0 && (!funnelDrop || d > funnelDrop.n)) funnelDrop = { n: d, from: stats.funnel[i - 1].label, to: stats.funnel[i].label }
  }
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <>
      <div className="home-new">
      <div className="home-hero">
        <div><h1>{greeting}.</h1><p>{leads.length} clients · {stats.ready.length} ready to review · {stats.inPipeline.length} in pipeline</p></div>
      </div>
      <section className="home-stats" aria-label="Workspace overview">
        {stats.summary.map(({ label, value, detail, emoji, tone }) => (
          <article key={label} className="home-stat">
            <span className={`home-stat-icon stat-emoji home-tone-${tone}`} aria-hidden="true">{emoji}</span>
            <span className="home-stat-copy"><strong>{value}</strong><small>{label}</small><em>{detail}</em></span>
          </article>
        ))}
      </section>
      <div className="home-grid">
        <section className="panel home-panel" aria-label="Sales funnel">
          <div className="section-heading"><div><h2>Sales funnel</h2><span>Cumulative conversion from collection to won.</span></div></div>
          <div className="home-funnel">
            {funnelActive.map((stage) => {
              const pct = funnelTop ? Math.round((stage.count / funnelTop) * 100) : 0
              return <div className={cn('home-funnel-row', stage.count === 0 && 'is-zero')} key={stage.label}><span className="home-funnel-label">{stage.label}</span><span className="home-funnel-track"><i className={`home-bar-${stage.tone}`} style={{ width: stage.count > 0 ? `${Math.max(pct, 1)}%` : '0%' }} /></span><strong>{stage.count}</strong><span>{stage.count === 0 ? '—' : `${pct}%`}</span></div>
            })}
          </div>
          {funnelTail.length > 0 && funnelActive.length > 0 && <p className="home-funnel-tail">{funnelTail.map((stage) => stage.label).join(' · ')} — no clients yet</p>}
          {funnelDrop && <p className="home-funnel-drop">Biggest drop: {funnelDrop.from} → {funnelDrop.to} · <strong>{funnelDrop.n} waiting</strong>{funnelDrop.from === 'Researched' && <button className="button button-quiet button-small" onClick={() => goTo('Research')}>Review them</button>}</p>}
          {stats.funnel.slice(1).every((stage) => stage.count === 0) && <p className="home-funnel-early">Early days — stages fill as clients move through research and sales.</p>}
        </section>
        <section className="panel home-panel" aria-label="Quick actions">
          <div className="section-heading"><div><h2>Quick Actions</h2></div></div>
          <div className="home-qa">
            <button onClick={onNewRun}><span className="home-qa-icon home-qa-emoji qa-tint-peach" aria-hidden="true">🔍</span>Start research run</button>
            <button onClick={() => goTo('Clients')}><span className="home-qa-icon home-qa-emoji qa-tint-lavender" aria-hidden="true">✅</span>Review ready clients ({stats.ready.length})</button>
            <button onClick={() => goTo('Pipeline')}><span className="home-qa-icon home-qa-emoji qa-tint-blue" aria-hidden="true">📊</span>Open pipeline</button>
            <button onClick={() => goTo('Outreach')}><span className="home-qa-icon home-qa-emoji qa-tint-lavender" aria-hidden="true">✉️</span>Continue outreach</button>
            <button onClick={onImport}><span className="home-qa-icon home-qa-emoji qa-tint-green" aria-hidden="true">📥</span>Import from CSV</button>
          </div>
        </section>
      </div>
      <div className="home-grid">
        <section className="panel home-panel" aria-label="Latest research runs">
          <div className="section-heading"><div><h2>Latest runs</h2><span>Freshest collection activity.</span></div><div className="section-heading-side"><Badge tone="gray">{runs.length} total</Badge>{runs.length > stats.latestRuns.length && <button className="button button-quiet button-small" onClick={() => goTo('Research', { search: '?tab=runs' })}>View all {runs.length} runs</button>}</div></div>
          <div className="home-activity">
            {stats.latestRuns.length ? stats.latestRuns.map((run) => (
              <div className="home-activity-row" key={run.id}>
                <span className="home-qa-icon home-qa-emoji qa-tint-peach" aria-hidden="true">📈</span>
                <span><strong>{runLabel(run)}</strong><small>{runTimestamp(run)} · {run.source}</small></span>
                <Badge tone={statusTone[run.status] || 'gray'} dot>{run.status}</Badge>
              </div>
            )) : <div className="empty-state"><span className="e e20" aria-hidden="true">📈</span><h3>No runs yet</h3><p>Start a research run to collect clients.</p></div>}
          </div>
        </section>
        <section className="panel home-panel" aria-label="Top opportunities">
          <div className="section-heading"><div><h2>Top opportunities</h2><span>Highest-ranked right now.</span></div></div>
          <div className="home-activity">
            {stats.topLeads.map((lead) => (
              <button className="home-activity-row home-activity-button" key={lead.id} onClick={() => onOpen(lead)}>
                <Avatar name={lead.company} />
                <span><strong>{lead.company}</strong><small>{lead.category} · {lead.location}</small></span>
                <Score value={lead.opportunityScore} />
              </button>
            ))}
            {!stats.topLeads.length && <div className="empty-state"><span className="e e20" aria-hidden="true">🔍</span><h3>No clients here</h3><p>Import clients to get started.</p></div>}
          </div>
        </section>
      </div>
      </div>
    </>
  )
}

const CLIENT_PAGE_SIZES = [25, 50, 100]

const CLIENT_VIEWS = ['All', 'Starred', 'Needs research', 'Ready to review', 'Pipeline', 'Won', 'Lost']

function StarToggle({ lead, onToggle, size = 14 }) {
  if (!onToggle) return lead.starred ? <span className="star-glyph" aria-label="Starred">★</span> : null
  return <IconButton label={lead.starred ? `Unstar ${lead.company}` : `Star ${lead.company}`} aria-pressed={lead.starred} className={cn('star-toggle', lead.starred && 'is-starred')} onClick={(event) => { event.stopPropagation(); onToggle(lead) }}><Star size={size} fill={lead.starred ? 'currentColor' : 'none'} /></IconButton>
}

function ClientsPage({ leads, runs, onOpen, onImport, onExport, goTo, onNewRun, onToggleStar, initialFilter }) {
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState(TABLE_SORTS[0])
  const [view, setView] = useState(CLIENT_VIEWS.includes(initialFilter) ? initialFilter : 'All')
  // Deep links (e.g. Pipeline's "View lost clients") select the filter on arrival.
  useEffect(() => { if (CLIENT_VIEWS.includes(initialFilter)) setView(initialFilter) }, [initialFilter])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(CLIENT_PAGE_SIZES[0])
  const views = [
    { label: 'All', count: leads.length, tone: 'all' },
    { label: 'Starred', count: leads.filter((lead) => lead.starred).length, tone: 'orange' },
    { label: 'Needs research', count: leads.filter((lead) => !researchState(lead).analyzed || researchState(lead).failure).length, tone: 'orange' },
    { label: 'Ready to review', count: leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).length, tone: 'purple' },
    { label: 'Pipeline', count: leads.filter(isOpenPipelineLead).length, tone: 'blue' },
    { label: 'Won', count: leads.filter((lead) => lead.salesStage === 'Won').length, tone: 'green' },
    { label: 'Lost', count: leads.filter((lead) => lead.salesStage === 'Lost').length, tone: 'gray' },
  ]
  const dupeCounts = duplicateLeadCounts(leads)
  const filtered = leads.filter((lead) => {
    const match = `${lead.company} ${lead.category} ${lead.location} ${lead.collectedAt || ''} ${formatCollectedDate(lead)} ${collectedSearchText(lead)}`.toLowerCase().includes(query.toLowerCase())
    if (!match) return false
    if (view === 'Starred') return Boolean(lead.starred)
    if (view === 'Needs research') return !researchState(lead).analyzed || researchState(lead).failure
    if (view === 'Ready to review') return researchState(lead).museComplete && !isQualifiedLead(lead)
    if (view === 'Pipeline') return isOpenPipelineLead(lead)
    if (view === 'Won') return lead.salesStage === 'Won'
    if (view === 'Lost') return lead.salesStage === 'Lost'
    return true
  })
  const sorted = sortTableRows(filtered, sortMode, (a, b) => leadRankValue(b) - leadRankValue(a))
  // Search, filter, sort, and page-size changes return to page one; opening
  // and closing a record keeps this component mounted, so the page is preserved.
  useEffect(() => { setPage(1) }, [query, view, sortMode, pageSize, leads.length])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageItems = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
  const rangeStart = sorted.length ? (safePage - 1) * pageSize + 1 : 0
  const rangeEnd = Math.min(safePage * pageSize, sorted.length)
  return (
    <>
      <section className="panel client-list-panel" aria-label="Client list">
        <div className="client-list-tools">
          <div className="view-tabs" role="tablist" aria-label="Client views">{views.map((item) => <button role="tab" aria-selected={view === item.label} key={item.label} className={view === item.label ? 'active' : ''} onClick={() => setView(item.label)}><i className={`filter-dot filter-dot-${item.tone}`} /><span>{item.label}</span><em>{item.count}</em></button>)}</div>
          <div className="research-tools-right">
            <label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort clients">{TABLE_SORTS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <div className="table-search"><Search size={14} /><input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients…" />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div>
          </div>
        </div>
        <div className="client-table">
          <div className="client-table-head"><SortHeader column="client" sortMode={sortMode} onSort={setSortMode} /><span>Research</span><SortHeader column="score" sortMode={sortMode} onSort={setSortMode} /><SortHeader column="added" sortMode={sortMode} onSort={setSortMode} /><span>Sales phase</span><span>Next action</span><span /><span /></div>
          <div className="client-table-body">
            {pageItems.map((lead) => {
              const { failure, phase } = researchState(lead)
              const origin = leadRunInfo(lead, runs)
              const originLabel = origin.collectionRun ? `Added in ${runLabel(origin.collectionRun)}` : lead.labels?.includes('CSV import') ? 'Manual import' : 'Existing client'
              const dupeCount = dupeCounts.get(lead.id)
              return <div className="client-row" key={lead.id} role="button" tabIndex={0} onClick={() => onOpen(lead, { queue: sorted.map((item) => item.id) })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(lead, { queue: sorted.map((item) => item.id) }) } }} title={`${lead.company} — ${originLabel}${origin.collectionRun ? ` · ${runTimestamp(origin.collectionRun)}` : ''}`}><span className="client-name"><Avatar name={lead.company} /><span><strong>{lead.company}{dupeCount ? <span className="dup-flag" title="This business appears more than once — open the record to compare before acting">Possible duplicate</span> : null}</strong><small>{lead.category} · {lead.location}{lead.website ? '' : ' · No website'}</small></span></span><span className="phase-cell"><Badge tone={failure ? 'red' : phase === 2 ? 'purple' : phase === 1 ? 'blue' : 'gray'} dot>{getResearchLabel(lead)}</Badge></span><Score value={lead.opportunityScore} /><span className="added-cell" title={lead.collectedAt ? `Collected ${lead.collectedAt}` : 'Collection date not recorded'}>{formatCollectedDate(lead)}</span><span>{lead.salesStage ? <Badge tone={statusTone[lead.salesStage]} dot>{lead.salesStage}</Badge> : <span className="muted-dash">Not in sales</span>}</span><span className="next-action-cell">{getNextAction(lead)}</span><StarToggle lead={lead} onToggle={onToggleStar} /><ChevronRight size={13} /></div>
            })}
            {!sorted.length && (view === 'Starred' ? <div className="empty-state"><span className="e e20" aria-hidden="true">⭐</span><h3>No starred clients yet</h3><p>Star important clients to pin them here.</p></div> : <div className="empty-state"><span className="e e20" aria-hidden="true">🔍</span><h3>No clients here</h3><p>Try another view or search.</p></div>)}
          </div>
        </div>
        <div className="client-table-foot">
          <span aria-live="polite">{rangeStart}–{rangeEnd} of {sorted.length}</span>
          <label className="rows-per-page"><span>Rows per page:</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} aria-label="Rows per page">{CLIENT_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
          <div className="pager"><button className="button button-quiet button-small" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage <= 1}><ArrowLeft size={12} />Previous</button><button className="button button-quiet button-small" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={safePage >= totalPages}>Next<ArrowRight size={12} /></button></div>
        </div>
      </section>
    </>
  )
}

function RunStatus({ run, onTogglePause, onCancel }) {
  if (!run) return null
  const progress = run.status === 'Completed' ? 100 : Number(run.progress || 0)
  const paused = run.status === 'Paused'
  const phase = run.status === 'Running' && run.duration === 'Waiting for discovery' ? 'Waiting for Bright Data' : run.status === 'Running' && run.duration === 'Auditing discovered websites' ? 'Auditing discovered websites' : null
  const title = paused ? 'Research run paused' : phase || (run.status === 'Running' ? 'Research run in progress' : run.status === 'Cancelled' ? 'Research run cancelled' : run.status === 'Failed' ? 'Research run failed' : 'Latest run completed')
  return (
    <section className="panel simple-run">
      <div><span className="panel-kicker"><span className="e e12" aria-hidden="true">📈</span>Collection activity</span><div className="run-status-identifiers"><strong>{runLabel(run)}</strong><small>{runTimestamp(run)} · {run.source}</small></div><h2>{title}</h2><p>{run.categories.join(', ')} · {run.location}</p></div>
      <div className="simple-run-progress"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div>
      {['Running', 'Paused'].includes(run.status) && <div className="simple-run-actions"><button className="button button-secondary button-small" onClick={onTogglePause}>{paused ? <span className="e" aria-hidden="true">▶️</span> : <span className="e" aria-hidden="true">⏸️</span>}{paused ? 'Resume' : 'Pause'}</button><button className="button button-quiet button-small" onClick={onCancel}><X size={12} />Cancel</button></div>}
      {!['Running', 'Paused'].includes(run.status) && <Badge tone={statusTone[run.status]} dot>{run.status}</Badge>}
    </section>
  )
}

function RunHistory({ runs, leads, onOpen }) {
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState('Newest first')
  if (!runs.length) return null
  const runTime = (run) => new Date(run.startedAt || run.createdAt).getTime() || 0
  const visible = runs.filter((run) => `${runLabel(run)} ${(run.categories || []).join(' ')} ${run.location || ''} ${run.status || ''} ${run.source || ''}`.toLowerCase().includes(query.toLowerCase()))
  const ordered = [...visible].sort((a, b) => order === 'Oldest first' ? runTime(a) - runTime(b) : runTime(b) - runTime(a))
  const latestId = [...runs].sort((a, b) => runTime(b) - runTime(a))[0]?.id
  return <section className="panel run-history-panel">
    <div className="section-heading"><div><h2>Research runs</h2><span>Every collection stays traceable, including the clients it touched.</span></div><Badge tone="gray">{runs.length} total</Badge></div>
    {runs.length > 1 && <div className="run-history-tools">
      <label className="sort-control"><span>Sort</span><select value={order} onChange={(event) => setOrder(event.target.value)} aria-label="Sort runs">{['Newest first', 'Oldest first'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="table-search"><Search size={14} /><input aria-label="Search runs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs…" />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div>
    </div>}
    <div className="run-history-list">
      {!ordered.length && <div className="empty-state"><span className="e e20" aria-hidden="true">🔍</span><h3>No matching runs</h3><p>Try another search.</p></div>}
      {ordered.map((run) => {
        const linked = leads.filter((lead) => run.clientIds?.includes(lead.id) || lead.runHistory?.some((item) => item.runId === run.id))
        const progress = run.status === 'Completed' ? 100 : Number(run.progress || 0)
        const newCount = run.newClients ?? run.newClientIds?.length ?? 0
        const matchedCount = run.matchedClients ?? run.matchedClientIds?.length ?? 0
        const active = ['Running', 'Paused'].includes(run.status)
        return <article className="run-history-row" key={run.id}>
          <div className="run-history-main"><div className="run-history-title"><strong>{runLabel(run)}</strong><Badge tone={statusTone[run.status] || 'gray'} dot>{run.status}</Badge>{run.id === latestId && <Badge tone="orange">Latest</Badge>}</div><p>{run.categories.join(', ')} · {run.location}</p><small>{runTimestamp(run)} · {run.source}</small></div>
          {active ? <div className="run-history-progress"><div><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div><small>{run.duration || 'Run in progress'}</small></div> : <small className="run-history-duration">{run.duration || run.status}</small>}
          <p className="run-history-counts">{newCount} new · {matchedCount} matched · {run.audited ?? 0} audited</p>
          <div className="run-history-clients">{linked.length ? <div>{linked.slice(0, 5).map((lead) => <button key={lead.id} type="button" onClick={() => onOpen(lead)} title={lead.company}><Avatar name={lead.company} size="small" /><span>{lead.company}</span></button>)}{linked.length > 5 && <em>+{linked.length - 5} more</em>}</div> : <small>No clients linked yet</small>}</div>
        </article>
      })}
    </div>
  </section>
}

function ResearchPage({ leads, runs, activeRunId, onOpen, onReview, onExport, onUpdate, onAnalyze, onCancelJob, onRetryJob, onNewRun, onTogglePause, onCancel, onOutreach }) {
  const initialParams = new URLSearchParams(window.location.search)
  const [tab, setTab] = useState(initialParams.get('tab') === 'runs' ? 'Runs' : 'Prospects')
  const [filter, setFilter] = useState(initialParams.get('filter') || 'Ready to review')
  const [sortMode, setSortMode] = useState('Recommended')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(CLIENT_PAGE_SIZES[0])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('tab', tab.toLowerCase())
    if (tab === 'Prospects') params.set('filter', filter)
    else params.delete('filter')
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`)
  }, [tab, filter])
  const allSorted = [...leads].sort((a, b) => getNextAction(a).localeCompare(getNextAction(b)) || leadRankValue(b) - leadRankValue(a))
  const dupeCounts = duplicateLeadCounts(leads)
  const inSalesCount = leads.filter(isQualifiedLead).length
  const metricDefs = [['Needs analysis', leads.filter((lead) => !researchState(lead).analyzed && !researchState(lead).processing).length, '🗄️', 'Collected without a completed audit'], ['In progress', leads.filter((lead) => researchState(lead).processing).length, '📈', 'A run or client job is active'], ['Ready to review', leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).length, '✅', 'Guidance is ready for your decision'], ['Failed', leads.filter((lead) => researchState(lead).failure).length, '⚠️', 'Retry a blocked research stage'], ['In sales', inSalesCount, '💼', 'Qualified and working deals'], ['All', leads.length, '🌐', 'Every collected client']]
  const researchTones = { 'Needs analysis': '', 'In progress': 'orange', 'Ready to review': 'green', Failed: 'red', 'In sales': 'blue', All: 'all' }
  const researchViews = metricDefs.map(([label, count, , description]) => ({ label, count, tone: researchTones[label] || '', description }))
  const filtered = allSorted.filter((lead) => {
    // Provider-confirmed closed businesses leave the default queue with a
    // visible reason; 'All' still shows them.
    const match = `${lead.company} ${lead.category} ${lead.location} ${lead.mainIssue || ''} ${lead.collectedAt || ''} ${formatCollectedDate(lead)} ${collectedSearchText(lead)}`.toLowerCase().includes(query.toLowerCase())
    if (!match) return false
    if (lead.leadValue?.excluded && filter !== 'All') return false
    const state = researchState(lead)
    if (filter === 'Needs analysis') return !state.analyzed && !state.processing
    if (filter === 'In progress') return state.processing
    if (filter === 'Ready to review') return state.museComplete && !isQualifiedLead(lead)
    if (filter === 'Failed') return Boolean(state.failure)
    if (filter === 'In sales') return isQualifiedLead(lead)
    return true
  })
  // Recommended keeps the queue order above (next action, then commercial
  // rank); every table also sorts by name, score, and date.
  const sorted = sortTableRows(filtered, sortMode)
  // Search, filter, and sort changes return to page one.
  useEffect(() => { setPage(1) }, [query, filter, sortMode, leads.length])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageItems = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
  const rangeStart = sorted.length ? (safePage - 1) * pageSize + 1 : 0
  const rangeEnd = Math.min(safePage * pageSize, sorted.length)
  const activeRun = runs.find((run) => run.id === activeRunId) || runs[0]
  return (
    <>
      <div className="view-tabs research-view-switch" role="tablist" aria-label="Research views"><button role="tab" aria-selected={tab === 'Prospects'} className={tab === 'Prospects' ? 'active' : ''} onClick={() => setTab('Prospects')}><span>Prospects</span></button><button role="tab" aria-selected={tab === 'Runs'} className={tab === 'Runs' ? 'active' : ''} onClick={() => setTab('Runs')}><span>Runs</span><em>{runs.length}</em></button></div>
      {tab === 'Prospects' && <>
      <section className="panel client-list-panel" aria-label="Research queue">
        <div className="client-list-tools research-tools">
          <div className="view-tabs tabs-dense" role="tablist" aria-label="Research filters">{researchViews.map((item) => <button role="tab" aria-selected={filter === item.label} key={item.label} className={filter === item.label ? 'active' : ''} onClick={() => setFilter(item.label)} title={item.description}><i className={`filter-dot${item.tone ? ` filter-dot-${item.tone}` : ''}`} /><span>{item.label}</span><em>{item.count}</em></button>)}</div>
          <div className="research-tools-right">
            <label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort prospects">{TABLE_SORTS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <div className="table-search"><Search size={14} /><input aria-label="Search prospects" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prospects…" />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div>
          </div>
        </div>
        <div className="client-table">
          <div className="client-table-head research-table-head"><SortHeader column="client" sortMode={sortMode} onSort={setSortMode} /><span>Status</span><span>Guidance</span><SortHeader column="score" sortMode={sortMode} onSort={setSortMode} /><SortHeader column="added" sortMode={sortMode} onSort={setSortMode} /><span>Action</span></div>
          <div className="client-table-body">
          {pageItems.map((lead) => {
            const { done, failure, phase } = researchState(lead)
            const auditReady = lead.performance != null || (lead.problems || []).length > 0
            const jobActive = ['Queued', 'Running', 'Waiting'].includes(lead.researchJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status) || ['Queued', 'Analyzing'].includes(lead.researchStatus)
            const rowRunning = activeLeadJob(lead)
            const rowFailed = failedLeadJob(lead)
            const rowResumable = !rowRunning && rowFailed && leadJobRetryable(lead, rowFailed) ? rowFailed : null
            const needsReview = done[1] && !failure && !isQualifiedLead(lead)
            const rowState = researchState(lead)
            const statusChip = failure ? ['Audit failed', 'red'] : jobActive ? ['Research running', 'orange'] : rowState.museComplete ? (isQualifiedLead(lead) ? ['In sales', 'purple'] : ['Ready to review', 'green']) : rowState.analyzed ? ['Audited', 'blue'] : ['Collected', 'gray']
            const dupeCount = dupeCounts.get(lead.id)
            return <article className={cn('research-row', 'research-table-row', failure && 'has-failure')} key={lead.id}><button className="research-client" onClick={() => onOpen(lead, { queue: sorted.map((item) => item.id) })} aria-label={`Open ${lead.company} record`}><Avatar name={lead.company} /><span><strong>{lead.company}{dupeCount ? <span className="dup-flag" title="This business appears more than once — open the record to compare before acting">Possible duplicate</span> : null}</strong><small>{lead.category} · {failure?.reason || lead.mainIssue}</small></span></button><span className="row-status"><Badge tone={statusChip[1]} dot>{statusChip[0]}</Badge></span><span className={cn('research-result', failure && 'is-failed')}><small title={failure || jobActive ? undefined : 'AI guidance is advisory only — it never changes the score'}>{failure ? 'Research state' : jobActive ? 'Research state' : 'AI guidance'}</small><strong>{failure ? `${researchLabels[phase]} failed` : jobActive ? 'In progress' : getMuseGuidance(lead) || getResearchLabel(lead)}</strong>{lead.leadValue?.excluded ? <em>{lead.leadValue.excluded.reason}</em> : done[1] && !failure ? (lead.confidence != null ? <em>{lead.confidence}% confidence</em> : null) : lead.leadValue ? <em>Value {lead.leadValue.leadValueScore}/100 · {lead.leadValue.band}</em> : null}</span><Score value={lead.opportunityScore} /><span className="added-cell" title={lead.collectedAt ? `Collected ${lead.collectedAt}` : 'Collection date not recorded'}>{formatCollectedDate(lead)}</span><div className="research-action">{jobActive ? <><Badge tone={statusTone[lead.researchJob?.status] || 'orange'} dot>{lead.researchJob?.phase || lead.researchJob?.status || lead.researchStatus}</Badge>{rowRunning ? <button className="button button-quiet button-small" title="Cancel this job" onClick={() => onCancelJob(lead, rowRunning.id)}><span className="e" aria-hidden="true">🚫</span></button> : null}</> : failure ? (rowResumable ? <button className="button button-secondary button-small retry-button" onClick={() => onRetryJob(lead, rowResumable.id)}><span className="e" aria-hidden="true">🔄</span>Resume job</button> : <button className="button button-secondary button-small retry-button" onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">🔄</span>Retry audit</button>) : !done[1] ? (lead.website ? <button className="button button-primary button-small" onClick={() => onAnalyze(lead)}>{auditReady ? <span className="e" aria-hidden="true">🔄</span> : <span className="e" aria-hidden="true">▶️</span>}Analyze website</button> : <span className="muted-dash" title="No website supplied — score and qualify on business evidence; add a website to enable the audit">No website</span>) : needsReview ? <button className="button button-primary button-small" onClick={() => onReview(lead)}><span className="e" aria-hidden="true">📄</span>Review findings</button> : <button className="button button-primary button-small" onClick={() => onOutreach(lead)}><span className="e" aria-hidden="true">✉️</span>Open outreach</button>}</div></article>
          })}
          {!sorted.length && <div className="empty-state"><span className="e e20" aria-hidden="true">✅</span><h3>Nothing needs attention here</h3><p>Try another research filter or start a new run.</p></div>}
          </div>
        </div>
        <div className="client-table-foot">
          <span aria-live="polite">{rangeStart}–{rangeEnd} of {sorted.length}</span>
          <label className="rows-per-page"><span>Rows per page:</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} aria-label="Rows per page">{CLIENT_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
          <div className="pager"><button className="button button-quiet button-small" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage <= 1}><ArrowLeft size={12} />Previous</button><button className="button button-quiet button-small" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={safePage >= totalPages}>Next<ArrowRight size={12} /></button></div>
        </div>
      </section>
      </>}
      {tab === 'Runs' && <div className="research-runs-scroll">
      {['Running', 'Paused'].includes(activeRun?.status) && <RunStatus run={activeRun} onTogglePause={onTogglePause} onCancel={onCancel} />}
      <RunHistory runs={runs} leads={leads} onOpen={onOpen} />
      </div>}
    </>
  )
}

// Review queue order: ready decisions first, commercial rank first.
function reviewQueue(leads = []) {
  return [...leads].filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).sort((a, b) => leadRankValue(b) - leadRankValue(a))
}

// Dedicated research review workspace. The client record itself is a full-page
// workspace; this page assembles the review queue decision in one place:
// identity, recommendation with uncertainty, findings paired with evidence,
// secondary detail, and persistent decision actions.
function ReviewWorkspace({ lead, leads, runs, onBack, onSelect, onOpenRecord, onUpdate, onQualify, onAnalyze, onRetryJob, onCancelJob, onExport, onOutreach }) {
  if (!lead) return null
  const queue = reviewQueue(leads)
  const index = queue.findIndex((item) => item.id === lead.id)
  const inQueue = index >= 0
  const prev = queue.length ? queue[inQueue ? (index - 1 + queue.length) % queue.length : queue.length - 1] : null
  const next = queue.length ? queue[inQueue ? (index + 1) % queue.length : 0] : null
  const research = researchState(lead)
  const { failure } = research
  const guidance = getMuseGuidance(lead)
  const needsReview = research.done[1] && !failure && !isQualifiedLead(lead)
  const runningJob = activeLeadJob(lead)
  const failedJob = failedLeadJob(lead)
  const resumableJob = failedJob && leadJobRetryable(lead, failedJob) ? failedJob : null
  const freshness = lead.lastSuccessfulAudit?.at ? `Audited ${auditAge(lead.lastSuccessfulAudit.at)}` : research.analyzed ? 'Audited · date unknown' : 'Not audited yet'
  const history = Array.isArray(lead.runHistory) ? [...lead.runHistory].sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime()).slice(0, 5) : []
  const findings = lead.problems?.length ? lead.problems : []
  return (
    <>
      <div className="review-head">
        <div className="review-nav">
          <button className="button button-quiet button-small" onClick={onBack}><ArrowLeft size={12} />Back to queue</button>
          <span className="review-position" aria-live="polite">{inQueue ? `${index + 1} of ${queue.length} to review` : 'Outside the review queue'}</span>
          <div className="review-prev-next">
            <button className="button button-quiet button-small" onClick={() => prev && onSelect(prev.id)} disabled={!prev}><ArrowLeft size={12} />Previous</button>
            <button className="button button-quiet button-small" onClick={() => next && onSelect(next.id)} disabled={!next}>Next<ArrowRight size={12} /></button>
          </div>
        </div>
        <div className="review-identity">
          <Avatar name={lead.company} />
          <div>
            <h1>{lead.company}</h1>
            <p>{lead.category} · {lead.location} · {websiteUrl(lead.website) ? <a href={websiteUrl(lead.website)} target="_blank" rel="noreferrer">Open website <span className="e e10" aria-hidden="true">↗️</span></a> : 'No website'} · {freshness}</p>
          </div>
          <div className="review-identity-badges"><Badge tone={failure ? 'red' : research.museComplete ? 'green' : 'blue'} dot>{getResearchLabel(lead)}</Badge>{lead.salesStage ? <Badge tone={statusTone[lead.salesStage]} dot>{lead.salesStage}</Badge> : null}</div>
        </div>
      </div>
      {failure && <div className="candidate-banner review-failure" role="alert"><span><strong>Collection issue, not a verdict — {researchStages[failure.stage]?.label || 'Research'} failed.</strong><small> {failure.reason} The recommendation below rests on saved evidence where available; fix the failure before treating it as final.</small></span><div>{runningJob ? <button className="button button-secondary button-small" onClick={() => onCancelJob(lead, runningJob.id)}><span className="e" aria-hidden="true">🚫</span>Cancel job</button> : null}{!runningJob && resumableJob ? <button className="button button-secondary button-small" onClick={() => onRetryJob(lead, resumableJob.id)}><span className="e" aria-hidden="true">🔄</span>Resume job</button> : null}<button className="button button-secondary button-small retry-button" onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">🔄</span>Retry audit</button></div></div>}
      <div className="review-grid">
        <section className="panel review-main" aria-label="Decision summary">
          <div className="section-heading"><div><h2>Decision summary</h2><span>Recommendation, reason, and uncertainty.</span></div><Score value={lead.opportunityScore} size="large" /></div>
          <div className="review-decision-line"><span className="detail-label">Recommendation</span><strong className={cn('review-guidance', guidance === 'Pursue' && 'is-pursue', guidance === 'Pass' && 'is-pass')}>{guidance || 'Not run'}</strong></div>
          <p className="lead-summary">{lead.museAnalysis?.qualificationRationale || lead.museAnalysis?.summary || lead.issueDetail || 'No recommendation recorded yet.'}</p>
          <p className="review-uncertainty">Opportunity {lead.opportunityScore ?? '—'}/100 · {lead.confidence != null ? `${lead.confidence}% confidence` : 'confidence not recorded'}{lead.leadValue ? ` · Value ${lead.leadValue.leadValueScore}/100 (${lead.leadValue.band})` : ''}</p>
          {research.done[1] && <MuseSynthesis lead={lead} onAnalyze={onAnalyze} onUpdate={onUpdate} />}
        </section>
        <aside className="panel review-side" aria-label="Decision actions">
          <span className="detail-label">Next action</span>
          <strong>{getNextAction(lead)}</strong>
          {needsReview ? <button className="button button-primary" onClick={() => onQualify(lead)}><span className="e" aria-hidden="true">✅</span>Qualify for outreach</button>
            : isQualifiedLead(lead) ? <button className="button button-primary" onClick={onOutreach}><span className="e" aria-hidden="true">✉️</span>Open outreach</button>
              : runningJob ? <button className="button button-secondary" onClick={() => onCancelJob(lead, runningJob.id)}><span className="e" aria-hidden="true">🚫</span>Cancel job</button>
                : lead.website ? <button className="button button-primary" onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">✨</span>Analyze website</button> : null}
          <button className="button button-secondary" onClick={() => onOpenRecord(lead)}><span className="e" aria-hidden="true">🏢</span>Open full record</button>
          <button className="button button-quiet" onClick={() => onExport(lead)}><span className="e" aria-hidden="true">📤</span>Export research packet</button>
          {needsReview ? <small>Qualifying moves this client to outreach. Staying here keeps it queued — that is the defer path.</small> : null}
        </aside>
      </div>
      <section className="panel review-evidence" aria-label="Findings and evidence">
        <div className="section-heading"><div><h2>Findings and evidence</h2><span>Each observation with why it matters and what to change.</span></div><Badge tone="gray">{findings.length} findings</Badge></div>
        {findings.length ? <ol className="review-finding-list">{findings.map((problem, position) => {
          const advice = findingAdvice(problem)
          return <li key={`${position}-${problem}`}><span className="review-finding-num">{position + 1}</span><div><strong>{problem}</strong><p><b>Why it matters:</b> {advice.why}</p><p><b>Suggested direction:</b> {advice.change}</p></div></li>
        })}</ol> : <p className="lead-summary">Website analysis has not been completed yet — the decision summary above is the current state.</p>}
        {(lead.evidence || []).length > 0 && <details className="ws-record-details ws-evidence"><summary>Saved evidence ({lead.evidence.length})<ChevronDown size={12} /></summary><ul className="review-evidence-list">{lead.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      </section>
      <div className="review-grid review-secondary">
        <section className="panel review-card" aria-label="Contact profile">
          <span className="detail-label">Contact profile</span>
          <div className="review-facts"><div><span>Phone</span><strong>{lead.phone || 'Not collected'}</strong></div><div><span>Email</span><strong>{lead.email || 'Not collected'}</strong></div><div><span>Address</span><strong>{lead.address || lead.location || 'Not collected'}</strong></div><div><span>Rating</span><strong>{lead.rating ? `${lead.rating} ★ · ${lead.reviews || 0} reviews` : 'Unknown'}</strong></div></div>
        </section>
        <section className="panel review-card" aria-label="Collection history">
          <span className="detail-label">Collection history</span>
          {history.length ? <ol className="review-history-list">{history.map((item, position) => {
            const run = runs.find((entry) => entry.id === item.runId)
            return <li key={`${item.runId}-${item.at || position}`}><strong>{run ? runLabel(run) : 'Manual record'}</strong><small>{item.relationship === 'new' ? 'New client' : 'Matched client'}{item.at ? ` · ${new Date(item.at).toLocaleDateString()}` : ''}</small></li>
          })}</ol> : <p className="lead-summary">No research run recorded.</p>}
        </section>
        <section className="panel review-card" aria-label="Technical diagnostics">
          <span className="detail-label">Technical diagnostics</span>
          <div className="review-facts"><div><span>Performance</span><strong>{lead.performance ?? '—'}{lead.performance != null ? '/100' : ''}</strong></div><div><span>Pages crawled</span><strong>{lead.pageCount ?? '—'}</strong></div><div><span>Broken links</span><strong>{lead.brokenLinks ?? '—'}</strong></div><div><span>Audit</span><strong>{lead.lastSuccessfulAudit ? `${lead.lastSuccessfulAudit.score}/100 ${auditAge(lead.lastSuccessfulAudit.at)}` : 'None yet'}</strong></div></div>
        </section>
        <section className="panel review-card" aria-label="Notes">
          <span className="detail-label">Notes</span>
          <p className="lead-summary">{lead.notes || 'No notes yet.'}</p>
          <button className="button button-quiet button-small" onClick={() => onOpenRecord(lead)}>Edit in full record <ArrowRight size={11} /></button>
        </section>
      </div>
      <div className="review-foot">
        <span className="review-position">{inQueue ? `${index + 1} of ${queue.length} to review` : lead.company}</span>
        <div>
          <button className="button button-quiet" onClick={onBack}>Back to queue</button>
          <button className="button button-secondary" onClick={() => onOpenRecord(lead)}>Open full record</button>
          {needsReview ? <button className="button button-primary" onClick={() => onQualify(lead)}><span className="e" aria-hidden="true">✅</span>Qualify for outreach</button> : null}
        </div>
      </div>
    </>
  )
}

function StagePicker({ lead, onChange }) {
  const [open, setOpen] = useState(false)
  const [flipUp, setFlipUp] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  // Near the viewport bottom the menu opens upward so every stage, including
  // Won, stays reachable; the menu also scrolls internally when cramped.
  useEffect(() => {
    if (!open) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    setFlipUp(rect.bottom + 8 + 260 > window.innerHeight && rect.top > 280)
  }, [open])
  // Escape closes the menu and restores focus to its trigger, regardless of
  // where focus sits. Capture phase runs before the app-level handler, so
  // the drawer underneath stays open.
  useEffect(() => {
    if (!open) return
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open ])
  return <div ref={rootRef} className="stage-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}><button ref={triggerRef} className="stage-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}><i className={`stage-dot stage-dot-${statusTone[lead.salesStage] || 'gray'}`} /><span>{lead.salesStage}</span><ChevronDown size={10} /></button>{open && <div className={cn('stage-picker-menu', flipUp && 'menu-up')} role="listbox" aria-label={`Move ${lead.company}`}>
    <small>Move to</small>
    {pipelineStages.map((stage) => <button type="button" role="option" aria-selected={lead.salesStage === stage} key={stage} onMouseDown={(event) => event.stopPropagation()} onClick={() => { onChange(stage); setOpen(false) }}><i className={`stage-dot stage-dot-${statusTone[stage] || 'gray'}`} /><span>{stage}</span>{lead.salesStage === stage && <Check size={11} />}</button>)}
  </div>}</div>
}

function OutreachCard({ lead, readiness = null, queueItem = null, commercialLabel = '', onOpen, onReview, onUpdate, onAttempt, onGenerate, onCandidate, onToast }) {
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [attemptOpen, setAttemptOpen] = useState(false)
  const [attemptChannel, setAttemptChannel] = useState('email')
  const [attemptContact, setAttemptContact] = useState('')
  const [attemptOutcome, setAttemptOutcome] = useState('')
  const [attemptNotes, setAttemptNotes] = useState('')
  const [attemptBusy, setAttemptBusy] = useState(false)
  const [version, setVersion] = useState(() => outreachVersion(lead))
  const [subject, setSubject] = useState(() => outreachSubject(lead))
  const [body, setBody] = useState(() => outreachBody(lead, outreachVersion(lead)))
  useEffect(() => { const nextVersion = outreachVersion(lead); setVersion(nextVersion); setSubject(outreachSubject(lead)); setBody(outreachBody(lead, nextVersion)) }, [lead.id, lead.outreachSubject, lead.outreachDraft, lead.outreachVersion, lead.outreachDrafts])
  const contacted = isContacted(lead)
  const hasEmail = true
  const displayEmail = Boolean(lead.email && !String(lead.email).toLowerCase().startsWith('not collected'))
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0
  const findings = (lead.problems?.length ? lead.problems : [lead.issueDetail]).filter(Boolean).slice(0, 3)
  const copy = async () => {
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); onToast(`${lead.company} email copied`) }
    catch { onToast({ message: 'Could not copy the email', tone: 'error' }) }
  }
  const selectVersion = (nextVersion) => { setVersion(nextVersion); setBody(outreachBody(lead, nextVersion)); setEditing(false) }
  const savedDrafts = () => ({ ...(lead.outreachDrafts || {}), [version]: body.trim() })
  const save = async () => { const updated = await onUpdate(lead.id, { outreachSubject: subject.trim(), outreachVersion: version, outreachDraft: body.trim(), outreachDrafts: savedDrafts() }); if (!updated) return; setEditing(false); onToast(`${version} email saved`) }
  // Contacted reflects a recorded attempt — copying a draft never records one.
  const openAttemptForm = () => {
    setAttemptChannel(displayEmail ? 'email' : lead.phone && !String(lead.phone).startsWith('Not collected') ? 'phone' : 'other')
    setAttemptContact(displayEmail ? lead.email : '')
    setAttemptOutcome('')
    setAttemptNotes('')
    setAttemptOpen(true)
  }
  const recordAttempt = async () => {
    if (!attemptOutcome || attemptBusy) return
    setAttemptBusy(true)
    const updated = await onAttempt(lead.id, { channel: attemptChannel, contact: attemptContact.trim(), outcome: attemptOutcome, notes: attemptNotes.trim() })
    setAttemptBusy(false)
    if (!updated) return
    setAttemptOpen(false)
    setEditing(false)
  }
  const generate = async () => {
    setGenerating(true)
    await onGenerate(lead)
    setGenerating(false)
  }
  const showCandidate = lead.outreachUpdateAvailable && (lead.outreachCandidates || []).some((item) => item && !item.insufficientEvidence && item.drafts)
  const resolveCandidate = async (action) => {
    setResolving(true)
    await onCandidate(lead, action, 0)
    setResolving(false)
  }
  const insufficient = lead.outreachStatus === 'Insufficient evidence' && !body.trim()
  return (
    <article className={cn('outreach-card', contacted && 'is-contacted')}>
      <header className="outreach-client-head"><button onClick={() => onOpen(lead)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{displayEmail ? lead.email : 'No email found · website form is still available'}</small></span></button><Badge tone={contacted ? statusTone[lead.salesStage] || 'blue' : readiness?.ready ? 'green' : 'orange'} dot>{contacted ? lead.salesStage : readiness?.ready ? 'Ready to contact' : 'Draft prepared'}</Badge></header>
      {queueItem && queueItem.kind !== 'ready' && <div className="candidate-banner"><span><strong>{queueItem.kind === 'followup-overdue' ? 'Follow-up overdue.' : 'Follow-up due today.'}</strong><small> {queueItem.reason}</small></span></div>}
      {readiness && !readiness.ready && !contacted && <div className="candidate-banner"><span><strong>Not ready yet.</strong><small> {readiness.blocks.map((block) => block.message).join(' ')}</small></span><div><button className="button button-secondary button-small" onClick={() => onOpen(lead)}>Open record</button></div></div>}
      {readiness?.ready && <div className="readiness-strip"><small>{readiness.accepted?.[0]?.finding?.detail || 'Reviewed opportunity'} · via {readiness.primaryChannel ? `${readiness.primaryChannel.kind}: ${readiness.primaryChannel.value}` : 'channel'} · evidence {readiness.evidenceAgeDays == null ? 'age unknown' : readiness.evidenceAgeDays === 0 ? 'fresh today' : `${readiness.evidenceAgeDays}d old`} · commercial {commercialLabel || readiness.commercial.status}{readiness.commercial.score != null ? ` ${readiness.commercial.score}/100` : ''}</small></div>}
      {lead.outreachChannels && (lead.outreachChannels.phone || lead.outreachChannels.form) && <div className="channel-drafts"><span className="detail-label">Channel actions</span>{!displayEmail && lead.outreachChannels.phone && <div className="channel-draft"><small>Phone · call script</small><p>{lead.outreachChannels.phone}</p></div>}{lead.outreachChannels.form && <div className="channel-draft"><small>Contact form · open manually, never auto-submit</small><p>{lead.outreachChannels.form}</p></div>}</div>}
      {getOutreachState(lead) === 'Needs draft' && !contacted && <div className="candidate-banner"><span><strong>No draft yet.</strong><small> Generate three versions from the saved evidence, or write one with Edit — then record the attempt once it is sent.</small></span><div><button className="button button-secondary button-small" onClick={generate} disabled={generating}>{generating ? 'Generating…' : 'Generate now'}</button></div></div>}
      <div className="outreach-card-grid">
        <section className="outreach-evidence"><span className="detail-label">Why this is relevant</span><ol>{findings.map((problem) => <li key={problem}>{problem}</li>)}</ol><button onClick={() => (onReview || onOpen)(lead)}>View full research <ArrowRight size={10} /></button></section>
        <section className="email-draft"><div className="email-draft-meta"><span className="detail-label">Email draft</span><div className="email-version-tabs" role="tablist" aria-label={`Email length for ${lead.company}`}>{outreachVersions.map((item) => <button key={item} role="tab" aria-selected={version === item} className={version === item ? 'active' : ''} onClick={() => selectVersion(item)} disabled={editing || generating}>{item}</button>)}</div><small>{wordCount} words · {lead.outreachGeneration?.model || 'evidence template'}</small></div>{lead.outreachStale && <div className="candidate-banner"><span><strong>Drafts predate the latest audit.</strong><small> {lead.outreachStaleReason || 'A newer audit completed after these drafts.'}</small></span><div><button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { outreachStale: false })}>Mark reviewed</button></div></div>}{showCandidate && <div className="candidate-banner"><span><strong>New generated draft available.</strong><small> Your current text was kept. Review the latest candidate before switching.</small></span><div><button className="button button-secondary button-small" onClick={() => resolveCandidate('accept')} disabled={resolving}>{resolving ? 'Applying…' : 'Use new draft'}</button><button className="button button-quiet button-small" onClick={() => resolveCandidate('dismiss')} disabled={resolving}>Keep current</button></div></div>}{insufficient && <div className="candidate-banner"><span><strong>No supported outreach.</strong><small> {lead.outreachCandidates?.[0]?.reason || 'The saved audit has no verified findings to write from.'}</small></span></div>}{editing ? <><label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label><span>Message</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label></> : <div className="email-preview"><small>Subject · {subject}</small><p>{body}</p></div>}<div className="outreach-actions">{editing ? <><button className="button button-quiet button-small" onClick={() => { setSubject(outreachSubject(lead)); setBody(outreachBody(lead, version)); setEditing(false) }}>Cancel</button><button className="button button-secondary button-small" onClick={save}><span className="e" aria-hidden="true">✅</span>Save {version.toLowerCase()}</button></> : <><button className="button button-quiet button-small" onClick={generate} disabled={generating}>{generating ? <LoaderCircle size={12} className="spin" /> : <span className="e" aria-hidden="true">🪄</span>}{generating ? 'Generating…' : 'Generate 3 versions'}</button><button className="button button-secondary button-small" onClick={() => setEditing(true)}><span className="e" aria-hidden="true">📄</span>Edit</button></>}<button className="button button-secondary button-small" onClick={copy} disabled={!hasEmail || generating}><span className="e" aria-hidden="true">📋</span>Copy {version.toLowerCase()}</button>{!contacted && !attemptOpen && <button className="button button-primary button-small" onClick={openAttemptForm} disabled={generating}><span className="e" aria-hidden="true">✅</span>Record attempt</button>}</div>{attemptOpen && !contacted && <div className="attempt-form"><label><span>Channel</span><select value={attemptChannel} onChange={(event) => setAttemptChannel(event.target.value)}>{['email', 'phone', 'maps', 'in-person', 'other'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Contact used</span><input value={attemptContact} onChange={(event) => setAttemptContact(event.target.value)} placeholder="Who or where you reached out to" /></label><label><span>Outcome</span><select value={attemptOutcome} onChange={(event) => setAttemptOutcome(event.target.value)}><option value="">Select outcome…</option>{ATTEMPT_OUTCOMES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Notes</span><input value={attemptNotes} onChange={(event) => setAttemptNotes(event.target.value)} placeholder="Optional" /></label><div><button className="button button-quiet button-small" onClick={() => setAttemptOpen(false)}>Cancel</button><button className="button button-primary button-small" onClick={recordAttempt} disabled={!attemptOutcome || attemptBusy}>{attemptBusy ? 'Saving…' : 'Save attempt'}</button></div><small>Only reached outcomes (conversation, reply, meeting) mark the client contacted.</small></div>}</section>
      </div>
    </article>
  )
}

function OutreachPage({ leads, onOpen, onReview, onUpdate, onAttempt, onGenerate, onCandidate, onToast, goTo }) {
  const [view, setView] = useState('Ready to contact')
  const [selectedId, setSelectedId] = useState(null)
  const dupCounts = useMemo(() => duplicateLeadCounts(leads), [leads])
  // Single shared readiness source (server/services/readiness.js): the same
  // rules the API enforces. Suppressed, Won and Lost never queue.
  const readinessById = useMemo(() => {
    const map = new Map()
    for (const lead of leads) map.set(lead.id, computeReadiness(lead, { duplicateCount: dupCounts.get(lead.id) || 0 }))
    return map
  }, [leads, dupCounts])
  const readinessOf = (lead) => readinessById.get(lead.id) || computeReadiness(lead, { duplicateCount: dupCounts.get(lead.id) || 0 })
  const eligible = leads.filter((lead) => isQualifiedLead(lead) && !['Won', 'Lost'].includes(lead.salesStage) && !lead.doNotContact?.status)
  const contacted = eligible.filter(isContacted)
  const ready = eligible.filter((lead) => !isContacted(lead) && readinessOf(lead).ready)
  const byPrep = (prep) => eligible.filter((lead) => !isContacted(lead) && !readinessOf(lead).ready && readinessOf(lead).preparation === prep)
  const groups = {
    'Ready to contact': ready,
    'Needs research': byPrep('needs-research'),
    'Needs opportunity review': byPrep('needs-opportunity-review'),
    'Needs contact': byPrep('needs-contact'),
    'Needs duplicate review': byPrep('needs-duplicate-review'),
    'Needs updated evidence': byPrep('needs-updated-evidence'),
    Contacted: contacted,
  }
  const views = [{ label: 'Ready to contact', tone: 'orange' }, { label: 'Needs research', tone: 'gray' }, { label: 'Needs opportunity review', tone: 'gray' }, { label: 'Needs contact', tone: 'gray' }, { label: 'Needs duplicate review', tone: 'gray' }, { label: 'Needs updated evidence', tone: 'gray' }, { label: 'Contacted', tone: 'blue' }]
    .map((item) => ({ ...item, count: (groups[item.label] || []).length }))
  const visible = groups[view] || ready
  const selected = visible.find((lead) => lead.id === selectedId) || visible[0]
  useEffect(() => { if (visible.length && !visible.some((lead) => lead.id === selectedId)) setSelectedId(visible[0].id) }, [visible, selectedId])
  // Daily queue: overdue follow-ups first, then today's, then ready prospects.
  const queue = useMemo(() => buildQueue(eligible.filter((lead) => !isContacted(lead)), { duplicateCounts: dupCounts }), [eligible, dupCounts])
  const queueFor = (lead) => queue.find((item) => item.leadId === lead.id)
  return (
    <>
      <section className="panel outreach-panel">
        <div className="outreach-toolbar"><div><h2>Outreach shortlist</h2><span>{ready.length} ready to contact · {queue.filter((item) => item.kind !== 'ready').length} follow-ups due</span></div>{eligible.length > 0 && <div className="view-tabs tabs-dense" role="tablist" aria-label="Outreach views">{views.map((item) => <button role="tab" aria-selected={view === item.label} key={item.label} className={view === item.label ? 'active' : ''} onClick={() => setView(item.label)}><i className={`filter-dot filter-dot-${item.tone}`} /><span>{item.label}</span><em>{item.count}</em></button>)}</div>}</div>
        {queue.filter((item) => item.kind !== 'ready').length > 0 && <div className="queue-strip" aria-label="Daily queue"><span className="detail-label">Today</span>{queue.filter((item) => item.kind !== 'ready').slice(0, 5).map((item) => <button key={item.leadId} className="button button-quiet button-small" onClick={() => { const target = leads.find((lead) => lead.id === item.leadId); if (target) { setView(readinessOf(target).ready ? 'Ready to contact' : 'Needs opportunity review'); setSelectedId(target.id); onOpen(target) } }} title={item.reason}><span className="e" aria-hidden="true">⏰</span>{item.company} · {item.reason}</button>)}</div>}
        {visible.length ? <div className="outreach-master-detail"><div className="outreach-queue-list" role="listbox" aria-label="Outreach shortlist">{visible.map((lead) => {
          const readiness = readinessOf(lead)
          const sub = readiness.ready
            ? `${readiness.primaryChannel ? `${readiness.primaryChannel.kind}: ${readiness.primaryChannel.value}` : 'channel ready'} · ${readiness.commercial.status === 'scored' ? `value ${readiness.commercial.score}` : readiness.commercial.status}`
            : explainReadiness(readiness)
          return <button key={lead.id} role="option" aria-selected={selected?.id === lead.id} className={selected?.id === lead.id ? 'active' : ''} onClick={() => setSelectedId(lead.id)} title={sub}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{readiness.ready ? `Ready · ${readiness.primaryChannel?.kind || 'channel'}` : readiness.preparation.replace(/-/g, ' ')}</small></span><ChevronRight size={12} /></button>
        })}</div><div className="outreach-selected"><OutreachCard key={selected?.id} lead={selected} readiness={readinessOf(selected)} queueItem={selected ? queueFor(selected) : null} commercialLabel={selected ? commercialStatusLabel(selected) : ''} onOpen={onOpen} onReview={onReview} onUpdate={onUpdate} onAttempt={onAttempt} onGenerate={onGenerate} onCandidate={onCandidate} onToast={onToast} /></div></div> : eligible.length === 0 ? <div className="empty-state"><span className="e e20" aria-hidden="true">✉️</span><h3>No qualified prospects yet</h3><p>Review research findings and qualify a client to prepare its first draft.</p><div className="empty-steps"><span>1 · Review findings</span><span>2 · Qualify for outreach</span><span>3 · Copy, send externally, mark contacted</span></div><button className="button button-primary" onClick={() => goTo('Research')}>Review prospects <ArrowRight size={12} /></button></div> : <div className="empty-state"><span className="e e20" aria-hidden="true">🔍</span><h3>No matching results</h3><p>This filter has no clients. Clear it to see the full queue.</p><button className="button button-secondary" onClick={() => setView('Ready to contact')}>Clear filters</button></div>}
      </section>
    </>
  )
}

// Won value grouped by currency (ROH-28): never summed across currencies,
// never presented as profit.
function wonValueByCurrency(wonLeads) {
  const totals = {}
  for (const lead of wonLeads) {
    const amount = Number(lead.contract?.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const code = String(lead.contract?.currency || 'USD').toUpperCase()
    totals[code] = (totals[code] || 0) + amount
  }
  return totals
}

function FollowupsView({ leads, onOpen, onUpdate }) {
  const today = localDayString()
  // Active sales follow-ups only: open tasks on qualified or in-pipeline
  // leads. Won/Lost stay out (delivery lives on the contract); suppressed
  // leads stay out (reopen explicitly first).
  const tasked = leads.filter((lead) => lead.nextTask?.status === 'open'
    && (isQualifiedLead(lead) || isOpenPipelineLead(lead))
    && !['Won', 'Lost'].includes(lead.salesStage)
    && !lead.doNotContact?.status)
  const groups = [
    ['Overdue', tasked.filter((lead) => taskBucket(lead.nextTask, today) === 'overdue')],
    ['Today', tasked.filter((lead) => taskBucket(lead.nextTask, today) === 'today')],
    ['Upcoming', tasked.filter((lead) => taskBucket(lead.nextTask, today) === 'upcoming')],
    ['No date', tasked.filter((lead) => taskBucket(lead.nextTask, today) === 'none')],
  ]
  const act = (lead, patch) => onUpdate(lead.id, { nextTask: { type: lead.nextTask.type, dueAt: lead.nextTask.dueAt ?? null, owner: lead.nextTask.owner ?? '', note: lead.nextTask.note ?? '', ...patch } })
  const snooze = (lead) => act(lead, { status: 'open', dueAt: addDaysString(lead.nextTask.dueAt || today, 7) })
  // Outcome counts are unique prospects, never attempts: repeated contact
  // attempts cannot inflate these denominators.
  const contacted = leads.filter((lead) => lead.outreachStatus === 'Contacted').length
  const replied = leads.filter((lead) => lead.outreachStatus === 'Replied').length
  const meetings = leads.filter((lead) => lead.salesStage === 'Meeting').length
  const proposals = leads.filter((lead) => lead.salesStage === 'Proposal').length
  const wonByCurrency = wonValueByCurrency(leads.filter((lead) => lead.salesStage === 'Won'))
  return (
    <>
      <section className="simple-summary pipeline-numbers">
        <div><strong>{contacted}</strong><span>Contacted prospects</span></div>
        <div><strong>{replied}</strong><span>Replied</span></div>
        <div><strong>{meetings}</strong><span>Meetings</span></div>
        <div><strong>{proposals}</strong><span>Proposals</span></div>
        <div><strong>{Object.entries(wonByCurrency).map(([code, total]) => `${code} ${total.toLocaleString()}`).join(' · ') || '—'}</strong><span>Won value by currency</span></div>
      </section>
      {groups.map(([label, items]) => <section className="panel followup-group" key={label}><div className="section-heading"><div><h2>{label}</h2><span>{items.length} follow-up{items.length === 1 ? '' : 's'}</span></div><Badge tone={label === 'Overdue' ? 'red' : label === 'Today' ? 'orange' : 'gray'}>{items.length}</Badge></div>
        {items.length ? <div className="followup-list">{items.map((lead) => <article key={lead.id}><button className="followup-main" onClick={() => onOpen(lead)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{lead.nextTask.type} · {lead.nextTask.dueAt || 'no date'}{lead.nextTask.owner ? ` · ${lead.nextTask.owner}` : ''}{lead.nextTask.note ? ` — ${lead.nextTask.note}` : ''}</small></span></button><span><button className="button button-quiet button-small" onClick={() => snooze(lead)}>Snooze 7d</button><button className="button button-quiet button-small" onClick={() => act(lead, { status: 'cleared' })}>Clear</button><button className="button button-secondary button-small" onClick={() => act(lead, { status: 'done' })}>Done</button></span></article>)}</div> : <p className="lead-summary">Nothing here.</p>}
      </section>)}
    </>
  )
}

function PipelinePage({ leads, onOpen, onUpdate, goTo, onContract }) {
  const pipeline = leads.filter((lead) => lead.salesStage)
  const [dragging, setDragging] = useState(null)
  const [selectedStage, setSelectedStage] = useState('Qualified')
  const [boardView, setBoardView] = useState('Board')
  const [showEmptyStages, setShowEmptyStages] = useState(false)
  const hiddenStages = pipelineStages.filter((stage) => !pipeline.some((lead) => lead.salesStage === stage))
  const move = (id, stage) => { if (id) onUpdate(id, { salesStage: stage }); setDragging(null) }
  return (
    <>

      <div className="view-tabs tabs-compact" role="tablist" aria-label="Pipeline views">{['Board', 'Follow-ups'].map((item) => <button role="tab" aria-selected={boardView === item} key={item} className={boardView === item ? 'active' : ''} onClick={() => setBoardView(item)}><span>{item}</span></button>)}</div>
      {boardView === 'Follow-ups' ? <FollowupsView leads={leads} onOpen={onOpen} onUpdate={onUpdate} /> : pipeline.length === 0 ? <section className="panel empty-board"><span className="e e20" aria-hidden="true">📊</span><h2>No pipeline yet</h2><p>Qualify a prospect in Research and it will appear here as an opportunity you can move forward.</p><button className="button button-primary" onClick={() => goTo('Research')}>Review prospects <ArrowRight size={12} /></button></section> : <>
      <section className="simple-summary pipeline-numbers">
        <div><strong>{pipeline.filter(isOpenPipelineLead).length}</strong><span>Open opportunities</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Meeting').length}</strong><span>Meetings</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Proposal').length}</strong><span>Proposals</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Won').length}</strong><span>Won clients</span></div>
      </section>
      <div className="pipeline-stage-tabs" role="tablist" aria-label="Pipeline stages">{pipelineStages.map((stage) => <button key={stage} role="tab" aria-selected={selectedStage === stage} className={selectedStage === stage ? 'active' : ''} onClick={() => setSelectedStage(stage)}><span>{stage}</span><em>{pipeline.filter((lead) => lead.salesStage === stage).length}</em></button>)}</div>
      {hiddenStages.length > 0 && <p className="kanban-hidden-note">{showEmptyStages ? 'Showing every stage.' : `${hiddenStages.length} empty ${hiddenStages.length === 1 ? 'stage is' : 'stages are'} hidden — the board follows active work.`} <button className="button button-quiet button-small" onClick={() => setShowEmptyStages((value) => !value)}>{showEmptyStages ? 'Hide empty' : 'Show empty'}</button></p>}
      <div className="kanban-wrap"><div className="kanban-board">{pipelineStages.filter((stage) => showEmptyStages || !hiddenStages.includes(stage)).map((stage) => {
        const clients = pipeline.filter((lead) => lead.salesStage === stage)
        return <section className={cn('kanban-column', `stage-${stage.toLowerCase()}`, selectedStage !== stage && 'is-unselected', dragging && 'kanban-drop-ready')} key={stage} onDragOver={(event) => event.preventDefault()} onDrop={() => move(dragging, stage)}><div className="kanban-heading"><Badge tone={statusTone[stage]} dot>{stage}</Badge><span>{clients.length}</span></div><div className="kanban-list">{clients.map((lead) => <article className="pipeline-card" key={lead.id} draggable onDragStart={() => setDragging(lead.id)} onDragEnd={() => setDragging(null)}><button className="pipeline-card-main" onClick={() => onOpen(lead)}><div><Score value={lead.opportunityScore} /><span className="pipeline-next-action">{getNextAction(lead)}</span></div><h3>{lead.company}</h3><p>{lead.mainIssue}</p></button><div className="pipeline-card-foot"><StagePicker lead={lead} onChange={(nextStage) => move(lead.id, nextStage)} />{stage === 'Won' ? <button className="contract-link" onClick={() => onContract(lead)}>{lead.contract ? 'Contract' : 'Add contract'}</button> : <span>{lead.nextAction || lead.updated || 'Set next action'}</span>}</div></article>)}{clients.length === 0 && <div className="kanban-empty">No clients here</div>}</div></section>
      })}</div></div>
      <div className="pipeline-lost-note"><span className="e e13" aria-hidden="true">⚠️</span><span>Lost clients are closed separately from this active pipeline.</span><button className="button button-quiet button-small" onClick={() => goTo('Clients', { search: '?filter=Lost' })}>View lost clients</button></div>
      {pipeline.some((lead) => lead.salesStage === 'Lost') && <section className="panel lost-pipeline-panel"><div className="section-heading"><div><h2>Closed as lost</h2><span>Kept here for history; these clients are not active opportunities.</span></div><Badge tone="gray">{pipeline.filter((lead) => lead.salesStage === 'Lost').length}</Badge></div><div className="lost-pipeline-list">{pipeline.filter((lead) => lead.salesStage === 'Lost').map((lead) => <button key={lead.id} onClick={() => onOpen(lead)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{lead.lostReason || 'Reason not recorded'}</small></span><Score value={lead.opportunityScore} /><ChevronRight size={13} /></button>)}</div></section>}
      </>}
    </>
  )
}

function ContractsPage({ leads, onOpen, onContract, goTo }) {
  const won = leads.filter((lead) => lead.salesStage === 'Won')
  const wonTotals = wonValueByCurrency(won)
  return (
    <>

      <section className="simple-summary won-summary">
        <div><strong>{won.length}</strong><span>Won clients</span></div>
        <div><strong>{won.filter((lead) => !lead.contract).length}</strong><span>Details needed</span></div>
        <div><strong>{won.length === 0 ? '—' : Object.entries(wonTotals).map(([code, total]) => currency(total, code)).join(' · ') || 'Value missing'}</strong><span>Recorded value by currency</span></div>
        <div><strong>{won.filter((lead) => lead.contract?.startDate).length}</strong><span>Start dates set</span></div>
      </section>
      {won.length ? <section className="won-grid">{won.map((lead) => <article className={cn('panel won-card', !lead.contract && 'contract-needs-details')} key={lead.id}><div className="won-card-head"><div><Avatar name={lead.company} /><span><h2>{lead.company}</h2><small>{lead.category} · {lead.location}</small></span></div><Badge tone={lead.contract ? 'green' : 'amber'}><span className="e e11" aria-hidden="true">{lead.contract ? '✅' : '📝'}</span>{lead.contract ? 'Contract recorded' : 'Details needed'}</Badge></div><div className="contract-value"><span>Approved value</span><strong>{currency(lead.contract?.amount, lead.contract?.currency)}</strong></div><dl><div><dt>Scope</dt><dd>{lead.contract?.scope || 'Not recorded'}</dd></div><div><dt>Terms</dt><dd>{lead.contract?.terms || 'Not recorded'}</dd></div><div><dt>Start date</dt><dd>{lead.contract?.startDate || 'Not set'}</dd></div><div><dt>Next step</dt><dd>{lead.contract?.nextStep || 'Not set'}</dd></div></dl><div className="won-card-actions"><button className="button button-secondary button-small" onClick={() => onOpen(lead)}>View client</button><button className="button button-primary button-small" onClick={() => onContract(lead)}>{lead.contract ? 'Edit contract' : 'Add contract details'}</button></div></article>)}</section> : <section className="panel empty-won"><span className="e e20" aria-hidden="true">🏆</span><h2>No won clients yet</h2><p>Review research findings and qualify a prospect to start its path to a contract.</p><button className="button button-primary" onClick={() => goTo('Research')}>Review prospects <ArrowRight size={12} /></button></section>}
    </>
  )
}

function BackupPanel() {
  const [health, setHealth] = useState(null)
  const [backups, setBackups] = useState([])
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [plan, setPlan] = useState(null)
  const [pendingFile, setPendingFile] = useState(null)
  const fileInput = useRef(null)
  const load = async () => {
    try {
      const [healthData, listData] = await Promise.all([apiRequest('/api/storage/health'), apiRequest('/api/backups')])
      setHealth(healthData); setBackups(listData.backups || [])
    } catch (caught) { setNotice({ tone: 'error', text: caught?.message || 'Could not load backup status' }) }
  }
  useEffect(() => { load() }, [])
  const fail = (caught, fallback) => setNotice({ tone: 'error', text: caught?.message || fallback })
  const createSnapshot = async () => {
    setBusy('create'); setNotice(null)
    try {
      const created = await apiRequest('/api/backups', { method: 'POST', timeoutMs: 300_000 })
      setNotice({ tone: 'ok', text: `Snapshot ${created.name} verified — ${created.counts?.leads ?? 0} clients, ${created.files ?? 0} files.` })
      await load()
    } catch (caught) { fail(caught, 'Could not create a backup snapshot') } finally { setBusy(null) }
  }
  const restoreSnapshot = async (name, counts) => {
    if (!window.confirm(`Restore snapshot ${name}? This replaces all current clients, runs and settings with the snapshot (${counts?.leads ?? '?'} clients).`)) return
    setBusy(`restore:${name}`); setNotice(null)
    try {
      const result = await apiRequest(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }), timeoutMs: 300_000 })
      setNotice({ tone: 'ok', text: `Restored ${result.restored?.tables?.leads ?? 0} clients and ${result.restored?.files ?? 0} files. Reloading…` })
      window.setTimeout(() => window.location.reload(), 1200)
    } catch (caught) { fail(caught, 'Could not restore the snapshot') } finally { setBusy(null) }
  }
  const deleteSnapshot = async (name) => {
    if (!window.confirm(`Delete snapshot ${name}? This cannot be undone.`)) return
    setBusy(`delete:${name}`); setNotice(null)
    try { await apiRequest(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }); await load() }
    catch (caught) { fail(caught, 'Could not delete the snapshot') } finally { setBusy(null) }
  }
  const exportBackup = async () => {
    setBusy('export'); setNotice(null)
    try {
      const response = await fetch('/api/backup/export')
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `Export failed with HTTP ${response.status}`)
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'scoutline-backup.json'
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => window.URL.revokeObjectURL(url), 5000)
      setNotice({ tone: 'ok', text: 'Backup file downloaded — keep it somewhere safe.' })
    } catch (caught) { fail(caught, 'Could not download the backup file') } finally { setBusy(null) }
  }
  const inspectFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('inspect'); setNotice(null); setPlan(null); setPendingFile(null)
    try {
      const backup = JSON.parse(await file.text())
      const preview = await apiRequest('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup }), timeoutMs: 300_000 })
      setPlan(preview); setPendingFile({ name: file.name, backup })
    } catch (caught) { fail(caught, 'That file is not a usable Scoutline backup') } finally { setBusy(null) }
  }
  const confirmImport = async () => {
    if (!pendingFile) return
    if (!window.confirm(`Replace ALL current data with ${pendingFile.name}? This cannot be undone.`)) return
    setBusy('import'); setNotice(null)
    try {
      const result = await apiRequest('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: pendingFile.backup, confirm: true }), timeoutMs: 300_000 })
      setNotice({ tone: 'ok', text: `Restored ${result.restored?.tables?.leads ?? 0} clients and ${result.restored?.files ?? 0} files. Reloading…` })
      window.setTimeout(() => window.location.reload(), 1200)
    } catch (caught) { fail(caught, 'Could not restore the backup file') } finally { setBusy(null) }
  }
  const failures = health?.artifactFailures || []
  return (
    <section className="panel minimal-settings">
      <div><h2>Backup &amp; restore</h2><p>Everything stays on this machine. Snapshots are verified on creation; restores are verified before anything is replaced.</p></div>
      <div className="minimal-form">
        <div className="backup-groups">
          <div><h3>Snapshots on this machine</h3><p>Verified copies you can restore from the list below.</p><button className="button button-secondary button-small" onClick={createSnapshot} disabled={busy === 'create'}>{busy === 'create' ? <LoaderCircle size={12} className="spin" /> : <span className="e" aria-hidden="true">🗄️</span>}{busy === 'create' ? 'Saving…' : 'Save snapshot now'}</button></div>
          <div><h3>Portable backup file</h3><p>Download a copy to keep elsewhere, or restore from one.</p><div className="action-row"><button className="button button-secondary button-small" onClick={exportBackup} disabled={busy === 'export'}>{busy === 'export' ? <LoaderCircle size={12} className="spin" /> : <span className="e" aria-hidden="true">📤</span>}{busy === 'export' ? 'Preparing…' : 'Download backup file'}</button><button className="button button-secondary button-small" onClick={() => fileInput.current?.click()} disabled={busy === 'inspect'}>{busy === 'inspect' ? <LoaderCircle size={12} className="spin" /> : <span className="e" aria-hidden="true">📂</span>}{busy === 'inspect' ? 'Checking…' : 'Restore from file'}</button><input ref={fileInput} className="visually-hidden" type="file" accept=".json,application/json" onChange={inspectFile} /></div></div>
        </div>
        {health && <small className={health.writable ? 'health-note' : 'health-note is-error'}>{health.writable ? `Storage is writable · ${health.backups.count} snapshot(s)` : 'Storage is NOT writable — backups cannot be written. Fix disk permissions.'}{failures.length > 0 && ` · ${failures.length} report file(s) need repair (restore a backup to fix).`}</small>}
        {failures.length > 0 && <div className="preview-banner"><span className="e e16" aria-hidden="true">⚠️</span><div><strong>Some report files failed to save</strong><p>{failures.map((item) => item.leadId).slice(0, 5).join(', ')}{failures.length > 5 ? ` and ${failures.length - 5} more` : ''} — the database is intact. Restoring a backup rewrites the files.</p></div></div>}
        {plan && pendingFile && <div className="preview-banner"><span className="e e16" aria-hidden="true">🛡️</span><div><strong>{pendingFile.name} looks good</strong><p>Would restore {plan.tables?.leads ?? 0} clients, {plan.tables?.runs ?? 0} runs, {plan.files ?? 0} files{plan.createdAt ? ` · backed up ${new Date(plan.createdAt).toLocaleString()}` : ''}.</p></div><div><button className="button button-primary button-small" onClick={confirmImport} disabled={busy === 'import'}>{busy === 'import' ? 'Restoring…' : 'Replace my data'}</button><button className="button button-quiet button-small" onClick={() => { setPlan(null); setPendingFile(null) }}>Cancel</button></div></div>}
        {notice && <div className={notice.tone === 'ok' ? 'field-error field-ok' : 'field-error'}>{notice.text}</div>}
        {backups.length > 0 && <div className="backup-list">{backups.map((item) => <div key={item.name} className="backup-row"><span className="grow"><strong>{item.name}</strong><br /><small>{item.counts ? `${item.counts.leads ?? 0} clients · ${item.files} files` : 'unreadable snapshot'}</small></span><button className="button button-quiet button-small" onClick={() => restoreSnapshot(item.name, item.counts)} disabled={busy === `restore:${item.name}`}>{busy === `restore:${item.name}` ? 'Restoring…' : 'Restore'}</button><button className="button button-quiet button-small" aria-label={`Delete snapshot ${item.name}`} onClick={() => deleteSnapshot(item.name)} disabled={busy === `delete:${item.name}`}><span className="e e12" aria-hidden="true">🗑️</span></button></div>)}</div>}
      </div>
    </section>
  )
}

function SettingsPage({ apiStatus, settings, onSave }) {
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  useEffect(() => setDraft(settings), [settings])
  const validation = validateSettingsDraft(draft)
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const handleField = (key, parse) => (event) => {
    const raw = event.target.value
    const val = parse ? parse(raw) : raw
    setDraft((c) => ({ ...c, [key]: val }))
    if (fieldErrors[key] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[key]; delete n._general; return n })
  }
  const handleOfferField = (key, parse) => (event) => {
    const raw = event?.target?.value
    const val = parse ? parse(raw) : raw
    setDraft((c) => ({ ...c, offer: { ...(c.offer || {}), [key]: val } }))
    if (fieldErrors[`offer.${key}`] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[`offer.${key}`]; delete n._general; return n })
  }
  const toggleOfferChannel = (channel) => () => {
    setDraft((c) => {
      const current = c.offer?.channels || []
      const next = current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel]
      return { ...c, offer: { ...(c.offer || {}), channels: next } }
    })
  }
  const handleBlur = (key) => () => setTouched((p) => ({ ...p, [key]: true }))
  const save = async () => {
    setSubmitted(true)
    setTouched({ defaultLocation: true, resultLimit: true, deepAuditLimit: true, discoveryLatitude: true, discoveryLongitude: true, 'offer.service': true, 'offer.callToAction': true, 'offer.channels': true })
    const v = validateSettingsDraft(draft)
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      // A changed offer ships without its version so the server stamps a new
      // one; unchanged offers keep their version and leave drafts unstaled.
      const payload = { ...draft }
      const before = settings.offer || {}
      const after = draft.offer || {}
      const same = ['service', 'geography', 'exclusions', 'callToAction', 'tone'].every((k) => String(before[k] || '') === String(after[k] || ''))
        && JSON.stringify(before.targetCategories || []) === JSON.stringify(after.targetCategories || [])
        && JSON.stringify(before.proofPoints || []) === JSON.stringify(after.proofPoints || [])
        && JSON.stringify([...(before.channels || [])].sort()) === JSON.stringify([...(after.channels || [])].sort())
      if (!same && payload.offer) {
        const { version: _dropped, ...rest } = payload.offer
        payload.offer = rest
      }
      const saved = await onSave(payload)
      if (!saved) setFieldErrors({ _general: 'Could not save settings' })
      else setTouched({})
    } catch (caught) {
      const mapped = getFieldErrorsFromApiError(caught)
      if (Object.keys(mapped).length) setFieldErrors(mapped)
      else setFieldErrors({ _general: caught?.message || 'Could not save settings' })
    } finally { setSaving(false) }
  }
  return (
    <>
      <section className="panel minimal-settings">
        <div><h2>Research defaults</h2><p>Used when a new collection run starts.</p></div>
        <div className="minimal-form"><label><span>Default location *</span><input value={draft.defaultLocation || ''} onChange={handleField('defaultLocation')} onBlur={handleBlur('defaultLocation')} className={show('defaultLocation') ? 'input-error' : undefined} aria-invalid={Boolean(show('defaultLocation'))} />{show('defaultLocation') && <span className="field-error">{merged.defaultLocation}</span>}</label><div><label><span>Clients per run (1-50)</span><input type="number" min="1" max="50" value={draft.resultLimit || 25} onChange={handleField('resultLimit', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('resultLimit')} className={show('resultLimit') ? 'input-error' : undefined} aria-invalid={Boolean(show('resultLimit'))} />{show('resultLimit') && <span className="field-error">{merged.resultLimit}</span>}</label><label><span>Website audits (1-25)</span><input type="number" min="1" max="25" value={draft.deepAuditLimit || 10} onChange={handleField('deepAuditLimit', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('deepAuditLimit')} className={show('deepAuditLimit') ? 'input-error' : undefined} aria-invalid={Boolean(show('deepAuditLimit'))} />{show('deepAuditLimit') && <span className="field-error">{merged.deepAuditLimit}</span>}</label></div><p className="hint">Collect up to {draft.resultLimit || 25} businesses and audit up to {draft.deepAuditLimit || 10} websites per run.</p><details className="advanced-group"><summary>Advanced: coordinate overrides</summary><div><label><span>Discovery latitude (-90 to 90)</span><input type="number" step="any" value={draft.discoveryLatitude ?? ''} onChange={handleField('discoveryLatitude', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('discoveryLatitude')} className={show('discoveryLatitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('discoveryLatitude'))} />{show('discoveryLatitude') && <span className="field-error">{merged.discoveryLatitude}</span>}</label><label><span>Discovery longitude (-180 to 180)</span><input type="number" step="any" value={draft.discoveryLongitude ?? ''} onChange={handleField('discoveryLongitude', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('discoveryLongitude')} className={show('discoveryLongitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('discoveryLongitude'))} />{show('discoveryLongitude') && <span className="field-error">{merged.discoveryLongitude}</span>}</label></div><small className="hint">Default map center for discovery. A run can set its own center instead.</small></details>{fieldErrors._general && <div className="field-error">{fieldErrors._general}</div>}<button className="button button-primary" onClick={save} disabled={saving}>{saving ? <LoaderCircle size={12} className="spin" /> : <span className="e" aria-hidden="true">✅</span>}{saving ? 'Saving…' : 'Save settings'}</button></div>
      </section>
      <section className="panel minimal-settings">
        <div><h2>Offer &amp; campaign</h2><p>Used when generating outreach. Editing the offer marks existing drafts stale without rewriting them.</p></div>
        <div className="minimal-form"><label><span>Service description</span><input value={draft.offer?.service || ''} onChange={handleOfferField('service')} onBlur={handleBlur('offer.service')} className={show('offer.service') ? 'input-error' : undefined} />{show('offer.service') && <span className="field-error">{merged['offer.service']}</span>}</label><div><label><span>Target categories (comma separated)</span><input value={(draft.offer?.targetCategories || []).join(', ')} onChange={handleOfferField('targetCategories', (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean))} /></label><label><span>Geography</span><input value={draft.offer?.geography || ''} onChange={handleOfferField('geography')} placeholder="Salt Lake City, Utah" /></label></div><label><span>Exclusions</span><input value={draft.offer?.exclusions || ''} onChange={handleOfferField('exclusions')} placeholder="Who this is not for — optional" /></label><label><span>Proof points (one per line — leave blank if unconfirmed)</span><textarea value={(draft.offer?.proofPoints || []).join('\n')} onChange={handleOfferField('proofPoints', (v) => String(v).split('\n').map((s) => s.trim()).filter(Boolean))} placeholder="No invented results, guarantees, or pricing" /></label><label><span>Preferred call to action *</span><input value={draft.offer?.callToAction || ''} onChange={handleOfferField('callToAction')} onBlur={handleBlur('offer.callToAction')} className={show('offer.callToAction') ? 'input-error' : undefined} />{show('offer.callToAction') && <span className="field-error">{merged['offer.callToAction']}</span>}</label><div><label><span>Tone</span><input value={draft.offer?.tone || ''} onChange={handleOfferField('tone')} /></label><fieldset className="channel-picks"><legend>Preferred channels</legend>{['email', 'phone', 'form'].map((channel) => <label key={channel}><input type="checkbox" checked={(draft.offer?.channels || []).includes(channel)} onChange={toggleOfferChannel(channel)} />{channel}</label>)}</fieldset></div>{show('offer.channels') && <span className="field-error">{merged['offer.channels']}</span>}<p className="hint">Changing the offer stamps a new version; drafts keep the version they were written with.</p></div>
      </section>
      {(!apiStatus?.brightDataAdapterReady || !apiStatus?.outreachConfigured || !apiStatus?.jevConfigured) && <details className="panel advanced-group setup-guide"><summary>Connect AI and discovery services</summary><div><p><strong>Live discovery:</strong> add <code>BRIGHT_DATA_API_KEY</code> to <code>.env</code> and restart the server.</p><p><strong>Jev triage:</strong> add <code>TYPESAFE_API_KEY</code> to <code>.env</code> and restart the server. It is advisory and does not replace the deterministic score.</p><p><strong>Outreach generation:</strong> add <code>MODEL_API_KEY</code> (or <code>OPENAI_API_KEY</code>) to <code>.env</code> and restart the server.</p><p>See <code>.env.example</code> for every supported key.</p></div></details>}
      <BackupPanel />
      <section className="panel connection-status"><span className="e e18" aria-hidden="true">🗄️</span><div><strong>Local SQLite storage</strong><span>{apiStatus?.databasePath || 'data/scoutline.db'}</span></div><Badge tone="green">Healthy</Badge></section>
      <section className="panel connection-status"><span className="e e18" aria-hidden="true">🪄</span><div><strong>Live discovery</strong><span>{apiStatus?.brightDataAdapterReady ? `Connected · each run can collect up to ${apiStatus.brightDataMaxRecords || 25} businesses.` : 'Not connected — runs audit your saved clients instead. Add a discovery key to collect new businesses.'}</span></div><Badge tone={apiStatus?.brightDataAdapterReady ? 'green' : 'amber'}>{apiStatus?.brightDataAdapterReady ? 'Connected' : 'Not connected'}</Badge></section>
      <section className="panel connection-status"><span className="e e18" aria-hidden="true">🧭</span><div><strong>Jev semantic triage</strong><span>{apiStatus?.jevConfigured ? `Connected · ${apiStatus.jevModel || 'jev-latest'} classifies local scrape results and suggests review or deep-audit routing.` : 'Not connected — local scrapes keep using deterministic opportunity and eligibility scores.'}</span></div><Badge tone={apiStatus?.jevConfigured ? 'green' : 'gray'}>{apiStatus?.jevConfigured ? 'Connected' : 'Advisory off'}</Badge></section>
      <section className="panel connection-status"><span className="e e18" aria-hidden="true">🤖</span><div><strong>Outreach generation</strong><span>{apiStatus?.outreachConfigured ? `${apiStatus.outreachProviderLabel} writes all three email versions from your evidence.` : 'No model key — drafts use built-in evidence templates instead.'}</span></div><Badge tone={apiStatus?.outreachConfigured ? 'green' : 'gray'}>{apiStatus?.outreachConfigured ? 'AI drafts' : 'Templates'}</Badge></section>
    </>
  )
}

function MuseSynthesis({ lead, onAnalyze, onUpdate }) {
  const analysis = lead.museAnalysis
  const status = analysis?.status || 'Not generated'
  const active = ['Queued', 'Running'].includes(status) || ['Queued', 'Running'].includes(lead.museJob?.status)
  const recommendationTone = analysis?.qualificationRecommendation === 'Pursue' ? 'green' : analysis?.qualificationRecommendation === 'Review' ? 'amber' : 'gray'
  return <section className={cn('muse-card', status === 'Failed' && 'has-failed')}>
    <div className="muse-card-head"><div><span className="muse-mark"><span className="e e14" aria-hidden="true">🤖</span></span><span><strong>AI synthesis</strong><small>Grounded in the saved crawl and Lighthouse evidence</small></span></div>{analysis?.status === 'Completed' ? <Badge tone={recommendationTone} dot>{analysis.qualificationRecommendation}</Badge> : <Badge tone={statusTone[status] || 'gray'} dot>{active ? lead.museJob?.phase || status : status}</Badge>}</div>
    {analysis?.status === 'Completed' ? <><p className="muse-summary">{analysis.summary}</p><div className="muse-opportunities">{(analysis.topOpportunities || []).slice(0, 4).map((item) => <article key={`${item.title}-${item.evidence}`}><span className={cn('muse-severity', `is-${item.severity.toLowerCase()}`)}>{item.severity}</span><div><strong>{item.title}</strong><p>{item.evidence}</p><small>{item.recommendation}</small></div></article>)}</div><div className="muse-foot"><span><b>{analysis.strengths?.length || 0}</b> strengths</span><span><b>{analysis.unknowns?.length || 0}</b> unknowns</span>{analysis?.stale && <span className="stale-badge">Stale — a newer audit completed</span>}<span>AI does not change the score</span>{analysis?.stale && <button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { museStale: false })}>Mark reviewed</button>}<button className="button button-quiet button-small" onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">🔄</span>Regenerate</button></div></> : <div className="muse-empty"><div><strong>{status === 'Failed' ? 'AI could not finish this synthesis' : active ? 'AI is reviewing the evidence' : status === 'Skipped' ? 'AI synthesis skipped — no AI key configured' : 'Add a second layer of reasoning'}</strong><p>{status === 'Failed' ? analysis.error : active ? 'The deterministic score remains available while this runs.' : status === 'Skipped' ? 'The deterministic audit stands on its own. Add an AI key and retry to get synthesis without re-running the audit.' : 'AI will prioritize the measured issues, explain why they matter, and suggest factual outreach angles.'}</p></div><button className="button button-secondary button-small" disabled={active} onClick={() => onAnalyze(lead)}>{active ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">🪄</span>}{active ? 'Analyzing' : status === 'Failed' ? 'Retry AI' : 'Analyze with AI'}</button></div>}
  </section>
}

const leadValueBandTone = { 'Top Prospect': 'green', Strong: 'purple', Review: 'amber', 'Low Priority': 'gray' }

// "Why this lead" (ROH-6): every component shows its score, top observed
// contributions and unknown count. Weights are hypotheses, stated as such.
function LeadValueCard({ lead }) {
  const value = lead.leadValue
  if (!value) return null
  const parts = [['Need', value.need], ['Business fit', value.businessFit], ['Reachability', value.reachability], ['Timing', value.timing]]
  return <section className="detail-section">
    <div className="detail-heading"><span className="detail-label">Why this lead</span><Badge tone={leadValueBandTone[value.band] || 'gray'}>{value.band}</Badge></div>
    <p className="lead-summary">Commercial value {value.leadValueScore}/100 · {value.bandReason}. Evidence coverage {Math.round((value.coverage || 0) * 100)}% · rubric {value.version} (default weights are uncalibrated hypotheses, not a sales forecast).</p>
    {value.excluded ? <p className="lead-summary">{value.excluded.reason}</p> : null}
    <div className="problem-list">{parts.map(([label, part]) => <div key={label}><span>{part?.score ?? 0}</span><p><strong>{label} {part?.score ?? 0}/100.</strong> {(part?.contributions || []).slice(0, 2).map((c) => c.signal).join('; ') || 'No observed signals yet.'}{(part?.unknowns || []).length ? ` · ${(part.unknowns || []).length} unknown${(part.unknowns || []).length === 1 ? '' : 's'} lower confidence, not the score.` : ''}</p></div>)}</div>
  </section>
}

function FindingReviewRow({ item, review, stale, onReview }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  if (stale) return <div className="finding-row is-stale"><span>Superseded</span><p><strong>{item.finding?.detail || item.findingKey}</strong><small>Reviewed under an older audit — kept for history, excluded from readiness.</small></p></div>
  if (review) return <div className={cn('finding-row', review.decision === 'accepted' && 'is-accepted')}><span>{review.decision === 'accepted' ? <span className="e e14" aria-hidden="true">✅</span> : <span className="e e14" aria-hidden="true">❌</span>}</span><p><strong>{item.finding?.detail || item.findingKey}</strong><small>{review.decision} {review.at ? `· ${new Date(review.at).toLocaleString()}` : ''}{review.by ? ` · ${review.by}` : ''}{review.reason ? ` — ${review.reason}` : ''}</small></p></div>
  return <div className="finding-row"><span><span className="e e14" aria-hidden="true">⚠️</span></span><p><strong>{item.detail}</strong>{item.evidence && <small>Evidence: {item.evidence}</small>}</p><div>{!rejecting ? <><button className="button button-secondary button-small" disabled={busy} onClick={async () => { setBusy(true); await onReview({ findingKey: item.key, decision: 'accepted' }); setBusy(false) }}>Accept</button><button className="button button-quiet button-small" onClick={() => setRejecting(true)}>Reject</button></> : <><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this finding wrong?" /><button className="button button-quiet button-small" onClick={() => { setRejecting(false); setReason('') }}>Cancel</button><button className="button button-secondary button-small" disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); await onReview({ findingKey: item.key, decision: 'rejected', reason: reason.trim() }); setBusy(false) }}>Save rejection</button></>}</div></div>
}

/* BriefTab was split into ResearchReviews (readiness + finding reviews, under
   the Research tab) and ActivityPanel (rationale, follow-ups, suppression,
   attempts, notes, under the Activity tab). */

function BusinessIntelligence({ lead }) {
  const intelligence = lead.businessIntelligence
  if (!intelligence) return null
  const metric = (key) => intelligence.companyMetrics?.[key]?.value
  const display = (key, fallback = 'Unknown') => metric(key) ?? fallback
  const maturity = intelligence.digitalMaturity
  const latestReview = intelligence.latestObservedReviewAt ? new Date(intelligence.latestObservedReviewAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown'
  const metrics = [
    ['Employees', display('employeeCount'), 'Requires a company-data source'],
    ['Annual revenue', display('annualRevenue'), 'Source-backed estimate only'],
    ['Annual profit', display('annualProfit'), 'Not inferred from revenue'],
    ['Branches', display('branchCount'), `${intelligence.locationsObserved || 0} location${intelligence.locationsObserved === 1 ? '' : 's'} observed`],
    ['Founded', display('foundedYear'), 'Requires a public source'],
  ]
  return <section className="detail-section intelligence-section">
    <div className="detail-heading"><span className="detail-label">Business intelligence</span><Badge tone="blue">{intelligence.source || 'Saved evidence'}</Badge></div>
    <div className="maturity-card"><div><span>Digital maturity</span><strong>{maturity?.score ?? '—'}<small>/100</small></strong><em>{maturity?.band || 'Not calculated'}</em></div><div className="maturity-track"><i style={{ width: `${maturity?.score || 0}%` }} /></div><p>{maturity?.coverage ? `Formula v${maturity.version || 2} · ${maturity.coverage.measuredComponents}/${maturity.coverage.totalComponents} components measured (${maturity.coverage.share}% of weighted signals). Unmeasured signals are excluded, not scored as poor.` : maturity ? 'Legacy formula (v1) — unmeasured signals were scored as poor. Re-run enrichment for v2 coverage.' : 'Calculated from measured website, technology, booking, profile, and maintenance signals.'}</p></div>
    <div className="intelligence-metrics">{metrics.map(([label, value, note]) => <article key={label} className={value === 'Unknown' ? 'is-unknown' : ''}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</div>
    <div className="intelligence-signals"><span><span className="e e11" aria-hidden="true">✅</span>{intelligence.claimed ? 'Google profile claimed' : 'Claim status unknown'}</span><span><span className="e e11" aria-hidden="true">📅</span>{intelligence.onlineBooking ? 'Online booking detected' : intelligence.onlineEstimates ? 'Online estimates offered' : 'No online booking detected'}</span><span><span className="e e11" aria-hidden="true">⭐</span>{intelligence.positiveReviewShare != null ? `${intelligence.positiveReviewShare}% positive reviews` : 'Review mix unknown'}</span><span><span className="e e11" aria-hidden="true">🕐</span>Latest sampled review {latestReview}</span></div>
    <p className="intelligence-note"><span className="e e11" aria-hidden="true">🛡️</span>Unknown fields stay unknown until a named source supplies them. AI cannot estimate them.</p>
  </section>
}

const clientRunActions = [
  { id: 'refresh', label: 'Refresh business data', description: 'Fetch this Google Maps record again with Bright Data.', emoji: '🗄️' },
  { id: 'audit', label: 'Run website audit', description: 'Crawl the site, check links, and rerun Lighthouse.', emoji: '📈' },
  { id: 'muse', label: 'Run AI analysis', description: 'Synthesize the saved audit evidence and recommendation.', emoji: '🤖' },
  { id: 'outreach', label: 'Generate outreach', description: 'Create concise, balanced, and detailed email drafts.', emoji: '✉️' },
]

function runTimestamp(run) {
  const value = run?.completedAt || run?.startedAt
  if (!value) return 'No manual run yet'
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function runLabel(run) {
  if (!run) return 'No research run'
  return run.sequence ? `Run ${run.sequence}` : `Run ${String(run.id || '').slice(-6).toUpperCase()}`
}

function leadRunInfo(lead, runs = []) {
  const history = Array.isArray(lead?.runHistory) ? [...lead.runHistory].sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime()) : []
  const collection = history.find((item) => item.relationship === 'new')
  const latest = history[0]
  const findRun = (item) => item ? runs.find((run) => run.id === item.runId) : null
  return {
    collection,
    collectionRun: findRun(collection),
    latest,
    latestRun: findRun(latest),
  }
}

const ACTIVE_JOB_MIRROR = ['Queued', 'Running', 'Waiting']
const FAILED_JOB_MIRROR = ['Failed', 'Error', 'Timed out']

// The freshest job mirror across the three per-lead job slots. Mirrors are
// written alongside every job transition, so the UI never needs a jobs fetch.
function activeLeadJob(lead = {}) {
  return [lead.researchJob, lead.museJob, lead.refreshJob].find((mirror) => mirror?.id && ACTIVE_JOB_MIRROR.includes(mirror.status)) || null
}

function failedLeadJob(lead = {}) {
  return [lead.researchJob, lead.museJob, lead.refreshJob].find((mirror) => mirror?.id && FAILED_JOB_MIRROR.includes(mirror.status)) || null
}

// Whether the failed job can be resumed in place (same parameters, kept
// evidence) or needs a fresh run. Absent flags on legacy rows mean resumable.
function leadJobRetryable(lead = {}, mirror = null) {
  if (!mirror) return false
  if (typeof mirror.retryable === 'boolean') return mirror.retryable
  if (mirror === lead.researchJob && typeof lead.researchFailure?.retryable === 'boolean') return lead.researchFailure.retryable
  return true
}

function ClientRunMenu({ lead, onRun, brightDataReady }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(null)
  const triggerRef = useRef(null)
  useEffect(() => { setOpen(false); setPending(null) }, [lead.id])
  // An open menu consumes Escape first (capture runs before the app-level
  // handler), so leaving a menu never exits the record underneath.
  useEffect(() => {
    if (!open) return
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  const active = ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status)
  const invoke = async (action) => {
    setPending(action)
    const updated = await onRun(lead, action)
    setPending(null)
    if (updated) setOpen(false)
  }
  const unavailable = (action) => action === 'refresh' ? !brightDataReady || !lead.sourceUrl : ['muse', 'outreach'].includes(action) ? lead.opportunityScore == null : false
  return <div className="client-run-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={triggerRef} className={cn('button button-secondary button-small client-run-trigger', active && 'is-running')} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} disabled={Boolean(pending)}>{active ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">▶️</span>}<span>{active ? 'Running' : 'Run'}</span><ChevronDown size={10} /></button>
    {open && <div className="client-run-popover" role="menu">
      <header><div><strong>Run for this client</strong><small>{active ? lead.manualRun.phase : `${lead.manualRun?.label || 'Manual control'} · ${runTimestamp(lead.manualRun)}`}</small></div>{active && <Badge tone="orange">{lead.manualRun.progress || 0}%</Badge>}</header>
      <button className="full-run-action" role="menuitem" type="button" onClick={() => invoke('full')} disabled={active || Boolean(pending)}><span><span className="e e15" aria-hidden="true">🪄</span></span><div><strong>Run full workflow</strong><small>Refresh data when available, then audit, AI, and outreach.</small></div>{pending === 'full' ? <LoaderCircle className="spin" size={12} /> : <ArrowRight size={12} />}</button>
      <div className="run-action-list">{clientRunActions.map(({ id, label, description, emoji }) => <button key={id} role="menuitem" type="button" onClick={() => invoke(id)} disabled={active || Boolean(pending) || unavailable(id)} title={unavailable(id) ? id === 'refresh' ? 'Requires a saved Google Maps source and Bright Data' : 'Run the website audit first' : undefined}><span><span className="e e14" aria-hidden="true">{emoji}</span></span><div><strong>{label}</strong><small>{unavailable(id) ? id === 'refresh' ? 'Unavailable for this client' : 'Website audit required first' : description}</small></div>{pending === id ? <LoaderCircle className="spin" size={12} /> : <ChevronRight size={12} />}</button>)}</div>
      <footer><span className="e e11" aria-hidden="true">🛡️</span>Nothing is sent to the client automatically.</footer>
    </div>}
  </div>
}

function ManualRunStatus({ lead, onRun, onCancelJob }) {
  const run = lead.manualRun
  if (!run) return null
  const active = ['Queued', 'Running', 'Waiting'].includes(run.status)
  const failed = run.status === 'Failed'
  return <section className={cn('manual-run-status', active && 'is-active', failed && 'is-failed')} aria-live="polite">
    <span>{active ? <LoaderCircle className="spin" size={14} /> : failed ? <span className="e e14" aria-hidden="true">⚠️</span> : <span className="e e14" aria-hidden="true">✅</span>}</span>
    <div><small>Manual run</small><strong>{run.label}</strong><em>{run.phase} · {active ? `${run.progress || 0}%` : runTimestamp(run)}</em></div>
    {active && <i><b style={{ width: `${run.progress || 0}%` }} /></i>}
    {active && run.jobId ? <button className="button button-quiet button-small" onClick={() => onCancelJob(lead, run.jobId)}><span className="e" aria-hidden="true">🚫</span>Cancel</button> : null}
    {failed && <button className="button button-secondary button-small" onClick={() => onRun(lead, run.action)}><span className="e" aria-hidden="true">🔄</span>Retry</button>}
  </section>
}

// Separate duplicate-comparison view: side-by-side records with an explicit
// return path, so comparing never strands the user on the wrong record.
function CompareRecords({ lead, other, onReturn, onOpen }) {
  const card = (item, current) => (
    <article key={item.id} className={cn('ws-compare-card', current && 'is-current')}>
      <span className="detail-label">{current ? 'Current record' : 'Duplicate record'}</span>
      <h3>{item.company}</h3>
      <p>{item.category} · {item.location}</p>
      <dl>
        <div><dt>Research</dt><dd>{getResearchLabel(item)}</dd></div>
        <div><dt>Score</dt><dd>{item.opportunityScore ?? '—'}{item.confidence != null ? ` · ${item.confidence}%` : ''}</dd></div>
        <div><dt>Sales phase</dt><dd>{item.salesStage || 'Not in pipeline'}</dd></div>
        <div><dt>Website</dt><dd>{item.website || 'Not collected'}</dd></div>
        <div><dt>Phone</dt><dd>{item.phone || 'Not collected'}</dd></div>
        <div><dt>Email</dt><dd>{item.email || 'Not collected'}</dd></div>
      </dl>
      {current ? null : <button className="button button-secondary button-small" onClick={() => onOpen(item)}>Open this record <ArrowRight size={11} /></button>}
    </article>
  )
  return <div className="ws-compare">
    <div className="ws-compare-head"><div><span className="detail-label">Compare records</span><h2>Possible duplicates</h2><p className="lead-summary">These records share a business name. Open one to keep working it — closing exits the record entirely.</p></div><button className="button button-secondary button-small" onClick={onReturn}><ArrowLeft size={12} />Return to {lead.company}</button></div>
    <div className="ws-compare-grid">{card(lead, true)}{card(other, false)}</div>
  </div>
}

// Evidence-review half of the old brief tab: readiness plus accept/reject
// reviews. Follow-ups, suppression, and attempts live under Activity.
function ResearchReviews({ lead, onReview, onBriefExport, onProspectBrief, onToast, fetchBrief }) {
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    fetchBrief(lead.id).then((result) => { if (live) { setBrief(result); setLoading(false) } })
    return () => { live = false }
  }, [lead.id, lead.rev, lead.findingReviews, lead.currentAuditId, lead.qualified, lead.doNotContact, lead.salesStage])
  if (loading || !brief) return <p className="lead-summary">Loading evidence reviews…</p>
  const { readiness, reviews } = brief
  const copyBrief = async () => {
    const markdown = await onBriefExport(lead.id)
    if (!markdown) return
    try { await navigator.clipboard.writeText(markdown); onToast('Brief copied — reviewed findings only') }
    catch { onToast({ message: 'Could not copy the brief', tone: 'error' }) }
  }
  const copyOnePager = async () => {
    const markdown = await onProspectBrief(lead.id)
    if (!markdown) return
    try { await navigator.clipboard.writeText(markdown); onToast('One-pager copied — snapshot, nothing sent') }
    catch { onToast({ message: 'Could not copy the one-pager', tone: 'error' }) }
  }
  const downloadOnePager = async () => {
    const markdown = await onProspectBrief(lead.id)
    if (!markdown) return
    downloadText(`${String(lead.company || 'prospect').replace(/[^a-z0-9]+/gi, '-').slice(0, 60) || 'prospect'}-opportunity.md`, markdown, 'text/markdown')
    onToast('One-pager downloaded — snapshot, nothing sent')
  }
  // Recommended opportunity: customer-task impact first, presented with the
  // evidence it stands on. Rejecting one finding never rejects the business.
  const candidates = reviews.pending.length ? reviews.pending : reviews.accepted
  const recommended = rankFindingsForOutreach(candidates)[0] || null
  const recommendedFinding = recommended ? (recommended.finding || { detail: recommended.findingKey, evidence: null }) : null
  const opportunity = recommendedFinding ? describeOpportunity(recommendedFinding, lead) : null
  return <>
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Outreach readiness</span><Badge tone={readiness.ready ? 'green' : 'amber'} dot>{readiness.ready ? 'Ready' : 'Not ready'}</Badge></div>
      {readiness.blocks.length ? <div className="problem-list">{readiness.blocks.map((block) => <div key={block.code}><span><span className="e e13" aria-hidden="true">⚠️</span></span><p>{block.message}</p></div>)}</div> : <p className="lead-summary">Qualified, reviewed, reachable and unsuppressed.</p>}
      {readiness.warnings.length ? <p className="lead-summary">{readiness.warnings.map((w) => w.message).join(' ')}</p> : null}
      <p className="lead-summary">Channel: {readiness.channels.map((c) => (c.kind === 'email' || c.kind === 'phone' ? `${c.kind}: ${c.value}` : c.value)).join('; ') || 'none identified'}{readiness.unknowns.length ? ` · Unknown: ${readiness.unknowns.join(', ')}` : ''}</p>
    </section>
    {opportunity && <section className="detail-section"><div className="detail-heading"><span className="detail-label">Recommended opportunity</span><Badge tone="purple">{reviews.pending.length ? 'Needs review' : 'Accepted'}</Badge></div>
      <p className="lead-summary"><strong>Observation:</strong> {opportunity.observation}</p>
      <p className="lead-summary"><strong>Evidence:</strong> {opportunity.evidence.excerpt || 'Finding text on record'}{opportunity.evidence.source ? ` · ${opportunity.evidence.source}` : ''}{opportunity.evidence.date ? ` · observed ${String(opportunity.evidence.date).slice(0, 10)}` : ''}</p>
      <p className="lead-summary"><strong>{opportunity.relevance}</strong></p>
      <p className="lead-summary"><strong>Proposed improvement:</strong> {opportunity.improvement}</p>
      {opportunity.limitations.length ? <p className="lead-summary"><strong>Limitations:</strong> {opportunity.limitations.join(' ')}</p> : null}
      <p className="lead-summary">Approach rationale: {opportunity.observation} {opportunity.improvement}</p>
    </section>}
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Finding reviews</span><Badge tone="gray">{reviews.accepted.length} accepted · {reviews.pending.length} pending</Badge></div>
      <div className="finding-list">{reviews.pending.map((item) => <FindingReviewRow key={item.key} item={item} onReview={(review) => onReview(lead.id, review)} />)}</div>
      {reviews.accepted.map((item) => <FindingReviewRow key={item.findingKey} item={item} review={item} onReview={(review) => onReview(lead.id, review)} />)}
      {reviews.rejected.map((item) => <FindingReviewRow key={item.findingKey} item={item} review={item} onReview={(review) => onReview(lead.id, review)} />)}
      {reviews.stale.map((item) => <FindingReviewRow key={`${item.findingKey}-${item.at}`} item={item} stale onReview={() => null} />)}
    </section>
    <section className="detail-section"><span className="detail-label">Client-facing brief</span><p className="lead-summary">Reviewed findings only. Scores and commercial estimates are always omitted.</p><div className="outreach-actions"><button className="button button-primary button-small" onClick={copyBrief} disabled={!reviews.accepted.length}><span className="e" aria-hidden="true">📋</span>Copy brief</button><button className="button button-secondary button-small" onClick={copyOnePager} disabled={!reviews.accepted.length}><span className="e" aria-hidden="true">📄</span>Copy one-pager</button><button className="button button-quiet button-small" onClick={downloadOnePager} disabled={!reviews.accepted.length}><span className="e" aria-hidden="true">⬇️</span>Download</button></div><p className="lead-summary">The one-pager is a dated snapshot with provenance. Exporting never sends or publishes it.</p></section>
  </>
}

// Activity half of the old brief tab, plus notes: every manual follow-up,
// suppression, attempt, and note in one timeline-adjacent place.
function attemptIcon(attempt) {
  const channel = String(attempt.channel || '').toLowerCase()
  if (channel.includes('mail')) return '✉️'
  if (channel.includes('phone') || channel.includes('call')) return '📞'
  if (channel.includes('visit') || channel.includes('meet')) return '🤝'
  return '💬'
}

function ContactRoutes({ lead, onAddContact }) {
  const [kind, setKind] = useState('email')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const candidates = Array.isArray(lead.contactCandidates) ? lead.contactCandidates : []
  const save = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    const saved = await onAddContact(lead.id, { kind, value: value.trim() })
    setBusy(false)
    if (saved) setValue('')
  }
  return <div className="business-card"><span className="detail-label">Contact routes</span>
    {candidates.length ? <ul className="ws-finding-titles">{candidates.map((cand) => <li key={cand.id || `${cand.kind}-${cand.value}`} title={`Source: ${cand.sourceUrl || cand.source || 'unknown'} · observed ${cand.observedAt ? String(cand.observedAt).slice(0, 10) : 'unknown'} · ${cand.verification || 'observed'}`}><strong>{cand.kind}</strong>: {cand.value} <small>· {cand.source === 'manual' ? 'entered manually' : `observed on website${cand.observedAt ? ` ${String(cand.observedAt).slice(0, 10)}` : ''}`}</small></li>)}</ul> : <p className="lead-summary">No sourced routes yet — the next audit collects them, or add one below.</p>}
    <div className="task-editor"><label><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value)}>{['email', 'phone', 'form', 'contactPage', 'booking'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Value</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={kind === 'email' ? 'hello@example.com' : kind === 'phone' ? '(801) 555-0100' : 'https://…'} /></label></div>
    <div><button className="button button-secondary button-small" disabled={!value.trim() || busy} onClick={save}>{busy ? 'Saving…' : 'Add contact'}</button></div>
    <p className="lead-summary">Manual entries survive re-audits. “Observed on website” is not verified ownership.</p>
  </div>
}

function ActivityPanel({ lead, history, noteDraft, setNoteDraft, editing, setEditing, onUpdate, onAddContact }) {
  const [rationale, setRationale] = useState(lead.briefRationale?.text || '')
  const [taskType, setTaskType] = useState(lead.nextTask?.type || 'follow-up')
  const [taskDue, setTaskDue] = useState(lead.nextTask?.dueAt || '')
  const [taskOwner, setTaskOwner] = useState(lead.nextTask?.owner || '')
  const [taskNote, setTaskNote] = useState(lead.nextTask?.note || '')
  const [suppressReason, setSuppressReason] = useState('')
  const [suppressScope, setSuppressScope] = useState('business')
  useEffect(() => { setRationale(lead.briefRationale?.text || '') }, [lead.id, lead.briefRationale?.at])
  const attempts = lead.contactAttempts || []
  const events = []
  attempts.forEach((attempt) => { if (attempt.at) events.push({ at: attempt.at, icon: attemptIcon(attempt), title: attempt.outcome || 'Contact attempt', detail: [attempt.channel, attempt.contact, attempt.notes].filter(Boolean).join(' · ') || null }) })
  history.forEach((item) => { if (item.at) events.push({ at: item.at, icon: '🗄️', title: item.relationship === 'new' ? 'New client' : 'Matched client', detail: null }) })
  if (lead.doNotContact?.status && lead.doNotContact.at) events.push({ at: lead.doNotContact.at, icon: '🚫', title: 'Contact suppressed', detail: lead.doNotContact.reason || null })
  if (lead.briefRationale?.text && lead.briefRationale.at) events.push({ at: lead.briefRationale.at, icon: '📝', title: 'Rationale saved', detail: null })
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return <div className="ws-cols"><div className="ws-main">
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">History</span><Badge tone="gray">{events.length}</Badge></div>
      {events.length ? <ol className="ws-timeline">{events.map((event, position) => <li key={`${event.at}-${position}`}><span className="e e14" aria-hidden="true">{event.icon}</span><div><strong>{event.title}</strong>{event.detail && <p>{event.detail}</p>}<small>{new Date(event.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}, {new Date(event.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</small></div></li>)}</ol> : <p className="lead-summary">No activity recorded yet. Outreach attempts, research runs, and follow-ups will appear here.</p>}
    </section>
    <section className="detail-section"><span className="detail-label">Add note</span><div className="notes-card ws-note-card">{editing ? <><textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} /><div className="note-actions"><button onClick={() => setEditing(false)}>Cancel</button><button onClick={async () => { const saved = await onUpdate(lead.id, { notes: noteDraft.trim() }); if (saved) setEditing(false) }}><Check size={11} />Save</button></div></> : <><p>{lead.notes || 'No notes yet.'}</p><button onClick={() => setEditing(true)}><span className="e" aria-hidden="true">📝</span>{lead.notes ? 'Edit note' : 'Add note'}</button></>}</div></section>
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Schedule follow-up</span>{lead.nextTask?.status === 'open' && <Badge tone="orange" dot>{lead.nextTask.dueAt || 'no date'}</Badge>}</div>
      <div className="task-editor"><label><span>Type</span><select value={taskType} onChange={(event) => setTaskType(event.target.value)}>{NEXT_TASK_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Due</span><input type="date" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} /></label><label><span>Owner</span><select value={taskOwner} onChange={(event) => setTaskOwner(event.target.value)}><option value="">Unassigned</option>{TASK_OWNERS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Note</span><input value={taskNote} onChange={(event) => setTaskNote(event.target.value)} placeholder="Optional" /></label></div>
      <div><button className="button button-secondary button-small" onClick={() => onUpdate(lead.id, { nextTask: { type: taskType, dueAt: taskDue || null, status: 'open', owner: taskOwner, note: taskNote } })}>Save follow-up</button>{lead.nextTask?.status === 'open' && <button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { nextTask: { ...lead.nextTask, status: 'cleared' } })}>Clear</button>}</div>
    </section>
    <section className="detail-section"><span className="detail-label">Manual rationale</span>
      <p className="lead-summary">Human judgment the software cannot see — labelled manual, kept across refreshes.</p>
      <textarea className="ws-textarea" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Human judgment the software cannot see — labelled manual, kept across refresh." />
      <div><button className="button button-secondary button-small" disabled={!rationale.trim()} onClick={() => onUpdate(lead.id, { briefRationale: { text: rationale.trim(), by: 'Rohan' } })}>Save rationale</button>{lead.briefRationale?.text && <small> Saved {lead.briefRationale.at ? new Date(lead.briefRationale.at).toLocaleString() : ''} · manual, retained across refresh.</small>}</div>
    </section>
  </div><aside>
    <ContactRoutes lead={lead} onAddContact={onAddContact} />
    <div className="business-card"><span className="detail-label">Contact restrictions</span><div className="ws-restrict-head">{lead.doNotContact?.status ? <Badge tone="red">Suppressed</Badge> : <Badge tone="gray">Not suppressed</Badge>}</div>
      {lead.doNotContact?.status
        ? <><p className="lead-summary">{lead.doNotContact.reason}{lead.doNotContact.at ? ` · since ${new Date(lead.doNotContact.at).toLocaleDateString()}` : ''} · survives reimport, refresh and merges.</p><button className="button button-secondary button-small" onClick={() => onUpdate(lead.id, { doNotContact: { status: false, reason: '' } })}>Reopen explicitly</button></>
        : <><div className="task-editor ws-restrict-form"><label><span>Reason (required)</span><input value={suppressReason} onChange={(event) => setSuppressReason(event.target.value)} placeholder="e.g. Asked to stop calling" /></label><label><span>Scope</span><select value={suppressScope} onChange={(event) => setSuppressScope(event.target.value)}><option value="business">Business</option><option value="contact">Contact</option></select></label></div><button className="button button-secondary button-small" disabled={!suppressReason.trim()} onClick={() => onUpdate(lead.id, { doNotContact: { status: true, reason: suppressReason.trim(), scope: suppressScope } })}>Suppress contact</button></>}
    </div>
  </aside></div>
}

const WORKSPACE_TABS = ['Overview', 'Research', 'Outreach', 'Activity']

function LeadDrawer({ lead, runs, leads = [], queue = null, origin = 'Clients', siblings = [], onSelect, close, onExport, onUpdate, onAddContact, onQualify, onAnalyze, onMuseAnalyze, onRunAction, onReview, fetchBrief, onBriefExport, onProspectBrief, onCancelJob, onRetryJob, brightDataReady, onToast, onContract, onInsight, onFailure, onOutreach }) {
  const [tab, setTab] = useState('Overview')
  const [compareId, setCompareId] = useState(null)
  const [stuck, setStuck] = useState(false)
  const identityRef = useRef(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const drawerRef = useRef(null)
  const closeRef = useRef(null)
  const previouslyFocused = useRef(null)
  useEffect(() => { setTab('Overview'); setCompareId(null); setEditing(false); setNoteDraft(lead?.notes || '') }, [lead?.id])
  // Newly selected tabs start at their content heading. The workspace
  // overlay owns the scroll position; the list underneath keeps its own.
  useEffect(() => { drawerRef.current?.closest('.workspace-overlay')?.scrollTo({ top: 0 }) }, [tab])
  // Once the identity header scrolls away, a slim strip keeps the company
  // name, stage, and action pinned alongside the tabs.
  useEffect(() => {
    setStuck(false)
    const overlay = drawerRef.current?.closest('.workspace-overlay')
    const target = identityRef.current
    if (!overlay || !target) return undefined
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), { root: overlay, threshold: 0 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [lead?.id, compareId])
  // Accessible dialog: focus entry + restoration and background scroll lock.
  useEffect(() => {
    if (!lead) return undefined
    previouslyFocused.current = document.activeElement
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = original
      if (previouslyFocused.current?.focus) previouslyFocused.current.focus()
    }
  }, [lead?.id])
  const trapTab = (event) => {
    if (event.key !== 'Tab' || !drawerRef.current) return
    const items = drawerRef.current.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  if (!lead) return null
  const { done, failure } = researchState(lead)
  const runningJob = activeLeadJob(lead)
  const failedJob = failedLeadJob(lead)
  const resumableJob = failedJob && leadJobRetryable(lead, failedJob) ? failedJob : null
  const pitch = outreachBody(lead)
  const currentSalesIndex = pipelineStages.indexOf(lead.salesStage)
  const runOrigin = leadRunInfo(lead, runs)
  const originLabel = runOrigin.collectionRun ? `Added in ${runLabel(runOrigin.collectionRun)}` : lead.labels?.includes('CSV import') ? 'Manual import' : 'Existing client'
  const backLabel = origin === 'Research' ? 'Back to Research' : origin === 'Review' ? 'Back to review' : 'Back to Clients'
  // Prev/next follows the list the record was opened from so reviewing
  // multiple records never needs the list. Deep links without a queue fall
  // back to commercial-rank order. Replacement keeps Close exiting in one
  // step, which preserves the entry list position.
  const queueOrder = Array.isArray(queue) && queue.length ? queue.map((id) => leads.find((item) => item.id === id)).filter(Boolean) : [...leads].sort((a, b) => leadRankValue(b) - leadRankValue(a))
  const queueIndex = queueOrder.findIndex((item) => item.id === lead.id)
  const queueAt = queueIndex === -1 ? 0 : queueIndex
  const prevLead = queueOrder.length > 1 ? queueOrder[(queueAt - 1 + queueOrder.length) % queueOrder.length] : null
  const nextLead = queueOrder.length > 1 ? queueOrder[(queueAt + 1) % queueOrder.length] : null
  const needsReview = done[1] && !failure && !isQualifiedLead(lead)
  const findings = lead.problems?.length ? lead.problems : []
  const attempts = lead.contactAttempts || []
  const freshness = lead.lastSuccessfulAudit?.at ? `Audited ${auditAge(lead.lastSuccessfulAudit.at)}` : researchState(lead).analyzed ? 'Audited · date unknown' : 'Not audited yet'
  const history = Array.isArray(lead.runHistory) ? [...lead.runHistory].sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime()).slice(0, 5) : []
  // One contextual primary action, shared by the header and the Overview
  // next-step panel so the record never offers competing primaries.
  const primaryAction = runningJob
    ? { label: 'Cancel job', emoji: '🚫', kind: 'secondary', run: () => onCancelJob(lead, runningJob.id) }
    : failure && resumableJob
      ? { label: 'Resume job', emoji: '🔄', kind: 'primary', run: () => onRetryJob(lead, resumableJob.id) }
      : failure
        ? { label: 'Retry audit', emoji: '🔄', kind: 'primary', run: () => onAnalyze(lead) }
        : needsReview
          ? { label: 'Qualify for outreach', emoji: '✅', kind: 'primary', run: () => onQualify(lead) }
          : isQualifiedLead(lead)
            ? { label: 'Open outreach', emoji: '✉️', kind: 'primary', run: onOutreach }
            : !done[1] && lead.website
              ? { label: 'Analyze website', emoji: '✨', kind: 'primary', run: () => onAnalyze(lead) }
              : null
  const compareLead = compareId ? siblings.find((item) => item.id === compareId) || null : null
  const stageChip = failure ? ['Needs attention', 'red'] : isQualifiedLead(lead) ? [lead.salesStage || 'Qualified', statusTone[lead.salesStage] || 'purple'] : researchState(lead).museComplete ? ['Ready to review', 'green'] : researchState(lead).analyzed ? ['Audited', 'blue'] : researchState(lead).processing ? ['Research running', 'orange'] : ['Collected', 'gray']
  const guidance = getMuseGuidance(lead)
  const limitation = failure ? `Collection issue. ${failure.reason}` : lead.researchStatus === 'Inconclusive' ? (lead.captureQuality?.reason || lead.lastAuditAttempt?.reason || 'The latest capture was inconclusive.') : lead.museAnalysis?.stale ? 'AI synthesis predates the latest audit.' : lead.measureProvenance?.performance?.source === 'html_heuristic' ? 'Performance is an HTML estimate rather than a Lighthouse measurement.' : !done[1] ? 'No website audit yet. Based on the business profile only.' : null
  return (
    <div className="workspace-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()} onKeyDown={trapTab}>
      <div ref={drawerRef} className={cn('client-workspace', stuck && 'is-stuck')} role="dialog" aria-modal="true" aria-label={`${lead.company} record`}>
        <div className="ws-context">
          <button className="ws-back" onClick={close}><ArrowLeft size={13} />{backLabel}</button>
          <div className="ws-context-right">
            {queueOrder.length > 1 && <span className="ws-position" aria-live="polite">{queueAt + 1} of {queueOrder.length}</span>}
            <div className="ws-pager">
              <button className="ws-page-btn" aria-label={prevLead ? `Previous client: ${prevLead.company}` : 'No previous client'} disabled={!prevLead} onClick={() => prevLead && onSelect(prevLead, { replace: true })}><ArrowLeft size={13} /></button>
              <button className="ws-page-btn" aria-label={nextLead ? `Next client: ${nextLead.company}` : 'No next client'} disabled={!nextLead} onClick={() => nextLead && onSelect(nextLead, { replace: true })}><ArrowRight size={13} /></button>
            </div>
            <ClientRunMenu lead={lead} onRun={onRunAction} brightDataReady={brightDataReady} />
            <IconButton label={websiteUrl(lead.website) ? `Open ${lead.company} website` : 'No website saved'} disabled={!websiteUrl(lead.website)} onClick={() => window.open(websiteUrl(lead.website), '_blank', 'noopener,noreferrer')}><span className="e e14" aria-hidden="true">↗️</span></IconButton>
            <IconButton ref={closeRef} label="Close client record" onClick={close}><X size={16} /></IconButton>
          </div>
        </div>
        {compareLead ? <CompareRecords lead={lead} other={compareLead} onReturn={() => setCompareId(null)} onOpen={(item) => { setCompareId(null); onSelect(item, { replace: true }) }} />
        : <>
        <header ref={identityRef} className="ws-identity">
          <div className="ws-identity-main">
            <div className="ws-eyebrow"><Badge tone={categoryTone[lead.category] || 'gray'}>{lead.category}</Badge><Badge tone={stageChip[1]} dot>{stageChip[0]}</Badge><StarToggle lead={lead} onToggle={(item) => onUpdate(item.id, { starred: !item.starred })} /></div>
            <h1 title={lead.company}>{lead.company}</h1>
            <p className="ws-sub">{lead.location}{websiteUrl(lead.website) ? <span> · <a href={websiteUrl(lead.website)} target="_blank" rel="noreferrer">Open website <span className="e e10" aria-hidden="true">↗️</span></a></span> : ' · No website'} · {freshness}</p>
            <details className="ws-record-details"><summary>Record details<ChevronDown size={12} /></summary>
              <dl className="ws-record-grid">
                <div><dt>Address</dt><dd>{lead.address || lead.location || 'Not collected'}</dd></div>
                <div><dt>Phone</dt><dd>{lead.phone || 'Not collected'}</dd></div>
                <div><dt>Email</dt><dd>{lead.email || 'Not collected'}</dd></div>
                <div><dt>Rating</dt><dd>{lead.rating ? `${lead.rating} ★ · ${lead.reviews || 0} reviews` : 'Unknown'}</dd></div>
                <div><dt>Source</dt><dd>{originLabel}</dd></div>
                <div><dt>Sales phase</dt><dd>{lead.salesStage || 'Not in pipeline'}</dd></div>
                <div><dt>Record ID</dt><dd>{lead.id}</dd></div>
              </dl>
            </details>
          </div>
          <div className="ws-identity-side">
            <div className="ws-score"><Score value={lead.opportunityScore} size="large" /><span>Opportunity<small>{lead.confidence != null ? `${lead.confidence}% confidence` : 'Not analyzed'}</small></span></div>
            {primaryAction && <button tabIndex={stuck ? -1 : undefined} className={cn('button', primaryAction.kind === 'primary' ? 'button-primary' : 'button-secondary')} onClick={primaryAction.run}><span className="e" aria-hidden="true">{primaryAction.emoji}</span>{primaryAction.label}</button>}
          </div>
        </header>
        <div className="ws-tabs" role="tablist" aria-label="Client record views" onKeyDown={(event) => {
          const current = WORKSPACE_TABS.indexOf(tab)
          let next = null
          if (event.key === 'ArrowRight') next = (current + 1) % WORKSPACE_TABS.length
          else if (event.key === 'ArrowLeft') next = (current - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = WORKSPACE_TABS.length - 1
          if (next === null) return
          event.preventDefault()
          setTab(WORKSPACE_TABS[next])
          event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus()
        }}>{WORKSPACE_TABS.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}{item === 'Research' && findings.length > 0 && <em>{findings.length}</em>}{item === 'Activity' && attempts.length > 0 && <em>{attempts.length}</em>}</button>)}<div className="ws-stuck"><strong title={lead.company}>{lead.company}</strong><Badge tone={stageChip[1]} dot>{stageChip[0]}</Badge>{primaryAction && <button className="button button-primary button-small" onClick={primaryAction.run}><span className="e" aria-hidden="true">{primaryAction.emoji}</span>{primaryAction.label}</button>}</div></div>
        <div className="ws-body">
          {tab === 'Overview' && <div className="ws-cols"><div className="ws-main"><section className="ws-next" aria-label="Next action"><span className="detail-label">Next action</span><strong>{getNextAction(lead)}</strong>{primaryAction ? <div className="ws-next-row"><button className="button button-secondary" onClick={primaryAction.run}><span className="e" aria-hidden="true">{primaryAction.emoji}</span>{primaryAction.label}</button><button className="button button-quiet" onClick={() => onExport(lead)}><span className="e" aria-hidden="true">📤</span>Export research packet</button></div> : <p className="lead-summary">Add a website to enable the audit; the business can still be qualified on its profile.</p>}{needsReview && <small>Qualifying moves this client to outreach. Staying here keeps it queued. That is the defer path.</small>}</section>{failure && <div className="candidate-banner" role="alert"><span><strong>Collection issue, not a verdict.</strong><small> {failure.reason} Saved evidence below is kept; fix the failure before treating the recommendation as final.</small></span></div>}<section className="detail-section"><span className="detail-label">Main opportunity</span>{lead.mainIssue ? <><h2>{lead.mainIssue}</h2><p className="lead-summary">{lead.issueDetail}</p></> : <><h2>Not assessed yet</h2><p className="lead-summary">No website audit has run for this business, so there is no evidence to summarize yet — this does not mean there is no opportunity.</p>{lead.website ? <p className="lead-summary">Run the website audit to produce findings.</p> : <p className="lead-summary">Add a website to enable the audit; the business can still be qualified on its profile.</p>}</>}</section><section className="detail-section"><div className="detail-heading"><span className="detail-label">Findings</span>{findings.length > 0 && <Badge tone="gray">{findings.length}</Badge>}</div>{findings.length ? <><ul className="ws-finding-titles">{findings.slice(0, 3).map((problem) => <li key={problem}>{problem}</li>)}</ul>{findings.length > 3 && <p className="lead-summary">Showing 3 of {findings.length}.</p>}<button className="button button-quiet button-small" onClick={() => setTab('Research')}>View all findings in Research <ArrowRight size={11} /></button></> : <p className="lead-summary">Website analysis has not been completed yet.</p>}</section></div><aside>{siblings.length ? <div className="dup-card"><span className="detail-label">Possible duplicates</span><p>{siblings.length + 1} records share this business name — open a side-by-side comparison before acting.</p><div>{siblings.map((sibling) => <button key={sibling.id} type="button" onClick={() => setCompareId(sibling.id)} title={`Compare with ${sibling.company}`}><Avatar name={sibling.company} size="small" /><span><strong>{sibling.company}</strong><small>{sibling.category} · {sibling.location} · {getResearchLabel(sibling)}</small></span></button>)}</div>{lead.duplicateReviewed ? <p className="lead-summary">Reviewed — outreach readiness no longer waits on duplicates.</p> : <button className="button button-secondary button-small" onClick={() => onUpdate(lead.id, { duplicateReviewed: true })}>Mark reviewed — distinct records</button>}</div> : null}<div className="business-card"><span className="detail-label">Client profile</span><div><span>Rating</span><strong>{lead.rating} ★ · {lead.reviews} reviews</strong></div><div><span>Phone</span><strong>{lead.phone}</strong></div><div><span>Email</span><strong>{lead.email}</strong></div><div><span>Sales phase</span><strong>{lead.salesStage || 'Not in pipeline'}</strong></div></div><div className="ws-activity-teaser"><span className="detail-label">Follow-up</span><p>{lead.nextTask?.status === 'open' ? `${lead.nextTask.type} · ${lead.nextTask.dueAt || 'no date'}` : 'No open follow-up.'}{attempts.length ? ` · ${attempts.length} recorded attempt${attempts.length === 1 ? '' : 's'}` : ''}</p><button className="button button-quiet button-small" onClick={() => setTab('Activity')}>Open activity <ArrowRight size={11} /></button></div></aside></div>}
          {tab === 'Research' && <div className="research-detail">
            <section className="ws-reco" aria-label="Recommendation"><div className="ws-reco-verdict"><span className="detail-label">Recommendation</span><strong className={cn('ws-guidance', guidance === 'Pursue' && 'is-pursue', guidance === 'Pass' && 'is-pass')}>{guidance || 'Not run'}</strong></div><p className="ws-reco-reason">{lead.museAnalysis?.qualificationRationale || lead.museAnalysis?.summary || lead.issueDetail || 'No recommendation recorded yet.'}</p><p className="ws-score-line">{lead.confidence != null ? `${lead.confidence}% confidence` : 'Confidence not recorded'}{lead.leadValue ? ` · commercial value ${lead.leadValue.leadValueScore}/100 (${lead.leadValue.band})` : ''}</p>{limitation && <p className="ws-limitation"><span className="e e11" aria-hidden="true">⚠️</span><span>{limitation}</span></p>}</section>
            <div className="research-detail-head">
              <div><span className="detail-label">{failure ? 'Failed stage' : 'Research state'}</span><h2 className={failure ? 'failure-title' : ''}>{getResearchLabel(lead)}</h2><p>{failure?.reason || (isQualifiedLead(lead) ? 'Research is complete. Sales progress is tracked separately.' : 'Review the evidence and AI guidance before deciding whether to qualify this client.')}</p></div>
              {failure ? <>
                {runningJob ? <button className="button button-secondary" onClick={() => onCancelJob(lead, runningJob.id)}><span className="e" aria-hidden="true">🚫</span>Cancel job</button> : null}
                {!runningJob && resumableJob ? <button className="button button-secondary" onClick={() => onRetryJob(lead, resumableJob.id)}><span className="e" aria-hidden="true">🔄</span>Resume job</button> : null}
                <button className={resumableJob ? 'button button-secondary' : 'button button-secondary retry-button'} onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">🔄</span>{resumableJob ? 'Fresh audit' : failure.retryable === false ? 'Start a fresh run' : 'Retry audit'}</button>
                {done[1] && !isQualifiedLead(lead) ? <button className="button button-quiet" onClick={() => onQualify(lead)} title="The saved evidence from the earlier attempt is kept"><span className="e" aria-hidden="true">✅</span>Qualify with saved evidence</button> : null}
              </>
                : runningJob ? <><button className="button button-primary" disabled><LoaderCircle className="spin" size={13} />{runningJob.phase || runningJob.status}</button><button className="button button-secondary" onClick={() => onCancelJob(lead, runningJob.id)}><span className="e" aria-hidden="true">🚫</span>Cancel job</button></>
                  : !done[1] ? (lead.website
                    ? <button className="button button-secondary" onClick={() => onAnalyze(lead)}><span className="e" aria-hidden="true">✨</span>Analyze website</button>
                    : <span className="lead-summary">No website supplied — the audit needs one. This business can still be scored, qualified and moved through sales; add a website to enable the audit.</span>)
                    : !isQualifiedLead(lead) ? <button className="button button-secondary" onClick={() => onQualify(lead)}><span className="e" aria-hidden="true">✅</span>Qualify for outreach</button>
                      : <Badge tone="purple" dot>In sales</Badge>}
            </div>
            <ManualRunStatus lead={lead} onRun={onRunAction} onCancelJob={onCancelJob} />
            {lead.researchStatus === 'Inconclusive' && <div className="candidate-banner"><span><strong>Latest capture inconclusive — no score claimed.</strong><small> {lead.captureQuality?.reason || lead.lastAuditAttempt?.reason || 'The page could not be assessed.'} Method: {lead.captureQuality?.captureMethod || 'static-fetch'}{lead.captureQuality?.renderedFallback ? ` · rendered fallback: ${lead.captureQuality.renderedFallback}` : ''}{lead.lastSuccessfulAudit ? ` · Last successful audit ${lead.lastSuccessfulAudit.score}/100 (${auditAge(lead.lastSuccessfulAudit.at)}).` : ' · No successful audit yet.'} The business stays available for manual qualification.</small></span><div><button className="button button-secondary button-small" onClick={() => onAnalyze(lead)}>Retry audit</button></div></div>}
            <div className="research-checklist">{researchLabels.map((label, index) => {
              const failed = failure?.stage === index
              const detail = failed ? failure.reason
                : index === 0 ? `${lead.company} and contact data saved`
                    : index === 1 ? done[index] ? `${lead.opportunityScore}/100 score · ${lead.confidence || '—'}% confidence · ${lead.evidence?.length || 0} evidence points` : 'Website evidence and opportunity scoring are not complete'
                    : done[index] ? lead.museAnalysis?.status === 'Completed' ? `Guidance saved for your decision` : 'Evidence is ready for your decision' : 'Waiting for a completed analysis'
              return <article key={label} className={cn(done[index] && 'complete', failed && 'failed')}><span>{failed ? <X size={13} /> : done[index] ? <Check size={13} /> : index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div></article>
            })}</div>
            <LeadValueCard lead={lead} />
            <div className="detail-section"><div className="detail-heading"><span className="detail-label">Findings and evidence</span><Badge tone="gray">{findings.length === 1 ? '1 finding' : `${findings.length} findings`} · {(lead.evidence?.length || 0) === 1 ? '1 evidence point' : `${lead.evidence?.length || 0} evidence points`}</Badge></div>
              {findings.length ? <div className="ws-findings">{findings.map((problem, position) => { const advice = findingAdvice(problem); return <article key={`${position}-${problem}`}><span className="ws-finding-num">{position + 1}</span><div><strong>{problem}</strong><p><b>Why it matters:</b> {advice.why}</p><p><b>Suggested direction:</b> {advice.change}</p></div></article> })}</div> : <p className="lead-summary">Website analysis has not been completed yet — the recommendation above is the current state.</p>}
              {(lead.evidence || []).length > 0 && <details className="ws-record-details ws-evidence"><summary>Saved evidence ({lead.evidence.length})<ChevronDown size={12} /></summary><ul className="ws-evidence-list">{lead.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details>}
            </div>
            {lead.auditHistory?.length > 0 && <details className="ws-details"><summary>Audit history<ChevronDown size={12} /></summary><div className="audit-history"><span className="detail-label">Audit history</span><ol>{[...lead.auditHistory].reverse().map((item) => <li key={item.auditId || `${item.jobId}-${item.at}`}><strong>{item.auditId === lead.currentAuditId ? 'Current' : item.version != null ? `v${item.version}` : 'legacy'}</strong><small>{item.auditId || 'unversioned'} · {item.at ? new Date(item.at).toLocaleString() : 'unknown date'} · {item.score ?? '—'}/100</small></li>)}</ol></div></details>}{done[1] && <details className="ws-details"><summary>Technical diagnostics<ChevronDown size={12} /></summary><div className="audit-metrics deep-audit-metrics ws-details-metrics"><article><span className="e e15" aria-hidden="true">⚡</span><span>Lighthouse performance</span><strong>{lead.performance ?? '—'}{lead.performance != null && <small>/100</small>}</strong><small>{lead.measureProvenance?.performance?.source === 'lighthouse' ? 'Measured on mobile' : lead.measureProvenance?.performance?.source === 'html_heuristic' ? 'HTML estimate — not measured' : lead.measureProvenance?.performance?.status === 'legacy' ? 'Unknown source (legacy value)' : lead.lighthouse?.status === 'Completed' ? 'Measured on mobile' : lead.lighthouse?.status || (lead.performance != null ? 'Unknown source (legacy value)' : 'Not measured')}</small><i className={lead.performance == null ? '' : lead.performance >= 75 ? 'good' : lead.performance >= 50 ? 'fair' : 'bad'} /></article><article><span className="e e15" aria-hidden="true">🌐</span><span>Pages crawled</span><strong>{lead.pageCount ?? '—'}</strong><small>{lead.auditComponents?.crawl?.stoppedBy && lead.auditComponents.crawl.stoppedBy !== 'page-limit' ? `Stopped: ${{ 'attempt-limit': 'attempt limit', 'time-limit': 'time limit', 'byte-limit': 'size limit', 'queue-limit': 'queue limit', cancelled: 'cancelled' }[lead.auditComponents.crawl.stoppedBy] || lead.auditComponents.crawl.stoppedBy}` : `of ${lead.auditComponents?.crawl?.pageLimit || 10} maximum`}</small><i className={lead.pageCount > 1 ? 'good' : 'fair'} /></article><article><span className="e e15" aria-hidden="true">🔗</span><span>Links checked</span><strong>{lead.checkedLinks ?? '—'}</strong><small>Same-site destinations</small><i className={lead.checkedLinks > 0 ? 'good' : 'fair'} /></article><article><span className="e e15" aria-hidden="true">⚠️</span><span>Broken links</span><strong>{lead.brokenLinks ?? '—'}</strong><small>{lead.linkSummary ? `${lead.linkSummary.confirmedBroken ?? lead.brokenLinks ?? 0} confirmed · ${lead.linkSummary.unverified ?? 0} unverified` : lead.auditStatus || 'Not measured'}</small><i className={lead.brokenLinks == null ? '' : lead.brokenLinks === 0 ? 'good' : lead.brokenLinks <= 2 ? 'fair' : 'bad'} /></article></div></details>}
            {lead.businessIntelligence ? <details className="ws-details"><summary>Business intelligence<ChevronDown size={12} /></summary><BusinessIntelligence lead={lead} /></details> : null}
            <ResearchReviews lead={lead} onReview={onReview} onBriefExport={onBriefExport} onProspectBrief={onProspectBrief} onToast={onToast} fetchBrief={fetchBrief} />
            {done[1] && <MuseSynthesis lead={lead} onAnalyze={onMuseAnalyze} onUpdate={onUpdate} />}
            {history.length === 0 && <p className="lead-summary">No research run recorded.</p>}
            <div className="research-detail-actions"><button className="button button-secondary" onClick={() => onExport(lead)}><span className="e" aria-hidden="true">📤</span>Export research packet</button>{done[1] && <button className="button button-secondary" onClick={() => onInsight(lead)}><span className="e" aria-hidden="true">📄</span>Adjust score</button>}{!failure && <button className="button button-quiet" onClick={() => onFailure(lead)}><span className="e" aria-hidden="true">⚠️</span>Mark stage failed</button>}</div>
          </div>}
          {tab === 'Activity' && <ActivityPanel lead={lead} history={history} noteDraft={noteDraft} setNoteDraft={setNoteDraft} editing={editing} setEditing={setEditing} onUpdate={onUpdate} onAddContact={onAddContact} />}
          {tab === 'Outreach' && <div className="sales-detail"><section className="sales-stage-card"><div className="sales-section-head"><div><span className="detail-label">Sales status</span><h2>{lead.salesStage || 'Not in sales'}</h2></div>{lead.salesStage && <Badge tone={statusTone[lead.salesStage]} dot>{lead.salesStage}</Badge>}</div><div className="next-action-callout"><span>Next action</span><strong>{getNextAction(lead)}</strong></div><div className="sales-stage-path" aria-label="Sales progression">{pipelineStages.map((stage, index) => <button key={stage} className={cn(index < currentSalesIndex && 'is-complete', index === currentSalesIndex && 'is-current')} aria-current={index === currentSalesIndex ? 'step' : undefined} onClick={() => onUpdate(lead.id, { salesStage: stage })}><span>{index < currentSalesIndex ? <Check size={10} /> : index + 1}</span><small>{stage}</small></button>)}</div><button className="button button-quiet button-small close-lost-action" onClick={() => onUpdate(lead.id, { salesStage: 'Lost', lostReason: 'Closed manually' })}><span className="e" aria-hidden="true">⚠️</span>Close as lost</button></section><section className="sales-email-card"><div className="sales-section-head"><div><span className="detail-label">Concise outreach email</span><h2>{pitch.trim() ? outreachSubject(lead) : 'No draft available'}</h2></div>{pitch.trim() ? <small>{pitch.trim().split(/\s+/).length} words</small> : null}</div>{pitch.trim() ? <><p>{pitch}</p><div><button className="button button-secondary button-small" onClick={async () => { try { await navigator.clipboard.writeText(`Subject: ${outreachSubject(lead)}\n\n${pitch}`); onToast('Outreach email copied') } catch { onToast({ message: 'Could not copy the email', tone: 'error' }) } }}><span className="e" aria-hidden="true">📋</span>Copy email</button><button className="button button-quiet button-small" onClick={onOutreach}>Open outreach <ArrowRight size={12} /></button></div></> : <><p className="lead-summary">Outreach drafts are written from verified findings. {lead.website ? 'Run the website audit to produce findings, then generate a draft.' : 'Add a website and run the audit to produce findings.'}</p><div>{primaryAction && <button className="button button-secondary button-small" onClick={primaryAction.run}><span className="e" aria-hidden="true">{primaryAction.emoji}</span>{primaryAction.label}</button>}</div></>}</section>{attempts.length > 0 && <button className="button button-quiet button-small ws-attempts-link" onClick={() => setTab('Activity')}>View {attempts.length} recorded attempt{attempts.length === 1 ? '' : 's'} in Activity <ArrowRight size={11} /></button>}{lead.salesStage === 'Won' && <div className="contract-callout"><span className="e e18" aria-hidden="true">🏆</span><div><strong>{lead.contract ? 'Contract recorded' : 'Add the agreement details'}</strong><p>{lead.contract ? `${currency(lead.contract.amount, lead.contract.currency)} · ${lead.contract.scope || 'Scope not recorded'}` : 'Save the approved amount, scope, terms, and kickoff plan.'}</p></div><button className="button button-primary button-small" onClick={() => onContract(lead)}>{lead.contract ? 'Edit' : 'Add details'}</button></div>}</div>}
        </div>
        </>}
      </div>
    </div>
  )
}

function ContractModal({ lead, close, onSave }) {
  const [draft, setDraft] = useState(() => ({ amount: '', currency: 'USD', scope: '', terms: '', startDate: '', signedOn: '', conditions: '', nextStep: '', ...(lead.contract || {}) }))
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const validation = validateContractDraft(draft)
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const handleField = (key) => (event) => { setDraft((c) => ({ ...c, [key]: event.target.value })); if (fieldErrors[key] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[key]; delete n._general; return n }) }
  const handleBlur = (key) => () => setTouched((p) => ({ ...p, [key]: true }))
  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitted(true)
    setTouched({ amount: true, scope: true, currency: true, signedOn: true, startDate: true })
    const v = validateContractDraft(draft)
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const saved = await onSave(lead.id, { salesStage: 'Won', contract: { ...draft, amount: Number(draft.amount || 0) } }); if (saved) close() } catch (caught) { const mapped = getFieldErrorsFromApiError(caught); if (Object.keys(mapped).length) setFieldErrors(mapped); else setFieldErrors({ _general: caught?.message || 'Could not save contract' }) } finally { setSaving(false) }
  }
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal contract-modal" role="dialog" aria-modal="true" aria-label="Contract details" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><span className="e e17" aria-hidden="true">🏆</span></span><span><strong>Contract details</strong><small>{lead.company}</small></span></div><IconButton label="Close contract" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error field-push">{fieldErrors._general}</div>}<div className="form-pair"><label><span>Approved amount *</span><input autoFocus type="number" min="0" value={draft.amount} onChange={handleField('amount')} onBlur={handleBlur('amount')} placeholder="12000" className={show('amount') ? 'input-error' : undefined} aria-invalid={Boolean(show('amount'))} />{show('amount') && <span className="field-error">{merged.amount}</span>}</label><label><span>Currency</span><select value={draft.currency} onChange={handleField('currency')} onBlur={handleBlur('currency')} className={show('currency') ? 'input-error' : undefined} aria-invalid={Boolean(show('currency'))}><option>USD</option><option>INR</option><option>GBP</option><option>EUR</option></select>{show('currency') && <span className="field-error">{merged.currency}</span>}</label></div><label><span>Approved scope *</span><textarea value={draft.scope} onChange={handleField('scope')} onBlur={handleBlur('scope')} placeholder="What are we delivering?" className={show('scope') ? 'input-error' : undefined} aria-invalid={Boolean(show('scope'))} />{show('scope') && <span className="field-error">{merged.scope}</span>}</label><label><span>Payment terms</span><input value={draft.terms} onChange={handleField('terms')} placeholder="50% at kickoff · 50% at launch" /></label><div className="form-pair"><label><span>Signed on</span><input type="date" value={draft.signedOn} onChange={handleField('signedOn')} onBlur={handleBlur('signedOn')} className={show('signedOn') ? 'input-error' : undefined} aria-invalid={Boolean(show('signedOn'))} />{show('signedOn') && <span className="field-error">{merged.signedOn}</span>}</label><label><span>Start date</span><input type="date" value={draft.startDate} onChange={handleField('startDate')} onBlur={handleBlur('startDate')} className={show('startDate') ? 'input-error' : undefined} aria-invalid={Boolean(show('startDate'))} />{show('startDate') && <span className="field-error">{merged.startDate}</span>}</label></div><label><span>Conditions</span><textarea value={draft.conditions} onChange={handleField('conditions')} placeholder="Dependencies, approvals, exclusions…" /></label><label><span>Next step</span><input value={draft.nextStep} onChange={handleField('nextStep')} placeholder="Book kickoff call" /></label></div><div className="modal-footer"><div><span className="e e13" aria-hidden="true">🛡️</span><span>Manual record · saved locally</span></div><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">✅</span>}{saving ? 'Saving…' : 'Save contract'}</button></div></div></form></div>
}

function InsightModal({ lead, close, onSave }) {
  const [score, setScore] = useState(lead.opportunityScore || '')
  const [confidence, setConfidence] = useState(lead.confidence || '')
  const [insight, setInsight] = useState(lead.notes || '')
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const validation = validateInsightDraft({ score, confidence, insight })
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const handleBlur = (k) => () => setTouched((p) => ({ ...p, [k]: true }))
  const clearErr = (k) => { if (fieldErrors[k] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[k]; delete n._general; return n }) }
  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitted(true)
    setTouched({ score: true, confidence: true, insight: true })
    const v = validateInsightDraft({ score, confidence, insight })
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const saved = await onSave(lead.id, { opportunityScore: Number(score), confidence: Number(confidence), notes: insight.trim(), researchStatus: 'Analyzed', analysisSource: 'Manual adjustment' }); if (saved) close() } catch (caught) { const mapped = getFieldErrorsFromApiError(caught); if (Object.keys(mapped).length) setFieldErrors(mapped); else setFieldErrors({ _general: caught?.message || 'Could not save result' }) } finally { setSaving(false) }
  }
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal insight-modal" role="dialog" aria-modal="true" aria-label="Adjust opportunity result" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon modal-icon-purple"><span className="e e17" aria-hidden="true">📄</span></span><span><strong>Adjust opportunity result</strong><small>{lead.company}</small></span></div><IconButton label="Close insight" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error field-push">{fieldErrors._general}</div>}<div className="form-pair"><label><span>Opportunity score *</span><input autoFocus type="number" min="0" max="100" value={score} onChange={(event) => { setScore(event.target.value); clearErr('score') }} onBlur={handleBlur('score')} className={show('score') ? 'input-error' : undefined} aria-invalid={Boolean(show('score'))} />{show('score') && <span className="field-error">{merged.score}</span>}</label><label><span>Confidence *</span><input type="number" min="0" max="100" value={confidence} onChange={(event) => { setConfidence(event.target.value); clearErr('confidence') }} onBlur={handleBlur('confidence')} className={show('confidence') ? 'input-error' : undefined} aria-invalid={Boolean(show('confidence'))} />{show('confidence') && <span className="field-error">{merged.confidence}</span>}</label></div><label><span>Review note *</span><textarea value={insight} onChange={(event) => { setInsight(event.target.value); clearErr('insight') }} onBlur={handleBlur('insight')} placeholder="Explain why you adjusted the evidence-based result." className={show('insight') ? 'input-error' : undefined} aria-invalid={Boolean(show('insight'))} />{show('insight') && <span className="field-error">{merged.insight}</span>}</label><div className="safe-note"><span className="e e14" aria-hidden="true">🛡️</span><p>The raw website evidence remains unchanged and the manual adjustment is labeled.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">✅</span>}{saving ? 'Saving…' : 'Save result'}</button></div></div></form></div>
}

function FailureModal({ lead, close, onSave }) {
  const state = researchState(lead)
  const [stage, setStage] = useState(state.done[1] ? 2 : 1)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const validation = validateFailureDraft({ reason, stage })
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const handleBlur = (k) => () => setTouched((p) => ({ ...p, [k]: true }))
  const handleChangeReason = (event) => { setReason(event.target.value); if (fieldErrors.reason || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n.reason; delete n._general; return n }) }
  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitted(true)
    setTouched({ reason: true, stage: true })
    const v = validateFailureDraft({ reason, stage })
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const saved = await onSave(lead.id, { researchFailure: { stage: Number(stage), reason: reason.trim(), at: new Date().toISOString() }, researchStatus: 'Failed' }); if (saved) close() } catch (caught) { const mapped = getFieldErrorsFromApiError(caught); if (Object.keys(mapped).length) setFieldErrors(mapped); else setFieldErrors({ _general: caught?.message || 'Could not mark failed' }) } finally { setSaving(false) }
  }
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal failure-modal" role="dialog" aria-modal="true" aria-label="Mark research stage failed" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon modal-icon-red"><span className="e e17" aria-hidden="true">⚠️</span></span><span><strong>Mark research stage failed</strong><small>{lead.company}</small></span></div><IconButton label="Close failure" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error field-push">{fieldErrors._general}</div>}<label><span>Failed stage</span><select autoFocus value={stage} onChange={(event) => setStage(Number(event.target.value))} className={show('stage') ? 'input-error' : undefined} aria-invalid={Boolean(show('stage'))}>{researchLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select>{show('stage') && <span className="field-error">{merged.stage}</span>}</label><label><span>What went wrong? *</span><textarea value={reason} onChange={handleChangeReason} onBlur={handleBlur('reason')} placeholder="For example: website timed out during the audit" className={show('reason') ? 'input-error' : undefined} aria-invalid={Boolean(show('reason'))} />{show('reason') && <span className="field-error">{merged.reason}</span>}</label><div className="failure-note"><span className="e e14" aria-hidden="true">🔄</span><p>This is an operational failure, not a rejection. Retrying will clear the failure and return the client to its last completed stage.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-failure" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">❌</span>}{saving ? 'Saving…' : 'Mark failed'}</button></div></div></form></div>
}

function ManualLeadModal({ close, onSave }) {
  const [draft, setDraft] = useState({ company: '', website: '', category: '', location: '', address: '', sourceUrl: '', email: '', phone: '' })
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const validation = validateLeadDraft(draft)
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const handleField = (key) => (event) => { setDraft((c) => ({ ...c, [key]: event.target.value })); if (fieldErrors[key] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[key]; delete n._general; return n }) }
  const handleBlur = (key) => () => setTouched((p) => ({ ...p, [key]: true }))
  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitted(true)
    setTouched({ company: true, website: true, email: true, sourceUrl: true })
    const v = validateLeadDraft(draft)
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const saved = await onSave(draft)
      if (saved) close()
      else setFieldErrors({ _general: 'Could not add the client' })
    } catch (caught) {
      const mapped = getFieldErrorsFromApiError(caught)
      if (Object.keys(mapped).length) setFieldErrors(mapped)
      else setFieldErrors({ _general: caught?.message || 'Could not add the client' })
    } finally { setSaving(false) }
  }
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal manual-lead-modal" role="dialog" aria-modal="true" aria-label="Add client manually" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><span className="e e17" aria-hidden="true">➕</span></span><span><strong>Add client manually</strong><small>Start with the information you already have</small></span></div><IconButton label="Close add client" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error field-push">{fieldErrors._general}</div>}<div className="form-pair"><label><span>Company name *</span><input autoFocus value={draft.company} onChange={handleField('company')} onBlur={handleBlur('company')} placeholder="Salt City Plumbing" className={show('company') ? 'input-error' : undefined} aria-invalid={Boolean(show('company'))} />{show('company') && <span className="field-error">{merged.company}</span>}</label><label><span>Website</span><input value={draft.website} onChange={handleField('website')} onBlur={handleBlur('website')} placeholder="example.com" className={show('website') ? 'input-error' : undefined} aria-invalid={Boolean(show('website'))} />{show('website') && <span className="field-error">{merged.website}</span>}</label></div><div className="form-pair"><label><span>Category</span><input value={draft.category} onChange={handleField('category')} placeholder="Plumbing" /></label><label><span>Location</span><input value={draft.location} onChange={handleField('location')} placeholder="Salt Lake City, Utah" /></label></div><label><span>Address</span><input value={draft.address} onChange={handleField('address')} placeholder="47 S Orange St A8" /></label><div className="form-pair"><label><span>Email</span><input type="email" value={draft.email} onChange={handleField('email')} onBlur={handleBlur('email')} placeholder="hello@example.com" className={show('email') ? 'input-error' : undefined} aria-invalid={Boolean(show('email'))} />{show('email') && <span className="field-error">{merged.email}</span>}</label><label><span>Phone</span><input value={draft.phone} onChange={handleField('phone')} placeholder="(801) 555-0100" /></label></div><label><span>Google Maps URL</span><input value={draft.sourceUrl} onChange={handleField('sourceUrl')} onBlur={handleBlur('sourceUrl')} placeholder="https://maps.google.com/..." className={show('sourceUrl') ? 'input-error' : undefined} aria-invalid={Boolean(show('sourceUrl'))} />{show('sourceUrl') && <span className="field-error">{merged.sourceUrl}</span>}</label><div className="safe-note"><span className="e e14" aria-hidden="true">🗄️</span><p>The client will be added as collected. Add a website later to start the audit.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">➕</span>}{saving ? 'Saving…' : 'Add client'}</button></div></div></form></div>
}

function NewRunModal({ close, onStart, connected, maxRecords = 25, defaults }) {
  const [location, setLocation] = useState(defaults.defaultLocation || 'Salt Lake City, Utah')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [categories, setCategories] = useState(defaults.categories || ['Roofing', 'HVAC', 'Flooring'])
  const [limit, setLimit] = useState(connected ? Math.min(5, maxRecords) : defaults.resultLimit || 25)
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [touched, setTouched] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const allCategories = ['Roofing', 'HVAC', 'Flooring', 'Remodeling', 'Electrical', 'Landscaping']
  const validation = validateRunConfig({ location, categories, limit, maxRecords, connected, latitude, longitude })
  const hasExplicitCoords = String(latitude).trim() !== '' || String(longitude).trim() !== ''
  const defaultCoords = defaults.discoveryLatitude !== '' && defaults.discoveryLatitude != null && defaults.discoveryLongitude !== '' && defaults.discoveryLongitude != null
    ? `${defaults.discoveryLatitude}, ${defaults.discoveryLongitude}` : null
  const coordsValid = hasExplicitCoords && Number(latitude) >= -90 && Number(latitude) <= 90 && Number(longitude) >= -180 && Number(longitude) <= 180
  const merged = { ...validation.errors, ...fieldErrors }
  const show = (k) => (submitted || touched[k]) && merged[k]
  const toggle = (item) => {
    setCategories((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])
    if (touched.categories || submitted) {
      const nextCats = categories.includes(item) ? categories.filter((v) => v !== item) : [...categories, item]
      if (nextCats.length) setFieldErrors((p) => { const n = { ...p }; delete n.categories; delete n._general; return n })
    }
  }
  const handleBlur = (k) => () => setTouched((p) => ({ ...p, [k]: true }))
  const handleLocationChange = (event) => { setLocation(event.target.value); if (fieldErrors.location || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n.location; delete n._general; return n }) }
  const handleLimitChange = (event) => { setLimit(event.target.value === '' ? '' : Number(event.target.value)); if (fieldErrors.limit || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n.limit; delete n._general; return n }) }
  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitted(true)
    setTouched({ location: true, categories: true, limit: true, latitude: true, longitude: true })
    const v = validateRunConfig({ location, categories, limit, maxRecords, connected, latitude, longitude })
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const coords = hasExplicitCoords ? { latitude: Number(latitude), longitude: Number(longitude) } : {}
      const saved = await onStart({ location, categories, limit: Number(limit), deepAuditLimit: Math.min(Number(defaults.deepAuditLimit) || 10, Number(limit) || 5), ...coords })
      if (!saved) setFieldErrors({ _general: 'Could not start the run — check connection and try again' })
    } catch (caught) {
      const mapped = getFieldErrorsFromApiError(caught)
      if (Object.keys(mapped).length) setFieldErrors(mapped)
      else setFieldErrors({ _general: caught?.message || 'Could not start the run' })
    } finally { setSaving(false) }
  }
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal minimal-run-modal" role="dialog" aria-modal="true" aria-label="Start research run" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><span className="e e17" aria-hidden="true">📈</span></span><span><strong>Add client data</strong><small>Start a focused collection run</small></span></div><IconButton label="Close run" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{!connected ? <div className="preview-banner"><span className="e e16" aria-hidden="true">🪄</span><div><strong>Saved-client mode</strong><p>Live discovery is not configured. This run will safely audit matching saved websites in this location (city-text filter).</p></div></div> : <div className="preview-banner"><span className="e e16" aria-hidden="true">🛡️</span><div><strong>Live test mode</strong><p>Starts at 5 clients and Bright Data is hard-capped at {maxRecords} records per run.</p></div></div>}{fieldErrors._general && <div className="field-error field-push">{fieldErrors._general}</div>}<label><span>Location *</span><input autoFocus value={location} onChange={handleLocationChange} onBlur={handleBlur('location')} placeholder="Salt Lake City, Utah" className={show('location') ? 'input-error' : undefined} aria-invalid={Boolean(show('location'))} />{show('location') && <span className="field-error">{merged.location}</span>}</label><label><span>Search center — optional coordinates</span><div className="field-row"><input value={latitude} onChange={(event) => setLatitude(event.target.value)} onBlur={handleBlur('latitude')} placeholder="Latitude · e.g. 40.7608" inputMode="decimal" className={show('latitude') ? 'grow input-error' : 'grow'} aria-invalid={Boolean(show('latitude'))} /><input value={longitude} onChange={(event) => setLongitude(event.target.value)} onBlur={handleBlur('longitude')} placeholder="Longitude · e.g. -111.891" inputMode="decimal" className={show('longitude') ? 'grow input-error' : 'grow'} aria-invalid={Boolean(show('longitude'))} /></div>{(show('latitude') || show('longitude')) && <span className="field-error">{merged.latitude || merged.longitude}</span>}<small className="hint">{hasExplicitCoords ? (coordsValid ? `Locked to ${latitude}, ${longitude} — saved with this run and never silently replaced.` : 'Enter both latitude (-90 to 90) and longitude (-180 to 180).') : defaultCoords ? `Empty uses the Settings default (${defaultCoords}). A new place name without coordinates is rejected instead of searched elsewhere.` : 'Empty uses the Settings default. A new place name without coordinates is rejected instead of searched elsewhere.'}</small></label><label><span>Business types *</span><div className="category-selector">{allCategories.map((item) => <button key={item} type="button" className={categories.includes(item) ? 'selected' : ''} onClick={() => toggle(item)}>{categories.includes(item) && <Check size={11} />}{item}</button>)}</div>{show('categories') && <span className="field-error">{merged.categories}</span>}</label><label><span>Maximum clients (1-50)</span><input type="number" min="1" max={connected ? maxRecords : 50} value={limit} onChange={handleLimitChange} onBlur={handleBlur('limit')} className={show('limit') ? 'input-error' : undefined} aria-invalid={Boolean(show('limit'))} />{show('limit') && <span className="field-error">{merged.limit}</span>}</label></div><div className="modal-footer"><div><span className="e e13" aria-hidden="true">🛡️</span><span>No automatic outreach</span></div><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <span className="e" aria-hidden="true">▶️</span>}{saving ? 'Starting…' : connected ? 'Start live run' : 'Audit saved clients'}</button></div></div></form></div>
}

function CommandMenu({ leads, close, onOpen, goTo, onNewRun }) {
  const [query, setQuery] = useState('')
  const input = useRef(null)
  const menuRef = useRef(null)
  useEffect(() => input.current?.focus(), [])
  const matching = leads.filter((lead) => `${lead.company} ${lead.category} ${lead.location}`.toLowerCase().includes(query.toLowerCase())).slice(0, 7)
  return <div className="modal-overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}><div ref={menuRef} className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu" onKeyDown={(event) => trapTabIn(menuRef, event)}><label><Search size={16} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a client…" /><kbd>Esc</kbd></label><div className="command-results">{!query && <><span>Go to</span>{navItems.map(({ label, Icon }) => <button key={label} onClick={() => { goTo(label); close() }}><i className="e e14" aria-hidden="true"><Icon size={14} /></i><strong>{label}</strong></button>)}<button onClick={onNewRun}><i className="e e14" aria-hidden="true">▶️</i><strong>Start research run</strong></button></>}{query && <span>Clients</span>}{query && !matching.length ? <div className="command-empty"><strong>No clients match “{query}”.</strong><small>Try a different company, category, or place — or start a run to collect new businesses.</small><div><button className="button button-quiet button-small" onClick={() => setQuery('')}>Clear search</button><button className="button button-secondary button-small" onClick={() => { goTo('Research'); close() }}>Research prospects</button></div></div> : matching.map((lead) => <button key={lead.id} onClick={() => { onOpen(lead); close() }}><Score value={lead.opportunityScore} /><strong>{lead.company}</strong><small>{lead.category} · {lead.location}</small></button>)}</div></div></div>
}

function QualifyDialog({ lead, onConfirm, close }) {
  const boxRef = useRef(null)
  const previouslyFocused = useRef(null)
  useEffect(() => {
    previouslyFocused.current = document.activeElement
    return () => { if (previouslyFocused.current?.focus) previouslyFocused.current.focus() }
  }, [])
  const topFinding = lead.mainIssue || (lead.problems || [])[0] || lead.issueDetail || 'No findings recorded yet'
  return <div className="modal-overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}><div ref={boxRef} className="run-modal qualify-modal" role="dialog" aria-modal="true" aria-labelledby="qualify-title" onKeyDown={(event) => trapTabIn(boxRef, event)}><div className="modal-header"><div><span className="modal-icon modal-icon-purple"><span className="e e17" aria-hidden="true">✅</span></span><span><strong id="qualify-title">Qualify {lead.company}?</strong><small>Review first — qualifying moves this client to outreach</small></span></div><IconButton label="Cancel qualification" type="button" onClick={close}><X size={16} /></IconButton></div><div className="modal-body"><div className="qualify-facts"><Score value={lead.opportunityScore} /><p><strong>Opportunity {lead.opportunityScore ?? '—'}/100{lead.confidence != null ? ` · ${lead.confidence}% confidence` : ''}</strong>{topFinding}</p></div><p className="lead-summary">Qualifying moves this client to outreach and starts its sales path. Staying here keeps it queued — that is the defer path.</p></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} autoFocus>Keep queued</button><button className="button button-primary" type="button" onClick={onConfirm}><span className="e" aria-hidden="true">✅</span>Qualify for outreach</button></div></div></div></div>
}

function NotFoundPage({ clientId, requestedPath, onNavigate, onBack }) {
  const clientMissing = Boolean(clientId)
  return <section className="route-error" role="alert">
    <div className="state-icon"><span className="e e20" aria-hidden="true">🔍</span></div>
    <span>{clientMissing ? 'Client not found' : 'Page not found'}</span>
    <h1>{clientMissing ? 'That client is no longer available.' : 'This route does not exist.'}</h1>
    <p>{clientMissing ? `No saved client matches “${clientId}”. It may have been removed or the link may be incomplete.` : `Scoutline could not match “${requestedPath || window.location.pathname}” to a workspace page.`}</p>
    <div><button className="button button-secondary" onClick={onBack}><ArrowLeft size={13} />Go back</button><button className="button button-primary" onClick={() => onNavigate('Clients')}><span className="e" aria-hidden="true">🏠</span>Open clients</button></div>
  </section>
}

function SystemNotice({ offline, error, onRetry, onDismiss }) {
  if (!offline && !error) return null
  return <div className="system-notice" role="alert"><span>{offline ? <span className="e e14" aria-hidden="true">📴</span> : <span className="e e14" aria-hidden="true">⚠️</span>}</span><div><strong>{offline ? 'You are offline' : 'Live updates are paused'}</strong><small>{offline ? 'Saved information remains visible. Changes need the local API connection.' : error}</small></div>{!offline && <><button onClick={onRetry}><span className="e" aria-hidden="true">🔄</span>Retry</button><IconButton label="Dismiss notice" onClick={onDismiss}><X size={12} /></IconButton></>}</div>
}

function WorkspaceError({ message, onRetry }) {
  return <main className="app-error" role="alert"><div className="state-icon state-icon-error"><span className="e e20" aria-hidden="true">⚠️</span></div><span>Workspace unavailable</span><h1>Scoutline could not load your local data.</h1><p>{message || 'The local API did not respond.'} Your saved SQLite data has not been changed.</p><div><button className="button button-secondary" onClick={() => window.location.assign('/clients')}><span className="e" aria-hidden="true">🏠</span>Clients route</button><button className="button button-primary" onClick={onRetry}><span className="e" aria-hidden="true">🔄</span>Try again</button></div><small>Make sure <code>npm run dev</code> is running in this project.</small></main>
}

function Toast({ toast }) {
  if (!toast) return null
  const notice = typeof toast === 'string' ? { message: toast, tone: 'success' } : toast
  return <div className={cn('toast', notice.tone === 'error' && 'toast-error')} role={notice.tone === 'error' ? 'alert' : 'status'} aria-live="polite"><span>{notice.tone === 'error' ? <span className="e e12" aria-hidden="true">⚠️</span> : <span className="e e12" aria-hidden="true">✅</span>}</span>{notice.message}</div>
}

function WorkspaceApp({ currentUser, onLogout }) {
  const [route, setRoute] = useState(() => readRoute())
  const page = route.page
  const [theme, setTheme] = useState(() => localStorage.getItem('scoutline-theme') || 'light')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [leads, setLeads] = useState([])
  const [runs, setRuns] = useState([])
  const [apiStatus, setApiStatus] = useState(null)
  const [settingsData, setSettingsData] = useState({ defaultLocation: 'Salt Lake City, Utah', resultLimit: 25, deepAuditLimit: 10, categories: ['Roofing', 'HVAC', 'Flooring'] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [offline, setOffline] = useState(() => !navigator.onLine)
  const [selectedLead, setSelectedLead] = useState(null)
  // Visible record order from the list the record was opened from, so
  // prev/next follows what the user just saw (queue survives replace
  // navigation; deep links fall back to commercial-rank order).
  const recordQueueRef = useRef(null)
  const [contractLead, setContractLead] = useState(null)
  const [insightLead, setInsightLead] = useState(null)
  const [failureLead, setFailureLead] = useState(null)
  const [runModalOpen, setRunModalOpen] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [manualLeadOpen, setManualLeadOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [qualifyLead, setQualifyLead] = useState(null)
  const [activeRunId, setActiveRunId] = useState(null)
  const [toast, setToast] = useState('')
  const csvInput = useRef(null)
  const hasActiveLeadJobs = leads.some((lead) => ['Queued', 'Running', 'Waiting'].includes(lead.researchJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.museJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.refreshJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status) || ['Queued', 'Analyzing'].includes(lead.researchStatus))

  const navigate = (nextPage, { clientId = null, replace = false, search = '', drawer = false } = {}) => {
    const nextRoute = { page: pagePaths[nextPage] ? nextPage : 'Clients', clientId, requestedPath: null, canonical: true, search: search || '' }
    const method = replace ? 'replaceState' : 'pushState'
    // drawer marks record opens so Close/Escape return to the entry screen
    // instead of dumping to the Clients list.
    window.history[method]({ scoutline: true, ...(drawer && { scoutlineDrawer: true }) }, '', routePath(nextRoute.page, clientId) + (search || ''))
    setRoute(nextRoute)
    setSelectedLead(null)
    setSidebarOpen(false)
    setCommandOpen(false)
    setCreateMenuOpen(false)
  }
  // Review "Back to queue" returns to the previous screen, so the queue
  // position (filter is kept in the URL) survives the round trip.
  const backToQueue = () => {
    if (window.history.length > 1) window.history.back()
    else navigate('Research')
  }
  const openLead = (lead, { replace = false, queue = null } = {}) => {
    const originPage = pagePaths[page] && page !== 'Settings' ? page : 'Clients'
    // Sibling comparison replaces the drawer entry so Close always exits in
    // one step; top-level opens push so browser Back returns to the list.
    window.history[replace ? 'replaceState' : 'pushState']({ scoutline: true, scoutlineDrawer: true }, '', routePath(originPage, lead.id))
    setRoute({ page: originPage, clientId: lead.id, requestedPath: null, canonical: true, search: '' })
    setSelectedLead(lead)
    if (queue) recordQueueRef.current = queue
  }
  // Dedicated review workspace: "Review findings" and "View full research"
  // land on evidence, while row clicks open the full client record.
  const openReview = (lead) => navigate('Review', { clientId: lead.id })
  const dupeGroups = useMemo(() => duplicateLeadGroups(leads), [leads])
  const drawerSiblings = selectedLead ? (dupeGroups.find((group) => group.some((item) => item.id === selectedLead.id)) || []).filter((item) => item.id !== selectedLead.id) : []
  const closeLead = () => {
    const current = readRoute()
    if (window.history.state?.scoutlineDrawer) window.history.back()
    else {
      const nextPage = pagePaths[current.page] ? current.page : 'Clients'
      window.history.replaceState({ scoutline: true }, '', routePath(nextPage))
      setRoute({ page: nextPage, clientId: null, requestedPath: null, canonical: true, search: '' })
      setSelectedLead(null)
    }
  }
  const showActionError = (caught, fallback) => {
    const fieldErrors = getFieldErrorsFromApiError(caught)
    const fieldMsg = Object.values(fieldErrors).join(' \u00b7 ')
    setToast({ message: fieldMsg || caught?.message || fallback, tone: 'error' })
    return null
  }

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('scoutline-theme', theme) }, [theme])
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setError('')
    Promise.all([apiRequest('/api/leads'), apiRequest('/api/runs'), apiRequest('/api/status'), apiRequest('/api/settings')])
      .then(([leadData, runData, statusData, savedSettings]) => {
        if (stopped) return
        setLeads(leadData); setRuns(runData); setApiStatus(statusData); setSettingsData(savedSettings)
        const running = runData.find((run) => ['Running', 'Paused'].includes(run.status))
        if (running) setActiveRunId(running.id)
      })
      .catch((caught) => { if (!stopped) setError(caught.message) })
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true }
  }, [reloadToken])
  useEffect(() => {
    if (!route.canonical) {
      window.history.replaceState({ scoutline: true }, '', routePath('Clients'))
      setRoute((current) => ({ ...current, canonical: true }))
    }
    const onPopState = () => {
      setRoute(readRoute())
      setContractLead(null); setInsightLead(null); setFailureLead(null); setRunModalOpen(false); setCreateMenuOpen(false); setManualLeadOpen(false); setCommandOpen(false); setSidebarOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [route.canonical])
  useEffect(() => {
    if (!route.clientId) return setSelectedLead(null)
    setSelectedLead(leads.find((lead) => lead.id === route.clientId) || null)
    // Page is a dependency so same-record transitions across pages (Review
    // to Clients record, browser Back to Review) re-sync the selection.
  }, [route.clientId, page, leads])
  useEffect(() => {
    const label = selectedLead?.company || (page === 'NotFound' ? 'Not found' : page)
    document.title = `${label} · Scoutline`
  }, [page, selectedLead])
  const scrollPosition = useRef({ page, clientId: route.clientId })
  // New destinations start at the top; opening or closing a record preserves
  // the list position. Prev/next inside Review is a destination change.
  useEffect(() => {
    const previous = scrollPosition.current
    if (previous.page !== page || (page === 'Review' && previous.clientId !== route.clientId)) window.scrollTo(0, 0)
    scrollPosition.current = { page, clientId: route.clientId }
  }, [page, route.clientId])
  useEffect(() => {
    const updateConnection = () => setOffline(!navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => { window.removeEventListener('online', updateConnection); window.removeEventListener('offline', updateConnection) }
  }, [])
  useEffect(() => {
    const handler = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true) }
      if (event.key === 'Escape') {
        // An open overlay consumes Escape first; the page underneath keeps
        // its state for the next press.
        if (document.querySelector('.modal-overlay, .command-overlay, .new-menu, .client-run-popover')) {
          setCommandOpen(false); setRunModalOpen(false); setCreateMenuOpen(false); setManualLeadOpen(false); setContractLead(null); setInsightLead(null); setFailureLead(null); setQualifyLead(null)
          return
        }
        const current = readRoute()
        if (current.page === 'Review' && current.clientId) { backToQueue(); return }
        if (current.clientId) {
          // Record opens carry the drawer flag, so Escape returns to the
          // entry screen (review included) instead of the Clients list.
          if (window.history.state?.scoutlineDrawer) { window.history.back(); return }
          window.history.replaceState({ scoutline: true }, '', routePath(current.page))
          setRoute({ ...current, clientId: null })
        }
        setSelectedLead(null); setContractLead(null); setInsightLead(null); setFailureLead(null); setRunModalOpen(false); setCreateMenuOpen(false); setManualLeadOpen(false); setCommandOpen(false); setQualifyLead(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  useEffect(() => {
    if (!activeRunId && !hasActiveLeadJobs) return
    let stopped = false
    const poll = async () => {
      try {
        const [leadData, runData, statusData] = await Promise.all([apiRequest('/api/leads'), apiRequest('/api/runs'), apiRequest('/api/status')])
        if (stopped) return
        setLeads(leadData); setRuns(runData); setApiStatus(statusData)
        setSyncError('')
        setSelectedLead((current) => current ? leadData.find((lead) => lead.id === current.id) || current : current)
        if (activeRunId) {
          const current = runData.find((run) => run.id === activeRunId)
          if (current && ['Completed', 'Cancelled', 'Failed'].includes(current.status)) {
            setToast(`${activeRunId.toUpperCase()} ${current.status.toLowerCase()} · ${current.audited || 0} analyzed, ${current.failed || 0} failed`)
            setActiveRunId(null)
          }
        }
      } catch (caught) { if (!stopped) setSyncError(caught.message) }
    }
    poll()
    const interval = window.setInterval(poll, 1200)
    return () => { stopped = true; window.clearInterval(interval) }
  }, [activeRunId, hasActiveLeadJobs])
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3000); return () => window.clearTimeout(timeout) }, [toast])

  const counts = useMemo(() => getSidebarCounts(leads), [leads])

  const refreshLead = async (id) => {
    const fresh = await apiRequest(`/api/leads/${id}`)
    setLeads((current) => current.map((lead) => lead.id === id ? fresh : lead))
    setSelectedLead((current) => current?.id === id ? fresh : current)
    return fresh
  }
  const updateLead = async (id, changes, { retryOnConflict = true } = {}) => {
    const local = leads.find((lead) => lead.id === id)
    const body = local && Number.isInteger(local.rev) && local.rev >= 0 ? { ...changes, rev: local.rev } : changes
    const applyUpdated = (updated) => {
      setLeads((current) => current.map((lead) => lead.id === id ? updated : lead))
      setSelectedLead((current) => current?.id === id ? updated : current)
      return updated
    }
    try {
      const updated = await apiRequest(`/api/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      setLeads((current) => current.map((lead) => lead.id === id ? updated : lead))
      setSelectedLead((current) => current?.id === id ? updated : current)
      setToast(changes.contract ? `${updated.company} contract saved` : changes.opportunityScore != null ? `${updated.company} insight saved` : changes.salesStage ? `${updated.company} moved to ${changes.salesStage}` : `${updated.company} updated`)
      return updated
    } catch (caught) {
      if (caught?.details?.code === 'REVISION_CONFLICT' && retryOnConflict) {
        try {
          const fresh = await refreshLead(id)
          const retried = await apiRequest(`/api/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...changes, rev: fresh.rev }) })
          applyUpdated(retried)
          setToast(`${retried.company} updated — reapplied after a concurrent change`)
          return retried
        } catch (retryCaught) {
          showActionError(retryCaught, 'Still conflicting — please retry your edit')
          return null
        }
      }
      const fieldErrors = getFieldErrorsFromApiError(caught)
      if (Object.keys(fieldErrors).length) setToast({ message: Object.values(fieldErrors).join(' \u00b7 ') || caught.message, tone: 'error' })
      else showActionError(caught, 'Could not update the client')
      return null
    }
  }
  const startRun = async (config) => {
    try {
      const run = await apiRequest('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
      setRuns((current) => [run, ...current]); setActiveRunId(run.id); setRunModalOpen(false); navigate('Research'); setToast(`${run.source} run started`)
      return run
    } catch (caught) {
      const fieldErrors = getFieldErrorsFromApiError(caught)
      if (Object.keys(fieldErrors).length) {
        setToast({ message: Object.values(fieldErrors).join(' \u00b7 ') || caught.message, tone: 'error' })
        throw caught
      }
      showActionError(caught, 'Could not start the run')
      throw caught
    }
  }
  const toggleRunPause = async () => {
    if (!activeRunId) return
    const currentRun = runs.find((run) => run.id === activeRunId)
    const next = currentRun?.status !== 'Paused'
    const previousStatus = currentRun?.status
    setRuns((current) => current.map((run) => run.id === activeRunId ? { ...run, status: next ? 'Paused' : 'Running' } : run))
    try {
      const updated = await apiRequest(`/api/runs/${activeRunId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next ? 'Paused' : 'Running' }) })
      setRuns((current) => current.map((run) => run.id === activeRunId ? updated : run))
      setToast(next ? 'Research paused' : 'Research resumed')
    } catch (caught) {
      setRuns((current) => current.map((run) => run.id === activeRunId ? { ...run, status: previousStatus } : run))
      showActionError(caught, 'Could not change the run')
    }
  }
  const cancelRun = async () => {
    if (!activeRunId) return
    const id = activeRunId
    try {
      const updated = await apiRequest(`/api/runs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Cancelled', duration: 'Cancelled manually' }) })
      setRuns((current) => current.map((run) => run.id === id ? updated : run))
      setActiveRunId(null); setToast('Research run cancelled')
    } catch (caught) { showActionError(caught, 'Could not cancel the run') }
  }
  const recordContactAttempt = async (id, attempt) => {
    try {
      const result = await apiRequest(`/api/leads/${id}/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt) })
      let finalLead = result.lead
      // Outcome side-effects keep one coherent flow: unanswered attempts never
      // claim contact; not-interested closes the loop as Lost (reason kept);
      // conversation outcomes only mark Contacted via the API, never here.
      if (attempt.outcome === 'not-interested') {
        try {
          finalLead = await updateLead(id, { salesStage: 'Lost', lostReason: String(attempt.notes || 'Not interested').slice(0, 500) })
        } catch { /* attempt is already recorded; stage change is best-effort */ }
      }
      setLeads((current) => current.map((lead) => lead.id === id ? finalLead : lead))
      setSelectedLead((current) => current?.id === id ? finalLead : current)
      if (result.attempt.outcome === 'no-answer') setToast('Attempt recorded — still waiting for first contact')
      else if (result.attempt.outcome === 'wrong-contact') setToast('Attempt recorded — check the contact route before retrying')
      else if (result.attempt.outcome === 'not-interested') setToast(`${finalLead.company} marked not interested`)
      else if (['conversation', 'replied', 'meeting'].includes(result.attempt.outcome)) setToast(`${finalLead.company} marked contacted — schedule a follow-up in Activity`)
      else setToast('Attempt recorded')
      return finalLead
    } catch (caught) { return showActionError(caught, 'Could not record the attempt') }
  }
  const fetchBrief = async (id) => {
    try {
      return await apiRequest(`/api/leads/${id}/brief`)
    } catch (caught) { showActionError(caught, 'Could not load the brief'); return null }
  }
  const exportBrief = async (id) => {
    try {
      const result = await apiRequest(`/api/leads/${id}/brief-export`, { method: 'POST' })
      return result.markdown
    } catch (caught) { showActionError(caught, 'Could not export the brief'); return null }
  }
  const exportProspectBrief = async (id) => {
    try {
      const result = await apiRequest(`/api/leads/${id}/prospect-brief`, { method: 'POST' })
      return result.markdown
    } catch (caught) { showActionError(caught, 'Could not export the one-pager'); return null }
  }
  const addContact = async (id, contact) => {
    try {
      const result = await apiRequest(`/api/leads/${id}/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contact) })
      setLeads((current) => current.map((lead) => lead.id === id ? result.lead : lead))
      setSelectedLead((current) => current?.id === id ? result.lead : current)
      setToast(`Contact route added (${result.contact.kind})`)
      return result.lead
    } catch (caught) { return showActionError(caught, 'Could not add the contact') }
  }
  const reviewFinding = async (id, review) => {
    try {
      const result = await apiRequest(`/api/leads/${id}/findings/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review) })
      setLeads((current) => current.map((lead) => lead.id === id ? result.lead : lead))
      setSelectedLead((current) => current?.id === id ? result.lead : current)
      return result.lead
    } catch (caught) { return showActionError(caught, 'Could not save the review') }
  }
  const analyzeLead = async (lead) => {
    try {
      const result = await apiRequest(`/api/leads/${lead.id}/analyze`, { method: 'POST' })
      setLeads((current) => current.map((item) => item.id === lead.id ? result.lead : item))
      setSelectedLead((current) => current?.id === lead.id ? result.lead : current)
      setToast(result.alreadyQueued ? `${lead.company} is already queued` : `${lead.company} website audit queued`)
      return result.lead
    } catch (caught) { return showActionError(caught, 'Could not queue the website audit') }
  }
  const analyzeWithMuse = async (lead) => {
    try {
      const result = await apiRequest(`/api/leads/${lead.id}/muse/analyze`, { method: 'POST' })
      setLeads((current) => current.map((item) => item.id === lead.id ? result.lead : item))
      setSelectedLead((current) => current?.id === lead.id ? result.lead : current)
      setToast(result.alreadyQueued ? `${lead.company} is already with AI` : `${lead.company} queued for AI synthesis`)
      return result.lead
    } catch (caught) { return showActionError(caught, 'Could not queue AI') }
  }
  const cancelLeadJob = async (lead, jobId) => {
    if (!jobId) return null
    try {
      const result = await apiRequest(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
      if (result.lead) {
        setLeads((current) => current.map((item) => item.id === result.lead.id ? result.lead : item))
        setSelectedLead((current) => current?.id === result.lead.id ? result.lead : current)
      }
      setToast(result.cancelling ? 'Stopping the job — in-flight work is dropped' : 'Job cancelled')
      return result.job
    } catch (caught) { return showActionError(caught, 'Could not cancel the job') }
  }
  const retryLeadJob = async (lead, jobId) => {
    if (!jobId) return null
    try {
      const result = await apiRequest(`/api/jobs/${jobId}/retry`, { method: 'POST' })
      setToast('Replacement job queued — saved evidence is kept')
      return result.job
    } catch (caught) { return showActionError(caught, 'Could not retry the job') }
  }
  const runClientAction = async (lead, action) => {
    try {
      const result = await apiRequest(`/api/leads/${lead.id}/actions/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const updated = result.lead
      setLeads((current) => current.map((item) => item.id === lead.id ? updated : item))
      setSelectedLead((current) => current?.id === lead.id ? updated : current)
      setToast(result.message || `${updated.company} action started`)
      return updated
    } catch (caught) { return showActionError(caught, 'Could not start the client action') }
  }
  const generateOutreachVersions = async (lead) => {
    try {
      const updated = await apiRequest(`/api/leads/${lead.id}/outreach/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setLeads((current) => current.map((item) => item.id === lead.id ? updated : item))
      setSelectedLead((current) => current?.id === lead.id ? updated : current)
      setToast(updated.outreachStatus === 'Insufficient evidence' && !updated.outreachDraft
        ? `No supported outreach for ${lead.company} — no verified findings`
        : `${lead.company} outreach generated with ${updated.outreachGeneration?.model || 'saved evidence'}`)
      return updated
    } catch (caught) { return showActionError(caught, 'Could not generate outreach') }
  }
  const resolveOutreachCandidate = async (lead, action, index = 0) => {
    try {
      const updated = await apiRequest(`/api/leads/${lead.id}/outreach/candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, index }) })
      setLeads((current) => current.map((item) => item.id === lead.id ? updated : item))
      setSelectedLead((current) => current?.id === lead.id ? updated : current)
      setToast(action === 'accept' ? `New draft applied for ${lead.company}` : `Kept current draft for ${lead.company}`)
      return updated
    } catch (caught) { return showActionError(caught, 'Could not update outreach draft') }
  }
  const exportLead = async (lead) => {
    try {
      const result = await apiRequest(`/api/leads/${lead.id}/export`, { method: 'POST' })
      downloadText(`${lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-research.md`, result.markdown, 'text/markdown')
      setToast(`${lead.company} research exported`)
    } catch (caught) { showActionError(caught, 'Export failed') }
  }
  const importCsv = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return setToast({ message: 'Choose a CSV file to import', tone: 'error' })
    let rows
    try {
      const text = await file.text()
      if (!text.trim()) return setToast({ message: 'CSV file is empty', tone: 'error' })
      rows = parseCsv(text)
    } catch {
      return setToast({ message: 'Could not read the CSV file', tone: 'error' })
    }
    const validation = validateImportRows(rows)
    if (validation.headerError) return setToast({ message: validation.headerError, tone: 'error' })
    if (validation.rowErrors.length) {
      const preview = validation.rowErrors.slice(0, 3).map((e) => `Row ${e.row}: ${e.reasons.join(', ')}`).join(' \u00b7 ')
      const more = validation.rowErrors.length > 3 ? ` (+${validation.rowErrors.length - 3} more rows)` : ''
      setToast({ message: `${preview}${more} \u2014 these rows will be skipped`, tone: 'error' })
    }
    if (!rows.length) return setToast({ message: 'CSV needs a header and at least one client', tone: 'error' })
    try {
      const result = await apiRequest('/api/leads/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) })
      setLeads((current) => [...current, ...result.leads])
      const reasons = result.rowReasons || result.reasons || result.skippedReasons || null
      const detail = reasons && Array.isArray(reasons) && reasons.length ? ` \u00b7 ${reasons.slice(0, 3).join('; ')}` : validation.rowErrors.length ? ` \u00b7 ${validation.rowErrors.slice(0,2).map((e)=>`row ${e.row} ${e.reasons.join(', ')}`).join('; ')}` : ''
      if (result.imported === 0 && result.skipped) return setToast({ message: `No clients imported \u00b7 ${result.skipped} skipped${detail}`, tone: 'error' })
      setToast({ message: `Imported ${result.imported} clients${result.skipped ? ` \u00b7 ${result.skipped} skipped${detail}` : ''}`, tone: result.skipped ? 'error' : 'success' })
    } catch (caught) {
      const mapped = getFieldErrorsFromApiError(caught)
      if (Object.keys(mapped).length) setToast({ message: Object.values(mapped).join(' \u00b7 ') || caught.message, tone: 'error' })
      else showActionError(caught, 'CSV import failed')
    }
  }
  const openImport = () => csvInput.current?.click()
  const createManualLead = async (draft) => {
    try {
      const created = await apiRequest('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      setLeads((current) => [...current, created])
      setToast(`${created.company} added to the client database`)
      return created
    } catch (caught) {
      const fieldErrors = getFieldErrorsFromApiError(caught)
      if (Object.keys(fieldErrors).length) {
        setToast({ message: Object.values(fieldErrors).join(' \u00b7 ') || caught.message, tone: 'error' })
        throw caught
      }
      showActionError(caught, 'Could not add the client')
      throw caught
    }
  }
  const exportCsv = () => {
    const headers = ['company', 'category', 'location', 'website', 'email', 'opportunity_score', 'research_phase', 'sales_phase', 'contract_value']
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = leads.map((lead) => { const state = researchState(lead); return [lead.company, lead.category, lead.location, lead.website, lead.email, lead.opportunityScore, `${researchLabels[state.phase]}${state.failure ? ' failed' : ''}`, lead.salesStage, lead.contract?.amount].map(escape).join(',') })
    downloadText('scoutline-clients.csv', [headers.join(','), ...rows].join('\n'), 'text/csv')
    setToast(`Exported ${leads.length} clients`)
  }
  const saveSettings = async (next) => {
    try {
      const saved = await apiRequest('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
      setSettingsData(saved); setToast('Settings saved'); return saved
    } catch (caught) {
      const fieldErrors = getFieldErrorsFromApiError(caught)
      if (Object.keys(fieldErrors).length) {
        setToast({ message: Object.values(fieldErrors).join(' \u00b7 ') || caught.message, tone: 'error' })
        throw caught
      }
      showActionError(caught, 'Could not save settings')
      throw caught
    }
  }

  if (loading) return <div className="app-loading" role="status" aria-live="polite"><Logo /><LoaderCircle className="spin" size={18} /><span>Opening local workspace…</span></div>
  if (error) return <WorkspaceError message={error} onRetry={() => setReloadToken((value) => value + 1)} />

  // Page titles and page actions live in the topbar, so no page burns a full
  // row on its own header. The Review workspace keeps its contextual nav.
  const importExportActions = <><button className="button button-secondary button-small" onClick={() => csvInput.current?.click()}><span className="e" aria-hidden="true">📥</span>Import CSV</button><button className="button button-secondary button-small" onClick={exportCsv}><span className="e" aria-hidden="true">📤</span>Export</button></>
  const readyCount = leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).length
  const bareReviewQueue = page === 'Review' && !selectedLead
  let topTitle = page === 'NotFound' ? 'Not found' : bareReviewQueue ? 'Research' : page
  let topMeta = null
  let topActions = null
  if (page === 'Overview' || page === 'Clients') {
    topMeta = `${leads.length} clients`
    topActions = importExportActions
  } else if (page === 'Starred') {
    topMeta = `${leads.filter((lead) => lead.starred).length} starred`
    topActions = importExportActions
  } else if (page === 'Research' || bareReviewQueue) {
    topMeta = `${readyCount} ready to review`
    topActions = <button className="button button-primary button-small" onClick={() => setRunModalOpen(true)}><span className="e" aria-hidden="true">▶️</span>New research run</button>
  } else if (page === 'Outreach') {
    topActions = <div className="outreach-guard"><span className="e e14" aria-hidden="true">🛡️</span><span><strong>Manual send only</strong><small>Review every draft before it leaves.</small></span></div>
  } else if (page === 'Pipeline') {
    topActions = <button className="button button-secondary button-small" onClick={() => navigate('Outreach')}><span className="e" aria-hidden="true">✉️</span>Open outreach queue</button>
  } else if (page === 'Contracts') {
    topActions = <button className="button button-secondary button-small" onClick={() => navigate('Pipeline')}><span className="e" aria-hidden="true">📊</span>Open pipeline</button>
  } else if (page === 'Preview') {
    topMeta = 'Concept · static data'
  }

  let content
  if (page === 'NotFound') content = <NotFoundPage requestedPath={route.requestedPath} onNavigate={navigate} onBack={() => window.history.length > 1 ? window.history.back() : navigate('Clients')} />
  else if (route.clientId && !selectedLead) content = <NotFoundPage clientId={route.clientId} onNavigate={navigate} onBack={() => window.history.length > 1 ? window.history.back() : navigate('Clients')} />
  if (page === 'Overview') content = <OverviewPage leads={leads} runs={runs} onOpen={openLead} onImport={() => csvInput.current?.click()} onExport={exportCsv} goTo={navigate} onNewRun={() => setRunModalOpen(true)} />
  else if (page === 'Clients') content = <ClientsPage leads={leads} runs={runs} onOpen={openLead} onImport={() => csvInput.current?.click()} onExport={exportCsv} goTo={navigate} onNewRun={() => setRunModalOpen(true)} onToggleStar={(lead) => updateLead(lead.id, { starred: !lead.starred })} initialFilter={new URLSearchParams(route.search || '').get('filter')} />
  else if (page === 'Starred') content = <ClientsPage leads={leads} runs={runs} onOpen={openLead} onImport={() => csvInput.current?.click()} onExport={exportCsv} goTo={navigate} onNewRun={() => setRunModalOpen(true)} onToggleStar={(lead) => updateLead(lead.id, { starred: !lead.starred })} initialFilter="Starred" />
  else if (page === 'Research') content = <ResearchPage leads={leads} runs={runs} activeRunId={activeRunId} onOpen={openLead} onOutreach={() => navigate('Outreach')} onReview={openReview} onExport={exportLead} onUpdate={updateLead} onAnalyze={analyzeLead} onCancelJob={cancelLeadJob} onRetryJob={retryLeadJob} onNewRun={() => setRunModalOpen(true)} onTogglePause={toggleRunPause} onCancel={cancelRun} />
  else if (page === 'Review') content = selectedLead ? <ReviewWorkspace lead={selectedLead} leads={leads} runs={runs} onBack={backToQueue} onSelect={(id) => navigate('Review', { clientId: id })} onOpenRecord={(lead) => navigate('Clients', { clientId: lead.id, drawer: true })} onUpdate={updateLead} onQualify={(lead) => setQualifyLead(lead)} onAnalyze={analyzeLead} onRetryJob={retryLeadJob} onCancelJob={cancelLeadJob} onExport={exportLead} onOutreach={() => navigate('Outreach')} /> : <ResearchPage leads={leads} runs={runs} activeRunId={activeRunId} onOpen={openLead} onOutreach={() => navigate('Outreach')} onReview={openReview} onExport={exportLead} onUpdate={updateLead} onAnalyze={analyzeLead} onCancelJob={cancelLeadJob} onRetryJob={retryLeadJob} onNewRun={() => setRunModalOpen(true)} onTogglePause={toggleRunPause} onCancel={cancelRun} />
  else if (page === 'Crawl') content = <CrawlPage onLeadAdded={(lead, created) => setLeads((current) => (created || !current.some((item) => item.id === lead.id) ? [...current, lead] : current.map((item) => item.id === lead.id ? lead : item)))} onToast={setToast} brightDataReady={apiStatus?.brightDataAdapterReady} jevConfigured={apiStatus?.jevConfigured} jevModel={apiStatus?.jevModel} localDefaults={{ location: settingsData.defaultLocation || 'Salt Lake City, Utah', category: settingsData.categories?.[0] || 'Roofing', latitude: settingsData.discoveryLatitude ?? '', longitude: settingsData.discoveryLongitude ?? '' }} />
  else if (page === 'Outreach') content = <OutreachPage leads={leads} onOpen={openLead} onReview={openReview} onUpdate={updateLead} onAttempt={recordContactAttempt} onGenerate={generateOutreachVersions} onCandidate={resolveOutreachCandidate} onToast={setToast} goTo={navigate} />
  else if (page === 'Pipeline') content = <PipelinePage leads={leads} onOpen={openLead} onUpdate={updateLead} goTo={navigate} onContract={setContractLead} />
  else if (page === 'Contracts') content = <ContractsPage leads={leads} onOpen={openLead} onContract={setContractLead} goTo={navigate} />
  else if (page === 'Preview') content = <PreviewPage initialScreen={new URLSearchParams(route.search || '').get('screen') || 'home'} />
  else content = <SettingsPage apiStatus={apiStatus} settings={settingsData} onSave={saveSettings} />

  return <div className="app-shell"><Sidebar page={page} setPage={navigate} open={sidebarOpen} close={() => setSidebarOpen(false)} counts={counts} currentUser={currentUser} onLogout={onLogout} /><main className="main-shell"><Topbar title={topTitle} meta={topMeta} actions={topActions} onMenu={() => setSidebarOpen(true)} onSearch={() => setCommandOpen(true)} theme={theme} toggleTheme={() => setTheme((value) => value === 'light' ? 'dark' : 'light')} onAdd={() => setCreateMenuOpen(true)} /><SystemNotice offline={offline} error={syncError} onRetry={() => { setSyncError(''); setReloadToken((value) => value + 1) }} onDismiss={() => setSyncError('')} /><div className={cn('page-content', page === 'Clients' && 'page-clients', page === 'Research' && 'page-research')}>{content}</div></main>{page === 'Review' ? null : <LeadDrawer lead={selectedLead} runs={runs} leads={leads} queue={recordQueueRef.current} origin={page} siblings={drawerSiblings} onSelect={openLead} close={closeLead} onExport={exportLead} onUpdate={updateLead} onQualify={(lead) => setQualifyLead(lead)} onAnalyze={analyzeLead} onMuseAnalyze={analyzeWithMuse} onRunAction={runClientAction} onReview={reviewFinding} fetchBrief={fetchBrief} onBriefExport={exportBrief} onProspectBrief={exportProspectBrief} onAddContact={addContact} onCancelJob={cancelLeadJob} onRetryJob={retryLeadJob} brightDataReady={apiStatus?.brightDataAdapterReady} onToast={setToast} onContract={setContractLead} onInsight={setInsightLead} onFailure={setFailureLead} onOutreach={() => navigate('Outreach')} />}{contractLead && <ContractModal lead={contractLead} close={() => setContractLead(null)} onSave={updateLead} />}{insightLead && <InsightModal lead={insightLead} close={() => setInsightLead(null)} onSave={updateLead} />}{failureLead && <FailureModal lead={failureLead} close={() => setFailureLead(null)} onSave={updateLead} />}{runModalOpen && <NewRunModal close={() => setRunModalOpen(false)} onStart={startRun} connected={apiStatus?.brightDataAdapterReady} maxRecords={apiStatus?.brightDataMaxRecords || 25} defaults={settingsData} />}{createMenuOpen && <NewMenu close={() => setCreateMenuOpen(false)} onRun={() => setRunModalOpen(true)} onImport={openImport} onManual={() => setManualLeadOpen(true)} />}{manualLeadOpen && <ManualLeadModal close={() => setManualLeadOpen(false)} onSave={createManualLead} />}{qualifyLead && <QualifyDialog lead={qualifyLead} close={() => setQualifyLead(null)} onConfirm={async () => { const updated = await updateLead(qualifyLead.id, { qualified: true, salesStage: 'Qualified' }); if (updated) setQualifyLead(null) }} />}{commandOpen && <CommandMenu leads={leads} close={() => setCommandOpen(false)} onOpen={openLead} goTo={navigate} onNewRun={() => { setCommandOpen(false); setRunModalOpen(true) }} />}<input ref={csvInput} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={importCsv} /><Toast toast={toast} /></div>
}

export default function App() {
  const isLanding = window.location.pathname.toLowerCase() === '/landing'
  const [authState, setAuthState] = useState({ loading: true, configured: false, clientId: null, user: null, error: '', signingIn: false })

  const checkSession = useCallback(async () => {
    setAuthState((current) => ({ ...current, loading: true, error: '' }))
    try {
      const [configResponse, sessionResponse] = await Promise.all([fetch('/api/auth/config'), fetch('/api/auth/session')])
      if (!configResponse.ok || !sessionResponse.ok) throw new Error('The authentication service could not be reached.')
      const [config, session] = await Promise.all([configResponse.json(), sessionResponse.json()])
      setAuthState({ loading: false, configured: config.configured, clientId: config.clientId, user: session.authenticated ? session.user : null, error: '', signingIn: false })
    } catch (error) {
      setAuthState((current) => ({ ...current, loading: false, error: error.message || 'Authentication check failed.', signingIn: false }))
    }
  }, [])

  useEffect(() => { if (!isLanding) checkSession() }, [checkSession, isLanding])
  useEffect(() => {
    const requireAuth = () => setAuthState((current) => ({ ...current, user: null, error: 'Your session ended. Sign in again to continue.' }))
    window.addEventListener('scoutline:auth-required', requireAuth)
    return () => window.removeEventListener('scoutline:auth-required', requireAuth)
  }, [])

  const signIn = useCallback(async (credential) => {
    setAuthState((current) => ({ ...current, signingIn: true, error: '' }))
    try {
      const response = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error || 'Google sign-in failed.')
      setAuthState((current) => ({ ...current, user: body.user, signingIn: false, error: '' }))
    } catch (error) {
      setAuthState((current) => ({ ...current, signingIn: false, error: error.message || 'Google sign-in failed.' }))
    }
  }, [])

  const logout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }) }
    finally {
      window.google?.accounts?.id?.disableAutoSelect?.()
      setAuthState((current) => ({ ...current, user: null, error: '', signingIn: false }))
    }
  }, [])

  const showLoginError = useCallback((message) => setAuthState((current) => ({ ...current, error: message })), [])

  if (isLanding) return <LandingPage />
  if (authState.loading) return <div className="app-loading" role="status" aria-live="polite"><Logo /><LoaderCircle className="spin" size={18} /><span>Checking access…</span></div>
  if (!authState.user) return <LoginPage configured={authState.configured} clientId={authState.clientId} error={authState.error} signingIn={authState.signingIn} onCredential={signIn} onRetry={showLoginError} />
  return <WorkspaceApp currentUser={authState.user} onLogout={logout} />
}
