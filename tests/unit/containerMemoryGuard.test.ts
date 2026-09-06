import { test } from "node:test";
import assert from "node:assert/strict";

import { readContainerMemory } from "../../src/safety/containerMemoryGuard.js";
import type { CgroupMemoryAvailability } from "../../src/config/cgroupMemoryDiagnostic.js";

test("readContainerMemory reports unavailable, never breached, when cgroup memory isn't readable", () => {
  const unavailable: CgroupMemoryAvailability = { available: false };
  const reading = readContainerMemory({ thresholdFraction: 0.75 }, unavailable);
  assert.equal(reading.available, false);
  assert.equal(reading.breached, false);
});

test("readContainerMemory breaches once current usage crosses thresholdFraction of the limit", () => {
  const availability: CgroupMemoryAvailability = {
    available: true,
    version: "v2",
    currentBytes: 400_000_000,
    limitBytes: 500_000_000,
  };
  const belowThreshold = readContainerMemory({ thresholdFraction: 0.9 }, availability);
  assert.equal(belowThreshold.available, true);
  assert.equal(belowThreshold.breached, false, "400M/500M = 0.8, below a 0.9 threshold");

  const atThreshold = readContainerMemory({ thresholdFraction: 0.75 }, availability);
  assert.equal(atThreshold.breached, true, "400M/500M = 0.8, at or above a 0.75 threshold");
  assert.equal(atThreshold.thresholdBytes, 375_000_000);
});

test("readContainerMemory prefers limitBytesOverride over the cgroup-reported limit", () => {
  const availability: CgroupMemoryAvailability = {
    available: true,
    version: "v1",
    currentBytes: 100,
    limitBytes: 999_999_999,
  };
  // The cgroup-reported limit would never breach at this current usage; a tiny override
  // forces an immediate breach regardless of what cgroup itself reports.
  const reading = readContainerMemory({ thresholdFraction: 0.75, limitBytesOverride: 100 }, availability);
  assert.equal(reading.limitBytes, 100);
  assert.equal(reading.breached, true);
});

test("readContainerMemory never breaches when the limit is missing or non-positive", () => {
  const noLimit: CgroupMemoryAvailability = { available: true, version: "v1", currentBytes: 100 };
  assert.equal(readContainerMemory({ thresholdFraction: 0.75 }, noLimit).breached, false);

  const zeroOverride: CgroupMemoryAvailability = { available: true, version: "v1", currentBytes: 100, limitBytes: 200 };
  assert.equal(
    readContainerMemory({ thresholdFraction: 0.75, limitBytesOverride: 0 }, zeroOverride).breached,
    false,
  );
});
