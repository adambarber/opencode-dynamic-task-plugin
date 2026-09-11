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

export function loadTaskLedger(filePath: string = TASK_LEDGER_PATH): Map<string, RetainedTaskState> {
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

export function saveTaskLedger(map: Map<string, RetainedTaskState>, filePath: string = TASK_LEDGER_PATH): void {
  const tasks: Record<string, RetainedTaskState> = {};
  for (const [id, entry] of map) {
    tasks[id] = entry;
  }
  // Atomic write: temp file plus rename survives a mid-write crash.
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: TASK_LEDGER_VERSION, tasks }, null, 2));
  renameSync(tmp, filePath);
}
