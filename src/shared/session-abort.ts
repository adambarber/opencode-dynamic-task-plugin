// src/shared/session-abort.ts
// The ONE child-abort site, and the ONE place a stop is judged reachable.
//
// It was the third subject inside session-lifecycle.ts, wedged between the event
// readers and the ledger, so the one file that decides what a stop MEANS was the
// one file a reader had to open to learn what a host event says. The ownership
// pins already treated this as its own subject: the abort rule sanctions this file
// alone, and the ledger's atomic-write dance sanctions another alone.

//jscpd:ignore-start
import { type OpaqueHost, type OpenCodeClient, callHost } from "./client.js";
import type { SessionId } from "./ids.js";
import type { TaskStore } from "./store.js";
import { WRITE_BOUNDS } from "./execution-bound.js";
import { errorMessage } from "./host-shape.js";
import { findTask, isRunning } from "./task-state.js";
import { isSessionMissing } from "./liveness.js";
import { subtreeTaskIds } from "./dispatch-tree.js";

//jscpd:ignore-end
// The ONE child-abort site. Tenet 9 keeps the await at the call site — a steer
// must abort exactly where its claim requires, an interrupt exactly where its
// claim sits — so the funnel takes the ordering-preserving shape: it performs
// the call and hands back what the failure MEANS, never what to do about it.
//
// Three meanings, and they are the whole reason this is one funnel. A "not
// found" child is dead (settle/report it); any other transport failure may never
// have reached the server, so the turn may still be running and a caller that
// treats it as a kill replaces a live turn instead of stopping it; and a REFUSAL
// means no request was made at all, which is a fourth thing again and cannot be
// spelled as either of the first two without lying about one of them.
export interface AbortOutcome {
  serverGone: boolean;
  transportError: string | undefined;
  /** Present when no request was made, and the reason. */
  refusal?: AbortRefusal;
}

/**
 * The two reasons a stop is refused. An enum for the same reason
 * `InterruptScope` is one: the vocabulary is small, closed, and decided by the
 * plugin rather than read off the wire — so a raw literal comparison here is a
 * member that survives a rename, and a new member that falls through to whatever
 * the final `else` said. Two callers render these differently (a stop and a steer
 * have different remedies), so the words cannot be assembled at the decision
 * either — which is why the discriminator is a typed member rather than a bare
 * sentence, and why the sentence lives in voice.ts.
 */
export enum AbortRefusalKind {
  /** The caller aimed the tool at the session it is speaking in. */
  Self = "self",
  /** The session is in neither half of the store: this process did not start it. */
  Unowned = "unowned",
}

export type AbortRefusal = { kind: AbortRefusalKind.Self } | { kind: AbortRefusalKind.Unowned };

/**
 * The three facts a stop needs, and the reason they travel together: the client
 * is what the request goes through, the store is what says whether the target is
 * the plugin's, and the caller is what says whether the target is the caller.
 * The two ids are neighbours in every signature that takes them, which is
 * exactly how a swap happens — and a swap here is a swapped *identity*: "is this
 * mine" and "is this me" are different questions, and asking the wrong one is
 * the bug this interface exists to make un-askable.
 */
export interface AbortTarget {
  host: OpaqueHost;
  store: TaskStore;
  /** The session that asked for the stop. Never a target, whatever the args say. */
  callerSessionId: string | undefined;
}

/**
 * Which sessions this caller may stop, or the refusal that stops them.
 *
 * Ownership and reach are ONE question with one answer, and a stop needs both
 * halves before it claims anything: the refusal decides whether to answer at all,
 * and the target list decides what a subtree stop is allowed to reach. They lived
 * apart — the rule here, the list in the tool — which is how a caller could be
 * refused by one and still have the other build a request. Settled ancestors are
 * still walked, so a live grandchild under a finished child is reached, while a
 * descendant that has already settled is left alone.
 */
export function stopPlan(
  target: Pick<AbortTarget, "store" | "callerSessionId">,
  sessionId: SessionId,
  reachSubtree: boolean,
): { refusal?: AbortRefusal; targets: SessionId[] } {
  const { store, callerSessionId } = target;
  if (callerSessionId !== undefined && callerSessionId === sessionId) {
    return { refusal: { kind: AbortRefusalKind.Self }, targets: [] };
  }
  if (findTask(store, sessionId) === null) {
    return { refusal: { kind: AbortRefusalKind.Unowned }, targets: [] };
  }
  const candidates = reachSubtree ? subtreeTaskIds(store, sessionId) : [sessionId];
  return { targets: candidates.filter((id) => id === sessionId || isRunning(store, id)) };
}

/** The outcome an accepted request produces: stopped, and nothing more to say. */
const ABORT_SENT: AbortOutcome = { serverGone: false, transportError: undefined };

export function abortSession(target: AbortTarget, sessionId: SessionId): Promise<AbortOutcome> {
  const { host } = target;
  // Decided before any transport is touched, and answered without an await: a
  // refusal must cost nothing and must hold when the server is gone, because a
  // dead server is exactly when a wrong target id is most likely to be guessed.
  const { refusal } = stopPlan(target, sessionId, false);
  if (refusal !== undefined) return Promise.resolve({ ...ABORT_SENT, refusal });

  // Bounded, and the bound answers with the SAME shape the transport failure does.
  // That is the whole argument for the bound existing: a stop that never answers is
  // ignorance, not a death — the request may never have reached the server — so it
  // has to arrive as the thing callers already know how to read, or a dead server
  // would get two spellings of "possibly still running".
  // v2 renamed this call: `session.abort` is `session.interrupt`, and its id is a
  // flat `sessionID` rather than a `{ path: { id } }` envelope.
  const dial = (client: OpenCodeClient): Promise<AbortOutcome> =>
    client.session
      .interrupt({ sessionID: sessionId })
      .then((): AbortOutcome => ABORT_SENT)
      .catch((error: unknown): AbortOutcome => {
        // The core not-found carries no message, so a substring cannot see
        // it — the one reader that names every shape decides here too.
        if (isSessionMissing(error)) return { serverGone: true, transportError: undefined };
        return { serverGone: false, transportError: errorMessage(error) };
      });

  return callHost(
    host,
    WRITE_BOUNDS.abort,
    dial,
    { serverGone: false, transportError: `no answer within ${WRITE_BOUNDS.abort}ms` },
  ).then((bounded) => bounded.value);
}