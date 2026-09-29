// n8n "Build Analytics Reporting Rows" Code node -- pure transform, no n8n runtime dependency.
//
// Replaces the old hand-rolled reconstruction node (which read captures.cta_clicks /
// captures.page_visits / raw GA4 and dataLayer evidence directly and reconstructed rows
// itself). The engine is the single source of truth for classification, correlation,
// deduplication and ordering (see docs/n8n-analytics-reporting-migration.md) -- this module
// passes response.analyticsReportingRows straight through, sanitizes a small set of URL/raw
// fields, and derives one small n8n-side-only field (adoptionStatus) from
// diagnostics.surfaceAdoption -- it never re-derives anything the engine already decided, and
// never computes milestone completion from analytics.
//
// Compatible with schemaVersion/outputSchemaVersion 1.29.0 and 1.30.0 -- analyticsReportingRows'
// own row shape is unchanged since 1.26.0; this module reads no 1.30.0-only field.
//
// To use inside n8n's Code node, paste the body of buildAnalyticsReportingRowsItems (and its
// helpers) into the node and call it as:
//   const items = $input.all().map((item) => item.json);
//   return buildAnalyticsReportingRowsItems(items);

const SENSITIVE_KEY_PATTERN = /token|password|secret|cookie|session|auth|api[-_]?key/i;

export function sanitizeUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.length === 0) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        u.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url; // not a parseable absolute URL -- left as-is, never guessed at
  }
}

export function sanitizeRawEvidenceJson(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // not JSON -- left as-is rather than mangled
  }
  const redact = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) redact(item);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          obj[key] = "[redacted]";
        } else {
          redact(obj[key]);
        }
      }
    }
  };
  redact(parsed);
  return JSON.stringify(parsed);
}

const URL_FIELDS = [
  "sourcePageUrl",
  "ctaElementDestinationUrl",
  "browserResultingUrl",
  "analyticsEventDestinationUrl",
  "analyticsPageLocation",
  "analyticsReferrer",
  "analyticsFullUrl",
  "analyticsVirtualPageUrl",
  "collectionEndpoint",
] as const;

interface SurfaceAdoptionAttempt {
  stepIndex: number;
  surfaceId: string;
  event: string;
}

type AnalyticsReportingRow = Record<string, unknown>;
type TaskResponseLike = {
  analyticsReportingRows?: AnalyticsReportingRow[];
  diagnostics?: { surfaceAdoption?: { attempts?: SurfaceAdoptionAttempt[] } };
  [key: string]: unknown;
};

/**
 * Derives adoptionStatus for popup-sourced rows from diagnostics.surfaceAdoption.attempts --
 * an n8n-side-only convenience field (the engine does not stamp this onto a row directly).
 * "adopted" / "rejected" reflect the outcome at the step that opened the candidate;
 * "returned" / "return_failed" / "closed_unexpectedly" reflect a later terminal event on that
 * same adopted surface, when one occurred. Purely additive -- never alters or drops a row, and
 * absent when unknown.
 */
function buildAdoptionStatusLookup(attempts: SurfaceAdoptionAttempt[] | undefined) {
  const openEventByStep = new Map<number, { event: string; surfaceId: string }>();
  const terminalEventBySurface = new Map<string, string>();
  for (const attempt of attempts || []) {
    if (attempt.event === "adopted" || attempt.event === "rejected") {
      openEventByStep.set(attempt.stepIndex, { event: attempt.event, surfaceId: attempt.surfaceId });
    } else if (attempt.event === "returned" || attempt.event === "return_failed" || attempt.event === "closed_unexpectedly") {
      terminalEventBySurface.set(attempt.surfaceId, attempt.event);
    }
  }
  return { openEventByStep, terminalEventBySurface };
}

function adoptionStatusForRow(
  row: AnalyticsReportingRow,
  lookup: ReturnType<typeof buildAdoptionStatusLookup>,
): string | undefined {
  if (row.evidenceSource !== "popup_context" || typeof row.contextId !== "string") {
    return row.evidenceSource === "main_frame" ? "not_applicable" : undefined;
  }
  const match = /^popup:(\d+)$/.exec(row.contextId);
  if (!match) return undefined;
  const openEvent = lookup.openEventByStep.get(Number(match[1]));
  if (!openEvent) return undefined;
  if (openEvent.event === "rejected") return "rejected";
  const terminal = lookup.terminalEventBySurface.get(openEvent.surfaceId);
  return terminal || "adopted";
}

/**
 * Pure transform: an array of TaskResponse-shaped objects in, an array of n8n-item-shaped rows
 * ({ json }) out. Never filters a row on navigationSuccessful, whether the opener URL changed,
 * or overall run status -- every row the engine emitted is preserved (requirements 6-8).
 */
export function buildAnalyticsReportingRowsItems(taskResponses: TaskResponseLike[]): { json: AnalyticsReportingRow }[] {
  const outputRows: AnalyticsReportingRow[] = [];
  const seenEventIds = new Set<string>();

  for (const response of taskResponses) {
    const rows = Array.isArray(response?.analyticsReportingRows) ? response.analyticsReportingRows : [];
    const attempts = response?.diagnostics?.surfaceAdoption?.attempts;
    const lookup = buildAdoptionStatusLookup(attempts);

    for (const row of rows) {
      // Deduplicate only truly equivalent records: the engine already guarantees a stable
      // eventId is unique per logical event; this is a defensive, engine-agnostic backstop
      // only, never a looser heuristic.
      const eventId = typeof row.eventId === "string" ? row.eventId : undefined;
      if (eventId) {
        if (seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);
      }

      const output: AnalyticsReportingRow = { ...row };
      for (const field of URL_FIELDS) {
        if (typeof output[field] === "string") {
          output[field] = sanitizeUrl(output[field] as string);
        }
      }
      if (typeof output.rawEvidenceJson === "string") {
        output.rawEvidenceJson = sanitizeRawEvidenceJson(output.rawEvidenceJson as string);
      }

      const adoptionStatus = adoptionStatusForRow(row, lookup);
      if (adoptionStatus) {
        output.adoptionStatus = adoptionStatus;
      }

      outputRows.push(output);
    }
  }

  // Deterministic journey ordering: the engine already emits rows in journeySequence order;
  // this sort is a defensive guarantee only (a no-op on already-sorted input).
  outputRows.sort((a, b) => ((a.journeySequence as number) ?? 0) - ((b.journeySequence as number) ?? 0));

  return outputRows.map((json) => ({ json }));
}
