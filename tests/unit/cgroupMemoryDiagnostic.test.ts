import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkCgroupMemoryAvailability,
  formatCgroupMemoryAvailabilityLogLine,
  type CgroupFsAccess,
} from "../../src/config/cgroupMemoryDiagnostic.js";

function fakeFs(files: Record<string, string>): CgroupFsAccess {
  const map = new Map(Object.entries(files));
  return {
    existsSync: (path) => map.has(path),
    readFileSync: (path) => {
      const content = map.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
  };
}

test("checkCgroupMemoryAvailability detects v2, falls back to v1, and reports unavailable safely -- never throwing", () => {
  const v2 = checkCgroupMemoryAvailability(
    fakeFs({ "/sys/fs/cgroup/memory.current": "104857600", "/sys/fs/cgroup/memory.max": "536870912" }),
  );
  assert.equal(v2.available, true);
  assert.equal(v2.version, "v2");
  assert.equal(v2.currentBytes, 104857600);
  assert.equal(v2.limitBytes, 536870912);
  assert.match(formatCgroupMemoryAvailabilityLogLine(v2), /available \(v2\)/);

  const v1 = checkCgroupMemoryAvailability(
    fakeFs({
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "604151808",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    }),
  );
  assert.equal(v1.available, true);
  assert.equal(v1.version, "v1");
  assert.equal(v1.currentBytes, 604151808);
  assert.match(formatCgroupMemoryAvailabilityLogLine(v1), /available \(v1\)/);

  const none = checkCgroupMemoryAvailability(fakeFs({}));
  assert.equal(none.available, false);
  assert.match(formatCgroupMemoryAvailabilityLogLine(none), /unavailable/);

  const unreadable = checkCgroupMemoryAvailability({
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(unreadable.available, true, "an existing-but-unreadable path is still reported as available");
  assert.equal(unreadable.currentBytes, undefined);
  assert.match(formatCgroupMemoryAvailabilityLogLine(unreadable), /present but unreadable/);
});
