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

//jscpd:ignore-start
import { eventField, eventString, eventWord, isEventRecord } from "./host-shape.js";
import type { OpenCodeEvent } from "@opencode/client/promise";

//jscpd:ignore-end
/** The host's event union — the source of truth for every name below. */
export type HostEventType = OpenCodeEvent["type"];

/** One host event, narrowed to the shape the host declares for that name. */
export type HostEvent<T extends HostEventType> = Extract<OpenCodeEvent, { type: T }>;

// v2 renamed the ask channel: `question.asked` became `permission.asked`, and the
// payload moved from `properties` to `data`. The RETIRED names have no reader, so
// a vocabulary that lists only what is read is one a reader cannot trust.
export const PERMISSION_ASKED = "permission.asked" satisfies HostEventType;
export const PERMISSION_REPLIED = "permission.replied" satisfies HostEventType;
export const FORM_CREATED = "form.created" satisfies HostEventType;
export const FORM_CANCELLED = "form.cancelled" satisfies HostEventType;

// The turn-ending events, spelled here for the same reason: a lifecycle branch
// that names a session event nobody publishes would be equally invisible.
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
export function isTurnEnding(type: string): boolean {
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
  sessionId: string;
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
  return { askId: data.id, sessionId: data.sessionID };
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
export function getSessionIdFromEvent(event: unknown): string | null {
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
  return sid;
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
 * The two lifecycle words that end a task BADLY rather than successfully.
 *
 * The lifecycle status itself is an OPEN vocabulary — it is whatever the host
 * said, lowercased — so it cannot be an enum, and that means a comparison against
 * these two words is a raw literal in a place that has to know them. So they are
 * named here, once, and every caller asks the question instead of restating the
 * answer. A caller that spells its own copy of this pair is a caller whose idea
 * of "the child died" can drift from everyone else's.
 */
const ENDED_BADLY = ["error", "deleted"] as const;

/** Did this lifecycle status end the task in failure rather than in success? */
export function endedBadly(status: string): boolean {
  return (ENDED_BADLY as readonly string[]).includes(status);
}

const TERMINAL_EVENT_STATUSES = new Set(["idle", "completed", "error", "deleted"]);

// The turn-ending events are named in host-events.ts against the SDK's own union
// — no `includes("delet")` substring guess, which is what a belief that
// "spellings differ across releases" buys: a typo'd name matches nothing and a
// near-miss name matches too much. The sync channel also carries lifecycle state
// in data.info.status, so that remains a terminal signal.
export function isTerminalSessionEvent(event: unknown): boolean {
  const type = eventWord(event, "type");
  if (isTurnEnding(type)) return true;
  if (type === SESSION_DELETED) return true;
  return TERMINAL_EVENT_STATUSES.has(getEventLifecycleStatus(event));
}