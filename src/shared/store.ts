/**
 * The store: the one thing that outlives a single tool call.
 *
 * It lives in its own module because the store and the state machine are two
 * subjects, not one: this file owns the SET — what exists, and the only way to
 * change it — while ./task-state.js owns what a set means (the transition matrix,
 * capacity, dispatch-tree shape, hydration). The split is what lets the maps be
 * private: a module that cannot name the map cannot write it.
 *
 * The record types are imported with `import type`, so nothing of task-state's
 * runtime ends up in this file's dependency graph and the two do not form a cycle
 * at runtime. ledger-change.ts already takes its record types from there the same
 * way; `verbatimModuleSyntax` is what makes the erasure guaranteed rather than
 * conventional.
 */
//jscpd:ignore-start
import type { ActiveTaskState, RetainedTaskState } from "./task-state.js";
import type { DependencyWait, WaitRegistry } from "./dispatch-wait.js";
import { type LedgerChange, LedgerChangeKind } from "./ledger-change.js";
import type { SessionId } from "./ids.js";

//jscpd:ignore-end
/**
 * How the store tells its durable writer WHAT changed. Named once because the two
 * observers share a shape and a reason, and a reader who meets the signature
 * spelled out twice has to work out whether the halves really are one contract.
 */
export type LedgerChangeSink = (changes: readonly LedgerChange[]) => void;

/**
 * This was an interface with two public `Map`s and a pair of free functions that
 * took the store and mutated it, and that shape cannot hold an invariant. With
 * the maps public, a direct write to either was a legal statement in any of
 * the seven modules that hold a store, and the only thing between that and a
 * durable-ledger bug was a regex in the test suite — a gate that file itself
 * calls token-shape deterrence, because aliasing and field reassignment walk
 * past it. It did not hold inside this file either: `restoreActive` was a second
 * implementation of the same write, reachable and unenforced, and the entry cap
 * had to be re-implemented beside it (`pruneIfBounded`) for no reason other than
 * that the map was open.
 *
 * So the maps are private and every write is a named method. Reads stay open on
 * purpose — reading the running set is not a dangerous act — and `activeTasks`
 * hands out a `ReadonlyMap`, which is why the sixteen read sites in the seven
 * other modules needed no edit at all. What is now unrepresentable is the write.
 *
 * A write RETURNS the change it made rather than publishing it. The store does
 * not own which observer hears about it, and must not: a settle notifies the
 * running sink and then the settled one, in that order, while a boot restore
 * collects every change and fires once for the whole batch. Returning the change
 * is what keeps the write and the fact that must be persisted from being
 * separated — a caller that forgets to publish has a visible unused return value,
 * not a silent divergence between the file and the process.
 *
 * `waits` stays a public map. Dependency waits are a separate subject in
 * ./dispatch-wait.js, they are not durable state, and sealing them would be a
 * refactor of a module this change has no reason to touch.
 */
export class TaskStore implements WaitRegistry {
  waits = new Map<string, DependencyWait>();
  // Durable-state observer (Task 06): invoked after retained entries change.
  onRetainedChange?: LedgerChangeSink | undefined;
  // Durable-state observer (Task 11): invoked when a task STARTS or STOPS being
  // a running task — the set of what a crash would leave behind. Separate from
  // onRetainedChange because the two halves persist for different reasons, and
  // joined here so a settlement writes the whole file exactly once.
  onActiveChange?: LedgerChangeSink | undefined;

  readonly #active = new Map<SessionId, ActiveTaskState>();
  readonly #retained = new Map<SessionId, RetainedTaskState>();

  get activeTasks(): ReadonlyMap<SessionId, ActiveTaskState> {
    return this.#active;
  }

  get retainedTasks(): ReadonlyMap<SessionId, RetainedTaskState> {
    return this.#retained;
  }

  // ── the running set ───────────────────────────────────────────────
  // These two are the one write path into the running set. Every structural
  // change to a live task goes through here, so the durable ledger has exactly
  // one place to learn that a task exists or stopped existing — and, just as
  // deliberately, one place the advisory writers below do NOT touch: a heartbeat
  // or a mid-flight notice would otherwise put a file write on every host event,
  // turning the event head into a filesystem hot path. The advisory fields are
  // stripped on the way to disk anyway (durableActiveTask), because a fresh
  // process cannot verify them.

  /**
   * A task begins running.
   *
   * Writing to one half REMOVES it from the other, which is what makes "a task is
   * in exactly one half" a property of the store rather than a convention its
   * thirty call sites happen to keep. It was previously representable in both at
   * once, and one test documented the overlap as "should not happen in practice"
   * — which is how a running child once got persisted as `completed`: the ledger
   * heard about both halves and the boot pass reconciled one id twice.
   *
   * The call sites still pair this with an explicit `dropRetained`, and that is
   * deliberate rather than redundant: the pairing is what EMITS the second ledger
   * change, and the delete inside here is what makes the impossible unrepresentable
   * even if a future caller forgets.
   */
  markRunning(id: SessionId, record: ActiveTaskState): LedgerChange {
    this.#retained.delete(id);
    this.#active.set(id, record);
    return { id, kind: LedgerChangeKind.Running, record };
  }

  /**
   * A task stops running. Returns the change whether or not the task was running,
   * matching what the callers were told before this was a method: they fire on the
   * transition, not on the presence of an entry.
   */
  stopRunning(id: SessionId): LedgerChange {
    this.#active.delete(id);
    return { id, kind: LedgerChangeKind.Stopped };
  }

  // ── the settled set ───────────────────────────────────────────────

  /**
   * A task is retained as settled. Removes it from the running set, for the same
   * reason `markRunning` empties the settled one: the two halves are exclusive, and
   * the store — not its callers — is what makes that true.
   */
  markRetained(id: SessionId, record: RetainedTaskState): void {
    this.#active.delete(id);
    this.#retained.set(id, record);
  }

  /**
   * A retained record is gone — reclaimed as running, pruned, or forgotten. These
   * are the same write with three reasons, which is why the reason is a call site
   * and not an argument here: the reason is what the ledger is told, and the
   * ledger is told by the caller.
   */
  dropRetained(id: SessionId): boolean {
    return this.#retained.delete(id);
  }
}

/**
 * The one construction chokepoint: a store is born here and nowhere else, so a
 * future constructor argument is one edit and not thirty-one call sites.
 */
export function createTaskStore(): TaskStore {
  return new TaskStore();
}
