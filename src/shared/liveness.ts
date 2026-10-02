// src/shared/liveness.ts
// Liveness, read from its sources (Task 01 follow-up): the server's status
// channel and the child's own messages. Nothing here infers a status from
// message shapes — `session.get` carries no status field, so probing it can
// only ever guess, and a guess is what made a running child read as
// "completed" and a silent turn read as a store that had nothing to say.
//
// One read, one vocabulary. Every renderer that shows liveness renders THIS
// reading, so the two read tools can never drift into disagreeing about the
// same child — which is what turns a status line into a wrong recovery.

import type { OpenCodeClient } from "./client.js";
import { hostPayload } from "./session-lifecycle.js";
import { eventField } from "./host-shape.js";
import { isMessage, messageRoleOf, messageTurnStuck, ASSISTANT_ROLE, readSessionMessages } from "./prompt.js";
import { withBound, READ_BOUNDS } from "./execution-bound.js";

// The server's own words for a session's turn. They are the SERVER's vocabulary,
// not this plugin's: it cannot add a member, and a test pinning one would be a
// test of fiction. So the words stay the strings the host wrote, read verbatim,
// and the two questions anyone asks of them are answered by predicates here —
// one owner for the set, so a word the host adds later is unrecognised at every
// call site at once and none of them can quietly decide what it means.
const RUNNING_HOST_STATES: ReadonlySet<string> = new Set(["busy", "retry"]);
const OVER_HOST_STATES: ReadonlySet<string> = new Set(["idle"]);

/**
 * How a reader renders a session this plugin tracks no record of. These three
 * words are OURS, not the host's: the host says a turn is working, retrying or
 * over, and this is what a person is shown for it. Named, because the word has
 * to be agreed on by the function that decides it, the formatter that compares
 * it, and every test that pins it — and a bare string in a union type is not an
 * agreement any compiler can check. It is also what makes
 * `TaskResultRecord["status"]` a real union rather than a `string`, so the two
 * vocabularies meet at a type instead of at a reader's guess.
 */
export enum UntrackedStatus {
  Busy = "busy",
  Completed = "completed",
  Unknown = "unknown",
}

export interface LivenessReading {
  /**
   * The server's word for this session, verbatim, or null when the status
   * channel lists no entry for it. Those are different facts and stay distinct:
   * a word this plugin does not read is NOT the same as a session the host has
   * stopped listing, and a reader that collapses them decides a child's fate
   * from a word it never understood.
   */
  hostState: string | null;
  /** When the child last wrote a message; null when it has written none. */
  lastMessageAt: number | null;
  messageCount: number;
}

/** A turn the server is running: working, or retrying on the provider's behalf. */
export function hostTurnRunning(reading: LivenessReading): boolean {
  return reading.hostState !== null && RUNNING_HOST_STATES.has(reading.hostState);
}

/**
 * A turn the server has said is OVER — the only fact that ends a restored child
 * from the status channel. False for every word this plugin does not read, and
 * that is the entire point: "the host said the turn ended" and "this plugin
 * does not know what the host said" are not the same sentence. The first is
 * settled from the transcript; the second must be left for the child's own
 * terminal event, or a word added upstream settles a working child as an error
 * nobody observed.
 */
export function hostTurnOver(reading: LivenessReading): boolean {
  return reading.hostState !== null && OVER_HOST_STATES.has(reading.hostState);
}

/**
 * The status word for a session no store record covers. The server's word is
 * the answer here — with nothing to reconcile it against, the only honest
 * reading is the source's own, and a session it does not list is genuinely
 * unknown rather than quiet-but-alive. "idle" reads as completed: the server
 * is saying the turn is over, which is the reading this vocabulary has for it.
 */
export function statusFromHostState(hostState: string | null): UntrackedStatus {
  if (hostState !== null && RUNNING_HOST_STATES.has(hostState)) return UntrackedStatus.Busy;
  if (hostState !== null && OVER_HOST_STATES.has(hostState)) return UntrackedStatus.Completed;
  return UntrackedStatus.Unknown;
}

// The host's words, and only its words, kept verbatim. The status channel is a
// map of session id to the server's own object, so a word we do not read comes
// back as the word the host actually wrote — not as a null, which is the host
// saying it has no entry for this session and a fact about a child rather than
// about this plugin's vocabulary.
function hostTurnState(statusResult: unknown, childSessionId: string): string | null {
  const entry = eventField(hostPayload(statusResult), childSessionId);
  const type = eventField(entry, "type");
  return typeof type === "string" ? type : null;
}

// The child's own clock: when the last message it wrote finished, or began —
// an unfinished turn has no completion, and its start is the honest floor.
//
// The message list the host returns is `{ info, parts }` per item, with the
// role and the clock on `info`; the flat form is the same tolerance
// `messageRoleOf` already keeps, so the two readers of one message agree on
// where its fields live. Reading the wrong level is not a crash — it reads as
// "this child has never written a message", which is how a finished child came
// to report "(none yet)".
function lastMessageAt(messages: unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const time = eventField(message, "info", "time") ?? eventField(message, "time");
    const completed = eventField(time, "completed");
    const created = eventField(time, "created");
    if (typeof completed === "number") return completed;
    if (typeof created === "number") return created;
  }
  return null;
}

/**
 * Read a child's liveness from both sources. `messages` is the session's
 * already-read message list when the caller has it — task_result needs the
 * list for its summary either way, and re-reading it would be a second copy of
 * the same fetch.
 */
export async function readLiveness(
  client: OpenCodeClient,
  childSessionId: string,
  messages?: unknown[],
): Promise<LivenessReading> {
  // Tolerant on the transcript, unlike task_result: a liveness read is asked
  // "is a turn running, and when did it last write?", and a session the host
  // cannot describe has honestly answered neither question. task_result still
  // reports a failed read as a failure (its own fetch is strict) — here the
  // empty list is the answer, and refusing it would let one vanished child
  // abandon a whole reconciliation pass.
  const list = messages ?? await readSessionMessages(client, childSessionId).catch(() => []);
  const statusMap = await readStatusMap(client);
  return {
    hostState: hostTurnState(statusMap, childSessionId),
    lastMessageAt: lastMessageAt(list),
    messageCount: list.length,
  };
}

/**
 * Is a turn running on this session RIGHT NOW, as the host's own status channel
 * says? One word, and deliberately not `readLiveness`.
 *
 * A parent-write gate needs this before it spends an attempt, and the transcript
 * that `readLiveness` also reads answers no part of that question: fetching a
 * session's whole message list to learn one word is a second copy of a fact the
 * status map already carries, on the path where a wrong answer costs a turn.
 *
 * A status read that FAILS is not "busy". The host holding a write is the only
 * thing this guards, and a transport error is no evidence of it — reading failure
 * as congestion would defer every debt for as long as the channel is down, which
 * is a silent stall wearing a safety check's name.
 */
export async function hostTurnInFlight(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  const statusMap = await readStatusMap(client).catch(() => null);
  const state = statusMap === null ? null : hostTurnState(statusMap, sessionId);
  return state !== null && RUNNING_HOST_STATES.has(state);
}

// How much of a parent's tail to read to decide whether its last turn finished.
// One message is the answer, and a few are read so a reordered or partially
// returned tail cannot hide the un-terminated turn behind a later one. The
// session may hold thousands of messages, so the read is bounded at the HOST and
// is never the whole transcript.
const WEDGE_TAIL_MESSAGES = 5;

/**
 * Has this parent stopped answering? A turn the host opened and never closed.
 *
 * Distinct from `hostTurnInFlight` because the host is honest about only one of
 * them. A busy parent HOLDS a write and delivers it when the turn ends; a WEDGED
 * parent holds it forever, creating no message and logging no line, so from the
 * outside the two are indistinguishable — a prompt into one produces not even a
 * `loop` line. The status map cannot tell them apart either, because it carries
 * live runs only and a wedge has no run.
 *
 * What does distinguish them is the transcript: an assistant message whose
 * `time.completed` is absent.
 *
 * The evidence for that is THINNER than the shape suggests, and the database is
 * what corrected it. Audited 2026-09-28 against every assistant turn on the
 * machine: 49 of ~153,000 carry no completion and are old enough that the turn
 * cannot still be in flight, across 40 sessions, 8 projects, since 2026-07-21.
 * All 49 have zero input, output and cache tokens — the model was never reached,
 * so these are FAILED DISPATCHES, not turns that ran and died. Of the 40
 * sessions, 32 carry later completed turns: the host recovered, unprompted, from
 * a row this function would call a wedge. Eight have nothing after them at all.
 * Exactly ONE session machine-wide shows the real thing — an unterminated
 * assistant turn followed by a user prompt that was never answered.
 *
 * So the marker is real, rare, and mostly not what its name suggests. It is kept
 * because it is the only signal the host exposes, and because the cost of firing
 * on a row the host recovered from is one deferred notice that a later boot
 * retries — while the cost of missing a true wedge is a debt that ages out
 * undelivered. That asymmetry is the whole justification, and it rests on ONE
 * observed instance, not the dozens an earlier reading of this comment claimed.
 *
 * Two refusals to guess, both deliberate. A read that FAILS is not a wedge —
 * reading failure as refusal would drop every debt whenever the channel is
 * flaky, which is a silent data loss wearing a safety check's name. And neither
 * is a session with no assistant turn at all, nor one whose turn carries no
 * clock: those are a host that has not said the turn failed, which is not the
 * same as saying it did.
 *
 * Callers must have already established the parent is not mid-turn: a live run
 * means the turn is open on purpose, and this reads an open turn as a wedge.
 */
export async function parentTurnStuck(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  // The same bounded read, asking for less: the tail is all this question needs,
  // and the host does the trimming.
  const list = await readSessionMessages(client, sessionId, { limit: WEDGE_TAIL_MESSAGES }).catch(() => null);
  if (list === null) return false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (!isMessage(message) || messageRoleOf(message) !== ASSISTANT_ROLE) continue;
    return messageTurnStuck(message);
  }
  return false;
}

/**
 * What the host says about every session's turn state, in one call.
 *
 * Two readers want this and they want different things from a failure, so the
 * READ is here and the interpretation stays with each caller: a liveness read
 * reports the absence, a parent-write gate refuses to read a transport failure as
 * congestion. What neither gets to do is wait forever for the answer — an
 * unbounded status read turned `task_status` and `task_result` into tool calls
 * that never returned.
 */
async function readStatusMap(client: OpenCodeClient): Promise<unknown> {
  const bounded = await withBound(READ_BOUNDS.status, () => client.session.status(), () => null);
  if (bounded.timedOut) throw new Error(`status unanswered after ${READ_BOUNDS.status}ms`);
  return bounded.value;
}
