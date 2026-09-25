import type { JourneyMemoryConfidenceChange, JourneyMemorySegment } from "../../types/journeyMemory.js";

/**
 * A single new failure must never by itself invalidate an older verified success (binding
 * contract §6) -- confidence only decays once this many *comparable* recent failures for
 * the same equivalence key have accumulated. Deliberately conservative/unvalidated,
 * consistent with this feature's other labelled-unvalidated thresholds.
 */
export const MULTI_FAILURE_DECAY_THRESHOLD = 3;
export const CONFIDENCE_DECAY_PER_FAILURE_GROUP = 0.15;
export const MIN_CONFIDENCE = 0.05;

/**
 * Two segments are "equivalent" (binding contract §6/§5's dedup requirement) when they
 * describe the same structural journey step: same source page identity, same action
 * meaning, and (for forward segments) the same destination -- never keyed on raw ids, only
 * on the already-sanitized semantic identity fields.
 */
export function equivalenceKey(segment: JourneyMemorySegment): string {
  if (segment.kind === "forward") {
    return JSON.stringify({
      kind: "forward",
      domain: segment.provenance.registrableDomain,
      source: `${segment.sourcePage.registrableDomain}${segment.sourcePage.normalizedPath}`,
      action: segment.action.semanticLabel,
      destination: `${segment.destinationPage.registrableDomain}${segment.destinationPage.normalizedPath}`,
    });
  }
  return JSON.stringify({
    kind: "recovery",
    domain: segment.provenance.registrableDomain,
    source: `${segment.sourcePage.registrableDomain}${segment.sourcePage.normalizedPath}`,
    action: segment.failedCandidate.semanticLabel,
  });
}

function isSuccess(segment: JourneyMemorySegment): boolean {
  return segment.kind === "forward" ? segment.outcome === "success" : segment.finalRecoveryOutcome === "recovered";
}

function isFailure(segment: JourneyMemorySegment): boolean {
  return segment.kind === "forward" ? segment.outcome === "failure" : segment.finalRecoveryOutcome === "not_recovered";
}

export interface DedupResult {
  /** Records to write (the incoming record, and/or any existing record whose confidence changed). */
  toWrite: JourneyMemorySegment[];
  /** Existing record ids to delete (pure duplicates only -- an older success is never deleted for a newer failure). */
  toDelete: string[];
  confidenceChanges: JourneyMemoryConfidenceChange[];
}

/**
 * Applies the outcome-precedence rules (binding contract §6) for one incoming record
 * against the existing records sharing its equivalence key:
 *  - A newer verified success supersedes older equivalent successes (deduped, the newest
 *    kept, older pure duplicates removed).
 *  - A newer failure never deletes/overwrites an older equivalent success; both are kept.
 *    The older success's confidence decays only once MULTI_FAILURE_DECAY_THRESHOLD
 *    comparable recent failures (by equivalence key) have accumulated -- a lone new
 *    failure never invalidates it.
 *  - A new verified success restores/raises a decayed equivalent success's confidence
 *    (implemented as: the new success record itself is written at full confidence, and any
 *    older equivalent record's confidence is reset upward).
 * All confidence changes are returned so the caller's diagnostics stay visible, per the
 * binding contract's audit-trail requirement.
 */
export function applyOutcomePrecedence(
  incoming: JourneyMemorySegment,
  existing: JourneyMemorySegment[],
): DedupResult {
  const key = equivalenceKey(incoming);
  const equivalent = existing.filter((s) => equivalenceKey(s) === key);
  const confidenceChanges: JourneyMemoryConfidenceChange[] = [];
  const toDelete: string[] = [];
  const toWrite: JourneyMemorySegment[] = [incoming];
  const now = new Date().toISOString();

  if (isSuccess(incoming)) {
    for (const existingRecord of equivalent) {
      const isDecayed = existingRecord.confidence < 0.7;
      if (isSuccess(existingRecord) && !isDecayed) {
        // Newer success supersedes an older, still-fresh duplicate success outright.
        toDelete.push(existingRecord.id);
      } else if (isDecayed) {
        // A new verified success restores/raises a decayed equivalent record's confidence
        // (whether that record's own outcome is itself "success" -- decayed by
        // accumulated later failures -- or a failure/partial record for the same journey).
        const restored: JourneyMemorySegment = { ...existingRecord, confidence: Math.min(1, existingRecord.confidence + 0.3) };
        confidenceChanges.push({
          recordId: existingRecord.id,
          previousConfidence: existingRecord.confidence,
          newConfidence: restored.confidence,
          reason: "A newer verified success for the equivalent journey restored this record's confidence.",
          timestamp: now,
        });
        toWrite.push(restored);
      }
    }
    return { toWrite, toDelete, confidenceChanges };
  }

  if (isFailure(incoming)) {
    const recentComparableFailures = equivalent.filter(isFailure).length + 1;
    for (const existingRecord of equivalent) {
      if (isSuccess(existingRecord) && recentComparableFailures >= MULTI_FAILURE_DECAY_THRESHOLD) {
        const decayed: JourneyMemorySegment = {
          ...existingRecord,
          confidence: Math.max(MIN_CONFIDENCE, existingRecord.confidence - CONFIDENCE_DECAY_PER_FAILURE_GROUP),
        };
        confidenceChanges.push({
          recordId: existingRecord.id,
          previousConfidence: existingRecord.confidence,
          newConfidence: decayed.confidence,
          reason: `${recentComparableFailures} comparable recent failures accumulated against this equivalent journey; confidence decayed (never deleted).`,
          timestamp: now,
        });
        toWrite.push(decayed);
      }
    }
    return { toWrite, toDelete, confidenceChanges };
  }

  // Partial outcome: never deletes anything, never decays a success on its own.
  return { toWrite, toDelete, confidenceChanges };
}

/**
 * Lazy, opportunistic eviction (checked on write, per binding contract §6's "no cron job"
 * note -- this single-process deployment has no scheduler) once a domain's record count
 * exceeds maxRecordsPerDomain: evicts the lowest-confidence, then oldest, records first.
 */
export function selectRecordsToEvict(
  records: JourneyMemorySegment[],
  maxRecordsPerDomain: number,
): string[] {
  if (records.length <= maxRecordsPerDomain) return [];
  const sorted = [...records].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence - b.confidence;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
  return sorted.slice(0, records.length - maxRecordsPerDomain).map((r) => r.id);
}

export function isExpiredByRetention(segment: JourneyMemorySegment, retentionDays: number): boolean {
  const ageMs = Date.now() - new Date(segment.timestamp).getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}
