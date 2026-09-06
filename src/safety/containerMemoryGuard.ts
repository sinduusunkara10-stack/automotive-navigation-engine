import { checkCgroupMemoryAvailability, type CgroupMemoryAvailability } from "../config/cgroupMemoryDiagnostic.js";

// Generic, brand-agnostic reading of whether this run's container is approaching its own
// memory ceiling, using the same cgroup v2 (falling back to v1) accounting the read-only
// startup diagnostic (cgroupMemoryDiagnostic.ts) already confirmed is readable. See
// docs/architecture.md "Container memory circuit breaker".
//
// Deliberately never throws and never treats missing/unreadable data as a breach: a
// container that doesn't expose cgroup memory files (or a transient read failure) must
// disable this check safely, not fail the task or the service.

export interface ContainerMemoryGuardOptions {
  thresholdFraction: number;
  /** Overrides the cgroup-reported limit when set; see readMemoryCircuitBreakerLimitBytesOverride. */
  limitBytesOverride?: number;
}

export interface ContainerMemoryReading {
  available: boolean;
  version?: "v2" | "v1";
  currentBytes?: number;
  limitBytes?: number;
  thresholdFraction: number;
  thresholdBytes?: number;
  breached: boolean;
}

export function readContainerMemory(
  options: ContainerMemoryGuardOptions,
  availability: CgroupMemoryAvailability = checkCgroupMemoryAvailability(),
): ContainerMemoryReading {
  const notAvailable: ContainerMemoryReading = {
    available: false,
    thresholdFraction: options.thresholdFraction,
    breached: false,
  };

  if (!availability.available || availability.currentBytes === undefined) {
    return { ...notAvailable, version: availability.version };
  }

  const limitBytes = options.limitBytesOverride ?? availability.limitBytes;
  if (limitBytes === undefined || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return { ...notAvailable, version: availability.version };
  }

  const thresholdBytes = limitBytes * options.thresholdFraction;
  return {
    available: true,
    version: availability.version,
    currentBytes: availability.currentBytes,
    limitBytes,
    thresholdFraction: options.thresholdFraction,
    thresholdBytes,
    breached: availability.currentBytes >= thresholdBytes,
  };
}
