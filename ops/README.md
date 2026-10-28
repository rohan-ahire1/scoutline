# Scoutline operations (VPS)

## Processes

| Unit | Role | What it does |
|---|---|---|
| `scoutline.service` | `SCOUTLINE_ROLE=web` | UI + API on 127.0.0.1:8787. Only enqueues work. |
| `scoutline-worker.service` | `SCOUTLINE_ROLE=worker` | Runs the job queue one job at a time: Bright Data discovery, site scans (`server/crawler/`), screenshots + visual review, Crawl-tab scrapes. MemoryMax 1.5G. Also runs the email autopilot every minute. |
| `scoutline-nightly.timer` → `.service` | CLI | 02:00 America/Denver: `server/cli.js nightly` queues tonight's market slice and waits for it. |

Both long-running units share `data/scoutline.db` (SQLite WAL, `busy_timeout`).
Locally, `npm run dev` runs one process with `SCOUTLINE_ROLE=all`.

### Why it is reliable
- Deploys restart only the web process. The worker notices the `current`
  symlink moved and restarts itself between jobs.
- A stopped or crashed worker's Running job goes back to the queue on start.
- Retries back off 30s → 2m → 8m → 30m. Paid provider triggers are never
  auto-replayed; a snapshot id is resumed instead.
- Per-type time budgets (qualify 5m, visual 6m, local scrape 45m…). A job
  that hangs past its budget is abandoned; if its code still has not returned
  90s later, the worker exits and systemd starts a clean one.
- Idempotency: one active job per `qualify:<lead>` / `visual:<lead>` /
  `discover:<run>`, and the nightly sends `nightly:<market>:<date>` so a rerun
  the same night reuses its runs instead of paying Bright Data twice.

## CLI (standalone use)

```bash
export SCOUTLINE_API=http://127.0.0.1:8787            # or any Scoutline instance
export SCOUTLINE_SERVICE_TOKEN=...                    # same value as the server
npm run scout -- health
npm run scout -- markets
npm run scout -- discover --market slc --areas "Murray, UT" --categories "HVAC contractor" --limit 10 --wait
npm run scout -- run <runId>
npm run scout -- backfill            # re-score saved scans offline
npm run scout -- nightly --dry-run   # show tonight's slice
```

On the VPS:

```bash
cd ~/projects/scoutline/current
set -a; . ~/.hermes/scoutline.env; set +a   # read-only bws token
export PATH=$HOME/.hermes/node/bin:$HOME/.hermes/bin:$PATH
bws run --project-id f132f7b5-b6cd-49ab-979a-b4c6007f22a6 -- node server/cli.js health
```

`health` exits 3 when jobs are waiting and no worker heartbeat is fresh.

## Secrets
All secrets live in Bitwarden project `f132f7b5-b6cd-49ab-979a-b4c6007f22a6`
and are injected by `bws run`; no plaintext env file holds them.
- `BRIGHT_DATA_API_KEY`, `MODEL_API_KEY`, Google login.
- `TYPESAFE_API_KEY`: Jev pre-screen before AI synthesis (worker). Optional;
  without it every lead gets the full analysis. `JEV_PASS_THRESHOLD` (default
  0.8) sets how sure Jev must be before a Pass skips the write-up.
- `SCOUTLINE_SERVICE_TOKEN`: used as `Authorization: Bearer` by the CLI.
- Alerts: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Without them alerts are
  only logged. Alerts: nightly failed,
  nightly found 0 new leads, a job that ran out of attempts (max one per 10
  minutes; the rest are folded into the next alert).
- Email autopilot: `GMAIL_USER` + `GMAIL_APP_PASSWORD` (a Google app
  password; the account needs 2-Step Verification). Optional
  `GMAIL_FROM_NAME`. Both units need them: the web unit for test sends and
  "Check replies now", the worker for the real sends.

## Email autopilot
Outreach → Autopilot sends a short sequence (email 1, then follow-ups in the
same thread) from the Gmail account above. Code: `server/services/sender.js`
(pure rules), `mailbox.js` (SMTP 587 + IMAP), `autopilot.js` (the loop).
- Sends nothing until the templates are approved and it is turned on. Any
  template edit clears the approval and turns it off.
- Each sending day it queues `dailyNew` leads (best priority first, one per
  business, MX checked) and spreads them across the window (default 7:00–9:30,
  Mon–Fri, in the lead's own time zone, at least ~6 minutes apart). Hard cap:
  40 sends a day including follow-ups.
- Every 10 minutes it reads All Mail over IMAP. A reply stops the sequence and
  moves the lead to Replied (Telegram alert). "No" / "unsubscribe" marks it
  opted out. Out-of-office replies are ignored. Bounces stop that lead.
- Pauses itself (Telegram alert) if Gmail rejects the login or more than 8%
  of the last 50 emails bounced.
- A send cut off by a restart is marked failed, never resent: check Gmail
  Sent before retrying by hand.
- State lives in the `autopilot_emails` table. It is in the nightly database
  snapshot but not in the JSON export, so restoring an export never forgets
  who was already emailed.

## Install / update units

```bash
sudo install -m 644 ops/systemd/scoutline*.service ops/systemd/scoutline-nightly.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scoutline-worker.service scoutline-nightly.timer
sudo systemctl restart scoutline.service
```

Logs: `journalctl -u scoutline-worker -u scoutline-nightly -u scoutline`.
Rollback: point `~/projects/scoutline/current` at the previous
`releases/<sha>`, then restart `scoutline.service` (the worker follows).
