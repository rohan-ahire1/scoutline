import { useEffect, useRef, useState } from 'react'
import './landing.css'

const trailFilters = [
  { id: 'all', label: 'All' },
  { id: 'claim', label: 'Claims' },
  { id: 'source', label: 'Sources' },
  { id: 'brief', label: 'Brief' },
]

const trailItems = [
  {
    id: 'claim',
    index: '01',
    type: 'CLAIM',
    title: 'Energy cost corroborated',
    status: 'VERIFIED',
    tone: 'verified',
    source: 'IEA 2024 · p.18',
    metrics: '4 sources · 92% confidence',
    detail: 'A single claim is supported by four independent passages, with the source and publication date still attached.',
  },
  {
    id: 'source',
    index: '02',
    type: 'SOURCE',
    title: 'IEA 2024 / high proximity',
    status: 'LINKED',
    tone: 'linked',
    source: 'International Energy Agency · 2024',
    metrics: '12 sources · 05 signals',
    detail: 'Scoutline keeps the source close to the sentence it informs, so you can return to the original context in one move.',
  },
  {
    id: 'counterclaim',
    index: '03',
    type: 'COUNTERCLAIM',
    title: 'Grid load caveat surfaced',
    status: 'REVIEW',
    tone: 'review',
    source: 'Nature Energy · 2023 · p.04',
    metrics: '2 tensions · 1 open question',
    detail: 'A conflicting passage is promoted into the trail instead of being buried in notes, making the edge of the argument visible.',
  },
  {
    id: 'brief',
    index: '04',
    type: 'BRIEF',
    title: 'Section 01 ready to write',
    status: 'READY',
    tone: 'ready',
    source: 'Working brief · Findings',
    metrics: '3 claims · 8 citations',
    detail: 'The brief inherits its citations and unresolved questions from the trail, turning a blank page into a defensible starting point.',
  },
]

const workflowSteps = [
  {
    id: 'gather',
    index: '01',
    kicker: 'SOURCE CAPTURE',
    title: 'Gather without losing the thread.',
    body: 'Bring in the links, papers, transcripts, and fragments that shape a question. Scoutline preserves origin, date, and the useful passage as you go.',
    outputs: ['Saved source', 'Clean excerpt', 'Origin + date'],
    notation: '12 SOURCES / INTAKE',
  },
  {
    id: 'trace',
    index: '02',
    kicker: 'EVIDENCE TRACE',
    title: 'Follow the evidence all the way through.',
    body: 'Connect claims to the passages that earned them. Counterclaims, gaps, and confidence stay visible, so the shape of an argument is never implied by a summary alone.',
    outputs: ['Claim / energy cost', 'Source / IEA 2024', 'Counterclaim / grid load'],
    notation: '05 SIGNALS / TRACE',
  },
  {
    id: 'write',
    index: '03',
    kicker: 'BRIEF COMPOSITION',
    title: 'Write from a trail that can answer back.',
    body: 'Compose a brief with the trail beside you. Every sentence can keep its return path to the source, the tension, and the question that remains open.',
    outputs: ['Section 01 / Findings', '8 citations / attached', 'Return path / active'],
    notation: '01 BRIEF / COMPOSE',
  },
]

const featureRows = [
  {
    index: '01',
    title: 'Source memory, without the archive anxiety.',
    body: 'Capture the useful part of a source and preserve the context around it. Search later by claim, author, or question—not by the tab you forgot to bookmark.',
    label: 'CAPTURE',
  },
  {
    index: '02',
    title: 'Arguments with their edges intact.',
    body: 'Separate a supporting passage from a counterclaim, an open question, or a working assumption. The trail shows what is settled and what still needs attention.',
    label: 'TRACE',
  },
  {
    index: '03',
    title: 'Briefs that show their work.',
    body: 'Move from collected evidence to a readable point of view without losing the citations that make it credible. Export a brief that is ready to share and easy to inspect.',
    label: 'WRITE',
  },
]

const faqs = [
  {
    question: 'Is Scoutline another answer engine?',
    answer: 'No. Scoutline is the workspace around the answer: a place to collect sources, trace claims, surface tensions, and write with the evidence still in view. It helps a point of view become more defensible; it does not replace judgment.',
  },
  {
    question: 'What kind of research can I bring in?',
    answer: 'Start with links, papers, transcripts, notes, and excerpts. The product model is source-first, so each imported piece keeps its origin and can be connected to a claim, signal, or open question.',
  },
  {
    question: 'Can my team review the trail together?',
    answer: 'That is the intended workflow. Shared trails make the reasoning legible across a team: reviewers can inspect the source behind a claim, challenge a counterclaim, and leave the brief stronger than they found it.',
  },
  {
    question: 'Does Scoutline write the brief for me?',
    answer: 'It helps you move from evidence to structure and keeps the return path intact. The final point of view remains yours, with the research visible enough for another person to follow.',
  },
]

function Wordmark() {
  return (
    <span className="sl-wordmark-lockup">
      <span className="sl-wordmark-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>SCOUTLINE</span>
    </span>
  )
}

function Eyebrow({ children, light = false }) {
  return <span className={`sl-eyebrow${light ? ' sl-eyebrow-light' : ''}`}><i aria-hidden="true" />{children}</span>
}

function LandingPage() {
  const rootRef = useRef(null)
  const dialogRef = useRef(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [trailFilter, setTrailFilter] = useState('all')
  const [selectedTrailId, setSelectedTrailId] = useState('claim')
  const [trailLive, setTrailLive] = useState(true)
  const [activeStep, setActiveStep] = useState('trace')
  const [activeFaq, setActiveFaq] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [formStatus, setFormStatus] = useState({ type: 'idle', message: '' })

  const visibleTrailItems = trailItems.filter((item) => trailFilter === 'all' || item.id === trailFilter)
  const selectedTrail = trailItems.find((item) => item.id === selectedTrailId) || trailItems[0]
  const selectedStep = workflowSteps.find((step) => step.id === activeStep) || workflowSteps[1]

  useEffect(() => {
    document.title = 'Scoutline — Evidence, visible'
    const root = rootRef.current
    if (!root) return undefined
    root.classList.add('sl-reveal-ready')
    const revealItems = root.querySelectorAll('[data-reveal]')
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion || !window.IntersectionObserver) {
      revealItems.forEach((item) => item.classList.add('is-visible'))
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        }
      })
    }, { threshold: 0.12 })
    revealItems.forEach((item, index) => {
      item.style.setProperty('--sl-reveal-delay', `${Math.min(index * 45, 240)}ms`)
      observer.observe(item)
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!trailLive) return undefined
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return undefined
    const timer = window.setInterval(() => {
      setSelectedTrailId((current) => {
        const currentIndex = trailItems.findIndex((item) => item.id === current)
        return trailItems[(currentIndex + 1) % trailItems.length].id
      })
    }, 4800)
    return () => window.clearInterval(timer)
  }, [trailLive])

  useEffect(() => {
    if (!dialogOpen) return undefined
    const previousFocus = document.activeElement
    const input = dialogRef.current?.querySelector('input')
    input?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setDialogOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.classList.add('sl-dialog-open')
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('sl-dialog-open')
      previousFocus?.focus?.()
    }
  }, [dialogOpen])

  useEffect(() => {
    if (!visibleTrailItems.some((item) => item.id === selectedTrailId)) {
      setSelectedTrailId(visibleTrailItems[0]?.id || 'claim')
    }
  }, [trailFilter, selectedTrailId, visibleTrailItems])

  const closeMobileMenu = () => setMobileOpen(false)
  const openDialog = () => {
    setMobileOpen(false)
    setFormStatus({ type: 'idle', message: '' })
    setDialogOpen(true)
  }

  const submitInterest = (event) => {
    event.preventDefault()
    const value = email.trim()
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setFormStatus({ type: 'error', message: 'Enter a valid work email to continue.' })
      return
    }
    try {
      localStorage.setItem('scoutline-interest', JSON.stringify({ email: value, capturedAt: new Date().toISOString() }))
    } catch {
      // The local demo still succeeds when storage is unavailable.
    }
    setFormStatus({ type: 'success', message: 'You’re on the shortlist. We’ll be in touch when your trail is ready.' })
  }

  return (
    <div className="landing-page" ref={rootRef}>
      <a className="sl-skip-link" href="#main-content">Skip to content</a>

      <header className={`sl-nav${mobileOpen ? ' is-open' : ''}`}>
        <div className="sl-nav-inner">
          <a className="sl-wordmark" href="#top" aria-label="Scoutline home" onClick={closeMobileMenu}><Wordmark /></a>
          <nav className="sl-nav-links" aria-label="Primary navigation">
            <a href="#method">Method</a>
            <a href="#signal">The trail</a>
            <a href="#questions">Questions</a>
          </nav>
          <div className="sl-nav-actions">
            <a className="sl-nav-signin" href="/overview">Sign in <span aria-hidden="true">↗</span></a>
            <button className="sl-button sl-button-nav" type="button" onClick={openDialog}>Open a trail</button>
          </div>
          <button className="sl-mobile-toggle" type="button" aria-expanded={mobileOpen} aria-controls="sl-mobile-panel" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} onClick={() => setMobileOpen((current) => !current)}>
            <span /><span />
          </button>
        </div>
        <div className="sl-mobile-panel" id="sl-mobile-panel">
          <a href="#method" onClick={closeMobileMenu}>Method <span aria-hidden="true">01</span></a>
          <a href="#signal" onClick={closeMobileMenu}>The trail <span aria-hidden="true">02</span></a>
          <a href="#questions" onClick={closeMobileMenu}>Questions <span aria-hidden="true">03</span></a>
          <a href="/overview" onClick={closeMobileMenu}>Sign in <span aria-hidden="true">↗</span></a>
          <button className="sl-button sl-button-nav" type="button" onClick={openDialog}>Open a trail <span aria-hidden="true">↗</span></button>
        </div>
      </header>

      <main id="main-content">
        <section className="sl-hero sl-section-frame" id="top">
          <div className="sl-hero-copy" data-reveal>
            <Eyebrow>AI RESEARCH WORKSPACE / BUILT FOR DEFENSIBLE THINKING</Eyebrow>
            <h1>Turn scattered reading into a brief that can answer back.</h1>
            <p className="sl-hero-lede">Scoutline gathers every source, claim, and counterclaim into one visible trail—so your conclusions stay close to their evidence.</p>
            <div className="sl-hero-actions">
              <button className="sl-button sl-button-primary" type="button" onClick={openDialog}>Start a trail <span aria-hidden="true">↗</span></button>
              <a className="sl-button sl-button-quiet" href="#method">See the method <span aria-hidden="true">↘</span></a>
            </div>
            <div className="sl-hero-meta">
              <span>FOR ANALYSTS</span>
              <span>RESEARCH TEAMS</span>
              <span>DESIGNERS</span>
            </div>
          </div>

          <div className="sl-hero-visual sl-reveal-delay" data-reveal>
            <div className="sl-visual-caption"><span>EVIDENCE TRAIL / LIVE</span><button type="button" aria-pressed={trailLive} onClick={() => setTrailLive((current) => !current)}><i className={`sl-live-dot${trailLive ? ' is-live' : ''}`} aria-hidden="true" />{trailLive ? 'Pause' : 'Resume'} scan</button></div>
            <div className="sl-trail-panel" role="region" aria-label="Interactive evidence trail demo">
              <div className="sl-trail-head">
                <div><span className="sl-data-label">WORKSPACE / CLIMATE TRANSITION</span><strong>Energy transition, 2024</strong></div>
                <span className="sl-trail-count">12 SOURCES / 05 SIGNALS</span>
              </div>
              <div className="sl-trail-filters" role="tablist" aria-label="Evidence types">
                {trailFilters.map((filter) => (
                  <button key={filter.id} type="button" role="tab" aria-selected={trailFilter === filter.id} className={trailFilter === filter.id ? 'is-active' : ''} onClick={() => setTrailFilter(filter.id)}>{filter.label}</button>
                ))}
              </div>
              <div className="sl-trail-list">
                {visibleTrailItems.map((item) => (
                  <button key={item.id} type="button" className={`sl-trail-row${selectedTrailId === item.id ? ' is-selected' : ''}`} aria-pressed={selectedTrailId === item.id} onClick={() => setSelectedTrailId(item.id)}>
                    <span className="sl-trail-index">{item.index}</span>
                    <span className="sl-trail-type">{item.type}</span>
                    <span className="sl-trail-title">{item.title}</span>
                    <span className={`sl-trail-status sl-status-${item.tone}`}>{item.status}</span>
                    <span className="sl-trail-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
              <div className="sl-trail-detail" aria-live="polite">
                <div className="sl-trail-detail-title"><span className="sl-data-label">{selectedTrail.type} / SELECTED</span><strong>{selectedTrail.title}</strong></div>
                <p>{selectedTrail.detail}</p>
                <div className="sl-trail-detail-meta"><span>{selectedTrail.source}</span><span>{selectedTrail.metrics}</span></div>
              </div>
              <div className="sl-trail-foot"><span>SOURCES RESOLVED / 12 OF 12</span><span>TRAIL INTACT <i aria-hidden="true" /></span></div>
            </div>
          </div>
        </section>

        <section className="sl-proof sl-section-frame" aria-labelledby="proof-title">
          <div className="sl-proof-intro" data-reveal>
            <Eyebrow>THE COST OF CONTEXT SWITCHING</Eyebrow>
            <h2 id="proof-title">Every decision keeps a return path.</h2>
            <p>From first source to final sentence, the trail stays close enough to inspect.</p>
          </div>
          <div className="sl-metric-grid" data-reveal>
            <div className="sl-metric"><strong>12</strong><span>SOURCE THREADS</span><small>captured in one working trail</small></div>
            <div className="sl-metric"><strong>05</strong><span>SIGNALS FOUND</span><small>claims, tensions, and gaps</small></div>
            <div className="sl-metric"><strong>1.7×</strong><span>LESS SWITCHING</span><small>between reading and writing</small></div>
          </div>
        </section>

        <section className="sl-method sl-paper-section sl-section-frame" id="method" aria-labelledby="method-title">
          <div className="sl-method-intro" data-reveal>
            <Eyebrow light>HOW SCOUTLINE WORKS / A QUIET SEQUENCE</Eyebrow>
            <h2 id="method-title">From source capture to defensible brief.</h2>
            <p>A quiet, repeatable sequence for the work between reading and writing.</p>
          </div>
          <div className="sl-method-layout">
            <div className="sl-step-rail" role="tablist" aria-label="Scoutline method">
              {workflowSteps.map((step) => (
                <button key={step.id} type="button" role="tab" aria-selected={activeStep === step.id} className={`sl-step-tab${activeStep === step.id ? ' is-active' : ''}`} onClick={() => setActiveStep(step.id)}>
                  <span className="sl-step-index">{step.index}</span>
                  <span><small>{step.kicker}</small><strong>{step.title}</strong></span>
                  <span className="sl-step-arrow" aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
            <article className="sl-method-detail" role="tabpanel" aria-label={selectedStep.kicker} data-reveal>
              <div className="sl-method-detail-head"><span>{selectedStep.notation}</span><i aria-hidden="true" /></div>
              <span className="sl-method-detail-kicker">{selectedStep.kicker}</span>
              <h3>{selectedStep.title}</h3>
              <p>{selectedStep.body}</p>
              <div className="sl-output-list">
                {selectedStep.outputs.map((output, index) => <div key={output}><span>0{index + 1}</span><strong>{output}</strong><i aria-hidden="true">↗</i></div>)}
              </div>
              <div className="sl-trace-notation"><span>RETURN PATH</span><div><i /><i /><i /></div><strong>VISIBLE</strong></div>
            </article>
          </div>
          <blockquote className="sl-method-quote" data-reveal><p>“The brief shows its work.”</p><cite>Trace claims back to the source that earned them.</cite></blockquote>
        </section>

        <section className="sl-signal sl-section-frame" id="signal" aria-labelledby="signal-title">
          <div className="sl-signal-head" data-reveal>
            <div><Eyebrow>MATERIALS OF THE TRAIL</Eyebrow><h2 id="signal-title">Less summary. More signal.</h2></div>
            <p>Research gets clearer when the useful tension is allowed to stay in the room.</p>
          </div>
          <div className="sl-feature-list">
            {featureRows.map((feature) => (
              <article className="sl-feature-row" key={feature.index} data-reveal>
                <span className="sl-feature-index">{feature.index}</span>
                <div className="sl-feature-copy"><span>{feature.label}</span><h3>{feature.title}</h3><p>{feature.body}</p></div>
                <span className="sl-feature-mark" aria-hidden="true">↗</span>
              </article>
            ))}
          </div>
        </section>

        <section className="sl-questions sl-paper-section sl-section-frame" id="questions" aria-labelledby="questions-title">
          <div className="sl-questions-intro" data-reveal><Eyebrow light>QUESTIONS / SHORT ANSWERS</Eyebrow><h2 id="questions-title">A workspace for the part AI can’t own.</h2><p>Scoutline keeps the reasoning legible—whether the next reader is a teammate, a client, or you three weeks from now.</p></div>
          <div className="sl-faq-list" data-reveal>
            {faqs.map((faq, index) => {
              const open = activeFaq === index
              return <div className={`sl-faq-item${open ? ' is-open' : ''}`} key={faq.question}><button type="button" aria-expanded={open} onClick={() => setActiveFaq(open ? -1 : index)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{faq.question}</strong><i aria-hidden="true">{open ? '−' : '+'}</i></button>{open && <div className="sl-faq-answer"><p>{faq.answer}</p></div>}</div>
            })}
          </div>
        </section>

        <section className="sl-cta sl-section-frame" id="start" data-reveal>
          <div><Eyebrow light>A BETTER BRIEF STARTS WITH A BETTER TRAIL</Eyebrow><h2>Make every conclusion traceable.</h2></div>
          <button className="sl-button sl-button-cta" type="button" onClick={openDialog}>Open Scoutline <span aria-hidden="true">↗</span></button>
        </section>
      </main>

      <footer className="sl-footer sl-section-frame">
        <div className="sl-footer-brand"><a className="sl-wordmark" href="#top"><Wordmark /></a><span>AI RESEARCH WORKSPACE</span></div>
        <div className="sl-footer-links"><a href="#method">Method</a><a href="#questions">Questions</a><a href="mailto:hello@scoutline.local">Contact</a></div>
        <span className="sl-footer-note">© 2026 SCOUTLINE / TRAIL INTACT</span>
      </footer>

      {dialogOpen && <div className="sl-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDialogOpen(false)}>
        <div className="sl-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="trail-dialog-title">
          <button className="sl-dialog-close" type="button" aria-label="Close start a trail dialog" onClick={() => setDialogOpen(false)}>×</button>
          <Eyebrow>START A TRAIL / PRIVATE PREVIEW</Eyebrow>
          <h2 id="trail-dialog-title">Give your next question a place to unfold.</h2>
          {formStatus.type === 'success' ? <div className="sl-form-success" role="status"><span aria-hidden="true">✓</span><p>{formStatus.message}</p><button className="sl-button sl-button-primary" type="button" onClick={() => setDialogOpen(false)}>Close <span aria-hidden="true">↗</span></button></div> : <form className="sl-interest-form" onSubmit={submitInterest} noValidate><label htmlFor="scoutline-email">Work email</label><input id="scoutline-email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); if (formStatus.type !== 'idle') setFormStatus({ type: 'idle', message: '' }) }} placeholder="you@yourteam.com" autoComplete="email" aria-invalid={formStatus.type === 'error'} aria-describedby={formStatus.type === 'error' ? 'scoutline-email-error' : 'scoutline-email-note'} />{formStatus.type === 'error' && <span className="sl-form-error" id="scoutline-email-error" role="alert">{formStatus.message}</span>}<small id="scoutline-email-note">No newsletter. We’ll only use this to open your private preview.</small><button className="sl-button sl-button-primary" type="submit">Request access <span aria-hidden="true">↗</span></button></form>}
          <p className="sl-dialog-foot">Your trail stays yours. No automatic outreach. No black-box summary without a return path.</p>
        </div>
      </div>}
    </div>
  )
}

export default LandingPage
