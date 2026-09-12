# 05 — Notification Gate

**Doctrine:** Tenets 1, 6, 11. Parent notification is a fragile, irreversible cross-session write — one audited dance, with a named outcome when the parent cannot be reached.

## Evidence

- `notifyParentSession` (`src/index.ts:306-321`): `session.prompt` into the parent, catch → `warn` log. No queue, retry, or persistence. Loss is silent to the planner.
- "Exactly-once" (`README.md:48`) rests on in-memory `completed`/`timeoutNotified` flags (`src/index.ts:328-329,427-428`) — at-most-once across the restart boundary where it matters.
- Completion-kind computation is spread across `handleChildLifecycleEvent` (`src/index.ts:430-440`) and `handleTimeout` (`src/index.ts:323-405`), each formatting via `formatParentNotification` with different subsets of context.

## Choke point

- **Primitive:** any write addressed to the parent session.
- **Funnel:** one `notifyParent(parentId, kind, payload)` gate: kind computed once from reconciled task state (not from which handler won the race), formatted once, delivered with one retry policy, recorded once on the task (notified kind + timestamp + delivery outcome).
- **Enforcement:** build invariant — no direct parent-directed `session.prompt` outside the gate. Kind strings (`completed` / `completed_after_timeout` / `timeout` / `error`) constructed only in the gate.
- **Contract test:** flaky-parent harness (parent busy, parent gone, transient prompt failure): asserts the recorded delivery outcome matches reality and that a late completion after timeout still produces exactly one `completed_after_timeout` record. Tests the real race (event vs timeout) with injected timers, not a mock of the formatter.
- **Degradation:** parent unreachable → task retains the notification payload, delivery outcome recorded as failed with reason, `task_result` surfaces it. The planner recovers by reading (Task 06), never by waiting for a prompt that will never arrive. No silent `warn`-and-drop.

## Scope

Collapse kind computation to one site, route both lifecycle and timeout paths through the gate, record delivery on the task. Keep message text compatible with existing `[dynamic-task-notify]` consumers.

## Litmus

A newcomer cannot notify the parent except through the gate — the build fails — and every notification has a queryable delivery record.

## Status

**Complete** — 2026-09-11. Proof: `resolveNotifyKind` matrix unit-pinned; `notifyParent` delivers with exactly one retry (250ms default, injectable) and records `{delivered, attempts, error}` in a bounded (200) ledger; all four notify sites (timeout, completion, late completion, prompt failure) route through the gate with gate-computed kinds; legacy `notifyParentSession` deleted and banned by build invariant; `task_result` surfaces the latest delivery record; full suite 262/262, coverage gate green, 0 clones.

Decisions: formatting stays in `task-formatting` (gate owns delivery+record, not text); failed delivery is data — the planner recovers by reading `task_result`, never by waiting; retry delay uses `globalThis.setTimeout` (same exemption shape as `REAL_TIMERS`).

Follow-up 2026-09-12 (field repro 2026-09-11T19:30:00.485Z: `session.error` + `session.status` + `session.idle` within 1ms, parent told success): three fixes at the decision point. (1) `getEventLifecycleStatus` returns `error` for error-typed events — `EventSessionError` carries `properties.error`, never a status field, so the old reader saw `""` and the gate computed `completed`. (2) The handler claims synchronously (steal + mark + `transitionState`) before any await — the transition is the single-winner gate; losers bail without notifying, and retained late-outcomes dedupe on unchanged state. (3) `extractSessionStatus` (task_result/task_status) reads the same message-error signal. The gate funnel itself (`resolveNotifyKind`) is unchanged.
