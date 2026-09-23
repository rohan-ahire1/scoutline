Implement a first, safe Jev integration for Scoutline.

Objective
Add a feature-flagged semantic triage layer to the existing local scrape workflow. A configured TypeSafe API key should cause each successfully crawled site to receive a small batch of Jev atomic decisions. The crawl and deterministic scores must remain authoritative; Jev is advisory routing metadata only.

Repository context
- This is a dirty worktree containing substantial user changes. Preserve unrelated changes and do not reset, checkout, or rewrite generated data.
- The app is Node 20+/ESM, Express, React/Vite. Global fetch is available; do not add a dependency just for Jev.
- Local scraping runs in server/services/crawlRunner.js: crawlSite -> aggregateSite -> mapEngineResultToSite -> save JSON run.
- Crawl exports are normalized in server/services/crawl.js and displayed in src/CrawlPage.jsx.
- /api/status and the Settings page already expose connection/setup guidance for other providers.
- Existing deterministic fields such as last_opportunity_score, last_visual_risk_score, eligible, and eligibility_reasons must not be overwritten by Jev.

Chosen design
1. Create server/services/jev.js as a small HTTP adapter using POST https://api.typesafe.ai/v1/systemone.
2. Configuration:
   - canonical env var TYPESAFE_API_KEY
   - optional JEV_MODEL default jev-latest
   - optional JEV_API_URL default https://api.typesafe.ai/v1/systemone
   - getJevConfig(options) must support test overrides without exposing the key.
3. The adapter must expose pure/testable helpers:
   - getJevConfig
   - buildJevState
   - buildJevQuestions
   - normalizeJevResponse (or equivalent validation helper)
   - deriveJevTriage
   - evaluateJev
   Keep state compact: business identity, title/meta/H1/text excerpt, page count, contact/form signals, tech flags, visual risk, deterministic opportunity/eligibility signals. Never send API keys or raw HTML beyond a capped excerpt.
4. Batch these independent questions in one request:
   - site_archetype Choice: local_service, ecommerce, portfolio_or_agency, content_or_publisher, other_or_unclear
   - primary_opportunity Choice: redesign, conversion, performance_or_mobile, seo_or_structure, maintenance, none_or_unclear
   - redesign_fit Score with four ordered levels from no supported case to exceptionally strong observed need
   - conversion_gap Score with four ordered levels
   - mobile_friction Score with four ordered levels
   - clear_contact_path Noul
   - should_deep_audit Noul
   Questions must be atomic and describe observed evidence only; do not ask Jev to generate prose or invent business outcomes.
5. deriveJevTriage must combine the three Score answers plus (1-clear_contact_path.noul) into a 0-100 semanticOpportunityScore, preserve the primary opportunity/archetype, expose the component scores, and produce a route:
   - deep-audit when semanticOpportunityScore >= 60 and should_deep_audit >= 0.55 and the Choice/Score answers are not low-confidence;
   - review when uncertain or score >= 40;
   - pass otherwise.
   Mark uncertainty when any Choice/Score confidence is below 0.55 or the Noul answer is between 0.35 and 0.65. Keep thresholds named constants.
6. evaluateJev must validate response types/options/ranges, support injected fetch and timeout for tests, retry 429/529 with short bounded exponential backoff (at most two retries), and throw a useful error with a code/status. Provider failure must not fail the crawl.
7. Integrate only in server/services/crawlRunner.js for now. After aggregateSite succeeds and only when Jev is configured, call evaluateJev with state containing the discovered company/category/location and aggregate. Attach a sanitized `jev_triage` object to the mapped site. If Jev is not configured, omit the field. If Jev fails, keep the site completed and attach a compact `jev_triage` failure state so the UI can explain it.
8. Extend server/services/crawl.js normalization/mapping to preserve only bounded, safe `jev_triage` fields for imported/local crawl sites. Do not let arbitrary JSON through.
9. Update `/api/status` in server/index.js with jevConfigured and jevModel, without returning secrets. Add TYPESAFE_API_KEY/JEV_MODEL/JEV_API_URL to .env.example and README setup documentation.
10. Update src/CrawlPage.jsx to show a compact “Jev triage” section only when the site has Jev metadata: route, semantic score, archetype, primary opportunity, and an uncertainty/failure note. Reuse existing badges/classes where possible; add minimal CSS only if needed. Update SettingsPage’s setup guide/connection list to explain the Jev key and that local scrapes will classify sites when configured. Pass the existing apiStatus through App only if needed.

Data/compatibility rules
- Existing crawl exports without jev_triage must continue to validate and render exactly as before.
- Do not change CRAWL_EXPORT_VERSION for an optional additive field.
- Do not change deterministic qualification_state, last_opportunity_score, lead value, Muse synthesis, outreach, or manual-send behavior.
- Do not call Jev from the browser and do not store the API key in SQLite or JSON artifacts.
- A Jev answer is not evidence for a sales claim; label it advisory in UI copy.

Tests and acceptance criteria
- Add server/services/jev.test.js covering: config defaults/override, compact state, exact question schema, response normalization/derivation, uncertainty/route rules, and evaluateJev with fake fetch (including retry and non-fatal provider error handling at the runner boundary if practical).
- Extend crawl tests for jev_triage normalization if needed.
- Run npm test and npm run build. If unrelated existing failures occur, report them precisely; do not repair unrelated files.
- Keep edits focused and report changed files plus checks.
