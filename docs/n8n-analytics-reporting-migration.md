# n8n migration: analytics reporting rows

As of `schemaVersion`/`outputSchemaVersion` 1.26.0, `task-response` carries a new top-level
field, `analyticsReportingRows` (see `schemas/task-response.schema.json`'s
`$defs/analyticsReportingRow` and `src/capture-modules/analyticsReportingRows.ts`): a final,
flattened, deterministically-ordered, deduplicated array of reporting records. This document
describes what changes on the n8n side. It does not modify n8n's own "Build Analytics
Reporting Rows" Code node — that is a follow-up change to be made and validated in n8n
directly, using this document as the spec.

## 1. What the engine now guarantees

Every row in `analyticsReportingRows` is one of `recordType`: `START_PAGE`, `CTA_CLICK`, or
`ANALYTICS_EVENT` (the latter further distinguished by `eventRole`: `PRIMARY_CLICK` —
merged into its own `CTA_CLICK` row, never a separate row — `CLICK_CANDIDATE`,
`ASSOCIATED_RESULT`, or `RAW_CAPTURE_IN_ACTION_WINDOW`). Rows are already:

- **Ordered**: `START_PAGE` first, then per journey-relevant action in step order
  (`CTA_CLICK`, its `CLICK_CANDIDATE` rows, its `ASSOCIATED_RESULT` rows, then any remaining
  `RAW_CAPTURE_IN_ACTION_WINDOW` rows), with a contiguous 1-based `journeySequence` already
  assigned across the whole run.
- **Deduplicated**: the same logical analytics event observed more than once (e.g. two
  different capture shapes of one `dataLayer.push()`) is exactly one row, identified by a
  stable, deterministic `eventId`.
- **Classified and correlated**: `eventClassification`/`correlationStatus`/
  `primaryClickTagStatus`/`analyticsCaptureStatus` are the engine's own final decisions,
  reusing its existing action-ownership and evidence-classification logic. n8n never needs to
  re-derive these from raw `captures.*` evidence.

## 2. What the n8n Code node must stop doing

The current "Build Analytics Reporting Rows" Code node reconstructs, classifies, correlates,
canonicalises, and deduplicates analytics evidence itself, reading `captures.cta_clicks` /
`captures.page_visits` / raw GA4 and dataLayer evidence directly. Once this contract is
validated end-to-end, that logic becomes obsolete and should be deleted, not ported —
n8n consuming raw `captures.*` for reporting purposes going forward is itself the bug this
contract exists to fix.

## 3. What replaces it

- **Split Out** `analyticsReportingRows` directly into one item per row. No parsing,
  flattening, or grouping step is needed first — each row is already a flat object with a
  stable, documented field set (see the schema `$defs/analyticsReportingRow`).
  Recommended field to split on: `analyticsReportingRows`.
- **Edit Fields (Set)** may rename columns for the destination sheet/table (e.g.
  `ctaText` → "CTA Text"), but must not compute, merge, or drop values.
- **Switch** may route rows by `recordType` and/or `eventRole` (e.g. one branch per sheet
  tab: start pages, CTA clicks, analytics events) — this is presentation routing, not
  classification.
- Any correlation/status the destination needs (e.g. "was this click confirmed?") should
  read `correlationStatus` / `primaryClickTagStatus` directly rather than re-deriving it
  from `analyticsCaptureStatus` or raw evidence.

## 4. Fields available on every row

See `AnalyticsReportingRow` in `src/types/task-response.ts` and
`$defs/analyticsReportingRow` in `schemas/task-response.schema.json` for the authoritative,
versioned field list (run/task identity, step/timestamp, CTA and destination URLs,
milestone/journey fields, capture status fields, event identity and classification fields,
generic analytics fields such as `eventName`/`pageTitle`/`measurementId`/`vehicleYear`, and
`rawEvidenceJson` — the canonicalised raw payload for audit, never parsed by n8n). A field is
present only when the engine actually has a value for it; n8n's mapping should treat every
field as optional.

## 5. Backward compatibility

`analyticsReportingRows` is additive — every field previously read from `captures.*` /
`engineAssessment` is unchanged and still present. An empty `analyticsReportingRows: []` is
schema-valid (a run with no page visits or CTA clicks recorded, e.g. an early
`stop_blocked`/`stop_failure`), so the Split Out step should tolerate zero items rather than
error.

## 6. Suggested rollout

1. Point Split Out at `analyticsReportingRows` in a new branch of the workflow, running
   alongside the existing Code node (do not remove it yet).
2. Compare output row-for-row against the existing node's output on a handful of real runs.
3. Once matched (or once the new contract's output is confirmed correct where the two
   diverge — the engine-owned contract is the source of truth), cut the workflow over and
   delete the old Code node.
