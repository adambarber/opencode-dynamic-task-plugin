// task_interrupt executor: the subtree stop. One call, every task the plugin
// was tracking below the one it was handed.
//
// The order is the whole design. Every target is claimed (settled
// `interrupted`) synchronously BEFORE the first abort reaches the server,
// because the claim is what orders the abort's own echoes: a terminal event
// for an already-claimed task finds settled history instead of an active
// record, so it cannot report a completion the parent was just told about.
// Claim one abort at a time and every descendant is still live while the first
// abort is in flight — the exact window where a real terminal event settles a
// child this call is stopping.
//
// Then each target is aborted in turn, and each reports its own outcome: the
// abort may never have reached the server, in which case that task alone is
// withdrawn back to active and its genuine terminal event still settles it.
import { abortSession, stopPlan } from "../shared/session-lifecycle.js";
import type { OpenCodeClient } from "../shared/client.js";
import { safeLog } from "../shared/notify.js";
import {
  TaskState,
  transitionState,
  withdrawInterruptClaim,
  noteAbortLanded,
  recordAbortError,
} from "../shared/task-state.js";
import { type ResolvedSessionScope } from "./context.js";
import type { Refusal } from "../shared/verdict.js";
import {
  interruptReport,
  interruptScopeRefused,
  interruptStopRefused,
  interruptSubtreeReport,
  type InterruptOutcome,
} from "../shared/voice.js";

/**
 * How far a stop reaches. `subtree` is the default and the honest one.
 *
 * An enum because the scope is a decision the plugin makes about work it did not
 * start, and a raw literal in that comparison is how a stop silently narrows or
 * widens. The wire values are the literals the tool argument is spelled with.
 */
export enum InterruptScope {
  Subtree = "subtree",
  Self = "self",
}

/** A scope the tool understands, as a predicate — the argument arrives `unknown`. */
function isInterruptScope(value: unknown): value is InterruptScope {
  return value === InterruptScope.Subtree || value === InterruptScope.Self;
}

// A recognized scope, or the value that was refused. A scope the tool does not
// understand is never defaulted: silently widening a stop kills work the caller
// did not name, and silently narrowing one leaves a descendant running behind a
// report that reads as success.
export function readInterruptScope(args: unknown): { ok: true; scope: InterruptScope } | Refusal {
  const raw = (args as { scope?: unknown } | null | undefined)?.scope;
  if (raw === undefined) return { ok: true, scope: InterruptScope.Subtree };
  if (isInterruptScope(raw)) return { ok: true, scope: raw };
  return { ok: false, error: interruptScopeRefused(String(raw)) };
}

interface InterruptClaim {
  claimed: boolean;
  claimTime: number;
}

/**
 * An abort that failed on a child this plugin is still responsible for: log what
 * the server said, with the circumstance that makes the failure mean something,
 * and answer the one outcome both a withdrawn claim and an untracked child get.
 * The `because` is a parameter because the two sites differ exactly there.
 */
function abortFailedActive(
  client: OpenCodeClient,
  sessionId: string,
  message: string,
  because: string,
): InterruptOutcome {
  void safeLog(client, "warn", `Interrupt: abort failed for ${sessionId} (${message}); ${because}.`);
  return { kind: "abort-failed-active", message };
}

/** The synchronous half: settle the task before the server is told anything. */
function claimInterrupt(store: ResolvedSessionScope["store"], sessionId: string): InterruptClaim {
  const claimTime = Date.now();
  if (!store.activeTasks.get(sessionId)) return { claimed: false, claimTime };
  try {
    transitionState(store, sessionId, TaskState.Interrupted);
    return { claimed: true, claimTime };
  } catch {
    return { claimed: false, claimTime }; // settled concurrently
  }
}

/** The awaited half: abort the claimed session and say what actually happened. */
async function abortClaimed(
  scope: ResolvedSessionScope,
  sessionId: string,
  claim: InterruptClaim,
): Promise<InterruptOutcome> {
  const { client, store, config } = scope;
  const { claimed } = claim;
  // `refusal` is destructured away, and that is the handling: a record that has
  // vanished between the pre-check above and this call leaves the task in neither
  // half of the store, so it falls through to `untracked` below — nothing stopped,
  // reported as nothing stopped. A branch of its own would claim the funnel can
  // disagree with itself here, which is the one thing the pre-check exists to
  // make impossible.
  const { serverGone, transportError: abortMessage } = await abortSession(
    { client, store, callerSessionId: scope.callerSessionId },
    sessionId,
  );

  const retained = store.retainedTasks.get(sessionId);
  if (!claimed && !retained) {
    // Untracked: transient abort failures are simply the caller's
    // transport error; nothing of ours is at stake.
    if (abortMessage) {
      return abortFailedActive(client, sessionId, abortMessage, "untracked child, so nothing of ours is at stake");
    }
    if (serverGone) return { kind: "gone" };
    return { kind: "untracked" };
  }

  if (abortMessage) {
    // Transport failure (not a 404): the abort may never have reached
    // the server, so a claimed live child is withdrawn back to active
    // — its genuine terminal event still settles it. A 404 means dead
    // and never withdraws. Settled history is recorded, not disturbed.
    // Withdrawal additionally requires no newer abort to have landed
    // since the claim (F-R4: success is knowledge, failure is
    // ignorance — the newer success wins).
    if (claimed && store.retainedTasks.get(sessionId)?.state === TaskState.Interrupted) {
      if (withdrawInterruptClaim(store, sessionId, claim.claimTime, config)) {
        return abortFailedActive(client, sessionId, abortMessage, "speculative claim withdrawn, child may still be live");
      }
      recordAbortError(store, sessionId, abortMessage);
      return { kind: "abort-failed-retained", message: abortMessage };
    }
    // A success record is never annotated with abort noise — the gap
    // belongs in the operator-visible report, not on the outcome.
    if (retained && retained.state !== TaskState.Completed) recordAbortError(store, sessionId, abortMessage);
    return { kind: "abort-failed-settled", state: retained?.state ?? "unknown", message: abortMessage };
  }
  if (serverGone) return { kind: "server-gone" };
  if (!claimed && retained) {
    // A successful abort landing on settled history is stamped: a
    // concurrent interruptor's stale withdraw must observe it (F-R4).
    noteAbortLanded(store, sessionId);
    return { kind: "already-settled", state: retained.state };
  }
  // Successful abort on our own fresh claim: stamp it so a concurrent
  // stale withdraw cannot resurrect a dead child.
  noteAbortLanded(store, sessionId);
  return { kind: "interrupted" };
}

export async function executeTaskInterrupt(scope: ResolvedSessionScope, args?: unknown): Promise<string> {
  const { store, sessionId } = scope;
  const reach = readInterruptScope(args);
  if (!reach.ok) return reach.error;

  // Ownership and reach, asked together and answered before anything is claimed:
  // the request itself is the damage, so a refusal never becomes a dial.
  const plan = stopPlan(scope, sessionId, reach.scope === InterruptScope.Subtree);
  if (plan.refusal !== undefined) return interruptStopRefused(sessionId, plan.refusal);

  const claims = plan.targets.map((id) => ({ id, claim: claimInterrupt(store, id) }));
  const members: Array<{ sessionId: string; outcome: InterruptOutcome }> = [];
  for (const { id, claim } of claims) {
    members.push({ sessionId: id, outcome: await abortClaimed(scope, id, claim) });
  }
  // One task is a sentence, several are a ledger. The words come from the same
  // function either way (interruptReport), so a report of ten does not say
  // something a report of one would not.
  return members.length === 1 && members[0] !== undefined
    ? interruptReport(members[0].sessionId, members[0].outcome)
    : interruptSubtreeReport(sessionId, members);
}
