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

import type { DynamicTaskConfig } from "./config.js";
import type { DependencyBlock } from "./admission.js";
import type { ModelOverride } from "./prompt.js";
import { checkConcurrencyLimit, DEFAULT_CONFIG } from "./config.js";

/**
 * What a mid-flight notice CLAIMS about the child's own state. It rides the ONE
 * child→parent channel (no purpose-specific tool): `progress` is information,
 * `needs_input` is the child saying this turn cannot finish without the parent.
 * The claim is what the settlement reads, so a child that ends its turn blocked
 * is recorded as blocked — the alternative was reporting it as a success.
 */
export type NoticeClaim = "progress" | "needs_input";

// The claims, as data: the tool validates its argument against this list, so an
// unrecognized claim is refused rather than quietly downgraded to progress — a
// typo'd `needs_input` would settle the child as a success.
export const NOTICE_CLAIMS: readonly NoticeClaim[] = ["progress", "needs_input"];

export type TaskState =
  | "active"
  | "completed"
  | "error"
  // Ended its turn needing the parent's answer. Not a success and not a failure:
  // the child worked, it could not finish, and the plugin recorded
  // `completed` for exactly this case — a false success claim about a task that
  // delivered no result. It is terminal (the turn is over) and revivable (the
  // parent's answer is a new turn).
  | "blocked"
  | "interrupted";

// The states, as data: the durable reader validates a restored record against
// this list, so a state cannot be added to the machine and forgotten by the
// reader that has to understand it.
export const TASK_STATES: readonly TaskState[] = ["active", "completed", "error", "blocked", "interrupted"];

/**
 * A settlement, named — and the names are the machine's OWN terminal states, so
 * a verdict is directly claimable, notifiable, and renderable without a second
 * lookup table translating between three parallel spellings of the same fact.
 *
 * `interrupted` is absent on purpose: it is claimed by the interrupt funnel, not
 * arrived at by a turn ending.
 */
export type SettlementVerdict = Extract<TaskState, "completed" | "blocked" | "error">;

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

// A model override as the parent spelled it. Named because the record, the
// reference, and the confirmation that renders it all need the same pair, and an
// inline spelling in each is three places for a rename to miss.
export interface RequestedModel {
  providerID: string;
  modelID: string;
}

// The fields every record carries, whatever state it is in. Declared once, so
// the active and retained shapes cannot drift and what admission hands the
// registry is derived from the record instead of re-typed alongside it.
export interface TaskRecordBase extends TaskIdentity {
  startedAt: number;
  lineage: LineagePath;
  requestedModel?: RequestedModel | undefined;
  dependsOn?: string[] | undefined;
  // Admission-time only: ids that needed settlement, not success, before this
  // task spawned. Persisted so status renders the full dependency picture.
  dependsOnSettled?: string[] | undefined;
}

// What admission registers: the record minus the clock the store owns. The
// advisory fields below are lifecycle-written, so a registration cannot set them.
export type NewTaskRegistration = Omit<TaskRecordBase, "startedAt">;

export interface ActiveTaskState extends TaskRecordBase {
  state: "active";
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
  state: Exclude<TaskState, "active">;
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
 * A dispatch the admission gate refused because its dependencies were not
 * ready, held so the plugin can say when the refusal is over.
 *
 * This is the state that `depends_on` never had. The refusal used to be a
 * sentence: the parent had to carry the wait in prose, be alive at the moment
 * the dependency settled, and re-dispatch from memory — three things that all
 * belong to the parent's context, which is what the plugin exists to hold.
 *
 * It holds NO prompt and NO session, deliberately. The parent wrote the
 * dispatch and the parent resumes it; the plugin's whole obligation is to say
 * when the gate will now admit it. So this is process memory, not ledger
 * truth: across a restart this wait and the parent that asked for it are gone
 * together, and a hint that outlived its asker would have nobody to inform.
 */
export interface DependencyWait {
  /** The parent's own words for this dispatch — its identity in every message. */
  description: string;
  /** The parent that asked. The hint goes here, not to the settling task's parent. */
  parentSessionId: string;
  /** Edges that must reach `completed`. */
  dependsOn: string[];
  /** Edges that only have to settle. */
  dependsOnSettled: string[];
  queuedAt: number;
}

/** A wait's key: who is waiting, for what. The parent named both. */
export function waitKey(parentSessionId: string, description: string): string {
  return parentSessionId + " " + description;
}

export interface TaskStore {
  activeTasks: Map<string, ActiveTaskState>;
  retainedTasks: Map<string, RetainedTaskState>;
  /**
   * Refused dispatches, keyed by the (parent, description) that asked for them —
   * the parent's own words are the identity, so the plugin never invents an id
   * the parent then has to learn. Not persisted; see DependencyWait.
   */
  waits: Map<string, DependencyWait>;
  // Durable-state observer (Task 06): invoked after retained entries change.
  onRetainedChange?: (() => void) | undefined;
  // Durable-state observer (Task 11): invoked when a task STARTS or STOPS being
  // a running task — the set of what a crash would leave behind. Separate from
  // onRetainedChange because the two halves persist for different reasons, and
  // joined here so a settlement writes the whole file exactly once.
  onActiveChange?: (() => void) | undefined;
}

// The one write path into the running set. Every structural change to a live
// task goes through here, so the durable ledger has exactly one place to learn
// that a task exists or stopped existing — and, just as deliberately, one place
// the advisory writers below do NOT touch: a heartbeat or a mid-flight notice
// would otherwise put a file write on every host event, turning the event head
// into a filesystem hot path. The advisory fields are stripped on the way to
// disk anyway (durableActiveTask), because a fresh process cannot verify them.
function setActive(store: TaskStore, childSessionId: string, record: ActiveTaskState): void {
  store.activeTasks.set(childSessionId, record);
  store.onActiveChange?.();
}

function removeActive(store: TaskStore, childSessionId: string): void {
  store.activeTasks.delete(childSessionId);
  store.onActiveChange?.();
}

// State machine (the one true lifecycle matrix). Active tasks move to a terminal
// state exactly once; terminal states never regress. Late error escalation
// (completed -> error) is a SEPARATE, explicitly-marked edge handled by
// noteLateOutcome, NOT by transitionState — this keeps the primary "does a
// transition happen at all" question decidable from this matrix alone.
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  "active": ["completed", "error", "blocked", "interrupted"],
  "completed": [],
  "error": [],
  "blocked": [],
  "interrupted": [],
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
  bounds?: Pick<DynamicTaskConfig, "maxConcurrent">,
): boolean {
  return decideRetained(store, childSessionId, (retained) => {
    if (retained.state !== "interrupted") return false;
    // >= not >: a successful abort landing in the same millisecond as the
    // claim is still knowledge — the newer (or same-instant) success wins.
    if ((retained.lastAbortAt ?? 0) >= claimTimeMs) return false;
    if (bounds && checkConcurrencyLimit(store.activeTasks.size, bounds)) return false;
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
  const reclaimed: ActiveTaskState = { ...carried, state: "active", ...overrides };
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

// Register a task and claim the session id atomically. The maxConcurrent
// check lives inside the choke point (Task 07) — no call site can forget it,
// and every active task holds a slot regardless of who awaits it.
export function registerActiveTask(
  store: TaskStore,
  task: NewTaskRegistration,
  config: Pick<DynamicTaskConfig, "maxConcurrent">,
): ActiveTaskState {
  const limitError = checkConcurrencyLimit(store.activeTasks.size, config);
  if (limitError) {
    throw new Error(limitError);
  }
  const record: ActiveTaskState = {
    ...task,
    state: "active",
    startedAt: Date.now(),
  };
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
  to: Exclude<TaskState, "active">,
): { state: TaskState; completed: boolean; task?: ActiveTaskState | RetainedTaskState } {
  const active = store.activeTasks.get(childSessionId);
  if (active) {
    const allowed: TaskState[] = VALID_TRANSITIONS[active.state] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition: ${active.state} → ${to}`);
    }
          const {
            lastNotice: _notice,
            lastActivityAt: _activity,
            replacedAt: _replaced,
            turnLiveAt: _turnLive,
            ...settled
          } = active;
    const retained: RetainedTaskState = {
      ...settled,
      state: to,
      retainedAt: Date.now(),
    };
    removeActive(store, childSessionId);
    store.retainedTasks.set(childSessionId, retained);
    emitRetainedChange(store);
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
export function noteLateOutcome(store: TaskStore, childSessionId: string, outcome: Exclude<TaskState, "active">): boolean {
  return decideRetained(store, childSessionId, (retained) => {
    if (retained.state !== "completed" || outcome !== "error") return false;
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
  config?: Pick<DynamicTaskConfig, "maxConcurrent">,
  model?: ModelOverride | undefined,
): ActiveTaskState {
  const retained = retainedFor(store, childSessionId);
  if (!retained) {
    throw new Error(`Invalid transition: not found (no task for ${childSessionId})`);
  }
  if (retained.state === "interrupted") {
    throw new Error(`Task ${childSessionId} was interrupted by request; interrupted children are not revived — spawn a fresh dynamic_task instead.`);
  }
  if (config) {
    const limitError = checkConcurrencyLimit(store.activeTasks.size, config);
    if (limitError) throw new Error(limitError);
  }
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
export function annotateNotice(store: TaskStore, childSessionId: string, message: string, claim: NoticeClaim): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.lastNotice = { message, at: Date.now(), claim };
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
  if (!active?.lastNotice || active.lastNotice.claim !== "needs_input") return false;
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
  task: { replacedAt?: number | undefined; turnLiveAt?: number | undefined } | undefined,
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
  for (const [id, task] of store.retainedTasks) {
    if (now - task.retainedAt >= config.retainedTaskTtlMs) {
      store.retainedTasks.delete(id);
      dropped++;
    }
  }
  while (store.retainedTasks.size > config.retainedTaskMaxEntries) {
    const oldest = oldestRetainedId(store);
    if (oldest === null) break;
    store.retainedTasks.delete(oldest);
    dropped++;
  }
  if (dropped > 0) emitRetainedChange(store);
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

// ─── Dependency waits ───────────────────────────────────────────────────
//
// One writer (the admission gate's refusal) and one reader (the settlement
// funnel). The reader asks the SAME predicate the gate asked, so "this dispatch
// can go now" can never disagree with "this dispatch was refused" — two
// hand-written readiness rules would drift, and the drift would read as the
// plugin refusing a dispatch it had just promised.

/** How many refused dispatches one parent may have outstanding. */
export const MAX_WAITS = 64;

/**
 * Hold a refused dispatch so the plugin can announce its release. Re-recording
 * the same (parent, description) replaces the earlier edges rather than
 * queueing a second hint for one dispatch: the parent asked twice about the
 * same thing, and the newer edges are the ones it means now.
 */
export function holdDispatchWait(
  store: TaskStore,
  wait: Omit<DependencyWait, "queuedAt">,
): DependencyWait {
  const held: DependencyWait = { ...wait, queuedAt: Date.now() };
  store.waits.set(waitKey(wait.parentSessionId, wait.description), held);
  // Bounded: the map is a courtesy ledger to a live parent, not a history. The
  // oldest wait goes first, and it is the one least likely to still be wanted.
  while (store.waits.size > MAX_WAITS) {
    const oldest = store.waits.keys().next();
    if (oldest.done) break;
    store.waits.delete(oldest.value);
  }
  return held;
}

/** What a settlement did to the waits that were watching it. */
export interface WaitRelease {
  /** Refused dispatches the gate will now admit. */
  ready: DependencyWait[];
  /** Refused dispatches that can never run: every unmet edge is finished, short of done. */
  dead: DependencyWait[];
}

/**
 * The waits this settlement resolves, and the ones it leaves alone. A wait is
 * resolved by the SAME predicate the gate refused it on, so readiness has one
 * definition. It is resolved as `dead` when the predicate still refuses AND no
 * unmet edge is still running: an edge that has settled and is not `completed`
 * will not run again, so waiting on it is waiting on nothing — and a parent that
 * is never told is a parent that waits forever.
 *
 * Resolved waits are removed here, so exactly-once is structural rather than a
 * dedup key: a wait cannot be announced twice because it is announced from the
 * moment it stops existing.
 */
export function releaseWaitsFor(
  store: TaskStore,
  settledChildSessionId: string,
  isAdmissible: (wait: DependencyWait) => { ok: true } | { ok: false; pending: DependencyBlock[] },
  stillRunning: (childSessionId: string) => boolean,
): WaitRelease {
  const release: WaitRelease = { ready: [], dead: [] };
  for (const [key, wait] of [...store.waits]) {
    const watching = [wait.dependsOn, wait.dependsOnSettled].some((edges) =>
      edges.includes(settledChildSessionId),
    );
    if (!watching) continue;
    const admitted = isAdmissible(wait);
    if (admitted.ok) {
      release.ready.push(wait);
      store.waits.delete(key);
      continue;
    }
    // Still refused: is any edge able to change that, or is this wait finished?
    const canStillClear = admitted.pending.some((edge) => stillRunning(edge.id));
    if (canStillClear) continue;
    release.dead.push(wait);
    store.waits.delete(key);
  }
  return release;
}

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

function emitRetainedChange(store: TaskStore): void {
  store.onRetainedChange?.();
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
): number {
  let restored = 0;
  for (const [id, record] of records) {
    if (outrankedBy.has(id)) continue;
    place(id, record);
    restored++;
  }
  return restored;
}

/** Is this one of ours, still running? The same question `activeFor` answers, as a verdict. */
export function isRunning(store: TaskStore, childSessionId: string): boolean {
  return activeFor(store, childSessionId) !== undefined;
}

// Boot hydration for the running half. The concurrency cap is deliberately NOT
// applied here: it is an admission policy about work this process starts, and
// these tasks are already running server-side. Dropping a restored task to stay
// under the cap would put the child back in the hole this hydration exists to
// close — burning tokens with nothing left to settle. Over-cap actives are
// re-discovered by the first reconcile pass, and block new admissions until
// they settle, which is the honest outcome.
// One task in the dispatch tree, with the place it holds in it.
export interface DispatchNode {
  task: TaskRecord;
  depth: number;
  // Whether the parent that spawned this task is itself tracked here. False
  // means the link is severed — pruned history, a record lost across a restart
  // — and a view that presents such a task flush would read it as a ROOT,
  // which is a task whose parent nobody has stopped above.
  parentTracked: boolean;
  children: DispatchNode[];
}

// The store's dispatch tree, as a forest of nested DispatchNodes. This is the
// ONE walk: the subtree stop and the fleet read are two different questions
// about the same shape, so they cannot each grow their own idea of it.
//
// Edges are `parentSessionId`, NOT `lineage` — lineage holds agent NAMES (the
// delegation policy's input), so it cannot answer "is this task below that
// one". Both maps are walked, so a finished task still holds its place as the
// parent of something running. The `path` guard makes the walk terminate on a
// cycle that admission cannot produce but a hand-edited record file could.
export function dispatchForest(store: TaskStore): DispatchNode[] {
  const records = new Map<string, TaskRecord>();
  for (const [id, task] of store.retainedTasks) records.set(id, task);
  for (const [id, task] of store.activeTasks) records.set(id, task);

  const childrenOf = new Map<string, string[]>();
  for (const [id, task] of records) {
    const siblings = childrenOf.get(task.parentSessionId);
    if (siblings) siblings.push(id);
    else childrenOf.set(task.parentSessionId, [id]);
  }

  const placed = new Set<string>();
  const grow = (task: TaskRecord, depth: number, parentTracked: boolean, path: ReadonlySet<string>): DispatchNode => {
    const node: DispatchNode = { task, depth, parentTracked, children: [] };
    placed.add(task.childSessionId);
    const next = new Set(path).add(task.childSessionId);
    for (const childId of childrenOf.get(task.childSessionId) ?? []) {
      const child = records.get(childId);
      if (child === undefined || next.has(childId)) continue;
      node.children.push(grow(child, depth + 1, true, next));
    }
    return node;
  };

  const forest: DispatchNode[] = [];
  // One root-finding pass, stated once: the two passes differ only in what they
  // call a root. The first is the honest one — a task whose parent is tracked
  // belongs under it. The second exists because a record set whose parent links
  // form a cycle has no root to be reached from, and an unreached record would
  // go missing from the view; it becomes a root of its own rather than vanish.
  const pushRoots = (isRoot: (task: TaskRecord) => boolean): void => {
    for (const task of records.values()) {
      if (isRoot(task)) forest.push(grow(task, 0, false, new Set()));
    }
  };
  pushRoots((task) => !records.has(task.parentSessionId));
  pushRoots((task) => !placed.has(task.childSessionId));
  return forest;
}

function findDispatchNode(nodes: DispatchNode[], sessionId: string): DispatchNode | undefined {
  for (const node of nodes) {
    if (node.task.childSessionId === sessionId) return node;
    const found = findDispatchNode(node.children, sessionId);
    if (found !== undefined) return found;
  }
  return undefined;
}

const descendDispatch = (node: DispatchNode): string[] => [
  node.task.childSessionId,
  ...node.children.flatMap(descendDispatch),
];

// The task tree under `rootSessionId`, root first, through SETTLED records: a
// finished child is not a wall, and the grandchild it left running is exactly
// what a subtree stop has to reach. A root the store does not track has no
// knowable descendants — the store only ever learns a parent link from a
// record — so the answer is that session alone, which the caller's report
// already names as untracked.
export function subtreeTaskIds(store: TaskStore, rootSessionId: string): string[] {
  const node = findDispatchNode(dispatchForest(store), rootSessionId);
  return node === undefined ? [rootSessionId] : descendDispatch(node);
}

export function restoreActive(store: TaskStore, records: Map<string, ActiveTaskState>): number {
  return hydrate(records, (id, record) => setActive(store, id, record), store.retainedTasks);
}

export function restoreRetained(
  store: TaskStore,
  records: Map<string, RetainedTaskState>,
  maxEntries: number = DEFAULT_CONFIG.retainedTaskMaxEntries,
): number {
  return hydrate(
    records,
    (id, record) => {
      store.retainedTasks.set(id, pruneIfBounded(store, record, maxEntries));
      emitRetainedChange(store);
    },
    store.activeTasks,
  );
}

// Restored entries bypass the runtime mutation choke points, so the cap is
// enforced here (tenet: the cap cannot be escaped by any state path).
function pruneIfBounded(store: TaskStore, record: RetainedTaskState, maxEntries: number): RetainedTaskState {
  if (store.retainedTasks.size >= maxEntries) {
    const oldestId = oldestRetainedId(store);
    if (oldestId) store.retainedTasks.delete(oldestId);
  }
  return record;
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
