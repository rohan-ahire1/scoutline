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

To load the Google settings from Bitwarden Secrets Manager instead of the
local `.env`, set the `BWS_ACCESS_TOKEN` for the `scoutline-deploy` machine
account and use the wrapped commands:

```bash
export BWS_ACCESS_TOKEN='paste-the-machine-account-token-here'
npm run secrets:dev    # local UI + API
npm run secrets:start  # production server after npm run build
```

The token is never committed to the repository. The machine account is
read-only and scoped to the Bitwarden `Scoutline` project. That project
contains `GOOGLE_CLIENT_ID` and `SCOUTLINE_ALLOWED_EMAILS`, which `bws run`
injects into the server process.

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
- `TYPESAFE_API_KEY` enables Jev semantic triage for local scrapes. When configured, each successfully crawled site is classified with advisory routing metadata (archetype, primary opportunity, semantic scores, route). The deterministic opportunity/eligibility scores remain authoritative; Jev is advisory only and never stored as sales evidence.
- `JEV_MODEL` defaults to `jev-latest`.
- `JEV_API_URL` defaults to `https://api.typesafe.ai/v1/systemone`.

When a provider is not configured, the UI states the fallback explicitly: saved-client audits for discovery and evidence templates for outreach. Jev triage is omitted when unconfigured and does not block the crawl when the provider fails.

To try Jev, create an API key in the [TypeSafe console](https://console.typesafe.ai), put it in the local `.env` as `TYPESAFE_API_KEY=...`, restart `npm run dev`, and open **Crawl**. Paste a few public URLs and start a local scrape; each successful result shows Jev's advisory `deep-audit`, `review`, or `pass` route alongside Scoutline's deterministic scores.

Secrets, databases, and generated lead artifacts are excluded from Git.

## Google login and email allowlist

Scoutline requires a Google account whose verified email is listed by the server. To configure it:

1. In Google Cloud Console, configure the OAuth consent screen and create an OAuth 2.0 Client ID of type **Web application**.
2. Add `http://127.0.0.1:5174` as an authorized JavaScript origin for local development. Add the HTTPS origin of the deployed site for production.
3. Add the client ID and the exact email addresses that may sign in to `.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
SCOUTLINE_ALLOWED_EMAILS=you@example.com,teammate@example.com
```

4. Restart `npm run dev` after changing the allowlist.

The allowlist is read only by the Express server. Google ID tokens are verified on the server, API routes require an HTTP-only session cookie, and logout revokes the corresponding SQLite session. Removing an address from the allowlist and restarting the server invalidates that account's existing session on its next request.

## VPS crawler tab

The **Crawl** tab reviews snapshots from the always-on crawler in `crawler/`
(deployed on the VPS). Sync flow: on the VPS run
`npm run export -- --out crawl-export.json`, copy the file to this machine,
and import it from the Crawl tab. The tab shows today's totals, a 30-day
trend, website-type/qualification filters, per-site detail with scores and
contacts, and an **Add as lead** action that pushes a site into Research
(duplicate domains resolve to the existing lead). With no import yet, the tab
offers the bundled `crawler/crawl-export.sample.json` to explore.

The same tab also runs **local scrapes**: enter a location + category
(discovery via Bright Data — needs the API key and coordinates unless the
location matches your Settings geography) or paste URLs to skip discovery.
The crawler engine runs on this machine and each run is saved as a
committable JSON file under `data/crawl/local/`, with the same detail view
and add-as-lead action as snapshot sites.
The Local scrape panel also shows saved Jev usage totals: HTTP request attempts
(including retries), successful classifications, failures/rate limits, token
usage when the provider reports it, and `deep-audit`/`review`/`pass` routes.
