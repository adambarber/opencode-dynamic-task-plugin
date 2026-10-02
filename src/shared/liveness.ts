// src/shared/liveness.ts
//
// What the host says about a session's turn, in the host's OWN vocabulary.
//
// House rule for this module: anything from the SDK is used through the SDK's
// declared type, never a local re-declaration of it. Both re-declarations that
// used to live here were load-bearing and both were wrong.

import { callHost, type OpaqueHost } from "./client.js";
import { isMessage, messageRoleOf, messageTurnStuck, ASSISTANT_ROLE, readSessionMessages } from "./prompt.js";
import { READ_BOUNDS } from "./execution-bound.js";
import { isPlainRecord } from "./host-shape.js";

// v1 answered "is a turn running" from an in-memory status map that DELETED its
// entry on idle, so absent meant "not running" and had also been misread as "no such
// session". v2 has no such call on the plugin surface at all — and does not need one:
// `SessionMessageAssistant.time.completed` is the durable record of a finished turn,
// in the transcript this module already reads. Absence of a completion on the last
// assistant message IS "the host is still working on it", and unlike the map it
// survives a restart.

/** Our words for a session we track no record of — not the host's. */
export enum UntrackedStatus {
  Busy = "busy",
  Unknown = "unknown",
}

/**
 * The host's own turn word. v2 declares exactly one (`SessionActive = {type:
 * "running"}`), so presence of the word is the whole signal and its absence means no
 * turn is running — which says nothing about existence, because existence is read
 * from `session.get` and never from this.
 */
export type HostTurnWord = "running";

export interface LivenessReading {
  /** The host's turn word when the transcript says the last turn is unfinished. */
  hostTurn: HostTurnWord | undefined;
  /**
   * Did the transcript read answer? Its silence is not evidence, so without this a
   * settled reader cannot tell "no turn running" from "no reply".
   */
  statusAnswered: boolean;
  /** When the child last wrote a message; null when it has written none. */
  lastMessageAt: number | null;
  messageCount: number;
}

/** A turn the server is running: an assistant message with no recorded completion. */
export function hostTurnRunning(reading: LivenessReading): boolean {
  return reading.hostTurn !== undefined;
}

/**
 * A session no store record covers: running, or unknown. There is deliberately no
 * "completed" — a plugin that does not track a session cannot witness its
 * completion, and "no running turn" is the only fact this read can see.
 */
export function statusFromHostTurn(hostTurn: HostTurnWord | undefined): UntrackedStatus {
  return hostTurn === undefined ? UntrackedStatus.Unknown : UntrackedStatus.Busy;
}

/**
 * When the last message finished, or began — an unfinished turn has no completion,
 * so its start is the honest floor. The host returns `{ info, parts }` with the
 * clock on `info`; the flat form is the tolerance `messageRoleOf` already keeps.
 */
function lastMessageAt(messages: unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessage(message)) continue;
    const time = messageTime(message);
    if (typeof time?.completed === "number") return time.completed;
    if (typeof time?.created === "number") return time.created;
  }
  return null;
}

/** Where one message keeps its clock: `info.time`, or the flat `time`. */
function messageTime(message: unknown): { completed?: unknown; created?: unknown } | undefined {
  if (!isPlainRecord(message)) return undefined;
  const info = isPlainRecord(message["info"]) ? message["info"] : undefined;
  const at = isPlainRecord(message["time"]) ? message["time"] : info?.["time"];
  if (!isPlainRecord(at)) return undefined;
  return { completed: at["completed"], created: at["created"] };
}

/**
 * Read a child's liveness. `messages` is the caller's already-read list — task_result
 * needs it for its summary either way, and re-reading would fetch it twice.
 *
 * Tolerant of a failed read on purpose: a transport that did not answer has said
 * nothing about any session, and `statusAnswered` is what lets a caller tell that
 * shrug apart from an answer.
 */
export async function readLiveness(
  host: OpaqueHost,
  childSessionId: string,
  messages?: unknown[],
): Promise<LivenessReading> {
  const read = messages === undefined ? await readSessionMessages(host, childSessionId).catch(() => null) : messages;
  if (read === null) {
    return { hostTurn: undefined, statusAnswered: false, lastMessageAt: null, messageCount: 0 };
  }
  return {
    hostTurn: transcriptTurnRunning(read) ? "running" : undefined,
    statusAnswered: true,
    lastMessageAt: lastMessageAt(read),
    messageCount: read.length,
  };
}

/**
 * Whether the host still HAS this session, asked of the one endpoint whose contract
 * answers it. Three answers because there is no honest two: a session with nothing
 * running and a session that never existed look identical in the status map, which
 * is the whole defect.
 */
export enum SessionExistence {
  Present = "present",
  Missing = "missing",
  Unread = "unread",
}

export interface SessionPresence {
  readonly existence: SessionExistence;
  /** The host's own not-found, when it gave one — its declared type, not a copy. */
  readonly missing?: HostSessionMissing | undefined;
}

/**
 * The name the host's own not-found carries: `SessionGetErrors[404]["name"]`.
 *
 * Exported because it is a value the host and this plugin must agree on, and a
 * test that writes "NotFoundError" by hand is a test that passes on a day the
 * host renames it and fails on no day at all. The fake also needs it at runtime,
 * and it parses it out of the same declaration rather than keeping a copy here.
 */
export const NOT_FOUND_NAME: HostSessionMissing["name"] = "NotFoundError";

/** The status code that same declaration pins: `SessionGetErrors[404]`. */
export const NOT_FOUND_STATUS = 404;

/**
 * The host's own "no such session", narrowed to what we actually compare.
 *
 * v2 has no declared 404 type on the plugin surface — `session.get` REJECTS with a
 * `ClientError` — so the guard checks the two spellings that error carries. Reading
 * both is the same rule as before: trusting one would report every missing session
 * present whenever the host picked the other.
 */
export type HostSessionMissing = Record<string, unknown>;

function isHostSessionMissing(error: unknown): error is HostSessionMissing {
  if (!isPlainRecord(error)) return false;
  if (error["name"] === NOT_FOUND_NAME) return true;
  return error["status"] === NOT_FOUND_STATUS;
}

/**
 * Bounded, because this sits on the reconcile path and an unbounded host call there
 * is a boot that never finishes. v2 has no `throwOnError`: the client rejects on a
 * 404 by itself, so existence is answered by the catch below.
 */
export async function readSessionPresence(host: OpaqueHost, sessionId: string): Promise<SessionPresence> {
  try {
    const bounded = await callHost(host, READ_BOUNDS.presence, (client) => client.session.get({ sessionID: sessionId }), null);
    if (bounded.timedOut) return { existence: SessionExistence.Unread };
    return { existence: SessionExistence.Present };
  } catch (error: unknown) {
    if (isHostSessionMissing(error)) return { existence: SessionExistence.Missing, missing: error };
    return { existence: SessionExistence.Unread };
  }
}

/**
 * The host's own turn word, derived from the transcript: present when the last
 * assistant turn has recorded no completion. `finish` and `error` classify HOW a
 * turn ended; presence of `completed` is simply that it ended.
 */
export function transcriptTurnRunning(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessage(message) || messageRoleOf(message) !== ASSISTANT_ROLE) continue;
    return messageTime(message)?.completed === undefined;
  }
  return false;
}

/**
 * Is a turn running RIGHT NOW? Deliberately not `readLiveness`: a parent-write gate
 * needs this before it spends an attempt, and a failed read is not "busy" — reading
 * transport failure as congestion defers every debt for as long as the channel is
 * down, a silent stall wearing a safety check's name.
 */
export async function hostTurnInFlight(host: OpaqueHost, sessionId: string): Promise<boolean> {
  const messages = await readSessionMessages(host, sessionId, { limit: WEDGE_TAIL_MESSAGES }).catch(() => null);
  return messages === null ? false : transcriptTurnRunning(messages);
}

/**
 * Has this parent stopped answering? A turn the host opened and never closed —
 * distinct from busy because a wedged parent holds its write forever, creating no
 * message and logging no line, and the status map cannot see it either since a
 * wedge has no run. Only the transcript can: an assistant message whose
 * `time.completed` is absent.
 */
export async function parentTurnStuck(host: OpaqueHost, sessionId: string): Promise<boolean> {
  const list = await readSessionMessages(host, sessionId, { limit: WEDGE_TAIL_MESSAGES }).catch(() => null);
  if (list === null) return false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!isMessage(message) || messageRoleOf(message) !== ASSISTANT_ROLE) continue;
    return messageTurnStuck(message);
  }
  return false;
}

// One message is the answer; a few are read so a reordered or partially returned tail
// cannot hide the un-terminated turn behind a later one. Bounded at the HOST.
const WEDGE_TAIL_MESSAGES = 5;

/**
 * The transcript's last assistant turn completed on its own, or the host gave up.
 *
 * Both words come from ONE record — `SessionMessageAssistant.time.completed` — and
 * `statusAnswered` says whether we were shown it at all. There is no third answer:
 * a host that refuses to say whether a turn is running leaves the child alone rather
 * than inventing the errors this pass exists to prevent.
 */