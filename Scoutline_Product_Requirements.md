# Scoutline — Product Requirements and Workflow

**Purpose:** Functional description of Scoutline for product, UX, UI, and workflow collaboration.

**Scope:** Describes what the product is, what a user can do, how information moves through it, and what each state means. It intentionally excludes theme, color, visual styling, screen layout, and backend implementation details.

**Product status:** Local-first MVP in active development.

## 1. Product at a glance

Scoutline is a lead-research and sales workspace for finding service businesses that may benefit from a better website, understanding the opportunity with evidence, preparing a relevant first message, and manually moving the relationship through sales to a contract.

Scoutline is an AI-assisted sales researcher, not an autonomous sales agent. Its job is to reduce the time between “this may be a good prospect” and “I understand why this prospect is worth contacting.” The user remains responsible for deciding who is qualified, reviewing outreach, sending it, and managing the relationship.

### Primary job to be done

Given a geography and a set of business categories, Scoutline helps the user:

1. Discover businesses.
2. Collect a usable business profile.
3. Inspect the public website.
4. Identify meaningful business and website opportunities.
5. Turn the strongest findings into a concise, evidence-backed outreach conversation.
6. Manually manage the relationship through a sales pipeline and contract handoff.

### Product promise

- Every important conclusion is traceable to a source, observation, or saved piece of evidence.
- Research and AI reasoning clarify a human decision; they do not silently make the sales decision.
- Unknown information remains unknown instead of being guessed.
- Outreach is prepared for review and is never sent automatically.
- Repeated collection and analysis remain understandable: the user can tell what was discovered in which run and what changed over time.

### Primary user

A founder, independent studio, or small sales/research team looking for local service-business clients—especially businesses where a website improvement could plausibly improve calls, quote requests, bookings, or trust.

## 2. Product principles and guardrails

| Principle | Requirement |
|---|---|
| Evidence before opinion | Scores, findings, and outreach angles are grounded in observable business or website evidence. |
| Deterministic score, advisory AI | The opportunity score is calculated from measured signals. AI explains and synthesizes; it does not replace or silently alter the score. |
| Human approval at consequential steps | The user decides which clients become qualified, which email version to use, when to change a relationship stage, and when a contract is recorded. |
| Truthful uncertainty | Revenue, profit, employee count, branches, decision makers, and similar metrics remain unknown unless a named source supplies them. |
| Traceability over novelty | A user should be able to answer where a client came from, when it was collected, what was observed, and which run produced the result. |
| Operational failure is not rejection | A timeout, blocked crawl, provider failure, or AI failure is a recoverable operational state, not a negative judgment about the business. |
| No spam machine | The product supports draft creation and manual review. It does not automatically send cold emails or continue after an opt-out. |

## 3. End-to-end product flow

The core workflow moves a business from a raw discovery record to a human-reviewed sales opportunity. The user can enter through live discovery or CSV import, and can also run individual actions for an existing client.

1. **Start or import data** — Choose a location, business categories, and a maximum client count for a collection run, or import a prepared list of businesses.
2. **Collect business records** — Collect public business information such as name, category, address, website, contact paths, ratings, reviews, and provider-supplied business signals.
3. **Normalize and identify provenance** — Deduplicate businesses primarily by website/domain and record whether each client was new to the workspace, matched from a previous run, or audited again.
4. **Analyze websites** — Run a bounded website audit that combines HTML observations, limited crawling, internal-link checks, and Lighthouse measurements where available.
5. **Prepare a recommendation** — Save the measured opportunity score and evidence. Optionally ask AI to synthesize the evidence into priorities, recommendations, strengths, unknowns, and qualification guidance.
6. **Qualify manually** — The user decides whether the client is worth pursuing. Qualifying a client adds it to the sales pipeline.
7. **Prepare outreach** — Generate three materially different email lengths from the saved findings, then edit, copy, and review the selected version before sending it manually.
8. **Manage the relationship** — Move the client through sales stages. If the client is won, record the agreed amount, scope, terms, dates, conditions, and next step.

### Important vocabulary decision

- **Approved** is not a research checkpoint.
- **Qualified** is the user’s sales decision and places the client in the pipeline.
- **Ranked** is not a separate stage; the opportunity score is a prioritization signal.
- **LLM insights** is not a separate checkpoint; AI is an optional advisory layer inside the analyzed/recommendation experience.

## 4. Core domain concepts

| Concept | Meaning in the product |
|---|---|
| Client | A business record in the workspace containing identity, contact paths, source information, research state, findings, sales state, notes, and—when won—contract details. |
| Research run | A batch-oriented collection or audit session defined by location, categories, source, time, and limits. It has its own status, progress, counts, and linked clients. |
| Finding / evidence | An observed website or business fact, such as a Lighthouse metric, page-structure observation, broken-link result, form friction, CTA issue, technology signal, review signal, or source-backed profile field. |
| Opportunity score | A deterministic 0–100 signal used to prioritize review. It is not a guarantee of commercial value. |
| Confidence | A measure of how complete and reliable the evidence is. A high score with low confidence should invite investigation rather than certainty. |
| AI synthesis | An optional evidence-grounded explanation that summarizes opportunities, recommendations, strengths, unknowns, and qualification guidance. It does not change the deterministic score. |
| Outreach draft | A generated or fallback email subject/body tied to the client’s findings. Three length levels are available and each can be edited before copying. |
| Sales stage | The manual relationship state: Qualified, Contacted, Replied, Meeting, Proposal, Won, or Lost. |
| Contract record | A manual post-win record containing amount, currency, scope, payment terms, signed date, start date, conditions, and next step. |
| Run provenance | The relationship between a client and one or more runs: added as new, matched in a later discovery, or audited by that run. |

## 5. Research state model

Research progress answers **“how much do we know about this client?”** It is deliberately separate from the sales pipeline, which answers **“where are we in the relationship?”**

| Research phase | Definition of done | What it does not mean |
|---|---|---|
| **Scraped** | A client record and public business data exist in the workspace. | Website analysis may still be pending. |
| **Analyzed** | Website evidence and the opportunity score are saved. | The deterministic audit can be complete even if a component such as Lighthouse is partial or failed. |
| **Recommended** | A recommendation is ready for the user’s decision. | It does not mean the user has qualified the client. |

Recommended can use completed deterministic analysis and may include AI’s optional advisory synthesis.

### Operational statuses

Any research action can also carry an operational status independent of the research phase:

- **Queued:** Work has been accepted but has not started.
- **Running:** Work is actively being performed.
- **Waiting:** The system is waiting on an external provider or retry window.
- **Completed:** The requested operation finished and its result is saved.
- **Failed:** The operation could not finish; the reason is visible and retryable where appropriate.
- **Paused:** A run was deliberately paused by the user.
- **Cancelled:** A run was deliberately stopped by the user.

A failure is attached to a stage and includes a reason and retry path.

## 6. Business discovery and client data

### Ways a client enters the workspace

- **Live discovery:** A collection run searches a chosen geography and business categories through the configured business-data provider.
- **CSV import:** A prepared client list is supplied for seeding, testing, or sources not connected to live discovery.
- **Existing workspace client:** A client can be re-analyzed or enriched without being newly discovered.

### Business information to collect when available

The client profile should make the source and freshness of each field understandable. Provider-supplied data can include:

- Business identity: name, category, address/location, website, source URL, phone, public email, rating, review count, hours, and service descriptions.
- Google/business profile signals: claimed status, review distribution and recency, photos, booking or estimate links, categories, and observed locations.
- Company metrics when a named source supplies them: employee count, estimated annual revenue, estimated annual profit, founding year, and branch count.
- Website and technology signals: CMS/framework clues, analytics or third-party scripts, booking/form systems, HTTPS, mobile setup, and other observable technical evidence.

### Unknowns are valid data

Scoutline must not infer revenue, profit, employee count, branch count, decision-maker identity, hosting cost, or business age from weak signals. When no source supplies a field, it remains unknown and the product should explain what source would be required.

### Run identity and provenance

Each run is identifiable by an ordered run number, start time, source, location, categories, status, and progress. The run exposes the clients it touched and distinguishes:

- **New clients:** First added to the workspace by that run.
- **Matched clients:** Already present but returned again by that run.
- **Audited clients:** Clients whose website research was processed by that run.

Each client retains a human-readable origin such as “Added in Run 1” and a history of later runs that matched or audited it. This avoids the ambiguity of a single undated “source” label.

## 7. Website analysis requirements

Website analysis is bounded, repeatable, and honest about partial results. It is intended to reveal actionable business and conversion opportunities, not to produce a generic technical audit report.

### Initial observations

- Reachability, redirect behavior, HTTPS, and basic response success.
- Page title, meta description, canonical, viewport, heading hierarchy, structured data, and content signals.
- Contact paths, phone/email links, forms, CTA visibility, quote/booking paths, financing language, and trust signals.
- Image alt coverage, mobile setup, technology clues, scripts, and other observable implementation signals.

### Bounded crawl and link checks

- Use the homepage plus a limited number of same-site pages, optionally informed by the sitemap.
- Respect the website’s robots rules where applicable and avoid action routes such as login, checkout, or account paths.
- Check a bounded set of internal links and save the response status or error for each checked destination.
- Record crawl errors and partial completion instead of hiding failed pages.

### Lighthouse and measured performance

- Where available, collect mobile performance, accessibility, SEO, best-practice, and timing metrics.
- If Lighthouse cannot launch or load the page, keep the client analyzed with a visible partial component state; never fabricate a performance score.

### Analysis output

The result should include:

- Measured opportunity score and confidence.
- Prioritized problems and supporting evidence.
- Crawl, page, and link counts.
- Technical and Lighthouse metrics where available.
- A clear indication of which parts are complete, partial, unavailable, or failed.

## 8. Scoring and recommendation logic

The opportunity score is a prioritization aid for deciding which clients deserve attention. It is not a prediction of revenue, a ranking checkpoint, or an automatic qualification decision.

### Score behavior

- Use measured business fit, website/conversion gaps, technical pain, rebuild feasibility, and contactability signals where available.
- Keep confidence separate from opportunity. An exciting lead with thin evidence should be clearly marked as uncertain.
- Every scored issue should be explainable through an evidence point, metric, URL, or saved observation.
- AI may prioritize or explain findings but must not silently change the deterministic score.

### Recommendation semantics

**Recommended** means “ready for a human decision based on the available evidence.” It is not the same as qualified, contacted, or won. The user must explicitly qualify a client before it enters the pipeline.

## 9. AI synthesis requirements

AI is the optional reasoning layer that turns saved evidence into a compact decision brief. It is a collaborator that organizes evidence, not the authority that invents facts or owns the score.

### AI inputs

- Saved client profile and source-backed business signals.
- Deterministic opportunity score and confidence.
- Website crawl summary, page observations, broken-link evidence, and Lighthouse metrics or selected failures.
- User’s configured outreach-length preference when drafting outreach.

### AI outputs

- A concise summary of the business and the most important opportunity.
- Prioritized opportunities with severity, observed evidence, and a recommended improvement.
- Strengths worth preserving or mentioning.
- Unknowns and evidence gaps that should not be presented as facts.
- Qualification guidance such as pursue, review, or deprioritize, with rationale.
- Outreach angles grounded in actual findings.

AI does not create a separate “LLM insights” stage. The underlying website analysis remains useful without AI.

## 10. Screen-by-screen functional requirements

### 10.1 Clients — the client database

**Purpose:** Provide a reliable workspace-level view of every business and its current research and sales state.

- Show aggregate counts for total clients, qualified clients, open pipeline clients, and won clients.
- Support views for All, Researching, In pipeline, and Won.
- Allow client search by name and related profile text.
- Show each client’s research phase, opportunity score, sales stage, last update, and origin run.
- Open a client’s detail workspace without losing the current navigation context.

### 10.2 Research — the evidence and operations workspace

**Purpose:** Make research progress legible from raw collection to a human qualification decision.

- Show counts for Scraped, Analyzed, and Recommended clients.
- Show each client’s three research checkpoints, current phase, failure state, score, and next available action.
- Allow a user to analyze one client, retry a failed audit, or qualify a completed client.
- Show the active collection run with its true phase, status, progress, and controls.
- Show run history, including run number/date/source, new and matched client counts, audited count, and the clients linked to that run.

### 10.3 Client detail workspace

**Purpose:** Provide a complete, evidence-backed view of one business and all actions that can be taken on it.

- Business identity, category, address, website, Google Maps link, contact paths, and source context.
- Origin run and later run history, including whether the client was new, matched, or audited.
- Research progress across Scraped, Analyzed, and Recommended.
- Summary of the main opportunity, findings, business intelligence, score, confidence, crawl metrics, Lighthouse metrics, and unknowns.
- Manual notes and editable operational context.
- Manual actions: refresh business data, run website audit, run AI analysis, generate outreach, or run the full workflow.
- Sales context with relationship stage, outreach draft, and contract details after a win.

### 10.4 Outreach — the review-before-send workspace

**Purpose:** Turn qualified research into a short, relevant, human-reviewed first message.

- Show qualified clients with the strongest relevant findings alongside their draft.
- Support All, Ready, and Contacted views.
- Generate, edit, save, select, and copy one of three email versions.
- Show whether an email was generated from the configured model or a deterministic evidence fallback.
- Allow the user to mark a client Contacted only after reviewing the draft; sending itself remains outside the app.

### 10.5 Pipeline — the relationship board

**Purpose:** Manage the manual sales relationship after a client is qualified.

- Use the stages Qualified, Contacted, Replied, Meeting, Proposal, Won, and Lost.
- Allow moving a client by drag-and-drop or an explicit stage menu.
- Treat Qualified as the entry point to the pipeline, not as a synonym for research recommendation.
- Keep stage changes visible on the client record and in relevant navigation counts.

### 10.6 Won — the handoff and contract workspace

**Purpose:** Record the agreement once a client says yes and preserve the information needed for delivery follow-up.

- Show won-client count, recorded contract value, and start-date coverage.
- Capture approved amount, currency, scope, payment terms, signed date, start date, conditions, and next step.
- Allow contract details to be added or edited manually.

### 10.7 Settings and workspace state

**Purpose:** Expose the defaults and provider readiness needed for day-to-day operation.

- Default location, client limit, deep-audit limit, and discovery coordinates.
- Whether live business discovery is available.
- Which outreach model/provider is configured and whether a fallback is active.
- Local workspace and persistence status at a conceptual level.

## 11. Outreach content requirements

Outreach should be concise, specific, and easy for a busy business owner to understand. The system should use the evidence to choose one or two high-value observations rather than dumping the entire audit into a message.

| Version | Length target | Functional requirement |
|---|---|---|
| **Concise** | Around 50 words | One or two important findings, one clear improvement idea, and a low-friction invitation. |
| **Balanced** | Around 110 words | A short context line, a small set of evidence-backed findings, why they matter, and a simple offer. |
| **Detailed** | Materially longer and more complete | A fuller report of the main issues, supporting evidence, possible improvements, and a clear next step. It should still be readable, not a raw audit dump. |

### Generation rules

- The selected length preference must be included in the model instruction when drafts are generated.
- The three versions must be meaningfully different in detail, not the same message with a few words removed.
- Claims must come from saved evidence. If a metric is unknown, the email must not invent it.
- The draft should offer a relevant next step, such as sharing a free homepage concept or discussing one improvement.
- The user can edit any subject or body before copying it.

## 12. Sales and contract requirements

| Sales stage | Meaning |
|---|---|
| **Qualified** | The user has chosen to pursue the client; the client enters the pipeline. |
| **Contacted** | The user has reviewed and sent or otherwise delivered the first outreach. |
| **Replied** | The client has responded. |
| **Meeting** | A conversation or meeting is scheduled or has taken place. |
| **Proposal** | A proposal or commercial scope has been shared. |
| **Won** | The client agreed to work together; contract details can be recorded. |
| **Lost** | The opportunity is closed without a win and remains historically visible. |

### Stage rules

- A client can be Recommended without being Qualified.
- Qualifying a client sets the sales stage to Qualified and makes it available in Outreach and Pipeline.
- Moving to any later sales stage implies the client is qualified.
- Won is a relationship outcome, not just a label; it unlocks the contract record and delivery handoff context.

## 13. Manual controls and individual-client workflows

The user should not need to rerun a full batch to fix or refresh one client. Every client can be operated on individually when the user has a specific reason.

| Action | When to use it | Expected result |
|---|---|---|
| **Refresh business data** | Re-fetch the provider record for a client with a saved source URL. | Provider data is refreshed and missing fields can be enriched. |
| **Run website audit** | Repeat the bounded website analysis for one client. | Research evidence and score are refreshed. |
| **Run AI analysis** | Synthesize saved audit evidence for one client. | AI recommendation, opportunities, strengths, and unknowns are refreshed. |
| **Generate outreach** | Create the three evidence-based drafts for one qualified or analyzed client. | Subject and drafts are saved for review. |
| **Run full workflow** | Refresh business data, audit, synthesize, and generate outreach in sequence where prerequisites are available. | The client receives a visible multi-step manual run state. |

Each manual action needs visible Queued, Running, Waiting, Completed, and Failed states where relevant. A failed action should explain which phase failed, preserve successful earlier work, and offer a retry instead of forcing the user to start over.

## 14. Failure, partial-data, and recovery behavior

The product should make failure understandable without turning the workspace into an error console. Failures are operational facts about a run or action, not judgments about the prospect.

| Failure type | Meaning | Required behavior |
|---|---|---|
| Discovery/provider failure | The collection provider cannot start, returns an error, or never completes. | Mark the run as failed or waiting with provider context; preserve the run record and allow retry. |
| Website fetch failure | A site cannot be reached, resolves to a blocked/private target, times out, or returns an unusable response. | Mark the audit stage failed; keep the client record and source data; allow retry or manual review. |
| Partial crawl or Lighthouse failure | Some pages or a measurement component cannot be collected. | Keep the analyzed result with a visible partial component state and never substitute a fabricated metric. |
| AI failure | The model returns an error, invalid structure, or cannot be reached. | Keep deterministic analysis and score; mark AI failed and offer retry. |
| Outreach generation failure | The selected provider or fallback cannot produce a draft. | Keep findings available; explain the failure; allow retry or manual editing. |
| Manual run failure | A multi-step client workflow stops after one phase. | Preserve completed phases, identify the failed phase, and let the user rerun that action. |

## 15. Data integrity and trust requirements

- Preserve source and observed-at context for important business and website fields.
- Keep repeated run history instead of overwriting the fact that a client was seen or audited before.
- Deduplicate repeated provider results without losing the client’s original origin run or later matched runs.
- Keep deterministic score, confidence, AI synthesis, findings, outreach drafts, sales stage, and contract record conceptually separate.
- Do not let a model invent metrics, customer value, decision-makers, outcomes, or contract terms.
- Do not send outreach automatically; design for human review and future suppression/opt-out handling.
- Treat website data as potentially hostile or incomplete input; preserve safe, bounded, and partial results.

## 16. Current scope versus intentionally future work

### In the current product scope

- Local-first client workspace with persistent clients, runs, jobs, settings, and event history.
- Live business discovery through the configured provider or CSV import.
- Source-backed profile enrichment and explicit unknown values.
- Website HTML inspection, bounded crawl, internal-link checks, Lighthouse measurements, and saved evidence.
- Deterministic opportunity score and confidence.
- Optional AI synthesis grounded in saved evidence.
- Three outreach draft lengths with edit/copy/review workflow.
- Manual qualification, Kanban-style sales stages, and contract recording after a win.
- Per-client manual actions, retryable job states, failures, and run provenance.

### Not part of the current product behavior

- Automatic cold-email sending, automatic follow-up sequences, or automatic qualification.
- A separate LLM-insights checkpoint or a separate ranked checkpoint.
- A complete competitor benchmarking system or longitudinal “why now?” monitoring.
- Automatic public redesign publishing or a public speculative website for every lead.
- Guaranteed employee, revenue, profit, branch, decision-maker, hosting-cost, or website-age data when no source provides it.
- A full CRM, billing system, team permissions, or multi-workspace collaboration model.
- A replacement for human sales judgment, compliance review, or contract/legal review.

### Potential next-stage capabilities

- Competitor comparisons showing relative performance, conversion friction, and service-page coverage.
- Revisit schedules and “why now?” signals such as new locations, new services, outages, or website changes.
- Small proof artifacts such as an annotated screenshot, homepage concept, or short opportunity report for manually approved leads.
- Decision-maker and contact enrichment from lawful, user-approved sources.
- Suppression lists, outreach limits, audit-history comparison, and a more complete revenue learning loop.

## 17. Design questions for the next exploration

1. How should a user compare two runs without losing the simple current workflow?
2. Should the default Research view show the latest run only, all active work, or a user-selected run?
3. How much provenance belongs on a client list row versus the client detail workspace?
4. What is the clearest distinction between Recommended, Qualified, and In pipeline for a first-time user?
5. Should a client’s run history show only discovery events, or every audit and enrichment event?
6. How should the product communicate partial evidence without making a client feel “broken”?
7. What information is necessary before a user feels comfortable copying an outreach draft?
8. Which proof artifact is most valuable for a qualified lead: a concise report, annotated screenshot, or private concept?
9. What should the user see immediately after a run completes: new clients, highest opportunities, failures, or changes since the previous run?
10. Which signals should be learned from real outcomes such as reply, meeting, proposal, and win?

## Appendix A — canonical vocabulary

| Vocabulary group | Canonical terms |
|---|---|
| Research phases | Scraped · Analyzed · Recommended |
| Operational statuses | Queued · Running · Waiting · Completed · Failed · Paused · Cancelled |
| Sales stages | Qualified · Contacted · Replied · Meeting · Proposal · Won · Lost |
| Run relationships | New · Matched · Audited |
| Score concepts | Opportunity score · Confidence · Evidence · Unknowns |
| AI concept | AI synthesis — advisory, evidence-grounded, and separate from the deterministic score |

## Final product definition

Scoutline helps a human researcher discover promising local businesses, understand their website and business opportunities with evidence, choose who is worth pursuing, prepare a relevant outreach conversation, and manage the relationship through a manual sales pipeline and contract handoff.
