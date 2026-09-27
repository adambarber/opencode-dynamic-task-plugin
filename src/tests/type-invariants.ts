/**
 * Type-level pins for the store's write invariant. Nothing here runs and nothing
 * imports this file: the COMPILER is the assertion.
 *
 * The store's maps used to be public on an interface, and the write funnel was
 * held by a regex in safety-invariants.test.js. A regex is token-shape deterrence
 * — it cannot tell a write from a mention of a write, and it only ever guarded
 * the file boundary, so inside the file that owned the funnel nothing enforced
 * anything. The claim this file makes is the stronger one: the write does not
 * compile.
 *
 * `@ts-expect-error` is not a bypass and nothing is silenced here. The directive
 * ASSERTS that an error exists on the next line. If a map is ever reopened, or the
 * class is replaced by an interface again, the error stops happening and
 * TypeScript reports an unused '@ts-expect-error' directive — so `npx tsc
 * --noEmit`, the authoritative gate, fails on the regression itself. That is the
 * opposite of `any`, which fails silently in the same situation.
 */
import type { DependencyWait } from "../shared/dispatch-wait.js";
import { createTaskStore, TaskStore } from "../shared/store.js";
import type { ActiveTaskState, RetainedTaskState } from "../shared/task-state.js";

const store = createTaskStore();

/**
 * The values the write probes pass. Typed, and `declare`d so they cost nothing at
 * runtime: with a placeholder like `undefined` the call still errors on the
 * ARGUMENT, and `@ts-expect-error` would be satisfied by that instead of by the
 * missing method — a pin that proves the wrong thing. The argument has to be
 * correct so the only error left on the line is the one being asserted.
 */
declare const anActive: ActiveTaskState;
declare const aRetained: RetainedTaskState;

/** A wait, built for real: the one map left open, and the reason it is worth a pin. */
const wait: DependencyWait = {
  description: "t",
  parentSessionId: "ses_parent",
  dependsOn: [],
  dependsOnSettled: [],
  queuedAt: 0,
};

// ── the running set is a ReadonlyMap, so a write is not a type error ──────────
// @ts-expect-error  ReadonlyMap has no `set`.
store.activeTasks.set("ses_x", anActive);
// @ts-expect-error  ReadonlyMap has no `delete`.
store.activeTasks.delete("ses_x");
// @ts-expect-error  ReadonlyMap has no `clear`.
store.activeTasks.clear();
// @ts-expect-error  ReadonlyMap has no `set`.
store.retainedTasks.set("ses_x", aRetained);
// @ts-expect-error  ReadonlyMap has no `delete`.
store.retainedTasks.delete("ses_x");

// ── a plain object is no longer a store ────────────────────────────────────────
// The interface this replaced was satisfied by any object literal with the right
// shape, which is how the suite ended up building stores that were never stores:
// they had the two maps and none of the behaviour, and they worked only until
// something needed the funnel.
// @ts-expect-error  missing the private maps and the five write methods.
const fake: TaskStore = { activeTasks: new Map(), retainedTasks: new Map(), waits: new Map() };

// ── and both halves of what stays open are pinned, so neither is an oversight ──
// Reading the running set is not a dangerous act, so the getter hands out a
// ReadonlyMap rather than a copy; the sixteen read sites in seven other modules
// depend on that being a view and not a snapshot.
const readable: ReadonlyMap<string, unknown> = store.activeTasks;
const size: number = store.activeTasks.size;
const ids: string[] = [...store.activeTasks.keys()];

// Dependency waits are a separate subject in ./dispatch-wait.js: transient, not
// durable, and sealing them would be a refactor of a module that had no other
// reason to move. This line FAILS to compile if a future change seals them without
// saying so — which is the point of writing it down rather than leaving it
// implied by the absence of a comment.
store.waits.set("ses_parent t", wait);

export type _Pins = [typeof readable, typeof size, typeof ids, typeof fake];
