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
import { dirname, join } from "node:path";
import type { OpenCodeClient } from "./client.js";
import type { RetainedTaskState, ActiveTaskState, TaskRecordBase, TaskState } from "./task-state.js";
import { TASK_STATES } from "./task-state.js";
import { NOTIFY_KINDS, type PendingDelivery } from "./notify.js";
import { eventField, eventString, isEventRecord } from "./host-shape.js";
import { SESSION_DELETED, isTurnEnding } from "./host-events.js";

// Host event payloads are untyped JSON at this boundary; the total readers that
// narrow them live in host-shape.ts, the bottom of the shape layer.

// The names the host puts a payload under once the transport envelope is
// stripped. `data` is the SDK's own (the client resolves to { data, request,
// response } by default), the rest are route-specific envelopes older hosts
// and the plugin's own tests have both been seen to use.
const PAYLOAD_KEYS = ["data", "body", "agents", "result", "session", "output"] as const;

/**
 * What the host actually returned, with the transport envelope removed.
 *
 * The SDK client resolves every call to `{ data, request, response }` — its
 * `responseStyle` default is "fields", not "data" — so a reader that looks for
 * a field at the top level is reading a field that is one level too high, and
 * it fails by finding nothing rather than by throwing. That is the worst
 * failure mode available here: a status read that silently answers "no session"
 * for a child that is working. Every host read unwraps through this one
 * function, so the envelope is knowledge this module owns.
 */
export function hostPayload(result: unknown): unknown {
  if (!isEventRecord(result)) return result;
  for (const key of PAYLOAD_KEYS) {
    const inner = result[key];
    if (inner !== undefined) return inner;
  }
  // No envelope: the payload is the record itself (a map keyed by session id,
  // or a session record carrying its own id).
  return result;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isEventRecord(error) && "message" in error) return String(error["message"]);
  return String(error);
}

// The settlement kind reader's own vocabulary normalizer: the host spells a
// status as a bare string in one event shape and as {type} in another, and the
// two must not become two different words.
export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (isEventRecord(raw) && typeof raw.type === "string") return raw.type.toLowerCase();
  return "";
}

// The ONE child-abort site. Tenet 9 keeps the await at the call site — a steer
// must abort exactly where its claim requires, an interrupt exactly where its
// claim sits — so the funnel takes the ordering-preserving shape: it performs
// the call and hands back what the failure MEANS, never what to do about it.
//
// Two meanings, and they are the whole reason this is one funnel: a "not
// found" child is dead (settle/report it), while any other transport failure
// may never have reached the server, so the turn may still be running and a
// caller that treats it as a kill replaces a live turn instead of stopping it.
export interface AbortOutcome {
  serverGone: boolean;
  transportError: string | undefined;
}

export function abortSession(client: OpenCodeClient, sessionId: string): Promise<AbortOutcome> {
  return client.session
    .abort({ path: { id: sessionId } })
    .then((): AbortOutcome => ({ serverGone: false, transportError: undefined }))
    .catch((error: unknown): AbortOutcome => {
      const message = errorMessage(error);
      return message.includes("not found")
        ? { serverGone: true, transportError: undefined }
        : { serverGone: false, transportError: message };
    });
}

// Session id lives at properties.info.id (host) or properties.sessionID
// (tests); aggregate/top-level spellings are fallbacks. A missing prefix
// means the payload is not a session event.
export function getSessionIdFromEvent(event: unknown): string | null {
  const properties = eventField(event, "properties");
  const sid =
    eventString(properties, "sessionID")
    ?? eventString(properties, "sessionId")
    ?? eventString(properties, "info", "id")
    ?? eventString(event, "data", "sessionId")
    ?? eventString(event, "data", "sessionID")
    ?? eventString(event, "data", "info", "id")
    ?? eventString(event, "properties", "aggregateID")
    ?? eventString(event, "aggregateID")
    ?? eventString(event, "id")
    ?? eventString(event, "sessionID");
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
    eventString(properties, "info", "status")
    ?? eventString(properties, "info", "status", "type")
    ?? eventString(event, "data", "info", "status")
    ?? eventString(event, "data", "info", "status", "type");
  if (infoStatus) return normalizeStatus(infoStatus);
  const status =
    eventString(properties, "status")
    ?? eventString(properties, "status", "type");
  if (status) return normalizeStatus(status);
  const source = (eventString(event, "type") ?? "") + (eventString(event, "name") ?? "");
  if (source.includes("idle")) return "idle";
  if (source.includes("error")) return "error";
  if (source.includes("delet")) return "deleted";
  return source.includes(".") ? (source.split(".").pop() ?? "").toLowerCase() : source.toLowerCase();
}

const TERMINAL_EVENT_STATUSES = ["idle", "completed", "error", "deleted"];

// The turn-ending events are named in host-events.ts against the SDK's own union
// — no `includes("delet")` substring guess, which is what a belief that
// "spellings differ across releases" buys: a typo'd name matches nothing and a
// near-miss name matches too much. The sync channel also carries lifecycle state
// in data.info.status, so that remains a terminal signal.
export function isTerminalSessionEvent(event: unknown): boolean {
  const type = eventString(event, "type") ?? "";
  if (isTurnEnding(type)) return true;
  if (type === SESSION_DELETED) return true;
  return TERMINAL_EVENT_STATUSES.includes(getEventLifecycleStatus(event));
}

// A task's durable record must be complete or absent: any field the render
// or revive path depends on disqualifies the whole entry. The guard itself
// carries the shape so the load path needs no casts. One entry type serves both
// durable halves (running and settled) — they differ in which state is legal
// and which clock must be there, not in the identity and routing fields, and
// two nearly-identical guards would be two places for them to drift.
interface ValidLedgerEntry {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  lineage: unknown[];
  state: TaskState;
  startedAt: number;
  retainedAt?: unknown;
  dependsOn?: unknown;
  dependsOnSettled?: unknown;
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
  } = value;
  return (
    typeof childSessionId === "string" && childSessionId.startsWith("ses_")
    && typeof parentSessionId === "string"
    && typeof agentName === "string"
    && typeof description === "string"
    && Array.isArray(lineage)
    && lineage.every((s): s is string => typeof s === "string")
    && TASK_STATES.includes(state as TaskState)
    && typeof startedAt === "number" && Number.isFinite(startedAt)
  );
}

// A settled record additionally carries the clock that ordered it. A running
// one must NOT: `retainedAt` on an active entry would mean nothing.
function isValidRetainedEntry(value: unknown): value is ValidLedgerEntry & { state: Exclude<RetainedTaskState["state"], "active">; retainedAt: number } {
  return isValidLedgerEntry(value)
    && value.state !== "active"
    && typeof value.retainedAt === "number"
    && Number.isFinite(value.retainedAt);
}

// v3: durable delivery. v2 held settled records only, so a crash between
// settling and telling the parent left a `completed` with no notice and no
// evidence one was owed; `pending` is that evidence, written before each dial.
// Retained kinds are the three terminal states. Every other version is
// discarded wholesale — a partially-restored past reads as history, and is worse
// than a clean boot.
// File shape: { version, tasks: { [childSessionId]: entry }, pending: [owed write] }.
export const TASK_LEDGER_VERSION = 3;

/** The whole durable file, as the one dance sees it. */
export interface TaskLedgerFile {
  retained: Map<string, RetainedTaskState>;
  active: Map<string, ActiveTaskState>;
  pending: PendingDelivery[];
}

const FALLBACK_LEDGER_ROOT = join(homedir(), ".local", "share", "opencode-dynamic-task");

// Ledger and debug root resolve from the host-provided project directory —
// the same root as the plugin config file — never process CWD. With no
// directory at all (tests, bare hosts), fall back to a private state dir.
export function resolveTaskLedgerPath(directory: string): string {
  if (directory) return join(directory, ".dynamic-task-ledger.json");
  return join(FALLBACK_LEDGER_ROOT, "ledger.json");
}

// An owed write is all-or-nothing: the boot must be able to deliver it exactly,
// so a missing parent, an empty text, an unknown kind, or a non-finite attempt
// count disqualifies the whole entry. Half an entry would dial a message nobody
// can account for.
function isPendingDelivery(value: unknown): value is PendingDelivery {
  if (!isEventRecord(value)) return false;
  const { parentSessionId, childSessionId, kind, text, attempts } = value;
  return (
    typeof parentSessionId === "string" && parentSessionId.length > 0
    && typeof childSessionId === "string" && childSessionId.startsWith("ses_")
    && typeof kind === "string" && NOTIFY_KINDS.some((known) => known === kind)
    && typeof text === "string" && text.length > 0
    && typeof attempts === "number" && Number.isFinite(attempts)
  );
}

// The identity, routing and admission facts both durable halves carry. Built in
// one expression: a hydrated record is complete at birth. Post-construction
// field assignment would belong to the state machine (task-state), and the
// lifecycle scanner rightly forbids it here.
function hydratedBase(entry: ValidLedgerEntry): TaskRecordBase {
  const dependsOn = entry.dependsOn;
  const dependsOnSettled = entry.dependsOnSettled;
  const requestedModel = entry.requestedModel;
  return {
    childSessionId: entry.childSessionId,
    parentSessionId: entry.parentSessionId,
    agentName: entry.agentName,
    description: entry.description,
    lineage: entry.lineage.filter((s): s is string => typeof s === "string"),
    startedAt: entry.startedAt,
    ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn.filter((d): d is string => typeof d === "string") } : {}),
    ...(Array.isArray(dependsOnSettled) ? { dependsOnSettled: dependsOnSettled.filter((d): d is string => typeof d === "string") } : {}),
    ...(isEventRecord(requestedModel)
      && typeof requestedModel["providerID"] === "string"
      && typeof requestedModel["modelID"] === "string"
      ? { requestedModel: { providerID: requestedModel["providerID"], modelID: requestedModel["modelID"] } }
      : {}),
  };
}

// The durable half of a running task. The advisory fields are dropped on the way
// out and are never expected back: a mid-flight notice and an activity
// heartbeat belong to the process that observed them, and turn attribution
// belongs to in-flight events that died with it. A fresh boot that inherited any
// of them would be trusting a claim it cannot verify — and would re-persist a
// heartbeat on every host event, putting a file write in the event head.
export function durableActiveTask(record: ActiveTaskState): ActiveTaskState {
  const {
    lastNotice: _notice,
    lastActivityAt: _activity,
    turnLiveAt: _turnLive,
    replacedAt: _replaced,
    ...core
  } = record;
  return { ...core, state: "active" };
}

export function loadTaskLedger(filePath: string): { retained: Map<string, RetainedTaskState>; active: Map<string, ActiveTaskState>; pending: PendingDelivery[] } {
  const retained = new Map<string, RetainedTaskState>();
  const active = new Map<string, ActiveTaskState>();
  const pending: PendingDelivery[] = [];
  if (!filePath || !existsSync(filePath)) return { retained, active, pending };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isEventRecord(parsed) || parsed.version !== TASK_LEDGER_VERSION || !isEventRecord(parsed["tasks"])) {
      return { retained, active, pending };
    }
    if (Array.isArray(parsed["pending"])) {
      for (const entry of parsed["pending"]) {
        if (isPendingDelivery(entry)) pending.push(entry);
      }
    }
    if (isEventRecord(parsed["active"])) {
      for (const [key, entry] of Object.entries(parsed["active"])) {
        if (!isValidLedgerEntry(entry) || entry.state !== "active" || entry.childSessionId !== key) continue;
        active.set(key, { ...hydratedBase(entry), state: "active" });
      }
    }
    for (const [key, entry] of Object.entries(parsed["tasks"] as Record<string, unknown>)) {
      if (!isValidRetainedEntry(entry) || !key.startsWith("ses_")) continue;
      // The map key is canonical identity: an entry disagreeing with its key
      // is corrupt, not merely mislabeled.
      if (entry.childSessionId !== key) continue;
      const abortError = entry["abortError"];
      retained.set(key, {
        ...hydratedBase(entry),
        state: entry.state,
        retainedAt: entry.retainedAt,
        ...(typeof abortError === "string" ? { abortError } : {}),
      });
    }
  } catch {
    // ignore
  }
  return { retained, active, pending };
}

// Returns the path written; throws only on fs failure (the caller owns the
// retry decision). Atomic: write tmp, then rename over the target — a crash
// between the two leaves the previous complete ledger, never a truncation.
export function saveTaskLedger(ledger: TaskLedgerFile, filePath: string): string {
  if (!filePath) {
    throw new Error("Task ledger path is required");
  }
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        version: TASK_LEDGER_VERSION,
        tasks: Object.fromEntries(ledger.retained),
        // Shaped here, at the ledger boundary: the one place that knows which
        // half of a live record is durable.
        active: Object.fromEntries([...ledger.active].map(([id, record]) => [id, durableActiveTask(record)])),
        pending: ledger.pending,
      },
      null,
      2,
    ),
  );
  renameSync(tmpPath, filePath);
  return filePath;
}

// Parent session resolution: the SDK context field first, then the
// historical spellings. Deliberately not `extends ToolContext`: ToolContext.metadata is a method,
// so this shape is a structural subset. No ambient fallback: a stray env var
// must never route root-session prompts to a phantom parent — callers that
// need an injected identity pass it in the context.
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
  return null;
}

// Session-create responses arrive wrapped in the transport envelope and, under
// some hosts, a second session envelope — unwrap known shells recursively,
// never blindly.
export function validateSessionResult(result: unknown): string | null {
  if (!isEventRecord(result)) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  for (const key of PAYLOAD_KEYS) {
    const inner = validateSessionResult(record[key]);
    if (inner) return inner;
  }
  return null;
}

// session.deleted may arrive name-only (no status field): a vanished session
// is a failure, never a clean completion — deletion needs two probes.
export function eventLooksDeleted(event: unknown): boolean {
  const type = eventString(event, "type") ?? "";
  const name = eventString(event, "name") ?? "";
  return type.includes("deleted") || name.includes("deleted");
}
