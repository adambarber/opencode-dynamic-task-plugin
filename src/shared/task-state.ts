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
  requestedModel?: string;        // model override for the child session
  dependsOn?: string[];           // task dependencies (session IDs)
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
  requestedModel?: string;
  dependsOn?: string[];
  previousSessionId?: string; // set when this entry was created by task_continue
  abortError?: string;         // populated when client.session.abort() fails
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

// ─── TaskStore ─────────────────────────────────────────────────────

export interface TaskStore {
  activeTasks: Map<string, ActiveTaskState>;
  retainedTasks: Map<string, RetainedTaskState>;
}

// ─── createStateStore ──────────────────────────────────────────────

export function createStateStore(): TaskStore {
  return {
    activeTasks: new Map(),
    retainedTasks: new Map(),
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
    requestedModel?: string;
    dependsOn?: string[];
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
  config: DynamicTaskConfig,
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
    abortError?: string;
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
  store.activeTasks.delete(childSessionId);
  store.retainedTasks.set(childSessionId, retained);
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
  active.timeoutHandle = undefined;
  return handle;
}

// ─── discardRetained ───────────────────────────────────────────────
// Removes a retained entry (e.g. on interrupt). Returns true when present.

export function discardRetained(store: TaskStore, childSessionId: string): boolean {
  return store.retainedTasks.delete(childSessionId);
}

// ─── findTask ──────────────────────────────────────────────────────
// Looks up a task in active first, then retained. Returns the state or null.

export function findTask(
  store: TaskStore,
  childSessionId: string,
): ActiveTaskState | RetainedTaskState | null {
  const active = store.activeTasks.get(childSessionId);
  if (active) return active;
  const retained = store.retainedTasks.get(childSessionId);
  if (retained) return retained;
  return null;
}

// ─── pruneRetainedTasks ────────────────────────────────────────────
// Lazy pruning: removes expired retained tasks by TTL and max entries.
// Call before any dynamic_task/task_continue/task_result read.
// Returns number of pruned entries.

export function pruneRetainedTasks(
  store: TaskStore,
  config: DynamicTaskConfig,
): number {
  const now = Date.now();
  let pruned = 0;

  // Remove expired by TTL
  for (const [id, entry] of store.retainedTasks) {
    if (now - entry.retainedAt > config.retainedTaskTtlMs) {
      store.retainedTasks.delete(id);
      pruned++;
    }
  }

  // Remove oldest entries if over max
  if (store.retainedTasks.size > config.retainedTaskMaxEntries) {
    const entries = [...store.retainedTasks.entries()]
      .sort((a, b) => a[1].retainedAt - b[1].retainedAt); // oldest first
    const toRemove = store.retainedTasks.size - config.retainedTaskMaxEntries;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      store.retainedTasks.delete(entries[i][0]);
      pruned++;
    }
  }

  return pruned;
}
