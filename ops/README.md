# Scoutline operations (VPS)

## Processes

| Unit | Role | What it does |
|---|---|---|
| `scoutline.service` | `SCOUTLINE_ROLE=web` | UI + API on 127.0.0.1:8787. Only enqueues work. |
| `scoutline-worker.service` | `SCOUTLINE_ROLE=worker` | Runs the job queue one job at a time: Bright Data discovery, site scans (`server/crawler/`), screenshots + visual review, Crawl-tab scrapes. MemoryMax 1.5G. |
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
- `SCOUTLINE_SERVICE_TOKEN`: used as `Authorization: Bearer` by the CLI.
- Alerts: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Without them alerts are
  only logged. Alerts: nightly failed,
  nightly found 0 new leads, a job that ran out of attempts (max one per 10
  minutes; the rest are folded into the next alert).

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
