# Scoutline

A local-first lead research and sales workspace. It collects or imports businesses, analyzes their websites, prepares evidence-backed outreach, and tracks qualified clients through a manual sales pipeline.

## Workflow

```text
Bright Data discovery or CSV import
→ source-backed business enrichment
→ safe website audit
→ deterministic opportunity score + saved evidence
→ optional AI evidence synthesis inside Analyzed
→ human qualification
→ three outreach versions
→ manual send and Kanban follow-up
→ contract record when won
```

“Analyzed” remains one complete website-analysis stage. There is no separate LLM-insights checkpoint or ranking checkpoint: the audit evidence and deterministic opportunity score are produced together. When AI is configured, it adds a grounded advisory synthesis inside that stage—priorities, recommendations, strengths, unknowns, qualification guidance, and outreach angles—without changing the score.

## Backend now included

- SQLite persistence for leads, runs, jobs, settings, and audit events
- API-owned job progress; the browser no longer simulates run completion
- Restart-safe in-process worker with queued, running, waiting, completed, failed, and cancelled states
- Retryable per-client website analysis
- SSRF-resistant fetches that block local/private networks, re-check redirects, cap response size, enforce timeouts, and respect a site-wide robots.txt disallow
- Bounded same-site crawling with robots enforcement, redirect revalidation, request delays, and per-run page limits
- Internal-link verification with saved status/error evidence and a 50-link safety cap per client
- Real mobile Lighthouse collection for performance, accessibility, SEO, best practices, and core timing metrics
- HTML audit for content hierarchy, mobile setup, contact paths, form friction, CTA visibility, image alt coverage, structured data, trust language, and technology signals
- Deterministic opportunity score and confidence with the exact evidence saved under `data/leads/{lead-id}/`
- Retryable AI synthesis jobs grounded in the saved crawl, broken-link checks, Lighthouse metrics, and selected Lighthouse failures
- Structured AI recommendations remain advisory and are persisted separately in `muse-analysis.json`
- Bright Data Google Maps discovery adapter using its async snapshot workflow
- Google business enrichment for claimed status, hours, services, booking/estimate links, review distribution and recency, photos, categories, and observed locations
- Transparent digital-maturity scoring from measured website, technology, profile, booking, and maintenance signals
- Source-required company metrics for employees, revenue, profit, founding year, and total branches; unavailable values remain explicitly unknown
- Meta Model API and OpenAI Responses API integrations with strict structured output for concise, balanced, and detailed outreach drafts
- Deterministic outreach fallback when no model API key is configured
- Manual outreach only; the app does not send email automatically

Deep audits retain a lightweight HTML fallback. If Lighthouse cannot launch or load a page, the client remains analyzed with a visible partial component state rather than fabricated performance data.

## Run locally

```bash
npm install
npm run dev
```

This starts:

- UI: `http://127.0.0.1:5174`
- API: `http://127.0.0.1:8787`
- database: `data/scoutline.db`

Production build:

```bash
npm test
npm run build
npm start
```

## Optional integrations

Copy `.env.example` to `.env` and add only the providers you want:

```bash
cp .env.example .env
```

- `BRIGHT_DATA_API_KEY` enables live Google Maps discovery. The map center is editable in Settings.
- `BRIGHT_DATA_DATASET_ID` is optional; the official Google Maps full-info dataset is the default.
- `MODEL_API_KEY` enables Meta Model API website synthesis and outreach generation.
- `META_MODEL` defaults to `muse-spark-1.2-contributor`.
- `META_REASONING_EFFORT` defaults to `minimal` for synthesis and outreach generation.
- `META_MODEL_API_BASE_URL` optionally overrides Meta's `https://api.meta.ai/v1` endpoint.
- `OPENAI_API_KEY` enables the optional OpenAI fallback when no Meta key is present.
- `OPENAI_MODEL` overrides the default OpenAI model.

When a provider is not configured, the UI states the fallback explicitly: saved-client audits for discovery and evidence templates for outreach.

Secrets, databases, and generated lead artifacts are excluded from Git.
