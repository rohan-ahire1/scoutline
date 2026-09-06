# Utah Remodel Works

## Audit version

- Audit ID: legacy (unversioned)
- Status: Analyzed
- Audited: 2026-08-23T10:09:56.147Z
- Provenance: legacy-unversioned

## Opportunity assessment

- Opportunity score: 63
- Confidence: 90
- Source: Multi-page website audit + Lighthouse
- Research status: Analyzed

## Website audit

- Lighthouse mobile performance: Not measured
- Lighthouse accessibility: 88
- Lighthouse SEO: 52
- Same-site pages crawled: 10
- Internal links checked: 18
- Broken internal links: 0
- Mobile quality: Good
- HTTPS: Yes
- Detected stack: WordPress, Elementor, GA4

## Main observed issue

**Search clarity:** The homepage title is missing or outside a useful descriptive range.

## Findings

- The homepage title is missing or outside a useful descriptive range.
- The homepage does not use one clear primary heading.
- The homepage description is missing or too brief to explain the offer clearly.
- No structured data was detected on the homepage.

## Evidence

- Homepage returned HTTP 200 at https://general-contractors-utah.com/
- Page title: General Contractor Salt Lake City Utah – Kitchen Remodeling, Bathroom Remodeling & home remodeling in Salt Lake City
- Internal links observed on homepage: 6
- Homepage CTA phrases detected: 6
- Image alt-text coverage: 89%
- Structured data: not found
- Homepage title length: 116 characters
- Homepage H1 count: 2
- Meta description length: 0 characters
- JSON-LD structured data blocks: 0
- Crawled 10 same-site pages and checked 18 internal links

## Muse synthesis (advisory)

- Recommendation: Review
- Rationale: OpportunityScore 63 / Confidence 90 with mainIssue 'Search clarity' - evidence shows clear, fixable search/presentation gaps (empty meta description, 2 H1s, 116-char title, 0 JSON-LD blocks) alongside strong trust signals (4.9 from 31 reviews, Google profile claimed, 0 broken of 18 links checked) but mixed measurement (Lighthouse failed to run) and limited online action (no booking/estimate signal). Advisory - human should Review and validate scope before pursuing.
- Model: muse-spark-1.2-contributor
- Generated: 2026-08-23T10:13:23.983Z

Utah Remodel Works shows strong offline trust (4.9 from 31 reviews, 97% 4-5 star, claimed profile) but the website has addressable search-clarity gaps. Deterministic audit flags Search clarity as mainIssue: title at 116 characters, 2 H1s on homepage, empty meta description, and SEO 52/100. Structured data not found and homepage has no form despite 6 CTA phrases. Lighthouse run failed, so performance is unknown. Fixing title/description/H1 and adding LocalBusiness schema plus a homepage lead form are practical next steps.

## Safety contract

Do not invent revenue, decision-maker names, hosting costs, performance metrics, or unobserved facts. Outreach remains manual and must be reviewed before sending.
