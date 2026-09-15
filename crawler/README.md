# Scoutline Crawler v0.3

Low-cost continuous website crawler for prospect qualification. Designed for ~1,000 domains/day without storing page assets.

## What it does

- PostgreSQL-backed target queue
- Up to 5 useful HTML pages/domain
- No image/video/font/CSS/JS asset storage
- Raw HTML discarded after analysis
- Capped text excerpts
- Shopify + likely-static detection
- lightweight technology detection
- contact/social/address extraction
- deterministic visual-risk + opportunity scoring
- robots.txt checks + per-host throttling
- crawl state persisted on every target
- stale worker recovery after restarts
- simple dashboard on `127.0.0.1:8791`

## States

Crawler state:

`pending -> queued -> crawling -> completed | failed | blocked`

Qualification is separate:

`not_evaluated | eligible | rejected`

A site is currently eligible when it is Shopify, likely static, or its deterministic visual-risk score is at/above the configured threshold.

## Dashboard

The dashboard shows:

- processed today / 1,000 daily limit
- active crawling and queued counts
- total eligible sites
- failed/blocked sites
- PostgreSQL database size
- every target with crawler state, qualification, website type, opportunity score, visual-risk score, HTTP status, pages inspected, contacts, duration and last result
- search/filter/sort
- auto refresh every 15 seconds

The HTTP server binds to localhost by default. Keep it that way and put Caddy/auth in front of it if exposing it publicly.

## Install

```bash
cd ~/projects
unzip scoutline-crawler-v3.zip -d scoutline-crawler
cd scoutline-crawler
npm install
cp .env.example .env
```

If using the included PostgreSQL container:

```bash
docker compose up -d postgres
```

Update `.env`, then:

```bash
npm run migrate
npm run seed -- urls.example.txt
npm start
```

Open from the VPS itself at:

```text
http://127.0.0.1:8791
```

For remote access, reverse-proxy this localhost port through your existing Caddy setup rather than binding the dashboard directly to the public internet.

## Key defaults

```env
CONCURRENCY=5
PER_HOST_DELAY_MS=3000
REQUEST_TIMEOUT_MS=15000
MAX_RESPONSE_BYTES=5000000
MAX_PAGES_PER_DOMAIN=5
MAX_TEXT_CHARS_PER_PAGE=8000
DAILY_SITE_LIMIT=1000
VISUAL_RISK_ELIGIBILITY_THRESHOLD=60
DEFAULT_INTERVAL_MINUTES=1440
STALE_JOB_MINUTES=30
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8791
```

## Local reuse

The scraping engine (`siteCrawler`, `fetchPage`, `analyze`, `robots`,
`throttle`) imports without a database — `DATABASE_URL` is only required by
the worker, dashboard, export, seed, and migrate entry points. Scoutline uses
this to scrape locally without Postgres.

## Scoutline export sync

The Scoutline app reads crawl data from a versioned JSON snapshot (no live
database connection needed):

```bash
# On the VPS, from the crawler directory:
set -a; source .env; set +a
npm run export -- --out crawl-export.json --days 30 --limit 5000
```

Then copy the file to your Mac (or fetch it over HTTP — the dashboard also
serves the same payload at `GET /api/export?days=30&limit=5000`) and import
it from the **Crawl** tab in Scoutline. The snapshot includes today's
summary, per-day history, and every site with its latest scores.

To automate the sync, add a cron job that regenerates the file (and optionally
`scp`s it to your Mac):

```cron
0 * * * * cd ~/projects/scoutline-crawler && set -a; source .env; set +a; npm run export -- --out /var/www/crawl-export.json >/dev/null 2>&1
```

## Upgrade from v0.2

Replace the application files and run:

```bash
npm run migrate
sudo systemctl restart scoutline-crawler
```

Migration `003_dashboard_state.sql` backfills existing targets from their latest jobs/snapshots, so previously crawled websites should not incorrectly appear as pending.
