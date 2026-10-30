// src/shared/host-events.ts
// The ONE place a host event name is spelled, and the ONE place a host event's
// payload is read. Both are pinned to the host's own declarations.
//
// Why this file exists: the question gate shipped matching an event the host
// never publishes, with a fixture that invented the missing event, so the suite
// was green against a host that does not exist. A name here is `satisfies
// HostEventType`, which makes "the host never publishes this" a build error.
//
// The readers moved here from session-lifecycle.ts, which is what the header
// above always claimed: a file that NAMES the events while a different file READS
// them is two vocabularies for one host boundary, and the read side is the one
// that decides what happened.

import type { OpenCodeEvent } from "@opencode/client/promise";
import { eventField, eventString, eventWord, isEventRecord } from "./host-shape.js";
import { type SessionId, sessionIdOf } from "./ids.js";

// The boundary re-serves the reading vocabulary (the record guard and the id
// mint), as notify.js re-serves the log vocabulary: a module that reads the
// host should not need three imports to say one thing — “a session fact, read
// off a host value” — and the gate flagged that trio arriving as a unit.
export { isEventRecord } from "./host-shape.js";
export { type SessionId, sessionIdOf } from "./ids.js";

/** The host's event union — the source of truth for every name below. */
export type HostEventType = OpenCodeEvent["type"];

/** One host event, narrowed to the shape the host declares for that name. */
type HostEvent<T extends HostEventType> = Extract<OpenCodeEvent, { type: T }>;

// v2 renamed the ask channel: `question.asked` became `permission.asked`, and the
// payload moved from `properties` to `data`. The RETIRED names have no reader, so
// a vocabulary that lists only what is read is one a reader cannot trust.
export const PERMISSION_ASKED = "permission.asked" satisfies HostEventType;
export const PERMISSION_REPLIED = "permission.replied" satisfies HostEventType;
const FORM_CREATED = "form.created" satisfies HostEventType;
export const FORM_CANCELLED = "form.cancelled" satisfies HostEventType;

// The turn-ending events, spelled here for the same reason: a lifecycle branch
// that names a session event nobody publishes would be equally invisible.
export const SESSION_RETRY_SCHEDULED = "session.retry.scheduled" satisfies HostEventType;
// The host's ONGOING turn-status channel: ephemeral {type: "idle"|"retry"|"busy"}
// events. The retry variant carries attempt/next — the same fact as
// retry.scheduled, delivered while the retry is in flight.
export const SESSION_STATUS = "session.status" satisfies HostEventType;
export const SESSION_IDLE = "session.idle" satisfies HostEventType;
export const SESSION_ERROR = "session.execution.failed" satisfies HostEventType;
export const SESSION_DELETED = "session.deleted" satisfies HostEventType;
export const SESSION_EXECUTION_STARTED = "session.execution.started" satisfies HostEventType;
export const SESSION_EXECUTION_SUCCEEDED = "session.execution.succeeded" satisfies HostEventType;
export const SESSION_EXECUTION_INTERRUPTED = "session.execution.interrupted" satisfies HostEventType;

/** True when the host asked something this plugin settles. */
export function isHostAsked(type: string): boolean {
  return type === PERMISSION_ASKED || type === FORM_CREATED;
}

/** True when the turn ended, one way or the other. */
function isTurnEnding(type: string): boolean {
  return type === SESSION_IDLE || type === SESSION_ERROR;
}

type AskedData = HostEvent<typeof PERMISSION_ASKED>["data"];

function isAskedData(value: unknown): value is AskedData {
  if (!isEventRecord(value)) return false;
  return typeof value.sessionID === "string" && typeof value.id === "string";
}

/** What the gate learns from an ask. */
export interface HostAsk {
  /** The host's own id for the ask — the `requestID` a reply carries. */
  askId: string;
  sessionId: SessionId;
}

/**
 * Read an ask in the host's shape, or null if it is not one.
 *
 * There is no answer to compute: a v2 permission is allow/deny with no options and
 * no labels, so the gate settles it by DENYING (see `question-handling.ts`) rather
 * than by choosing. Both ids are required, because a reply carries both.
 */
export function readHostAsk(event: unknown): HostAsk | null {
  const data = eventField(event, "data");
  if (!isAskedData(data)) return null;
  const sid = sessionIdOf(data.sessionID);
  return sid ? { askId: data.id, sessionId: sid } : null;
}

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
  for (const inner of envelopeShells(result)) return inner;
  // No envelope: the payload is the record itself (a map keyed by session id,
  // or a session record carrying its own id).
  return result;
}

/**
 * The shells the transport may have wrapped a payload in, in the order they are
 * tried. One walk, because the knowledge is one fact: the SDK resolves every
 * call to an envelope and a second shell is possible under some hosts, so a
 * reader that rolls its own loop is a reader that can disagree with the next one
 * about what the shells are.
 */
export function* envelopeShells(record: Record<string, unknown>) {
  for (const key of PAYLOAD_KEYS) {
    const inner = record[key];
    if (inner !== undefined) yield inner;
  }
}

// The settlement kind reader's own vocabulary normalizer: the host spells a
// status as a bare string in one event shape and as {type} in another, and the
// two must not become two different words.
export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (isEventRecord(raw) && typeof raw.type === "string") return raw.type.toLowerCase();
  return "";
}

// Session id lives at data.info.id (host) or data.sessionID
// (tests); aggregate/top-level spellings are fallbacks. A missing prefix
// means the payload is not a session event.
export function getSessionIdFromEvent(event: unknown): SessionId | null {
  const data = eventField(event, "data");
  const sid =
    eventString(data, "sessionID")
    ?? eventString(data, "sessionId")
    ?? eventString(data, "info", "id")
    ?? eventString(event, "data", "sessionId")
    ?? eventString(event, "data", "sessionID")
    ?? eventString(event, "data", "info", "id")
    ?? eventString(event, "data", "aggregateID")
    ?? eventString(event, "aggregateID")
    ?? eventString(event, "id")
    ?? eventString(event, "sessionID");
  if (!sid || !sid.startsWith("ses_")) return null;
  return sessionIdOf(sid) ?? null;
}

// session.deleted may arrive name-only (no status field): a vanished session
// is a failure, never a clean completion — deletion needs two probes.
export function eventLooksDeleted(event: unknown): boolean {
  const type = eventWord(event, "type");
  const name = eventWord(event, "name");
  return type.includes("deleted") || name.includes("deleted");
}

// Lifecycle status extraction for every observed event shape: the event's `data`
// payload (host), data.info (sync updates), or the turn-ending vocabulary named in
// host-events.ts as a last resort.
//
// The turn-ending names are READ FROM isTurnEnding, not matched as substrings. v2
// renamed the failure event to `session.execution.failed`, so an `includes("error")`
// guess missed it and the catch-all returned "failed" — a word `endedBadly` does not
// contain, so a failed child turn settled as COMPLETED and the parent was told the
// work succeeded. Same field bug as 2026-09-12, reached by a rename instead of a typo.
export function getEventLifecycleStatus(event: unknown): string {
  const data = eventField(event, "data");
  const infoStatus =
    eventString(data, "info", "status")
    ?? eventString(data, "info", "status", "type")
    ?? eventString(event, "data", "info", "status")
    ?? eventString(event, "data", "info", "status", "type");
  if (infoStatus) return normalizeStatus(infoStatus);
  const status = eventString(data, "status") ?? eventString(data, "status", "type");
  if (status) return normalizeStatus(status);
  const type = eventWord(event, "type");
  if (type === SESSION_IDLE) return "idle";
  if (isTurnEnding(type)) return "error";
  if (type === SESSION_DELETED) return "deleted";
  // v2's four execution events, NAMED rather than guessed. The fallback below
  // splits the type on `.` and takes the last segment, which for `session.execution.
  // failed` yields "failed" — a word `ENDED_BADLY` does not contain, so a failed child
  // settled as COMPLETED and the parent was told its work succeeded. A guess is what
  // made that reachable, and the fix is to stop guessing a vocabulary the host declares.
  // `SESSION_ERROR` IS the failed execution event (`session.execution.failed`);
  // it is named for its role, which predates v2 splitting these four apart.
  if (type === SESSION_ERROR) return "error";
  if (type === SESSION_EXECUTION_SUCCEEDED) return "completed";
  if (type === SESSION_EXECUTION_INTERRUPTED) return "interrupted";
  if (type === SESSION_EXECUTION_STARTED) return "started";
  const source = type + eventWord(event, "name");
  return source.includes(".") ? (source.split(".").pop() ?? "").toLowerCase() : source.toLowerCase();
}

/**
 * The lifecycle words this plugin interprets, as a closed enum.
 *
 * The host's own vocabulary is OPEN — `getEventLifecycleStatus` answers with
 * whatever the host said, lowercased, and a release can add a word — so the raw
 * word cannot be this type, and pretending otherwise would be a lie the compiler
 * enforces in the wrong direction (every caller forced to handle a value that
 * cannot occur, while a value that CAN occur is spelled `string` and accepted).
 *
 * So the boundary stays open and the READING is closed: `classifyLifecycleStatus`
 * maps the host's word onto one of these once, and everything downstream compares
 * members. An enum rather than a string union for the reason the rest of this
 * plugin uses one: a member compared as a raw literal compiles clean under a
 * rename, and a newly added member falls through to whatever the final `else`
 * was. `unknown` is that fallback made a member, so a word nobody has interpreted
 * is not silently the success answer — which is the failure that settled a failed
 * child as COMPLETED and told the parent its work had succeeded.
 */
export enum LifecycleStatus {
  Idle = "idle",
  Completed = "completed",
  Error = "error",
  Deleted = "deleted",
  Interrupted = "interrupted",
  Started = "started",
  Unknown = "unknown",
}

/** The statuses that end a task at all, as the members the reader checks. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<LifecycleStatus> = new Set([
  LifecycleStatus.Idle,
  LifecycleStatus.Completed,
  LifecycleStatus.Error,
  LifecycleStatus.Deleted,
]);

/** The wire words, as values: what a stored status can be, before it is read. */
const LIFECYCLE_WORDS: readonly string[] = Object.values(LifecycleStatus);

/**
 * Is this string one of the lifecycle words this plugin interprets?
 *
 * A predicate, not a cast, mirroring `isTaskState`: the enum is the vocabulary,
 * and `Object.values` is how the vocabulary is read rather than restated, so a
 * member added to the machine is classified without anyone editing a list.
 */
export function isLifecycleStatus(value: string): value is LifecycleStatus {
  return LIFECYCLE_WORDS.includes(value);
}

/**
 * Read the host's lifecycle word as one of this plugin's closed vocabulary.
 *
 * The ONE place an open host word becomes a closed status, and the only place a
 * wire word is turned into a member: the failure that produced this was a
 * `getEventLifecycleStatus` fallback yielding "failed" — a word `endedBadly` did
 * not contain, so a failed turn settled as completed and the parent was told the
 * work succeeded. A word outside the vocabulary is `unknown`, which is neither
 * terminal nor a bad ending: the safe answer for a status nobody has read yet.
 */
export function classifyLifecycleStatus(raw: string): LifecycleStatus {
  return isLifecycleStatus(raw) ? raw : LifecycleStatus.Unknown;
}

/** Did this lifecycle status end the task in failure rather than in success? */
export function endedBadly(status: LifecycleStatus): boolean {
  return status === LifecycleStatus.Error || status === LifecycleStatus.Deleted;
}

// The turn-ending events are named in host-events.ts against the SDK's own union
// — no `includes("delet")` substring guess, which is what a belief that
// "spellings differ across releases" buys: a typo'd name matches nothing and a
// near-miss name matches too much. The sync channel also carries lifecycle state
// in data.info.status, so that remains a terminal signal.
export function isTerminalSessionEvent(event: unknown): boolean {
  const type = eventWord(event, "type");
  if (isTurnEnding(type)) return true;
  if (type === SESSION_DELETED) return true;
  return TERMINAL_EVENT_STATUSES.has(classifyLifecycleStatus(getEventLifecycleStatus(event)));
}