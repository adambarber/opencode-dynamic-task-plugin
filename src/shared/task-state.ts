// Shared task-state machine (Task 01 amendment): the single owner of task
// records and every lifecycle mutation. States: active until a settlement
// event arrives — the plugin arms no timers, so nothing else can settle a
// task, and terminal states never regress.
//
// Lifecycle map (every edge below goes through the function named on it):
//
//   active ──terminal event (transitionState)──▶ completed|error|interrupted ──▶ retained ──▶ pruned
//     │                                              ▲ completed ──noteLateOutcome──▶ error (only rewrite edge)
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
import type { ModelOverride } from "./prompt.js";
import { checkConcurrencyLimit, DEFAULT_CONFIG } from "./config.js";

export type TaskState =
  | "active"
  | "completed"
  | "error"
  | "interrupted";

export type LineageStep = string;
export type LineagePath = LineageStep[];

// The fields every record carries, whatever state it is in. Declared once, so
// the active and retained shapes cannot drift and what admission hands the
// registry is derived from the record instead of re-typed alongside it.
export interface TaskRecordBase {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  startedAt: number;
  lineage: LineagePath;
  requestedModel?: { providerID: string; modelID: string } | undefined;
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
  // Latest mid-flight notice from the child (advisory metadata, not a lifecycle field).
  lastNotice?: { message: string; at: number } | undefined;
  // Latest time the host emitted ANY event for this child's session — the
  // event funnel's own proof the turn is moving. Without it "last activity"
  // could only mean "spawned" or "called task_notify", so a child working
  // through a long tool chain read as silent since spawn. Advisory like the
  // notice: never a lifecycle field, stripped at settlement so the durable
  // ledger carries no heartbeat.
  lastActivityAt?: number | undefined;
  // Parent steer in flight: set synchronously by task_continue before aborting
  // the running turn, consumed by the lifecycle handler to suppress that
  // turn's terminal echo. Advisory, never a lifecycle mutation — the task
  // stays active either way, and settlement strips it.
  steerPending?: boolean | undefined;
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

export interface TaskStore {
  activeTasks: Map<string, ActiveTaskState>;
  retainedTasks: Map<string, RetainedTaskState>;
  // Durable-state observer (Task 06): invoked after retained entries change.
  onRetainedChange?: (() => void) | undefined;
}

// State machine (the one true lifecycle matrix). Active tasks move to a terminal
// state exactly once; terminal states never regress. Late error escalation
// (completed -> error) is a SEPARATE, explicitly-marked edge handled by
// noteLateOutcome, NOT by transitionState — this keeps the primary "does a
// transition happen at all" question decidable from this matrix alone.
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  "active": ["completed", "error", "interrupted"],
  "completed": [],
  "error": [],
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
  const retained = store.retainedTasks.get(childSessionId);
  if (!retained || retained.state !== "interrupted") return false;
  // >= not >: a successful abort landing in the same millisecond as the
  // claim is still knowledge — the newer (or same-instant) success wins.
  if ((retained.lastAbortAt ?? 0) >= claimTimeMs) return false;
  if (bounds && checkConcurrencyLimit(store.activeTasks.size, bounds)) return false;
  const { retainedAt: _retainedAt, abortError: _abortError, lastAbortAt: _lastAbortAt, ...active } = retained;
  store.retainedTasks.delete(childSessionId);
  store.activeTasks.set(childSessionId, { ...active, state: "active" });
  emitRetainedChange(store);
  return true;
}

// Stamp a successful abort landing on a retained record (F-R4): concurrent
// interruptors observe it through withdrawInterruptClaim's guard.
export function noteAbortLanded(store: TaskStore, childSessionId: string): boolean {
  const retained = store.retainedTasks.get(childSessionId);
  if (!retained) return false;
  retained.lastAbortAt = Date.now();
  emitRetainedChange(store);
  return true;
}

export function createTaskStore(): TaskStore {
  return {
    activeTasks: new Map(),
    retainedTasks: new Map(),
    onRetainedChange: undefined,
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
  store.activeTasks.set(task.childSessionId, record);
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
    const { lastNotice: _notice, steerPending: _steer, lastActivityAt: _activity, ...settled } = active;
    const retained: RetainedTaskState = {
      ...settled,
      state: to,
      retainedAt: Date.now(),
    };
    store.activeTasks.delete(childSessionId);
    store.retainedTasks.set(childSessionId, retained);
    emitRetainedChange(store);
    return { state: to, completed: true, task: retained };
  }

  // No active entry — reject based on the retained state, if any.
  const retained = store.retainedTasks.get(childSessionId);
  if (retained) {
    throw new Error(`Invalid transition: terminal state (${retained.state})`);
  }
  throw new Error(`Invalid transition: not found (no task for ${childSessionId})`);
}

// Late-error escalation — the ONE edge that rewrites a retained state.
// Only a recorded success can be corrected to error: an interrupted or
// errored task's own abort aftermath must never re-notify the parent.
export function noteLateOutcome(store: TaskStore, childSessionId: string, outcome: Exclude<TaskState, "active">): boolean {
  const retained = store.retainedTasks.get(childSessionId);
  if (!retained) return false;
  const allowed: Exclude<TaskState, "active">[] = retained.state === "completed" ? ["error"] : [];
  if (!allowed.includes(outcome)) return false;
  retained.state = outcome;
  emitRetainedChange(store);
  return true;
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
  const retained = store.retainedTasks.get(childSessionId);
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
  const { state: _terminal, retainedAt: _at, abortError: _err, ...core } = retained;
  const revived: ActiveTaskState = {
    ...core,
    state: "active",
    startedAt: Date.now(),
    ...(model !== undefined ? { requestedModel: model } : {}),
  };
  store.retainedTasks.delete(childSessionId);
  store.activeTasks.set(childSessionId, revived);
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
  const active = store.activeTasks.get(childSessionId);
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
export function noteActivity(store: TaskStore, childSessionId: string | null | undefined): boolean {
  if (!childSessionId) return false;
  return annotateActive(store, childSessionId, (active) => {
    active.lastActivityAt = Date.now();
  });
}

// Notice announcements are recorded on the active entry by the gate module —
// advisory metadata, never a lifecycle mutation.
export function annotateNotice(store: TaskStore, childSessionId: string, message: string): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.lastNotice = { message, at: Date.now() };
  });
}

// Steer claim (parent→child mid-flight message): armed synchronously by
// task_continue before aborting the running turn, consumed once by the
// lifecycle handler to suppress that turn's terminal echo. Advisory like a
// notice — the task stays active either way — so this pair may read and
// clear the flag but never moves a lifecycle state.
export function markSteerPending(store: TaskStore, childSessionId: string): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.steerPending = true;
  });
}

export function consumeSteerPending(store: TaskStore, childSessionId: string): boolean {
  const active = store.activeTasks.get(childSessionId);
  if (!active || !active.steerPending) return false;
  active.steerPending = false;
  return true;
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
  return store.activeTasks.get(childSessionId) ?? store.retainedTasks.get(childSessionId) ?? null;
}

// Transient abort failures are recorded on the retained entry: an
// interrupted-but-still-live child must be visible, not silently stranded.
export function recordAbortError(store: TaskStore, childSessionId: string, error: string): void {
  const retained = store.retainedTasks.get(childSessionId);
  if (!retained) return; // already pruned — nothing to annotate
  retained.abortError = error;
  emitRetainedChange(store);
}

function emitRetainedChange(store: TaskStore): void {
  store.onRetainedChange?.();
}

// Durability boundary: hydrate entries already validated by the ledger
// reader (session-lifecycle) into the live retained map. The reader owns
// shape truth; this module owns placement and the cap.
export function restoreRetained(
  store: TaskStore,
  records: Map<string, RetainedTaskState>,
  maxEntries: number = DEFAULT_CONFIG.retainedTaskMaxEntries,
): number {
  let restored = 0;
  for (const [id, record] of records) {
    if (store.activeTasks.has(id)) continue; // live wins over restored history
    store.retainedTasks.set(id, pruneIfBounded(store, record, maxEntries));
    restored++;
    emitRetainedChange(store);
  }
  return restored;
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
