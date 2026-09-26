// Child lifecycle (entry): the prompt-firing dance, parent delivery, and the
// terminal-event settlement handler. Owns every entry-side client.session
// call except spawn's create and the steer/interrupt aborts (Tenet 9: those
// stay in their tool executors beside the claims that order them).
import type { OpenCodeClient } from "../shared/client.js";
import {
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  eventLooksDeleted,
  isParentless,
  UNKNOWN_PARENT,
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
  safeLog,
  formatParentNotification,
  notifyRecord,
  recordNotification,
  type NotifyKind,
} from "../shared/notify.js";
import {
  transitionState,
  noteLateOutcome,
  declaredBlocked,
  terminalEventIsAttributable,
  isRunning,
  findTask,
  type TaskStore,
  type TaskIdentity,
  type TaskRecordBase,
  type SettlementVerdict,
} from "../shared/task-state.js";
import { releaseWaitsFor, type DependencyWait } from "../shared/dispatch-wait.js";
import { resolveDependencies } from "../shared/admission.js";
import { settlementFallback, waitsReleasedBody } from "../shared/voice.js";

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
  if (isParentless(parentSessionId)) {
    // Nowhere to deliver — but the non-delivery is recorded, so deafness is
    // distinguishable from "no event yet" in task_result.
    recordNotification(
      notifyRecord(
        { parentSessionId: parentSessionId || UNKNOWN_PARENT, childSessionId, kind },
        message,
        { attempts: 0, delivered: false },
      ),
    );
    return Promise.resolve(false);
  }
  return notifyParent(client, parentSessionId, message, { childSessionId, kind });
}

export interface ChildRef extends TaskIdentity {
  requestedModel?: TaskRecordBase["requestedModel"];
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

// The single settlement implementation for a RUNNING task, whatever told us it
// is over: the host's terminal event, or the boot pass that found no turn
// running for a task the last process left running. Both bring the host's own
// status word; the event brings the event itself (deletion is read from it),
// and the boot pass brings a `cause`, so the parent learns the difference
// between work that failed and a child this plugin lost track of. Two callers,
// one funnel — a second settlement path is how a record ends up `completed`
// with no notice.
export interface SettlementSignal {
  /** The host's own word: idle, error, deleted. */
  status: string;
  /** The event that carried it, when there was one. */
  event?: unknown;
  /** Why we are settling without an event. */
  cause?: string;
}

/**
 * The one place a turn's ending is interpreted.
 *
 * Three inputs, one named verdict, and no fallible intermediate state: the host
 * says what happened to the session, the event can carry a deletion the status
 * word has not caught up with, and the child can declare that it stopped because
 * it needs the parent. A failure outranks the declaration — a turn that broke is
 * a failure whatever it was waiting for — and any other ending that is not a
 * declared block is a completed turn, which is what the host's `idle` has always
 * meant here. The boot pass passes the same words, so a task that vanished
 * across a restart lands on `error` by the same rule as one that broke live.
 */
function settlementVerdict(input: {
  status: string;
  event: unknown;
  declaredBlocked: boolean;
}): SettlementVerdict {
  if (input.status === "error" || input.status === "deleted" || (input.event !== undefined && eventLooksDeleted(input.event))) {
    return "error";
  }
  return input.declaredBlocked ? "blocked" : "completed";
}

export async function settleRunningChild(
  client: OpenCodeClient,
  store: TaskStore,
  childSessionId: string,
  signal: SettlementSignal,
): Promise<boolean> {
  const { status, cause } = signal;
  // Turn attribution first, and the reason for it lives on the gate itself. It is
  // a question about the store rather than about a record in hand, so asking it
  // first also means a session this plugin has no record of costs one lookup
  // instead of two.
  if (!terminalEventIsAttributable(store, childSessionId)) {
    void safeLog(client, "info", `Dropped unattributable ending for ${childSessionId}, staying active`);
    return false;
  }
  // "Still running" is asked of the store's ONE reader for "is this one of ours",
  // so a session id in the settled half is refused by the same door that refuses
  // an unknown one — and the record the settlement needs is the record the guard
  // was asked about, not a second lookup.
  const task = findTask(store, childSessionId);
  if (task?.state !== "active") return false;
  // Synchronous claim — no awaits before this. transitionState is the one
  // settlement gate: the winner replaces the active entry, so every
  // competing writer's transition throws and bows out.
  //
  // ONE decision, in ONE named vocabulary, before anything is claimed: the
  // host's own word and the child's own declaration become a single verdict that
  // is already a state of the machine. Downstream — the claim, the notification
  // kind, the fallback wording — all read the verdict. Three parallel booleans
  // and a status string re-tested at each step is how a child that declared it
  // was blocked came to be reported as a completed success.
  let verdict = settlementVerdict({
    status,
    event: signal.event,
    declaredBlocked: declaredBlocked(store, childSessionId),
  });
  const parentSessionId = task.parentSessionId;
  const childDescription = task.description;
  try {
    transitionState(store, childSessionId, verdict);
  } catch {
    void safeLog(client, "info", `Lost settlement race for ${childSessionId}, dropping`);
    return false;
  }
  void safeLog(client, "info", `Settled ${childSessionId} as ${verdict}`);

  const outcome = await hydrateLatestOutcome(client, childSessionId);
  // The kind IS the verdict: the wire vocabulary and the state vocabulary are
  // the same words, so a settled `blocked` cannot be announced as a success.
  let kind: NotifyKind = verdict;
  if (verdict === "completed" && outcome.errorDetail) {
    verdict = "error";
    kind = "error";
    if (!noteLateOutcome(store, childSessionId, "error")) {
      void safeLog(client, "info", `Late error already recorded for ${childSessionId}`);
    }
  }
  const latestText = outcome.text || settlementFallback(verdict, outcome.errorDetail);
  // The outcome is the point of this message, so a read that could not be
  // made says so instead of letting "(completed)" stand in for a quote the
  // parent never received. The record is settled either way; task_result
  // remains the way to read what the child actually said.
  const unreadableNote = outcome.unreadable ? "\n\n(The child's transcript could not be read; read it with task_result.)" : "";
  // What told us it was over, when no event did. Names the loss of contact so a
  // vanished child is never read as a child whose work failed.
  const causeNote = cause ? `\n\n${cause}` : "";
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
  void deliverParent(client, parentSessionId, childSessionId, childDescription, kind, `${latestText}${causeNote}${resumeHint}${unreadableNote}`)
    .then((delivered) => debugLog(parentSessionId, childSessionId, "completion-notify", { kind, delivered }));
  // This settlement may also be the answer to a dispatch another parent was
  // refused. Released HERE — the one place a task settles — so a wait is
  // answered exactly when its edge is, and by the same predicate the gate
  // refused it on. A separate funnel would be a second readiness rule.
  releaseWaitingDispatches(client, store, childSessionId);
  return true;
}

/**
 * Tell every parent whose refused dispatch this settlement decided, grouped by
 * parent so one parent hears one message no matter how many of its waits this
 * edge released. The settlement claim is already taken, so this cannot fail
 * loudly: an unanswered hint leaves the parent waiting, which is exactly the
 * state this replaced — no worse, and the wait is already gone from the store.
 */
function releaseWaitingDispatches(
  client: OpenCodeClient,
  store: TaskStore,
  settledChildSessionId: string,
): void {
  const release = releaseWaitsFor(
    store,
    settledChildSessionId,
    (wait) => resolveDependencies(store, wait.dependsOn, wait.dependsOnSettled),
    (id) => isRunning(store, id),
  );
  if (release.ready.length === 0 && release.dead.length === 0) return;
  const byParent = new Map<string, DependencyWait[]>();
  for (const wait of [...release.ready, ...release.dead]) {
    const group = byParent.get(wait.parentSessionId) ?? [];
    group.push(wait);
    byParent.set(wait.parentSessionId, group);
  }
  for (const [waitingParent, waits] of byParent) {
    const body = waitsReleasedBody({
      ready: waits.filter((w) => release.ready.includes(w)),
      dead: waits.filter((w) => release.dead.includes(w)),
    });
    // A wait is a property of the PARENT's dispatch, so the child session id
    // this rides on is the edge that answered it — which is what lets the
    // parent see it next to the settlement that released it.
    void deliverParent(client, waitingParent, settledChildSessionId, "a dispatch you asked for", "notice", body)
      .then((delivered) => debugLog(waitingParent, settledChildSessionId, "wait-released", { delivered }));
  }
}

export async function handleChildLifecycleEvent(
  client: OpenCodeClient,
  store: TaskStore,
  event: unknown,
): Promise<void> {
  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  if (store.activeTasks.get(childSessionId)) {
    await settleRunningChild(client, store, childSessionId, {
      status: getEventLifecycleStatus(event),
      event,
    });
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
    const errorDetail = outcome.errorDetail
      || (outcome.unreadable ? "(session vanished and its transcript could not be read)" : "(session vanished before output was readable)");
    void deliverParent(client, retained.parentSessionId, childSessionId, retained.description, "error", errorDetail)
      .then((delivered) => debugLog(retained.parentSessionId, childSessionId, "retained-late-error", { kind: "error", delivered }));
  }
}
