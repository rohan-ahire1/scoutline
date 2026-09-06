# Scoutline offline quality benchmark

- Fixtures: v1 (22 cases, 29 checks)
- Commit: d1d90f9 · generated 2026-09-06T19:57:40.990Z · 91ms
- Passed: **29/29** · fake provider calls: 5

## By area (explicit denominators)

- classifyCapture: 6/6
- analyzeHtml: 6/6
- fetchBehavior: 4/4
- discoveryMapping: 3/3
- discoveryDedupe: 3/3
- museGrounding: 5/5
- outreachGrounding: 2/2

## Failing checks (none)

No failing checks.

## Limitations

- Offline fixtures only: no live provider, model, or browser involved. A green board does not prove production quality.
- Fixture authors choose the cases; coverage is bounded by the 22 cases in fixtures v1 (static/JS/challenge/empty/multi-form/redirect/timeout/HTTP-500/DNS/discovery/muse/outreach).
- Latency is harness-local (pure functions + fakes), not production latency.
- Provider-call counts come from the scripted fakes, not real billing.
