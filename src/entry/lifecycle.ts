// Child lifecycle (entry): the prompt-firing dance, parent delivery, and the
// terminal-event settlement handler. Owns every entry-side client.session
// call except spawn's create and the steer/interrupt aborts (Tenet 9: those
// stay in their tool executors beside the claims that order them).

import { debugLog } from "../debug-logger.js";
import { resolveDependencies } from "../shared/admission.js";
import type { AgentCapSource } from "../shared/caps.js";
import type { OpaqueHost } from "../shared/client.js";
import { type DependencyWait, releaseWaitsFor } from "../shared/dispatch-wait.js";
import { classifyFailure, FailureClass, failureNote } from "../shared/failure-class.js";
import { classifyLifecycleStatus, endedBadly, eventLooksDeleted, getEventLifecycleStatus, getSessionIdFromEvent, LifecycleStatus } from "../shared/host-events.js";
import { errorMessage } from "../shared/host-shape.js";
import type { SessionId } from "../shared/ids.js";
import { declaredBlocked } from "../shared/notice-claim.js";
import { formatParentNotification, NotifyKind } from "../shared/notification-text.js";
import {
  clearSettlementReservation,
  forgetChildDeliveryClaims,
  gateLedger,
  LogLevel,
  notifyParent,
  notifyRecord,
  recordNotification,
  reserveSettlementDebt,
  safeLog,
  settlementKind,
} from "../shared/notify.js";
import {
  classifyPromptError,
  type HydratedOutcome,
  hydrateLatestOutcome,
  invokePrompt,
  type ModelOverride,
} from "../shared/prompt.js";
import { isParentless, type ParentSession, UNKNOWN_PARENT } from "../shared/session-lifecycle.js";
import {
  type ActiveTaskState,
  activeFor,
  findTask,
  isRunning,
  recordSettledOutcome,
  retainedFor,
  reviveRetainedTask,
  type SettlementVerdict,
  type TaskIdentity,
  type TaskRecordBase,
  TaskState,
  type TaskStore,
  terminalEventIsAttributable,
  transitionState,
} from "../shared/task-state.js";
import { textBlock } from "../shared/text-block.js";
import { transientResumeAvailable } from "../shared/transient-resume.js";
import { waitsReleasedBody } from "../shared/voice.js";

// One delivery helper for every settlement path (event, prompt failure):
// notification is fire-and-forget by contract — the gate owns retries, the
// ledger owns history, and a failed delivery is visible via the notification
// record, never a reason to disturb the caller's control flow. Always a
// Promise so every call site voids it the same way; the parentless path
// resolves false immediately after recording the non-delivery.
export function deliverParent(
  host: OpaqueHost,
  parentSessionId: ParentSession,
  childSessionId: SessionId,
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
        { childSessionId, kind, parentSessionId: parentSessionId || UNKNOWN_PARENT },
        message,
        { attempts: 0, delivered: false },
      ),
    );
    return Promise.resolve(false);
  }
  return deliverOrContain(
    host,
    { childSessionId, kind, parentSessionId },
    message,
  );
}

// try/catch, not .then-only: the fire-and-forget contract above is true by
// construction — a rejected delivery (a failed durable read inside the claim
// walk, say) is recorded and logged, never a rejection the `.then`-only call
// sites would leave unhandled, which Node >= 15 answers by killing the host.
async function deliverOrContain(
  host: OpaqueHost,
  target: { childSessionId: SessionId; kind: NotifyKind; parentSessionId: SessionId },
  message: string,
): Promise<boolean> {
  try {
    return await notifyParent(host, target.parentSessionId, message, target);
  } catch (error: unknown) {
    recordNotification(notifyRecord(target, message, { attempts: 0, delivered: false }));
    void safeLog(
      LogLevel.Warn,
      `Dynamic task plugin: delivery of a ${target.kind} notification to parent ${target.parentSessionId} for task ${target.childSessionId} failed and was not retried: ${errorMessage(error)}`,
    );
    return false;
  }
}

// The settlement claim for a prompt delivery that failed NON-retryably:
// reserve the parent-owed debt the moment the claim lands, then deliver the
// failure notice. The reserve closes the same crash window the async settlement
// path has — the debt is a microtask from the claim, and leaving that gap open
// is a settled record with no debt and no delivery claim after a crash. Only
// the notice body changes here, so the two facts ride one named function rather
// than being spelled out in the failure closure.
function settlePromptDeliveryFailure(host: OpaqueHost, task: ChildRef, message: string): void {
  reserveSettlementDebt(
    { childSessionId: task.childSessionId, kind: NotifyKind.Error, parentSessionId: task.parentSessionId },
    task.description,
  );
  const modelSuffix = task.requestedModel
    ? `\nRequested model: ${task.requestedModel.providerID}/${task.requestedModel.modelID}`
    : "";
  void deliverParent(host, task.parentSessionId, task.childSessionId, task.description, NotifyKind.Error, `${message}${modelSuffix}`)
    .then((delivered) => debugLog(task.parentSessionId, task.childSessionId, "prompt-error-notify", { delivered }));
}

/**
 * Has this prompt been accepted / is a turn running for this child?
 *
 * A prompt delivery failure is only SURVIVABLE when a turn is actually running:
 * the child's own terminal event settles it later. But if the prompt was never
 * accepted — the initial dispatch, whose transport refused at fire time — no
 * turn ever starts and no terminal event will ever arrive, so returning on the
 * failure would strand the task Active, holding its concurrency slot forever
 * (issue #9). A freshly registered child has no turn-observation yet (no
 * `turnLiveAt`/`lastActivityAt`) and has not replaced a turn (`replacedAt`) or
 * taken a steer (`lastSteer`); every later prompt — a steer, a continuation, a
 * revival — rides a child that has already been seen in a turn or replaced one,
 * so its blips stay survivable.
 */
function promptTurnRunning(store: TaskStore, childSessionId: SessionId): boolean {
  const active = activeFor(store, childSessionId);
  if (active === undefined) return false;
  return (
    active.turnLiveAt !== undefined ||
    active.lastActivityAt !== undefined ||
    active.replacedAt !== undefined ||
    active.lastSteer !== undefined
  );
}

// The prompt-failure settlement writes just one state move, shared by the
// retryable-never-accepted arm and the non-retryable arm so neither re-spells
// the single-winner transition and its catch.
function settleError(store: TaskStore, childSessionId: SessionId): boolean {
  try {
    transitionState(store, childSessionId, TaskState.Error);
    return true;
  } catch {
    // A lifecycle event won the settlement.
    return false;
  }
}

export interface ChildRef extends TaskIdentity {
  requestedModel?: TaskRecordBase["requestedModel"];
  /** The inbox delivery verdict this prompt asks the host for, if any. */
  delivery?: "steer" | "queue";
}

// Fire a child prompt and own its failure path. The prompt resolving is NOT
// how a task settles — lifecycle events are. This catch exists only for
// delivery failures where no event will ever arrive (session vanished,
// transport rejected): without it a fired prompt leaves the ledger active
// and the parent silently deaf.
export function fireChildPrompt(host: OpaqueHost, store: TaskStore, task: ChildRef, prompt: string): void {
  const routing: { agent: string; delivery?: "steer" | "queue"; model?: { providerID: string; modelID: string } } = {
    agent: task.agentName,
    ...(task.delivery !== undefined ? { delivery: task.delivery } : {}),
    ...(task.requestedModel !== undefined ? { model: task.requestedModel } : {}),
  };
  // A delivery failure settles exactly once through the same gate the async
  // path uses. A NON-retryable failure always settles. A retryable failure
  // settles TOO when the prompt was never accepted (no turn is running, so no
  // terminal event will ever arrive and the task would otherwise strand Active
  // holding a slot, #9); it only survives when the child's turn is actually
  // running, because then the child's own terminal event settles it.
  const onPromptFailure = (error: unknown): void => {
    const classified = classifyPromptError(error);
    void safeLog(LogLevel.Warn, `Prompt delivery failed for ${task.childSessionId}: ${classified.message} (retryable: ${classified.retryable})`);
    // A transport blip (timeout, refused connection) says nothing about a child
    // whose turn is actually RUNNING — settling error there would deafen the
    // ledger to the child's genuine terminal event. But a blank on a prompt that
    // was never accepted (the initial dispatch, where no turn ever started, or
    // a revival whose resume prompt cannot land) has no terminal event coming
    // at all: retryable must still settle it, never strand it Active holding a
    // slot (#9). The class rides the notice so the parent can tell the blip
    // from broken work.
    if (classified.retryable && promptTurnRunning(store, task.childSessionId)) return;
    const settled = settleError(store, task.childSessionId);
    if (!settled) return;
    if (classified.retryable) {
      // The prompt was never accepted, so the class is known without a
      // transcript: the transport refused, and that is a transient blip.
      recordSettledOutcome(store, task.childSessionId, TaskState.Error, FailureClass.Transient);
      settlePromptDeliveryFailure(host, task, `${classified.message}\n\n${failureNote(FailureClass.Transient)}`);
      return;
    }
    settlePromptDeliveryFailure(host, task, classified.message);
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
 *   2. `gateLedger.forgetChild` and `forgetChildDeliveryClaims` — a revived task
 *      is a FRESH settlement subject, in this process and in any other sharing the
 *      project. Without this the child's next real outcome is deduplicated against
 *      the turn that already settled — in memory against the gate, on disk against
 *      the durable claim — and a child that recovers from a blip and then
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
  childSessionId: SessionId,
  prompt: string,
  capSource: AgentCapSource | undefined,
  model?: ModelOverride,
): ActiveTaskState {
  const revived = reviveRetainedTask(store, childSessionId, capSource, model);
  gateLedger.forgetChild(childSessionId);
  forgetChildDeliveryClaims(childSessionId);
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
  childSessionId: SessionId,
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
    void safeLog(LogLevel.Info, `Transient resume refused for ${childSessionId}: ${errorMessage(error)} — reporting the failure instead`);
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
  /** The host's word, read as this plugin's closed vocabulary. */
  status: LifecycleStatus;
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
// The words a settlement interprets, before any outcome is read.
interface SettlementFacts {
  status: LifecycleStatus;
  event: unknown;
  declaredBlocked: boolean;
}

function settlementVerdict(input: SettlementFacts): SettlementVerdict {
  if (endedBadly(input.status) || (input.event !== undefined && eventLooksDeleted(input.event))) {
    return TaskState.Error;
  }
  return input.declaredBlocked ? TaskState.Blocked : TaskState.Completed;
}

// The one interpreter both settlement arms share: a turn the
// transcript cannot back is not the success its status word claimed.
function settleOutcome(input: SettlementFacts & {
  outcome: HydratedOutcome;
  cause?: string | undefined;
  resumesSpent: number;
}): { verdict: SettlementVerdict; failure: FailureClass; text: string } {
  const base = settlementVerdict(input);
  const verdict =
    base === TaskState.Completed && (input.outcome.errorDetail || input.outcome.unreadable || input.outcome.text === "")
      ? TaskState.Error
      : base;
  // Empty content on an IDLE ending is the interruption signature — the resume
  // budget bounds it. An affirmative failure EVENT with no detail is the host's
  // verdict, and stays structural.
  const emptyTurn = input.status === LifecycleStatus.Idle && input.outcome.text === "" && !input.outcome.unreadable
    && !input.outcome.errorDetail && !input.outcome.retryAfterMs && !input.outcome.errorShape;
  const failure = emptyTurn
    ? FailureClass.Transient
    : classifyFailure(verdict, input.outcome.errorDetail, { errorShape: input.outcome.errorShape, retryAfterMs: input.outcome.retryAfterMs });
  const quote = input.outcome.text || input.outcome.errorDetail || "";
  const causeNote = input.cause ? `\n\n${input.cause}` : "";
  const classNote = failureNote(failure, input.resumesSpent);
  const unreadableNote = input.outcome.unreadable
    ? "\n\n(The child's transcript could not be read; read it with task_result.)"
    : "";
  const emptyNote = input.outcome.text === "" && !input.outcome.errorDetail && !input.outcome.unreadable
    ? "\n\nThe turn ended with no content — the child said nothing."
    : "";
  return { failure, text: `${quote}${causeNote}${classNote}${unreadableNote}${emptyNote}`, verdict };
}

export async function settleRunningChild(
  host: OpaqueHost,
  store: TaskStore,
  childSessionId: SessionId,
  signal: SettlementSignal,
  capSource?: AgentCapSource,
): Promise<boolean> {
  const { status, cause } = signal;
  // Turn attribution first, and the reason for it lives on the gate itself. It is
  // a question about the store rather than about a record in hand, so asking it
  // first also means a session this plugin has no record of costs one lookup
  // instead of two.
  if (!terminalEventIsAttributable(store, childSessionId)) {
    void safeLog(LogLevel.Info, `Dropped unattributable ending for ${childSessionId}, staying active`);
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
  const declared = declaredBlocked(store, childSessionId);
  const facts: SettlementFacts = {
    declaredBlocked: declared,
    event: signal.event,
    status,
  };
  let verdict = settlementVerdict(facts);

  // A host-initiated retry is pending: the turn is not over, and an idle
  // event must not settle it as Completed. Defer until a terminal
  // execution event (succeeded/failed/interrupted) arrives.
  if (status === LifecycleStatus.Idle) {
    const active = activeFor(store, childSessionId);
    if (active?.retryScheduledAt) {
      void safeLog(LogLevel.Info, `Deferred settlement for ${childSessionId}: retry pending`);
      return false;
    }
  }

  try {
    transitionState(store, childSessionId, verdict);
  } catch {
    void safeLog(LogLevel.Info, `Lost settlement race for ${childSessionId}, dropping`);
    return false;
  }
  void safeLog(LogLevel.Info, `Settled ${childSessionId} as ${verdict}`);

  // The settlement claim is durable; the parent-owed debt for it is taken NOW,
  // before the async work below — the process dying inside the transcript read
  // (up to 5s) must not leave a settled record with no debt and no delivery
  // claim. The reservation is a placeholder: its (child + kind) identity is
  // what the real debt `deliverParent` writes a moment later dedups against, so
  // it survives a crash and is replaced by the real notice when none comes.
  const reservedKind = settlementKind(verdict);
  const reservedDebt = {
    childSessionId,
    kind: reservedKind,
    parentSessionId: task.parentSessionId,
  };
  reserveSettlementDebt(reservedDebt, task.description);

  const outcome = await hydrateLatestOutcome(host, childSessionId);
  // The kind IS the verdict: the wire vocabulary and the state vocabulary are
  // the same words, so a settled `blocked` cannot be announced as a success.
  // The verdict the parent hears, settled before anything is recorded: an
  // errored stream or an unreadable transcript both correct a success.
  const settled = settleOutcome({
    ...facts,
    cause,
    outcome,
    resumesSpent: task.transientResumes ?? 0,
  });
  const kind: NotifyKind = settlementKind(settled.verdict);
  // The verdict the parent actually owes can differ from the one the claim
  // reserved: a transcript that corrected a claimed success escalates it to
  // error, and the kind is part of the debt identity. The old kind's placeholder
  // is cleared so it cannot survive as a stale duplicate beside the real debt,
  // and the new kind is reserved before any delivery is attempted — the debt a
  // crash in the gap leaves is still owed, just under the true kind.
  if (kind !== reservedKind) {
    clearSettlementReservation(reservedDebt);
    reserveSettlementDebt({ ...reservedDebt, kind }, task.description);
  }
  // WHY, recorded on the same amendment that may correct the state. A parent that
  // inspects this child in an hour asks "was this the network or was this the
  // work", and only the record can answer it — the notification is a moment, and
  // moments do not survive. One write, not two: the common case for this
  // correction IS the common case for a class, since both come from a turn that
  // ended `idle` over an errored stream.
  const {failure} = settled;
  if (settled.verdict !== verdict) {
    ({ verdict } = settled);
    if (!recordSettledOutcome(store, childSessionId, TaskState.Error, failure)) {
      void safeLog(LogLevel.Info, `Late error already recorded for ${childSessionId}`);
    }
  } else if (failure !== FailureClass.None) {
    recordSettledOutcome(store, childSessionId, verdict, failure);
  }

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
  if (transientResumeAvailable(store, childSessionId, { capSource, failure: settled.failure })) {
    const spent = findTask(store, childSessionId)?.transientResumes ?? 0;
    if (resumeAfterBlip(host, store, childSessionId, capSource)) {
      // A resumed child is NOT going to be told to the parent — the reservation
      // taken when the claim landed would otherwise survive as a stale durable
      // debt the next boot redelivers as a bogus "settled" notice for a task
      // that is running again. The revival cleared the settle-dedup; the owed
      // debt goes the same way.
      clearSettlementReservation({ childSessionId, kind, parentSessionId: task.parentSessionId });
      void safeLog(LogLevel.Info, `Resumed ${childSessionId} after a transient failure (resume ${spent + 1} of budget)`);
      return true;
    }
  }

  // Detached: the synchronous claim above is the settlement guarantee;
  // delivery transport must never hold the event pump head-of-line.
  // Observability survives via the ledger record, logged on completion.
  // deliverParent is the single funnel for parent-directed writes: it
  // records parentless settlements instead of dialing a phantom session.
  void deliverParent(host, task.parentSessionId, task.childSessionId, task.description, kind, settled.text)
    .then((delivered) => debugLog(task.parentSessionId, task.childSessionId, "completion-notify", { delivered, kind }));
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
  settledChildSessionId: SessionId,
): void {
  const release = releaseWaitsFor(store, settledChildSessionId, {
    isAdmissible: (wait: DependencyWait) => resolveDependencies(store, wait.dependsOn, wait.dependsOnSettled),
    stillRunning: (id: SessionId) => isRunning(store, id),
  });
  if (release.ready.length === 0 && release.dead.length === 0) return;
  const byParent = new Map<ParentSession, DependencyWait[]>();
  for (const wait of [...release.ready, ...release.dead]) {
    const group = byParent.get(wait.parentSessionId) ?? [];
    group.push(wait);
    byParent.set(wait.parentSessionId, group);
  }
  for (const [waitingParent, waits] of byParent) {
    const body = waitsReleasedBody({
      dead: waits.filter((w) => release.dead.includes(w)),
      ready: waits.filter((w) => release.ready.includes(w)),
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
  capSource?: AgentCapSource,
): Promise<void> {
  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  if (isRunning(store, childSessionId)) {
    await settleRunningChild(host, store, childSessionId, {
      event,
      status: classifyLifecycleStatus(getEventLifecycleStatus(event)),
    }, capSource);
    return;
  }

  const settledRecord = retainedFor(store, childSessionId);
  if (settledRecord) {
    // Late failures are the only amendment a settled record accepts: an event
    // contradicting a reported success escalates completed→error. Interrupted
    // and errored records are final — post-interrupt errors are our own
    // abort's echo, not a discovery, and escalating them would notify the
    // parent of a "failure" it deliberately caused.
    const status = classifyLifecycleStatus(getEventLifecycleStatus(event));
    if (!endedBadly(status)) return;
    if (settledRecord.state !== TaskState.Completed) return;
    const outcome = await hydrateLatestOutcome(host, childSessionId);
    const current = retainedFor(store, childSessionId);
    if (!current || current.state !== TaskState.Completed) return; // lost the escalation race
    // WHY, on the same amendment, and ONE decision read twice. A failure that
    // arrives after a reported success is the same failure the ordinary path
    // classifies, and omitting it made a network blip indistinguishable from
    // broken work on the one route where the parent has already been told
    // otherwise: the parent investigates a socket reset as if it were its own.
    // The transcript is in scope here — it was just read to build the notice —
    // so this costs a classifier call, not another read, and the record and the
    // notice below cannot disagree about what class it is.
    const settled = settleOutcome({
      declaredBlocked: declaredBlocked(store, childSessionId),
      event,
      outcome,
      resumesSpent: current.transientResumes ?? 0,
      status,
    });
    const kind = settlementKind(settled.verdict);
    recordSettledOutcome(store, childSessionId, settled.verdict, settled.failure);
    // The escalation's amendment is durable; the debt for it is taken now, so a
    // crash between the amendment and the debt's own write cannot leave a
    // record reading `error` with nothing owed. The real debt below overwrites
    // this placeholder by the same (child + kind) identity.
    reserveSettlementDebt(
      { childSessionId, kind, parentSessionId: settledRecord.parentSessionId },
      settledRecord.description,
    );
    void deliverParent(host, settledRecord.parentSessionId, childSessionId, settledRecord.description, kind, settled.text)
      .then((delivered) => debugLog(settledRecord.parentSessionId, childSessionId, "retained-late-error", { delivered, kind }));
  }
}
