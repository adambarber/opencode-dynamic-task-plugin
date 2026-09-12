// ─── unknown-event field access ────────────────────────────────────
// Events arrive untyped (SDK union members plus sync envelopes and the
// question API). These read them without casts: non-records yield
// undefined, never throw.

export function isEventRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function eventField(root: unknown, ...path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isEventRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function eventString(root: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    const value = eventField(root, ...path);
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

// The one way to read an error's message from `unknown`: Error instances
// first, message-bearing records next (SDK failures are sometimes plain
// objects), string fallback last. Never throws, never casts.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const msg = eventField(error, "message");
  if (typeof msg === "string") return msg;
  if (msg !== undefined && msg !== null) return String(msg);
  return String(error);
}

export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.trim().toLowerCase();
  if (raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return (raw as { type: string }).type.trim().toLowerCase();
  }
  return "";
}

export function getSessionIdFromEvent(event: unknown): string | null {
  return eventString(
    event,
    ["properties", "sessionID"],
    ["properties", "sessionId"],
    ["properties", "id"],
    ["data", "sessionID"],
    ["data", "sessionId"],
    ["data", "id"],
    ["aggregateID"],
    ["sessionID"],
    ["sessionId"],
    ["subject"],
    ["resource", "id"],
    ["id"],
  );
}

export function getEventLifecycleStatus(event: unknown): string {
  // session.error carries its payload in properties.error and has NO status
  // field (SDK 1.18 EventSessionError). An error-typed event is an error
  // regardless of payload shape — otherwise a provider failure (429/auth)
  // reads as "" and is misreported as a clean completion (field log
  // 2026-09-11T19:30:00.485Z). Checked before the status candidates so a
  // status-bearing non-error event still resolves normally.
  const type = eventString(event, ["type"]);
  const name = eventString(event, ["name"]);
  if (type === "session.error" || name === "session.error" || name === "session.error.1") {
    return "error";
  }
  const candidates = [
    ["properties", "status"],
    ["data", "info", "status"],
    ["data", "status"],
    ["info", "status"],
    ["status"],
    ["body", "status"],
    ["body", "info", "status"],
    ["properties", "info", "status"],
  ];
  for (const path of candidates) {
    const normalized = normalizeStatus(eventField(event, ...path));
    if (normalized) return normalized;
  }
  return "";
}

const TERMINAL_STATUSES = ["idle", "completed", "error", "deleted"];

export function isTerminalSessionEvent(event: unknown): boolean {
  const eventType = eventString(event, ["type"]) ?? "";
  const eventName = eventString(event, ["name"]) ?? "";
  const status = getEventLifecycleStatus(event);

  // Pattern 1: sync events with session.updated/deleted names
  if (eventType === "sync") {
    if (eventName === "session.deleted.1" || eventName === "session.deleted") {
      return true;
    }
    if (
      (eventName === "session.updated.1" || eventName === "session.updated") &&
      TERMINAL_STATUSES.includes(status)
    ) {
      return true;
    }
  }

  // Pattern 2: direct event types (session.idle, session.error, etc.)
  if (TERMINAL_STATUSES.some((s) => eventType === `session.${s}`)) {
    return true;
  }

  // Pattern 3: session.status events with terminal status payload
  if (eventType === "session.status" && TERMINAL_STATUSES.includes(status)) {
    return true;
  }

  // Pattern 4: any event with a terminal status in properties (broad catch-all)
  if (status && TERMINAL_STATUSES.includes(status) && getSessionIdFromEvent(event)) {
    return true;
  }

  return false;
}

const raw = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
const parsed = Number(raw);
export const MAX_CONCURRENT_TASKS = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;

// --- Task ledger persistence (atomic JSON file, Task 06) ---
// Versioned envelope of full retained-task records keyed by child session
// id. Replaces the inverted description-keyed ID map: crash recovery reads
// what was actually retained. Unknown versions and malformed entries are
// dropped — a corrupt ledger starts empty, never crashes boot.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RetainedTaskState } from "./task-state.js";

const TASK_LEDGER_PATH = ".dynamic-task-ledger.json";
const TASK_LEDGER_VERSION = 1;

const RETAINED_STATES: readonly string[] = [
  "timed_out_retained",
  "completed",
  "completed_after_timeout",
  "error",
  "interrupted",
];

function isValidLedgerEntry(value: unknown): value is RetainedTaskState {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.childSessionId === "string" && entry.childSessionId.length > 0 &&
    typeof entry.parentSessionId === "string" &&
    typeof entry.agentName === "string" &&
    typeof entry.description === "string" &&
    Array.isArray(entry.lineage) &&
    typeof entry.state === "string" && RETAINED_STATES.includes(entry.state) &&
    typeof entry.isBackground === "boolean" &&
    typeof entry.startedAt === "number" &&
    typeof entry.retainedAt === "number" &&
    typeof entry.timeoutNotified === "boolean" &&
    typeof entry.completed === "boolean"
  );
}

// The ledger lives with the project it tracks — the same directory the host
// hands the plugin (where .opencode/ config lives), never the process CWD.
// Requiring the argument (no default) makes accidental CWD writes a
// compile error for every future caller; the empty-directory fallback
// exists only for hosts that omit `directory` entirely.
export function resolveTaskLedgerPath(directory: string): string {
  return directory ? join(directory, TASK_LEDGER_PATH) : TASK_LEDGER_PATH;
}

export function loadTaskLedger(filePath: string): Map<string, RetainedTaskState> {
  const map = new Map<string, RetainedTaskState>();
  if (!existsSync(filePath)) return map;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object") return map;
    if (data.version !== TASK_LEDGER_VERSION) return map;
    if (!data.tasks || typeof data.tasks !== "object") return map;
    for (const [id, entry] of Object.entries(data.tasks)) {
      if (typeof id === "string" && id.length > 0 && isValidLedgerEntry(entry)) {
        map.set(id, entry);
      }
    }
  } catch { /* corrupt ledger starts empty */ }
  return map;
}

export function saveTaskLedger(map: Map<string, RetainedTaskState>, filePath: string): void {
  const tasks: Record<string, RetainedTaskState> = {};
  for (const [id, entry] of map) {
    tasks[id] = entry;
  }
  // Atomic write: temp file plus rename survives a mid-write crash.
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: TASK_LEDGER_VERSION, tasks }, null, 2));
  renameSync(tmp, filePath);
}
