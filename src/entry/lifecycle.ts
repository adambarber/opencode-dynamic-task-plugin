// Child lifecycle (entry): the prompt-firing dance, parent delivery, and the
// terminal-event settlement handler. Owns every entry-side client.session
// call except spawn's create and the steer/interrupt aborts (Tenet 9: those
// stay in their tool executors beside the claims that order them).
import type { OpaqueHost } from "../shared/client.js";
import {
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  endedBadly,
  eventLooksDeleted,
  isParentless,
  UNKNOWN_PARENT,
} from "../shared/session-lifecycle.js";
import { debugLog } from "../debug-logger.js";
import {
  invokePrompt,
  classifyPromptError,
  hydrateLatestOutcome,
} from "../shared/prompt.js";
import { formatParentNotification, NotifyKind } from "../shared/notification-text.js";
import { classifyFailure, failureNote, FailureClass } from "../shared/failure-class.js";
import {
  notifyParent,
  safeLog,
  notifyRecord,
  recordNotification,
  settlementKind,
  gateLedger,
} from "../shared/notify.js";
import { declaredBlocked } from "../shared/notice-claim.js";
import {
  transitionState,
  recordSettledOutcome,
  terminalEventIsAttributable,
  isRunning,
  findTask,
  reviveRetainedTask,
  type TaskStore,
  type TaskIdentity,
  type TaskRecordBase,
  type ActiveTaskState,
  type SettlementVerdict,
  TaskState,
} from "../shared/task-state.js";
import { releaseWaitsFor, type DependencyWait } from "../shared/dispatch-wait.js";
import { resolveDependencies } from "../shared/admission.js";
import { waitsReleasedBody } from "../shared/voice.js";
import { transientResumeAvailable } from "../shared/transient-resume.js";
import { textBlock } from "../shared/text-block.js";
import { errorMessage } from "../shared/host-shape.js";
import type { AgentCapSource } from "../shared/caps.js";
import type { ModelOverride } from "../shared/prompt.js";

// One delivery helper for every settlement path (event, prompt failure):
// notification is fire-and-forget by contract — the gate owns retries, the
// ledger owns history, and a failed delivery is visible via the notification
// record, never a reason to disturb the caller's control flow. Always a
// Promise so every call site voids it the same way; the parentless path
// resolves false immediately after recording the non-delivery.
export function deliverParent(
  host: OpaqueHost,
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
  return notifyParent(host, parentSessionId, message, { childSessionId, kind });
}

export interface ChildRef extends TaskIdentity {
  requestedModel?: TaskRecordBase["requestedModel"];
}

// Fire a child prompt and own its failure path. The prompt resolving is NOT
// how a task settles — lifecycle events are. This catch exists only for
// delivery failures where no event will ever arrive (session vanished,
// transport rejected): without it a fired prompt leaves the ledger active
// and the parent silently deaf.
export function fireChildPrompt(host: OpaqueHost, store: TaskStore, task: ChildRef, prompt: string): void {
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
    void safeLog("warn", `Prompt delivery failed for ${task.childSessionId}: ${classified.message} (retryable: ${classified.retryable})`);
    if (classified.retryable) return;
    let settled = false;
    try {
      transitionState(store, task.childSessionId, TaskState.Error);
      settled = true;
    } catch { /* a lifecycle event won the settlement */ }
    if (settled) {
      // The requested model rides along so a bad id names its suspect.
      const modelSuffix = task.requestedModel
        ? `\nRequested model: ${task.requestedModel.providerID}/${task.requestedModel.modelID}`
        : "";
      void deliverParent(host, task.parentSessionId, task.childSessionId, task.description, NotifyKind.Error, `${classified.message}${modelSuffix}`)
        .then((delivered) => debugLog(task.parentSessionId, task.childSessionId, "prompt-error-notify", { delivered }));
    }
  };
  try {
    invokePrompt(host, task.childSessionId, prompt, routing, onPromptFailure);
  } catch (error: unknown) {
    onPromptFailure(error);
  }
}

/**
 * The ONE way a settled child is brought back to life, for both callers that do
 * it: a parent following up with `task_continue`, and a settlement that decides a
 * network blip is not worth telling the parent about.
 *
 * Three steps in a fixed order, and the order is the whole content:
 *
 *   1. `reviveRetainedTask` — the single move from settled back to running. It
 *      re-claims the child's concurrency slot (so a revival cannot exceed a cap,
 *      and cannot skip the check by coming from the automatic path), spends one
 *      unit of the child's resume budget, and publishes the new running record.
 *   2. `gateLedger.forgetChild` — a revived task is a FRESH settlement subject.
 *      Without this the child's next real outcome is deduplicated against the
 *      turn that already settled, and a child that recovers from a blip and then
 *      genuinely fails reports nothing, forever. That is the one failure this
 *      feature must be structurally unable to cause.
 *   3. `fireChildPrompt` — the child's new turn, carrying whatever asked for it.
 *
 * Written once because these three steps had two homes: the settlement path would
 * otherwise have been a second revival, and a second revival is a second place for
 * the dedup to be forgotten and a second place for the cap check to be skipped.
 *
 * Throws when the revival is refused (an unknown child, or one an operator
 * interrupted — which is never revived) and when no slot is free. Each caller
 * answers that in its own voice: a tool returns a sentence to the parent, and a
 * settlement falls back to REPORTING, which is the only safe direction to fail in.
 */
export function reviveWithPrompt(
  host: OpaqueHost,
  store: TaskStore,
  childSessionId: string,
  prompt: string,
  capSource: AgentCapSource | undefined,
  model?: ModelOverride | undefined,
): ActiveTaskState {
  const revived = reviveRetainedTask(store, childSessionId, capSource, model);
  gateLedger.forgetChild(childSessionId);
  fireChildPrompt(host, store, revived, prompt);
  return revived;
}

/**
 * Resume a child that died of a network blip. Answers WHETHER it happened, so
 * the settlement can fall through to reporting when it did not — a refused
 * revival (no slot free, the record gone, an operator's interrupt) must end in a
 * message to the parent, never in a task that is neither running nor reported.
 *
 * The child is told what happened and that nothing it was asked to do has
 * changed, because the alternative — a resumed child that assumes it was wrong
 * and starts redoing finished work — costs more than the blip did.
 */
function resumeAfterBlip(
  host: OpaqueHost,
  store: TaskStore,
  childSessionId: string,
  capSource: AgentCapSource | undefined,
): boolean {
  const text = textBlock(
    "[Resumed — your previous turn was cut off by a network or provider error, not by anything you did.]",
    "No work is lost and nothing you were asked to do has changed. Read back over your last few messages, work out what you had already finished, and continue from there.",
    "Do not start over. If you were mid-way through a tool call, check whether it actually took effect before repeating it.",
  );
  try {
    reviveWithPrompt(host, store, childSessionId, text, capSource);
    return true;
  } catch (error: unknown) {
    void safeLog("info", `Transient resume refused for ${childSessionId}: ${errorMessage(error)} — reporting the failure instead`);
    return false;
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
  if (endedBadly(input.status) || (input.event !== undefined && eventLooksDeleted(input.event))) {
    return TaskState.Error;
  }
  return input.declaredBlocked ? TaskState.Blocked : TaskState.Completed;
}

export async function settleRunningChild(
  host: OpaqueHost,
  store: TaskStore,
  childSessionId: string,
  signal: SettlementSignal,
  capSource?: AgentCapSource | undefined,
): Promise<boolean> {
  const { status, cause } = signal;
  // Turn attribution first, and the reason for it lives on the gate itself. It is
  // a question about the store rather than about a record in hand, so asking it
  // first also means a session this plugin has no record of costs one lookup
  // instead of two.
  if (!terminalEventIsAttributable(store, childSessionId)) {
    void safeLog("info", `Dropped unattributable ending for ${childSessionId}, staying active`);
    return false;
  }
  // "Still running" is asked of the store's ONE reader for "is this one of ours",
  // so a session id in the settled half is refused by the same door that refuses
  // an unknown one — and the record the settlement needs is the record the guard
  // was asked about, not a second lookup.
  const task = findTask(store, childSessionId);
  if (task?.state !== TaskState.Active) return false;
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
    void safeLog("info", `Lost settlement race for ${childSessionId}, dropping`);
    return false;
  }
  void safeLog("info", `Settled ${childSessionId} as ${verdict}`);

  const outcome = await hydrateLatestOutcome(host, childSessionId);
  // The kind IS the verdict: the wire vocabulary and the state vocabulary are
  // the same words, so a settled `blocked` cannot be announced as a success.
  let kind: NotifyKind = settlementKind(verdict);
  // The verdict the parent will actually hear, settled before anything is
  // recorded. A turn that ended `idle` over an errored stream is a failure, and
  // the correction and the classification must BOTH be taken from this final
  // value — classifying the host's original `idle` describes a state the record
  // is no longer in, which is how a structural failure ends up labelled "no
  // failure class" and the parent loses the one fact it needed.
  const concluded = verdict === TaskState.Completed && outcome.errorDetail
    ? TaskState.Error
    : verdict;
  // WHY, recorded on the same amendment that may correct the state. A parent that
  // inspects this child in an hour asks "was this the network or was this the
  // work", and only the record can answer it — the notification is a moment, and
  // moments do not survive. One write, not two: the common case for this
  // correction IS the common case for a class, since both come from a turn that
  // ended `idle` over an errored stream.
  const failure = classifyFailure(concluded, outcome.errorDetail);
  if (concluded !== verdict) {
    verdict = concluded;
    kind = NotifyKind.Error;
    if (!recordSettledOutcome(store, childSessionId, TaskState.Error, failure)) {
      void safeLog("info", `Late error already recorded for ${childSessionId}`);
    }
  } else if (failure !== FailureClass.None) {
    recordSettledOutcome(store, childSessionId, verdict, failure);
  }
  // Empty when the child said nothing: the renderer says so and names the reader,
  // which is truer than any stand-in word and cannot be mistaken for a quote.
  const latestText = outcome.text || outcome.errorDetail || "";

  // The settlement has claimed the child, so the record is settled and the parent
  // is owed an answer. Before spending that answer: was this failure the
  // network's, and is there budget left to try again without asking? A child that
  // dies of a socket reset has not done anything wrong, and a parent told about
  // it spends a turn investigating a network problem as if it were its own.
  //
  // So it is resumed instead, and nothing is sent. Every way this can be wrong
  // fails toward REPORTING rather than toward silence: a structural failure is
  // never resumed, a spent budget is never resumed, an unknown cap is never
  // resumed, and a refused revival falls through to the notice below. The child
  // that recovers tells the parent its real outcome, because the revival cleared
  // the settle-dedup (reviveWithPrompt) — a resume that left it in place would
  // swallow the next outcome too.
  if (transientResumeAvailable(store, childSessionId, verdict, outcome.errorDetail, capSource)) {
    const spent = findTask(store, childSessionId)?.transientResumes ?? 0;
    if (resumeAfterBlip(host, store, childSessionId, capSource)) {
      void safeLog("info", `Resumed ${childSessionId} after a transient failure (resume ${spent + 1} of budget)`);
      return true;
    }
  }

  // The outcome is the point of this message, so a read that could not be
  // made says so instead of letting "(completed)" stand in for a quote the
  // parent never received. The record is settled either way; task_result
  // remains the way to read what the child actually said.
  const unreadableNote = outcome.unreadable ? "\n\n(The child's transcript could not be read; read it with task_result.)" : "";
  // What told us it was over, when no event did. Names the loss of contact so a
  // vanished child is never read as a child whose work failed.
  const causeNote = cause ? `\n\n${cause}` : "";
  // WHY it failed, in words the parent can act on. A network blip and a broken
  // child arrive as the same host error string, and a parent who cannot tell
  // them apart either ignores real failures or root-causes a socket reset. The
  // class is decided once, by the classifier, and its wording lives beside it —
  // the two used to be separate (a boolean here appending a sentence about a
  // classification that did not exist), which is how the sentence stopped
  // describing the decision.
  const classNote = failureNote(failure, findTask(store, childSessionId)?.transientResumes ?? 0);
  // Detached: the synchronous claim above is the settlement guarantee;
  // delivery transport must never hold the event pump head-of-line.
  // Observability survives via the ledger record, logged on completion.
  // deliverParent is the single funnel for parent-directed writes: it
  // records parentless settlements instead of dialing a phantom session.
  void deliverParent(host, parentSessionId, childSessionId, childDescription, kind, `${latestText}${causeNote}${classNote}${unreadableNote}`)
    .then((delivered) => debugLog(parentSessionId, childSessionId, "completion-notify", { kind, delivered }));
  // The parent's answer to a settlement this child may have been an EDGE for is
  // not sent here. It is sent by the store's own retained-change sink, which every
  // settlement passes through whether it came through this function or not — see
  // releaseWaitsForSettled in entry/state.ts. Four of the five ways a task can end
  // settle from somewhere else, and "the one place a task settles" was a claim
  // about this function that four call sites quietly contradicted.
  return true;
}

/**
 * Tell every parent whose refused dispatch this settlement decided, grouped by
 * parent so one parent hears one message no matter how many of its waits this
 * edge released. The settlement claim is already taken, so this cannot fail
 * loudly: an unanswered hint leaves the parent waiting, which is exactly the
 * state this replaced — no worse, and the wait is already gone from the store.
 *
 * Takes the SETTLED EDGE as its argument rather than discovering it, because the
 * caller is the store's change sink and its whole claim is that it sees every
 * settlement: a function that found the edge for itself would be the second
 * derivation this hook exists to replace.
 */
export function releaseWaitingDispatches(
  host: OpaqueHost,
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
    void deliverParent(host, waitingParent, settledChildSessionId, "a dispatch you asked for", NotifyKind.Notice, body)
      .then((delivered) => debugLog(waitingParent, settledChildSessionId, "wait-released", { delivered }));
  }
}

export async function handleChildLifecycleEvent(
  host: OpaqueHost,
  store: TaskStore,
  event: unknown,
  capSource?: AgentCapSource | undefined,
): Promise<void> {
  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  if (store.activeTasks.get(childSessionId)) {
    await settleRunningChild(host, store, childSessionId, {
      status: getEventLifecycleStatus(event),
      event,
    }, capSource);
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
    if (!endedBadly(status)) return;
    if (retained.state !== TaskState.Completed) return;
    const outcome = await hydrateLatestOutcome(host, childSessionId);
    const current = store.retainedTasks.get(childSessionId);
    if (!current || current.state !== TaskState.Completed) return; // lost the escalation race
    // WHY, on the same amendment, and ONE decision read twice. A failure that
    // arrives after a reported success is the same failure the ordinary path
    // classifies, and omitting it made a network blip indistinguishable from
    // broken work on the one route where the parent has already been told
    // otherwise: the parent investigates a socket reset as if it were its own.
    // The transcript is in scope here — it was just read to build the notice —
    // so this costs a classifier call, not another read, and the record and the
    // notice below cannot disagree about what class it is.
    const failure = classifyFailure(TaskState.Error, outcome.errorDetail);
    recordSettledOutcome(store, childSessionId, TaskState.Error, failure);
    const errorDetail = outcome.errorDetail
      || (outcome.unreadable ? "(session vanished and its transcript could not be read)" : "(session vanished before output was readable)");
    const classNote = failureNote(failure, current.transientResumes ?? 0);
    void deliverParent(host, retained.parentSessionId, childSessionId, retained.description, NotifyKind.Error, `${errorDetail}${classNote ? `\n\n${classNote}` : ""}`)
      .then((delivered) => debugLog(retained.parentSessionId, childSessionId, "retained-late-error", { kind: NotifyKind.Error, delivered }));
  }
}
