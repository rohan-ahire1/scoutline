# Bounded live pilot protocol (ROH-26) — DRAFT, NOT EXECUTED

Creating this ticket is not approval to spend or contact leads. Do not run this
protocol until Rohan has supplied every item under "Required from Rohan" and
explicitly approved the run.

## Required from Rohan

1. Approved provider credentials via the environment (Bright Data, model API).
2. A maximum dollar spend for the pilot, in writing.
3. Target categories and geographies (proposal: two geographies × two
   categories, up to 20 unique businesses total).
4. A manually labelled sample: for at least 10 businesses, which report findings
   are factually correct and which outreach angle (if any) is commercially usable.

## Bounds (hard)

- At most 20 unique businesses, 2 geographies, 2 categories.
- Record every provider/model call with real versions; redact credentials from
  all stored output.
- Opt-in only: run from a local checkout with the pilot flag, never from a
  scheduled job or the shared workspace.
- Unknown dollar cost remains unknown — report metered usage only; never invent
  percentage results before running.

## Procedure

1. Confirm all four offline release gates pass on the exact commit under test.
2. Run collection for the approved scope; archive raw provider payloads.
3. Score the same reports against Rohan's labels: capture coverage, finding
   precision, unsupported-claim count, geography/category relevance, duplicate
   rate, latency, provider calls/cost.
4. Report commercial ranking agreement SEPARATELY from predicted conversion —
   a 20-business sample cannot prove buying intent.
5. Publish freshness and sampling limitations alongside the numbers.

## Abort conditions

Stop the pilot if spend approaches the cap, a provider returns unexpected PII,
or any finding cannot be traced to a stored observation.
