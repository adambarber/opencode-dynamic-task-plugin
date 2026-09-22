// task_interrupt executor: synchronous settle-first claim, then the server
// abort. Holds one of the three sanctioned session.abort sites (Tenet 9:
// beside the interrupt claim that orders it).
import { errorMessage } from "../shared/session-lifecycle.js";
import { safeLog } from "../shared/notify.js";
import {
  transitionState,
  withdrawInterruptClaim,
  noteAbortLanded,
  recordAbortError,
} from "../shared/task-state.js";
import { missingSessionId, type ToolDeps } from "./context.js";

export interface InterruptArgs {
  session_id?: string | undefined;
}

export async function executeTaskInterrupt(deps: ToolDeps, args: InterruptArgs): Promise<string> {
  const { client, store, config } = deps;
  const missing = missingSessionId(args);
  if (missing) return missing;
  const sessionId = String(args.session_id ?? "");

  // Claim first, then touch the server: settling the task synchronously
  // means the idle/error events our own abort provokes can never be
  // misclaimed as a fresh completion by the lifecycle handler.
  const active = store.activeTasks.get(sessionId);
  let claimed = false;
  const claimTime = Date.now();
  if (active) {
    try { transitionState(store, sessionId, "interrupted"); claimed = true; } catch { /* settled concurrently */ }
  }

  let abortMessage: string | undefined;
  let serverGone = false;
  try {
    await client.session.abort({ path: { id: sessionId } });
  } catch (error: unknown) {
    const message = errorMessage(error);
    serverGone = message.includes("not found");
    abortMessage = serverGone ? undefined : message;
  }

  const retained = store.retainedTasks.get(sessionId);
  if (!claimed && !retained) {
    // Untracked: transient abort failures are simply the caller's
    // transport error; nothing of ours is at stake.
    if (abortMessage) return `ERROR: ${abortMessage}`;
    if (serverGone) return `ERROR: Session "${sessionId}" not found.`;
    return `Session ${sessionId} aborted (not a tracked task).`;
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
        return `ERROR: abort failed (${abortMessage}) — task left active; its lifecycle events will still settle it. Retry task_interrupt to abort again.`;
      }
      recordAbortError(store, sessionId, abortMessage);
      return `ERROR: abort failed (${abortMessage}) — task retained as interrupted; history preserved. Retry task_interrupt to abort again.`;
    }
    // A success record is never annotated with abort noise — the gap
    // belongs in the operator-visible report, not on the outcome.
    if (retained && retained.state !== "completed") recordAbortError(store, sessionId, abortMessage);
    const state = store.retainedTasks.get(sessionId)?.state ?? "unknown";
    return `ERROR: abort failed (${abortMessage}) — task already settled as ${state}; history preserved.`;
  }
  if (serverGone) {
    return `ERROR: Session "${sessionId}" not found — history preserved.`;
  }
  if (!claimed && retained) {
    // A successful abort landing on settled history is stamped: a
    // concurrent interruptor's stale withdraw must observe it (F-R4).
    noteAbortLanded(store, sessionId);
    return `Session ${sessionId} already settled as ${retained.state}; abort sent to the server, history preserved.`;
  }
  // Successful abort on our own fresh claim: stamp it so a concurrent
  // stale withdraw cannot resurrect a dead child.
  noteAbortLanded(store, sessionId);
  return `Session ${sessionId} interrupted.`;
}
