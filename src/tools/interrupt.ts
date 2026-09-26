// task_interrupt executor: synchronous settle-first claim, then the server
// abort. The claim here is what orders the abort (Tenet 9) — abortSession
// classifies the outcome; this file decides what each outcome means.
import { abortSession } from "../shared/session-lifecycle.js";
import { safeLog } from "../shared/notify.js";
import {
  transitionState,
  withdrawInterruptClaim,
  noteAbortLanded,
  recordAbortError,
} from "../shared/task-state.js";
import { type ResolvedSessionScope } from "./context.js";
import {
  interruptUnknown,
  interruptAbortedUntracked,
  interruptAbortFailedActive,
  interruptAbortFailedRetained,
  interruptAbortFailedSettled,
  interruptServerGone,
  interruptAlreadySettled,
  taskInterrupted,
} from "../shared/voice.js";

export async function executeTaskInterrupt(scope: ResolvedSessionScope): Promise<string> {
  const { client, store, config, sessionId } = scope;

  // Claim first, then touch the server: settling the task synchronously
  // means the idle/error events our own abort provokes can never be
  // misclaimed as a fresh completion by the lifecycle handler.
  const active = store.activeTasks.get(sessionId);
  let claimed = false;
  const claimTime = Date.now();
  if (active) {
    try { transitionState(store, sessionId, "interrupted"); claimed = true; } catch { /* settled concurrently */ }
  }

  const { serverGone, transportError: abortMessage } = await abortSession(client, sessionId);

  const retained = store.retainedTasks.get(sessionId);
  if (!claimed && !retained) {
    // Untracked: transient abort failures are simply the caller's
    // transport error; nothing of ours is at stake.
    if (abortMessage) return `ERROR: ${abortMessage}`;
    if (serverGone) return interruptUnknown(sessionId);
    return interruptAbortedUntracked(sessionId);
  }

  if (abortMessage) {
    // Transport failure (not a 404): the abort may never have reached
    // the server, so a claimed live child is withdrawn back to active
    // — its genuine terminal event still settles it. A 404 means dead
    // and never withdraws. Settled history is recorded, not disturbed.
    // Withdrawal additionally requires no newer abort to have landed
    // since the claim (F-R4: success is knowledge, failure is
    // ignorance — the newer success wins).
    if (claimed && store.retainedTasks.get(sessionId)?.state === "interrupted") {
      if (withdrawInterruptClaim(store, sessionId, claimTime, config)) {
        void safeLog(client, "warn", `Interrupt: abort failed for ${sessionId} (${abortMessage}); speculative claim withdrawn, child may still be live.`);
        return interruptAbortFailedActive(abortMessage);
      }
      recordAbortError(store, sessionId, abortMessage);
      return interruptAbortFailedRetained(abortMessage);
    }
    // A success record is never annotated with abort noise — the gap
    // belongs in the operator-visible report, not on the outcome.
    if (retained && retained.state !== "completed") recordAbortError(store, sessionId, abortMessage);
    const state = store.retainedTasks.get(sessionId)?.state ?? "unknown";
    return interruptAbortFailedSettled(abortMessage, state);
  }
  if (serverGone) {
    return interruptServerGone(sessionId);
  }
  if (!claimed && retained) {
    // A successful abort landing on settled history is stamped: a
    // concurrent interruptor's stale withdraw must observe it (F-R4).
    noteAbortLanded(store, sessionId);
    return interruptAlreadySettled(sessionId, retained.state);
  }
  // Successful abort on our own fresh claim: stamp it so a concurrent
  // stale withdraw cannot resurrect a dead child.
  noteAbortLanded(store, sessionId);
  return taskInterrupted(sessionId);
}
