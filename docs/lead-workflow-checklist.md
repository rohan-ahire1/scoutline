# Lead-workflow implementation checklist (M1)

Shared readiness source: `server/services/readiness.js`, re-exported for the
UI at `src/domain/readiness.js`. API (`GET /api/leads/:id/readiness`,
`GET /api/queue`) and UI (`OutreachPage`, `ResearchReviews`) use it directly.

## Field map

| Concept | Existed | Extended |
|---|---|---|
| Research (opportunityScore, auditStatus, auditedAt, auditHistory, researchFailure) | yes | freshness policy `EVIDENCE_FRESH_DAYS = 60` in readiness.js |
| Opportunity review (problems, evidence, findingReviews, currentAuditId) | yes | `describeOpportunity` + `rankFindingsForOutreach` in brief.js |
| Contact channels (phone, email, auditSummary.forms, sourceUrl) | yes | `contactCandidates[]` additive with provenance; `POST /api/leads/:id/contacts` |
| Commercial (leadValue scorer, no stored scores) | scorer only | `POST /api/lead-value/backfill` persists versioned scores; status unscored/scored/stale/insufficient |
| Drafts (outreachDraft/Drafts, candidates, revision protection) | yes | `outreachChannels` (email/phone/form), `outreachProvenance` (opportunity, audit, offer version, contact) |
| Offer/campaign settings | no | `settings.offer` (service, categories, geography, exclusions, proof, CTA, tone, channels) + version |
| Suppression (doNotContact) | yes | unchanged; takes precedence in readiness and queue |
| Follow-up (nextTask) + attempts (contactAttempts) | yes | outcome mapping: no-answer keeps waiting; not-interested closes Lost; conversation marks Contacted |
| Duplicates (businessId, name groups) | partial | `duplicateReviewed` flag; readiness blocks until resolved |
| Prospect brief | internal only | `buildProspectBrief` + `POST /api/leads/:id/prospect-brief` (snapshot, internal details excluded) |

## Migration safety

- Leads are schemaless JSON payloads: all new fields are additive, absence
  means "unknown", never backfilled with invented dates or provenance.
- `POST /api/lead-value/backfill` is idempotent (second run reports
  `unchanged`), uses saved evidence only, rewrites only changed rows so
  notes/stages/contracts/suppression/attempts/drafts/audit history survive.
- JSON backup/restore round-trips whole payloads; new-field coverage is tested
  in `server/services/backup.test.js`.
- Always: verify backup coverage, create a recoverable local backup first
  (`POST /api/backups`), then backfill.
