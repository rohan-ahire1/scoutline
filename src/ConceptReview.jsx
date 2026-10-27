import { useState } from 'react'
import { Check, ExternalLink, RefreshCw, X } from 'lucide-react'

const STATUS_LABEL = {
  generating: 'Claude is writing it',
  review: 'Ready for review',
  'needs-fix': 'Failed its checks',
  live: 'Live',
  rejected: 'Rejected',
  failed: 'Generation failed',
}

// One generated concept: a phone-width preview of the page, what the checks
// found, and the review actions. Nothing goes live until Approve.
export function ConceptCard({ api, prospect, onChanged }) {
  const concept = prospect.concept
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const act = async (action, body) => {
    setBusy(action)
    setError('')
    try {
      await api(`/api/leads/${prospect.id}/concept${action === 'generate' ? '' : `/${action}`}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      onChanged()
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy('')
    }
  }
  const canApprove = ['review', 'needs-fix'].includes(concept.status)
  return (
    <div className="concept-card">
      {concept.preview && concept.status !== 'generating'
        ? <iframe className="concept-frame" src={concept.preview} title={`${prospect.company} concept`} sandbox="allow-scripts allow-forms" loading="lazy" />
        : <div className="concept-frame concept-frame-empty">{STATUS_LABEL[concept.status] || concept.status}</div>}
      <div className="concept-body">
        <strong>{prospect.company}</strong>
        <small>{STATUS_LABEL[concept.status] || concept.status} · {concept.key}.goodshigoto.com</small>
        {concept.problems?.length > 0 && <ul className="concept-problems">{concept.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        {error && <p className="concept-error" role="alert">{error}</p>}
        <div className="concept-actions">
          {canApprove && <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => act('approve', { override: concept.status === 'needs-fix' })}><Check size={14} aria-hidden="true" />{concept.status === 'needs-fix' ? 'Publish anyway' : 'Approve & publish'}</button>}
          {concept.status === 'live' && concept.url && <a className="button" href={concept.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Open</a>}
          {concept.preview && concept.status !== 'live' && <a className="button" href={concept.preview} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Full preview</a>}
          {prospect.website && <a className="button" href={`https://${String(prospect.website).replace(/^https?:\/\//, '')}`} target="_blank" rel="noreferrer">Their site</a>}
          {concept.status !== 'generating' && concept.status !== 'live' && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => act('generate')}><RefreshCw size={14} aria-hidden="true" />Redo</button>}
          {['review', 'needs-fix', 'live'].includes(concept.status) && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => act('reject')}><X size={14} aria-hidden="true" />{concept.status === 'live' ? 'Take down' : 'Reject'}</button>}
        </div>
      </div>
    </div>
  )
}
