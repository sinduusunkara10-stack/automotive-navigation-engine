import type { JourneyMemoryFlags, JourneyMemoryTimingConfig } from "../../config/journeyMemoryConfig.js";
import { rankJourneyMemoryCandidates, type JourneyMemoryScoringInput } from "./scoring.js";
import { applyOutcomePrecedence, selectRecordsToEvict } from "./retention.js";
import { withTimeout, type JourneyMemoryStore } from "./store.js";
import { TIER_EXPANSION_ORDER } from "./tiering.js";
import type {
  JourneyMemoryContext,
  JourneyMemoryLookupDurations,
  JourneyMemorySegment,
  ScoredJourneyMemoryCandidate,
} from "../../types/journeyMemory.js";

/** Once this many strong (score-accepted, tier1) candidates are found, tier expansion stops early -- see binding contract §4/§9. */
const SUFFICIENT_STRONG_CANDIDATES = 5;

function emptyDurations(): JourneyMemoryLookupDurations {
  return { redisMs: 0, filteringMs: 0, scoringMs: 0, tierExpansionMs: 0, totalMs: 0 };
}

export interface JourneyMemoryLookupParams extends JourneyMemoryScoringInput {
  timeoutMs: number;
}

/**
 * Deterministic, zero-Claude-call retrieval + ranking (binding contract §2): queries Tier1
 * first, only widening to Tier2/3/4 while the time budget (params.timeoutMs) remains and
 * yield is still insufficient -- returning as soon as enough strong evidence is found
 * rather than always burning the full budget (§9).
 */
export async function retrieveJourneyMemoryContext(
  store: JourneyMemoryStore | undefined,
  flags: JourneyMemoryFlags,
  params: JourneyMemoryLookupParams,
): Promise<JourneyMemoryContext> {
  const base: JourneyMemoryContext = {
    enabled: flags.enabled,
    storageAvailable: store !== undefined,
    lookupCompleted: false,
    accepted: [],
    ambiguous: [],
    rejected: [],
    candidatesConsidered: 0,
    durations: emptyDurations(),
  };

  if (!flags.enabled || !flags.readEnabled) {
    return { ...base, unavailableReason: "disabled" };
  }
  if (!store) {
    return { ...base, unavailableReason: "storage_unavailable" };
  }

  const startedAt = Date.now();
  const remainingMs = () => Math.max(0, params.timeoutMs - (Date.now() - startedAt));

  let allSegments: JourneyMemorySegment[] = [];
  const seenIds = new Set<string>();
  let redisMs = 0;
  let tierExpansionMs = 0;
  let timedOut = false;

  const addSegments = (values: JourneyMemorySegment[]) => {
    for (const value of values) {
      if (!seenIds.has(value.id)) {
        seenIds.add(value.id);
        allSegments.push(value);
      }
    }
  };

  // Tier1 and Tier2 are both same-registrable-domain records -- a single listDomain call
  // already returns everything for that domain (the exact per-record market comparison,
  // done later by scoring.ts's classifyTier, is what actually distinguishes Tier1 from
  // Tier2). This loop's real widening only ever happens at Tier3 (listByMarket) and Tier4
  // (listGlobal), per binding contract §4/§9: query Tier1 first, only widen once yield is
  // insufficient and budget remains, deduplicated by record id so a record already found in
  // an earlier tier's fetch is never double-counted.
  for (const tier of TIER_EXPANSION_ORDER) {
    if (remainingMs() <= 0) {
      timedOut = true;
      break;
    }
    if (tier === "tier2") {
      // Already covered by the tier1 domain fetch above -- see comment above the loop.
      continue;
    }
    const tierStart = Date.now();
    const fetchPromise =
      tier === "tier1"
        ? store.listDomain(params.currentDomain)
        : tier === "tier3"
          ? params.currentMarket
            ? store.listByMarket(params.currentMarket)
            : Promise.resolve([])
          : store.listGlobal();

    const result = await withTimeout(fetchPromise, remainingMs());
    tierExpansionMs += Date.now() - tierStart;
    if (result.timedOut) {
      timedOut = true;
      break;
    }
    redisMs += Date.now() - tierStart;
    addSegments(result.value);

    if (tier === "tier1") {
      const strongSoFar = allSegments.filter((s) => s.confidence >= 0.6).length;
      if (strongSoFar >= SUFFICIENT_STRONG_CANDIDATES) break;
    }
  }

  const filterStart = Date.now();
  const candidates = allSegments;
  const filteringMs = Date.now() - filterStart;

  const scoringStart = Date.now();
  const scored: ScoredJourneyMemoryCandidate[] = rankJourneyMemoryCandidates(candidates, params);
  const scoringMs = Date.now() - scoringStart;

  const accepted = scored.filter((c) => c.decision === "accept");
  const ambiguous = scored.filter((c) => c.decision === "ambiguous");
  const rejectedCandidates = scored.filter((c) => c.decision === "reject");
  const rejectedByReason = new Map<string, number>();
  for (const c of rejectedCandidates) {
    rejectedByReason.set(c.tier, (rejectedByReason.get(c.tier) ?? 0) + 1);
  }

  const totalMs = Date.now() - startedAt;

  return {
    enabled: true,
    storageAvailable: true,
    lookupCompleted: !timedOut,
    accepted,
    ambiguous,
    rejected: [...rejectedByReason.entries()].map(([reason, count]) => ({ reason: `rejected_${reason}`, count })),
    candidatesConsidered: candidates.length,
    durations: { redisMs, filteringMs, scoringMs, tierExpansionMs, totalMs },
    ...(timedOut
      ? { unavailableReason: "timeout" as const }
      : candidates.length === 0
        ? { unavailableReason: "no_match" as const }
        : {}),
  };
}

export interface RecordSegmentsResult {
  segmentsWritten: number;
  confidenceChanges: import("../../types/journeyMemory.js").JourneyMemoryConfidenceChange[];
}

/**
 * Writes a run's produced segments (binding contract §5/§6): applies semantic dedup +
 * outcome precedence against the domain's existing records, then lazily enforces the
 * per-domain retention cap. Fails safe -- any Redis error is swallowed and reflected as
 * zero segments written, never thrown up through the run (see service caller in
 * core/engine.ts).
 */
export async function recordJourneySegments(
  store: JourneyMemoryStore | undefined,
  flags: JourneyMemoryFlags,
  segments: JourneyMemorySegment[],
  maxRecordsPerDomain: number,
): Promise<RecordSegmentsResult> {
  if (!flags.enabled || !flags.writeEnabled || !store || segments.length === 0) {
    return { segmentsWritten: 0, confidenceChanges: [] };
  }

  let segmentsWritten = 0;
  const allConfidenceChanges: import("../../types/journeyMemory.js").JourneyMemoryConfidenceChange[] = [];

  try {
    const byDomain = new Map<string, JourneyMemorySegment[]>();
    for (const segment of segments) {
      const domain = segment.provenance.registrableDomain;
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), segment]);
    }

    for (const [domain, domainSegments] of byDomain) {
      let existing = await store.listDomain(domain);
      for (const incoming of domainSegments) {
        const { toWrite, toDelete, confidenceChanges } = applyOutcomePrecedence(incoming, existing);
        for (const id of toDelete) {
          await store.deleteRecord(domain, id);
          existing = existing.filter((r) => r.id !== id);
        }
        for (const record of toWrite) {
          await store.writeRecord(record);
          existing = [...existing.filter((r) => r.id !== record.id), record];
          segmentsWritten += 1;
        }
        allConfidenceChanges.push(...confidenceChanges);
      }

      const toEvict = selectRecordsToEvict(existing, maxRecordsPerDomain);
      for (const id of toEvict) {
        await store.deleteRecord(domain, id);
      }
    }
  } catch {
    // Fail-safe: journey memory write is never allowed to fail the run itself.
    return { segmentsWritten, confidenceChanges: allConfidenceChanges };
  }

  return { segmentsWritten, confidenceChanges: allConfidenceChanges };
}
