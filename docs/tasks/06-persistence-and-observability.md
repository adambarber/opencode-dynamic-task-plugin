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

## Status

**Complete** — 2026-09-11. Proof: versioned full-record ledger round-trips, rejects corrupt/unknown-version/foreign entries, and writes through injectable paths (no CWD pollution in unit tests); store owns bounds + `onRetainedChange` (active-only writes stay silent), pruning internal to register/transition/forceRetain/findTask/listTasks; crash recovery rehydrates via `restoreRetained` (live state wins); `task_list`/`task_status` (pure store reads — status works with the API down) production-driven; README lists all six tools; full suite 272/272, coverage gate green, 0 clones.

**Amendment (live-smoke finding, 2026-09-11):** the injectable-path guarantee held for unit tests but the plugin's own wiring called `loadTaskLedger()`/`saveTaskLedger(map)` with the CWD-relative default — every integration boot persisted into the suite's working directory, and the real 15:01 ledger contained 10 phantom `ses_integration_*`/`ses_tools_*` tasks restored at startup. Fix at the choke point: paths now derive from the host-provided project `directory` (`resolveTaskLedgerPath`, same root as the config file); `filePath` is a required param, so a CWD-defaulting call is a compile error; debug logs are scoped the same way (`configureDebugRoot`); integration harnesses boot in fresh temp dirs; a behavior test pins "retained writes land in the project dir, the process cwd is untouched", and a scanner bans state-path literals outside the two dances. Detection-gap lesson recorded: a suite that drives real persistence must assert where persistence lands.

Decisions: ledger file is `.dynamic-task-ledger.json` (old inverted map deleted with its tests; stale `.dynamic-task-ids.json` removed); `pruneRetainedTasks` kept exported with a narrowed limits param (existing callers type-check unchanged); `task_status` reads the store while `task_result` reads the API — complementary, not redundant; read-tool shell shared via `sessionReadTool` after jscpd flagged the definition boilerplate.

Follow-up 2026-09-22 (review finding: Windows ledger writes): `saveTaskLedger` derived the parent dir with a hardcoded POSIX `lastIndexOf("/")`, so backslash ledger paths skipped `mkdirSync` and persistence silently degraded to never-saved on Windows. Fixed at the dance with `path.dirname` (bare filenames still skip, as before). No POSIX behavior change — platform-only defect, pinned by reading, suite-green proves no regression.

Follow-up 2026-09-22 (review finding: module singletons vs per-instance claim): audited every process-global — `debugRoot`, `notifyLedger`/`gateLedger`/`notifyChains`, `questionSessions`, `agentCacheEpoch`. Tenet-9 exemption recorded: each is keyed by server-unique ids (sessions, questions) or isolates by client (agent-cache WeakMap; the epoch only invalidates), so cross-instance interference is unrepresentable and only bounded memory is shared. The entry comment now claims per-instance capture for the store/config alone. No per-instance plumbing: a defect class that never recurs gets a documented exemption, not a refactor.
