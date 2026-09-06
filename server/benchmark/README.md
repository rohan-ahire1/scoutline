# Offline quality benchmark (ROH-26)

The offline half of ROH-26. Everything here runs without network access (loopback
only), credentials, or billing.

## Layout

- `fixtures.v1.json` — 22 versioned cases: static/JS/challenge/empty/multi-form
  captures, redirect/timeout/HTTP-500/DNS fetch paths, well-formed/malformed/
  duplicate/off-area/branch discovery records, grounded/uncited/stale/empty/
  filler Muse analyses, invented/grounded outreach copy.
- `fakes.js` — scripted `fetch` replacement with a call ledger, plus a loopback
  chat-completions server for the real model SDK (zero spend).
- `eval.js` — runs every fixture through the real service functions and writes
  `eval-report.json` (machine) + `eval-report.md` (human) with explicit
  denominators, the code commit, fixture version, and limitations.
- `gates.js` — four release gates with recorded evidence, never just an exit code.
- `run.js` — regenerates the committed reports: `node server/benchmark/run.js`
  (or `npm run eval`). Exits non-zero when a gate fails.
- `live-pilot-protocol.md` — the bounded live pilot. Draft only; executing it
  needs Rohan's credentials, spend cap, and labelled sample.

## Fixture versioning

Bump `version` and rename the file (`fixtures.v2.json`) for breaking schema
changes; the runner refuses mismatched versions. Additive cases keep the version.

## Production seam

`fetchPublicText`/`fetchPublicStatus` accept `options.dnsLookup` (default: real
DNS) so the redirect/timeout/HTTP-500 paths are testable offline. Default
behavior is unchanged — the seam follows the existing `checker` precedent.

## What this does NOT cover

Live providers, real browsers, and the full HTTP/worker loop are out of scope
for the offline suite — that is what the live pilot protocol is for.
