import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEBUG_DIR = ".dynamic-task-logs";
// Same scoping rule as the ledger: logs land in the project the host gave
// the plugin, not the process CWD. initPluginState sets this once per boot;
// the default keeps the pure path helper usable without boot.
// Tenet 9: process-global by design, with the true residual stated plainly —
// a second init reroutes ALL instances' subsequent debug lines into the
// newest project dir (misrouting, not collision: session ids never collide,
// directory paths do). Accepted because debug output is best-effort and off
// by default with single-instance the norm; per-instance scoping would
// thread a root through ~20 call sites in 5 files for diagnostics-only gain.
let debugRoot = DEBUG_DIR;
// Payload cap: at most MAX_DEBUG_FIELDS fields ever leave the process.
const MAX_DEBUG_FIELDS = 4;

// Read at call time, never at import: hosts and tests set env after load,
// like every other knob. No length cap — the cap above bounds emitted
// FIELDS, not the operator's blocklist (truncating it would silently unblock).
function currentBlocklist(): string[] {
  const raw = process.env.DYNAMIC_TASK_DEBUG_BLOCKLIST ?? "prompt,fullPrompt";
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function configureDebugRoot(directory: string): void {
  debugRoot = directory ? path.join(directory, DEBUG_DIR) : DEBUG_DIR;
}

export function getDebugLogPath(parentSessionId: string, childSessionId: string): string {
  // Sanitize to prevent path traversal via malicious session IDs
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(debugRoot, `parent-${sanitize(parentSessionId)}__child-${sanitize(childSessionId)}.log`);
}

/**
 * The one file write this plugin makes, for every line it keeps.
 *
 * v2 took the host's log sink away, so `safeLog` had to keep its own line — and
 * the first version of that opened a second `appendFileSync` in `notify.ts`,
 * which the write-funnel gate correctly refused. A second writer is two places
 * to learn that a failing write must be swallowed and two places to forget.
 */
export function appendLogLine(targetPath: string, line: string): void {
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    appendFileSync(targetPath, `${line}\n`, "utf8");
  } catch {
    // A failing fs write (permissions, disk) must never break the caller —
    // observability is never worth losing the work it was observing.
  }
}

export function safeDebugPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const blocklist = currentBlocklist();
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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    eventName,
    ...safeDebugPayload(payload),
  });
  appendLogLine(getDebugLogPath(parentSessionId, childSessionId), line);
}
