// src/shared/liveness.ts
//
// What the host says about a session's turn, in the host's OWN vocabulary.
//
// House rule for this module: anything from the SDK is used through the SDK's
// declared type, never a local re-declaration of it. Both re-declarations that
// used to live here were load-bearing and both were wrong.

import type { HostSessionMissing, HostStatusMap, HostTurn, OpenCodeClient } from "./client.js";
import { isMessage, messageRoleOf, messageTurnStuck, ASSISTANT_ROLE, readSessionMessages } from "./prompt.js";
import { boundedRead, READ_BOUNDS } from "./execution-bound.js";
import { isPlainRecord } from "./host-shape.js";

// opencode v1.18.30 packages/opencode/src/session/status.ts: `set` DELETES the
// entry on `idle` and stores it otherwise — so the map holds RUNNING turns only, and
// an absent key means "no turn running", never "no such session".
// The host does publish a `session.status` EVENT carrying `idle` first; that is a
// different channel with its own vocabulary, and it is handled by the event path.

/** Our words for a session we track no record of — not the host's. */
export enum UntrackedStatus {
  Busy = "busy",
  Unknown = "unknown",
}

export interface LivenessReading {
  /** The host's turn object verbatim, or undefined when the map lists no key. */
  hostTurn: HostTurn | undefined;
  /**
   * Did the status channel answer? Its silence is not evidence, so without this a
   * settled reader cannot tell "no turn" from "no reply".
   */
  statusAnswered: boolean;
  /** When the child last wrote a message; null when it has written none. */
  lastMessageAt: number | null;
  messageCount: number;
}

/**
 * A switch over the SDK's own union with no `default`, so `noImplicitReturns` turns
 * a word the host adds into a BUILD ERROR here rather than a runtime "not running"
 * that leaves every working child looking settled.
 */
function hostTurnIsRunning(turn: HostTurn): boolean {
  switch (turn.type) {
    case "busy":
    case "retry":
      return true;
    case "idle":
      return false;
  }
}

/** A turn the server is running: working, or retrying on the provider's behalf. */
export function hostTurnRunning(reading: LivenessReading): boolean {
  return reading.hostTurn !== undefined && hostTurnIsRunning(reading.hostTurn);
}

/**
 * A session no store record covers: running, or unknown. There is deliberately no
 * "completed" — a plugin that does not track a session cannot witness its
 * completion, and "no running turn" is the only fact this read can see.
 */
export function statusFromHostTurn(hostTurn: HostTurn | undefined): UntrackedStatus {
  return hostTurn !== undefined && hostTurnIsRunning(hostTurn) ? UntrackedStatus.Busy : UntrackedStatus.Unknown;
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
  client: OpenCodeClient,
  childSessionId: string,
  messages?: unknown[],
): Promise<LivenessReading> {
  const list = messages ?? (await readSessionMessages(client, childSessionId).catch(() => []));
  const statusMap = await readStatusMap(client);
  return {
    hostTurn: statusMap?.[childSessionId],
    statusAnswered: statusMap !== null,
    lastMessageAt: lastMessageAt(list),
    messageCount: list.length,
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
 * Two spellings, because the SDK's error mode picks which one arrives and the reader
 * must not depend on a mode it does not set — reading only one would report every
 * missing session present whenever the other mode is in force.
 */
function isHostSessionMissing(error: unknown): error is HostSessionMissing {
  if (!isPlainRecord(error)) return false;
  if (error["name"] === NOT_FOUND_NAME) return true;
  return error["status"] === NOT_FOUND_STATUS;
}

/**
 * Bounded, because this sits on the reconcile path and an unbounded host call there
 * is a boot that never finishes. `throwOnError` makes the SDK hand over its own
 * payload on success and its own error on refusal — no envelope to unwrap, no error
 * shape to re-declare, which is why this is ten lines and not thirty.
 */
export async function readSessionPresence(client: OpenCodeClient, sessionId: string): Promise<SessionPresence> {
  try {
    const bounded = await boundedRead(READ_BOUNDS.presence, () =>
      client.session.get({ path: { id: sessionId }, throwOnError: true }),
    );
    if (bounded.timedOut) return { existence: SessionExistence.Unread };
    return { existence: SessionExistence.Present };
  } catch (error: unknown) {
    if (isHostSessionMissing(error)) return { existence: SessionExistence.Missing, missing: error };
    return { existence: SessionExistence.Unread };
  }
}

/**
 * Is a turn running RIGHT NOW? One word, deliberately not `readLiveness`: a
 * parent-write gate needs this before it spends an attempt, and a failed read is not
 * "busy" — reading transport failure as congestion defers every debt for as long as
 * the channel is down, a silent stall wearing a safety check's name.
 */
export async function hostTurnInFlight(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  const statusMap = await readStatusMap(client);
  if (statusMap === null) return false;
  const turn = statusMap[sessionId];
  return turn !== undefined && hostTurnIsRunning(turn);
}

/**
 * Has this parent stopped answering? A turn the host opened and never closed —
 * distinct from busy because a wedged parent holds its write forever, creating no
 * message and logging no line, and the status map cannot see it either since a
 * wedge has no run. Only the transcript can: an assistant message whose
 * `time.completed` is absent.
 */
export async function parentTurnStuck(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  const list = await readSessionMessages(client, sessionId, { limit: WEDGE_TAIL_MESSAGES }).catch(() => null);
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
 * The status channel in the SDK's own declared type, or null when it did not answer.
 * Two readers want this and want different things from a failure, so the READ
 * reports it and each caller interprets — but neither may wait forever for it.
 */
async function readStatusMap(client: OpenCodeClient): Promise<HostStatusMap | null> {
  try {
    const bounded = await boundedRead(READ_BOUNDS.status, () => client.session.status({ throwOnError: true }));
    if (bounded.timedOut) return null;
    return bounded.value === null ? null : bounded.value.data;
  } catch {
    return null;
  }
}