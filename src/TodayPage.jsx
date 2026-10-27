import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Clock, Globe, Mail, Plus, SearchX, Sparkles, WifiOff } from 'lucide-react'
import { taskBucket } from '../server/services/brief.js'
import { PlayTag } from './leadUi.jsx'
import { ConceptCard } from './ConceptReview.jsx'

const TABS = [
  { id: 'pitch', label: 'To pitch', match: (p) => p.play !== 'skip' },
  { id: 'redesign', label: 'Redesign', match: (p) => p.play === 'redesign' },
  { id: 'concepts', label: 'Concepts', match: (p) => Boolean(p.concept) && p.concept.status !== 'rejected' },
  { id: 'audit', label: 'Audit', match: (p) => p.play === 'audit' },
  { id: 'email', label: 'Needs an email', match: (p) => p.play !== 'skip' && !p.contact?.email },
  { id: 'skip', label: 'Skipped', match: (p) => p.play === 'skip' },
]

const PRESENCE_LABEL = {
  none: 'No website',
  'social-only': 'Social page only',
  'free-subdomain': 'Free builder subdomain',
  'dead-domain': 'Domain no longer resolves',
  unreachable: 'Site could not be loaded',
  placeholder: 'Placeholder page',
  'location-page': 'Location page on a larger brand',
}

function SitePreview({ prospect }) {
  const src = prospect.screens?.desktop
  if (src) return <div className="site-preview"><img src={src} alt={`${prospect.company} website, above the fold`} loading="lazy" /></div>
  const NoSite = prospect.presence === 'unreachable' || prospect.presence === 'dead-domain' ? WifiOff : prospect.presence === 'own-site' ? Globe : SearchX
  return (
    <div className="site-preview site-preview-empty">
      <NoSite size={18} aria-hidden="true" />
      <span>{PRESENCE_LABEL[prospect.presence] || (prospect.website ? 'No screenshot yet' : 'No website')}</span>
      {prospect.website && <small>{String(prospect.website).replace(/^https?:\/\//, '').replace(/\/$/, '')}</small>}
    </div>
  )
}

export default function TodayPage({ api, leads, onOpen, goTo, onNewCrawl, reloadKey }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('pitch')
  const [localReload, setLocalReload] = useState(0)
  const [drafting, setDrafting] = useState('')

  useEffect(() => {
    let stopped = false
    api('/api/prospects?play=all&limit=500')
      .then((body) => { if (!stopped) { setData(body); setError('') } })
      .catch((caught) => { if (!stopped) setError(caught.message) })
    return () => { stopped = true }
  }, [api, reloadKey, localReload])

  const prospects = data?.prospects || []
  const counts = useMemo(() => Object.fromEntries(TABS.map((item) => [item.id, prospects.filter(item.match).length])), [prospects])
  const visible = prospects.filter(TABS.find((item) => item.id === tab).match)
  const dueLeads = leads.filter((lead) => ['today', 'overdue'].includes(taskBucket(lead.nextTask)))
  const unqualified = leads.filter((lead) => !lead.qualification).length
  const reload = () => setLocalReload((value) => value + 1)
  const draftConcepts = async () => {
    setDrafting('Queuing…')
    try {
      const body = await api('/api/concepts/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 3 }) })
      setDrafting(body.queued ? `${body.queued} queued. Each takes a few minutes.` : 'No redesign leads with an email are waiting.')
      reload()
    } catch (caught) {
      setDrafting(caught.message)
    }
  }
  const open = (prospect) => {
    const lead = leads.find((item) => item.id === prospect.id)
    if (lead) onOpen(lead, { queue: visible.map((item) => item.id) })
  }

  return (
    <div className="today">
      {dueLeads.length > 0 && (
        <button type="button" className="today-due" onClick={() => goTo('Outreach')}>
          <Clock size={17} aria-hidden="true" />
          <span><strong>{dueLeads.length === 1 ? '1 follow-up is due' : `${dueLeads.length} follow-ups are due`}</strong> · {dueLeads.slice(0, 3).map((lead) => lead.company).join(', ')}{dueLeads.length > 3 ? '…' : ''}</span>
          <em>Open outreach <ArrowRight size={14} aria-hidden="true" /></em>
        </button>
      )}

      <div className="tabs" role="tablist" aria-label="Filter prospects">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.label} <span className="num">{counts[item.id] ?? 0}</span>
          </button>
        ))}
        {tab === 'concepts' && data?.canReviewConcepts
          ? <span className="tabs-note concept-draft"><button type="button" className="button" onClick={draftConcepts} disabled={drafting === 'Queuing…'}><Sparkles size={14} aria-hidden="true" />Draft 3 concepts</button>{drafting && <small>{drafting}</small>}</span>
          : <span className="tabs-note">Sorted by priority</span>}
      </div>

      {error ? <div className="today-empty" role="alert"><strong>Couldn’t load today’s leads</strong><span>{error}</span></div>
        : !data ? <div className="lead-grid" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div key={index} className="lead-card lead-card-skeleton" />)}</div>
          : visible.length === 0 ? (
            <div className="today-empty">
              <strong>{prospects.length ? 'Nothing in this view' : 'No qualified leads yet'}</strong>
              <span>{prospects.length ? 'Try another tab.' : unqualified ? `${unqualified} leads are waiting to be sorted into plays. Start a crawl or run qualification.` : 'Run a crawl to find trade businesses and sort them into plays.'}</span>
              {!prospects.length && <button type="button" className="button button-primary" onClick={onNewCrawl}><Plus size={15} aria-hidden="true" />New crawl</button>}
            </div>
          ) : tab === 'concepts' ? (
            <div className="concept-grid">
              {visible.map((prospect) => <ConceptCard key={prospect.id} api={api} prospect={prospect} canAct={Boolean(data.canReviewConcepts)} onChanged={reload} />)}
            </div>
          ) : (
            <div className="lead-grid">
              {visible.map((prospect) => (
                <button key={prospect.id} type="button" className="lead-card" onClick={() => open(prospect)}>
                  <SitePreview prospect={prospect} />
                  <span className="lead-card-body">
                    <span className="lead-card-head">
                      <span className="lead-card-title"><strong>{prospect.company}</strong><small>{[prospect.category, prospect.rating ? `${prospect.rating}★ · ${prospect.reviews ?? 0}` : null].filter(Boolean).join(' · ')}</small></span>
                      <span className="priority" title="Priority">{prospect.priority}</span>
                    </span>
                    <PlayTag play={prospect.play} />
                    <span className="lead-card-reason">{prospect.playReason}</span>
                    <span className={prospect.contact?.email ? 'lead-card-email' : 'lead-card-email is-missing'}><Mail size={13} aria-hidden="true" /><span>{prospect.contact?.email || (prospect.contact?.channel && prospect.contact.channel !== 'none' ? `No email, reach by ${prospect.contact.channel}` : 'No email or contact route found')}</span></span>
                  </span>
                </button>
              ))}
            </div>
          )}
    </div>
  )
}
