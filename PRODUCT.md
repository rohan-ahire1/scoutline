# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator: the owner of GoodShigoto, a small web studio, doing outbound sales for the studio. They sign in with Google (allowlist) and work mostly on a laptop; phone use is rare and only has to work. No teams or roles.

## Product Purpose

Scoutline is the GoodShigoto lead engine. It finds local trade businesses (Salt Lake City first; NYC outer boroughs configured but disabled), scans their websites, and sorts each lead into a **play**:

- **redesign**: no site, or a bad/static one. The studio builds a free concept by hand and emails it.
- **audit**: a decent site with specific, evidenced problems. The email carries concrete pointers.
- **skip**: everything else.

Success means a short list of pitchable leads, each with a reachable email address and evidence the operator trusts, rather than more data.

## Positioning

Evidence over black-box scores. Every judgement traces back to the crawl, scan, screenshot or metric that produced it, saved under `data/leads/{lead-id}/`. Scoring is deterministic from measured signals; model output (Meta Muse Spark vision review, then OpenAI as fallback) is advisory and decides only what markup can't, such as whether a modern-looking WordPress/Wix site is actually good.

## Operating Context

- Production runs on the operator's VPS (`scoutline.service`, auto-deployed from `main`). Crawling happens there; a local scrape is used only when running the app locally.
- Pipeline: discovery (crawl / Bright Data Google Maps / CSV / manual) → enrichment and contact finding → safe site scan and audit → qualify into a play → visual review where markup is ambiguous → human review → outreach drafts → manual send → follow-up pipeline → contract record.
- Sending is manual. Automated sending is not a priority. Redesign concepts are built by hand outside the app.

## Capabilities and Constraints

- React + Vite SPA (`src/`), Express + SQLite server (`server/`). Restart-safe job worker with queued / running / waiting / completed / failed / cancelled states.
- Safe fetching: SSRF-resistant, robots.txt respected, bounded crawls with delays and page limits.
- Real measurement only: Lighthouse and HTML audit. When something can't be measured, the UI shows a visible partial state; nothing is fabricated.
- Unknown company facts stay explicitly unknown.
- The app never sends email itself.

## Brand Commitments

Name: Scoutline, an internal tool for GoodShigoto. No other binding voice, asset or identity constraints.

## Evidence on Hand

- Working app and real production data (35 leads as of 2026-09-23), including site screenshots saved per lead.
- `Scoutline_Product_Requirements.md`.
- Absences future work must not fabricate: no testimonials, customers, case studies or benchmarks.

## Product Principles

1. Every claim shows its evidence or stays explicitly unknown.
2. Deterministic measurement first; model output is advisory and never overrides a score.
3. The human decides and sends; the software prepares and remembers.
4. Fewer, better leads: the play and the reason for it matter more than volume.
5. Partial honesty beats complete fiction: visible gaps over plausible filler.
