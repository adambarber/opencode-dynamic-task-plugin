// Child lifecycle (entry): the prompt-firing dance, parent delivery, and the
// terminal-event settlement handler. Owns every entry-side client.session
// call except spawn's create and the steer/interrupt aborts (Tenet 9: those
// stay in their tool executors beside the claims that order them).
import type { OpenCodeClient } from "../shared/client.js";
import {
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  eventLooksDeleted,
} from "../shared/session-lifecycle.js";
import { debugLog } from "../debug-logger.js";
import {
  invokePrompt,
  classifyPromptError,
  isTransientOutcomeError,
  hydrateLatestOutcome,
} from "../shared/prompt.js";
import {
  notifyParent,
  resolveNotifyKind,
  safeLog,
  formatParentNotification,
  recordNotification,
  type NotifyKind,
} from "../shared/notify.js";
import {
  transitionState,
  noteLateOutcome,
  terminalEventIsAttributable,
  type TaskStore,
  type TaskState,
} from "../shared/task-state.js";

// One delivery helper for every settlement path (event, prompt failure):
// notification is fire-and-forget by contract — the gate owns retries, the
// ledger owns history, and a failed delivery is visible via the notification
// record, never a reason to disturb the caller's control flow. Always a
// Promise so every call site voids it the same way; the parentless path
// resolves false immediately after recording the non-delivery.
export function deliverParent(
  client: OpenCodeClient,
  parentSessionId: string,
  childSessionId: string,
  description: string,
  kind: NotifyKind,
  text: string,
): Promise<boolean> {
  const message = formatParentNotification({ childSessionId, description }, kind, text);
  if (!parentSessionId || parentSessionId === "unknown") {
    // Nowhere to deliver — but the non-delivery is recorded, so deafness is
    // distinguishable from "no event yet" in task_result.
    recordNotification({
      at: Date.now(),
      parentSessionId: parentSessionId || "unknown",
      childSessionId,
      kind,
      message,
      attempts: 0,
      delivered: false,
    });
    return Promise.resolve(false);
  }
  return notifyParent(client, parentSessionId, message, { childSessionId, kind });
}

export interface ChildRef {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  requestedModel?: { providerID: string; modelID: string } | undefined;
}

// Fire a child prompt and own its failure path. The prompt resolving is NOT
// how a task settles — lifecycle events are. This catch exists only for
// delivery failures where no event will ever arrive (session vanished,
// transport rejected): without it a fired prompt leaves the ledger active
// and the parent silently deaf.
export function fireChildPrompt(client: OpenCodeClient, store: TaskStore, task: ChildRef, prompt: string): void {
  const routing: { agent: string; model?: { providerID: string; modelID: string } } = {
    agent: task.agentName,
    ...(task.requestedModel !== undefined ? { model: task.requestedModel } : {}),
  };
  // A delivery failure settles exactly once through the same gate the async
  // path uses — but only a NON-retryable one. A transport blip (timeout,
  // refused connection) says nothing about the child: the turn may well be
  // running, and settling error here would deafen the ledger to the child's
  // genuine terminal event. Retryable failures leave the task active; the
  // only bound on a truly-dead child stays operator interruption.
  const onPromptFailure = (error: unknown): void => {
    const classified = classifyPromptError(error);
    void safeLog(client, "warn", `Prompt delivery failed for ${task.childSessionId}: ${classified.message} (retryable: ${classified.retryable})`);
    if (classified.retryable) return;
    let settled = false;
    try {
      transitionState(store, task.childSessionId, "error");
      settled = true;
    } catch { /* a lifecycle event won the settlement */ }
    if (settled) {
      // The requested model rides along so a bad id names its suspect.
      const modelSuffix = task.requestedModel
        ? `\nRequested model: ${task.requestedModel.providerID}/${task.requestedModel.modelID}`
        : "";
      void deliverParent(client, task.parentSessionId, task.childSessionId, task.description, "error", `${classified.message}${modelSuffix}`)
        .then((delivered) => debugLog(task.parentSessionId, task.childSessionId, "prompt-error-notify", { delivered }));
    }
  };
  try {
    invokePrompt(client, task.childSessionId, prompt, routing).catch(onPromptFailure);
  } catch (error: unknown) {
    onPromptFailure(error);
  }
}

export async function handleChildLifecycleEvent(
  client: OpenCodeClient,
  store: TaskStore,
  event: unknown,
): Promise<void> {
  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  const active = store.activeTasks.get(childSessionId);
  if (active) {
    // Turn attribution: a turn that REPLACED another (a steer, a revival) has a
    // prior turn's terminal copies possibly still in flight, and the host
    // publishes a turn end more than once. Until the replacement has been seen
    // doing something, a terminal event cannot be attributed to it and the task
    // stays active. A fresh spawn has no prior turn, so it always settles here.
    if (!terminalEventIsAttributable(store, childSessionId)) {
      void safeLog(client, "info", `Event handler: dropped unattributable ending for ${childSessionId}, staying active`);
      return;
    }
    // Synchronous claim — no awaits before this. transitionState is the one
    // settlement gate: the winner replaces the active entry, so every
    // competing writer's transition throws and bows out.
    const status = getEventLifecycleStatus(event);
    const failed = status === "error" || status === "deleted" || eventLooksDeleted(event);
    const provisional: TaskState = failed ? "error" : "completed";
    const parentSessionId = active.parentSessionId;
    const childDescription = active.description;
    try {
      transitionState(store, childSessionId, provisional);
    } catch {
      void safeLog(client, "info", `Event handler: lost settlement race for ${childSessionId}, dropping`);
      return;
    }
    void safeLog(client, "info", `Event handler: settled ${childSessionId} as ${provisional}`);

    const outcome = await hydrateLatestOutcome(client, childSessionId);
    // Kind follows the SETTLED outcome, not the raw status text: a deleted
    // session whose stale status still reads idle notifies error (F-R3).
    let kind: NotifyKind = failed ? "error" : (resolveNotifyKind(status) ?? provisional);
    if (kind === "completed" && outcome.errorDetail) {
      kind = "error";
      if (!noteLateOutcome(store, childSessionId, "error")) {
        void safeLog(client, "info", `Event handler: late error already recorded for ${childSessionId}`);
      }
    }
    const latestText = outcome.text || (kind === "error" ? outcome.errorDetail || "(error — no detail)" : "(completed)");
    // Transient failures name the resume path: a network/provider blip that
    // killed the turn usually resumes cleanly via task_continue, while a
    // fatal cause must not invite a blind retry. Advisory only — kind and
    // state are already decided above.
    const resumeHint = kind === "error" && isTransientOutcomeError(outcome.errorDetail)
      ? "\n\nThis failure looks transient (network/provider blip) — task_continue can usually resume the child from here."
      : "";
    // Detached: the synchronous claim above is the settlement guarantee;
    // delivery transport must never hold the event pump head-of-line.
    // Observability survives via the ledger record, logged on completion.
    // deliverParent is the single funnel for parent-directed writes: it
    // records parentless settlements instead of dialing a phantom session.
    void deliverParent(client, parentSessionId, childSessionId, childDescription, kind, `${latestText}${resumeHint}`)
      .then((delivered) => debugLog(parentSessionId, childSessionId, "completion-notify", { kind, delivered }));
    return;
  }

  const retained = store.retainedTasks.get(childSessionId);
  if (retained) {
    // Late failures are the only amendment a settled record accepts: an event
    // contradicting a reported success escalates completed→error. Interrupted
    // and errored records are final — post-interrupt errors are our own
    // abort's echo, not a discovery, and escalating them would notify the
    // parent of a "failure" it deliberately caused.
    const status = getEventLifecycleStatus(event);
    if (status !== "error" && status !== "deleted") return;
    if (retained.state !== "completed") return;
    const outcome = await hydrateLatestOutcome(client, childSessionId);
    const current = store.retainedTasks.get(childSessionId);
    if (!current || current.state !== "completed") return; // lost the escalation race
    noteLateOutcome(store, childSessionId, "error");
    const errorDetail = outcome.errorDetail || "(session vanished before output was readable)";
    void deliverParent(client, retained.parentSessionId, childSessionId, retained.description, "error", errorDetail)
      .then((delivered) => debugLog(retained.parentSessionId, childSessionId, "retained-late-error", { kind: "error", delivered }));
  }
}
