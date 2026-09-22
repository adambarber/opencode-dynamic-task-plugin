// task_continue executor: steer a running child (turn replacement) or revive
// a settled one. Holds one of the three sanctioned session.abort sites
// (Tenet 9: beside the steer claim that orders it).
import { errorMessage } from "../shared/session-lifecycle.js";
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

export interface ContinueArgs {
  session_id?: string | undefined;
  prompt?: string | undefined;
}

export async function executeTaskContinue(deps: ToolDeps, args: ContinueArgs): Promise<string> {
  const { client, store, config } = deps;
  const missing = missingSessionId(args);
  if (missing) return missing;
  if (!args.prompt || typeof args.prompt !== "string") {
    return "ERROR: prompt is required and must be a non-empty string.";
  }

  if (args.prompt.length > 100000) {
    return `ERROR: Prompt too long (${args.prompt.length} chars). Max: 100000.`;
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
      // the ledger never strands an active task with no server side.
      try { transitionState(store, sessionId, "error"); } catch { /* settled concurrently */ }
      void deliverParent(client, active.parentSessionId, sessionId, active.description, "error", `Steer failed: session "${sessionId}" not found on the server.`)
        .then((delivered) => debugLog(active.parentSessionId, sessionId, "steer-missing-notify", { delivered }));
      return `ERROR: Session "${sessionId}" not found — steer failed; task settled as error, history preserved.`;
    }
    if (abortError) {
      // The abort may never have reached the server, so the turn may
      // still be running — a replacement prompt now would compete
      // with it instead of replacing it. Disarm the claim (the live
      // turn's genuine terminal event must still settle it) and stay
      // active without sending.
      consumeSteerPending(store, sessionId);
      return `ERROR: abort failed (${abortError}) — task left active; the running turn was not stopped, so no message was sent. Retry task_continue to steer again.`;
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
    return `Steer sent to ${sessionId} (@${active.agentName}): the running turn was stopped and the message was sent as the next turn. The task stays active; its outcome arrives as a dynamic-task-notify message.`;
  }

  let task;
  try {
    task = reviveRetainedTask(store, sessionId, config);
    // A revived task is a fresh settlement subject: clear its
    // settle-dedup so the next completion can be delivered.
    gateLedger.forgetChild(sessionId);
  } catch (error: unknown) {
    if (!store.retainedTasks.has(sessionId)) {
      return `ERROR: Session "${sessionId}" is not a tracked task. Use task_list to see tracked sessions, or dynamic_task to start a new one.`;
    }
    return `ERROR: ${errorMessage(error)}`;
  }

  fireChildPrompt(client, store, task, args.prompt);
  return `Follow-up sent to ${task.childSessionId} (@${task.agentName}). The reply arrives as a dynamic-task-notify message.`;
}
