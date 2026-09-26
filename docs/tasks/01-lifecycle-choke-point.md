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

Follow-up 2026-09-25 (field repro: subagents never reported recent activity): the store had no activity field, so "activity" was inferred from two write sites that are silent during ordinary work (`startedAt` and `task_notify`). The event head — the only place that sees a child's `message.updated`/`message.part.*`/`session.status` traffic — forwarded only terminal events, so the observation choke point and the mutation choke point never met. Added `noteActivity`, the single writer for the advisory `lastActivityAt` (sibling of `annotateNotice`, stripped at settlement so the durable ledger carries no heartbeat), fed by one line in the event head before any gate. The Task 01 scanner's field alternation now includes `lastActivityAt`: a direct write anywhere but `task-state.ts` fails the build. Detection gap closed: the new production-driven test in `background-completion.test.js` fires a host-shaped progress event at a real spawned child and compares the two rendered clocks — it failed at `started=1s activity=1s` with the heartbeat line removed.

Follow-up 2026-09-25 (field repro: one steer, three "completed successfully" notices, the last one 109s before the child actually finished): the same heartbeat, asked a second question. `noteActivity` could not tell *which turn* it was observing, so the steer claim had to be a one-shot boolean — and a turn end is published more than once (the host sent 282 `session.status` and 9 `session.idle` events for one such child), so echo #1 ate the claim and echo #2 settled the *replacement* turn as completed, permanently deafening the ledger to the child's real outcome. `noteActivity` now takes the terminality the head has already decided, and writes two stamps instead: `lastActivityAt` (everything) and `turnLiveAt` (non-terminal only — a turn ENDING is not the turn working, and counting it is what let an echo vouch for itself). `markTurnReplacement`/`clearTurnReplacement` replaced `markSteerPending`/`consumeSteerPending`, and every revival stamps `replacedAt` too, because a revival replaces a turn exactly as a steer does. The settle gate is one predicate, `terminalEventIsAttributable`, and it is right for any number of stale copies rather than one. Scanner alternation extended to both new fields. Detection gap closed twice: the harness's `settle` now ends a turn the way the host does (seen working, then its ending), because a turn that ends without ever being seen working is not a shape the host produces; and `events.status` carries the host's nested `{type}` spelling instead of a string shorthand. M9's auto-revive lost its original settler (no terminal event can win a steer any more) and was re-pointed at the one that remains — the replaced turn's prompt delivery failing inside the abort window — which needed a `gateChildPrompt` hook the abort gate had no equal for.
