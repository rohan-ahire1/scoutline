import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, LoaderCircle, Mail, Pause, Play, Plus, RefreshCw, Send, X } from 'lucide-react'

const TABS = [
  { id: 'queue', label: 'Queue' },
  { id: 'templates', label: 'Templates' },
  { id: 'activity', label: 'Activity' },
  { id: 'schedule', label: 'Schedule' },
]

const STATUS = {
  queued: ['Scheduled', 'gray'],
  active: ['In sequence', 'blue'],
  sending: ['Sending', 'orange'],
  finished: ['Sequence done', 'slate'],
  replied: ['Replied', 'green'],
  'opted-out': ['Said no', 'amber'],
  bounced: ['Bounced', 'red'],
  stopped: ['Stopped', 'gray'],
  skipped: ['Skipped', 'gray'],
  failed: ['Failed', 'red'],
}

const ZONE_LABEL = { 'America/Denver': 'Utah', 'America/New_York': 'New York' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const stepLabel = (step) => (step === 0 ? 'Email 1' : `Follow-up ${step}`)

function formatAt(iso, timeZone) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

function formatDay(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(iso))
}

const minutesToTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const timeToMinutes = (value) => {
  const [h, m] = String(value || '').split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

function Badge({ status }) {
  const [label, tone] = STATUS[status] || [status, 'gray']
  return <span className={`badge badge-${tone}`}>{label}</span>
}

function EmailPreview({ preview }) {
  if (!preview) return null
  if (preview.error) return <p className="ap-preview-error">Can’t write this email: {preview.error}</p>
  return (
    <div className="ap-preview">
      <div className="ap-preview-subject"><span>Subject</span>{preview.subject}</div>
      <pre>{preview.text}</pre>
    </div>
  )
}

export default function AutopilotPage({ api, onOpenLead, onToast }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('queue')
  const [busy, setBusy] = useState('')

  const load = useCallback(() => api('/api/autopilot').then((body) => { setData(body); setError('') }).catch((caught) => setError(caught.message)), [api])
  useEffect(() => {
    load()
    const timer = window.setInterval(load, 60_000)
    return () => window.clearInterval(timer)
  }, [load])

  // Every action returns the fresh overview.
  const act = useCallback(async (key, path, body, method = 'POST') => {
    setBusy(key)
    try {
      const result = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      if (result?.config) setData(result)
      else if (result?.overview) setData(result.overview)
      return result
    } catch (caught) {
      onToast?.({ tone: 'error', message: caught.message })
      return null
    } finally {
      setBusy('')
    }
  }, [api, onToast])

  if (error && !data) return <div className="today-empty" role="alert"><strong>Couldn’t load the autopilot</strong><span>{error}</span><button className="button button-secondary button-small" onClick={load}>Try again</button></div>
  if (!data) return <div className="ap-loading" role="status"><LoaderCircle className="spin" size={16} />Loading autopilot…</div>

  return (
    <div className="ap">
      <StatusPanel data={data} busy={busy} act={act} goTemplates={() => setTab('templates')} />
      <div className="tabs" role="tablist" aria-label="Autopilot views">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.label}
            {item.id === 'queue' && <span className="num"> {data.upcoming.length || data.nextUp.length}</span>}
            {item.id === 'templates' && !data.config.approved && <i className="ap-dot" aria-label="needs approval" />}
          </button>
        ))}
        <button type="button" className="tabs-note ap-check" onClick={async () => { const result = await act('check', '/api/autopilot/check-replies'); if (result) onToast?.({ tone: 'success', message: `Checked Gmail: ${result.replies || 0} new replies, ${result.bounces || 0} bounces` }) }} disabled={busy === 'check' || !data.mailbox.configured}>
          {busy === 'check' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Check replies now
        </button>
      </div>
      {tab === 'queue' && <QueueView data={data} busy={busy} act={act} onOpenLead={onOpenLead} />}
      {tab === 'templates' && <TemplatesView data={data} api={api} busy={busy} act={act} onToast={onToast} />}
      {tab === 'activity' && <ActivityView data={data} onOpenLead={onOpenLead} />}
      {tab === 'schedule' && <ScheduleView data={data} busy={busy} act={act} />}
    </div>
  )
}

function StatusPanel({ data, busy, act, goTemplates }) {
  const { config, mailbox, stats } = data
  const running = config.running && config.approved && mailbox.configured
  const next = data.upcoming.find((row) => row.nextAt)
  const steps = [
    { done: mailbox.configured, label: mailbox.configured ? `Gmail connected · ${mailbox.user}` : 'Connect Gmail', hint: 'Add GMAIL_USER and GMAIL_APP_PASSWORD to the server secrets' },
    { done: config.approved, label: config.approved ? 'Templates approved' : 'Approve the templates', hint: config.problems[0] || 'Read them once, then press Approve', action: config.approved ? null : goTemplates },
    { done: running, label: running ? 'Running' : 'Turn it on' },
  ]
  const replyRate = stats.sent ? Math.round((stats.replied / stats.sent) * 100) : null
  return (
    <section className="panel ap-status">
      <div className="ap-status-head">
        <div className="ap-status-title">
          <span className={`ap-light ${running ? 'is-on' : ''}`} aria-hidden="true" />
          <div>
            <strong>{running ? 'Autopilot is on' : 'Autopilot is off'}</strong>
            <small>
              {running
                ? next ? `Next: ${next.company} · ${formatAt(next.nextAt, next.timeZone)} ${ZONE_LABEL[next.timeZone] || ''} time` : 'Nothing due. New emails are planned for the next sending day.'
                : 'Nothing is sent while it’s off. Replies are still checked.'}
            </small>
          </div>
        </div>
        {running
          ? <button className="button button-secondary" onClick={() => act('run', '/api/autopilot/running', { running: false })} disabled={busy === 'run'}><Pause size={14} />Pause</button>
          : <button className="button button-primary" onClick={() => act('run', '/api/autopilot/running', { running: true })} disabled={busy === 'run' || !config.approved || !mailbox.configured} title={!mailbox.configured ? 'Connect Gmail first' : !config.approved ? 'Approve the templates first' : ''}><Play size={14} />Turn on</button>}
      </div>
      {!running && (
        <ol className="ap-steps">
          {steps.map((step, index) => (
            <li key={step.label} className={step.done ? 'is-done' : ''}>
              <span className="ap-step-mark">{step.done ? <Check size={12} /> : index + 1}</span>
              <span>
                {step.action ? <button className="ap-link" onClick={step.action}>{step.label}</button> : step.label}
                {!step.done && step.hint && <small>{step.hint}</small>}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="ap-stats">
        <div><strong className="num">{stats.sentToday}</strong><span>Sent today</span></div>
        <div><strong className="num">{stats.sent}</strong><span>People emailed</span></div>
        <div><strong className="num">{stats.replied}</strong><span>Replied{replyRate != null ? ` · ${replyRate}%` : ''}</span></div>
        <div><strong className="num">{stats.inSequence}</strong><span>In sequence</span></div>
        <div><strong className="num">{stats.optedOut + stats.bounced}</strong><span>Said no / bounced</span></div>
        <div><strong className="num">{stats.eligible}</strong><span>Leads left to email</span></div>
      </div>
    </section>
  )
}

function QueueView({ data, busy, act, onOpenLead }) {
  const groups = useMemo(() => {
    const map = new Map()
    for (const row of data.upcoming) {
      const key = row.nextAt ? formatDay(row.nextAt, row.timeZone) : 'Not scheduled'
      map.set(key, [...(map.get(key) || []), row])
    }
    return [...map.entries()]
  }, [data.upcoming])
  return (
    <div className="ap-queue">
      {data.nextUp.length > 0 && (
        <section className="panel ap-section">
          <div className="section-heading"><div><h2>Next in line</h2><span>{data.config.running ? 'These get scheduled at the start of the next sending day.' : 'When you turn it on, these are the first emails to go out.'} Skip anyone you don’t want emailed.</span></div></div>
          <div className="ap-list">{data.nextUp.map((item) => <NextUpRow key={item.leadId} item={item} busy={busy} act={act} onOpenLead={onOpenLead} />)}</div>
        </section>
      )}
      {groups.map(([day, rows]) => (
        <section className="panel ap-section" key={day}>
          <div className="section-heading"><div><h2>{day}</h2><span>{rows.length} email{rows.length === 1 ? '' : 's'}</span></div></div>
          <div className="ap-list">{rows.map((row) => <QueueRow key={row.id} row={row} busy={busy} act={act} onOpenLead={onOpenLead} />)}</div>
        </section>
      ))}
      {!groups.length && !data.nextUp.length && <div className="today-empty"><strong>Nothing to send</strong><span>No leads with a usable email are left. Run a crawl to find more.</span></div>}
    </div>
  )
}

function NextUpRow({ item, busy, act, onOpenLead }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="ap-row">
      <button className="ap-row-main ap-row-compact" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="ap-row-who"><strong>{item.company}</strong><small>{item.email}</small></span>
        <span className="ap-row-subject">{item.preview?.subject || item.preview?.error}</span>
        <span className="priority">{item.priority}</span>
      </button>
      {open && (
        <div className="ap-row-body">
          <EmailPreview preview={item.preview} />
          <div className="ap-row-actions">
            <button className="button button-quiet button-small" onClick={() => onOpenLead?.(item.leadId)}>Open lead</button>
            <button className="button button-secondary button-small" onClick={() => act(`skip-${item.leadId}`, `/api/autopilot/leads/${encodeURIComponent(item.leadId)}/skip`)} disabled={busy === `skip-${item.leadId}`}><X size={13} />Don’t email</button>
          </div>
        </div>
      )}
    </article>
  )
}

function QueueRow({ row, busy, act, onOpenLead }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ observation: '', ownerName: '' })
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const startEdit = () => {
    setDraft({ observation: row.overrides?.observation || '', ownerName: row.overrides?.ownerName || '' })
    setEditing(true)
  }
  const save = async () => {
    const result = await act(`edit-${row.id}`, `/api/autopilot/emails/${row.id}`, draft, 'PATCH')
    if (result) setEditing(false)
  }
  return (
    <article className="ap-row">
      <button className="ap-row-main" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="ap-row-time num" title={`${formatAt(row.nextAt, viewerZone)} your time`}>{row.nextAt ? formatAt(row.nextAt, row.timeZone).replace(/^\w+ /, '') : '—'}<small>{ZONE_LABEL[row.timeZone] || row.timeZone}</small></span>
        <span className="ap-row-who"><strong>{row.company}</strong><small>{row.email}</small></span>
        <span className="ap-row-subject">{stepLabel(row.step)}{row.preview?.subject ? ` · ${row.preview.subject}` : ''}</span>
        {row.error ? <span className="badge badge-red" title={row.error}>Retrying</span> : <Badge status={row.status} />}
      </button>
      {open && (
        <div className="ap-row-body">
          {row.nextAt && <small className="ap-muted">Goes out {formatAt(row.nextAt, row.timeZone)} {ZONE_LABEL[row.timeZone] || ''} time · {formatAt(row.nextAt, viewerZone)} your time</small>}
          {editing ? (
            <div className="ap-edit">
              <label><span>What you noticed (finishes the sentence “I noticed something: …”)</span><textarea value={draft.observation} onChange={(event) => setDraft({ ...draft, observation: event.target.value })} placeholder={row.preview?.text ? 'Leave blank to keep the automatic one' : ''} /></label>
              <label><span>Owner name</span><input value={draft.ownerName} onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })} placeholder="Leave blank to keep the automatic one" /></label>
              <div className="ap-row-actions"><button className="button button-quiet button-small" onClick={() => setEditing(false)}>Cancel</button><button className="button button-primary button-small" onClick={save} disabled={busy === `edit-${row.id}`}>Save</button></div>
            </div>
          ) : <EmailPreview preview={row.preview} />}
          {!editing && (
            <div className="ap-row-actions">
              <button className="button button-quiet button-small" onClick={() => onOpenLead?.(row.leadId)}>Open lead</button>
              {row.step === 0 && <button className="button button-secondary button-small" onClick={startEdit}>Edit details</button>}
              {row.status === 'queued' && row.step === 0
                ? <button className="button button-secondary button-small" onClick={() => act(`skip-${row.id}`, `/api/autopilot/emails/${row.id}/skip`)} disabled={busy === `skip-${row.id}`}><X size={13} />Skip</button>
                : <button className="button button-secondary button-small" onClick={() => act(`stop-${row.id}`, `/api/autopilot/emails/${row.id}/stop`)} disabled={busy === `stop-${row.id}`}><X size={13} />Stop follow-ups</button>}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function ActivityView({ data, onOpenLead }) {
  if (!data.recent.length) return <div className="today-empty"><strong>No activity yet</strong><span>Sent emails, replies and bounces show up here.</span></div>
  return (
    <section className="panel ap-section">
      <div className="ap-list">
        {data.recent.map((row) => {
          const last = row.history[row.history.length - 1]
          return (
            <article className="ap-row" key={row.id}>
              <button className="ap-row-main ap-row-compact" onClick={() => onOpenLead?.(row.leadId)}>
                <Badge status={row.status} />
                <span className="ap-row-who"><strong>{row.company}</strong><small>{row.email}</small></span>
                <span className="ap-row-subject">{row.reason || (last ? `${last.type === 'sent' ? `${stepLabel(last.step)} sent` : last.type.replace('-', ' ')}` : '')}</span>
                <span className="ap-muted num">{last ? new Date(last.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span>
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function TemplatesView({ data, api, busy, act, onToast }) {
  const saved = useMemo(() => ({ sequence: data.config.sequence, signature: data.config.signature }), [data.config.sequence, data.config.signature])
  const [draft, setDraft] = useState(saved)
  const [step, setStep] = useState(0)
  const [leadId, setLeadId] = useState('')
  const [preview, setPreview] = useState(null)
  const focused = useRef(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => { if (!dirty) setDraft(saved) }, [saved]) // eslint-disable-line react-hooks/exhaustive-deps

  const leads = useMemo(() => {
    const seen = new Map()
    for (const item of [...data.nextUp, ...data.upcoming]) if (!seen.has(item.leadId)) seen.set(item.leadId, item.company)
    return [...seen.entries()].slice(0, 30)
  }, [data.nextUp, data.upcoming])

  useEffect(() => {
    let stopped = false
    const timer = window.setTimeout(() => {
      api('/api/autopilot/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, step, leadId: leadId || null }) })
        .then((body) => { if (!stopped) setPreview(body) })
        .catch((caught) => { if (!stopped) setPreview({ error: caught.message, problems: [] }) })
    }, 300)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [api, draft, step, leadId])

  const setStepField = (index, key, value) => setDraft((current) => ({ ...current, sequence: current.sequence.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }))
  // Variable chips insert at the cursor of the last field you were in.
  const insert = (name) => {
    const target = focused.current
    const token = `{{${name}}}`
    if (!target) return
    const { index, key, el } = target
    const value = key === 'signature' ? draft.signature : draft.sequence[index][key]
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    if (key === 'signature') setDraft((current) => ({ ...current, signature: next }))
    else setStepField(index, key, next)
    window.requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }
  const track = (index, key) => (event) => { focused.current = { index, key, el: event.target } }
  const problems = (dirty ? preview?.problems : data.config.problems) || []

  return (
    <div className="ap-templates">
      <div className="ap-editor">
        {draft.sequence.map((item, index) => (
          <section className="panel ap-section ap-step" key={index}>
            <div className="section-heading">
              <div><h2>{stepLabel(index)}</h2><span>{index === 0 ? 'Sent on the lead’s scheduled morning' : `${item.delayDays} day${item.delayDays === 1 ? '' : 's'} after email 1, in the same thread, only if they haven’t replied`}</span></div>
              {index > 0 && <button className="button button-quiet button-small" onClick={() => setDraft((current) => ({ ...current, sequence: current.sequence.filter((_, i) => i !== index) }))} aria-label={`Remove ${stepLabel(index)}`}><X size={13} /></button>}
            </div>
            <div className="ap-fields">
              {index === 0
                ? <label><span>Subject</span><input value={item.subject} onChange={(event) => setStepField(index, 'subject', event.target.value)} onFocus={track(index, 'subject')} onSelect={track(index, 'subject')} /></label>
                : <label className="ap-delay"><span>Wait (days after email 1)</span><input type="number" min="1" max="30" value={item.delayDays} onChange={(event) => setStepField(index, 'delayDays', Number(event.target.value))} /></label>}
              <label><span>Message</span><textarea rows={index === 0 ? 12 : 6} value={item.body} onChange={(event) => setStepField(index, 'body', event.target.value)} onFocus={track(index, 'body')} onSelect={track(index, 'body')} onClick={() => setStep(index)} /></label>
            </div>
          </section>
        ))}
        {draft.sequence.length < 5 && <button className="button button-secondary button-small ap-add" onClick={() => setDraft((current) => ({ ...current, sequence: [...current.sequence, { delayDays: (current.sequence.at(-1)?.delayDays || 0) + 4, subject: '', body: 'Hi {{firstName}},\n\n\n\n{{signature}}' }] }))}><Plus size={13} />Add follow-up</button>}
        <section className="panel ap-section">
          <div className="section-heading"><div><h2>Signature</h2><span>Goes where {'{{signature}}'} is. US law (CAN-SPAM) needs a real postal address in it.</span></div></div>
          <textarea rows={4} value={draft.signature} onChange={(event) => setDraft({ ...draft, signature: event.target.value })} onFocus={track(0, 'signature')} onSelect={track(0, 'signature')} />
        </section>
      </div>

      <aside className="ap-side">
        <section className="panel ap-section">
          <div className="section-heading"><div><h2>Fill-ins</h2><span>Click to insert where your cursor is</span></div></div>
          <div className="ap-chips">{Object.entries(data.config.variables).map(([name, hint]) => <button key={name} className="ap-chip" onMouseDown={(event) => event.preventDefault()} onClick={() => insert(name)} title={hint}>{`{{${name}}}`}</button>)}</div>
        </section>
        <section className="panel ap-section">
          <div className="section-heading">
            <div><h2>Preview</h2><span>{preview?.lead ? `As ${preview.lead.company} would get it` : 'Real lead, real fill-ins'}</span></div>
          </div>
          <div className="ap-preview-controls">
            <div className="segmented">{draft.sequence.map((_, index) => <button key={index} className={step === index ? 'active' : ''} onClick={() => setStep(index)}>{index === 0 ? 'Email 1' : `F${index}`}</button>)}</div>
            {leads.length > 0 && <select value={leadId} onChange={(event) => setLeadId(event.target.value)} aria-label="Preview for lead"><option value="">Next lead in line</option>{leads.map(([id, company]) => <option key={id} value={id}>{company}</option>)}</select>}
          </div>
          {preview?.email ? <EmailPreview preview={preview.email} /> : preview?.error ? <p className="ap-preview-error">{preview.error}</p> : <div className="ap-loading"><LoaderCircle className="spin" size={14} /></div>}
        </section>
        <section className="panel ap-section ap-approve">
          {problems.length > 0 && <ul className="ap-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          {dirty ? (
            <div className="ap-row-actions">
              <button className="button button-quiet button-small" onClick={() => setDraft(saved)}>Undo changes</button>
              <button className="button button-primary" onClick={() => act('save', '/api/autopilot/templates', draft, 'PUT')} disabled={busy === 'save'}>{busy === 'save' ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}Save</button>
            </div>
          ) : data.config.approved ? (
            <p className="ap-approved"><Check size={14} />Approved {data.config.approvedAt ? new Date(data.config.approvedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}. Any edit pauses sending until you approve again.</p>
          ) : (
            <button className="button button-primary" onClick={() => act('approve', '/api/autopilot/approve', { hash: data.config.hash })} disabled={busy === 'approve' || problems.length > 0}><Check size={13} />Approve these templates</button>
          )}
          <button className="button button-secondary button-small" onClick={async () => { const result = await act('test', '/api/autopilot/test', { step, leadId: leadId || preview?.lead?.id || undefined }); if (result?.ok) onToast?.({ tone: 'success', message: `Test sent to ${result.to}` }) }} disabled={dirty || busy === 'test' || !data.mailbox.configured} title={dirty ? 'Save first' : !data.mailbox.configured ? 'Connect Gmail first' : ''}>
            {busy === 'test' ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}Send this as a test to me
          </button>
        </section>
      </aside>
    </div>
  )
}

function ScheduleView({ data, busy, act }) {
  const { config, timeZone } = data
  const [dailyNew, setDailyNew] = useState(config.dailyNew)
  const [start, setStart] = useState(minutesToTime(config.window.startMinute))
  const [end, setEnd] = useState(minutesToTime(config.window.endMinute))
  const [days, setDays] = useState(config.window.days)
  const startMinute = timeToMinutes(start)
  const endMinute = timeToMinutes(end)
  const valid = startMinute != null && endMinute != null && endMinute > startMinute && days.length > 0 && dailyNew >= 1 && dailyNew <= 30
  const save = () => act('schedule', '/api/autopilot/schedule', { dailyNew: Number(dailyNew), window: { startMinute, endMinute, days } }, 'PUT')
  return (
    <section className="panel ap-section ap-schedule">
      <div className="ap-fields">
        <label className="ap-delay"><span>New people per day</span><input type="number" min="1" max="30" value={dailyNew} onChange={(event) => setDailyNew(Number(event.target.value))} /></label>
        <div className="ap-time-pair">
          <label><span>Send from</span><input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label><span>until</span><input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        </div>
        <fieldset className="ap-days"><legend>Days</legend>{WEEKDAYS.map((label, day) => <label key={label}><input type="checkbox" checked={days.includes(day)} onChange={() => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()))} />{label}</label>)}</fieldset>
        <button className="button button-primary" onClick={save} disabled={!valid || busy === 'schedule'}>Save schedule</button>
      </div>
      <div className="ap-note">
        <Mail size={15} aria-hidden="true" />
        <p>Times are in each lead’s own time zone (Utah leads on Utah time, New York leads on New York time; the day is counted on {ZONE_LABEL[timeZone] || timeZone} time). Emails are spread across the window a few minutes apart, never in a burst. Follow-ups count toward a hard limit of 40 emails a day.</p>
        <p>Why early morning: trade owners usually check email before they head out to a job. That’s a best guess, not proven. Once replies come in, the Activity tab shows when people answer, so the window can be moved.</p>
      </div>
    </section>
  )
}
