import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEBUG_DIR = ".dynamic-task-logs";
// Same scoping rule as the ledger: logs land in the project the host gave
// the plugin, not the process CWD. initPluginState sets this once per boot;
// the default keeps the pure path helper usable without boot.
// Tenet 9: process-global by design. Debug output is best-effort and off by
// default; log paths embed server-unique session ids, so a second init
// cannot collide — threading a root through every call site buys no safety.
let debugRoot = DEBUG_DIR;
const DEFAULT_DEBUG_BLOCKLIST = (process.env.DYNAMIC_TASK_DEBUG_BLOCKLIST ?? "prompt,fullPrompt").split(",").slice(0, 4);
const MAX_DEBUG_FIELDS = 4;

export function configureDebugRoot(directory: string): void {
  debugRoot = directory ? path.join(directory, DEBUG_DIR) : DEBUG_DIR;
}

export function getDebugLogPath(parentSessionId: string, childSessionId: string): string {
  // Sanitize to prevent path traversal via malicious session IDs
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(debugRoot, `parent-${sanitize(parentSessionId)}__child-${sanitize(childSessionId)}.log`);
}

export function safeDebugPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const blocklist = DEFAULT_DEBUG_BLOCKLIST;
  const clone: Record<string, unknown> = {};
  const keys = Object.keys(payload).slice(0, MAX_DEBUG_FIELDS);
  for (const key of keys) {
    if (!blocklist.includes(key)) {
      clone[key] = payload[key];
    }
  }
  return clone;
}

export function debugLog(parentSessionId: string, childSessionId: string, eventName: string, payload: Record<string, unknown> = {}): void {
  if (process.env.DYNAMIC_TASK_DEBUG !== "1") return;
  // Best-effort: a failing fs write (permissions, disk) must never break the
  // event handler that calls it — debug output is never worth a dropped event.
  try {
    mkdirSync(debugRoot, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      eventName,
      ...safeDebugPayload(payload),
    });
    appendFileSync(getDebugLogPath(parentSessionId, childSessionId), `${line}\n`, "utf8");
  } catch {
    // debug logging degrades to silence
  }
}
