# Rocky Mountain Power

## Audit version

- Audit ID: legacy (unversioned)
- Status: Analyzed
- Audited: 2026-08-23T10:10:18.418Z
- Provenance: legacy-unversioned

## Opportunity assessment

- Opportunity score: 62
- Confidence: 88
- Source: Multi-page website audit + Lighthouse
- Research status: Analyzed

## Website audit

- Lighthouse mobile performance: Not measured
- Lighthouse accessibility: 73
- Lighthouse SEO: 62
- Same-site pages crawled: 10
- Internal links checked: 50
- Broken internal links: 0
- Mobile quality: Fair
- HTTPS: Yes
- Detected stack: GA4

## Main observed issue

**Content hierarchy:** The homepage does not use one clear primary heading.

## Findings

- The homepage does not use one clear primary heading.
- Many homepage images do not have useful alternative text.
- The homepage description is missing or too brief to explain the offer clearly.
- No structured data was detected on the homepage.

## Evidence

- Homepage returned HTTP 200 at https://www.rockymountainpower.net/
- Page title: Rocky Mountain Power
- Internal links observed on homepage: 87
- Canonical URL: not found
- Homepage CTA phrases detected: 4
- Image alt-text coverage: 46%
- Structured data: not found
- Homepage H1 count: 13
- Meta description length: 0 characters
- JSON-LD structured data blocks: 0
- Crawled 10 same-site pages and checked 50 internal links

## Muse synthesis (advisory)

- Recommendation: Review
- Rationale: Opportunity Score 62 indicates moderate website opportunity (deterministic assessment, confidence 88). SAAS not flagged as tech-heavy. Evidence shows clear, addressable content/SEO issues (13 H1s, 0-char meta description, 0 schema blocks, 46% alt coverage) with low-risk implementation. Review - not Pass - because issues are measurable but site is functional (HTTP 200, 0 broken of 50 checked, claimed profile, GA4 present).
- Model: muse-spark-1.2-contributor
- Generated: 2026-08-23T10:13:37.435Z

Rocky Mountain Power (www.rockymountainpower.net, Electric utility, Active) shows a functional site (HTTP 200, 0/50 broken links, claimed profile) but Foundational digital maturity (33/100 band). Deterministic audit (confidence 88) flags content hierarchy as main issue: Homepage H1 count: 13 and Meta description length: 0 characters, plus Image alt-text coverage: 46% and Structured data: not found. Useful to address but limited complexity - opportunity score 62 suggests Review rather than immediate Pursue.

## Safety contract

Do not invent revenue, decision-maker names, hosting costs, performance metrics, or unobserved facts. Outreach remains manual and must be reviewed before sending.
