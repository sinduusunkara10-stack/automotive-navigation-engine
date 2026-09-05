import { randomUUID } from "node:crypto";

/**
 * A unique identity for this process instance, computed once at module load. process.pid
 * alone is not enough -- a container runtime can reuse PIDs across restarts -- so this
 * pairs the PID with a random token that is guaranteed to differ after any restart
 * (including the OOM-kill-and-restart cycle this identity exists to detect -- see
 * staleDetection.ts and docs/architecture.md "Memory stability").
 */
export const WORKER_ID = `${process.pid}-${randomUUID()}`;
