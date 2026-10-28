import { useState } from 'react'
import { Copy, ExternalLink, LoaderCircle, RefreshCw, ScanEye, Sparkles } from 'lucide-react'
import { CONCEPT_STATUS_LABEL } from './ConceptReview.jsx'

const PLAY_LABEL = { redesign: 'Redesign', audit: 'Audit', skip: 'Skip' }

export function PlayTag({ play }) {
  if (!play) return <span className="play-tag play-none">Not sorted</span>
  return <span className={`play-tag play-${play}`}>{PLAY_LABEL[play] || play}</span>
}

// Saved screenshots live under /api/leads/:id/screens/<file>; the visual
// review records which files it wrote (desktop, mobile, desktopFull, ...).
export function leadScreens(lead) {
  const files = lead?.visualReview?.files
  if (!files) return null
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, `/api/leads/${lead.id}/screens/${file}`]))
}

function ScoreRow({ label, score, tone, detail }) {
  const value = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null
  return (
    <div className="score-row">
      <div className="score-row-head"><span>{label}</span><span className="num">{value ?? '—'}</span></div>
      <div className="score-bar" aria-hidden="true"><span className={tone} style={{ transform: `scaleX(${(value ?? 0) / 100})` }} /></div>
      {detail && <small>{detail}</small>}
    </div>
  )
}

const CONFIDENCE = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }
const BASIS = { 'visual+markup': 'visual review and markup', markup: 'markup only', presence: 'web presence', unscanned: 'not scanned yet' }

export function LeadEvidence({ lead, api, onLeadChanged, onToast, onDraft }) {
  const [view, setView] = useState('desktop')
  const [busy, setBusy] = useState('')
  const q = lead.qualification
  const screens = leadScreens(lead)
  const shot = screens?.[view]
  const visual = lead.visualReview

  const run = async (kind, path, message) => {
    setBusy(kind)
    try {
      await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      onToast(message)
      onLeadChanged()
    } catch (caught) {
      onToast({ message: caught.message || 'Could not start the job', tone: 'error' })
    } finally { setBusy('') }
  }
  const requalify = () => run('qualify', `/api/leads/${lead.id}/qualify`, `${lead.company} queued for qualification`)
  const reviewVisually = () => run('visual', `/api/leads/${lead.id}/visual-review`, `${lead.company} queued for visual review`)
  const [conceptWarning, setConceptWarning] = useState(false)
  const leadEmail = lead.qualification?.contact?.email || (/@/.test(lead.email || '') ? lead.email : null)
  const generateConcept = () => {
    if (!leadEmail && !conceptWarning) return setConceptWarning(true)
    setConceptWarning(false)
    run('concept', `/api/leads/${lead.id}/concept`, `${lead.company} queued for a redesign concept. It takes a few minutes.`)
  }
  const copyEmail = async (email) => {
    try { await navigator.clipboard.writeText(email); onToast('Email copied') } catch { onToast({ message: 'Could not copy the email', tone: 'error' }) }
  }

  if (!q) {
    return (
      <div className="evidence-empty">
        <strong>Not sorted into a play yet</strong>
        <span>Qualification scans the site, finds a contact, and decides between redesign, audit, and skip.</span>
        <button type="button" className="button button-primary" onClick={requalify} disabled={busy === 'qualify'}>{busy === 'qualify' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Qualify now</button>
      </div>
    )
  }

  const weakness = q.siteWeakness || {}
  const worth = q.businessWorth || {}
  const contact = q.contact || {}
  const findings = weakness.reasons || []

  return (
    <div className="evidence">
      <section className="evidence-main">
        <div className="panel shot-panel">
          <div className="shot-bar">
            <div className="segmented" role="tablist" aria-label="Screenshot">
              {['desktop', 'mobile'].map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item === 'desktop' ? 'Desktop' : 'Mobile'}</button>)}
            </div>
            {screens?.[`${view}Full`] && <a href={screens[`${view}Full`]} target="_blank" rel="noreferrer">Full page <ExternalLink size={12} aria-hidden="true" /></a>}
            {visual?.reviewedAt && <span className="shot-meta">captured {new Date(visual.reviewedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
          </div>
          {shot ? <div className={`shot shot-${view}`}><img src={shot} alt={`${lead.company} website on ${view}`} /></div> : (
            <div className="shot shot-empty">
              <span>{lead.website ? 'No screenshot saved yet.' : 'This business has no website to capture.'}</span>
              {lead.website && <button type="button" className="button button-secondary button-small" onClick={reviewVisually} disabled={busy === 'visual'}>{busy === 'visual' ? <LoaderCircle className="spin" size={14} /> : <ScanEye size={14} />}Take screenshots and review</button>}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>What we found</h2><span className="num">{findings.length}</span></div>
          {findings.length ? (
            <ol className="findings">
              {findings.map((item, index) => (
                <li key={`${index}-${item.text}`}>
                  <span className="finding-num">{index + 1}</span>
                  <span className="finding-text"><strong>{item.text}</strong>{item.evidence && <small>{item.evidence}</small>}</span>
                </li>
              ))}
            </ol>
          ) : <p className="panel-note">{weakness.basis === 'unscanned' ? 'The site has not been scanned yet.' : 'No site problems found in the markup.'}{q.needsVisualReview && !visual?.verdict ? ' A visual review would settle whether the design is dated.' : ''}</p>}
          {visual?.summary && <p className="panel-note visual-summary"><strong>Visual review:</strong> {visual.summary}{visual.eraGuess ? ` (looks like ${visual.eraGuess})` : ''}</p>}
        </div>
      </section>

      <aside className="evidence-side">
        <section className="panel">
          <h2>Why {q.play === 'skip' ? 'skip' : q.play}</h2>
          <p className="panel-text">{q.playReason}</p>
          <small className="panel-meta">{CONFIDENCE[q.confidence] || 'Confidence unknown'} · based on {BASIS[weakness.basis] || weakness.basis || 'the scan'}</small>
          <div className="panel-actions">
            {q.needsVisualReview && lead.website && !visual?.verdict && <button type="button" className="button button-secondary button-small" onClick={reviewVisually} disabled={busy === 'visual'}>{busy === 'visual' ? <LoaderCircle className="spin" size={14} /> : <ScanEye size={14} />}Visual review</button>}
            <button type="button" className="button button-secondary button-small" onClick={requalify} disabled={busy === 'qualify'}>{busy === 'qualify' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Re-check</button>
          </div>
        </section>

        <section className="panel">
          <h2>Redesign concept</h2>
          {lead.concept && lead.concept.status !== 'rejected'
            ? <p className="panel-text">{CONCEPT_STATUS_LABEL[lead.concept.status] || lead.concept.status} · {lead.concept.key}.goodshigoto.com</p>
            : <p className="panel-text">A new homepage for them, written by Claude and held for your review in Today, then Concepts.</p>}
          {lead.concept?.problems?.length > 0 && lead.concept.status === 'needs-fix' && <small className="panel-meta">{lead.concept.problems.join(' · ')}</small>}
          {conceptWarning && <p className="panel-text is-missing" role="alert">This lead has no email, so you’d have to reach them by phone or their website form. Generate anyway?</p>}
          <div className="panel-actions">
            {!lead.website ? <small className="panel-meta">No website to redesign.</small>
              : lead.concept?.status === 'live' ? <a className="button button-secondary button-small" href={lead.concept.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open live concept</a>
                : lead.concept?.status === 'generating' ? <span className="panel-meta"><LoaderCircle className="spin" size={14} /> Claude is writing it</span>
                  : <>
                    <button type="button" className="button button-secondary button-small" onClick={generateConcept} disabled={busy === 'concept'}>{busy === 'concept' ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{conceptWarning ? 'Generate anyway' : lead.concept && lead.concept.status !== 'rejected' ? 'Generate again' : 'Generate concept'}</button>
                    {conceptWarning && <button type="button" className="button button-quiet button-small" onClick={() => setConceptWarning(false)}>Cancel</button>}
                  </>}
            {lead.concept?.generatedAt && lead.concept.status !== 'live' && <a className="button button-quiet button-small" href={`/api/leads/${lead.id}/concept/preview`} target="_blank" rel="noreferrer"><ExternalLink size={14} />Preview</a>}
          </div>
        </section>

        <section className="panel">
          <h2>Scores</h2>
          <ScoreRow label="Worth pitching" score={worth.score} tone="bar-ink" detail={(worth.reasons || []).slice(0, 4).map((item) => item.text).join(' · ')} />
          <ScoreRow label="Site weakness" score={weakness.score} tone="bar-weak" detail={visual?.verdict ? `Visual review: ${visual.verdict}` : weakness.basis === 'markup' ? 'From the markup scan' : null} />
        </section>

        <section className="panel">
          <h2>Contact</h2>
          {contact.email ? (
            <div className="contact-email"><span className="mono">{contact.email}</span><button type="button" className="button button-secondary button-small" onClick={() => copyEmail(contact.email)}><Copy size={13} />Copy</button></div>
          ) : <p className="panel-text is-missing">No email found{contact.channel && contact.channel !== 'none' ? `. Reach them by ${contact.channel}.` : ', and no other contact route.'}</p>}
          <small className="panel-meta">{[contact.emailSource ? `From ${contact.emailSource}` : null, contact.phone || lead.phone, contact.ownerName ? `Owner: ${contact.ownerName}` : 'Owner’s name not found'].filter(Boolean).join(' · ')}</small>
        </section>

        {q.pitchHooks?.length > 0 && (
          <section className="panel">
            <h2>Lead the email with</h2>
            <ul className="hooks">{[...new Set(q.pitchHooks)].map((hook) => <li key={hook}>{hook}</li>)}</ul>
            {q.play !== 'skip' && <button type="button" className="button button-primary button-small" onClick={onDraft}>Draft email</button>}
          </section>
        )}

        {q.flags?.length > 0 && (
          <section className="panel">
            <h2>Notes</h2>
            <ul className="hooks">{q.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
          </section>
        )}
      </aside>
    </div>
  )
}
