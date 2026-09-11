# 06 — Persistence and Observability

**Doctrine:** Tenets 6, 10. Crash recovery is an atomic-write dance; retained history is a bounded cache — each encoded once, with preserved semantics pinned by property tests.

## Evidence

- Store self-describes as ephemeral (`src/shared/task-state.ts:1-5`); `pluginState`, `taskIdToSessionId`, `questionIdToSessionId`, `cachedAgents` all die with the process (`src/index.ts:51-52,69,112-114`).
- `saveTaskIdMap` already does the atomic dance correctly (temp + rename, `src/shared/session-lifecycle.ts:117-124`) — but persists the inverted content from Task 00, and only the ID map, not task state. The dance is right; what flows through it is wrong.
- `pruneRetainedTasks` (`src/shared/task-state.ts:217-244`) is a correct bounded-evict implementation with no encapsulation (Tenet 5): callers must remember to call it (`src/index.ts:719,912`), and raw-map access can bypass it.
- `task_list` / `task_status` are documented (`README.md:23-24`) and absent (`src/index.ts` tool block). `task_result` already formats single-task views (`formatTaskResultSummary`); fleet visibility has no funnel at all.

## Choke point

- **Primitive (two, narrow — not a god module):** (a) durable task ledger writes; (b) retained-history eviction. One module each; the ledger reuses the existing atomic-write dance, the eviction lives inside the store (operations, never raw maps — extends Task 01).
- **Funnel:** all task-state changes flow through the store (Task 01), which persists through the ledger dance; all reads for `task_result` / `task_list` / `task_status` are pure views over the same store. `pruneRetainedTasks` becomes internal (called on every store op), not a caller-remembered preamble.
- **Enforcement:** build invariant — no direct `writeFileSync`/`renameSync` for task data outside the ledger module; no `pruneRetainedTasks` calls from tool handlers (it is internal now).
- **Contract test:** crash-recovery property — write N tasks, kill mid-write, reload: original survives, temp cleaned, ledger parses (extends the existing atomicity guarantee to real task payloads). Eviction properties — TTL expiry and max-entries LRU order hold under insertion sequences, not just single examples.
- **Degradation:** corrupt ledger → start empty with a logged warning (current `loadTaskIdMap` behavior, kept deliberately); over-cap retained → oldest evicted, eviction counted and observable via `task_list`.

## Scope

Fix the persisted payload (full task records, correct key direction), internalize pruning, ship `task_list` and `task_status` as read-only views. No scheduler, no queue — visibility first.

## Litmus

A newcomer cannot persist task data except through the ledger dance, cannot bypass eviction, and cannot add a tool-visible state field without it appearing in the list/status views.
