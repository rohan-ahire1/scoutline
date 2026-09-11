# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo operator: the developer himself, running manual outbound sales for his own client work. One user, one machine, one local database. No teams, roles, or multi-user workflows.

## Product Purpose

Scoutline is a local-first lead research and sales workspace. It takes the operator from raw business discovery through evidence-backed website analysis to prepared, manually-sent outreach and Kanban follow-up, ending in a contract record when a deal is won.

Success means the operator qualifies fewer, better leads with full knowledge of why each one is worth pursuing — and every outreach message is grounded in observed facts about the prospect's site, not guesses.

## Positioning

Evidence over black-box scores. Neighboring tools (Apollo, Clay, Hunter + a VA) rank leads with opaque scores or hand over contact lists. Scoutline saves the exact audit evidence under `data/leads/{lead-id}/`, computes a deterministic opportunity score from measured signals, and keeps LLM synthesis strictly advisory — it never changes the score. Any claim the product surfaces can be traced back to the crawl, check, or metric that produced it.

## Operating Context

Local machine workflow, started with `npm run dev` (UI on 127.0.0.1:5174, API on 8787, SQLite at `data/scoutline.db`). Leads enter via Bright Data Google Maps discovery or CSV import, then move through a fixed pipeline: enrichment → safe website audit → deterministic score + saved evidence → optional grounded AI synthesis → human qualification → three outreach drafts → manual send and Kanban follow-up → contract record. Model API keys are optional; deterministic fallbacks cover scoring and outreach when they are absent.

## Capabilities and Constraints

- SQLite persistence for leads, runs, jobs, settings, and audit events; restart-safe worker with queued/running/waiting/completed/failed/cancelled states.
- Safe fetching: SSRF-resistant, blocks local/private networks, re-checks redirects, caps response size, enforces timeouts, respects robots.txt, bounded same-site crawling with delays and per-run page limits.
- Real measurement only: mobile Lighthouse collection and HTML audit (hierarchy, contact paths, form friction, CTA visibility, alt coverage, structured data, trust language, tech signals). If Lighthouse cannot run, the client shows a visible partial state — performance data is never fabricated.
- Source-required company metrics (employees, revenue, profit, founding year, branches); unavailable values stay explicitly unknown.
- Manual outreach only. The app drafts three outreach versions per qualified client and never sends email automatically.
- Open decisions: none currently pending; per operator, nothing is sacred yet and constraints may evolve.

## Brand Commitments

Name: Scoutline. No confirmed voice, assets, or visual identity constraints beyond the name.

## Evidence on Hand

- Working app: `src/` (React + Vite SPA) and `server/` (Express + SQLite) in this repo.
- Requirements source: `Scoutline_Product_Requirements.md` (and `.docx`).
- UI captures: `screenshots/` directory.
- Absences future work must not fabricate: no testimonials, customers, case studies, press, or benchmarks exist.

## Product Principles

1. Every claim shows its evidence or stays explicitly unknown.
2. Deterministic measurement first; LLM output is advisory and never overrides a score.
3. The human decides and sends; the software prepares and remembers.
4. Local-first: the operator's data and pipeline stay on his machine under his control.
5. Partial honesty beats complete fiction — visible gaps over plausible filler.
