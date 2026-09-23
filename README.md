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

## Lead quality: who to pitch, and how

Scoutline qualifies every discovered business for GoodShigoto outreach and
sorts it into one **play**:

- **redesign**: a business worth pitching (reviews, rating, ticket size) whose web presence is missing or weak: no website, a Facebook/Yelp link, a free builder subdomain, a dead domain, a parked page, broken HTTPS, or a clearly dated site. Build a concept and send it.
- **audit**: a decent business with a fixable site. Send 2–3 specific pointers.
- **skip**: franchises and national brands, utilities and suppliers, chain location pages, very large operations (1,500+ reviews), weak reputations (<4.0★), closed businesses, thin businesses, and sites that already look good.

Pipeline (runs on the VPS inside `scoutline.service`, or locally with `npm run dev`):

```text
Market discovery (Bright Data, one run per area)
→ qualify job per business: crawl up to 5 pages (crawler engine) → emails
  (mailto, Cloudflare-protected, obfuscated, JSON-LD) ranked + MX-checked
  → owner names → dated-site signals → business worth + site weakness → play
→ visual job (own sites that are not skipped): desktop + mobile screenshots,
  popups removed; with OPENAI_API_KEY a vision model rates them on a fixed
  rubric and the play is re-scored (with MODEL_API_KEY or OPENAI_API_KEY)
→ GET /api/prospects: the ranked shortlist
```

Markup alone cannot tell a tidy modern template from a tired one, so an
own-site lead without a visual review stays an `audit` with `confidence: low`.

Endpoints:

- `GET /api/prospects?play=redesign|audit|skip|active|all&market=slc&contact=email`
- `POST /api/leads/:id/qualify`, `POST /api/leads/:id/visual-review`
- `POST /api/qualify/backfill` with `{"rescan": false}` re-scores saved scans offline (after tuning rules); `{"rescan": true}` crawls again
- `GET /api/markets`, `POST /api/markets/:id/discover` with `{"areas": ["Murray, UT"], "categories": ["HVAC contractor"], "limit": 25}`. Bright Data bills per record, so choose areas and limits deliberately.
- `GET /api/leads/:id/screens/{desktop|mobile}-{fold|full}.jpg`

Markets live in `server/services/markets.js`: Salt Lake City is on, and New York
City (outer boroughs plus Hempstead) is present but off. Rules live in
`server/services/qualify.js`, dated-site signals in `crawler/src/dated.js`,
contact extraction in `crawler/src/contacts.js`.

Discovery runs no longer queue Lighthouse audits automatically. Run the deep
audit on shortlisted leads, or pass `options: { deepAudit: true }` to a run.

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
- Screenshot reviews use the same provider order: Meta (`MODEL_API_KEY`, model `META_VISION_MODEL` or `META_MODEL`) first, then OpenAI (`OPENAI_VISION_MODEL` or `OPENAI_MODEL`). With no key, screenshots are still captured for manual review. Try it on one site: `node scripts/visual-probe.mjs https://example.com`.

When a provider is not configured, the UI states the fallback explicitly: saved-client audits for discovery and evidence templates for outreach.

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
