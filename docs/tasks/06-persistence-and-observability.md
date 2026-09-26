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

Follow-up 2026-09-22 (review finding: module singletons vs per-instance claim): audited every process-global. Correction to the first version of this note, which overclaimed: the id-keyed ledgers (`notifyLedger`/`gateLedger`/`notifyChains`, `questionSessions`, agent-cache epoch) are unrepresentable-cross-instance by server-unique keys or client isolation — that half stands. The debug root is the opposite: `configureDebugRoot` reroutes every instance's later lines (misrouting, not collision), accepted as residual because debug is best-effort, off by default, and single-instance is the norm — per-instance scoping would thread a root through ~20 call sites for diagnostics-only gain. The entry claims per-instance capture for the store/config alone.

Follow-up 2026-09-22 (single-instance assumption stated): two plugin instances sharing one project directory both observe `onRetainedChange` and rename over the ledger — atomic, so never torn, but last-writer-wins can silently clobber the other's mutation. One directory, one instance; no lockfile dance for a configuration that should not exist.

Follow-up 2026-09-25 (field repro: a working child reads as silent — the Batch A stall line could only fire falsely): the activity line derived from `max(startedAt, lastNotice.at)`, so every child that did not call `task_notify` reported its spawn age indefinitely and tripped the 10-minute "stalled" warning while demonstrably working. Fix is the Task 01 activity heartbeat (one writer, fed by the event head), and the render now reads the newest of three clocks — observed event, explicit notice, spawn as the floor. It renders as `Last plugin event:` rather than `Last activity:`, because the plugin's event stream is not the child's activity: a long tool call is silent in it by construction, and a line that names its source cannot be read as proof of a stall. The warning on top of it names the same blind spot ("one long tool call is silent too") rather than asserting a stall it cannot distinguish from a long-running tool, and it fires only for a task the store still calls active. The child's own clock is a separate, sourced line (`Last child message:`, from its transcript) and the server's turn status is a third (`Server status:`) — three sources, each named, none inferred.
