# Scoutline

**A lead research workspace that finds local businesses, audits their websites, and shows the evidence behind every pitch.**

I built Scoutline to run outbound sales for a small web studio. It is a single-operator app behind Google sign-in, so you run it locally with the steps below.

## What it does

Scoutline finds local trade businesses (plumbers, roofers, HVAC and so on), scans their websites, and sorts each one into a **play**:

- **redesign**: a business worth pitching whose web presence is missing or weak (no site, only a Facebook or Yelp page, a free builder subdomain, a dead or parked domain, broken HTTPS, or a clearly dated site).
- **audit**: a solid business with a site that has specific, fixable problems.
- **skip**: franchises and national brands, chain location pages, very large operations, weak reputations, closed businesses, and sites that already look good.

Every judgement links back to the crawl, screenshot or metric that produced it. Scores are computed from measured signals; AI output is advisory and never changes a score.

```
discovery (Google Maps via Bright Data, CSV import, or pasted URLs)
  -> business enrichment (hours, services, reviews, booking links)
  -> safe website crawl (up to 5 pages) and audit
  -> contacts: emails ranked and MX-checked, owner names
  -> dated-site signals + business worth + site weakness -> play
  -> desktop and mobile screenshots, optional vision-model review
  -> human review -> outreach drafts -> manual send or approved autopilot
  -> follow-up pipeline -> contract record
```

## Key features

- **Market discovery** through Bright Data's Google Maps dataset, run per area and category, with a nightly timer that works through a market a slice at a time.
- **Safe crawling.** SSRF-resistant fetches that block private networks, re-check every redirect, cap response size and enforce timeouts. Crawls respect robots.txt, add delays between requests and stay within page limits.
- **Website audit.** Mobile Lighthouse (performance, accessibility, SEO, best practices, core timings) plus an HTML audit of content hierarchy, mobile setup, contact paths, form friction, calls to action, image alt text, structured data and technology signals. If Lighthouse can't run, the lead shows a visible partial state instead of made-up numbers.
- **Contact finding.** Emails from mailto links, Cloudflare-protected and obfuscated addresses, and JSON-LD, ranked and checked against the domain's MX records.
- **Visual review.** Headless Chrome captures desktop and mobile screenshots with popups removed. With a model key, a vision model rates them on a fixed rubric, because markup alone can't tell a tidy modern template from a tired one.
- **Outreach drafts** in three lengths from the Meta Model API or OpenAI with structured output, grounded in the saved evidence. Without a key, it falls back to evidence-based templates.
- **Email autopilot (optional).** Sends an approved sequence through a Gmail mailbox, at most 40 emails a day inside a sending window, and stops a sequence when the lead replies, opts out or bounces (replies are checked over IMAP). Any edit to the sequence stops sending until it is approved again.
- **Google sign-in with an email allowlist.** ID tokens are verified on the server, sessions are HTTP-only cookies stored in SQLite, and removing an address invalidates its session.
- **Backups and restore** of the database from the UI and API.

## Tech stack

- React and Vite single-page app (`src/`)
- Node.js and Express 5 API (`server/`)
- SQLite via better-sqlite3 (WAL mode), shared by the web and worker processes
- Cheerio and robots-parser for crawling; Lighthouse and chrome-launcher for audits and screenshots
- OpenAI SDK (also used for the Meta Model API), google-auth-library, nodemailer and ImapFlow
- Node's built-in test runner
- Deployed on a VPS with systemd units, a GitHub Actions deploy workflow and Bitwarden Secrets Manager for credentials

## Architecture notes

- **One job queue for every scrape.** The UI, the CLI and the nightly timer all enqueue work into a SQLite-backed queue; a separate worker process runs it. Jobs are idempotent (one active qualify or visual job per lead, one discovery per run), retry with backoff (30s, 2m, 8m, 30m), have per-type time budgets, and survive restarts and deploys. Paid Bright Data requests are never replayed automatically; the worker resumes the existing snapshot instead.
- **Self-healing worker.** A job that runs past its budget is abandoned, and if its code still hasn't returned 90 seconds later the worker exits so systemd starts a clean one. After a deploy the worker notices the new release and restarts between jobs.
- **Deterministic scoring.** Qualification rules live in `server/services/qualify.js`, dated-site signals in `server/crawler/dated.js` and contact extraction in `server/crawler/contacts.js`. Saved scans can be re-scored offline after the rules change.
- **Offline benchmark.** `server/benchmark/` runs 22 versioned fixtures (fetch failures, malformed discovery records, grounded and ungrounded AI output) through the real services with a fake network and a local model server, then checks four release gates. Run it with `npm run eval`.

## Run it locally

```bash
npm install
cp .env.example .env   # set GOOGLE_CLIENT_ID and SCOUTLINE_ALLOWED_EMAILS at minimum
npm run dev
```

This starts the UI at `http://127.0.0.1:5174`, the API at `http://127.0.0.1:8787`, and a SQLite database at `data/scoutline.db`.

```bash
npm test              # node --test
npm run eval          # offline benchmark and release gates
npm run build && npm start
npm run worker        # run the job worker as its own process
npm run scout -- health   # CLI; see ops/README.md
```

### Google sign-in

1. In Google Cloud Console, create an OAuth 2.0 Client ID of type **Web application**.
2. Add `http://127.0.0.1:5174` as an authorized JavaScript origin (and the HTTPS origin of any deployment).
3. Put the client ID and the allowed addresses in `.env`, then restart:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
SCOUTLINE_ALLOWED_EMAILS=you@example.com,teammate@example.com
```

### Optional integrations

| Variable | Enables |
| --- | --- |
| `BRIGHT_DATA_API_KEY` (`BRIGHT_DATA_DATASET_ID`, `BRIGHT_DATA_MAX_RECORDS`) | Live Google Maps discovery (billed per record) |
| `MODEL_API_KEY`, `META_MODEL`, `META_REASONING_EFFORT`, `META_MODEL_API_BASE_URL` | Meta Model API for analysis, outreach and visual review |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI fallback when no Meta key is set |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_FROM_NAME` | Email autopilot |
| `SCOUTLINE_PORT`, `SCOUTLINE_DATA_DIR`, `CHROME_PATH` | Local overrides |

When a provider isn't configured, the UI says which fallback it is using.

## Project layout

```
src/               React UI: Today, leads, Crawl, Outreach/autopilot
server/index.js    Express API and worker entry point
server/crawler/    Page fetching, robots, same-site crawl, contacts, dated-site signals
server/services/   Discovery, enrichment, audit, qualify, visual review, outreach, jobs, autopilot, backups
server/benchmark/  Offline fixtures, evaluation and release gates
server/cli.js      Command-line client for the API
ops/               systemd units, deploy scripts and the operations guide
```

See [ops/README.md](ops/README.md) for how the web, worker and nightly processes run in production.
