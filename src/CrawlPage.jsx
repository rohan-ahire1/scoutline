import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, LoaderCircle, Play, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { normalizeLocalScrapeDefaults } from '../server/services/crawl.js'

const cn = (...parts) => parts.filter(Boolean).join(' ')
const PAGE_SIZE = 50

async function apiRequest(path, options = {}) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 75_000)
  try {
    const { timeoutMs: _timeoutMs, ...requestOptions } = options
    const response = await fetch(path, { ...requestOptions, signal: controller.signal })
    const raw = await response.text()
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    if (!response.ok) throw new Error(body?.error || `Request failed with HTTP ${response.status}`)
    return body
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request took too long. Please try again.')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

function scoreTone(score) {
  if (score == null) return 'gray'
  if (score >= 70) return 'green'
  if (score >= 40) return 'amber'
  return 'gray'
}

function qualBadge(qual) {
  if (qual === 'eligible') return { tone: 'green', label: 'Eligible' }
  if (qual === 'rejected') return { tone: 'gray', label: 'Rejected' }
  return { tone: 'amber', label: 'Not evaluated' }
}

function stateBadge(state) {
  if (state === 'completed') return { tone: 'green', label: 'Completed' }
  if (state === 'failed') return { tone: 'red', label: 'Failed' }
  if (state === 'blocked') return { tone: 'amber', label: 'Blocked' }
  if (state === 'crawling' || state === 'queued') return { tone: 'blue', label: state === 'crawling' ? 'Crawling' : 'Queued' }
  if (state === 'disabled') return { tone: 'gray', label: 'Disabled' }
  return { tone: 'gray', label: 'Pending' }
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function timeAgo(iso) {
  if (!iso) return 'unknown'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatBytes(bytes) {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function Score({ value }) {
  if (value == null) return <span className="crawl-score is-empty">—</span>
  return <span className={cn('crawl-score', `crawl-score-${scoreTone(value)}`)}>{value}</span>
}

function TrendChart({ history }) {
  const width = 720
  const height = 190
  const padLeft = 36
  const padBottom = 24
  const padTop = 12
  const innerWidth = width - padLeft - 8
  const innerHeight = height - padTop - padBottom
  const max = Math.max(1, ...history.map((day) => day.completed + day.failed))
  const slot = innerWidth / Math.max(history.length, 1)
  const barWidth = Math.max(2, Math.min(18, slot * 0.55))
  const totals = history.reduce((acc, day) => ({ completed: acc.completed + day.completed, failed: acc.failed + day.failed, eligible: acc.eligible + day.eligible }), { completed: 0, failed: 0, eligible: 0 })
  const yTicks = [0, Math.round(max / 2), max]
  return (
    <div>
      <svg className="crawl-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily crawls for the last ${history.length} days: ${totals.completed} completed, ${totals.failed} failed, ${totals.eligible} eligible.`}>
        {yTicks.map((tick) => {
          const y = padTop + innerHeight - (tick / max) * innerHeight
          return (
            <g key={tick}>
              <line x1={padLeft} x2={width - 8} y1={y} y2={y} className="crawl-trend-grid" />
              <text x={padLeft - 6} y={y + 4} textAnchor="end" className="crawl-trend-tick">{tick}</text>
            </g>
          )
        })}
        {history.map((day, index) => {
          const x = padLeft + index * slot + (slot - barWidth) / 2
          const completedHeight = (day.completed / max) * innerHeight
          const failedHeight = (day.failed / max) * innerHeight
          const base = padTop + innerHeight
          return (
            <g key={day.date}>
              <title>{`${day.date}: ${day.completed} completed, ${day.failed} failed, ${day.eligible} eligible`}</title>
              <rect x={x} y={base - completedHeight} width={barWidth} height={Math.max(completedHeight, day.completed ? 1.5 : 0)} rx="1.5" className="crawl-bar-completed" />
              <rect x={x} y={base - completedHeight - failedHeight} width={barWidth} height={Math.max(failedHeight, day.failed ? 1.5 : 0)} rx="1.5" className="crawl-bar-failed" />
              {(index % 5 === 0 || index === history.length - 1) && (
                <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="crawl-trend-tick">{day.date.slice(5)}</text>
              )}
            </g>
          )
        })}
        <polyline
          className="crawl-line-eligible"
          points={history.map((day, index) => `${(padLeft + index * slot + slot / 2).toFixed(1)},${(padTop + innerHeight - (day.eligible / max) * innerHeight).toFixed(1)}`).join(' ')}
        />
        {history.map((day, index) => (
          <circle
            key={`e-${day.date}`}
            cx={padLeft + index * slot + slot / 2}
            cy={padTop + innerHeight - (day.eligible / max) * innerHeight}
            r={index % 5 === 0 || index === history.length - 1 ? 3 : 1.8}
            className="crawl-dot-eligible"
          >
            <title>{`${day.date}: ${day.eligible} eligible`}</title>
          </circle>
        ))}
      </svg>
      <div className="crawl-legend" aria-hidden="true">
        <span><i className="crawl-swatch crawl-swatch-completed" />Completed ({totals.completed})</span>
        <span><i className="crawl-swatch crawl-swatch-failed" />Failed ({totals.failed})</span>
        <span><i className="crawl-swatch crawl-swatch-eligible" />Eligible ({totals.eligible})</span>
      </div>
    </div>
  )
}

function SiteDetail({ site, adding, added, onAddLead }) {
  const techFlags = site.tech && typeof site.tech === 'object'
    ? Object.entries(site.tech).filter(([key, value]) => value === true && key !== 'staticCandidate').map(([key]) => key)
    : []
  if (site.tech?.staticCandidate) techFlags.unshift('static-candidate')
  const status = added ? (added.created ? 'Added as lead' : 'Already a lead') : null
  return (
    <div className="crawl-detail">
      <div className="crawl-detail-grid">
        <div>
          <h4>Scores</h4>
          <dl>
            <div><dt>Opportunity</dt><dd><Score value={site.last_opportunity_score} /></dd></div>
            <div><dt>Visual risk</dt><dd><Score value={site.last_visual_risk_score} /></dd></div>
            <div><dt>Qualification</dt><dd><span className={cn('badge', `badge-${qualBadge(site.qualification_state).tone}`)}>{qualBadge(site.qualification_state).label}</span></dd></div>
          </dl>
          {site.eligibility_reasons?.length > 0 && (
            <p className="crawl-reasons">Why: {site.eligibility_reasons.join(' · ').replaceAll('_', ' ')}</p>
          )}
          {site.visual_risk?.reasons?.length > 0 && (
            <p className="crawl-reasons">Risk signals: {site.visual_risk.reasons.join(' · ').replaceAll('_', ' ')}</p>
          )}
        </div>
        <div>
          <h4>Site</h4>
          <dl>
            <div><dt>Type</dt><dd>{site.website_type}</dd></div>
            <div><dt>HTTP</dt><dd>{site.last_status_code ?? '—'}</dd></div>
            <div><dt>Pages</dt><dd>{site.last_pages_inspected ?? '—'} inspected · {site.total_crawls} crawls</dd></div>
            <div><dt>Latency</dt><dd>{site.last_duration_ms != null ? `${site.last_duration_ms} ms` : '—'}</dd></div>
            {site.title && <div><dt>Title</dt><dd className="crawl-wrap">{site.title}</dd></div>}
          </dl>
          {techFlags.length > 0 && (
            <p className="crawl-tech">{techFlags.map((flag) => <span key={flag} className="badge badge-slate">{flag}</span>)}</p>
          )}
          {site.last_error && <p className="crawl-error">Last error: {site.last_error}</p>}
        </div>
        <div>
          <h4>Contacts</h4>
          {site.emails?.length > 0 || site.phones?.length > 0 || site.social_links?.length > 0 ? (
            <ul className="crawl-contacts">
              {(site.emails || []).map((email) => <li key={email}><a href={`mailto:${email}`}>{email}</a></li>)}
              {(site.phones || []).map((phone) => <li key={phone}><a href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a></li>)}
              {(site.social_links || []).map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//, '').slice(0, 48)}</a></li>)}
            </ul>
          ) : <p className="crawl-muted">No contacts found.</p>}
        </div>
      </div>
      <div className="crawl-detail-actions">
        <a className="button button-secondary button-small" href={site.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open site</a>
        {status ? (
          <span className="badge badge-green"><Check size={12} />{status}</span>
        ) : (
          <button className="button button-primary button-small" disabled={adding} onClick={() => onAddLead(site)}>
            {adding ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />}Add as lead
          </button>
        )}
      </div>
    </div>
  )
}

const SORTS = [
  { value: 'opportunity', label: 'Highest opportunity' },
  { value: 'risk', label: 'Highest visual risk' },
  { value: 'recent', label: 'Most recent' },
  { value: 'host', label: 'Host A–Z' },
]

function SiteTable({ sites, isExpanded, onToggle, isAdding, addedFor, onAddLead, emptyTitle, emptyHint }) {
  return (
    <div className="crawl-table-wrap">
      <div className="crawl-header" aria-hidden="true"><span>Site</span><span>Type</span><span>Qualification</span><span>Opp.</span><span>Risk</span><span>Result</span><span /></div>
      {sites.map((site) => {
        const expanded = isExpanded(site)
        const qual = qualBadge(site.qualification_state)
        return (
          <div key={site.id} className="crawl-row-group">
            <button
              className={cn('crawl-row', expanded && 'is-expanded')}
              aria-expanded={expanded}
              onClick={() => onToggle(site)}
            >
              <span className="crawl-site"><strong>{site.host}</strong><small>{site.title || site.url}</small></span>
              <span className="crawl-cell">{site.website_type}</span>
              <span><span className={cn('badge', `badge-${qual.tone}`)}>{qual.label}</span></span>
              <span><Score value={site.last_opportunity_score} /></span>
              <span><Score value={site.last_visual_risk_score} /></span>
              <span className="crawl-cell">{formatDateTime(site.last_result_at)}</span>
              <span className={cn('crawl-chevron', expanded && 'is-open')}><ChevronDown size={15} /></span>
            </button>
            {expanded && <SiteDetail site={site} adding={isAdding(site)} added={addedFor(site)} onAddLead={onAddLead} />}
          </div>
        )
      })}
      {!sites.length && <div className="empty-table"><strong>{emptyTitle}</strong><span>{emptyHint}</span></div>}
    </div>
  )
}

const LOCAL_RUN_ACTIVE = ['queued', 'discovering', 'scraping']

function runBadge(status) {
  if (status === 'done') return { tone: 'green', label: 'Done' }
  if (status === 'failed') return { tone: 'red', label: 'Failed' }
  if (status === 'interrupted') return { tone: 'amber', label: 'Interrupted' }
  if (status === 'discovering') return { tone: 'blue', label: 'Discovering' }
  if (status === 'scraping') return { tone: 'blue', label: 'Scraping' }
  return { tone: 'gray', label: 'Queued' }
}

function runTitle(run) {
  if (run.mode === 'discovery') return `${run.location} · ${run.category}`
  return `${run.urlCount} pasted URL${run.urlCount === 1 ? '' : 's'}`
}

function runProgressText(run) {
  const progress = run.progress || {}
  if (run.status === 'queued') return 'Starting…'
  if (run.status === 'discovering') return 'Finding businesses…'
  if (run.status === 'scraping') return `${progress.scraped || 0}/${progress.total || 0} scraped`
  if (run.counts) return `${run.counts.completed} ok · ${run.counts.failed} failed · ${run.counts.eligible} eligible`
  if (run.status === 'done') return `${run.siteCount} sites`
  return ''
}

function LocalScrapePanel({ brightDataReady, onToast, addingKey, addedMap, onAddLead, localDefaults }) {
  const [runs, setRuns] = useState([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [openRunId, setOpenRunId] = useState(null)
  const [openRun, setOpenRun] = useState(null)
  const [expandedSiteId, setExpandedSiteId] = useState(null)
  const [form, setForm] = useState(() => normalizeLocalScrapeDefaults(localDefaults))
  // Optimistic run card: feedback within milliseconds of clicking Start,
  // replaced by the real run once the server responds.
  const [optimistic, setOptimistic] = useState(null)
  const [starting, setStarting] = useState(false)
  const [formError, setFormError] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const openRef = useRef(null)
  openRef.current = openRunId

  const loadAll = async () => {
    try {
      const list = await apiRequest('/api/crawl/local-runs')
      setRuns(list.runs || [])
      setRunsLoaded(true)
      setRunsError('')
      if (openRef.current && !String(openRef.current).startsWith('pending-')) {
        try {
          setOpenRun(await apiRequest(`/api/crawl/local-runs/${encodeURIComponent(openRef.current)}`))
        } catch {
          // Keep the last good detail on transient errors; deletion closes explicitly.
        }
      }
    } catch (err) {
      if (!runsLoaded) setRunsError(err.message)
    }
  }

  useEffect(() => { loadAll() }, [])
  useEffect(() => {
    if (!runs.some((run) => LOCAL_RUN_ACTIVE.includes(run.status))) return
    const timer = window.setInterval(loadAll, 3000)
    return () => window.clearInterval(timer)
  }, [runs])

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const scrollToRun = (id) => {
    requestAnimationFrame(() => {
      document.getElementById(`crawl-run-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const start = async (event) => {
    event.preventDefault()
    if (starting) return
    setFormError('')
    const pasted = form.urls.split('\n').map((line) => line.trim()).filter(Boolean)
    const limit = Number.parseInt(form.limit, 10)
    const safeLimit = Number.isFinite(limit) ? limit : 10
    const body = pasted.length
      ? { urls: pasted, limit: safeLimit }
      : {
          location: form.location.trim(),
          category: form.category.trim(),
          limit: safeLimit,
          ...(form.latitude.trim() ? { latitude: form.latitude.trim() } : {}),
          ...(form.longitude.trim() ? { longitude: form.longitude.trim() } : {}),
        }
    const tempId = `pending-${Date.now()}`
    setOptimistic({
      id: tempId,
      mode: pasted.length ? 'urls' : 'discovery',
      location: body.location || null,
      category: body.category || null,
      limit: safeLimit,
      urlCount: pasted.length,
      status: 'queued',
      progress: { discovered: 0, scraped: 0, total: pasted.length || safeLimit },
      counts: null,
      error: null,
      note: null,
      siteCount: 0,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    })
    setOpenRunId(tempId)
    scrollToRun(tempId)
    setStarting(true)
    try {
      const created = await apiRequest('/api/crawl/local-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      })
      setOptimistic(null)
      setForm((prev) => ({ ...prev, urls: '' }))
      setOpenRunId(created.id)
      setExpandedSiteId(null)
      await loadAll()
      scrollToRun(created.id)
      onToast?.('Local scrape started')
    } catch (err) {
      setOptimistic(null)
      setOpenRunId(null)
      setFormError(err.message)
    } finally {
      setStarting(false)
    }
  }

  const toggleRun = async (id) => {
    if (String(id).startsWith('pending-')) {
      // Optimistic card has no server detail yet; toggle locally only.
      if (openRunId === id) {
        setOpenRunId(null)
        setOpenRun(null)
      } else {
        setOpenRunId(id)
      }
      return
    }
    if (openRunId === id) {
      setOpenRunId(null)
      setOpenRun(null)
      return
    }
    setOpenRunId(id)
    setExpandedSiteId(null)
    try {
      setOpenRun(await apiRequest(`/api/crawl/local-runs/${encodeURIComponent(id)}`))
    } catch (err) {
      onToast?.(err.message)
      setOpenRunId(null)
    }
  }

  const remove = async (id) => {
    setDeletingId(id)
    try {
      await apiRequest(`/api/crawl/local-runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (openRunId === id) {
        setOpenRunId(null)
        setOpenRun(null)
      }
      await loadAll()
    } catch (err) {
      onToast?.(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="panel crawl-panel" aria-label="Local scrape">
      <div className="section-heading">
        <div><h2>Local scrape</h2><span>Find sites by location or paste URLs — scraped on this machine, saved to a JSON file.</span></div>
      </div>
      <form className="crawl-local-form" onSubmit={start}>
        <div className="crawl-local-grid">
          <label><span>Location</span><input value={form.location} onChange={(event) => setField('location', event.target.value)} placeholder="Salt Lake City, Utah" autoComplete="off" /></label>
          <label><span>Category</span><input value={form.category} onChange={(event) => setField('category', event.target.value)} placeholder="Roofing" autoComplete="off" /></label>
          <label className="crawl-local-limit"><span>Limit</span><input value={form.limit} onChange={(event) => setField('limit', event.target.value)} inputMode="numeric" autoComplete="off" aria-label="Maximum sites to scrape" /></label>
          <label><span>Latitude <em>optional</em></span><input value={form.latitude} onChange={(event) => setField('latitude', event.target.value)} placeholder="40.76" inputMode="decimal" autoComplete="off" /></label>
          <label><span>Longitude <em>optional</em></span><input value={form.longitude} onChange={(event) => setField('longitude', event.target.value)} placeholder="-111.89" inputMode="decimal" autoComplete="off" /></label>
        </div>
        <label className="crawl-local-urls"><span>Or paste URLs (one per line)</span><textarea value={form.urls} onChange={(event) => setField('urls', event.target.value)} rows={3} placeholder={'https://example.com/\nhttps://another.com/'} spellCheck={false} /></label>
        {!brightDataReady && (
          <p className="crawl-local-hint">Location search needs a Bright Data key (Settings) — or paste URLs to skip discovery. Free-text locations also need coordinates unless they match your Settings geography.</p>
        )}
        {formError && <p className="crawl-error" role="alert">{formError}</p>}
        <div><button className="button button-primary button-small" disabled={starting}>{starting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}{starting ? 'Starting…' : 'Start local scrape'}</button></div>
      </form>
      <div className="crawl-runs">
        {runsError && <p className="crawl-error" role="alert">{runsError}</p>}
        {runsLoaded && !runs.length && !runsError && <p className="crawl-muted">No local scrapes yet.</p>}
        {(optimistic ? [optimistic, ...runs] : runs).map((run) => {
          const badge = runBadge(run.status)
          const open = openRunId === run.id
          const progress = run.progress || {}
          const pct = progress.total ? Math.round(((progress.scraped || 0) / progress.total) * 100) : (run.status === 'done' ? 100 : 0)
          const full = open && openRun && openRun.id === run.id ? openRun : null
          const sites = full ? [...(full.sites || [])].sort((a, b) => (b.last_opportunity_score ?? -1) - (a.last_opportunity_score ?? -1)) : []
          return (
            <article key={run.id} id={`crawl-run-${run.id}`} className="crawl-run">
              <div className="crawl-run-top">
                <button className="crawl-run-head" aria-expanded={open} onClick={() => toggleRun(run.id)}>
                  <span className="crawl-run-title"><strong>{runTitle(run)}</strong><small>{formatDateTime(run.createdAt)}{run.mode === 'discovery' ? '' : ' · pasted URLs'}</small></span>
                  <span className={cn('badge', `badge-${badge.tone}`)}>{badge.label}</span>
                  <span className="crawl-run-track" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                  <span className="crawl-cell">{runProgressText(run)}</span>
                  <span className={cn('crawl-chevron', open && 'is-open')}><ChevronDown size={15} /></span>
                </button>
                {!LOCAL_RUN_ACTIVE.includes(run.status) && (
                  <button className="button button-quiet button-small" disabled={deletingId === run.id} onClick={() => remove(run.id)} aria-label={`Delete run ${runTitle(run)}`}>
                    {deletingId === run.id ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
                  </button>
                )}
              </div>
              {run.error && <p className="crawl-error">{run.error}</p>}
              {run.note && <p className="crawl-muted">{run.note}</p>}
              {open && !full && <p className="crawl-muted"><LoaderCircle size={13} className="spin" /> Loading results…</p>}
              {open && full && (
                full.sites?.length
                  ? (
                    <SiteTable
                      sites={sites}
                      isExpanded={(site) => expandedSiteId === site.id}
                      onToggle={(site) => setExpandedSiteId(expandedSiteId === site.id ? null : site.id)}
                      isAdding={(site) => addingKey === `local:${run.id}:${site.id}`}
                      addedFor={(site) => addedMap[`local:${run.id}:${site.id}`]}
                      onAddLead={(site) => onAddLead(site, run.id)}
                      emptyTitle="No sites yet"
                      emptyHint="Results appear as pages finish."
                    />
                  )
                  : <p className="crawl-muted">{LOCAL_RUN_ACTIVE.includes(run.status) ? 'Scraping in progress — results appear here as pages finish.' : 'No sites in this run.'}</p>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default function CrawlPage({ onLeadAdded, onToast, brightDataReady, localDefaults }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [sampleLoading, setSampleLoading] = useState(false)
  const [fromSample, setFromSample] = useState(false)
  const [filters, setFilters] = useState({ q: '', type: 'all', qual: 'all', state: 'all', sort: 'opportunity' })
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState(null)
  const [addingKey, setAddingKey] = useState(null)
  const [addedMap, setAddedMap] = useState({})
  const fileRef = useRef(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const payload = await apiRequest('/api/crawl')
      setData(payload.imported ? payload : null)
      setFromSample(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => { setPage(1) }, [filters])

  const loadSample = async () => {
    setSampleLoading(true)
    setError('')
    try {
      const payload = await apiRequest('/api/crawl/sample')
      setData(payload)
      setFromSample(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSampleLoading(false)
    }
  }

  const importFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImporting(true)
    setError('')
    try {
      const text = await file.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('That file is not valid JSON — expected a crawl-export.json snapshot.')
      }
      const saved = await apiRequest('/api/crawl/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        timeoutMs: 120_000,
      })
      const payload = await apiRequest('/api/crawl')
      setData(payload.imported ? payload : null)
      setFromSample(false)
      setAddedMap({})
      onToast?.(`Imported ${saved.sites} crawled sites`)
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  const addLead = async (site, runId = null) => {
    const key = runId ? `local:${runId}:${site.id}` : site.id
    const endpoint = runId
      ? `/api/crawl/local-runs/${encodeURIComponent(runId)}/sites/${encodeURIComponent(site.id)}/add-lead`
      : `/api/crawl/sites/${encodeURIComponent(site.id)}/add-lead`
    setAddingKey(key)
    try {
      const result = await apiRequest(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      setAddedMap((prev) => ({ ...prev, [key]: { created: result.created, leadId: result.lead?.id } }))
      onLeadAdded?.(result.lead, result.created)
      onToast?.(result.created ? `Added ${result.lead.company} to Research` : `${result.lead.company} is already a lead`)
    } catch (err) {
      onToast?.(err.message)
    } finally {
      setAddingKey(null)
    }
  }

  const typeOptions = useMemo(() => {
    const counts = data?.siteSummary?.byWebsiteType || {}
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  }, [data])

  const filtered = useMemo(() => {
    const sites = data?.sites || []
    const q = filters.q.trim().toLowerCase()
    const rows = sites.filter((site) => {
      if (filters.type !== 'all' && site.website_type !== filters.type) return false
      if (filters.qual !== 'all' && site.qualification_state !== filters.qual) return false
      if (filters.state !== 'all' && site.crawl_state !== filters.state) return false
      if (q && !`${site.host} ${site.title || ''} ${site.url}`.toLowerCase().includes(q)) return false
      return true
    })
    const byRecent = (a, b) => new Date(b.last_result_at || 0).getTime() - new Date(a.last_result_at || 0).getTime()
    if (filters.sort === 'risk') rows.sort((a, b) => (b.last_visual_risk_score ?? -1) - (a.last_visual_risk_score ?? -1) || byRecent(a, b))
    else if (filters.sort === 'recent') rows.sort(byRecent)
    else if (filters.sort === 'host') rows.sort((a, b) => String(a.host).localeCompare(String(b.host)))
    else rows.sort((a, b) => (b.last_opportunity_score ?? -1) - (a.last_opportunity_score ?? -1) || byRecent(a, b))
    return rows
  }, [data, filters])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const summary = data?.summary
  const siteSummary = data?.siteSummary

  const setFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }))

  if (loading) {
    return <div className="panel crawl-loading"><LoaderCircle size={20} className="spin" /><p>Loading crawl data…</p></div>
  }

  return (
    <div className="crawl-page">
      <div className="crawl-head">
        <div>
          <h2 className="crawl-section-title">VPS crawler</h2>
          <p>
            {data
              ? <>Snapshot from {formatDateTime(data.exportedAt)} ({timeAgo(data.exportedAt)}){data.workerId ? ` · ${data.workerId}` : ''}{data.siteTruncated ? ` · showing ${data.sites.length} of ${data.siteTotal} sites` : ''}</>
              : 'Continuous website scanner — import a snapshot to review it here.'}
          </p>
        </div>
        <div className="crawl-head-actions">
          <button className="button button-secondary button-small" onClick={load} disabled={importing}><RefreshCw size={13} />Refresh</button>
          <button className="button button-primary button-small" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <LoaderCircle size={13} className="spin" /> : <Upload size={13} />}{importing ? 'Importing…' : 'Import snapshot'}
          </button>
          <input ref={fileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={importFile} aria-label="Import crawl-export.json" />
        </div>
      </div>

      {error && <div className="crawl-error-banner" role="alert"><span>{error}</span><button className="button button-quiet button-small" onClick={() => setError('')} aria-label="Dismiss error"><X size={13} /></button></div>}
      {fromSample && (
        <div className="crawl-sample-banner">
          <span>Viewing bundled sample data — import your real <code>crawl-export.json</code> to replace it.</span>
          <button className="button button-secondary button-small" onClick={() => fileRef.current?.click()}>Import snapshot</button>
        </div>
      )}

      {!data ? (
        <section className="panel crawl-empty" aria-label="No crawl data yet">
          <div className="empty-state">
            <h3>No crawl snapshot imported</h3>
            <p>Export on your VPS, copy the file here, and import it — or explore with sample data first.</p>
          </div>
          <ol className="crawl-steps">
            <li><span>On the VPS, export a snapshot:</span><code>set -a; source .env; set +a; npm run export -- --out crawl-export.json</code></li>
            <li><span>Copy it to this machine:</span><code>scp user@vps:~/projects/scoutline-crawler/crawl-export.json ~/Downloads/</code></li>
            <li><span>Import it with the button above.</span></li>
          </ol>
          <div className="crawl-empty-actions">
            <button className="button button-secondary" onClick={loadSample} disabled={sampleLoading}>
              {sampleLoading ? <LoaderCircle size={14} className="spin" /> : null}Explore sample data
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="crawl-stats" aria-label="Crawl summary">
            <article className="crawl-stat">
              <small>Crawled today</small>
              <strong>{summary.processedToday}</strong>
              <span>of {summary.dailyLimit} daily limit</span>
            </article>
            <article className="crawl-stat">
              <small>Successful</small>
              <strong className="crawl-good">{summary.completedToday}</strong>
              <span>{summary.scheduledToday} scheduled today</span>
            </article>
            <article className="crawl-stat">
              <small>Failed</small>
              <strong className={summary.failedToday ? 'crawl-bad' : ''}>{summary.failedToday}</strong>
              <span>{summary.states?.blocked ? `${summary.states.blocked} blocked · ` : ''}{formatBytes(summary.databaseBytes)} database</span>
            </article>
            <article className="crawl-stat">
              <small>Eligible sites</small>
              <strong className="crawl-good">{summary.qualifications?.eligible ?? siteSummary.eligible}</strong>
              <span>worth working on · {siteSummary.avgOpportunity != null ? `avg opportunity ${siteSummary.avgOpportunity}` : 'no scores yet'}</span>
            </article>
          </section>

          <div className="crawl-grid">
            <section className="panel crawl-panel" aria-label="Daily crawl trend">
              <div className="section-heading"><div><h2>Daily trend</h2><span>Last {data.history.length} days · completed vs failed, eligible overlay.</span></div></div>
              {data.history.length ? <TrendChart history={data.history} /> : <p className="crawl-muted">No history in this snapshot.</p>}
            </section>
            <section className="panel crawl-panel" aria-label="Website types">
              <div className="section-heading"><div><h2>Website types</h2><span>Select a type to filter the table.</span></div></div>
              <div className="crawl-types">
                {typeOptions.map((type) => (
                  <button
                    key={type}
                    className={cn('crawl-type', filters.type === type && 'is-active')}
                    aria-pressed={filters.type === type}
                    onClick={() => setFilter('type', filters.type === type ? 'all' : type)}
                  >
                    <span>{type}</span><strong>{siteSummary.byWebsiteType[type]}</strong>
                  </button>
                ))}
                {!typeOptions.length && <p className="crawl-muted">No sites in this snapshot.</p>}
              </div>
              <div className="section-heading crawl-qual-head"><div><h2>Qualification</h2></div></div>
              <div className="crawl-quals">
                {['eligible', 'rejected', 'not_evaluated'].map((qual) => (
                  <button key={qual} className={cn('crawl-type', filters.qual === qual && 'is-active')} aria-pressed={filters.qual === qual} onClick={() => setFilter('qual', filters.qual === qual ? 'all' : qual)}>
                    <span>{qualBadge(qual).label}</span><strong>{siteSummary.byQualification[qual] || 0}</strong>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <section className="panel crawl-panel" aria-label="Crawled sites">
            <div className="section-heading">
              <div><h2>Crawled sites</h2><span>{filtered.length} of {data.sites.length} sites · expand a row for detail.</span></div>
            </div>
            <div className="crawl-filters">
              <label className="table-search crawl-search"><Search size={14} aria-hidden="true" /><input value={filters.q} onChange={(event) => setFilter('q', event.target.value)} placeholder="Search sites…" aria-label="Search crawled sites by host or title" />{filters.q && <button onClick={() => setFilter('q', '')} aria-label="Clear search"><X size={12} /></button>}</label>
              <label><span>State</span>
                <select value={filters.state} onChange={(event) => setFilter('state', event.target.value)} aria-label="Filter by crawl state">
                  <option value="all">All states</option>
                  {['completed', 'failed', 'blocked', 'crawling', 'queued', 'pending', 'disabled'].map((state) => (
                    <option key={state} value={state}>{stateBadge(state).label} ({siteSummary.byCrawlState[state] || 0})</option>
                  ))}
                </select>
              </label>
              <label><span>Sort</span>
                <select value={filters.sort} onChange={(event) => setFilter('sort', event.target.value)} aria-label="Sort crawled sites">
                  {SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}
                </select>
              </label>
              {(filters.q || filters.type !== 'all' || filters.qual !== 'all' || filters.state !== 'all') && (
                <button className="button button-quiet button-small" onClick={() => setFilters({ q: '', type: 'all', qual: 'all', state: 'all', sort: filters.sort })}>Clear filters</button>
              )}
            </div>
            <SiteTable
              sites={paged}
              isExpanded={(site) => expandedId === site.id}
              onToggle={(site) => setExpandedId(expandedId === site.id ? null : site.id)}
              isAdding={(site) => addingKey === site.id}
              addedFor={(site) => addedMap[site.id]}
              onAddLead={(site) => addLead(site)}
              emptyTitle="No sites match"
              emptyHint="Adjust the search or filters."
            />
            {totalPages > 1 && (
              <div className="crawl-pagination">
                <button className="button button-secondary button-small" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</button>
                <span>Page {safePage} of {totalPages} · {filtered.length} sites</span>
                <button className="button button-secondary button-small" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next</button>
              </div>
            )}
          </section>
        </>
      )}

      <LocalScrapePanel brightDataReady={brightDataReady} onToast={onToast} addingKey={addingKey} addedMap={addedMap} onAddLead={addLead} localDefaults={localDefaults} />
    </div>
  )
}
