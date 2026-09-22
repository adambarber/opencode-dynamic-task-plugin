// task_continue executor: steer a running child (turn replacement) or revive
// a settled one. Holds one of the three sanctioned session.abort sites
// (Tenet 9: beside the steer claim that orders it).
import { errorMessage } from "../shared/session-lifecycle.js";
import { parseModelOverride, describeModelShapeError } from "../shared/prompt.js";
import { debugLog } from "../debug-logger.js";
import { gateLedger } from "../shared/notify.js";
import {
  transitionState,
  pruneRetainedTasks,
  markSteerPending,
  consumeSteerPending,
  reviveRetainedTask,
} from "../shared/task-state.js";
import { deliverParent, fireChildPrompt } from "../entry/lifecycle.js";
import { missingSessionId, type ToolDeps } from "./context.js";
import {
  PROMPT_REQUIRED,
  promptTooLong,
  steerMissing,
  steerWonBySettler,
  steerStateUnknown,
  steerSettledMidway,
  steerAbortFailed,
  steerSent,
  untrackedSession,
  followupSent,
  steerAutoRevived,
} from "../shared/voice.js";

export interface ContinueArgs {
  session_id?: string | undefined;
  prompt?: string | undefined;
  model?: string | undefined;
}

export async function executeTaskContinue(deps: ToolDeps, args: ContinueArgs): Promise<string> {
  const { client, store, config } = deps;
  const missing = missingSessionId(args);
  if (missing) return missing;
  if (!args.prompt || typeof args.prompt !== "string") {
    return PROMPT_REQUIRED;
  }

  if (args.prompt.length > 100000) {
    return promptTooLong(args.prompt.length);
  }

  // Model shape is validated before anything moves: a bad id fails without
  // touching the task. The override applies to revivals only — steers keep
  // the task's model (a mid-turn model swap is a new task, not a steer).
  const modelOverride = parseModelOverride(args.model);
  const modelShapeError = describeModelShapeError(args.model);
  if (modelShapeError) {
    return `ERROR: ${modelShapeError}`;
  }

  pruneRetainedTasks(store, config);
  const sessionId = String(args.session_id ?? "");

  const active = store.activeTasks.get(sessionId);
  if (active) {
    // Steer: the parent speaks to a running child as a turn
    // replacement — stop, append, re-submit. The claim is armed
    // synchronously (before any await) so the pre-steer turn's
    // terminal event cannot settle the task before the abort lands;
    // the lifecycle handler consumes it and the task stays active.
    // This path never settles: only the replacement turn's genuine
    // terminal event, or operator interruption, ends the task.
    markSteerPending(store, sessionId);
    let abortError: string | undefined;
    let serverGone = false;
    try {
      await client.session.abort({ path: { id: sessionId } });
    } catch (error: unknown) {
      const message = errorMessage(error);
      serverGone = message.includes("not found");
      if (!serverGone) abortError = message;
    }
    if (serverGone) {
      // Nothing left to steer: the session is gone. Settle error so
      // the ledger never strands an active task with no server side —
      // unless a concurrent settler already won: its outcome (and its
      // notification) stands, and the report names it instead of
      // double-notifying an error over the winner.
      let weSettled = false;
      try { transitionState(store, sessionId, "error"); weSettled = true; } catch { /* settled concurrently */ }
      if (!weSettled) {
        const state = store.retainedTasks.get(sessionId)?.state;
        if (state) {
          return steerWonBySettler(sessionId, state);
        }
        return steerStateUnknown(sessionId);
      }
      const missing = steerMissing(sessionId);
      void deliverParent(client, active.parentSessionId, sessionId, active.description, "error", missing.notify)
        .then((delivered) => debugLog(active.parentSessionId, sessionId, "steer-missing-notify", { delivered }));
      return missing.report;
    }
    if (abortError) {
      // The abort may never have reached the server, so the turn may
      // still be running — a replacement prompt now would compete
      // with it instead of replacing it. Disarm the claim (the live
      // turn's genuine terminal event must still settle it) and stay
      // active without sending.
      consumeSteerPending(store, sessionId);
      return steerAbortFailed(abortError);
    }
    // Re-validate after the await: an event or an interrupt may have
    // settled the task while the abort was in flight. Firing the
    // replacement prompt now would launch an untracked turn on a settled
    // task's session and report a steer that never happened.
    if (!store.activeTasks.has(sessionId)) {
      // No disarm needed: the flag lives on the active record and
      // transitionState strips it, so nothing is armed anymore by construction.
      const settled = store.retainedTasks.get(sessionId);
      if (settled && settled.state !== "interrupted") {
        // M9: close the loop the abort-race opened. The abort landed, so the
        // session proved live — revive in this same call instead of demanding
        // a second round-trip. Interrupted stays terminal by doctrine.
        let revived;
        try {
          revived = reviveRetainedTask(store, sessionId, config, modelOverride);
          gateLedger.forgetChild(sessionId);
        } catch (error: unknown) {
          return `ERROR: ${errorMessage(error)}`;
        }
        fireChildPrompt(client, store, revived, args.prompt);
        return steerAutoRevived(sessionId, revived.agentName, settled.state);
      }
      return steerSettledMidway(settled?.state ?? "unknown");
    }
    // The turn is dead: fire the parent message as the next user turn.
    // Fire-and-forget like every prompt — the lifecycle event owns
    // settlement, and the prompt-failure path owns delivery failure.
    const steerText = [
      "[Parent steer — read before continuing.]",
      "The parent sent the following while you were running. Read it first, then continue your task with it in mind.",
      "",
      args.prompt,
    ].join("\n");
    fireChildPrompt(client, store, {
      childSessionId: sessionId,
      parentSessionId: active.parentSessionId,
      agentName: active.agentName,
      description: active.description,
      ...(active.requestedModel !== undefined ? { requestedModel: active.requestedModel } : {}),
    }, steerText);
    return steerSent(sessionId, active.agentName);
  }

  let task;
  try {
    task = reviveRetainedTask(store, sessionId, config, modelOverride);
    // A revived task is a fresh settlement subject: clear its
    // settle-dedup so the next completion can be delivered.
    gateLedger.forgetChild(sessionId);
  } catch (error: unknown) {
    if (!store.retainedTasks.has(sessionId)) {
      return untrackedSession(sessionId);
    }
    return `ERROR: ${errorMessage(error)}`;
  }

  fireChildPrompt(client, store, task, args.prompt);
  return followupSent(task.childSessionId, task.agentName);
}
