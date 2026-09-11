export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.trim().toLowerCase();
  if (raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return (raw as { type: string }).type.trim().toLowerCase();
  }
  return "";
}

export function getSessionIdFromEvent(event: any): string | null {
  const candidates = [
    event?.properties?.sessionID,
    event?.properties?.sessionId,
    event?.properties?.id,
    event?.data?.sessionID,
    event?.data?.sessionId,
    event?.data?.id,
    event?.aggregateID,
    event?.sessionID,
    event?.sessionId,
    event?.subject,
    event?.resource?.id,
    event?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  return null;
}

export function getEventLifecycleStatus(event: any): string {
  const candidates = [
    event?.properties?.status,
    event?.data?.info?.status,
    event?.data?.status,
    event?.info?.status,
    event?.status,
    event?.body?.status,
    event?.body?.info?.status,
    event?.properties?.info?.status,
  ];
  for (const c of candidates) {
    const normalized = normalizeStatus(c);
    if (normalized) return normalized;
  }
  return "";
}

const TERMINAL_STATUSES = ["idle", "completed", "error", "deleted"];

export function isTerminalSessionEvent(event: any): boolean {
  const eventType = event?.type;
  const eventName = event?.name;
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
