// Concept preview of the four CRM screens from the supplied mockups.
// Static data only (see mockData.js). Promote a screen to live data before
// treating it as product.
import { useState } from 'react'
import {
  ArrowRight, Bell, BookOpenCheck, Building2, Calendar, CalendarCheck, CalendarPlus,
  Check, CheckSquare, ChevronDown, ChevronLeft, FilePlus, FileText, List,
  Mail, MapPin, Link, Plus, Search, Sparkles, TrendingUp, Upload, UserPlus, Users,
  Eye, Zap, Leaf, CircleCheck,
} from 'lucide-react'
import './preview.css'
import {
  aiSuggestions, funnelShare, funnelStages, homeActivity, homeStats, leadDetail,
  outreachFilters, outreachGroups, pipelineColumns, previewScreens, previewUser,
  quickActions, revenueGoal,
} from './mockData.js'

const iconMap = {
  UserPlus, Mail, CheckSquare, CalendarPlus, Upload, Eye, CalendarCheck, FilePlus,
  FileText, MapPin, Link, Users, Calendar, Check, Building2,
}

function PreviewIcon({ name, size = 16 }) {
  const Icon = iconMap[name] || Sparkles
  return <Icon size={size} aria-hidden="true" />
}

function PersonDot({ initials, tint = 'lavender' }) {
  return <span className={`pv-person pv-tint-${tint}`} aria-hidden="true">{initials}</span>
}

function PriorityPill({ level }) {
  const tone = level === 'High' ? 'red' : level === 'Medium' ? 'amber' : 'green'
  return <span className={`pv-pill pv-pill-${tone}`}>{level}</span>
}

function OutreachScreen() {
  const [done, setDone] = useState({})
  const toggle = (key) => setDone((prev) => ({ ...prev, [key]: !prev[key] }))
  return (
    <div className="pv-screen">
      <div className="pv-topbar">
        <label className="pv-search"><Search size={15} aria-hidden="true" /><input placeholder="Search tasks, emails, or contacts..." aria-label="Search tasks, emails, or contacts" /></label>
        <div className="pv-top-actions">
          <button className="pv-icon-btn" aria-label="Notifications"><Bell size={17} aria-hidden="true" /><i className="pv-dot" /></button>
          <PersonDot initials={previewUser.initials} tint="peach" />
          <button className="pv-btn pv-btn-dark"><Plus size={15} aria-hidden="true" />New task</button>
        </div>
      </div>
      <h1 className="pv-page-title">Outreach</h1>
      <p className="pv-sub">Stay organized, follow up faster, and close more deals.</p>
      <div className="pv-tabs" role="tablist" aria-label="Outreach views">
        {['Tasks', 'Sequences', 'Templates', 'Analytics'].map((tab, i) => (
          <button key={tab} role="tab" aria-selected={i === 0} className={i === 0 ? 'is-active' : ''}>{tab}</button>
        ))}
      </div>
      <div className="pv-filter-row">
        <div className="pv-filters">
          {outreachFilters.map((filter) => (
            <button key={filter.label} className={filter.active ? 'pv-chip is-active' : 'pv-chip'}>
              {filter.label}{filter.badge && <em>{filter.badge}</em>}{filter.menu && <ChevronDown size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="pv-view-toggle" role="group" aria-label="Layout">
          <button className="is-active"><List size={14} aria-hidden="true" />List</button>
          <button><Calendar size={14} aria-hidden="true" />Calendar</button>
        </div>
      </div>
      <div className="pv-grid-outreach">
        <section className="pv-card" aria-label="Tasks">
          {outreachGroups.map((group) => (
            <div key={group.label}>
              <h3 className="pv-group-head">{group.label}<span>{group.count}</span></h3>
              <ul className="pv-tasks">
                {group.tasks.map((task) => {
                  const key = `${group.label}-${task.title}`
                  return (
                    <li key={key}>
                      <button className={done[key] ? 'pv-check is-done' : 'pv-check'} aria-pressed={Boolean(done[key])} aria-label={`Mark done: ${task.title}`} onClick={() => toggle(key)}><Check size={13} aria-hidden="true" /></button>
                      <div className={done[key] ? 'pv-task is-done' : 'pv-task'}><strong>{task.title}</strong><small>{task.company}</small></div>
                      <PriorityPill level={task.priority} />
                      <span className="pv-when">{task.when}</span>
                      <PersonDot initials={task.person} tint="lavender" />
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
        <div className="pv-side-stack">
          <section className="pv-card" aria-label="AI suggested next steps">
            <h2><Sparkles size={15} aria-hidden="true" />AI Suggested Next Steps</h2>
            <ul className="pv-suggest">
              {aiSuggestions.map((item) => (
                <li key={item.text}><p>{item.text}</p><button className="pv-btn-soft">Review</button></li>
              ))}
            </ul>
          </section>
          <section className="pv-card pv-promo" aria-label="Outreach tip">
            <h2>Consistent outreach wins.</h2>
            <p>Scoutline helps you stay on top of what matters, so you can build more meaningful conversations.</p>
            <button className="pv-btn-soft">Learn more<ArrowRight size={13} aria-hidden="true" /></button>
          </section>
        </div>
      </div>
    </div>
  )
}

function LeadScreen() {
  return (
    <div className="pv-screen">
      <div className="pv-topbar">
        <label className="pv-search"><Search size={15} aria-hidden="true" /><input placeholder="Search leads, companies, or notes..." aria-label="Search leads, companies, or notes" /></label>
        <div className="pv-top-actions">
          <button className="pv-icon-btn" aria-label="Notifications"><Bell size={17} aria-hidden="true" /><i className="pv-dot" /></button>
          <PersonDot initials={previewUser.initials} tint="peach" />
          <button className="pv-btn pv-btn-dark"><Plus size={15} aria-hidden="true" />New</button>
        </div>
      </div>
      <div className="pv-lead-top">
        <button className="pv-back"><ChevronLeft size={14} aria-hidden="true" />Back to leads</button>
        <div className="pv-lead-top-actions"><button className="pv-icon-btn" aria-label="More options">···</button><button className="pv-chip">Share</button></div>
      </div>
      <div className="pv-lead-head">
        <div className="pv-lead-id">
          <span className="pv-lead-mark"><Leaf size={30} aria-hidden="true" /></span>
          <div>
            <div className="pv-lead-title"><h1>{leadDetail.company}</h1><span className="pv-hot">{leadDetail.badge}</span></div>
            <p className="pv-sub">{leadDetail.tagline}</p>
            <div className="pv-tag-row">
              {leadDetail.tags.map((tag) => <span key={tag} className="pv-tag">{tag}</span>)}
              <span className="pv-tag pv-tag-loc"><MapPin size={12} aria-hidden="true" />{leadDetail.location}</span>
            </div>
          </div>
        </div>
        <div className="pv-lead-cta">
          <button className="pv-btn pv-btn-dark"><Mail size={15} aria-hidden="true" />Send email<ChevronDown size={14} aria-hidden="true" /></button>
          <button className="pv-btn pv-btn-line"><BookOpenCheck size={15} aria-hidden="true" />Add to pipeline<ChevronDown size={14} aria-hidden="true" /></button>
          <button className="pv-btn pv-btn-line"><CalendarPlus size={15} aria-hidden="true" />Create task<ChevronDown size={14} aria-hidden="true" /></button>
        </div>
      </div>
      <div className="pv-tabs" role="tablist" aria-label="Lead sections">
        {['Overview', 'Contacts (3)', 'Activity', 'Notes', 'Files'].map((tab, i) => (
          <button key={tab} role="tab" aria-selected={i === 0} className={i === 0 ? 'is-active' : ''}>{tab}</button>
        ))}
      </div>
      <div className="pv-grid-2">
        <div className="pv-side-stack">
          <section className="pv-card" aria-label="Website">
            <div className="pv-card-head"><h2>Website</h2><span className="pv-site-url">{leadDetail.website}</span></div>
            <div className="pv-site-slot" role="img" aria-label="Website preview placeholder">
              <Building2 size={22} aria-hidden="true" />
              <p>Live site preview loads here</p>
              <small>{leadDetail.website}</small>
            </div>
          </section>
          <section className="pv-card" aria-label="AI summary">
            <div className="pv-card-head"><h2><Sparkles size={15} aria-hidden="true" />AI Summary</h2><button className="pv-chip">Regenerate</button></div>
            <p className="pv-body">{leadDetail.summary}</p>
            <h3 className="pv-mini-head">Key takeaways:</h3>
            <ul className="pv-takeaways">
              {leadDetail.takeaways.map((item) => (
                <li key={item}><CircleCheck size={15} aria-hidden="true" />{item}</li>
              ))}
            </ul>
          </section>
        </div>
        <div className="pv-side-stack">
          <section className="pv-card" aria-label="Company info">
            <div className="pv-info-grid">
              <div>
                <h2>Company Info</h2>
                <ul className="pv-info-list">
                  {leadDetail.info.map((row) => (
                    <li key={row.label}><PreviewIcon name={row.icon} size={14} /><span className={row.link ? 'pv-link-text' : ''}>{row.label}</span></li>
                  ))}
                </ul>
              </div>
              <div className="pv-map-slot" role="img" aria-label="Map placeholder for San Francisco, CA">
                <MapPin size={20} aria-hidden="true" />
                <span>San Francisco, CA</span>
              </div>
            </div>
          </section>
          <section className="pv-card" aria-label="Key opportunities">
            <div className="pv-card-head"><h2><Sparkles size={15} aria-hidden="true" />Key Opportunities</h2><button className="pv-link">View all</button></div>
            <div className="pv-opp-row">
              {leadDetail.opportunities.map((opp) => <span key={opp} className="pv-opp">{opp}</span>)}
            </div>
          </section>
          <section className="pv-card" aria-label="Recent activity">
            <div className="pv-card-head"><h2><Zap size={15} aria-hidden="true" />Recent Activity</h2><button className="pv-link">View all</button></div>
            <ul className="pv-feed">
              {leadDetail.activity.map((item) => (
                <li key={item.text}>
                  <span className={`pv-action-ic pv-tint-${item.tint}`}><PreviewIcon name={item.icon} size={14} /></span>
                  <p>{item.text}</p><span className="pv-when">{item.time}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}

function PipelineScreen() {
  return (
    <div className="pv-screen">
      <div className="pv-topbar">
        <label className="pv-search"><Search size={15} aria-hidden="true" /><input placeholder="Search companies, contacts, or keywords..." aria-label="Search companies, contacts, or keywords" /></label>
        <div className="pv-top-actions">
          <button className="pv-icon-btn" aria-label="Notifications"><Bell size={17} aria-hidden="true" /><i className="pv-dot" /></button>
          <PersonDot initials={previewUser.initials} tint="peach" />
        </div>
      </div>
      <div className="pv-hero-row">
        <div>
          <h1 className="pv-page-title">Pipeline</h1>
          <p className="pv-sub">Turn conversations into customers.</p>
        </div>
        <div className="pv-top-actions">
          <button className="pv-select">All owners<ChevronDown size={14} aria-hidden="true" /></button>
          <button className="pv-select"><Calendar size={15} aria-hidden="true" />This quarter<ChevronDown size={14} aria-hidden="true" /></button>
          <button className="pv-btn pv-btn-dark"><Plus size={15} aria-hidden="true" />Add deal</button>
        </div>
      </div>
      <div className="pv-board" role="list" aria-label="Pipeline by stage">
        {pipelineColumns.map((column) => (
          <div key={column.stage} className={`pv-col pv-col-${column.tone}`} role="listitem">
            <div className="pv-col-sum"><strong>{column.stage}</strong><span>{column.count}</span><em>{column.value}</em></div>
            <div className={`pv-col-head pv-tone-text-${column.tone}`}><strong>{column.stage}</strong><span>{column.count}</span><button className="pv-icon-btn pv-add" aria-label={`Add deal to ${column.stage}`}><Plus size={14} aria-hidden="true" /></button></div>
            {column.deals.map((deal) => (
              <article key={deal.company} className="pv-deal">
                <span className={`pv-mono pv-tint-${column.tone === 'violet' ? 'lavender' : column.tone === 'red' ? 'peach' : column.tone}`} aria-hidden="true">{deal.monogram}</span>
                <div><strong>{deal.company}</strong><div className="pv-tag-row">{deal.tags.map((tag) => <span key={tag} className="pv-tag">{tag}</span>)}</div>
                <div className="pv-deal-meta"><strong>{deal.value}</strong>{deal.meta && <span>{deal.meta}</span>}</div></div>
              </article>
            ))}
          </div>
        ))}
        <aside className="pv-card pv-board-promo" aria-label="Pipeline tip">
          <h2>A healthier pipeline today. A bigger tomorrow.</h2>
          <p>Keep the momentum going.</p>
        </aside>
      </div>
    </div>
  )
}

const screens = { home: <HomeScreen />, outreach: <OutreachScreen />, lead: <LeadScreen />, pipeline: <PipelineScreen /> }

export default function PreviewPage({ initialScreen = 'home' }) {
  const valid = previewScreens.some((screen) => screen.id === initialScreen) ? initialScreen : 'home'
  const [active, setActive] = useState(valid)
  return (
    <div className="pv-wrap">
      <div className="pv-switch" role="tablist" aria-label="Concept screens">
        {previewScreens.map((screen) => (
          <button key={screen.id} role="tab" aria-selected={active === screen.id} className={active === screen.id ? 'is-active' : ''} onClick={() => setActive(screen.id)}>{screen.label}</button>
        ))}
        <span className="pv-concept">Concept · static data</span>
      </div>
      <div role="tabpanel">{screens[active]}</div>
    </div>
  )
}

function HomeScreen() {
  return (
    <div className="pv-screen">
      <div className="pv-topbar">
        <label className="pv-search"><Search size={15} aria-hidden="true" /><input placeholder="Search leads, companies, or notes..." aria-label="Search leads, companies, or notes" /></label>
        <div className="pv-top-actions">
          <button className="pv-icon-btn" aria-label="Notifications"><Bell size={17} aria-hidden="true" /><i className="pv-dot" /></button>
          <PersonDot initials={previewUser.initials} tint="peach" />
          <button className="pv-btn pv-btn-dark"><Plus size={15} aria-hidden="true" />New</button>
        </div>
      </div>
      <div className="pv-hero-row">
        <div>
          <h1 className="pv-greet">Good morning, {previewUser.firstName}</h1>
          <p className="pv-sub">You are on track to hit your Q3 goals! Here is what is happening today.</p>
        </div>
        <button className="pv-select"><Calendar size={15} aria-hidden="true" />This quarter<ChevronDown size={14} aria-hidden="true" /></button>
      </div>
      <div className="pv-stats">
        {homeStats.map((stat) => (
          <div key={stat.label} className={`pv-stat pv-tint-${stat.tint}`}>
            <strong>{stat.value}</strong>
            <div><span>{stat.label}</span><em><TrendingUp size={12} aria-hidden="true" />{stat.delta}</em></div>
          </div>
        ))}
      </div>
      <div className="pv-grid-2">
        <section className="pv-card" aria-label="Sales funnel">
          <div className="pv-card-head"><h2>Sales Funnel</h2><button className="pv-select pv-select-sm">This quarter<ChevronDown size={14} aria-hidden="true" /></button></div>
          <ul className="pv-funnel">
            {funnelStages.map((stage) => (
              <li key={stage.label}>
                <span className={`pv-funnel-bar pv-tone-${stage.tone}`} style={{ width: `${Math.max(funnelShare(stage.count), 22)}%` }}>{stage.label}</span>
                <strong>{stage.count}</strong>
                <span className="pv-funnel-share">{funnelShare(stage.count)}%</span>
              </li>
            ))}
          </ul>
        </section>
        <div className="pv-side-stack">
          <section className="pv-card" aria-label="Quick actions">
            <h2>Quick Actions</h2>
            <ul className="pv-actions">
              {quickActions.map((action) => (
                <li key={action.label}><button><span className={`pv-action-ic pv-tint-${action.tint}`}><PreviewIcon name={action.icon} size={15} /></span>{action.label}</button></li>
              ))}
            </ul>
          </section>
          <section className="pv-card pv-ai-card" aria-label="AI enrichment">
            <Sparkles size={20} aria-hidden="true" />
            <h2>Let AI do the research</h2>
            <p>Turn any website into a complete lead profile in seconds. Find key contacts, insights, and outreach ideas.</p>
            <button className="pv-btn pv-btn-dark">Try AI Enrichment<ArrowRight size={14} aria-hidden="true" /></button>
          </section>
          <section className="pv-card pv-goal-card" aria-label="Revenue goal">
            <h2>You are {revenueGoal.dealsAway} deals away from your goal!</h2>
            <div className="pv-goal-bar" role="progressbar" aria-valuenow={revenueGoal.percent} aria-valuemin="0" aria-valuemax="100" aria-label="Revenue goal progress"><i style={{ width: `${revenueGoal.percent}%` }} /></div>
            <div className="pv-goal-meta"><span>{revenueGoal.current} / {revenueGoal.target}</span><strong>{revenueGoal.percent}%</strong></div>
          </section>
        </div>
      </div>
      <section className="pv-card" aria-label="Recent activity">
        <div className="pv-card-head"><h2><Zap size={16} aria-hidden="true" />Recent Activity</h2><button className="pv-link">View all</button></div>
        <ul className="pv-activity-grid">
          {homeActivity.map((item) => (
            <li key={item.title}>
              {item.person ? <PersonDot initials={item.person} tint={item.tint} /> : <span className={`pv-action-ic pv-tint-${item.tint}`}><PreviewIcon name={item.icon} size={15} /></span>}
              <div><strong>{item.title}</strong><small>{item.time} · {item.meta}</small></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
