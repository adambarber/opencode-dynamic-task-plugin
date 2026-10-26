// task_continue executor: steer a running child (turn replacement) or revive
// a settled one. Holds one of the three sanctioned session.abort sites
// (Tenet 9: beside the steer claim that orders it).

import { debugLog } from "../debug-logger.js";
import { deliverParent, fireChildPrompt, reviveWithPrompt } from "../entry/lifecycle.js";
import { admitToolPrompt } from "../shared/admission.js";
import { errorMessage } from "../shared/host-shape.js";
import { clearTurnReplacement, markTurnReplacement } from "../shared/notice-claim.js";
import { NotifyKind } from "../shared/notification-text.js";
import { abortSession, stopPlan } from "../shared/session-abort.js";
import type { SettledTaskState } from "../shared/task-records.js";
import {
  activeFor,
  isRunning,
  retainedFor,
  TaskState,
  transitionState,
} from "../shared/task-state.js";
import { textBlock } from "../shared/text-block.js";
import {
  followupSent,
  PROMPT_REQUIRED,
  steerAbortFailed,
  steerAutoRevived,
  steerMissing,
  steerSelfRefused,
  steerSent,
  steerSettledMidway,
  steerStateUnknown,
  steerWonBySettler,
  untrackedSession,
} from "../shared/voice.js";
import type { ContinueArgs } from "./args.js";
import { type ResolvedSessionScope } from "./context.js";

export type { ContinueArgs } from "./args.js";

export async function executeTaskContinue(scope: ResolvedSessionScope, args: ContinueArgs): Promise<string> {
  const { host, store, config, sessionId, callerSessionId } = scope;

  // The shared opening for a prompt-bearing tool: validate the prompt and model
  // before anything moves (a bad id fails without touching the task), then
  // prune retained history. The model override applies to revivals only — steers
  // keep the task's model (a mid-turn model swap is a new task, not a steer).
  const admission = admitToolPrompt(args, PROMPT_REQUIRED, store, config);
  if (!admission.ok) return admission.error;
  const admitted = admission.input;

  // The state a revival was auto-triggered from, or undefined when the parent
  // simply followed up on a settled task. Set by the M9 arm below and read by
  // the shared revival, so the two paths cannot drift in what they do.
  let autoRevivedFrom: SettledTaskState | undefined = undefined;

  const active = activeFor(store, sessionId);
  if (active) {
    // A steer is an abort and a prompt, so it is stopped by the same rule that stops
    // a child from interrupting itself — and it has to be asked BEFORE
    // `markTurnReplacement`, because that stamp is what suppresses the live turn's
    // terminal echo. A refused self-steer that armed it first would kill the child's
    // turn and then wait forever for a replacement turn that the refusal just said
    // would not be sent: the child reads `active` and the store reads mid-steer, and
    // neither fact points at the tool call that caused it.
    const selfSteer = stopPlan({ callerSessionId, store }, sessionId, false).refusal;
    if (selfSteer !== undefined) return steerSelfRefused(sessionId, selfSteer);

    // Steer: the parent speaks to a running child as a turn
    // replacement — stop, append, re-submit. Turn attribution is armed
    // synchronously (before any await) so the pre-steer turn's terminal
    // copies cannot settle the task before the abort lands, nor after it:
    // the lifecycle handler drops any ending the replacement turn has not
    // yet been seen working through, however many copies the host sends.
    // This path never settles: only the replacement turn's genuine
    // terminal event, or operator interruption, ends the task.
    markTurnReplacement(store, sessionId);
    const { serverGone, transportError: abortError } = await abortSession(
      { callerSessionId, host, store },
      sessionId,
    );
    if (serverGone) {
      // Nothing left to steer: the session is gone. Settle error so
      // the ledger never strands an active task with no server side —
      // unless a concurrent settler already won: its outcome (and its
      // notification) stands, and the report names it instead of
      // double-notifying an error over the winner.
      let weSettled = false;
      try { transitionState(store, sessionId, TaskState.Error); weSettled = true; } catch { /* settled concurrently */ }
      if (!weSettled) {
        const state = retainedFor(store, sessionId)?.state;
        if (state) {
          return steerWonBySettler(sessionId, state);
        }
        return steerStateUnknown(sessionId);
      }
      const missing = steerMissing(sessionId);
      void deliverParent(host, active.parentSessionId, sessionId, active.description, NotifyKind.Error, missing.notify)
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
    if (!isRunning(store, sessionId)) {
      // No disarm needed: the stamps live on the active record and
      // transitionState strips them, so nothing is armed anymore by construction.
      const settled = retainedFor(store, sessionId);
      if (settled && settled.state !== TaskState.Interrupted) {
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
      const steerText = textBlock(
        "[Parent steer — read before continuing.]",
        "The parent sent the following while you were running. Read it first, then continue your task with it in mind.",
        "",
        admitted.prompt,
      );
      fireChildPrompt(host, store, {
        agentName: active.agentName,
        childSessionId: sessionId,
        description: active.description,
        parentSessionId: active.parentSessionId,
        ...(active.requestedModel !== undefined ? { requestedModel: active.requestedModel } : {}),
      }, steerText);
      return steerSent(sessionId, active.agentLabel ?? active.agentName);
    }
  }

  // The one revival path: a settled task followed up with a message, and the
  // M9 auto-revive above, differ only in the sentence that announces them. So
  // does the settlement that resumes a child after a network blip — all three
  // go through `reviveWithPrompt`, which owns the three steps that must not be
  // spelled twice (revive, clear the settle-dedup, prompt).
  let task: { agentLabel?: string; agentName: string; childSessionId: string } | undefined = undefined;
  try {
    task = reviveWithPrompt(host, store, sessionId, admitted.prompt, config, admitted.modelOverride);
  } catch (error: unknown) {
    if (!retainedFor(store, sessionId)) {
      return untrackedSession(sessionId);
    }
    return `ERROR: ${errorMessage(error)}`;
  }

  return autoRevivedFrom
    ? steerAutoRevived(sessionId, task.agentLabel ?? task.agentName, autoRevivedFrom)
    : followupSent(task.childSessionId, task.agentLabel ?? task.agentName);
}
