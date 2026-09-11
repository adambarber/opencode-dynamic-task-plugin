# 02 — Execution Bound

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
