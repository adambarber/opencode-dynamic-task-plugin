// src/shared/session-lifecycle.ts
// Session and event boundary (Task 08): typed readers for host events and
// session-API payloads, durable ledger (de)serialization, and the one
// sanctioned PluginInput→client augmentation cast. Pure glue: policy lives
// in the task modules, not here.
//
// Durable state (the ledger, the debug log root) resolves from the
// host-provided project `directory` — never process CWD, which for tests and
// multi-project hosts is somebody else's tree.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RetainedTaskState } from "./task-state.js";

// Host event payloads are untyped JSON at this boundary. isEventRecord is the
// only sanctioned narrowing; field access goes through eventField/eventString
// and never through casts.
export function isEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Total, non-throwing readers into event/session shapes.
export function eventField(event: unknown, ...path: string[]): unknown {
  let current: unknown = event;
  for (const key of path) {
    if (!isEventRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function eventString(event: unknown, path: string[]): string | undefined {
  const value = eventField(event, ...path);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isEventRecord(error) && "message" in error) return String(error["message"]);
  return String(error);
}

export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (isEventRecord(raw) && typeof raw.type === "string") return raw.type.toLowerCase();
  return "";
}

// Session id lives at properties.info.id (host) or properties.sessionID
// (tests); aggregate/top-level spellings are fallbacks. A missing prefix
// means the payload is not a session event.
export function getSessionIdFromEvent(event: unknown): string | null {
  const properties = eventField(event, "properties");
  const sid =
    eventString(properties, ["sessionID"])
    ?? eventString(properties, ["sessionId"])
    ?? eventString(properties, ["info", "id"])
    ?? eventString(event, ["data", "sessionId"])
    ?? eventString(event, ["data", "sessionID"])
    ?? eventString(event, ["data", "info", "id"])
    ?? eventString(event, ["properties", "aggregateID"])
    ?? eventString(event, ["aggregateID"])
    ?? eventString(event, ["id"])
    ?? eventString(event, ["sessionID"]);
  if (!sid || !sid.startsWith("ses_")) return null;
  return sid;
}

// Lifecycle status extraction for every observed event shape: properties
// (host), data.info (sync updates), or type/name keywords as last resort.
// The nested {type:"error"} spelling is host-real and must not be missed —
// a failed child reported as success is the worst possible outcome.
export function getEventLifecycleStatus(event: unknown): string {
  const properties = eventField(event, "properties");
  const infoStatus =
    eventString(properties, ["info", "status"])
    ?? eventString(properties, ["info", "status", "type"])
    ?? eventString(event, ["data", "info", "status"])
    ?? eventString(event, ["data", "info", "status", "type"]);
  if (infoStatus) return normalizeStatus(infoStatus);
  const status =
    eventString(properties, ["status"])
    ?? eventString(properties, ["status", "type"]);
  if (status) return normalizeStatus(status);
  const source = (eventString(event, ["type"]) ?? "") + (eventString(event, ["name"]) ?? "");
  if (source.includes("idle")) return "idle";
  if (source.includes("error")) return "error";
  if (source.includes("delet")) return "deleted";
  return source.includes(".") ? (source.split(".").pop() ?? "").toLowerCase() : source.toLowerCase();
}

const TERMINAL_EVENT_STATUSES = ["idle", "completed", "error", "deleted"];

// Host event type/name spellings differ across releases; the sync channel
// carries the lifecycle state in data.info.status. Terminal iff the derived
// status is one the settlement handler acts on.
export function isTerminalSessionEvent(event: unknown): boolean {
  const type = eventString(event, ["type"]) ?? "";
  if (type === "session.idle" || type === "session.error") return true;
  if (type.includes("delet") || (eventString(event, ["name"]) ?? "").includes("delet")) return true;
  return TERMINAL_EVENT_STATUSES.includes(getEventLifecycleStatus(event));
}

// A task's durable record must be complete or absent: any field the render
// or revive path depends on disqualifies the whole entry. The guard itself
// carries the shape so the load path needs no casts.
interface ValidLedgerEntry {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  lineage: unknown[];
  state: "completed" | "error" | "interrupted";
  startedAt: number;
  retainedAt: number;
  dependsOn?: unknown;
  requestedModel?: unknown;
  abortError?: unknown;
}

function isValidLedgerEntry(value: unknown): value is ValidLedgerEntry {
  if (!isEventRecord(value)) return false;
  const {
    childSessionId,
    parentSessionId,
    agentName,
    description,
    lineage,
    state,
    startedAt,
    retainedAt,
  } = value;
  return (
    typeof childSessionId === "string" && childSessionId.startsWith("ses_")
    && typeof parentSessionId === "string"
    && typeof agentName === "string"
    && typeof description === "string"
    && Array.isArray(lineage)
    && lineage.every((s): s is string => typeof s === "string")
    && (state === "completed" || state === "error" || state === "interrupted")
    && typeof startedAt === "number" && Number.isFinite(startedAt)
    && typeof retainedAt === "number" && Number.isFinite(retainedAt)
  );
}

// v2: non-blocking cutover. Retained kinds are the three terminal states;
// timeout kinds never existed here and v1 ledgers are discarded wholesale.
// File shape: { version, tasks: { [childSessionId]: entry } }.
export const TASK_LEDGER_VERSION = 2;

const FALLBACK_LEDGER_ROOT = join(homedir(), ".local", "share", "opencode-dynamic-task");

// Ledger and debug root resolve from the host-provided project directory —
// the same root as the plugin config file — never process CWD. With no
// directory at all (tests, bare hosts), fall back to a private state dir.
export function resolveTaskLedgerPath(directory: string): string {
  if (directory) return join(directory, ".dynamic-task-ledger.json");
  return join(FALLBACK_LEDGER_ROOT, "ledger.json");
}

export function loadTaskLedger(filePath: string): Map<string, RetainedTaskState> {
  const entries = new Map<string, RetainedTaskState>();
  if (!filePath || !existsSync(filePath)) return entries;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isEventRecord(parsed) || parsed.version !== TASK_LEDGER_VERSION || !isEventRecord(parsed["tasks"])) {
      return entries;
    }
    for (const [key, entry] of Object.entries(parsed["tasks"] as Record<string, unknown>)) {
      if (!isValidLedgerEntry(entry) || !key.startsWith("ses_")) continue;
      // The map key is canonical identity: an entry disagreeing with its key
      // is corrupt, not merely mislabeled.
      if (entry.childSessionId !== key) continue;
      const dependsOn = entry["dependsOn"];
      const requestedModel = entry["requestedModel"];
      const abortError = entry["abortError"];
      // Built in one expression: a hydrated record is complete at birth.
      // Post-construction field assignment would belong to the state machine
      // (task-state), and the lifecycle scanner rightly forbids it here.
      const typed: RetainedTaskState = {
        childSessionId: entry.childSessionId,
        parentSessionId: entry.parentSessionId,
        agentName: entry.agentName,
        description: entry.description,
        lineage: entry.lineage.filter((s): s is string => typeof s === "string"),
        state: entry.state,
        startedAt: entry.startedAt,
        retainedAt: entry.retainedAt,
        ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn.filter((d): d is string => typeof d === "string") } : {}),
        ...(isEventRecord(requestedModel)
          && typeof requestedModel["providerID"] === "string"
          && typeof requestedModel["modelID"] === "string"
          ? { requestedModel: { providerID: requestedModel["providerID"], modelID: requestedModel["modelID"] } }
          : {}),
        ...(typeof abortError === "string" ? { abortError } : {}),
      };
      entries.set(key, typed);
    }
  } catch {
    // ignore
  }
  return entries;
}

// Returns the path written; throws only on fs failure (the caller owns the
// retry decision). Atomic: write tmp, then rename over the target — a crash
// between the two leaves the previous complete ledger, never a truncation.
export function saveTaskLedger(retainedTasks: Map<string, unknown>, filePath: string): string {
  if (!filePath) {
    throw new Error("Task ledger path is required");
  }
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) {
    mkdirSync(dir, { recursive: true });
  }
  const entries = Object.fromEntries(retainedTasks);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ version: TASK_LEDGER_VERSION, tasks: entries }, null, 2));
  renameSync(tmpPath, filePath);
  return filePath;
}

// Parent session resolution: the SDK context field first, then the
// historical spellings, then the ambient variable tests and bare hosts rely on.
// Deliberately not `extends ToolContext`: ToolContext.metadata is a method,
// so this shape is a structural subset.
export interface SessionContext {
  sessionID?: string;
  sessionId?: string;
  session_id?: string;
}

export function resolveParentSessionId(ctx: SessionContext): string | null {
  if (!isEventRecord(ctx)) return null;
  const record = ctx as Record<string, unknown>;
  const session = isEventRecord(record["session"]) ? record["session"] : undefined;
  const candidates: unknown[] = [
    record["sessionID"],
    record["sessionId"],
    record["session_id"],
    session ? session["id"] : undefined,
    record["id"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  const ambient = typeof process !== "undefined" ? process.env.DYNAMIC_TASK_TEST_SESSION_ID : undefined;
  return ambient && ambient.trim().length > 0 ? ambient : null;
}

// Session-create responses arrive wrapped: flat id, body/data envelopes, or
// nested session objects — unwrap known shells recursively, never blindly.
export function validateSessionResult(result: unknown): string | null {
  if (!isEventRecord(result)) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  for (const key of ["body", "data", "result", "session", "output"]) {
    const inner = validateSessionResult(record[key]);
    if (inner) return inner;
  }
  return null;
}

// session.deleted may arrive name-only (no status field): a vanished session
// is a failure, never a clean completion — deletion needs two probes.
export function eventLooksDeleted(event: unknown): boolean {
  const type = eventString(event, ["type"]) ?? "";
  const name = eventString(event, ["name"]) ?? "";
  return type.includes("deleted") || name.includes("deleted");
}
