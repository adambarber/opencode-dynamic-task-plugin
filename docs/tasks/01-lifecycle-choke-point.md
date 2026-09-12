# 01 — Lifecycle Choke Point

**Doctrine:** Tenets 1, 3, 5, 8. Shared mutable task state must own its synchronization and its transitions. "Remember to transition correctly" is a discipline tax on every future author.

## Evidence

- `src/shared/task-state.ts:1-5` declares the model: active/retained split, ephemeral, TTL-bounded.
- `transitionState` (`src/shared/task-state.ts:144-196`) with `VALID_TRANSITIONS` (`src/shared/task-state.ts:60-68`) is the concentrated implementation — but it is a suggestion, not a funnel:
  - Direct mutation bypasses it: `task.completed = true`, `task.timeoutNotified = true` in `src/index.ts:328-329`, `active.completed = true` in `src/index.ts:428`.
  - Manual map surgery bypasses it: `store.activeTasks.delete` + `store.retainedTasks.set` fallback in `src/index.ts:367-375`; `store.retainedTasks.delete` in `src/index.ts:1178`.
  - `timed_out_retained` is terminal (`src/shared/task-state.ts:63`) yet `handleChildLifecycleEvent` mutates retained entries in place (`src/index.ts:484`) and `task_continue` transitions them (`src/index.ts:928,948`).
- `registerActiveTask` (`src/shared/task-state.ts:90-136`) is bypassable the same way — nothing prevents a raw `store.activeTasks.set`.

## Choke point

- **Primitive:** any mutation of `activeTasks` / `retainedTasks` / per-task flags.
- **Funnel:** `task-state.ts` owns all of it. Expose operations (`register`, `transition`, `noteTimeout`, `markNotified`), never the raw maps. `completed` / `timeoutNotified` become derived or set only inside the module.
- **Enforcement:** build invariant — no `store.activeTasks.set/delete`, `store.retainedTasks.set/delete`, or `.completed =` / `.timeoutNotified =` outside `task-state.ts`. AST walk, sanctioned module `task-state.ts` only (Tenet 9 exemption recorded co-located with the ban).
- **Contract test:** transition-matrix test against the real store (Tenet 12 — no mocked store): every valid edge moves, every invalid edge throws, terminal states are immovable except via the one sanctioned continuation path Task 07 defines.
- **Degradation:** invalid transition throws a named error with allowed edges; callers convert to `ERROR:` strings. Never silent fallback to manual surgery.

## Scope

Refactor `src/index.ts` call sites to the funnel; delete the fallback surgery in `handleTimeout`. Preserve per-call semantics (Tenet 10): background-only concurrency counting, retained TTL/max-entries behavior pinned by property tests before migration.

## Litmus

A newcomer cannot mutate task state without going through `task-state.ts` — the build fails on direct map/flag access.

## Status

**Complete** — 2026-09-11. Proof: lifecycle invariant passes with all six historical bypass sites (`index.ts` flag writes, manual map surgery, retained delete) routed through `noteTimeoutFired`, `markActiveCompleted` (atomic read-and-set, removes the check-then-set race), `forceRetain`, `discardRetained`; 8 funnel-op contract tests plus the pre-existing matrix/concurrency/pruning suites green; full suite 217/217. Retained-pruning internalization deferred to Task 06, which owns eviction.

Follow-up 2026-09-12 (field repro: timeout/completion race swallowed the notification): matrix gains `active → completed_after_timeout` — the timeout flags the task (still `active`) and the completion event lands before `handleTimeout` retains it; without the edge the transition threw and the outer catch swallowed it. `task_interrupt` cleans local state (steal + `interrupted` transition) on a confirmed server 404 instead of returning before cleanup; transient abort failures still preserve state for retry.
