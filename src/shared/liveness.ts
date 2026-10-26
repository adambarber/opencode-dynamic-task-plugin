// src/shared/liveness.ts
//
// What the host says about a session's turn, in the host's OWN vocabulary.
//
// House rule for this module: anything from the SDK is used through the SDK's
// declared type, never a local re-declaration of it. Both re-declarations that
// used to live here were load-bearing and both were wrong.

import type { Session } from "@opencode/schema/session";
import { callHost, type OpaqueHost } from "./client.js";
import { READ_BOUNDS } from "./execution-bound.js";
import { includesWord, isPlainRecord } from "./host-shape.js";
import { isMessage, readSessionMessages } from "./prompt.js";

/** The host's own session object, by its declared type — never a local copy of it. */
type SessionInfo = Session.Info;

// v1 answered "is a turn running" from an in-memory status map that DELETED its
// entry on idle, so absent meant "not running" and had also been misread as "no such
// session". v2 has no such map. What it has instead is a TURN record on the session
// itself: `Session.Info.outcome` is documented as the outcome of the last COMPLETED
// execution, recorded at `time.idle` and absent until a run reaches a terminal
// transition. So absence of an outcome is the turn-level "no turn has finished".
//
// The transcript cannot answer this, and the version of this module that said it
// could settled live children as `completed` seconds into their first step. Measured
// against a real v2 child (coda, `senior-engineer`, 47 minutes of work): EVERY
// assistant message carries its own `time.completed` — seq 7 completed 30s in —
// because a v2 turn is a SEQUENCE of messages that each finish individually.
// "the last message completed" is therefore true for most of a running turn, which
// is the worst possible answer: it reads as an ending where there is only a step.

/** Our words for a session we track no record of — not the host's. */
export enum UntrackedStatus {
  Busy = "busy",
  Unknown = "unknown",
}

/**
 * The host's own verdict on a TURN, not on a message. `Session.Info.outcome` is
 * absent until an execution reaches a terminal transition, so this union plus
 * `undefined` covers every turn state the host can be in. Derived from the SDK's
 * declaration rather than restated: a host that adds a verdict must not leave this
 * module quietly misreading one.
 */
export type HostTurnWord = NonNullable<SessionInfo["outcome"]>;

/**
 * The host's TURN record, as our reading of it. A session with no completed
 * execution has an open turn; a session the host cannot answer for has neither a
 * turn nor an answer, and those are kept apart on purpose.
 */
export enum SessionExistence {
  Present = "present",
  Missing = "missing",
  Unread = "unread",
}

export interface SessionTurn {
  /** Does the host still have this session? A verdict cannot answer that. */
  existence: SessionExistence;
  hostTurn: HostTurnWord | undefined;
  /**
   * Did the host answer? Its silence is not evidence, so without this a settled
   * reader cannot tell "no turn finished" from "no reply" — and the two must not
   * collapse, because the second is a transport failure and reading it as the
   * first would report a dead host as busy and defer every debt behind it.
   */
  statusAnswered: boolean;
}

export interface LivenessReading extends SessionTurn {
  /** When the child last wrote a message; null when it has written none. */
  lastMessageAt: number | null;
  messageCount: number;
}

/** The one answer a host that did not reply gets, so no caller spells it twice. */
export const UNANSWERED_LIVENESS: LivenessReading = Object.freeze({
  existence: SessionExistence.Unread,
  hostTurn: undefined,
  lastMessageAt: null,
  messageCount: 0,
  statusAnswered: false,
});

/**
 * Is a turn still open? The host has recorded no completed execution, and it did
 * say so — an unanswered read is not an open turn.
 */
export function hostTurnRunning(reading: SessionTurn): boolean {
  // Presence is part of the question. A session the host says it does not have has
  // no verdict only because there is no session to hold one, and reading that as
  // an open turn leaves a vanished child running for ever — the reconciler has no
  // other way to end it, and the parent never hears what happened.
  return (
    reading.statusAnswered &&
    reading.existence === SessionExistence.Present &&
    reading.hostTurn === undefined
  );
}

/**
 * A session no store record covers: running, or unknown. There is deliberately no
 * "completed" — a plugin that does not track a session cannot witness its
 * completion, and "no running turn" is the only fact this read can see.
 */
export function statusFromHostTurn(reading: SessionTurn): UntrackedStatus {
  return hostTurnRunning(reading) ? UntrackedStatus.Busy : UntrackedStatus.Unknown;
}

/**
 * When the last message finished, or began — an unfinished turn has no completion,
 * so its start is the honest floor. The host returns `{ info, parts }` with the
 * clock on `info`; the flat form is the tolerance `messageRoleOf` already keeps.
 */
function lastMessageAt(messages: unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isMessage(message)) {
      const time = messageTime(message);
      if (typeof time?.completed === "number") return time.completed;
      if (typeof time?.created === "number") return time.created;
    }
  }
  return null;
}

/** Where one message keeps its clock: `info.time`, or the flat `time`. */
function messageTime(message: unknown): { completed?: unknown; created?: unknown } | undefined {
  if (!isPlainRecord(message)) return undefined;
  const info = isPlainRecord(message.info) ? message.info : undefined;
  const at = isPlainRecord(message.time) ? message.time : info?.time;
  if (!isPlainRecord(at)) return undefined;
  return { completed: at.completed, created: at.created };
}

/**
 * Read a child's liveness.
 *
 * The turn state comes from the host's TURN record; the message facts come from the
 * caller's already-read transcript (task_result needs it for its summary either way,
 * and re-reading would fetch it twice). Two reads, two questions — neither is asked
 * to answer the other's, which is exactly how a turn came to be derived from a
 * message field that means something else.
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
  // The turn read is wrapped like its sibling below: a rejected read has said
  // nothing about any session, so it answers the shrug rather than rejecting.
  const turn = await readSessionTurn(host, childSessionId).catch(() => ({
    existence: SessionExistence.Unread,
    hostTurn: undefined,
    statusAnswered: false,
  }));
  if (!turn.statusAnswered) return UNANSWERED_LIVENESS;
  const read = messages === undefined ? await readSessionMessages(host, childSessionId).catch(() => null) : messages;
  if (read === null) return { ...UNANSWERED_LIVENESS, existence: turn.existence, statusAnswered: true };
  return {
    existence: turn.existence,
    hostTurn: turn.hostTurn,
    lastMessageAt: lastMessageAt(read),
    messageCount: read.length,
    statusAnswered: true,
  };
}

/**
 * Whether the host still HAS this session, asked of the one endpoint whose contract
 * answers it. Three answers because there is no honest two: a session with nothing
 * running and a session that never existed look identical in the status map, which
 * is the whole defect.
 */


export interface SessionPresence {
  readonly existence: SessionExistence;
  /** The host's own not-found, when it gave one — its declared type, not a copy. */
  readonly missing?: HostSessionMissing | undefined;
  /** The host's own verdict on the last completed execution, when there was one. */
  readonly hostTurn?: HostTurnWord | undefined;
  /** Did the host answer at all? Absence is a transport failure, not an absence. */
  readonly statusAnswered: boolean;
}

/**
 * The reason the client declares for "the server said no", and the status the host
 * pairs it with to mean "no such session".
 *
 * v2 declares no not-found error type: `session.get` rejects with a `ClientError`
 * carrying `reason` and the failing response on `cause`. The host's own client
 * spells its missing-session test exactly this way, so a reader checking `name` or
 * `status` at the top level — as the v1 shape allowed — matches nothing and reports
 * every lost child as unread, which defers the question forever.
 */
export const NOT_FOUND_REASON = "UnexpectedStatus" as const;

/** The HTTP status that, paired with the reason above, means "no such session". */
const NOT_FOUND_STATUS = 404;

/** The host's own "no such session", narrowed to what we actually compare. */
export type HostSessionMissing = Record<string, unknown>;

/**
 * The in-process host's missing-session tag, named once. The dotted spelling
 * is the core `Session.NotFoundError` (`packages/core/src/session/error.ts`);
 * the undotted one is the protocol/HTTP layer's own error. They differ by
 * design, so the reader below accepts both and no other tag.
 */
export const SESSION_NOT_FOUND_TAG = "Session.NotFoundError";
export const PROTOCOL_NOT_FOUND_TAG = "SessionNotFoundError";

/**
 * Whether the host says "no such session", in every shape it says it.
 *
 * Order matters: the dotted core tag is what the in-process plugin API
 * throws (verified against the host source); the rest is tolerance for the
 * remote shapes. The message fallback is scoped to sessions — a bare
 * "not found" also matches the AGENT being gone, which is a different
 * failure with a different recovery.
 */
export function isSessionMissing(error: unknown): error is HostSessionMissing {
  if (!isPlainRecord(error)) return false;
  // The SDK's tag field, read computed because its underscore is theirs; the
  // local tag spelling stays out of the repo's vocabulary. The two rules
  // disagree on this spelling (dot-notation wants a dot, no-underscore-dangle
  // forbids the underscore), so the deliberate form is pinned by name.
  // eslint-disable-next-line typescript/dot-notation
  const tag = error["_tag"];
  if (tag === SESSION_NOT_FOUND_TAG || tag === PROTOCOL_NOT_FOUND_TAG) return true;
  if (error.type === SESSION_NOT_FOUND_TAG || error.type === PROTOCOL_NOT_FOUND_TAG) return true;
  if (error.reason === NOT_FOUND_REASON) {
    const {cause} = error;
    return isPlainRecord(cause) && cause.status === NOT_FOUND_STATUS;
  }
  const {message} = error;
  return typeof message === "string" && /session[^.]{0,40}not found/i.test(message);
}

/**
 * The session, as the host describes it: whether it exists AND where its last
 * execution got to. One read, because the same object answers both — existence from
 * the call succeeding, turn state from `outcome`. Reading them apart would mean two
 * reads that can disagree, and that disagreement is a false settlement.
 *
 * Bounded, because this sits on the reconcile path and an unbounded host call there
 * is a boot that never finishes. v2 offers `throwOnError`, but the host's bindings
 * here reject on a 404 rather than returning an envelope payload, so existence is
 * answered by the catch below.
 */
async function readSessionState(host: OpaqueHost, sessionId: string): Promise<SessionPresence> {
  try {
    const bounded = await callHost(host, READ_BOUNDS.presence, (client) => client.session.get({ sessionID: sessionId }), null);
    if (bounded.timedOut) return { existence: SessionExistence.Unread, statusAnswered: false };
    const info = isPlainRecord(bounded.value) ? bounded.value : undefined;
    return {
      existence: SessionExistence.Present,
      statusAnswered: true,
      ...(info ? { hostTurn: readHostOutcome(info) } : {}),
    };
  } catch (error: unknown) {
    if (isSessionMissing(error)) {
      return { existence: SessionExistence.Missing, missing: error, statusAnswered: true };
    }
    return { existence: SessionExistence.Unread, statusAnswered: false };
  }
}

/** The host's own outcome word, or undefined when no execution has completed. */
function readHostOutcome(info: Record<string, unknown>): HostTurnWord | undefined {
  const {outcome} = info;
  return isHostTurnWord(outcome) ? outcome : undefined;
}

// Every word the SDK declares, so an undeclared one cannot pass as a verdict.
const HOST_TURN_WORD_LIST = ["succeeded", "failed", "interrupted"] as const;
function isHostTurnWord(value: unknown): value is HostTurnWord {
  return includesWord(HOST_TURN_WORD_LIST, value);
}

/**
 * Presence, for the callers that only ask that. Existence and turn state come from
 * one read, so this is the same call with less of the answer asked for — not a
 * second endpoint to keep in step.
 */
export async function readSessionPresence(host: OpaqueHost, sessionId: string): Promise<SessionPresence> {
  return readSessionState(host, sessionId);
}

/** Bounded, because this sits on the write and wedge paths. */
async function readSessionTurn(host: OpaqueHost, sessionId: string): Promise<SessionTurn> {
  const state = await readSessionState(host, sessionId);
  return { existence: state.existence, hostTurn: state.hostTurn, statusAnswered: state.statusAnswered };
}

/**
 * Is a turn running RIGHT NOW? Deliberately not `readLiveness`: a parent-write gate
 * needs this before it spends an attempt, and a failed read is not "busy" — reading
 * transport failure as congestion defers every debt for as long as the channel is
 * down, a silent stall wearing a safety check's name.
 */
export async function hostTurnInFlight(host: OpaqueHost, sessionId: string): Promise<boolean> {
  return hostTurnRunning(await readSessionTurn(host, sessionId));
}

/**
 * Has this parent stopped answering? A turn the host opened and never closed —
 * distinct from busy because a wedged parent holds its write forever, creating no
 * message and logging no line. The host's own record draws the same line: an
 * execution that reached a terminal transition settled it, and one that has not is
 * still the host's to close.
 */
export async function parentTurnStuck(host: OpaqueHost, sessionId: string): Promise<boolean> {
  // An open turn alone is not the evidence — a host that described nothing (no clock
  // on the last message, or no transcript at all) has not said the turn failed. The
  // wedge is an opened turn the host never closed: a clock with no completion.
  const reading = await readLiveness(host, sessionId);
  return hostTurnRunning(reading) && reading.lastMessageAt !== null;
}

/**
 * The transcript's last assistant turn completed on its own, or the host gave up.
 *
 * Both words come from ONE record — `SessionMessageAssistant.time.completed` — and
 * `statusAnswered` says whether we were shown it at all. There is no third answer:
 * a host that refuses to say whether a turn is running leaves the child alone rather
 * than inventing the errors this pass exists to prevent.
 */