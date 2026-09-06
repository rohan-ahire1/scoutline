import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  Globe2,
  Home,
  LayoutGrid,
  LoaderCircle,
  Mail,
  MapPin,
  Menu,
  Moon,
  PanelLeftClose,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trophy,
  Upload,
  WandSparkles,
  WifiOff,
  X,
} from 'lucide-react'
import {
  getFieldErrorsFromApiError,
  getMuseGuidance,
  getNextAction,
  getOutreachState,
  getResearchLabel,
  getResearchState,
  getSidebarCounts,
  isContacted,
  isOpenPipeline,
  isQualified,
  researchStages,
  salesStages,
  validateImportRows,
  validateLeadDraft,
  validateRunConfig,
  validateSettingsDraft,
} from './domain/workflow'
import { ATTEMPT_OUTCOMES, NEXT_TASK_TYPES, TASK_OWNERS, addDaysString, localDayString, taskBucket } from '../server/services/brief.js'

const navItems = [
  { label: 'Clients', icon: Building2 },
  { label: 'Research', icon: Sparkles },
  { label: 'Outreach', icon: Mail },
  { label: 'Pipeline', icon: LayoutGrid },
  { label: 'Contracts', icon: Trophy },
]

const researchLabels = researchStages.map((stage) => stage.label)
const pipelineStages = [...salesStages]
const pagePaths = { Clients: '/clients', Research: '/research', Outreach: '/outreach', Pipeline: '/pipeline', Contracts: '/contracts', Won: '/won', Settings: '/settings' }
const pathPages = Object.fromEntries(Object.entries(pagePaths).map(([page, path]) => [path.slice(1), page]))
pathPages.won = 'Contracts'

function readRoute() {
  let segments
  try { segments = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent) }
  catch { return { page: 'NotFound', clientId: null, requestedPath: window.location.pathname, canonical: true } }
  if (!segments.length) return { page: 'Clients', clientId: null, requestedPath: null, canonical: false }
  const page = pathPages[segments[0].toLowerCase()]
  if (!page || segments.length > 2 || (page === 'Settings' && segments.length > 1)) return { page: 'NotFound', clientId: null, requestedPath: window.location.pathname, canonical: true }
  return { page, clientId: segments[1] || null, requestedPath: null, canonical: true }
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
  Qualified: 'purple', Contacted: 'blue', Replied: 'purple', Meeting: 'amber', Proposal: 'pink', Won: 'green', Lost: 'gray',
  Running: 'orange', Queued: 'purple', Waiting: 'amber', Paused: 'amber', Completed: 'green', Cancelled: 'gray', Failed: 'red',
}

const categoryTone = {
  Roofing: 'orange', HVAC: 'cyan', Flooring: 'purple', Remodeling: 'pink', Electrical: 'amber', Landscaping: 'green',
  Concrete: 'slate', Plumbing: 'blue', Windows: 'indigo', Decking: 'brown', Fencing: 'slate', 'Garage Doors': 'blue',
}

function cn(...values) { return values.filter(Boolean).join(' ') }

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

function outreachBody(lead, version = 'Concise') {
  if (lead.outreachDrafts?.[version]) return lead.outreachDrafts[version]
  if (lead.outreachDraft && outreachVersion(lead) === version) return lead.outreachDraft
  // Client-side preview only renders verified findings; with none, it renders
  // nothing instead of inventing default defects.
  const findings = (lead.problems?.length ? lead.problems : (lead.issueDetail ? [lead.issueDetail] : [])).filter(Boolean).slice(0, 3).map((item) => {
    const clean = String(item).trim().replace(/[.!?]+$/, '')
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : ''
  }).filter(Boolean)
  if (!findings.length) return ''
  const [first, second, third] = findings
  if (version === 'Detailed') {
    const observations = [first, second, third].filter(Boolean)
    const report = observations.map((finding, index) => {
      const advice = findingAdvice(finding)
      return `${index + 1}. ${finding}\nWhy it matters: ${advice.why}\nHow I’d improve it: ${advice.change}`
    }).join('\n\n')
    return `Hi —\n\nI reviewed ${lead.company}'s website and pulled together a short audit of the main areas I’d improve:\n\n${report}\n\nOverall direction\nI’d shape the redesign around ${String(lead.mainIssue || 'a clearer customer journey').toLowerCase()}, a stronger visual hierarchy, and a simpler path from interest to enquiry.\n\nIf useful, I can turn this into a free homepage concept so you can judge the direction before deciding anything. Would you like me to send it over?`
  }
  if (version === 'Balanced') {
    const observations = [first, second].filter(Boolean)
    const list = observations.map((finding) => `• ${finding}`).join('\n')
    return `Hi —\n\nI reviewed ${lead.company}'s website and ${observations.length > 1 ? 'two things' : 'one thing'} stood out:\n${list}\n\nThese issues can make it harder for visitors to understand the offer and take the next step, especially on mobile. I’d focus the redesign on ${String(lead.mainIssue || 'a clearer customer journey').toLowerCase()}, a clearer primary action, stronger proof near the enquiry point, and a simpler mobile path.\n\nIf useful, I can create a free homepage concept showing how those changes could work together. You can review the direction first and decide whether it feels right—would you like me to send it?`
  }
  return `Hi — I reviewed ${lead.company}'s website and noticed one clear opportunity: ${first}. I have a straightforward idea to improve it and make the next step easier for visitors. If useful, I can send a free homepage redesign so you can see the direction before deciding anything—interested?`
}

function Logo() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
}

function Badge({ children, tone = 'gray', dot = false }) {
  return <span className={cn('badge', `badge-${tone}`)}>{dot && <i />}{children}</span>
}

function Score({ value, size = 'normal' }) {
  const score = value ?? 0
  const tone = score >= 88 ? 'great' : score >= 80 ? 'good' : score >= 70 ? 'fair' : 'low'
  return <span className={cn('score', `score-${tone}`, `score-${size}`)} title={value == null ? 'Not analyzed yet' : `Opportunity score ${value}`}>{value ?? '—'}</span>
}

function Avatar({ name, size = 'normal' }) {
  const initials = name.split(' ').map((part) => part[0]).slice(0, 2).join('')
  return <span className={cn('avatar', `avatar-${size}`)}>{initials}</span>
}

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

function Sidebar({ page, setPage, open, close, counts }) {
  const go = (next) => { setPage(next); close() }
  return (
    <>
      {open && <button className="nav-scrim" aria-label="Close navigation" onClick={close} />}
      <aside className={cn('sidebar', open && 'sidebar-open')}>
        <div className="brand-row">
          <button className="brand-button" onClick={() => go('Clients')}><Logo /><span>Scoutline</span><Badge tone="orange">Local</Badge></button>
          <IconButton label="Close sidebar" className="sidebar-close" onClick={close}><PanelLeftClose size={15} /></IconButton>
        </div>
        <div className="workspace-label"><span>Client workspace</span></div>
        <nav className="main-nav" aria-label="Client workflow">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={cn('nav-item', page === label && 'nav-item-active')} aria-current={page === label ? 'page' : undefined} onClick={() => go(label)}>
              <Icon size={15} strokeWidth={1.8} /><span>{label}</span>
              {counts[label] > 0 && <small>{counts[label]}</small>}
            </button>
          ))}
        </nav>
        <div className="workflow-key">
          <span>One simple flow</span>
          <p>Collect → understand → reach out → sell → deliver</p>
        </div>
        <div className="sidebar-bottom">
          <button className={cn('nav-item', page === 'Settings' && 'nav-item-active')} aria-current={page === 'Settings' ? 'page' : undefined} onClick={() => go('Settings')}><Settings size={15} /><span>Settings</span></button>
          <button className="profile-row" onClick={() => go('Settings')}><Avatar name="Rohan" /><span><strong>Local workspace</strong><small>SQLite · Private</small></span><ChevronRight size={13} /></button>
        </div>
      </aside>
    </>
  )
}

function Topbar({ page, onNavigate, onMenu, onSearch, theme, toggleTheme, onAdd }) {
  return (
    <header className="topbar">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><IconButton label="Open navigation" className="mobile-menu" onClick={onMenu}><Menu size={17} /></IconButton><button className="breadcrumb-home" onClick={() => onNavigate('Clients')}>Scoutline</button><ChevronRight size={12} aria-hidden="true" /><strong aria-current="page">{page}</strong></nav>
      <div className="top-actions">
        <button className="global-search" onClick={onSearch}><Search size={14} /><span>Find a client</span><kbd>⌘ K</kbd></button>
        <IconButton label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={toggleTheme}>{theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}</IconButton>
        <button className="button button-primary top-run" onClick={onAdd}><Plus size={13} />New</button>
      </div>
    </header>
  )
}

function NewMenu({ close, onRun, onImport, onManual }) {
  return <div className="modal-overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="new-menu"><div className="new-menu-head"><div><span className="detail-label">Create</span><h2>What are you adding?</h2></div><IconButton label="Close create menu" onClick={close}><X size={15} /></IconButton></div><button onClick={() => { close(); onRun() }}><span><Play size={16} /></span><div><strong>Start research run</strong><small>Discover businesses and audit their websites.</small></div><ArrowRight size={13} /></button><button onClick={() => { close(); onImport() }}><span><Upload size={16} /></span><div><strong>Import CSV</strong><small>Add a prepared list of clients and evidence.</small></div><ArrowRight size={13} /></button><button onClick={() => { close(); onManual() }}><span><Plus size={16} /></span><div><strong>Add client manually</strong><small>Save one client now and research it later.</small></div><ArrowRight size={13} /></button></div></div>
}

function PageHeader({ eyebrow, title, description, children }) {
  return <div className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children && <div className="page-header-actions">{children}</div>}</div>
}

function ClientsPage({ leads, runs, onOpen, onImport, onExport }) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState('All')
  const views = [
    { label: 'All', count: leads.length, tone: 'all' },
    { label: 'Needs research', count: leads.filter((lead) => !researchState(lead).analyzed || researchState(lead).failure).length, tone: 'orange' },
    { label: 'Ready to review', count: leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).length, tone: 'purple' },
    { label: 'Pipeline', count: leads.filter(isOpenPipelineLead).length, tone: 'blue' },
    { label: 'Won', count: leads.filter((lead) => lead.salesStage === 'Won').length, tone: 'green' },
  ]
  const filtered = leads.filter((lead) => {
    const match = `${lead.company} ${lead.category} ${lead.location}`.toLowerCase().includes(query.toLowerCase())
    if (!match) return false
    if (view === 'Needs research') return !researchState(lead).analyzed || researchState(lead).failure
    if (view === 'Ready to review') return researchState(lead).museComplete && !isQualifiedLead(lead)
    if (view === 'Pipeline') return isOpenPipelineLead(lead)
    if (view === 'Won') return lead.salesStage === 'Won'
    return true
  }).sort((a, b) => (b.opportunityScore || b.prelimScore) - (a.opportunityScore || a.prelimScore))
  const inPipeline = leads.filter(isOpenPipelineLead)
  const won = leads.filter((lead) => lead.salesStage === 'Won')
  const ready = leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead))
  const summary = [
    { label: 'Total clients', value: leads.length, detail: `${new Set(leads.map((lead) => lead.category)).size} categories`, icon: Building2, tone: 'blue' },
    { label: 'Ready to review', value: ready.length, detail: 'Research complete · decision needed', icon: CheckCircle2, tone: 'purple' },
    { label: 'Open pipeline', value: inPipeline.length, detail: `${inPipeline.filter((lead) => lead.salesStage === 'Proposal').length} at proposal`, icon: BriefcaseBusiness, tone: 'orange' },
    { label: 'Won', value: won.length, detail: won.some((lead) => Number(lead.contract?.amount)) ? `${currency(won.reduce((total, lead) => total + Number(lead.contract?.amount || 0), 0))} recorded` : 'No contract value yet', icon: Trophy, tone: 'green' },
  ]
  return (
    <>
      <PageHeader eyebrow="Client database" title="Every client, one place." description="See what is ready for review, what is in sales, and what needs attention next.">
        <button className="button button-secondary" onClick={onImport}><Upload size={14} />Import CSV</button>
        <button className="button button-secondary" onClick={onExport}><Download size={14} />Export</button>
      </PageHeader>
      <section className="client-summary" aria-label="Client overview">
        {summary.map(({ label, value, detail, icon: Icon, tone }) => (
          <article key={label} className={`client-summary-card summary-tone-${tone}`}>
            <span className="client-summary-icon"><Icon size={15} strokeWidth={1.8} /></span>
            <span className="client-summary-copy"><small>{label}</small><strong>{value}</strong><em>{detail}</em></span>
          </article>
        ))}
      </section>
      <section className="panel client-list-panel">
        <div className="client-list-tools">
          <div className="view-tabs" role="tablist" aria-label="Client views">{views.map((item) => <button role="tab" aria-selected={view === item.label} key={item.label} className={view === item.label ? 'active' : ''} onClick={() => setView(item.label)}><i className={`filter-dot filter-dot-${item.tone}`} /><span>{item.label}</span><em>{item.count}</em></button>)}</div>
          <div className="table-search"><Search size={14} /><input aria-label="Search clients" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients…" />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div>
        </div>
        <div className="client-table">
          <div className="client-table-head"><span>Client</span><span>Research</span><span>Opportunity</span><span>Sales phase</span><span>Next action</span><span /></div>
          {filtered.map((lead) => {
            const { failure, phase } = researchState(lead)
            const origin = leadRunInfo(lead, runs)
            const originLabel = origin.collectionRun ? `Added in ${runLabel(origin.collectionRun)}` : lead.labels?.includes('CSV import') ? 'Manual import' : 'Existing client'
            return <button className="client-row" key={lead.id} onClick={() => onOpen(lead)}><span className="client-name"><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{lead.category} · {lead.location}</small><small className="client-origin"><Database size={9} />{originLabel}{origin.collectionRun ? ` · ${runTimestamp(origin.collectionRun)}` : ''}</small></span></span><span className="phase-cell"><Badge tone={failure ? 'red' : phase === 2 ? 'purple' : phase === 1 ? 'blue' : 'gray'} dot>{getResearchLabel(lead)}</Badge></span><Score value={lead.opportunityScore} /><span>{lead.salesStage ? <Badge tone={statusTone[lead.salesStage]} dot>{lead.salesStage}</Badge> : <span className="muted-dash">Not in sales</span>}</span><span className="next-action-cell">{getNextAction(lead)}</span><ChevronRight size={13} /></button>
          })}
          {!filtered.length && <div className="empty-state"><Search size={20} /><h3>No clients here</h3><p>Try another view or search.</p></div>}
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
      <div><span className="panel-kicker"><Activity size={12} />Collection activity</span><div className="run-status-identifiers"><strong>{runLabel(run)}</strong><small>{runTimestamp(run)} · {run.source}</small></div><h2>{title}</h2><p>{run.categories.join(', ')} · {run.location}</p></div>
      <div className="simple-run-progress"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div>
      {['Running', 'Paused'].includes(run.status) && <div className="simple-run-actions"><button className="button button-secondary button-small" onClick={onTogglePause}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? 'Resume' : 'Pause'}</button><button className="button button-quiet button-small" onClick={onCancel}><X size={12} />Cancel</button></div>}
      {!['Running', 'Paused'].includes(run.status) && <Badge tone={statusTone[run.status]} dot>{run.status}</Badge>}
    </section>
  )
}

function RunHistory({ runs, leads, onOpen }) {
  if (!runs.length) return null
  const ordered = [...runs].sort((a, b) => new Date(b.startedAt || b.createdAt).getTime() - new Date(a.startedAt || a.createdAt).getTime())
  const latestId = ordered[0]?.id
  return <section className="panel run-history-panel">
    <div className="section-heading"><div><h2>Research runs</h2><span>Every collection stays traceable, including the clients it touched.</span></div><Badge tone="gray">{runs.length} total</Badge></div>
    <div className="run-history-list">
      {ordered.map((run) => {
        const linked = leads.filter((lead) => run.clientIds?.includes(lead.id) || lead.runHistory?.some((item) => item.runId === run.id))
        const progress = run.status === 'Completed' ? 100 : Number(run.progress || 0)
        const newCount = run.newClients ?? run.newClientIds?.length ?? 0
        const matchedCount = run.matchedClients ?? run.matchedClientIds?.length ?? 0
        return <article className={cn('run-history-row', run.id === latestId && 'is-latest')} key={run.id}>
          <div className="run-history-main"><div className="run-history-title"><strong>{runLabel(run)}</strong><Badge tone={statusTone[run.status] || 'gray'} dot>{run.status}</Badge>{run.id === latestId && <Badge tone="orange">Latest</Badge>}</div><p>{run.categories.join(', ')} · {run.location}</p><small>{runTimestamp(run)} · {run.source}</small></div>
          <div className="run-history-progress"><div><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong></div><small>{run.duration || 'Run in progress'}</small></div>
          <div className="run-history-stats"><span><strong>{newCount}</strong><small>new</small></span><span><strong>{matchedCount}</strong><small>matched</small></span><span><strong>{run.audited ?? 0}</strong><small>audited</small></span></div>
          <div className="run-history-clients"><span className="detail-label">Clients from this run</span>{linked.length ? <div>{linked.slice(0, 5).map((lead) => <button key={lead.id} type="button" onClick={() => onOpen(lead)} title={lead.company}><Avatar name={lead.company} size="small" /><span>{lead.company}</span></button>)}{linked.length > 5 && <em>+{linked.length - 5} more</em>}</div> : <small>No clients linked yet</small>}</div>
        </article>
      })}
    </div>
  </section>
}

function ResearchPage({ leads, runs, activeRunId, onOpen, onExport, onUpdate, onAnalyze, onNewRun, onTogglePause, onCancel }) {
  const initialParams = new URLSearchParams(window.location.search)
  const [tab, setTab] = useState(initialParams.get('tab') === 'runs' ? 'Runs' : 'Prospects')
  const [filter, setFilter] = useState(initialParams.get('filter') || 'Ready to review')
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('tab', tab.toLowerCase())
    if (tab === 'Prospects') params.set('filter', filter)
    else params.delete('filter')
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`)
  }, [tab, filter])
  const allSorted = [...leads].sort((a, b) => getNextAction(a).localeCompare(getNextAction(b)) || (b.opportunityScore || b.prelimScore) - (a.opportunityScore || a.prelimScore))
  const sorted = allSorted.filter((lead) => {
    const state = researchState(lead)
    if (filter === 'Needs analysis') return !state.analyzed && !state.processing
    if (filter === 'In progress') return state.processing
    if (filter === 'Ready to review') return state.museComplete && !isQualifiedLead(lead)
    if (filter === 'Failed') return Boolean(state.failure)
    if (filter === 'In sales') return isQualifiedLead(lead)
    return true
  })
  const activeRun = runs.find((run) => run.id === activeRunId) || runs[0]
  const failedCount = leads.filter((lead) => researchState(lead).failure).length
  const readyCount = leads.filter((lead) => researchState(lead).museComplete && !isQualifiedLead(lead)).length
  const inProgressCount = leads.filter((lead) => researchState(lead).processing).length
  const needsAnalysisCount = leads.filter((lead) => !researchState(lead).analyzed && !researchState(lead).processing).length
  return (
    <>
      <PageHeader eyebrow="Research workspace" title="Know exactly what is done." description="Collect evidence, review Muse guidance, then choose which clients enter sales.">
        <button className="button button-primary" onClick={onNewRun}><Play size={13} />New research run</button>
      </PageHeader>
      <div className="workspace-tabs" role="tablist" aria-label="Research views"><button role="tab" aria-selected={tab === 'Prospects'} className={tab === 'Prospects' ? 'active' : ''} onClick={() => setTab('Prospects')}>Prospects</button><button role="tab" aria-selected={tab === 'Runs'} className={tab === 'Runs' ? 'active' : ''} onClick={() => setTab('Runs')}>Runs <em>{runs.length}</em></button></div>
      {tab === 'Prospects' && <>
      <section className="milestone-summary">
        {[['Needs analysis', needsAnalysisCount, Database, 'Collected without a completed audit'], ['In progress', inProgressCount, Activity, 'A run or client job is active'], ['Ready to review', readyCount, CheckCircle2, 'Muse guidance is ready for your decision'], ['Failed', failedCount, CircleAlert, 'Retry a blocked research stage']].map(([label, count, Icon, detail]) => <button type="button" className={cn('research-metric', filter === label && 'active')} key={label} onClick={() => setFilter(label)}><span><Icon size={15} /></span><strong>{count}</strong><div><b>{label}</b><small>{detail}</small></div></button>)}
      </section>
      <section className="panel research-list-panel">
        <div className="section-heading"><div><h2>{filter}</h2><span>Each row has one next action. Qualification adds the client to Outreach and Pipeline.</span></div><div className="view-tabs research-filter-tabs" role="tablist" aria-label="Research filters">{['Ready to review', 'Needs analysis', 'In progress', 'Failed', 'In sales', 'All'].map((item) => <button role="tab" aria-selected={filter === item} key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div></div>
        <div className="research-list">
          {sorted.map((lead) => {
            const { done, failure, phase } = researchState(lead)
            const auditReady = lead.performance != null || (lead.problems || []).length > 0
            const jobActive = ['Queued', 'Running', 'Waiting'].includes(lead.researchJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status) || ['Queued', 'Analyzing'].includes(lead.researchStatus)
            const origin = leadRunInfo(lead, runs)
            return <article className={cn('research-row', failure && 'has-failure')} key={lead.id}><button className="research-client" onClick={() => onOpen(lead)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{lead.category} · {failure?.reason || lead.mainIssue}</small>{origin.collectionRun && <small className="client-origin"><Database size={9} />{`Added in ${runLabel(origin.collectionRun)}`}</small>}</span></button><ResearchProgress lead={lead} /><span className={cn('research-result', failure && 'is-failed')}><small>{failure ? 'Research state' : jobActive ? 'Research state' : 'Muse guidance'}</small><strong>{failure ? `${researchLabels[phase]} failed` : jobActive ? 'In progress' : getMuseGuidance(lead) || getResearchLabel(lead)}</strong>{done[1] && !failure && <em>{lead.opportunityScore}/100 score</em>}</span><div className="research-action">{jobActive ? <Badge tone={statusTone[lead.researchJob?.status] || 'orange'} dot>{lead.researchJob?.phase || lead.researchJob?.status || lead.researchStatus}</Badge> : failure ? <button className="button button-secondary button-small retry-button" onClick={() => onAnalyze(lead)}><RefreshCcw size={12} />Retry audit</button> : !done[1] ? <button className="button button-primary button-small" onClick={() => onAnalyze(lead)}>{auditReady ? <RefreshCcw size={12} /> : <Play size={12} />}Analyze website</button> : !isQualifiedLead(lead) ? <button className="button button-primary button-small" onClick={() => onUpdate(lead.id, { qualified: true, salesStage: 'Qualified' })}><CheckCircle2 size={12} />Qualify for outreach</button> : <Badge tone="purple" dot>In sales</Badge>}</div></article>
          })}
          {!sorted.length && <div className="empty-state"><CheckCircle2 size={20} /><h3>Nothing needs attention here</h3><p>Try another research filter or start a new run.</p></div>}
        </div>
      </section>
      </>}
      {tab === 'Runs' && <>
      <RunStatus run={activeRun} onTogglePause={onTogglePause} onCancel={onCancel} />
      <RunHistory runs={runs} leads={leads} onOpen={onOpen} />
      </>}
    </>
  )
}

function StagePicker({ lead, onChange }) {
  const [open, setOpen] = useState(false)
  return <div className="stage-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}><button className="stage-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}><i className={`stage-dot stage-dot-${statusTone[lead.salesStage] || 'gray'}`} /><span>{lead.salesStage}</span><ChevronDown size={10} /></button>{open && <div className="stage-picker-menu" role="listbox" aria-label={`Move ${lead.company}`}>
    <small>Move to</small>
    {pipelineStages.map((stage) => <button type="button" role="option" aria-selected={lead.salesStage === stage} key={stage} onMouseDown={(event) => event.stopPropagation()} onClick={() => { onChange(stage); setOpen(false) }}><i className={`stage-dot stage-dot-${statusTone[stage] || 'gray'}`} /><span>{stage}</span>{lead.salesStage === stage && <Check size={11} />}</button>)}
  </div>}</div>
}

function OutreachCard({ lead, onOpen, onUpdate, onAttempt, onGenerate, onCandidate, onToast }) {
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
      <header className="outreach-client-head"><button onClick={() => onOpen(lead)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{displayEmail ? lead.email : 'No email found · website form is still available'}</small></span></button><Badge tone={contacted ? statusTone[lead.salesStage] || 'blue' : getOutreachState(lead) === 'Needs draft' ? 'gray' : 'orange'} dot>{contacted ? lead.salesStage : getOutreachState(lead)}</Badge></header>
      <div className="outreach-card-grid">
        <section className="outreach-evidence"><span className="detail-label">Why this is relevant</span><ol>{findings.map((problem) => <li key={problem}>{problem}</li>)}</ol><button onClick={() => onOpen(lead)}>View full research <ArrowRight size={10} /></button></section>
        <section className="email-draft"><div className="email-draft-meta"><span className="detail-label">Email draft</span><div className="email-version-tabs" role="tablist" aria-label={`Email length for ${lead.company}`}>{outreachVersions.map((item) => <button key={item} role="tab" aria-selected={version === item} className={version === item ? 'active' : ''} onClick={() => selectVersion(item)} disabled={editing || generating}>{item}</button>)}</div><small>{wordCount} words · {lead.outreachGeneration?.model || 'evidence template'}</small></div>{lead.outreachStale && <div className="candidate-banner"><span><strong>Drafts predate the latest audit.</strong><small> {lead.outreachStaleReason || 'A newer audit completed after these drafts.'}</small></span><div><button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { outreachStale: false })}>Mark reviewed</button></div></div>}{showCandidate && <div className="candidate-banner"><span><strong>New generated draft available.</strong><small> Your current text was kept. Review the latest candidate before switching.</small></span><div><button className="button button-secondary button-small" onClick={() => resolveCandidate('accept')} disabled={resolving}>{resolving ? 'Applying…' : 'Use new draft'}</button><button className="button button-quiet button-small" onClick={() => resolveCandidate('dismiss')} disabled={resolving}>Keep current</button></div></div>}{insufficient && <div className="candidate-banner"><span><strong>No supported outreach.</strong><small> {lead.outreachCandidates?.[0]?.reason || 'The saved audit has no verified findings to write from.'}</small></span></div>}{editing ? <><label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label><span>Message</span><textarea value={body} onChange={(event) => setBody(event.target.value)} /></label></> : <div className="email-preview"><small>Subject · {subject}</small><p>{body}</p></div>}<div className="outreach-actions">{editing ? <><button className="button button-quiet button-small" onClick={() => { setSubject(outreachSubject(lead)); setBody(outreachBody(lead, version)); setEditing(false) }}>Cancel</button><button className="button button-secondary button-small" onClick={save}><Check size={12} />Save {version.toLowerCase()}</button></> : <><button className="button button-quiet button-small" onClick={generate} disabled={generating}>{generating ? <LoaderCircle size={12} className="spin" /> : <WandSparkles size={12} />}{generating ? 'Generating…' : 'Generate 3 versions'}</button><button className="button button-secondary button-small" onClick={() => setEditing(true)}><FileText size={12} />Edit</button></>}<button className="button button-secondary button-small" onClick={copy} disabled={!hasEmail || generating}><Copy size={12} />Copy {version.toLowerCase()}</button>{!contacted && !attemptOpen && <button className="button button-primary button-small" onClick={openAttemptForm} disabled={generating}><CheckCircle2 size={12} />Record attempt</button>}</div>{attemptOpen && !contacted && <div className="attempt-form"><label><span>Channel</span><select value={attemptChannel} onChange={(event) => setAttemptChannel(event.target.value)}>{['email', 'phone', 'maps', 'in-person', 'other'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Contact used</span><input value={attemptContact} onChange={(event) => setAttemptContact(event.target.value)} placeholder="Who or where you reached out to" /></label><label><span>Outcome</span><select value={attemptOutcome} onChange={(event) => setAttemptOutcome(event.target.value)}><option value="">Select outcome…</option>{ATTEMPT_OUTCOMES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Notes</span><input value={attemptNotes} onChange={(event) => setAttemptNotes(event.target.value)} placeholder="Optional" /></label><div><button className="button button-quiet button-small" onClick={() => setAttemptOpen(false)}>Cancel</button><button className="button button-primary button-small" onClick={recordAttempt} disabled={!attemptOutcome || attemptBusy}>{attemptBusy ? 'Saving…' : 'Save attempt'}</button></div><small>Only reached outcomes (conversation, reply, meeting) mark the client contacted.</small></div>}</section>
      </div>
    </article>
  )
}

function OutreachPage({ leads, onOpen, onUpdate, onAttempt, onGenerate, onCandidate, onToast }) {
  const [view, setView] = useState('All')
  const [selectedId, setSelectedId] = useState(null)
  // Suppressed, Won and Lost leads never enter the outreach queue.
  const qualified = leads.filter((lead) => isQualifiedLead(lead) && !['Won', 'Lost'].includes(lead.salesStage) && !lead.doNotContact?.status)
  const contacted = qualified.filter(isContacted)
  const ready = qualified.filter((lead) => !isContacted(lead))
  const needsDraft = ready.filter((lead) => getOutreachState(lead) === 'Needs draft')
  const views = [{ label: 'All', count: qualified.length, tone: 'all' }, { label: 'Ready to contact', count: ready.length, tone: 'orange' }, { label: 'Needs draft', count: needsDraft.length, tone: 'gray' }, { label: 'Contacted', count: contacted.length, tone: 'blue' }]
  const visible = view === 'Ready to contact' ? ready : view === 'Needs draft' ? needsDraft : view === 'Contacted' ? contacted : qualified
  const selected = visible.find((lead) => lead.id === selectedId) || visible[0]
  useEffect(() => { if (visible.length && !visible.some((lead) => lead.id === selectedId)) setSelectedId(visible[0].id) }, [visible, selectedId])
  return (
    <>
      <PageHeader eyebrow="Outreach queue" title="Say less. Make it relevant." description="Review a draft, copy it into your chosen channel, then mark the client contacted.">
        <div className="outreach-guard"><ShieldCheck size={14} /><span><strong>Manual send only</strong><small>Review every draft before it leaves.</small></span></div>
      </PageHeader>
      <section className="panel outreach-panel">
        <div className="outreach-toolbar"><div><h2>Qualified clients</h2><span>{ready.length} waiting for a first message</span></div><div className="view-tabs" role="tablist" aria-label="Outreach views">{views.map((item) => <button role="tab" aria-selected={view === item.label} key={item.label} className={view === item.label ? 'active' : ''} onClick={() => setView(item.label)}><i className={`filter-dot filter-dot-${item.tone}`} /><span>{item.label}</span><em>{item.count}</em></button>)}</div></div>
        {visible.length ? <div className="outreach-master-detail"><div className="outreach-queue-list" role="listbox" aria-label="Qualified clients">{visible.map((lead) => <button key={lead.id} role="option" aria-selected={selected?.id === lead.id} className={selected?.id === lead.id ? 'active' : ''} onClick={() => setSelectedId(lead.id)}><Avatar name={lead.company} /><span><strong>{lead.company}</strong><small>{getOutreachState(lead)}</small></span><ChevronRight size={12} /></button>)}</div><div className="outreach-selected"><OutreachCard key={selected?.id} lead={selected} onOpen={onOpen} onUpdate={onUpdate} onAttempt={onAttempt} onGenerate={onGenerate} onCandidate={onCandidate} onToast={onToast} /></div></div> : <div className="empty-state"><Mail size={21} /><h3>No clients in this view</h3><p>Qualify a client in Research to prepare an outreach draft.</p></div>}
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
  const move = (id, stage) => { if (id) onUpdate(id, { salesStage: stage }); setDragging(null) }
  return (
    <>
      <PageHeader eyebrow="Client pipeline" title="Move the relationship forward." description="Track sales progress, follow-ups, and next actions. Research details stay on the client record.">
        <button className="button button-secondary" onClick={() => goTo('Outreach')}><Mail size={13} />Open outreach queue</button>
      </PageHeader>
      <div className="view-tabs" role="tablist" aria-label="Pipeline views">{['Board', 'Follow-ups'].map((item) => <button role="tab" aria-selected={boardView === item} key={item} className={boardView === item ? 'active' : ''} onClick={() => setBoardView(item)}><span>{item}</span></button>)}</div>
      {boardView === 'Follow-ups' ? <FollowupsView leads={leads} onOpen={onOpen} onUpdate={onUpdate} /> : <>
      <section className="simple-summary pipeline-numbers">
        <div><strong>{pipeline.filter(isOpenPipelineLead).length}</strong><span>Open opportunities</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Meeting').length}</strong><span>Meetings</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Proposal').length}</strong><span>Proposals</span></div>
        <div><strong>{pipeline.filter((lead) => lead.salesStage === 'Won').length}</strong><span>Won clients</span></div>
      </section>
      <div className="pipeline-stage-tabs" role="tablist" aria-label="Pipeline stages">{pipelineStages.map((stage) => <button key={stage} role="tab" aria-selected={selectedStage === stage} className={selectedStage === stage ? 'active' : ''} onClick={() => setSelectedStage(stage)}><span>{stage}</span><em>{pipeline.filter((lead) => lead.salesStage === stage).length}</em></button>)}</div>
      <div className="kanban-wrap"><div className="kanban-board">{pipelineStages.map((stage) => {
        const clients = pipeline.filter((lead) => lead.salesStage === stage)
        return <section className={cn('kanban-column', `stage-${stage.toLowerCase()}`, selectedStage !== stage && 'is-unselected', dragging && 'kanban-drop-ready')} key={stage} onDragOver={(event) => event.preventDefault()} onDrop={() => move(dragging, stage)}><div className="kanban-heading"><Badge tone={statusTone[stage]} dot>{stage}</Badge><span>{clients.length}</span></div><div className="kanban-list">{clients.map((lead) => <article className="pipeline-card" key={lead.id} draggable onDragStart={() => setDragging(lead.id)} onDragEnd={() => setDragging(null)}><button className="pipeline-card-main" onClick={() => onOpen(lead)}><div><Score value={lead.opportunityScore} /><span className="pipeline-next-action">{getNextAction(lead)}</span></div><h3>{lead.company}</h3><p>{lead.mainIssue}</p></button><div className="pipeline-card-foot"><StagePicker lead={lead} onChange={(nextStage) => move(lead.id, nextStage)} />{stage === 'Won' ? <button className="contract-link" onClick={() => onContract(lead)}>{lead.contract ? 'Contract' : 'Add contract'}</button> : <span>{lead.nextAction || lead.updated || 'Set next action'}</span>}</div></article>)}{clients.length === 0 && <div className="kanban-empty">No clients here</div>}</div></section>
      })}</div></div>
      <div className="pipeline-lost-note"><CircleAlert size={13} /><span>Lost clients are closed separately from this active pipeline.</span><button className="button button-quiet button-small" onClick={() => goTo('Clients')}>View clients</button></div>
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
      <PageHeader eyebrow="Contracts" title="From agreement to kickoff." description="Record the value, scope, terms, and next step after a client says yes.">
        <button className="button button-secondary" onClick={() => goTo('Pipeline')}><LayoutGrid size={13} />Open pipeline</button>
      </PageHeader>
      <section className="simple-summary won-summary">
        <div><strong>{won.length}</strong><span>Won clients</span></div>
        <div><strong>{won.filter((lead) => !lead.contract).length}</strong><span>Details needed</span></div>
        <div><strong>{Object.entries(wonTotals).map(([code, total]) => currency(total, code)).join(' · ') || currency(0)}</strong><span>Recorded value by currency</span></div>
        <div><strong>{won.filter((lead) => lead.contract?.startDate).length}</strong><span>Start dates set</span></div>
      </section>
      {won.length ? <section className="won-grid">{won.map((lead) => <article className={cn('panel won-card', !lead.contract && 'contract-needs-details')} key={lead.id}><div className="won-card-head"><div><Avatar name={lead.company} /><span><h2>{lead.company}</h2><small>{lead.category} · {lead.location}</small></span></div><Badge tone={lead.contract ? 'green' : 'amber'}><CheckCircle2 size={11} />{lead.contract ? 'Contract recorded' : 'Details needed'}</Badge></div><div className="contract-value"><span>Approved value</span><strong>{currency(lead.contract?.amount, lead.contract?.currency)}</strong></div><dl><div><dt>Scope</dt><dd>{lead.contract?.scope || 'Not recorded'}</dd></div><div><dt>Terms</dt><dd>{lead.contract?.terms || 'Not recorded'}</dd></div><div><dt>Start date</dt><dd>{lead.contract?.startDate || 'Not set'}</dd></div><div><dt>Next step</dt><dd>{lead.contract?.nextStep || 'Not set'}</dd></div></dl><div className="won-card-actions"><button className="button button-secondary button-small" onClick={() => onOpen(lead)}>View client</button><button className="button button-primary button-small" onClick={() => onContract(lead)}>{lead.contract ? 'Edit contract' : 'Add contract details'}</button></div></article>)}</section> : <section className="panel empty-won"><Trophy size={24} /><h2>No won clients yet</h2><p>Move a client to Won on the pipeline, then record the contract details here.</p><button className="button button-primary" onClick={() => goTo('Pipeline')}>Open pipeline <ArrowRight size={12} /></button></section>}
    </>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
  const handleField = (key, parse) => (event) => {
    const raw = event.target.value
    const val = parse ? parse(raw) : raw
    setDraft((c) => ({ ...c, [key]: val }))
    if (fieldErrors[key] || fieldErrors._general) setFieldErrors((p) => { const n = { ...p }; delete n[key]; delete n._general; return n })
  }
  const handleBlur = (key) => () => setTouched((p) => ({ ...p, [key]: true }))
  const save = async () => {
    setSubmitted(true)
    setTouched({ defaultLocation: true, resultLimit: true, deepAuditLimit: true, discoveryLatitude: true, discoveryLongitude: true })
    const v = validateSettingsDraft(draft)
    if (!v.isValid) { setFieldErrors(v.errors); return }
    setSaving(true)
    setFieldErrors({})
    try {
      const saved = await onSave(draft)
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
      <PageHeader eyebrow="Workspace" title="Simple defaults." description="Only the settings needed for day-to-day research are shown here." />
      <section className="panel minimal-settings">
        <div><h2>Research defaults</h2><p>Used when a new collection run starts.</p></div>
        <div className="minimal-form"><label><span>Default location *</span><input value={draft.defaultLocation || ''} onChange={handleField('defaultLocation')} onBlur={handleBlur('defaultLocation')} style={show('defaultLocation') ? errStyle : undefined} className={show('defaultLocation') ? 'input-error' : undefined} aria-invalid={Boolean(show('defaultLocation'))} />{show('defaultLocation') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.defaultLocation}</span>}</label><div><label><span>Clients per run (1-50)</span><input type="number" min="1" max="50" value={draft.resultLimit || 25} onChange={handleField('resultLimit', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('resultLimit')} style={show('resultLimit') ? errStyle : undefined} className={show('resultLimit') ? 'input-error' : undefined} aria-invalid={Boolean(show('resultLimit'))} />{show('resultLimit') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.resultLimit}</span>}</label><label><span>Website audits (1-25)</span><input type="number" min="1" max="25" value={draft.deepAuditLimit || 10} onChange={handleField('deepAuditLimit', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('deepAuditLimit')} style={show('deepAuditLimit') ? errStyle : undefined} className={show('deepAuditLimit') ? 'input-error' : undefined} aria-invalid={Boolean(show('deepAuditLimit'))} />{show('deepAuditLimit') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.deepAuditLimit}</span>}</label></div><div><label><span>Discovery latitude (-90 to 90)</span><input type="number" step="any" value={draft.discoveryLatitude ?? ''} onChange={handleField('discoveryLatitude', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('discoveryLatitude')} style={show('discoveryLatitude') ? errStyle : undefined} className={show('discoveryLatitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('discoveryLatitude'))} />{show('discoveryLatitude') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.discoveryLatitude}</span>}</label><label><span>Discovery longitude (-180 to 180)</span><input type="number" step="any" value={draft.discoveryLongitude ?? ''} onChange={handleField('discoveryLongitude', (v) => v === '' ? '' : Number(v))} onBlur={handleBlur('discoveryLongitude')} style={show('discoveryLongitude') ? errStyle : undefined} className={show('discoveryLongitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('discoveryLongitude'))} />{show('discoveryLongitude') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.discoveryLongitude}</span>}</label></div>{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{fieldErrors._general}</div>}<button className="button button-primary" onClick={save} disabled={saving}>{saving ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}{saving ? 'Saving…' : 'Save settings'}</button></div>
      </section>
      <section className="panel connection-status"><Database size={18} /><div><strong>Local SQLite storage</strong><span>{apiStatus?.databasePath || 'data/scoutline.db'}</span></div><Badge tone="green">Healthy</Badge></section>
      <section className="panel connection-status"><WandSparkles size={18} /><div><strong>Live discovery</strong><span>{apiStatus?.brightDataAdapterReady ? `Bright Data Google Maps is ready · provider requests capped at ${apiStatus.brightDataMaxRecords || 25} records.` : 'Add BRIGHT_DATA_API_KEY to use live discovery; runs currently audit saved clients.'}</span></div><Badge tone={apiStatus?.brightDataAdapterReady ? 'green' : 'amber'}>{apiStatus?.brightDataAdapterReady ? 'Ready' : 'Local'}</Badge></section>
      <section className="panel connection-status"><Bot size={18} /><div><strong>Outreach generation</strong><span>{apiStatus?.outreachConfigured ? `${apiStatus.outreachProviderLabel} · ${apiStatus.outreachModel} will generate all three evidence-based email versions.` : 'No model API key found; the same endpoint uses deterministic evidence templates.'}</span></div><Badge tone={apiStatus?.outreachConfigured ? 'green' : 'gray'}>{apiStatus?.outreachConfigured ? 'Ready' : 'Fallback'}</Badge></section>
    </>
  )
}

function MuseSynthesis({ lead, onAnalyze, onUpdate }) {
  const analysis = lead.museAnalysis
  const status = analysis?.status || 'Not generated'
  const active = ['Queued', 'Running'].includes(status) || ['Queued', 'Running'].includes(lead.museJob?.status)
  const recommendationTone = analysis?.qualificationRecommendation === 'Pursue' ? 'green' : analysis?.qualificationRecommendation === 'Review' ? 'amber' : 'gray'
  return <section className={cn('muse-card', status === 'Failed' && 'has-failed')}>
    <div className="muse-card-head"><div><span className="muse-mark"><Bot size={14} /></span><span><strong>Muse synthesis</strong><small>Grounded in the saved crawl and Lighthouse evidence</small></span></div>{analysis?.status === 'Completed' ? <Badge tone={recommendationTone} dot>{analysis.qualificationRecommendation}</Badge> : <Badge tone={statusTone[status] || 'gray'} dot>{active ? lead.museJob?.phase || status : status}</Badge>}</div>
    {analysis?.status === 'Completed' ? <><p className="muse-summary">{analysis.summary}</p><div className="muse-opportunities">{(analysis.topOpportunities || []).slice(0, 4).map((item) => <article key={`${item.title}-${item.evidence}`}><span className={cn('muse-severity', `is-${item.severity.toLowerCase()}`)}>{item.severity}</span><div><strong>{item.title}</strong><p>{item.evidence}</p><small>{item.recommendation}</small></div></article>)}</div><div className="muse-foot"><span><b>{analysis.strengths?.length || 0}</b> strengths</span><span><b>{analysis.unknowns?.length || 0}</b> unknowns</span>{analysis?.stale && <span className="stale-badge">Stale — a newer audit completed</span>}<span>Muse does not change the score</span>{analysis?.stale && <button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { museStale: false })}>Mark reviewed</button>}<button className="button button-quiet button-small" onClick={() => onAnalyze(lead)}><RefreshCcw size={11} />Regenerate</button></div></> : <div className="muse-empty"><div><strong>{status === 'Failed' ? 'Muse could not finish this synthesis' : active ? 'Muse is reviewing the evidence' : 'Add a second layer of reasoning'}</strong><p>{status === 'Failed' ? analysis.error : active ? 'The deterministic score remains available while this runs.' : 'Muse will prioritize the measured issues, explain why they matter, and suggest factual outreach angles.'}</p></div><button className="button button-secondary button-small" disabled={active} onClick={() => onAnalyze(lead)}>{active ? <LoaderCircle className="spin" size={12} /> : <WandSparkles size={12} />}{active ? 'Analyzing' : status === 'Failed' ? 'Retry Muse' : 'Analyze with Muse'}</button></div>}
  </section>
}

function FindingReviewRow({ item, review, stale, onReview }) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  if (stale) return <div className="finding-row is-stale"><span>Superseded</span><p><strong>{item.finding?.detail || item.findingKey}</strong><small>Reviewed under an older audit — kept for history, excluded from readiness.</small></p></div>
  if (review) return <div className={cn('finding-row', review.decision === 'accepted' && 'is-accepted')}><span>{review.decision === 'accepted' ? <CheckCircle2 size={14} /> : <X size={14} />}</span><p><strong>{item.finding?.detail || item.findingKey}</strong><small>{review.decision} {review.at ? `· ${new Date(review.at).toLocaleString()}` : ''}{review.by ? ` · ${review.by}` : ''}{review.reason ? ` — ${review.reason}` : ''}</small></p></div>
  return <div className="finding-row"><span><CircleAlert size={14} /></span><p><strong>{item.detail}</strong>{item.evidence && <small>Evidence: {item.evidence}</small>}</p><div>{!rejecting ? <><button className="button button-secondary button-small" disabled={busy} onClick={async () => { setBusy(true); await onReview({ findingKey: item.key, decision: 'accepted' }); setBusy(false) }}>Accept</button><button className="button button-quiet button-small" onClick={() => setRejecting(true)}>Reject</button></> : <><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this finding wrong?" /><button className="button button-quiet button-small" onClick={() => { setRejecting(false); setReason('') }}>Cancel</button><button className="button button-secondary button-small" disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); await onReview({ findingKey: item.key, decision: 'rejected', reason: reason.trim() }); setBusy(false) }}>Save rejection</button></>}</div></div>
}

function BriefTab({ lead, onUpdate, onReview, fetchBrief, onBriefExport, onToast }) {
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  const [rationale, setRationale] = useState(lead.briefRationale?.text || '')
  const [taskType, setTaskType] = useState(lead.nextTask?.type || 'follow-up')
  const [taskDue, setTaskDue] = useState(lead.nextTask?.dueAt || '')
  const [taskOwner, setTaskOwner] = useState(lead.nextTask?.owner || '')
  const [taskNote, setTaskNote] = useState(lead.nextTask?.note || '')
  const [suppressReason, setSuppressReason] = useState('')
  const [suppressScope, setSuppressScope] = useState('business')
  useEffect(() => {
    let live = true
    setLoading(true)
    fetchBrief(lead.id).then((result) => { if (live) { setBrief(result); setLoading(false) } })
    return () => { live = false }
  }, [lead.id, lead.rev, lead.findingReviews, lead.currentAuditId, lead.qualified, lead.doNotContact, lead.salesStage])
  useEffect(() => { setRationale(lead.briefRationale?.text || '') }, [lead.id, lead.briefRationale?.at])
  if (loading || !brief) return <p className="lead-summary">Loading brief…</p>
  const { readiness, reviews } = brief
  const copyBrief = async () => {
    const markdown = await onBriefExport(lead.id)
    if (!markdown) return
    try { await navigator.clipboard.writeText(markdown); onToast('Brief copied — reviewed findings only') }
    catch { onToast({ message: 'Could not copy the brief', tone: 'error' }) }
  }
  return <div className="brief-tab">
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Outreach readiness</span><Badge tone={readiness.ready ? 'green' : 'amber'} dot>{readiness.ready ? 'Ready' : 'Not ready'}</Badge></div>
      {readiness.blocks.length ? <div className="problem-list">{readiness.blocks.map((block) => <div key={block.code}><span><CircleAlert size={13} /></span><p>{block.message}</p></div>)}</div> : <p className="lead-summary">Qualified, reviewed, reachable and unsuppressed.</p>}
      {readiness.warnings.length ? <p className="lead-summary">{readiness.warnings.map((w) => w.message).join(' ')}</p> : null}
      <p className="lead-summary">Channel: {readiness.channels.map((c) => (c.kind === 'email' || c.kind === 'phone' ? `${c.kind}: ${c.value}` : c.value)).join('; ') || 'none identified'}{readiness.unknowns.length ? ` · Unknown: ${readiness.unknowns.join(', ')}` : ''}</p>
    </section>
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Finding reviews</span><Badge tone="gray">{reviews.accepted.length} accepted · {reviews.pending.length} pending</Badge></div>
      <div className="finding-list">{reviews.pending.map((item) => <FindingReviewRow key={item.key} item={item} onReview={(review) => onReview(lead.id, review)} />)}</div>
      {reviews.accepted.map((item) => <FindingReviewRow key={item.findingKey} item={item} review={item} onReview={(review) => onReview(lead.id, review)} />)}
      {reviews.rejected.map((item) => <FindingReviewRow key={item.findingKey} item={item} review={item} onReview={(review) => onReview(lead.id, review)} />)}
      {reviews.stale.map((item) => <FindingReviewRow key={`${item.findingKey}-${item.at}`} item={item} stale onReview={() => null} />)}
    </section>
    <section className="detail-section"><span className="detail-label">Manual rationale</span>
      <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Human judgment the software cannot see — labelled manual, kept across refreshes." />
      <div><button className="button button-secondary button-small" disabled={!rationale.trim()} onClick={() => onUpdate(lead.id, { briefRationale: { text: rationale.trim(), by: 'Rohan' } })}>Save rationale</button>{lead.briefRationale?.text && <small> Saved {lead.briefRationale.at ? new Date(lead.briefRationale.at).toLocaleString() : ''} · manual, retained across refresh.</small>}</div>
    </section>
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Next follow-up</span>{lead.nextTask?.status === 'open' && <Badge tone="orange" dot>{lead.nextTask.dueAt || 'no date'}</Badge>}</div>
      <div className="task-editor"><label><span>Type</span><select value={taskType} onChange={(event) => setTaskType(event.target.value)}>{NEXT_TASK_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Due</span><input type="date" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} /></label><label><span>Owner</span><select value={taskOwner} onChange={(event) => setTaskOwner(event.target.value)}><option value="">Unassigned</option>{TASK_OWNERS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Note</span><input value={taskNote} onChange={(event) => setTaskNote(event.target.value)} placeholder="Optional" /></label></div>
      <div><button className="button button-secondary button-small" onClick={() => onUpdate(lead.id, { nextTask: { type: taskType, dueAt: taskDue || null, status: 'open', owner: taskOwner, note: taskNote } })}>Save follow-up</button>{lead.nextTask?.status === 'open' && <button className="button button-quiet button-small" onClick={() => onUpdate(lead.id, { nextTask: { ...lead.nextTask, status: 'cleared' } })}>Clear</button>}</div>
    </section>
    <section className="detail-section"><div className="detail-heading"><span className="detail-label">Contact suppression</span>{lead.doNotContact?.status ? <Badge tone="red">Suppressed</Badge> : <Badge tone="gray">Not suppressed</Badge>}</div>
      {lead.doNotContact?.status
        ? <><p className="lead-summary">{lead.doNotContact.reason}{lead.doNotContact.at ? ` · since ${new Date(lead.doNotContact.at).toLocaleDateString()}` : ''} · survives reimport, refresh and merges.</p><button className="button button-secondary button-small" onClick={() => onUpdate(lead.id, { doNotContact: { status: false, reason: '' } })}>Reopen explicitly</button></>
        : <><div className="task-editor"><label><span>Reason (required)</span><input value={suppressReason} onChange={(event) => setSuppressReason(event.target.value)} placeholder="e.g. Asked to stop calling" /></label><label><span>Scope</span><select value={suppressScope} onChange={(event) => setSuppressScope(event.target.value)}><option value="business">Business</option><option value="contact">Contact</option></select></label></div><button className="button button-secondary button-small" disabled={!suppressReason.trim()} onClick={() => onUpdate(lead.id, { doNotContact: { status: true, reason: suppressReason.trim(), scope: suppressScope } })}>Suppress contact</button></>}
    </section>
    {(lead.contactAttempts || []).length > 0 && <section className="detail-section"><div className="detail-heading"><span className="detail-label">Contact attempts</span><Badge tone="gray">{lead.contactAttempts.length}</Badge></div><div className="problem-list">{[...lead.contactAttempts].reverse().map((attempt) => <div key={attempt.id}><span>{attempt.channel}</span><p><strong>{attempt.outcome}</strong>{attempt.contact ? ` · ${attempt.contact}` : ''}{attempt.notes ? ` — ${attempt.notes}` : ''}<small>{attempt.at ? new Date(attempt.at).toLocaleString() : ''}</small></p></div>)}</div></section>}
    <section className="detail-section"><span className="detail-label">Client-facing brief</span><p className="lead-summary">Reviewed findings only. Scores and commercial estimates are always omitted.</p><button className="button button-primary button-small" onClick={copyBrief} disabled={!reviews.accepted.length}><Copy size={12} />Copy brief</button></section>
  </div>
}

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
    <div className="intelligence-signals"><span><CheckCircle2 size={11} />{intelligence.claimed ? 'Google profile claimed' : 'Claim status unknown'}</span><span><CalendarDays size={11} />{intelligence.onlineBooking ? 'Online booking detected' : intelligence.onlineEstimates ? 'Online estimates offered' : 'No online booking detected'}</span><span><Star size={11} />{intelligence.positiveReviewShare != null ? `${intelligence.positiveReviewShare}% positive reviews` : 'Review mix unknown'}</span><span><Clock3 size={11} />Latest sampled review {latestReview}</span></div>
    <p className="intelligence-note"><ShieldCheck size={11} />Unknown fields stay unknown until a named source supplies them. Muse cannot estimate them.</p>
  </section>
}

const clientRunActions = [
  { id: 'refresh', label: 'Refresh business data', description: 'Fetch this Google Maps record again with Bright Data.', icon: Database },
  { id: 'audit', label: 'Run website audit', description: 'Crawl the site, check links, and rerun Lighthouse.', icon: Activity },
  { id: 'muse', label: 'Run Muse analysis', description: 'Synthesize the saved audit evidence and recommendation.', icon: Bot },
  { id: 'outreach', label: 'Generate outreach', description: 'Create concise, balanced, and detailed email drafts.', icon: Mail },
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

function ClientRunMenu({ lead, onRun, brightDataReady }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(null)
  useEffect(() => { setOpen(false); setPending(null) }, [lead.id])
  const active = ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status)
  const invoke = async (action) => {
    setPending(action)
    const updated = await onRun(lead, action)
    setPending(null)
    if (updated) setOpen(false)
  }
  const unavailable = (action) => action === 'refresh' ? !brightDataReady || !lead.sourceUrl : ['muse', 'outreach'].includes(action) ? lead.opportunityScore == null : false
  return <div className="client-run-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button className={cn('button button-secondary button-small client-run-trigger', active && 'is-running')} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} disabled={Boolean(pending)}>{active ? <LoaderCircle className="spin" size={12} /> : <Play size={12} />}<span>{active ? 'Running' : 'Run'}</span><ChevronDown size={10} /></button>
    {open && <div className="client-run-popover" role="menu">
      <header><div><strong>Run for this client</strong><small>{active ? lead.manualRun.phase : `${lead.manualRun?.label || 'Manual control'} · ${runTimestamp(lead.manualRun)}`}</small></div>{active && <Badge tone="orange">{lead.manualRun.progress || 0}%</Badge>}</header>
      <button className="full-run-action" role="menuitem" type="button" onClick={() => invoke('full')} disabled={active || Boolean(pending)}><span><WandSparkles size={15} /></span><div><strong>Run full workflow</strong><small>Refresh data when available, then audit, Muse, and outreach.</small></div>{pending === 'full' ? <LoaderCircle className="spin" size={12} /> : <ArrowRight size={12} />}</button>
      <div className="run-action-list">{clientRunActions.map(({ id, label, description, icon: Icon }) => <button key={id} role="menuitem" type="button" onClick={() => invoke(id)} disabled={active || Boolean(pending) || unavailable(id)} title={unavailable(id) ? id === 'refresh' ? 'Requires a saved Google Maps source and Bright Data' : 'Run the website audit first' : undefined}><span><Icon size={14} /></span><div><strong>{label}</strong><small>{unavailable(id) ? id === 'refresh' ? 'Unavailable for this client' : 'Website audit required first' : description}</small></div>{pending === id ? <LoaderCircle className="spin" size={12} /> : <ChevronRight size={12} />}</button>)}</div>
      <footer><ShieldCheck size={11} />Nothing is sent to the client automatically.</footer>
    </div>}
  </div>
}

function ManualRunStatus({ lead, onRun }) {
  const run = lead.manualRun
  if (!run) return null
  const active = ['Queued', 'Running', 'Waiting'].includes(run.status)
  const failed = run.status === 'Failed'
  return <section className={cn('manual-run-status', active && 'is-active', failed && 'is-failed')} aria-live="polite">
    <span>{active ? <LoaderCircle className="spin" size={14} /> : failed ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}</span>
    <div><small>Manual run</small><strong>{run.label}</strong><em>{run.phase} · {active ? `${run.progress || 0}%` : runTimestamp(run)}</em></div>
    {active && <i><b style={{ width: `${run.progress || 0}%` }} /></i>}
    {failed && <button className="button button-secondary button-small" onClick={() => onRun(lead, run.action)}><RefreshCcw size={11} />Retry</button>}
  </section>
}

function LeadDrawer({ lead, runs, close, onExport, onUpdate, onAnalyze, onMuseAnalyze, onRunAction, onReview, fetchBrief, onBriefExport, brightDataReady, onToast, onContract, onInsight, onFailure, onOutreach }) {
  const [tab, setTab] = useState('Summary')
  const [noteDraft, setNoteDraft] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => { setTab('Summary'); setEditing(false); setNoteDraft(lead?.notes || '') }, [lead?.id])
  if (!lead) return null
  const { done, failure, phase } = researchState(lead)
  const pitch = outreachBody(lead)
  const currentSalesIndex = pipelineStages.indexOf(lead.salesStage)
  const origin = leadRunInfo(lead, runs)
  const originLabel = origin.collectionRun ? `Added in ${runLabel(origin.collectionRun)}` : lead.labels?.includes('CSV import') ? 'Manual import' : 'Existing client'
  return (
    <div className="drawer-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <aside className="lead-drawer simple-drawer">
        <div className="drawer-top"><div><Badge tone={categoryTone[lead.category] || 'gray'}>{lead.category}</Badge><span>{lead.id.toUpperCase()}</span></div><div><ClientRunMenu lead={lead} onRun={onRunAction} brightDataReady={brightDataReady} /><IconButton label="Open website" onClick={() => window.open(`https://${lead.website}`, '_blank', 'noopener,noreferrer')}><ExternalLink size={14} /></IconButton><IconButton label="Close client" onClick={close}><X size={16} /></IconButton></div></div>
        <div className="drawer-hero"><div><h1>{lead.company}</h1><div className="drawer-hero-meta"><a className="drawer-address-link" href={mapsUrl(lead)} target="_blank" rel="noreferrer" aria-label={`Open ${lead.company} address in Google Maps`}><MapPin size={12} aria-hidden="true" /><span className="drawer-address-value">{lead.address || lead.location || 'Address not collected'}</span><span className="drawer-address-action">Open in Google Maps <ExternalLink size={10} aria-hidden="true" /></span></a>{websiteUrl(lead.website) ? <a href={websiteUrl(lead.website)} target="_blank" rel="noreferrer" aria-label={`Open ${lead.company} website`}><Globe2 size={12} aria-hidden="true" /><span>{lead.website}</span></a> : <span className="drawer-hero-missing">Website not collected</span>}</div><div className="drawer-run-origin"><Database size={11} /><span><strong>{originLabel}</strong><small>{origin.collectionRun ? `${runTimestamp(origin.collectionRun)} · ${origin.collection?.relationship === 'new' ? 'New client' : 'Matched client'}` : 'No research run recorded'}</small></span></div></div><div className="hero-score"><Score value={lead.opportunityScore} size="hero" /><span>Opportunity<small>{lead.confidence ? `${lead.confidence}% confidence` : 'Not analyzed'}</small></span></div></div>
        <div className="drawer-status-strip"><span><small>Research</small><Badge tone={failure ? 'red' : phase === 2 ? 'purple' : 'blue'} dot>{getResearchLabel(lead)}</Badge></span><span><small>Muse</small><Badge tone={getMuseGuidance(lead) === 'Pursue' ? 'green' : getMuseGuidance(lead) === 'Deprioritize' ? 'gray' : 'amber'} dot>{getMuseGuidance(lead) || 'Not run'}</Badge></span><span><small>Sales</small><Badge tone={lead.salesStage ? statusTone[lead.salesStage] : 'gray'} dot>{lead.salesStage || 'Not in sales'}</Badge></span></div>
        <div className="drawer-tabs">{['Summary', 'Research', 'Brief', 'Sales'].map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
        <div className="drawer-body">
          {tab === 'Summary' && <div className="drawer-two-col"><main><section className="detail-section"><span className="detail-label">Main opportunity</span><h2>{lead.mainIssue}</h2><p className="lead-summary">{lead.issueDetail}</p></section><section className="detail-section"><div className="detail-heading"><span className="detail-label">Findings</span><Badge tone="gray">{lead.problems?.length || 0}</Badge></div><div className="problem-list">{lead.problems?.length ? lead.problems.map((problem, index) => <div key={problem}><span>{index + 1}</span><p>{problem}</p></div>) : <p className="lead-summary">Website analysis has not been completed yet.</p>}</div></section><BusinessIntelligence lead={lead} /></main><aside><div className="business-card"><span className="detail-label">Client profile</span><div><span>Rating</span><strong>{lead.rating} ★ · {lead.reviews} reviews</strong></div><div><span>Phone</span><strong>{lead.phone}</strong></div><div><span>Email</span><strong>{lead.email}</strong></div><div><span>Sales phase</span><strong>{lead.salesStage || 'Not in pipeline'}</strong></div></div><div className="notes-card"><span className="detail-label">Notes</span>{editing ? <><textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} /><div className="note-actions"><button onClick={() => setEditing(false)}>Cancel</button><button onClick={async () => { const saved = await onUpdate(lead.id, { notes: noteDraft.trim() }); if (saved) setEditing(false) }}><Check size={11} />Save</button></div></> : <><p>{lead.notes || 'No notes yet.'}</p><button onClick={() => setEditing(true)}><Plus size={12} />{lead.notes ? 'Edit note' : 'Add note'}</button></>}</div></aside></div>}
          {tab === 'Research' && <div className="research-detail">
            <div className="research-detail-head">
              <div><span className="detail-label">{failure ? 'Failed stage' : 'Research state'}</span><h2 className={failure ? 'failure-title' : ''}>{getResearchLabel(lead)}</h2><p>{failure?.reason || (isQualifiedLead(lead) ? 'Research is complete. Sales progress is tracked separately.' : 'Review the evidence and Muse guidance before deciding whether to qualify this client.')}</p></div>
              {failure ? <button className="button button-secondary retry-button" onClick={() => onAnalyze(lead)}><RefreshCcw size={13} />Retry audit</button>
                : !done[1] ? <button className="button button-primary" onClick={() => onAnalyze(lead)} disabled={['Queued', 'Analyzing'].includes(lead.researchStatus)}>{['Queued', 'Analyzing'].includes(lead.researchStatus) ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}{['Queued', 'Analyzing'].includes(lead.researchStatus) ? lead.researchJob?.phase || lead.researchStatus : 'Analyze website'}</button>
                  : !isQualifiedLead(lead) ? <button className="button button-primary" onClick={() => onUpdate(lead.id, { qualified: true, salesStage: 'Qualified' })}><CheckCircle2 size={13} />Qualify for outreach</button>
                    : <Badge tone="purple" dot>In sales</Badge>}
            </div>
            <ManualRunStatus lead={lead} onRun={onRunAction} />
            {lead.researchStatus === 'Inconclusive' && <div className="candidate-banner"><span><strong>Latest capture inconclusive — no score claimed.</strong><small> {lead.captureQuality?.reason || lead.lastAuditAttempt?.reason || 'The page could not be assessed.'} Method: {lead.captureQuality?.captureMethod || 'static-fetch'}{lead.captureQuality?.renderedFallback ? ` · rendered fallback: ${lead.captureQuality.renderedFallback}` : ''}{lead.lastSuccessfulAudit ? ` · Last successful audit ${lead.lastSuccessfulAudit.score}/100 (${auditAge(lead.lastSuccessfulAudit.at)}).` : ' · No successful audit yet.'} The business stays available for manual qualification.</small></span><div><button className="button button-secondary button-small" onClick={() => onAnalyze(lead)}>Retry audit</button></div></div>}
            <div className="research-checklist">{researchLabels.map((label, index) => {
              const failed = failure?.stage === index
              const detail = failed ? failure.reason
                : index === 0 ? `${lead.company} and contact data saved`
                    : index === 1 ? done[index] ? `${lead.opportunityScore}/100 score · ${lead.confidence || '—'}% confidence · ${lead.evidence?.length || 0} evidence points` : 'Website evidence and opportunity scoring are not complete'
                    : done[index] ? lead.museAnalysis?.status === 'Completed' ? `${getMuseGuidance(lead) || 'Review manually'} guidance saved for your decision` : 'Evidence is ready for your decision' : 'Waiting for a completed analysis'
              return <article key={label} className={cn(done[index] && 'complete', failed && 'failed')}><span>{failed ? <X size={13} /> : done[index] ? <Check size={13} /> : index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div></article>
            })}</div>
            {lead.auditHistory?.length > 0 && <div className="audit-history"><span className="detail-label">Audit history</span><ol>{[...lead.auditHistory].reverse().map((item) => <li key={item.auditId || `${item.jobId}-${item.at}`}><strong>{item.auditId === lead.currentAuditId ? 'Current' : item.version != null ? `v${item.version}` : 'legacy'}</strong><small>{item.auditId || 'unversioned'} · {item.at ? new Date(item.at).toLocaleString() : 'unknown date'} · {item.score ?? '—'}/100</small></li>)}</ol></div>}{done[1] && <div className="audit-metrics deep-audit-metrics"><article><Activity size={15} /><span>Lighthouse performance</span><strong>{lead.performance ?? '—'}{lead.performance != null && <small>/100</small>}</strong><small>{lead.measureProvenance?.performance?.source === 'lighthouse' ? 'Measured on mobile' : lead.measureProvenance?.performance?.source === 'html_heuristic' ? 'HTML estimate — not measured' : lead.measureProvenance?.performance?.status === 'legacy' ? 'Unknown source (legacy value)' : lead.lighthouse?.status === 'Completed' ? 'Measured on mobile' : lead.lighthouse?.status || (lead.performance != null ? 'Unknown source (legacy value)' : 'Not measured')}</small><i className={lead.performance == null ? '' : lead.performance >= 75 ? 'good' : lead.performance >= 50 ? 'fair' : 'bad'} /></article><article><Globe2 size={15} /><span>Pages crawled</span><strong>{lead.pageCount ?? '—'}</strong><small>{lead.auditComponents?.crawl?.stoppedBy && lead.auditComponents.crawl.stoppedBy !== 'page-limit' ? `Stopped: ${{ 'attempt-limit': 'attempt limit', 'time-limit': 'time limit', 'byte-limit': 'size limit', 'queue-limit': 'queue limit', cancelled: 'cancelled' }[lead.auditComponents.crawl.stoppedBy] || lead.auditComponents.crawl.stoppedBy}` : `of ${lead.auditComponents?.crawl?.pageLimit || 10} maximum`}</small><i className={lead.pageCount > 1 ? 'good' : 'fair'} /></article><article><ExternalLink size={15} /><span>Links checked</span><strong>{lead.checkedLinks ?? '—'}</strong><small>Same-site destinations</small><i className={lead.checkedLinks > 0 ? 'good' : 'fair'} /></article><article><CircleAlert size={15} /><span>Broken links</span><strong>{lead.brokenLinks ?? '—'}</strong><small>{lead.linkSummary ? `${lead.linkSummary.confirmedBroken ?? lead.brokenLinks ?? 0} confirmed · ${lead.linkSummary.unverified ?? 0} unverified` : lead.auditStatus || 'Not measured'}</small><i className={lead.brokenLinks == null ? '' : lead.brokenLinks === 0 ? 'good' : lead.brokenLinks <= 2 ? 'fair' : 'bad'} /></article></div>}
            {done[1] && <MuseSynthesis lead={lead} onAnalyze={onMuseAnalyze} onUpdate={onUpdate} />}
            <div className="research-detail-actions"><button className="button button-secondary" onClick={() => onExport(lead)}><Download size={13} />Export research packet</button>{done[1] && <button className="button button-secondary" onClick={() => onInsight(lead)}><FileText size={13} />Adjust score</button>}{!failure && <button className="button button-quiet" onClick={() => onFailure(lead)}><CircleAlert size={13} />Mark stage failed</button>}</div>
          </div>}
          {tab === 'Brief' && <BriefTab lead={lead} onUpdate={onUpdate} onReview={onReview} fetchBrief={fetchBrief} onBriefExport={onBriefExport} onToast={onToast} />}
          {tab === 'Sales' && <div className="sales-detail"><section className="sales-stage-card"><div className="sales-section-head"><div><span className="detail-label">Sales status</span><h2>{lead.salesStage || 'Not in sales'}</h2></div>{lead.salesStage && <Badge tone={statusTone[lead.salesStage]} dot>{lead.salesStage}</Badge>}</div><div className="next-action-callout"><span>Next action</span><strong>{getNextAction(lead)}</strong></div><div className="sales-stage-path" aria-label="Sales progression">{pipelineStages.map((stage, index) => <button key={stage} className={cn(index < currentSalesIndex && 'is-complete', index === currentSalesIndex && 'is-current')} aria-current={index === currentSalesIndex ? 'step' : undefined} onClick={() => onUpdate(lead.id, { salesStage: stage })}><span>{index < currentSalesIndex ? <Check size={10} /> : index + 1}</span><small>{stage}</small></button>)}</div><button className="button button-quiet button-small close-lost-action" onClick={() => onUpdate(lead.id, { salesStage: 'Lost', lostReason: 'Closed manually' })}><CircleAlert size={12} />Close as lost</button></section><section className="sales-email-card"><div className="sales-section-head"><div><span className="detail-label">Concise outreach email</span><h2>{outreachSubject(lead)}</h2></div><small>{pitch.trim().split(/\s+/).length} words</small></div><p>{pitch}</p><div><button className="button button-secondary button-small" onClick={async () => { try { await navigator.clipboard.writeText(`Subject: ${outreachSubject(lead)}\n\n${pitch}`); onToast('Outreach email copied') } catch { onToast({ message: 'Could not copy the email', tone: 'error' }) } }}><Copy size={12} />Copy email</button><button className="button button-quiet button-small" onClick={onOutreach}>Open outreach <ArrowRight size={12} /></button></div></section>{lead.salesStage === 'Won' && <div className="contract-callout"><Trophy size={18} /><div><strong>{lead.contract ? 'Contract recorded' : 'Add the agreement details'}</strong><p>{lead.contract ? `${currency(lead.contract.amount, lead.contract.currency)} · ${lead.contract.scope || 'Scope not recorded'}` : 'Save the approved amount, scope, terms, and kickoff plan.'}</p></div><button className="button button-primary button-small" onClick={() => onContract(lead)}>{lead.contract ? 'Edit' : 'Add details'}</button></div>}</div>}
        </div>
      </aside>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
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
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal contract-modal" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><Trophy size={17} /></span><span><strong>Contract details</strong><small>{lead.company}</small></span></div><IconButton label="Close contract" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px', marginBottom: '8px' }}>{fieldErrors._general}</div>}<div className="form-pair"><label><span>Approved amount *</span><input type="number" min="0" value={draft.amount} onChange={handleField('amount')} onBlur={handleBlur('amount')} placeholder="12000" style={show('amount') ? errStyle : undefined} className={show('amount') ? 'input-error' : undefined} aria-invalid={Boolean(show('amount'))} />{show('amount') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.amount}</span>}</label><label><span>Currency</span><select value={draft.currency} onChange={handleField('currency')} onBlur={handleBlur('currency')} style={show('currency') ? errStyle : undefined} className={show('currency') ? 'input-error' : undefined} aria-invalid={Boolean(show('currency'))}><option>USD</option><option>INR</option><option>GBP</option><option>EUR</option></select>{show('currency') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.currency}</span>}</label></div><label><span>Approved scope *</span><textarea value={draft.scope} onChange={handleField('scope')} onBlur={handleBlur('scope')} placeholder="What are we delivering?" style={show('scope') ? errStyle : undefined} className={show('scope') ? 'input-error' : undefined} aria-invalid={Boolean(show('scope'))} />{show('scope') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.scope}</span>}</label><label><span>Payment terms</span><input value={draft.terms} onChange={handleField('terms')} placeholder="50% at kickoff · 50% at launch" /></label><div className="form-pair"><label><span>Signed on</span><input type="date" value={draft.signedOn} onChange={handleField('signedOn')} onBlur={handleBlur('signedOn')} style={show('signedOn') ? errStyle : undefined} className={show('signedOn') ? 'input-error' : undefined} aria-invalid={Boolean(show('signedOn'))} />{show('signedOn') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.signedOn}</span>}</label><label><span>Start date</span><input type="date" value={draft.startDate} onChange={handleField('startDate')} onBlur={handleBlur('startDate')} style={show('startDate') ? errStyle : undefined} className={show('startDate') ? 'input-error' : undefined} aria-invalid={Boolean(show('startDate'))} />{show('startDate') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.startDate}</span>}</label></div><label><span>Conditions</span><textarea value={draft.conditions} onChange={handleField('conditions')} placeholder="Dependencies, approvals, exclusions…" /></label><label><span>Next step</span><input value={draft.nextStep} onChange={handleField('nextStep')} placeholder="Book kickoff call" /></label></div><div className="modal-footer"><div><ShieldCheck size={13} /><span>Manual record · saved locally</span></div><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}{saving ? 'Saving…' : 'Save contract'}</button></div></div></form></div>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
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
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal insight-modal" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon modal-icon-purple"><FileText size={17} /></span><span><strong>Adjust opportunity result</strong><small>{lead.company}</small></span></div><IconButton label="Close insight" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px', marginBottom: '8px' }}>{fieldErrors._general}</div>}<div className="form-pair"><label><span>Opportunity score *</span><input type="number" min="0" max="100" value={score} onChange={(event) => { setScore(event.target.value); clearErr('score') }} onBlur={handleBlur('score')} style={show('score') ? errStyle : undefined} className={show('score') ? 'input-error' : undefined} aria-invalid={Boolean(show('score'))} />{show('score') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.score}</span>}</label><label><span>Confidence *</span><input type="number" min="0" max="100" value={confidence} onChange={(event) => { setConfidence(event.target.value); clearErr('confidence') }} onBlur={handleBlur('confidence')} style={show('confidence') ? errStyle : undefined} className={show('confidence') ? 'input-error' : undefined} aria-invalid={Boolean(show('confidence'))} />{show('confidence') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.confidence}</span>}</label></div><label><span>Review note *</span><textarea value={insight} onChange={(event) => { setInsight(event.target.value); clearErr('insight') }} onBlur={handleBlur('insight')} placeholder="Explain why you adjusted the evidence-based result." style={show('insight') ? errStyle : undefined} className={show('insight') ? 'input-error' : undefined} aria-invalid={Boolean(show('insight'))} />{show('insight') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.insight}</span>}</label><div className="safe-note"><ShieldCheck size={14} /><p>The raw website evidence remains unchanged and the manual adjustment is labeled.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}{saving ? 'Saving…' : 'Save result'}</button></div></div></form></div>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
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
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal failure-modal" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon modal-icon-red"><CircleAlert size={17} /></span><span><strong>Mark research stage failed</strong><small>{lead.company}</small></span></div><IconButton label="Close failure" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px', marginBottom: '8px' }}>{fieldErrors._general}</div>}<label><span>Failed stage</span><select value={stage} onChange={(event) => setStage(Number(event.target.value))} style={show('stage') ? errStyle : undefined} className={show('stage') ? 'input-error' : undefined} aria-invalid={Boolean(show('stage'))}>{researchLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select>{show('stage') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.stage}</span>}</label><label><span>What went wrong? *</span><textarea value={reason} onChange={handleChangeReason} onBlur={handleBlur('reason')} placeholder="For example: website timed out during the audit" style={show('reason') ? errStyle : undefined} className={show('reason') ? 'input-error' : undefined} aria-invalid={Boolean(show('reason'))} />{show('reason') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.reason}</span>}</label><div className="failure-note"><RefreshCcw size={14} /><p>This is an operational failure, not a rejection. Retrying will clear the failure and return the client to its last completed stage.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-failure" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <X size={12} />}{saving ? 'Saving…' : 'Mark failed'}</button></div></div></form></div>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
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
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal manual-lead-modal" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><Plus size={17} /></span><span><strong>Add client manually</strong><small>Start with the information you already have</small></span></div><IconButton label="Close add client" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px', marginBottom: '8px' }}>{fieldErrors._general}</div>}<div className="form-pair"><label><span>Company name *</span><input value={draft.company} onChange={handleField('company')} onBlur={handleBlur('company')} placeholder="Salt City Plumbing" style={show('company') ? errStyle : undefined} className={show('company') ? 'input-error' : undefined} aria-invalid={Boolean(show('company'))} />{show('company') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.company}</span>}</label><label><span>Website</span><input value={draft.website} onChange={handleField('website')} onBlur={handleBlur('website')} placeholder="example.com" style={show('website') ? errStyle : undefined} className={show('website') ? 'input-error' : undefined} aria-invalid={Boolean(show('website'))} />{show('website') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.website}</span>}</label></div><div className="form-pair"><label><span>Category</span><input value={draft.category} onChange={handleField('category')} placeholder="Plumbing" /></label><label><span>Location</span><input value={draft.location} onChange={handleField('location')} placeholder="Salt Lake City, Utah" /></label></div><label><span>Address</span><input value={draft.address} onChange={handleField('address')} placeholder="47 S Orange St A8" /></label><div className="form-pair"><label><span>Email</span><input type="email" value={draft.email} onChange={handleField('email')} onBlur={handleBlur('email')} placeholder="hello@example.com" style={show('email') ? errStyle : undefined} className={show('email') ? 'input-error' : undefined} aria-invalid={Boolean(show('email'))} />{show('email') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.email}</span>}</label><label><span>Phone</span><input value={draft.phone} onChange={handleField('phone')} placeholder="(801) 555-0100" /></label></div><label><span>Google Maps URL</span><input value={draft.sourceUrl} onChange={handleField('sourceUrl')} onBlur={handleBlur('sourceUrl')} placeholder="https://maps.google.com/..." style={show('sourceUrl') ? errStyle : undefined} className={show('sourceUrl') ? 'input-error' : undefined} aria-invalid={Boolean(show('sourceUrl'))} />{show('sourceUrl') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.sourceUrl}</span>}</label><div className="safe-note"><Database size={14} /><p>The client will be added as collected. Add a website later to start the audit.</p></div></div><div className="modal-footer"><div /><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}{saving ? 'Saving…' : 'Add client'}</button></div></div></form></div>
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
  const errStyle = { borderColor: '#c00', boxShadow: '0 0 0 3px rgba(204,0,0,0.08)' }
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
  return <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}><form className="run-modal minimal-run-modal" onSubmit={handleSubmit} noValidate><div className="modal-header"><div><span className="modal-icon"><Activity size={17} /></span><span><strong>Add client data</strong><small>Start a focused collection run</small></span></div><IconButton label="Close run" type="button" onClick={close} disabled={saving}><X size={16} /></IconButton></div><div className="modal-body contract-form">{!connected ? <div className="preview-banner"><WandSparkles size={16} /><div><strong>Saved-client mode</strong><p>Live discovery is not configured. This run will safely audit matching saved websites in this location (city-text filter).</p></div></div> : <div className="preview-banner"><ShieldCheck size={16} /><div><strong>Live test mode</strong><p>Starts at 5 clients and Bright Data is hard-capped at {maxRecords} records per run.</p></div></div>}{fieldErrors._general && <div className="field-error" style={{ color: '#c00', fontSize: '12px', marginBottom: '8px' }}>{fieldErrors._general}</div>}<label><span>Location *</span><input value={location} onChange={handleLocationChange} onBlur={handleBlur('location')} placeholder="Salt Lake City, Utah" style={show('location') ? errStyle : undefined} className={show('location') ? 'input-error' : undefined} aria-invalid={Boolean(show('location'))} />{show('location') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.location}</span>}</label><label><span>Search center — optional coordinates</span><div style={{ display: 'flex', gap: '8px' }}><input value={latitude} onChange={(event) => setLatitude(event.target.value)} onBlur={handleBlur('latitude')} placeholder="Latitude · e.g. 40.7608" inputMode="decimal" style={{ flex: 1, ...(show('latitude') ? errStyle : undefined) }} className={show('latitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('latitude'))} /><input value={longitude} onChange={(event) => setLongitude(event.target.value)} onBlur={handleBlur('longitude')} placeholder="Longitude · e.g. -111.891" inputMode="decimal" style={{ flex: 1, ...(show('longitude') ? errStyle : undefined) }} className={show('longitude') ? 'input-error' : undefined} aria-invalid={Boolean(show('longitude'))} /></div>{(show('latitude') || show('longitude')) && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.latitude || merged.longitude}</span>}<small style={{ color: '#666', fontSize: '12px' }}>{hasExplicitCoords ? (coordsValid ? `Locked to ${latitude}, ${longitude} — saved with this run and never silently replaced.` : 'Enter both latitude (-90 to 90) and longitude (-180 to 180).') : defaultCoords ? `Empty uses the Settings default (${defaultCoords}). A new place name without coordinates is rejected instead of searched elsewhere.` : 'Empty uses the Settings default. A new place name without coordinates is rejected instead of searched elsewhere.'}</small></label><label><span>Business types *</span><div className="category-selector">{allCategories.map((item) => <button key={item} type="button" className={categories.includes(item) ? 'selected' : ''} onClick={() => toggle(item)}>{categories.includes(item) && <Check size={11} />}{item}</button>)}</div>{show('categories') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.categories}</span>}</label><label><span>Maximum clients (1-50)</span><input type="number" min="1" max={connected ? maxRecords : 50} value={limit} onChange={handleLimitChange} onBlur={handleBlur('limit')} style={show('limit') ? errStyle : undefined} className={show('limit') ? 'input-error' : undefined} aria-invalid={Boolean(show('limit'))} />{show('limit') && <span className="field-error" style={{ color: '#c00', fontSize: '12px' }}>{merged.limit}</span>}</label></div><div className="modal-footer"><div><ShieldCheck size={13} /><span>No automatic outreach</span></div><div><button className="button button-secondary" type="button" onClick={close} disabled={saving}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={12} /> : <Play size={12} />}{saving ? 'Starting…' : connected ? 'Start live run' : 'Audit saved clients'}</button></div></div></form></div>
}

function CommandMenu({ leads, close, onOpen, goTo, onNewRun }) {
  const [query, setQuery] = useState('')
  const input = useRef(null)
  useEffect(() => input.current?.focus(), [])
  const matching = leads.filter((lead) => `${lead.company} ${lead.category} ${lead.location}`.toLowerCase().includes(query.toLowerCase())).slice(0, 7)
  return <div className="modal-overlay command-overlay" onMouseDown={(event) => event.target === event.currentTarget && close()}><div className="command-menu"><label><Search size={16} /><input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a client…" /><kbd>Esc</kbd></label><div className="command-results">{!query && <><span>Go to</span>{navItems.map(({ label, icon: Icon }) => <button key={label} onClick={() => { goTo(label); close() }}><i><Icon size={14} /></i><strong>{label}</strong></button>)}<button onClick={onNewRun}><i><Play size={14} /></i><strong>Start research run</strong></button></>}{query && <span>Clients</span>}{matching.map((lead) => <button key={lead.id} onClick={() => { onOpen(lead); close() }}><Score value={lead.opportunityScore} /><strong>{lead.company}</strong><small>{lead.category} · {lead.location}</small></button>)}</div></div></div>
}

function NotFoundPage({ clientId, requestedPath, onNavigate, onBack }) {
  const clientMissing = Boolean(clientId)
  return <section className="route-error" role="alert">
    <div className="state-icon"><Search size={20} /></div>
    <span>{clientMissing ? 'Client not found' : 'Page not found'}</span>
    <h1>{clientMissing ? 'That client is no longer available.' : 'This route does not exist.'}</h1>
    <p>{clientMissing ? `No saved client matches “${clientId}”. It may have been removed or the link may be incomplete.` : `Scoutline could not match “${requestedPath || window.location.pathname}” to a workspace page.`}</p>
    <div><button className="button button-secondary" onClick={onBack}><ArrowLeft size={13} />Go back</button><button className="button button-primary" onClick={() => onNavigate('Clients')}><Home size={13} />Open clients</button></div>
  </section>
}

function SystemNotice({ offline, error, onRetry, onDismiss }) {
  if (!offline && !error) return null
  return <div className="system-notice" role="alert"><span>{offline ? <WifiOff size={14} /> : <CircleAlert size={14} />}</span><div><strong>{offline ? 'You are offline' : 'Live updates are paused'}</strong><small>{offline ? 'Saved information remains visible. Changes need the local API connection.' : error}</small></div>{!offline && <><button onClick={onRetry}><RefreshCcw size={11} />Retry</button><IconButton label="Dismiss notice" onClick={onDismiss}><X size={12} /></IconButton></>}</div>
}

function WorkspaceError({ message, onRetry }) {
  return <main className="app-error" role="alert"><div className="state-icon state-icon-error"><CircleAlert size={20} /></div><span>Workspace unavailable</span><h1>Scoutline could not load your local data.</h1><p>{message || 'The local API did not respond.'} Your saved SQLite data has not been changed.</p><div><button className="button button-secondary" onClick={() => window.location.assign('/clients')}><Home size={13} />Clients route</button><button className="button button-primary" onClick={onRetry}><RefreshCcw size={13} />Try again</button></div><small>Make sure <code>npm run dev</code> is running in this project.</small></main>
}

function Toast({ toast }) {
  if (!toast) return null
  const notice = typeof toast === 'string' ? { message: toast, tone: 'success' } : toast
  return <div className={cn('toast', notice.tone === 'error' && 'toast-error')} role={notice.tone === 'error' ? 'alert' : 'status'} aria-live="polite"><span>{notice.tone === 'error' ? <CircleAlert size={12} /> : <Check size={12} />}</span>{notice.message}</div>
}

export default function App() {
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
  const [contractLead, setContractLead] = useState(null)
  const [insightLead, setInsightLead] = useState(null)
  const [failureLead, setFailureLead] = useState(null)
  const [runModalOpen, setRunModalOpen] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [manualLeadOpen, setManualLeadOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [activeRunId, setActiveRunId] = useState(null)
  const [toast, setToast] = useState('')
  const csvInput = useRef(null)
  const hasActiveLeadJobs = leads.some((lead) => ['Queued', 'Running', 'Waiting'].includes(lead.researchJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.museJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.refreshJob?.status) || ['Queued', 'Running', 'Waiting'].includes(lead.manualRun?.status) || ['Queued', 'Analyzing'].includes(lead.researchStatus))

  const navigate = (nextPage, { clientId = null, replace = false } = {}) => {
    const nextRoute = { page: pagePaths[nextPage] ? nextPage : 'Clients', clientId, requestedPath: null, canonical: true }
    const method = replace ? 'replaceState' : 'pushState'
    window.history[method]({ scoutline: true }, '', routePath(nextRoute.page, clientId))
    setRoute(nextRoute)
    setSelectedLead(null)
    setSidebarOpen(false)
    setCommandOpen(false)
    setCreateMenuOpen(false)
  }
  const openLead = (lead) => {
    const originPage = pagePaths[page] && page !== 'Settings' ? page : 'Clients'
    window.history.pushState({ scoutline: true, scoutlineDrawer: true }, '', routePath(originPage, lead.id))
    setRoute({ page: originPage, clientId: lead.id, requestedPath: null, canonical: true })
    setSelectedLead(lead)
  }
  const closeLead = () => {
    const current = readRoute()
    if (window.history.state?.scoutlineDrawer) window.history.back()
    else {
      const nextPage = pagePaths[current.page] ? current.page : 'Clients'
      window.history.replaceState({ scoutline: true }, '', routePath(nextPage))
      setRoute({ page: nextPage, clientId: null, requestedPath: null, canonical: true })
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
  }, [route.clientId, leads])
  useEffect(() => {
    const label = selectedLead?.company || (page === 'NotFound' ? 'Not found' : page)
    document.title = `${label} · Scoutline`
  }, [page, selectedLead])
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
        const current = readRoute()
        if (current.clientId) {
          window.history.replaceState({ scoutline: true }, '', routePath(current.page))
          setRoute({ ...current, clientId: null })
        }
        setSelectedLead(null); setContractLead(null); setInsightLead(null); setFailureLead(null); setRunModalOpen(false); setCreateMenuOpen(false); setManualLeadOpen(false); setCommandOpen(false)
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
      setLeads((current) => current.map((lead) => lead.id === id ? result.lead : lead))
      setSelectedLead((current) => current?.id === id ? result.lead : current)
      setToast(result.attempt.outcome === 'no-answer' || result.attempt.outcome === 'wrong-contact' ? 'Attempt recorded — still waiting for first contact' : `${result.lead.company} marked contacted`)
      return result.lead
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
      setToast(result.alreadyQueued ? `${lead.company} is already with Muse` : `${lead.company} queued for Muse synthesis`)
      return result.lead
    } catch (caught) { return showActionError(caught, 'Could not queue Muse') }
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

  let content
  if (page === 'NotFound') content = <NotFoundPage requestedPath={route.requestedPath} onNavigate={navigate} onBack={() => window.history.length > 1 ? window.history.back() : navigate('Clients')} />
  else if (route.clientId && !selectedLead) content = <NotFoundPage clientId={route.clientId} onNavigate={navigate} onBack={() => window.history.length > 1 ? window.history.back() : navigate('Clients')} />
  else if (page === 'Clients') content = <ClientsPage leads={leads} runs={runs} onOpen={openLead} onImport={() => csvInput.current?.click()} onExport={exportCsv} />
  else if (page === 'Research') content = <ResearchPage leads={leads} runs={runs} activeRunId={activeRunId} onOpen={openLead} onExport={exportLead} onUpdate={updateLead} onAnalyze={analyzeLead} onNewRun={() => setRunModalOpen(true)} onTogglePause={toggleRunPause} onCancel={cancelRun} />
  else if (page === 'Outreach') content = <OutreachPage leads={leads} onOpen={openLead} onUpdate={updateLead} onAttempt={recordContactAttempt} onGenerate={generateOutreachVersions} onCandidate={resolveOutreachCandidate} onToast={setToast} />
  else if (page === 'Pipeline') content = <PipelinePage leads={leads} onOpen={openLead} onUpdate={updateLead} goTo={navigate} onContract={setContractLead} />
  else if (page === 'Contracts') content = <ContractsPage leads={leads} onOpen={openLead} onContract={setContractLead} goTo={navigate} />
  else content = <SettingsPage apiStatus={apiStatus} settings={settingsData} onSave={saveSettings} />

  return <div className="app-shell"><Sidebar page={page} setPage={navigate} open={sidebarOpen} close={() => setSidebarOpen(false)} counts={counts} /><main className="main-shell"><Topbar page={page === 'NotFound' ? 'Not found' : page} onNavigate={navigate} onMenu={() => setSidebarOpen(true)} onSearch={() => setCommandOpen(true)} theme={theme} toggleTheme={() => setTheme((value) => value === 'light' ? 'dark' : 'light')} onAdd={() => setCreateMenuOpen(true)} /><SystemNotice offline={offline} error={syncError} onRetry={() => { setSyncError(''); setReloadToken((value) => value + 1) }} onDismiss={() => setSyncError('')} /><div className="page-content">{content}</div></main><LeadDrawer lead={selectedLead} runs={runs} close={closeLead} onExport={exportLead} onUpdate={updateLead} onAnalyze={analyzeLead} onMuseAnalyze={analyzeWithMuse} onRunAction={runClientAction} onReview={reviewFinding} fetchBrief={fetchBrief} onBriefExport={exportBrief} brightDataReady={apiStatus?.brightDataAdapterReady} onToast={setToast} onContract={setContractLead} onInsight={setInsightLead} onFailure={setFailureLead} onOutreach={() => navigate('Outreach')} />{contractLead && <ContractModal lead={contractLead} close={() => setContractLead(null)} onSave={updateLead} />}{insightLead && <InsightModal lead={insightLead} close={() => setInsightLead(null)} onSave={updateLead} />}{failureLead && <FailureModal lead={failureLead} close={() => setFailureLead(null)} onSave={updateLead} />}{runModalOpen && <NewRunModal close={() => setRunModalOpen(false)} onStart={startRun} connected={apiStatus?.brightDataAdapterReady} maxRecords={apiStatus?.brightDataMaxRecords || 25} defaults={settingsData} />}{createMenuOpen && <NewMenu close={() => setCreateMenuOpen(false)} onRun={() => setRunModalOpen(true)} onImport={openImport} onManual={() => setManualLeadOpen(true)} />}{manualLeadOpen && <ManualLeadModal close={() => setManualLeadOpen(false)} onSave={createManualLead} />}{commandOpen && <CommandMenu leads={leads} close={() => setCommandOpen(false)} onOpen={openLead} goTo={navigate} onNewRun={() => { setCommandOpen(false); setRunModalOpen(true) }} />}<input ref={csvInput} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={importCsv} /><Toast toast={toast} /></div>
}