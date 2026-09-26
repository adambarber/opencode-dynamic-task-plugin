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

Follow-up 2026-09-14 (adversarial review F-6): the record distinguishes outcomes, not just success/failure. Duplicate suppression writes `suppressed: true` (attempts 0, never dialed); a parentless settlement writes attempts 0 with parent `unknown`. `task_result`/`task_status` render "Suppressed (duplicate — already delivered)" and "Not delivered (no parent session)" — FAILED is reserved for real attempts that failed. Claims/commits are now generation-bound (see 09): a pre-revival commit emits history but reserves nothing.

Follow-up 2026-09-22 (transient failure guidance): error settlements now judge what they report — `isTransientOutcomeError` (`prompt.ts`) matches the outcome's error detail against transport + provider-blip markers and, on a hit, appends a resume hint naming `task_continue`. Advisory only (Tenet 2): the markers never gate kind or state, so the worst case is a wrong hint, never a wrong settlement. Fatal causes carry no hint. No auto-retry by design: retrying a failed turn needs a budget, and the settlement layer arms no clocks — the operator stays the retry loop.

Follow-up 2026-09-22 (orchestration audit C1: read-path race + tag collision): `task_result` reported the live API inference as `Status` for active tasks while `task_continue` gated on store state — a child that merely spoke via `task_notify` read `completed` then refused as still-running. `Status` now reports the tracked store state verbatim (the store is the liveness authority); the live inference renders as a subordinate `Live inference` block for active tasks only, explicitly advisory. Notices and settlements also split wire tags: mid-flight voice emits `[dynamic-task-notice]`, settlements keep `[dynamic-task-notify]` (clean break, no dual-emit) — settlement vs. spoke is routable without parsing prose.

Follow-up 2026-09-25 (the advisory block is deleted, not relabelled): "advisory" was read as authoritative anyway — a caller would settle on `Live inference: completed` and a real running child looked finished. An advisory line is a liability when the thing it hedges is the store's own state, so the block is gone and what remains are sourced facts: `Server status:` (the server's word), `Last child message:` (the child's transcript), `Last plugin event:` (what this plugin's event head saw). `Status` is the store's state and stays the sole authority on settleability; a session with no store record reads as the server's own word, or `unknown` when the server lists none.

Follow-up 2026-09-25 (a held write is a fourth outcome, not a failure): the host ACCEPTS a prompt to a mid-turn parent and holds the request until that turn ends — proven in the field, where a completion notification sat on the wire for twenty minutes and landed the moment the parent's turn finished. The gate could not wait that long without holding the event pump, so the write now runs under `PARENT_WRITE_BOUND_MS` (2s) and the caller gets an answer now. What the write is doing at that moment is not a failure and must never read as one: the record gets `pending: true` — dialed, unanswered, may yet arrive — and the request is left in flight, with the claim still held so nothing duplicates behind it. A held write is NOT retried (the host may still deliver the first copy) and the record corrects itself to the real answer whenever the host returns. This is why the caller's `false` and the parent's eventual receipt can both be true at once, and why `task_result` names the state instead of guessing: `PENDING — dialed, the parent session has not answered; it may still arrive`. Reached through the bound, not through a per-call-site timeout (Tenet 1): every parent write is now bounded at the one primitive.

A reset carries its own invariant: a claim remembers the gate epoch it was issued under, so an answer that arrives after `clearNotifyLedger()` lands in nothing. The per-child generation cannot catch this — a reset restarts those at zero, and the same child id may now belong to an entirely different child whose first notification a stale "delivered" would suppress as a duplicate. Contract-pinned in `notify.test.js` ("an answer that arrives after the gate was reset lands in nothing").
