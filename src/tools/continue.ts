// task_continue executor: steer a running child (turn replacement) or revive
// a settled one. Holds one of the three sanctioned session.abort sites
// (Tenet 9: beside the steer claim that orders it).
import { abortSession, errorMessage } from "../shared/session-lifecycle.js";
import { admitPromptInput } from "../shared/prompt.js";
import { debugLog } from "../debug-logger.js";
import { gateLedger } from "../shared/notify.js";
import {
  transitionState,
  pruneRetainedTasks,
  markTurnReplacement,
  clearTurnReplacement,
  reviveRetainedTask,
} from "../shared/task-state.js";
import { deliverParent, fireChildPrompt } from "../entry/lifecycle.js";
import { type ResolvedSessionScope } from "./context.js";
import {
  PROMPT_REQUIRED,
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

export async function executeTaskContinue(scope: ResolvedSessionScope, args: ContinueArgs): Promise<string> {
  const { client, store, config, sessionId } = scope;

  // Prompt and model shape are validated before anything moves: a bad id
  // fails without touching the task. The override applies to revivals only —
  // steers keep the task's model (a mid-turn model swap is a new task, not a
  // steer).
  const admitted = admitPromptInput(args.prompt, args.model, PROMPT_REQUIRED);
  if (!admitted.ok) return admitted.error;
  const { prompt, modelOverride } = admitted.input;

  pruneRetainedTasks(store, config);

  // The state a revival was auto-triggered from, or undefined when the parent
  // simply followed up on a settled task. Set by the M9 arm below and read by
  // the shared revival, so the two paths cannot drift in what they do.
  let autoRevivedFrom: string | undefined;

  const active = store.activeTasks.get(sessionId);
  if (active) {
    // Steer: the parent speaks to a running child as a turn
    // replacement — stop, append, re-submit. Turn attribution is armed
    // synchronously (before any await) so the pre-steer turn's terminal
    // copies cannot settle the task before the abort lands, nor after it:
    // the lifecycle handler drops any ending the replacement turn has not
    // yet been seen working through, however many copies the host sends.
    // This path never settles: only the replacement turn's genuine
    // terminal event, or operator interruption, ends the task.
    markTurnReplacement(store, sessionId);
    const { serverGone, transportError: abortError } = await abortSession(client, sessionId);
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
      // with it instead of replacing it. Drop the attribution stamp (the
      // live turn's genuine terminal event must still settle it) and stay
      // active without sending.
      clearTurnReplacement(store, sessionId);
      return steerAbortFailed(abortError);
    }
    // Re-validate after the await: an event or an interrupt may have
    // settled the task while the abort was in flight. Firing the
    // replacement prompt now would launch an untracked turn on a settled
    // task's session and report a steer that never happened.
    if (!store.activeTasks.has(sessionId)) {
      // No disarm needed: the stamps live on the active record and
      // transitionState strips them, so nothing is armed anymore by construction.
      const settled = store.retainedTasks.get(sessionId);
      if (settled && settled.state !== "interrupted") {
        // M9: close the loop the abort-race opened. The abort landed, so the
        // session proved live — revive in this same call instead of demanding
        // a second round-trip. Falling through to the shared revival below,
        // which names the mid-steer settlement in its announcing sentence.
        autoRevivedFrom = settled.state;
      } else {
        return steerSettledMidway(settled?.state ?? "unknown");
      }
    } else {
      // The turn is dead: fire the parent message as the next user turn.
      // Fire-and-forget like every prompt — the lifecycle event owns
      // settlement, and the prompt-failure path owns delivery failure.
      const steerText = [
        "[Parent steer — read before continuing.]",
        "The parent sent the following while you were running. Read it first, then continue your task with it in mind.",
        "",
        prompt,
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
  }

  // The one revival path: a settled task followed up with a message, and the
  // M9 auto-revive above, differ only in the sentence that announces them.
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

  fireChildPrompt(client, store, task, prompt);
  return autoRevivedFrom
    ? steerAutoRevived(sessionId, task.agentName, autoRevivedFrom)
    : followupSent(task.childSessionId, task.agentName);
}
