import { existsSync, readFileSync } from "node:fs";

// Purely diagnostic, read-only startup check for whether this container exposes cgroup
// memory accounting -- this is prerequisite investigation for a possible future memory
// circuit breaker (deliberately NOT implemented here). Logged once at startup by
// src/api/main.ts. Never throws and never affects whether the service starts: an
// unreadable or absent path is reported as "unavailable", not an error.

const CGROUP_V2_CURRENT_PATH = "/sys/fs/cgroup/memory.current";
const CGROUP_V2_MAX_PATH = "/sys/fs/cgroup/memory.max";
const CGROUP_V1_USAGE_PATH = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const CGROUP_V1_LIMIT_PATH = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

export interface CgroupFsAccess {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
}

const defaultFsAccess: CgroupFsAccess = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
};

export interface CgroupMemoryAvailability {
  available: boolean;
  version?: "v2" | "v1";
  currentPath?: string;
  limitPath?: string;
  currentBytes?: number;
  limitBytes?: number;
}

function tryReadBytes(fs: CgroupFsAccess, path: string): number | undefined {
  try {
    const value = Number(fs.readFileSync(path).trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function checkCgroupMemoryAvailability(fs: CgroupFsAccess = defaultFsAccess): CgroupMemoryAvailability {
  try {
    if (fs.existsSync(CGROUP_V2_CURRENT_PATH) && fs.existsSync(CGROUP_V2_MAX_PATH)) {
      return {
        available: true,
        version: "v2",
        currentPath: CGROUP_V2_CURRENT_PATH,
        limitPath: CGROUP_V2_MAX_PATH,
        currentBytes: tryReadBytes(fs, CGROUP_V2_CURRENT_PATH),
        limitBytes: tryReadBytes(fs, CGROUP_V2_MAX_PATH),
      };
    }
    if (fs.existsSync(CGROUP_V1_USAGE_PATH) && fs.existsSync(CGROUP_V1_LIMIT_PATH)) {
      return {
        available: true,
        version: "v1",
        currentPath: CGROUP_V1_USAGE_PATH,
        limitPath: CGROUP_V1_LIMIT_PATH,
        currentBytes: tryReadBytes(fs, CGROUP_V1_USAGE_PATH),
        limitBytes: tryReadBytes(fs, CGROUP_V1_LIMIT_PATH),
      };
    }
  } catch {
    // Falls through to "unavailable" below -- this check must never throw or block startup.
  }
  return { available: false };
}

export function formatCgroupMemoryAvailabilityLogLine(result: CgroupMemoryAvailability): string {
  if (!result.available) {
    return (
      "[startup] cgroup memory diagnostic: unavailable -- neither cgroup v2 " +
      `(${CGROUP_V2_CURRENT_PATH}) nor cgroup v1 (${CGROUP_V1_USAGE_PATH}) memory files were found`
    );
  }
  const currentText = result.currentBytes !== undefined ? `${result.currentBytes} bytes` : "present but unreadable";
  const limitText = result.limitBytes !== undefined ? `${result.limitBytes} bytes` : "present but unreadable";
  return (
    `[startup] cgroup memory diagnostic: available (${result.version}) -- ` +
    `current=${result.currentPath} (${currentText}), limit=${result.limitPath} (${limitText})`
  );
}
