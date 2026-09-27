// Shared task-state machine (Task 01 amendment): the single owner of task
// records and every lifecycle mutation. States: active until a settlement
// event arrives — the plugin arms no timers, so nothing else can settle a
// task, and terminal states never regress.
//
// Lifecycle map (every edge below goes through the function named on it):
//
//   active ──terminal event (transitionState)──▶ completed|error|interrupted ──▶ retained ──▶ pruned
//     │                                              ▲ completed ──noteLateOutcome──▶ error (only rewrite edge)
//     │                                              ├──blocked (declared needs_input)──▶ terminal, NOT rewritten:
//     │                                              │    nothing to correct — it never claimed success
//     │                                              └──revive (never interrupted)──▶ active, fresh startedAt
//     ├──interrupt: sync claim ──▶ interrupted (abort-transport failure may withdraw back to active)
//     └──steer claim ──▶ stays active (echo consumed; re-validated after abort)
//
// Durable across restart: retained records only (ledger). Active turns and
// delivery receipts are process memory.
//
// Late-error escalation: noteLateOutcome() is the only edge that rewrites a
// retained state (completed -> error).
//
// The transition result is deliberately plain — callers branch on
// `completed` (first terminal reporter wins) and throw to signal rejection.

import { LedgerChangeKind, type LedgerChange } from "./ledger-change.js";
import type { LaneConfigSource, DynamicTaskConfig } from "./config.js";
import type { WaitRegistry } from "./dispatch-wait.js";
import { liveLanes } from "./lane-overlay.js";
import type { ModelOverride } from "./prompt.js";
import { checkLaneCapacity, resolveLane, resolveLaneName, DEFAULT_CONFIG } from "./config.js";

/**
/**
 * What a mid-flight notice CLAIMS about the child's own state. It rides the ONE
 * child→parent channel (no purpose-specific tool): `progress` is information,
 * `needs_input` is the child saying this turn cannot finish without the parent.
 * The claim is what the settlement reads, so a child that ends its turn blocked
 * is recorded as blocked — the alternative was reporting it as a success.
 *
 * An enum rather than a string-literal union, because a union invites `claim
 * === "needs_input"` and a raw literal in a comparison is a rename that compiles
 * clean and a value nobody updates. The member is the value; the string is only
 * what crosses the wire.
 */
export enum NoticeClaim {
  Progress = "progress",
  NeedsInput = "needs_input",
}

// The claims, as data: the tool validates its argument against this list, so an
// unrecognized claim is refused rather than quietly downgraded to progress — a
// typo'd `needs_input` would settle the child as a success.
export const NOTICE_CLAIMS: readonly NoticeClaim[] = Object.values(NoticeClaim);

/**
 * Is this a claim? A predicate rather than a list lookup behind a cast: the tool
 * receives `unknown` from the host, and a cast is a promise that someone else
 * checked. This is the check, and it narrows the value in the same breath.
 */
export function isNoticeClaim(value: unknown): value is NoticeClaim {
  return typeof value === "string" && Object.values<string>(NoticeClaim).includes(value);
}

/**
 * A task's lifecycle state.
 *
 * `blocked` is a state of its own: the child ended its turn needing the parent's
 * answer. Not a success and not a failure — the child worked, it could not
 * finish, and the plugin recorded `completed` for exactly this case, a false
 * success claim about a task that delivered no result. It is terminal (the turn
 * is over) and revivable (the parent's answer is a new turn).
 *
 * An enum, not a string-literal union, for the same reason as NoticeClaim: a
 * union is an invitation to compare against a raw literal, and the wire string is
 * the only place a literal belongs.
 */
export enum TaskState {
  Active = "active",
  Completed = "completed",
  Error = "error",
  Blocked = "blocked",
  Interrupted = "interrupted",
}

// The states, as data: the durable reader validates a restored record against
// this list, so a state cannot be added to the machine and forgotten by the
// reader that has to understand it.
export const TASK_STATES: readonly TaskState[] = Object.values(TaskState);

/**
 * A settlement, named — and the names are the machine's OWN terminal states, so
 * a verdict is directly claimable, notifiable, and renderable without a second
 * lookup table translating between three parallel spellings of the same fact.
 *
 * `interrupted` is absent on purpose: it is claimed by the interrupt funnel, not
 * arrived at by a turn ending.
 */
export type SettlementVerdict = Extract<TaskState, TaskState.Completed | TaskState.Blocked | TaskState.Error>;

export type LineageStep = string;
export type LineagePath = LineageStep[];

// The identity and routing of a task: the store's record, the durable entry the
// loader narrows an untrusted file to, and the reference the plugin hands to the
// prompt path are one contract wearing three coats. Declared once, so a field
// added to a task is added here — a fourth coat is a fourth place a rename or a
// new required field silently fails to reach.
export interface TaskIdentity {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
}

// A model override as the parent spelled it, as a PAIR — the record, the route
// and the confirmation that renders it all need the same one, so it is named once
// where the parse that produces it lives (ModelOverride, in prompt.ts) rather than
// declared a second time beside the field that holds it. An inline spelling in
// each is three places for a rename to miss.
export interface TaskRecordBase extends TaskIdentity {
  startedAt: number;
  lineage: LineagePath;
  /**
   * The concurrency lane this task occupies a slot in. A routing fact, not
   * lifecycle: a revival keeps the lane its settled record was running in, so
   * the record and its re-admission are always counted against the same budget.
   */
  lane: string;
  requestedModel?: ModelOverride | undefined;
  dependsOn?: string[] | undefined;
  // Admission-time only: ids that needed settlement, not success, before this
  // task spawned. Persisted so status renders the full dependency picture.
  dependsOnSettled?: string[] | undefined;
}

// What admission registers: the record minus the clock the store owns. The
// advisory fields below are lifecycle-written, so a registration cannot set them.
export type NewTaskRegistration = Omit<TaskRecordBase, "startedAt">;

/**
 * The advisory fields — the ones a fresh process cannot verify, and so the only
 * ones that may never reach disk. A mid-flight notice and an activity heartbeat
 * belong to the process that observed them, and turn attribution belongs to
 * in-flight events that died with it: a fresh boot that inherited any of them
 * would be trusting a claim it cannot verify — and would re-persist a heartbeat on
 * every host event, putting a file write in the event head.
 *
 * The list lives HERE, exported, because three readers need it: the strip below,
 * the durable write, and the suite that has to prove the strip happens. It was
 * written out in the settle path and again on the durable write, in different
 * orders, and a fifth advisory field added to the record had to be remembered in
 * both places — while the tests, which named their advisories one case at a time,
 * would not have covered the fifth at all.
 */
export const ADVISORY_FIELDS = ["lastNotice", "lastActivityAt", "turnLiveAt", "replacedAt"] as const;

/** A compile-time proof that ADVISORY_FIELDS is the whole advisory set. Add a fifth
 *  advisory to the record and this stops being `never`, so the build fails until the
 *  list names it — which is the point of declaring the list in one place. */
type UnlistedAdvisory = Exclude<
  keyof ActiveTaskState,
  "state" | keyof TaskRecordBase | (typeof ADVISORY_FIELDS)[number]
>;
const everyAdvisoryIsListed: UnlistedAdvisory extends never ? true : never = true;
void everyAdvisoryIsListed;

/** The object minus the named keys, typed — the one way this repo drops a field. */
function omit<T extends object, K extends keyof T>(record: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...record } as Record<PropertyKey, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

export function withoutAdvisory(record: ActiveTaskState): TaskRecordBase {
  return omit(record, ADVISORY_FIELDS);
}

export interface ActiveTaskState extends TaskRecordBase {
  state: TaskState.Active;
  // Latest mid-flight notice from the child (advisory metadata, not a lifecycle
  // field). `claim` is what the child said about itself: `needs_input` means
  // this turn is ending because it needs the parent, and the settlement reads it
  // to record `blocked` instead of a false success. Last one wins, so a child
  // that declares a block and then reports progress is believed again.
  lastNotice?: { message: string; at: number; claim: NoticeClaim } | undefined;
  // Latest time the host emitted ANY event for this child's session — the
  // event funnel's own proof the turn is moving. Without it "last activity"
  // could only mean "spawned" or "called task_notify", so a child working
  // through a long tool chain read as silent since spawn. Advisory like the
  // notice: never a lifecycle field, stripped at settlement so the durable
  // ledger carries no heartbeat.
  lastActivityAt?: number | undefined;
  /**
   * Turn attribution, part 1. Stamped ONLY when this turn REPLACED a previous
   * turn on the same session (a steer, a revival) — a fresh spawn has no prior
   * turn whose ending could still be in flight.
   *
   * A turn end is published more than once by the host (the status channel and
   * the idle event each say the turn ended), and those copies can still be in
   * flight when a replacement is dispatched. Until the replacement shows a life
   * sign, no terminal event can be attributed to it — see
   * `terminalEventIsAttributable`, the one gate that decides this.
   */
  replacedAt?: number | undefined;
  /**
   * Turn attribution, part 2: the last moment the CURRENT turn was observed
   * doing something. Terminal events do not count — a turn ENDING is not the
   * turn working, and counting it is what let an echo vouch for itself.
   */
  turnLiveAt?: number | undefined;
  // Parent steer in flight: set synchronously by task_continue before aborting
  // the running turn, consumed by the lifecycle handler to suppress that
  // turn's terminal echo. Advisory, never a lifecycle mutation — the task
  // stays active either way, and settlement strips it.
}

export interface RetainedTaskState extends TaskRecordBase {
  state: Exclude<TaskState, TaskState.Active>;
  retainedAt: number;
  abortError?: string | undefined;
  // Last successful abort landing on this record. Guards withdrawInterruptClaim
  // against concurrent interrupts (F-R4): a stale claim never resurrects a
  // child a newer abort already killed. Transient bookkeeping, not ledger
  // truth — the reader drops it on load.
  lastAbortAt?: number | undefined;
}

export type TaskRecord = ActiveTaskState | RetainedTaskState;

/**
 * The wait registry's map is a store field because the store is the only thing
 * that outlives a single tool call, but the waits themselves are a separate
 * subject and live in ./dispatch-wait.js — see WaitRegistry there for why the
 * store is passed to that module structurally rather than by import.
 */
export interface TaskStore extends WaitRegistry {
  activeTasks: Map<string, ActiveTaskState>;
  retainedTasks: Map<string, RetainedTaskState>;
  // Durable-state observer (Task 06): invoked after retained entries change.
  onRetainedChange?: LedgerChangeSink | undefined;
  // Durable-state observer (Task 11): invoked when a task STARTS or STOPS being
  // a running task — the set of what a crash would leave behind. Separate from
  // onRetainedChange because the two halves persist for different reasons, and
  // joined here so a settlement writes the whole file exactly once.
  onActiveChange?: LedgerChangeSink | undefined;
}

/**
 * How the store tells its durable writer WHAT changed. Named once because the two
 * observers share a shape and a reason, and a reader who meets the signature
 * spelled out twice has to work out whether the halves really are one contract.
 */
export type LedgerChangeSink = (changes: readonly LedgerChange[]) => void;

// The one write path into the running set. Every structural change to a live
// task goes through here, so the durable ledger has exactly one place to learn
// that a task exists or stopped existing — and, just as deliberately, one place
// the advisory writers below do NOT touch: a heartbeat or a mid-flight notice
// would otherwise put a file write on every host event, turning the event head
// into a filesystem hot path. The advisory fields are stripped on the way to
// disk anyway (durableActiveTask), because a fresh process cannot verify them.
function setActive(store: TaskStore, childSessionId: string, record: ActiveTaskState): void {
  store.activeTasks.set(childSessionId, record);
  store.onActiveChange?.([{ kind: LedgerChangeKind.Running, id: childSessionId, record }]);
}

function removeActive(store: TaskStore, childSessionId: string): void {
  store.activeTasks.delete(childSessionId);
  store.onActiveChange?.([{ kind: LedgerChangeKind.Stopped, id: childSessionId }]);
}

// State machine (the one true lifecycle matrix). Active tasks move to a terminal
// state exactly once; terminal states never regress. Late error escalation
// (completed -> error) is a SEPARATE, explicitly-marked edge handled by
// noteLateOutcome, NOT by transitionState — this keeps the primary "does a
// transition happen at all" question decidable from this matrix alone.
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  [TaskState.Active]: [TaskState.Completed, TaskState.Error, TaskState.Blocked, TaskState.Interrupted],
  [TaskState.Completed]: [],
  [TaskState.Error]: [],
  [TaskState.Blocked]: [],
  [TaskState.Interrupted]: [],
};

// Withdraw a speculative interrupt claim after an abort transport failure
// (F2): the abort may never have reached the server, so the child may still
// be live — it returns to active and stays settable by its genuine terminal
// event. Refuses when the slot is gone (no over-subscription past
// maxConcurrent) or when a newer abort already landed (F-R4: success is
// knowledge, failure is ignorance — the newer success wins). A 404 means
// dead and never withdraws; operator revival of interrupted tasks stays
// forbidden (reviveRetainedTask still throws) — this edge is internal to
// task_interrupt's failure path, not a policy change. Persists via the
// ledger observer like every other retained mutation.
export function withdrawInterruptClaim(
  store: TaskStore,
  childSessionId: string,
  claimTimeMs: number,
  bounds?: LaneConfigSource,
): boolean {
  return decideRetained(store, childSessionId, (retained) => {
    if (retained.state !== TaskState.Interrupted) return false;
    // >= not >: a successful abort landing in the same millisecond as the
    // claim is still knowledge — the newer (or same-instant) success wins.
    if ((retained.lastAbortAt ?? 0) >= claimTimeMs) return false;
    // Reclaiming is a slot claim, judged in the lane the record was in.
    if (
      bounds &&
      checkLaneCapacity(
        { laneActive: laneActiveCount(store, retained.lane), totalActive: store.activeTasks.size },
        resolveLane(bounds, retained.lane),
        bounds.maxConcurrent,
      )
    ) {
      return false;
    }
    // No turn attribution: a withdrawal UNDOES a claim about this very turn, so
    // the turn is still live and its own ending settles it like any other.
    reclaimAsActive(store, childSessionId, retained);
    return true;
  });
}

/**
 * The move from settled back to running. A revival and a withdrawn interrupt
 * claim are the same move with different bookkeeping, so it is written once: the
 * settled-only fields are dropped here rather than each caller listing which ones
 * it remembered — one of them had been carrying a stale `lastAbortAt` onto the
 * running record, where nothing can read it — and the two maps are moved in the
 * only order that cannot be observed half-done.
 *
 * The caller still owes the publish: dropping a settled record IS a retained
 * mutation, and the durable ledger is written from that event.
 */
function reclaimAsActive(
  store: TaskStore,
  childSessionId: string,
  retained: RetainedTaskState,
  overrides: Partial<ActiveTaskState> = {},
): ActiveTaskState {
  const { state: _settled, retainedAt: _at, abortError: _err, lastAbortAt: _abort, ...carried } = retained;
  const reclaimed: ActiveTaskState = { ...carried, state: TaskState.Active, ...overrides };
  store.retainedTasks.delete(childSessionId);
  setActive(store, childSessionId, reclaimed);
  return reclaimed;
}

/**
 * The ONE way a retained (settled) record is read for a decision. All three
 * halves are load-bearing and none is the caller's business: a record that is
 * gone must be a no-op, a decision that declines itself must publish nothing,
 * and a decision that DID act must publish through the retained funnel, because
 * the durable ledger is written from that event. A mutation that skipped the
 * publish left a persisted record disagreeing with the store — a settled task
 * that comes back wrong after a restart.
 *
 * The decision is one predicate over the record and nothing more: stamping an
 * abort, annotating a notice, and withdrawing an interrupt claim are all "look,
 * decide, act", so the lookup and the publish are not three callers' chance to
 * spell them differently.
 */
function decideRetained(
  store: TaskStore,
  childSessionId: string,
  amend: (retained: RetainedTaskState) => boolean,
): boolean {
  const retained = retainedFor(store, childSessionId);
  if (retained === undefined) return false; // nothing settled to edit
  if (!amend(retained)) return false; // the amendment declined itself
  emitRetainedChange(store);
  return true;
}

// Stamp a successful abort landing on a retained record (F-R4): concurrent
// interruptors observe it through withdrawInterruptClaim's guard.
export function noteAbortLanded(store: TaskStore, childSessionId: string): boolean {
  return decideRetained(store, childSessionId, (retained) => {
    retained.lastAbortAt = Date.now();
    return true;
  });
}

export function createTaskStore(): TaskStore {
  return {
    activeTasks: new Map(),
    retainedTasks: new Map(),
    waits: new Map(),
    onRetainedChange: undefined,
    onActiveChange: undefined,
  };
}

/**
 * The one place a slot is claimed.
 *
 * A fresh registration and a revival compete for the same limit, and this
 * function is why they cannot disagree: the comment on registerActiveTask used
 * to claim the check lived in a choke point, while reviveRetainedTask spelled
 * the same check out a few lines away with its own `if (config)` guard. Two
 * spellings of one budget, and the one nobody re-reads was the revival door —
 * which is how maxConcurrent gets oversubscribed by continuing a task instead of
 * spawning one.
 *
 * An absent config is a caller that does not enforce the limit at all (a
 * revival path with no config in hand), not a limit of zero, so it returns
 * rather than refusing.
 */
/** Running tasks occupying a slot in one lane. */
export function laneActiveCount(store: TaskStore, lane: string): number {
  let count = 0;
  for (const record of store.activeTasks.values()) {
    if (record.lane === lane) count++;
  }
  return count;
}

/**
 * The store's ONE lane capacity judgment: the refusal text for admitting into
 * this lane, or null when there is room.
 *
 * Two callers need this and neither may own it. The authoritative gate claims a
 * slot and throws; the spawn tool checks BEFORE creating a session, because
 * refusing after the session exists orphans an untracked child on the server.
 * Same inputs, same answer, one function — the second caller asking its own
 * question here is how an advisory check and the gate that overrides it come to
 * disagree about what "full" means.
 *
 * It is also where LIVE policy enters, deliberately: this is the one function
 * every claim goes through — a fresh spawn, a revival re-claiming its lane, the
 * boot restore — so resolving the overlay here means an operator's edit applies
 * to every claim without any of those callers knowing a project directory exists.
 * Resolving it at the tool instead would leave a revival judged against the cap
 * that was frozen at boot, which is the inconsistency an operator hits the first
 * time they raise a cap and then revive something.
 */
export function laneCapacityRefusal(
  store: TaskStore,
  lane: string,
  config: LaneConfigSource | undefined,
): string | null {
  if (!config) return null;
  const policy = liveLanes(config);
  return checkLaneCapacity(
    { laneActive: laneActiveCount(store, lane), totalActive: store.activeTasks.size },
    resolveLane(policy, lane),
    policy.maxConcurrent,
  );
}

/**
 * The authoritative claim on a slot, for both callers that must not proceed
 * without one: a fresh registration, and a revival re-claiming the lane its
 * settled record was running in. The record decides the lane, so a charge can
 * never be aimed at a lane other than the one the task belongs to.
 */
function claimSlot(store: TaskStore, record: { readonly lane: string }, config: LaneConfigSource | undefined): void {
  const limitError = laneCapacityRefusal(store, record.lane, config);
  if (limitError) throw new Error(limitError);
}

/**
 * The record a registration makes. Extracted from registerActiveTask so the one
 * construction is named: a fixture built here is the record production builds,
 * not a hand-rolled copy of it that can agree about the field list for a while
 * and then stop.
 */
export function activeRecord(registration: NewTaskRegistration, startedAt: number): ActiveTaskState {
  return { ...registration, state: TaskState.Active, startedAt };
}

/**
 * The record a settlement leaves behind, which is the active record with the
 * advisories stripped — the same strip the durable write performs, so a fixture
 * for "what a settlement leaves on disk" cannot disagree with it about which
 * fields those are.
 */
export function retainedRecord(
  active: ActiveTaskState,
  state: Exclude<TaskState, TaskState.Active>,
  retainedAt: number,
): RetainedTaskState {
  return { ...withoutAdvisory(active), state, retainedAt };
}

// Register a task and claim the session id atomically. Every active task holds a
// slot regardless of who awaits it, and the slot comes from claimSlot.
export function registerActiveTask(
  store: TaskStore,
  task: NewTaskRegistration,
  config: LaneConfigSource,
): ActiveTaskState {
  // The lane is resolved HERE, once, on the way in. Four things charge it — the
  // slot claim below, the record, the durable write, and a later revival's
  // re-claim — and the field is declared required while every JavaScript caller
  // is free to omit it. Normalizing at this boundary is what makes the four
  // agree: without it a registration that omits the lane leaves all four holding
  // `undefined`, and a revived task is re-admitted against a lane that does not
  // exist. The normalization is idempotent, so resolving an already-resolved
  // lane costs nothing.
  const registration = { ...task, lane: resolveLaneName(task.lane) };
  claimSlot(store, registration, config);
  const record = activeRecord(registration, Date.now());
  setActive(store, task.childSessionId, record);
  return record;
}

// Lifecycle mutation choke point. The from-state is read from the store under
// the single-winner claim. Returns the post-move record (active: the entry;
// terminal: the retained entry). Throws on any rejected transition:
//  - no task for the id,
//  - a terminal state that cannot regress,
//  - a from/to pair absent from VALID_TRANSITIONS.
// Callers branch on `.completed` (first terminal reporter wins) — the
// rejected-transition shape is not the caller's problem.
export function transitionState(
  store: TaskStore,
  childSessionId: string,
  to: Exclude<TaskState, TaskState.Active>,
): { state: TaskState; completed: boolean; task?: ActiveTaskState | RetainedTaskState } {
  const active = store.activeTasks.get(childSessionId);
  if (active) {
    const allowed: TaskState[] = VALID_TRANSITIONS[active.state] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition: ${active.state} → ${to}`);
    }
          const retained = retainedRecord(active, to, Date.now());
    removeActive(store, childSessionId);
    store.retainedTasks.set(childSessionId, retained);
    emitRetainedChange(store, { kind: LedgerChangeKind.Settled, id: childSessionId, record: retained });
    return { state: to, completed: true, task: retained };
  }

  // No active entry — reject based on the retained state, if any.
  const retained = retainedFor(store, childSessionId);
  if (retained) {
    throw new Error(`Invalid transition: terminal state (${retained.state})`);
  }
  throw new Error(`Invalid transition: not found (no task for ${childSessionId})`);
}

// Late-error escalation — the ONE edge that rewrites a retained state.
// Only a recorded success can be corrected to error: an interrupted or
// errored task's own abort aftermath must never re-notify the parent.
export function noteLateOutcome(store: TaskStore, childSessionId: string, outcome: Exclude<TaskState, TaskState.Active>): boolean {
  return decideRetained(store, childSessionId, (retained) => {
    if (retained.state !== TaskState.Completed || outcome !== TaskState.Error) return false;
    retained.state = outcome;
    return true;
  });
}

// Continuation revival: a settled task earns a live turn by moving back to
// active through this gate — the same slot accounting as a fresh spawn, the
// same single-winner settlement when its next idle event lands. The old
// retained history is replaced by the revived record, not duplicated. An
// explicit model replaces the retained one for the new turn (revive-only:
// steers keep the task's model); omitted keeps it.
export function reviveRetainedTask(
  store: TaskStore,
  childSessionId: string,
  config?: LaneConfigSource,
  model?: ModelOverride | undefined,
): ActiveTaskState {
  const retained = retainedFor(store, childSessionId);
  if (!retained) {
    throw new Error(`Invalid transition: not found (no task for ${childSessionId})`);
  }
  if (retained.state === TaskState.Interrupted) {
    throw new Error(`Task ${childSessionId} was interrupted by request; interrupted children are not revived — spawn a fresh dynamic_task instead.`);
  }
  // The lane the settled record was running in, not a fresh default: a revival
  // re-claims a slot, and charging it to a different lane than the one it
  // occupied is how a capped lane gets filled by its own recovered children.
  claimSlot(store, retained, config);
  const revived = reclaimAsActive(store, childSessionId, retained, {
    // A revival REPLACES the turn, so the clock restarts: this is a new turn of
    // the same child, not the continuation of the one that ended.
    startedAt: Date.now(),
    // A revival replaces the turn that just ended, and a turn end is published
    // more than once — a copy can still be in flight when the new prompt fires.
    // Stamped here, in the one place a revival happens, so that copy cannot
    // settle the revival and report it completed before it has begun.
    replacedAt: Date.now(),
    ...(model !== undefined ? { requestedModel: model } : {}),
  });
  emitRetainedChange(store);
  return revived;
}

// The single writer for advisory fields on the active record. Notice, activity
// and steer claims are metadata the read side may consult and no lifecycle
// transition reads, so they are one funnel: an untracked id writes nothing and
// reports false, and no writer can quietly mutate a lifecycle field instead.
function annotateActive(
  store: TaskStore,
  childSessionId: string,
  apply: (active: ActiveTaskState) => void,
): boolean {
  const active = activeFor(store, childSessionId);
  if (!active) return false;
  apply(active);
  return true;
}

// Activity heartbeat: the event funnel's single writer. Any event bearing a
// tracked ACTIVE child's session id is proof the turn is moving, so the
// operator's "last activity" reads observed motion instead of "no task_notify
// since spawn". Returns false for untracked ids (the parent, settled children)
// and writes nothing — the read side (task_status) still treats startedAt as
// the floor when no event has been seen.
export function noteActivity(
  store: TaskStore,
  childSessionId: string | null | undefined,
  terminal: boolean,
): boolean {
  if (!childSessionId) return false;
  return annotateActive(store, childSessionId, (active) => {
    const now = Date.now();
    active.lastActivityAt = now;
    if (!terminal) active.turnLiveAt = now;
  });
}

// Notice announcements are recorded on the active entry by the gate module —
// advisory metadata, never a lifecycle mutation.
// The notice a turn declares, assembled once. The `claim` is what the settlement
// reads to tell a blocked turn from a finished one, so it is not optional in the
// record and this is the one place that says so.
export function noticeRecord(message: string, claim: NoticeClaim, at: number): ActiveTaskState["lastNotice"] {
  return { message, at, claim };
}

export function annotateNotice(store: TaskStore, childSessionId: string, message: string, claim: NoticeClaim): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.lastNotice = noticeRecord(message, claim, Date.now());
  });
}

/**
 * Whether this active task declared that its turn is ending blocked — the one
 * input to the settlement that separates "finished the work" from "cannot
 * finish without the parent".
 *
 * Scoped to the turn that made the declaration: a steer stamped AFTER the
 * declaration IS the answer, so the ending turn (which declared nothing) is
 * settled on its own claim. A turn replacement is the only boundary a record
 * has, and a revival produces a new record with no declaration at all.
 */
export function declaredBlocked(store: TaskStore, childSessionId: string): boolean {
  const active = store.activeTasks.get(childSessionId);
  if (!active?.lastNotice || active.lastNotice.claim !== NoticeClaim.NeedsInput) return false;
  return active.lastNotice.at > (active.replacedAt ?? 0);
}

// Turn attribution (parent→child turn replacement): armed synchronously by
// task_continue before aborting the running turn, and by every revival, because
// a replaced turn's terminal copies can still be in flight. Advisory like a
// notice — the task stays active either way — so this pair may read and clear
// the stamps but never moves a lifecycle state.
export function markTurnReplacement(store: TaskStore, childSessionId: string): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.replacedAt = Date.now();
  });
}

/**
 * Drop turn attribution when the replacement never happened — the abort may not
 * have reached the server, so the ORIGINAL turn is still live and will show its
 * own life signs.
 */
export function clearTurnReplacement(store: TaskStore, childSessionId: string): boolean {
  const active = store.activeTasks.get(childSessionId);
  if (!active || active.replacedAt === undefined) return false;
  delete active.replacedAt;
  return true;
}

/**
 * Has this turn replaced another and not yet been seen doing anything?
 *
 * The record-level half of the settle gate, and the only part of it that is not
 * a lookup: a turn that replaced another cannot be said to have ended until it
 * has been seen doing something. A fresh spawn answers false, because nothing
 * precedes it.
 */
export function turnReplacementPending(
  task: Pick<ActiveTaskState, "replacedAt" | "turnLiveAt"> | undefined,
): boolean {
  if (!task || task.replacedAt === undefined) return false;
  return (task.turnLiveAt ?? 0) < task.replacedAt;
}

/**
 * The ONE gate that decides whether a terminal event may settle this turn.
 *
 * A turn that REPLACED another (a steer, a revival) has a prior turn's terminal
 * copies possibly still in flight, and the host publishes a turn end more than
 * once. Until the replacement has been seen doing something, a terminal event
 * cannot be attributed to it and the task stays active. A fresh spawn — and a
 * restored one, whose attribution state was deliberately not persisted — has no
 * prior turn, so it always settles.
 */
export function terminalEventIsAttributable(store: TaskStore, childSessionId: string): boolean {
  return !turnReplacementPending(store.activeTasks.get(childSessionId));
}

// Read-path TTL pruning (Task 06): expired retained entries are dropped
// lazily, so every reader (including the test harness, which injects short
// TTLs) sees a consistent view without needing a scheduler. The entry cap is
// enforced on the same pass — the cap cannot be escaped by any state path.
export function pruneRetainedTasks(
  store: TaskStore,
  config: Pick<DynamicTaskConfig, "retainedTaskTtlMs" | "retainedTaskMaxEntries">,
): number {
  const now = Date.now();
  let dropped = 0;
  // Named, not counted: the ledger write says which ids it forgot, so a
  // forgotten task leaves the SHARED file and not merely this process's view.
  const forgotten: LedgerChange[] = [];
  for (const [id, task] of store.retainedTasks) {
    if (now - task.retainedAt >= config.retainedTaskTtlMs) {
      store.retainedTasks.delete(id);
      forgotten.push({ kind: LedgerChangeKind.Forgotten, id });
      dropped++;
    }
  }
  while (store.retainedTasks.size > config.retainedTaskMaxEntries) {
    const oldest = oldestRetainedId(store);
    if (oldest === null) break;
    store.retainedTasks.delete(oldest);
    forgotten.push({ kind: LedgerChangeKind.Forgotten, id: oldest });
    dropped++;
  }
  if (forgotten.length > 0) emitRetainedChange(store, ...forgotten);
  return dropped;
}

export function listTasks(store: TaskStore): {
  active: ActiveTaskState[];
  retained: RetainedTaskState[];
} {
  return {
    active: [...store.activeTasks.values()],
    retained: [...store.retainedTasks.values()],
  };
}

export function findTask(store: TaskStore, childSessionId: string): TaskRecord | null {
  return store.activeTasks.get(childSessionId) ?? retainedFor(store, childSessionId) ?? null;
}

// ─── the wait registry ────────────────────────────────────────────────────────
//
// The refused dispatches and the readiness rule that releases them moved to
// ./dispatch-wait.js, which is where that subject now lives.


// Transient abort failures are recorded on the retained entry: an
// interrupted-but-still-live child must be visible, not silently stranded.
export function recordAbortError(store: TaskStore, childSessionId: string, error: string): void {
  decideRetained(store, childSessionId, (retained) => {
    retained.abortError = error;
    return true;
  });
}

// ─── the settled-record primitives ──────────────────────────────────
// The read, the publish, and the edit. Every function in this module that
// touches settled history goes through one of these three, which is what makes
// "a retained record is only ever read here, changed there, and published once"
// checkable by reading one screen instead of auditing every edge.

/**
 * The running record for a child, or undefined. The mirror of `retainedFor`, and
 * named for the same reason: "what is this child's running record" is one question
 * with one answer, so the absence signal is declared once here rather than left to
 * each caller. The policy that answers it stays with the edge — an internal
 * rollback, a settlement and a revival genuinely disagree about a missing record.
 */
function activeFor(store: TaskStore, childSessionId: string): ActiveTaskState | undefined {
  return store.activeTasks.get(childSessionId);
}

/**
 * The settled (retained) record for a child, or undefined. One accessor because
 * "what is this child's settled record" is one question with one answer — and
 * because each call site wrote the lookup with its own idea of what an absent
 * record MEANS: one edge threw, one returned false, one built a refusal
 * sentence. The absence signal is declared once here; the policy that answers it
 * stays with the edge, because an internal rollback and a policy revival
 * genuinely disagree about a missing record.
 */
function retainedFor(store: TaskStore, childSessionId: string): RetainedTaskState | undefined {
  return store.retainedTasks.get(childSessionId);
}

/** The one retained-write funnel: it states WHAT moved, not the resulting map. */
function emitRetainedChange(store: TaskStore, ...changes: LedgerChange[]): void {
  store.onRetainedChange?.(changes);
}

// Durability boundary: hydrate entries already validated by the ledger
// reader (session-lifecycle) into the live maps. The reader owns shape truth;
// this module owns placement and the caps.
//
// One loop for both halves. "Walk what the last boot left, keep what fits, count
// what came back" is one shape; the per-record work (where it lands, and what
// conflicts with it) is a function, not a copy of the loop.
//
// The conflict is handed over as the OTHER durable half rather than as a
// predicate: a settled record and a running record for one id are the same task
// seen twice, so the rule is simply "the other half outranks me" and each caller
// names the map that holds it instead of re-deriving the lookup.
function hydrate<T extends ActiveTaskState | RetainedTaskState>(
  records: Map<string, T>,
  place: (id: string, record: T) => void,
  outrankedBy: Map<string, ActiveTaskState | RetainedTaskState>,
  superseded: string[] = [],
): number {
  let restored = 0;
  for (const [id, record] of records) {
    if (outrankedBy.has(id)) {
      // Declined, not placed — and the caller must be able to SAY so, or the
      // entry stays in the shared file forever: this process will never place
      // it, never settle it, and never claim it.
      superseded.push(id);
      continue;
    }
    place(id, record);
    restored++;
  }
  return restored;
}

/** Is this one of ours, still running? The same question `activeFor` answers, as a verdict. */
export function isRunning(store: TaskStore, childSessionId: string): boolean {
  return activeFor(store, childSessionId) !== undefined;
}


/**
 * Boot hydration for the running half, as ONE change rather than N.
 *
 * One write, and that is the load-bearing part. Placing each record through
 * `setActive` meant a boot rewrote the file once per restored task, each write
 * serializing a map that had already grown: restoring 200 records issued 200
 * writes and 4.8 MB of JSON to produce a 30 KB file, every boot, for no change in
 * content — the file ALREADY holds these records, they were just read from it.
 *
 * So the restore places and then tells the funnel ONCE. It does not bypass it —
 * spawn, revive and settlement still go through `setActive`/`removeActive` — and
 * a restore that dropped a record (the cap fired, or the other half outranked
 * it) is still followed by a write, so the file never disagrees with memory.
 *
 * The concurrency cap is deliberately NOT applied: it is an admission policy
 * about work this process starts, and these tasks are already running
 * server-side. Over-cap actives block new admissions until they settle.
 */
/**
 * The one boot restore, for either half of the ledger.
 *
 * Three things are true of both halves and none of them is worth stating twice:
 * placements are collected AS they happen (so there is no second pass over the
 * records and no cast), an entry outranked by the other half is reported rather
 * than left behind, and N placements become ONE write. A boot that wrote per
 * record would read the shared file N times for no gain.
 */
function restoreInto<T extends ActiveTaskState | RetainedTaskState>(
  records: Map<string, T>,
  outrankedBy: Map<string, ActiveTaskState | RetainedTaskState>,
  place: (id: string, record: T, changes: LedgerChange[]) => void,
  fire: LedgerChangeSink | undefined,
): number {
  const changes: LedgerChange[] = [];
  const superseded: string[] = [];
  const restored = hydrate(records, (id, record) => place(id, record, changes), outrankedBy, superseded);
  for (const id of superseded) changes.push({ kind: LedgerChangeKind.Stopped, id });
  if (changes.length > 0) fire?.(changes);
  return restored;
}

/**
 * The running half, restored as running tasks. Over-cap actives block new
 * admissions until they settle.
 */
export function restoreActive(store: TaskStore, records: Map<string, ActiveTaskState>): number {
  return restoreInto(
    records,
    store.retainedTasks,
    (id, record, changes) => {
      store.activeTasks.set(id, record);
      changes.push({ kind: LedgerChangeKind.Running, id, record });
    },
    store.onActiveChange,
  );
}

/**
 * The settled half, with the same one-write shape.
 *
 * `pruneIfBounded` is what stops this being a copy of the file: the cap can drop
 * a record, and a record the running half already holds is skipped, so the
 * restored set is not always the loaded set.
 */
export function restoreRetained(
  store: TaskStore,
  records: Map<string, RetainedTaskState>,
  maxEntries: number = DEFAULT_CONFIG.retainedTaskMaxEntries,
): number {
  return restoreInto(
    records,
    store.activeTasks,
    (id, record, changes) => {
      // The cap's drop is named rather than left inside `pruneIfBounded`, which
      // has no way to hand it back: a record it drops must leave the shared file
      // too, and "this process no longer has it" is not the same claim.
      const dropped = pruneIfBounded(store, record, maxEntries);
      store.retainedTasks.set(id, dropped.kept);
      if (dropped.forgotten !== null) changes.push({ kind: LedgerChangeKind.Forgotten, id: dropped.forgotten });
      changes.push({ kind: LedgerChangeKind.Settled, id, record: dropped.kept });
    },
    store.onRetainedChange === undefined
      ? undefined
      : (changes) => emitRetainedChange(store, ...changes),
  );
}

// Restored entries bypass the runtime mutation choke points, so the cap is
// enforced here (tenet: the cap cannot be escaped by any state path).
function pruneIfBounded(
  store: TaskStore,
  record: RetainedTaskState,
  maxEntries: number,
): { kept: RetainedTaskState; forgotten: string | null } {
  let forgotten: string | null = null;
  if (store.retainedTasks.size >= maxEntries) {
    const oldestId = oldestRetainedId(store);
    if (oldestId) {
      store.retainedTasks.delete(oldestId);
      forgotten = oldestId;
    }
  }
  return { kept: record, forgotten };
}

export function oldestRetainedId(store: TaskStore): string | null {
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [id, t] of store.retainedTasks) {
    if (t.retainedAt < oldestAt) {
      oldest = id;
      oldestAt = t.retainedAt;
    }
  }
  return oldest;
}

// Shared age formatting for task summaries and fleet rows.
export function formatAge(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}
