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
→ reviewed batch sending with automatic follow-ups, or manual send
→ Kanban follow-up
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
- Automated email outreach in dry run by default: approved batches, daily cap, day 3 and day 7 follow-ups, reply and bounce tracking, opt-out and suppression (see below)

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
- `TYPESAFE_API_KEY` enables Jev semantic triage for local scrapes. When configured, each successfully crawled site is classified with advisory routing metadata (archetype, primary opportunity, semantic scores, route). The deterministic opportunity/eligibility scores remain authoritative; Jev is advisory only and never stored as sales evidence.
- `JEV_MODEL` defaults to `jev-latest`.
- `JEV_API_URL` defaults to `https://api.typesafe.ai/v1/systemone`.

When a provider is not configured, the UI states the fallback explicitly: saved-client audits for discovery and evidence templates for outreach. Jev triage is omitted when unconfigured and does not block the crawl when the provider fails.

To try Jev, create an API key in the [TypeSafe console](https://console.typesafe.ai), put it in the local `.env` as `TYPESAFE_API_KEY=...`, restart `npm run dev`, and open **Crawl**. Paste a few public URLs and start a local scrape; each successful result shows Jev's advisory `deep-audit`, `review`, or `pass` route alongside Scoutline's deterministic scores.

Secrets, databases, and generated lead artifacts are excluded from Git.

## Automated email outreach

Scoutline can send approved first emails and two follow-ups on its own. It starts in dry run and stays there until you set `MAIL_LIVE=yes`.

How it works:

1. **Sending → Build batch** queues the top leads by qualification priority. A lead is skipped if it has no email, its MX check did not pass, it is marked do-not-contact, it is already in a conversation, it was contacted by hand, it is on the suppression list, someone else at the same company domain is already queued, or its draft makes a claim the evidence does not support.
2. You review each email (and can edit it), then approve or reject. With **Auto-approve** on, leads at or above the priority threshold skip review.
3. Approved emails go out on weekdays from 9:00 to 16:00 Denver time, spaced 4 to 11 minutes apart, up to the daily cap (20 by default).
4. Follow-up 1 goes out on day 3 and follow-up 2 on day 7, threaded on the first email. Both use only the evidence the first email used.
5. The inbox is checked over IMAP every 3 minutes. A reply stops the sequence and moves the lead to **Replied**. A hard bounce stops it and suppresses the address. An "unsubscribe" reply or a click on the opt-out link suppresses the address for good. Moving a lead to Replied, Meeting, Proposal, Won or Lost by hand also stops its sequence.
6. If more than 5% of 20 or more contacted leads bounce, sending pauses on its own.

Every email has your postal address, a reply-to-unsubscribe line, and `List-Unsubscribe` headers (mailto, plus one-click HTTPS when `SCOUTLINE_PUBLIC_URL` is set).

### Modes

- Dry run (default): emails are logged to the server console and the queue. Nothing leaves the machine. Dry-run sends do not mark leads as contacted. Use **Reset dry run** to put those sequences back in review before going live.
- Local catcher: point SMTP at Mailpit (`brew install mailpit && mailpit`, then `MAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025`). Emails show up at http://127.0.0.1:8025 and go nowhere else.
- Live: needs `MAIL_LIVE=yes` and every required variable below. Tests force dry run.

### Setup before going live

1. Use a separate sending domain or subdomain (for example `mail.goodshigoto.com`), so a bad week does not hurt your main domain.
2. Add DNS records for it: SPF (from your provider), DKIM (your provider gives you the key), and DMARC, starting with `v=DMARC1; p=none; rua=mailto:you@goodshigoto.com`.
3. Warm it up for 2 to 4 weeks: start at 5 to 10 emails a day and raise the cap slowly. Keep bounces under 2%.
4. Set the environment, through `.env` or `bws run`:

```bash
MAIL_TRANSPORT=smtp               # or resend
MAIL_FROM="Rohan <rohan@mail.goodshigoto.com>"
MAIL_REPLY_TO=rohan@goodshigoto.com
MAIL_PHYSICAL_ADDRESS="Street, City, State ZIP, Country"
SMTP_HOST=smtp.example.com        # SMTP transport
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
RESEND_API_KEY=...                # Resend transport instead of SMTP
IMAP_HOST=imap.example.com        # mailbox that receives replies and bounces
IMAP_USER=...
IMAP_PASS=...
SCOUTLINE_PUBLIC_URL=https://scoutline.example.com   # optional, for the one-click opt-out link
MAIL_LIVE=yes                     # last step
```

5. The opt-out page lives at `/u/<token>`, outside the login. The server listens on 127.0.0.1, so for the link to work, expose only `/u/` through a reverse proxy or a tunnel (for example Cloudflare Tunnel) and set `SCOUTLINE_PUBLIC_URL` to that address. Without it, people can still opt out by replying "unsubscribe".
6. Restart the server. The Sending page shows the mode it is in and lists any missing variables.

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
