# 02 — Execution Bound

> **SUPERSEDED by cycle 09 (`09-non-blocking-settlement.md`), 2026-09-12.**
> The TimerProvider funnel this cycle built was deleted: per-call clocks raced
> on one session and the first expiry deafened the ledger to the child's real
> outcome. Settlement now lives solely at the notification layer. Kept as the
> record of what was bound and why the bound itself was the bug.

**Doctrine:** Tenets 2, 7, 11. Bound execution, not inputs. Every bound has one named place and one deliberate, observable outcome.

## Evidence

- `POLL_INTERVAL` defined `src/index.ts:55`, referenced nowhere — the reconciliation bound was deleted, leaving events-or-timeout duality.
- Sync path `src/index.ts:807-833` arms *two* timers for one wait: a `setTimeout` callback (line 810) plus a `Promise.race` timer (lines 823-825), with a `timedOut` flag shared between them. Double-fire transitions are possible.
- Background path `src/index.ts:853-858` arms `handleTimeout`, which awaits `client.session.abort` with its own 5s inner race (`src/index.ts:342-346`) — a bound inside a bound, unnamed and untested in combination.
- Timeout numbers live in three places: `src/shared/config.ts:42-55` defaults, env parsing (`src/shared/config.ts:133-147`), per-call clamp (`src/shared/config.ts:85-103`). Consolidation has not yet been run as a bug-finding exercise (Tenet 7).

## Choke point

- **Primitive:** any wait on child work (`dynamic_task` sync, `task_continue`, background timeout arm).
- **Funnel:** one `withBound(ms, work)` helper: single timer per wait, single timeout owner, abort policy injected from config. No raw `timerProvider.setTimeout` at call sites.
- **Enforcement:** build invariant — `setTimeout` for task waits appears only in the bound module. Timer injection (`TimerProvider`, `src/shared/config.ts:13-21`) stays so tests remain deterministic without mocking the contract (Tenet 12 corollary: real sleeps near real I/O; fake timers only against injected seams).
- **Contract test:** property tests — timeout always fires within `bound + epsilon`, early completion always cancels the timer (no post-completion timeout win), concurrent waits are independent. Best-of-N timing with absolute ceiling per Tenet 10, not single-shot flaky asserts.
- **Degradation (documented, one per mode):** `interrupt` → abort attempted, abort outcome recorded on the retained entry (`abortError` exists at `src/shared/task-state.ts:53` — keep it), caller gets `(Timed out after Ns. Session: …)` with resume guidance; `notify`/`notify_untrack` → state moves, no abort. Timeout and completion are distinguishable in every return shape — never an accidental default.

## Scope

Collapse the dual timers, route all three wait sites through the funnel, centralize named budgets. Out of scope: changing default durations — preserve semantics, pin first.

## Litmus

A newcomer cannot add a second timer to a wait or inline a literal timeout — the build fails; and every bound's fire path is observable in output and logs.

## Known gap (found during foundation, fixed here)

`task_interrupt` transitioned state but never cleared the stored timeout handle — fixed via `stealTimeoutHandle` + `cancel()` in the interrupt path, pinned by the recording-timer integration test.

## Status

**Complete** — 2026-09-11. Proof: `bound.test.js` (11 tests: fire-once, idempotent cancel, single-timer call-shape, unref, bound race/slow/reject/cancel) plus `stealTimeoutHandle` unit tests plus interrupt-cancel/notify-mode integration pins green; sync prompt race (formerly two timers), retained try-existing race, `waitForPendingSync`, and the background arm all route through `startTimeout`/`withBound`; abort budget centralized as `ABORT_TIMEOUT_MS`; full suite 230/230, timer-shape invariant green, 0 clones. Decisions: handles are unref'd so waits never hold the host open; late settlement is swallowed, never an unhandled rejection; `waitForPendingSync` keeps the waiter map (Task 03 owns single-wait), the bound owns its timer.

Follow-up 2026-09-25 (a bound must not demand a promise, and the seam is the suite's, not one test's): two things the primitive got wrong once the notify gate was the first production caller. (1) `withBound` reached for `.then` on its work result, so a client that answers SYNCHRONOUSLY — ordinary, not exotic — raised a `TypeError` inside the gate. The caller read that as a failed delivery: a 200ms retry, a record blaming the wrong thing, and a settlement that looked lost. `work` is now `() => T | Promise<T>` and is invoked through `Promise.resolve().then(work)`, which also turns a synchronous throw into the rejection it is. Contract-pinned in `execution-bound.test.js`. (2) Shrinking a deadline is now `shrinkBoundsForTesting(ms)` returning the restore, used by both the notify unit tests and the integration tests — a test may shorten a deadline, never substitute for one, and the seam lives with the primitive that owns the number. Also: the two bound names are `READ_BOUNDS.transcript` (5s — one call to a local server) and `WRITE_BOUNDS.parentPrompt` (2s — a parent works for minutes at a stretch, so "busy" is the ordinary case and the bound exists to answer now, not to give up).
