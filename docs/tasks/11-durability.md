# 11 — Durable Liveness and Delivery (DESIGN — not yet implemented)

**Doctrine:** Tenets 6 (one dance), 11 (deliberate degradation), 5 (shared state owns its scope). This is the M1/M2/M5/M10 epic: the ledger captures *settlement state* but neither *liveness* (actives vanish on restart) nor *delivery state* (a crash between `transitionState` and `deliverParent` leaves `completed`-forever with no notice and no evidence of the gap).

## The holes, stated once

- **M1.** Only retained records persist. Post-restart, still-running children keep running server-side; their terminal events find no record and drop silently. The store is the only index of "what was I running," and it is empty for actives.
- **M2.** `notifyLedger` is process memory. Crash inside the transition→delivery window strands a settled record with no notice and no trace of the missing notice.
- **M5/M10 fall out** once delivery state is durable: failed spawn-error notices become redeliverable, and notification history becomes auditable post-restart.

## Decisions (binding on the implementation)

- **Ledger v3, one migration.** `{ version: 3, tasks: {...retained}, active: {...}, pending: [...] }`. The v2 reader keeps discarding non-v3 wholesale (same policy as v1→v2: a partial past is worse than a clean one). `active` entries carry the full `ActiveTaskState` minus advisory fields (`lastNotice`, `steerPending` never persist — a fresh boot owns no in-flight claims). `pending` entries are `{ childSessionId, kind, text, attempts }` written *before* the first delivery attempt and deleted on success — the only new write site, beside the retained observer.
- **Boot reconciliation is a one-shot pass, not a timer.** For each restored active: one `session.get` probe. Session alive → re-armed as active (its natural terminal event settles it; the generation it belonged to died with the process, so settle-dedup starts empty — safe because no delivery could have happened for it). Session gone → settle `error` ("session vanished across restart") and queue its notice in `pending`. No polling, no clocks — Task 09 stands.
- **Redelivery is at-least-once across restart, exactly-once within a boot.** A crash between attempts leaves ambiguity (did attempt 1 land?). The Tenet-11 direction: a duplicate notice after restart is observable and harmless; a missing notice is silent deafness. Prefer the duplicate. `pending` entries redeliver once at boot, oldest first, then delete — even on failure (a second boot must not retry forever; the record shows the attempts).
- **No cross-instance locking (M8 stands).** One directory, one instance remains the contract. v3 does not add lockfiles; concurrent writers stay last-writer-wins by documented misconfiguration.
- **Non-goals:** JSON output mode (declined — the voice stays markdown), discovery tools, auto-revive policy changes, retry budgets for failed turns.

## Choke points (all four components each)

- **Primitive «durable active set»:** funnel `persistActive`/`restoreActive` in `session-lifecycle.ts` beside the ledger dance; enforcement extends the state-path-literal scanner if new literals appear (none should — same two dances); contract tests: kill-and-restore with live + vanished sessions.
- **Primitive «pending delivery»:** funnel `queuePending`/`dropPending` in `notify.ts` beside the gate; enforcement: no `pending` writes outside the gate; contract tests: crash between transition and delivery redelivers exactly once at boot; double-crash deletes without looping.
- **Primitive «boot reconciliation»:** one function in `entry/state.ts` (`reconcileRestored`), called once from `initPluginState`; contract tests pin re-arm vs settle-error vs pending-redelivery per matrix.

## Test plan (TDD, behavior-first)

- Restore with a live session → active again, natural event settles and notifies once.
- Restore with a vanished session → settled `error` with the vanished-across-restart voice + notice queued.
- Pending entry at boot → one redelivery attempt, then gone regardless of outcome.
- v2 ledger on disk → discarded wholesale, clean boot (existing policy test extended).
- Suite pins: no new timers anywhere (existing scanner), no `any`, zero clones.

## Litmus

Pull the process plug between a child's last turn and its notice: after reboot the operator sees the outcome exactly once (or twice with the duplicate documented) — never zero times with a `completed` record and no evidence.

## Status

**Design** — 2026-09-22. No code. Implementation order behind Batches A–C; M5/M10 ride along, M7/M13/lockfile stay declined.
