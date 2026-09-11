// src/shared/task-state.ts
// Active task store + retained history store + idempotent state transitions.
// The active/retained split ensures timed-out tasks do not occupy concurrency slots.
// Both maps are ephemeral — they do not survive plugin or OpenCode restart.
// Retained tasks are bounded by TTL/max-entries lazy pruning.

import type { DynamicTaskConfig } from "./config.js";
import type { TimeoutController } from "./bound.js";

// ─── TaskLifecycleState ────────────────────────────────────────────

export type TaskLifecycleState =
  | "active"
  | "timeout_interrupting"
  | "timed_out_retained"
  | "completed"
  | "completed_after_timeout"
  | "error"
  | "interrupted";

// ─── Task State Types ──────────────────────────────────────────────

export interface ActiveTaskState {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  lineage: string[];
  state: TaskLifecycleState;
  isBackground: boolean;
  startedAt: number;
  timeoutNotified: boolean;
  completed: boolean;
  requestedModel?: string | undefined;        // model override for the child session
  dependsOn?: string[] | undefined;           // task dependencies (session IDs)
  timeoutHandle?: TimeoutController; // owned by the bound funnel; cancel, never clearTimeout
}

export interface RetainedTaskState {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  lineage: string[];
  state: TaskLifecycleState;
  isBackground: boolean;
  startedAt: number;
  retainedAt: number;
  timeoutNotified: boolean;
  completed: boolean;
  requestedModel?: string | undefined;
  dependsOn?: string[] | undefined;
  previousSessionId?: string | undefined; // set when this entry was created by task_continue
  abortError?: string | undefined;         // populated when client.session.abort() fails
}

// ─── Valid Transition Matrix ───────────────────────────────────────
// Valid transitions: key → [allowed target states]
// Invalid transitions throw.

const VALID_TRANSITIONS: Record<TaskLifecycleState, TaskLifecycleState[]> = {
  "active": ["completed", "timeout_interrupting", "timed_out_retained", "error", "interrupted"],
  "timeout_interrupting": ["timed_out_retained", "completed_after_timeout", "completed"],
  "timed_out_retained": [],  // terminal — no further transitions (must go via task_continue which spawns new)
  "completed": [],           // terminal
  "completed_after_timeout": [], // terminal
  "error": [],               // terminal
  "interrupted": [],         // terminal
};

// ─── RetainedBounds + TaskStore ─────────────────────────────────────
// Bounds drive internal pruning; onRetainedChange fires after every
// retained mutation so the ledger (Task 06) stays current without any
// caller remembering to persist. Both optional: bare stores behave exactly
// as before (no pruning, no callback).

export interface RetainedBounds {
  retainedTaskTtlMs: number;
  retainedTaskMaxEntries: number;
}

export interface TaskStore {
  activeTasks: Map<string, ActiveTaskState>;
  retainedTasks: Map<string, RetainedTaskState>;
  bounds?: RetainedBounds;
  onRetainedChange?: () => void;
}

// ─── createStateStore ──────────────────────────────────────────────

export function createStateStore(bounds?: RetainedBounds): TaskStore {
  return {
    activeTasks: new Map(),
    retainedTasks: new Map(),
    ...(bounds ? { bounds } : {}),
  };
}

// ─── registerActiveTask ────────────────────────────────────────────
// Registers a task in the active store. Throws if background count exceeds maxConcurrent.
// Returns the registered task state on success.

export function registerActiveTask(
  store: TaskStore,
  params: {
    childSessionId: string;
    parentSessionId: string;
    agentName: string;
    description: string;
    lineage: string[];
    isBackground: boolean;
    requestedModel?: string | undefined;
    dependsOn?: string[] | undefined;
  },
  config: DynamicTaskConfig,
): ActiveTaskState {
  // Count background tasks toward concurrency (sync tasks excluded)
  let bgCount = 0;
  if (params.isBackground) {
    for (const task of store.activeTasks.values()) {
      if (task.isBackground) bgCount++;
    }
    if (bgCount >= config.maxConcurrent) {
      throw new Error(
        `ConcurrencyLimitExceeded: Cannot register more than ${config.maxConcurrent} ` +
        `active background tasks (current: ${bgCount}). ` +
        `Wait for tasks to complete or increase maxConcurrent in config.`,
      );
    }
  }

  const task: ActiveTaskState = {
    childSessionId: params.childSessionId,
    parentSessionId: params.parentSessionId,
    agentName: params.agentName,
    description: params.description,
    lineage: params.lineage,
    state: "active",
    isBackground: params.isBackground,
    startedAt: Date.now(),
    timeoutNotified: false,
    completed: false,
    requestedModel: params.requestedModel,
    dependsOn: params.dependsOn,
  };

  pruneIfBounded(store);
  store.activeTasks.set(params.childSessionId, task);
  return task;
}

// ─── transitionState ───────────────────────────────────────────────
// Moves a task from one lifecycle state to another.
// Validates against the transition matrix.
// On terminal transitions from active, moves to retainedTasks.
// Returns the updated state object.

export function transitionState(
  store: TaskStore,
  childSessionId: string,
  toState: TaskLifecycleState,
): ActiveTaskState | RetainedTaskState {
  const active = store.activeTasks.get(childSessionId);
  let fromState: TaskLifecycleState;

  if (active) {
    fromState = active.state;
  } else {
    // Check retained tasks
    const retained = store.retainedTasks.get(childSessionId);
    if (!retained) {
      throw new Error(`Task "${childSessionId}" not found in active or retained tasks.`);
    }
    throw new Error(`Invalid transition: task "${childSessionId}" is in terminal state "${retained.state}".`);
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS[fromState];
  if (!allowed.includes(toState)) {
    throw new Error(
      `Invalid state transition: "${fromState}" → "${toState}" for task "${childSessionId}". ` +
      `Allowed transitions from "${fromState}": ${allowed.join(", ")}`,
    );
  }

  // Check transition destination — if terminal (timed_out_retained, completed, error), move from active to retained
  const isTerminal = ["timed_out_retained", "completed", "completed_after_timeout", "error", "interrupted"].includes(toState);

  if (isTerminal && active) {
    // Move from active to retained
    const retained: RetainedTaskState = {
      ...active,
      state: toState,
      retainedAt: Date.now(),
    };
    store.activeTasks.delete(childSessionId);
    store.retainedTasks.set(childSessionId, retained);
    pruneIfBounded(store);
    emitRetainedChange(store);
    return retained;
  }

  // Non-terminal transition (e.g., active → timeout_interrupting)
  if (active) {
    active.state = toState;
    return active;
  }

  // Should not reach here — but safe fallback
  throw new Error(`Unexpected transition state for task "${childSessionId}".`);
}

// ─── noteTimeoutFired ──────────────────────────────────────────────
// Marks an active task as timeout-fired (timeoutNotified + completed flags).
// The task stays active until transitioned — the flags record that the
// timeout path won the race. Throws if the task is not active.

export function noteTimeoutFired(
  store: TaskStore,
  childSessionId: string,
): ActiveTaskState {
  const active = store.activeTasks.get(childSessionId);
  if (!active) {
    throw new Error(`Task "${childSessionId}" is not active.`);
  }
  active.timeoutNotified = true;
  active.completed = true;
  return active;
}

// ─── markActiveCompleted ───────────────────────────────────────────
// Atomically reads and sets the completed flag on an active task.
// Returns the previous value (true when the timeout path already fired).

export function markActiveCompleted(
  store: TaskStore,
  childSessionId: string,
): boolean {
  const active = store.activeTasks.get(childSessionId);
  if (!active) {
    throw new Error(`Task "${childSessionId}" is not active.`);
  }
  const was = active.completed;
  active.completed = true;
  return was;
}

// ─── forceRetain ───────────────────────────────────────────────────
// Last-resort move into retained for races where the matrix rejects the
// transition (e.g. completion lands during the abort await). Bases on
// whatever is known (active preferred, else retained) and applies the patch.

export function forceRetain(
  store: TaskStore,
  childSessionId: string,
  patch: {
    state: TaskLifecycleState;
    timeoutNotified?: boolean;
    completed?: boolean;
    abortError?: string | undefined;
  },
): RetainedTaskState {
  const base = store.activeTasks.get(childSessionId)
    ?? store.retainedTasks.get(childSessionId);
  if (!base) {
    throw new Error(`Task "${childSessionId}" not found in active or retained tasks.`);
  }
  const retained: RetainedTaskState = {
    childSessionId: base.childSessionId,
    parentSessionId: base.parentSessionId,
    agentName: base.agentName,
    description: base.description,
    lineage: base.lineage,
    isBackground: base.isBackground,
    startedAt: base.startedAt,
    requestedModel: base.requestedModel,
    dependsOn: base.dependsOn,
    previousSessionId: "previousSessionId" in base ? base.previousSessionId : undefined,
    timeoutNotified: patch.timeoutNotified ?? base.timeoutNotified,
    completed: patch.completed ?? base.completed,
    retainedAt: Date.now(),
    state: patch.state,
  };
  if (patch.abortError !== undefined) {
    retained.abortError = patch.abortError;
  }
  pruneIfBounded(store);
  store.activeTasks.delete(childSessionId);
  store.retainedTasks.set(childSessionId, retained);
  emitRetainedChange(store);
  return retained;
}

// ─── stealTimeoutHandle ────────────────────────────────────────────
// Detaches the armed timeout from an active task and returns it so the
// caller (interrupt path, completion path) can cancel it. Returns undefined
// when the task is unknown or has no handle — both are benign.

export function stealTimeoutHandle(
  store: TaskStore,
  childSessionId: string,
): TimeoutController | undefined {
  const active = store.activeTasks.get(childSessionId);
  if (!active?.timeoutHandle) return undefined;
  const handle = active.timeoutHandle;
  delete active.timeoutHandle;
  return handle;
}

// ─── noteLateOutcome ───────────────────────────────────────────────
// Records a late terminal observation on a retained task without moving it.
// Permitted edges: timed_out_retained → completed_after_timeout | error
// (late completion), and any retained state → error (late failure).
// Anything else throws — terminal states do not regress.

export function noteLateOutcome(
  store: TaskStore,
  childSessionId: string,
  toState: "completed_after_timeout" | "error",
): RetainedTaskState {
  const retained = store.retainedTasks.get(childSessionId);
  if (!retained) {
    throw new Error(`Task "${childSessionId}" is not retained.`);
  }
  const allowed: TaskLifecycleState[] =
    retained.state === "timed_out_retained"
      ? ["completed_after_timeout", "error"]
      : ["error"];
  if (!allowed.includes(toState)) {
    throw new Error(
      `Invalid late outcome: "${retained.state}" → "${toState}" for task "${childSessionId}".`,
    );
  }
  retained.state = toState;
  emitRetainedChange(store);
  return retained;
}

// ─── restoreRetained ───────────────────────────────────────────────
// Crash-recovery bulk load: inserts ledger entries the store does not
// already track. Live state always wins over the ledger; unknown ids with
// valid records are retained, then pruned to bounds. Returns the count
// restored. Entries are pre-validated by loadTaskLedger.

export function restoreRetained(
  store: TaskStore,
  entries: Iterable<readonly [string, RetainedTaskState]>,
): number {
  let restored = 0;
  for (const [id, task] of entries) {
    if (store.activeTasks.has(id) || store.retainedTasks.has(id)) continue;
    store.retainedTasks.set(id, task);
    restored++;
  }
  if (restored > 0) {
    pruneIfBounded(store);
    emitRetainedChange(store);
  }
  return restored;
}

// ─── discardRetained ───────────────────────────────────────────────
// Removes a retained entry (e.g. on interrupt). Returns true when present.

export function discardRetained(store: TaskStore, childSessionId: string): boolean {
  const removed = store.retainedTasks.delete(childSessionId);
  if (removed) emitRetainedChange(store);
  return removed;
}

// ─── findTask ──────────────────────────────────────────────────────
// Looks up a task in active first, then retained. Returns the state or null.

export function findTask(
  store: TaskStore,
  childSessionId: string,
): ActiveTaskState | RetainedTaskState | null {
  // Read hygiene: evictions on read keep the ledger honest for recovery.
  if (pruneIfBounded(store) > 0) emitRetainedChange(store);
  const active = store.activeTasks.get(childSessionId);
  if (active) return active;
  const retained = store.retainedTasks.get(childSessionId);
  if (retained) return retained;
  return null;
}

// ─── listTasks ─────────────────────────────────────────────────────
// Read-only fleet snapshot for task_list. Prunes to bounds first so the
// view matches what recovery would see. Returns live references — views
// format immediately and never mutate.

export function listTasks(store: TaskStore): {
  active: ActiveTaskState[];
  retained: RetainedTaskState[];
} {
  if (pruneIfBounded(store) > 0) emitRetainedChange(store);
  return {
    active: [...store.activeTasks.values()],
    retained: [...store.retainedTasks.values()],
  };
}

// ─── pruneRetainedTasks ────────────────────────────────────────────
// Lazy pruning: removes expired retained tasks by TTL and max entries.
// Runs internally on every store op when bounds are set; direct calls
// remain supported (existing callers pass full config — structurally
// compatible with RetainedBounds). Returns number of pruned entries.

export function pruneRetainedTasks(
  store: TaskStore,
  limits: RetainedBounds,
): number {
  const now = Date.now();
  let pruned = 0;

  // Remove expired by TTL
  for (const [id, entry] of store.retainedTasks) {
    if (now - entry.retainedAt > limits.retainedTaskTtlMs) {
      store.retainedTasks.delete(id);
      pruned++;
    }
  }

  // Remove oldest entries if over max
  if (store.retainedTasks.size > limits.retainedTaskMaxEntries) {
    const entries = [...store.retainedTasks.entries()]
      .sort((a, b) => a[1].retainedAt - b[1].retainedAt); // oldest first
    const toRemove = store.retainedTasks.size - limits.retainedTaskMaxEntries;
    for (let i = 0; i < toRemove; i++) {
      const entry = entries[i];
      if (!entry) break;
      store.retainedTasks.delete(entry[0]);
      pruned++;
    }
  }

  return pruned;
}

// ─── pruneIfBounded + emitRetainedChange ───────────────────────────
// Internal plumbing: prune on bounded stores; notify (never throwing, so
// persistence can never break control flow) after retained mutations.

function pruneIfBounded(store: TaskStore): number {
  if (!store.bounds) return 0;
  return pruneRetainedTasks(store, store.bounds);
}

function emitRetainedChange(store: TaskStore): void {
  try {
    store.onRetainedChange?.();
  } catch {
    // Persistence must never break control flow.
  }
}
