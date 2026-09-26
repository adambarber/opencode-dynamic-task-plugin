# 11 — Durable Liveness and Delivery (IMPLEMENTED — M2 + M1 shipped)

**Doctrine:** Tenets 6 (one dance), 11 (deliberate degradation), 5 (shared state owns its scope). This is the M1/M2/M5/M10 epic: the ledger captures *settlement state* but neither *liveness* (actives vanish on restart) nor *delivery state* (a crash between `transitionState` and `deliverParent` leaves `completed`-forever with no notice and no evidence of the gap).

## The holes, stated once

- **M1.** Only retained records persist. Post-restart, still-running children keep running server-side; their terminal events find no record and drop silently. The store is the only index of "what was I running," and it is empty for actives.
- **M2.** `notifyLedger` is process memory. Crash inside the transition→delivery window strands a settled record with no notice and no trace of the missing notice.
- **M5/M10 fall out** once delivery state is durable: failed spawn-error notices become redeliverable, and notification history becomes auditable post-restart.

## Implementation notes (deviations from the design, and why)

- **The v3 file carries `pending` first; `active` joined it in the M1 cycle.** Split rather than half-wired: a reader that hydrated `active` with nothing writing it would be dead code, and a writer emitting `active: {}` while real actives existed would be a lie. The key is additive within v3 because there is exactly one reader (this plugin) — the wholesale-discard policy is for *versions*, not for keys added by the same version.
- **The running set's write funnel lives in `task-state.ts`, not in a `persistActive` beside the ledger dance.** The design put it there; the state machine is the better chokepoint, and the reason is the gap the original design left: `persistActive` is a function *call*, so every structural change to a live task must remember it, and the two sites that add or remove a running task (spawn, settlement) would each have to remember while the advisory writers (mid-flight notice, activity heartbeat) must deliberately *not*. Those two requirements are opposite, so the funnel has to be structural. It is now `setActive`/`removeActive` inside the state machine, guarded by the same observer the retained half uses (`onActiveChange`), with the existing store-mutation invariant covering the outside. The advisory fields are still stripped — at the ledger boundary (`durableActiveTask`), the one place that knows which half of a live record is durable — so the same funnel persists both halves, once, atomically.
- **A restored task settles `completed` when the host says the turn is `idle`, and `error` only when the host does not list it at all.** The design said "no turn running → settle error", which is right for a vanished child and wrong for a child that *finished* while the parent was down: settling that one `error` would report a failure nobody saw, and the transcript it does still have would prove the work landed. The two cases are different facts, the host's own status words tell them apart, and the whole point of the pass is that it reports what it observed.
- **A liveness read tolerates an unreadable transcript; `task_result` does not.** A vanished child's transcript fetch throws. Letting that escape would abandon the rest of the pass — one lost child stranding every task listed after it, which is the very hole the pass closes. So `readLiveness` answers "no messages" (it was asked "is a turn running, and when did it last write?"), while `task_result` keeps its strict fetch and its "the failed read says so" voice. The reconcile loop is also per-child guarded: a status channel that is down leaves tasks active (the safe reading) instead of settling them blind.
- **`pending` entries carry `parentSessionId`.** The design's `{ childSessionId, kind, text, attempts }` has no routing target, so a boot could not deliver the entry without looking the parent up out of the retained record — and a debt whose record was pruned would become undeliverable. The target belongs to the write, so the write carries it.
- **A held redelivery escalates by count instead of being capped.** A refused redelivery is dropped, as designed. A redelivery the host *holds* re-arms its own entry with `attempts` carried forward, so the next boot tries again with a visibly higher count. A hard cap would silently drop an undelivered notice — the exact deafness this epic exists to remove — so the count is the signal and the operator is the decider.

## Decisions (binding on the implementation)

- **Ledger v3, one migration.** `{ version: 3, tasks: {...retained}, active: {...}, pending: [...] }`. The v2 reader keeps discarding non-v3 wholesale (same policy as v1→v2: a partial past is worse than a clean one). `active` entries carry the full `ActiveTaskState` minus advisory fields (`lastNotice` never persists — a fresh boot owns no in-flight claims). `pending` entries are `{ childSessionId, kind, text, attempts }` written *before* the first delivery attempt and deleted on success — the only new write site, beside the retained observer.
- **Boot reconciliation is a one-shot pass, not a timer.** For each restored active: one live liveness read (the same one the read tools make — `session.status` for the server's turn status, the child's transcript for its own last message; `session.get` is not a source, its `Session` type carries no status field). Turn running → re-armed as active (its natural terminal event settles it; the generation it belonged to died with the process, so settle-dedup starts empty — safe because no delivery could have happened for it). Turn over (`idle`) → settled from its transcript, exactly as its own event would have. Not listed at all → settle `error` with a cause naming the loss of contact across the restart, and queue its notice in `pending`. No polling, no clocks — Task 09 stands.
- **Redelivery is at-least-once across restart, exactly-once within a boot.** A crash between attempts leaves ambiguity (did attempt 1 land?). The Tenet-11 direction: a duplicate notice after restart is observable and harmless; a missing notice is silent deafness. Prefer the duplicate. `pending` entries redeliver once at boot, oldest first, then delete — even on failure (a second boot must not retry forever; the record shows the attempts).
- **No cross-instance locking (M8 stands).** One directory, one instance remains the contract. v3 does not add lockfiles; concurrent writers stay last-writer-wins by documented misconfiguration.
- **Non-goals:** JSON output mode (declined — the voice stays markdown), discovery tools, auto-revive policy changes, retry budgets for failed turns.

## Choke points (all four components each)

- **Primitive «durable active set»:** funnel `setActive`/`removeActive` + `onActiveChange` in `task-state.ts`, durable shape at the boundary (`durableActiveTask` in `session-lifecycle.ts`); enforcement: the existing store-mutation invariant already bans `activeTasks.set|delete` outside the state machine — no new literal, no new rule; contract tests: kill-and-restore with live, idle and vanished sessions, plus a spawn that is on disk while running and gone once settled.
- **Primitive «pending delivery»:** funnel `queuePending`/`dropPending` in `notify.ts` beside the gate; enforcement: no `pending` writes outside the gate; contract tests: crash between transition and delivery redelivers exactly once at boot; double-crash deletes without looping.
- **Primitive «boot reconciliation»:** one function in `entry/state.ts` (`reconcileRestored`), called once from `initPluginState`; contract tests pin re-arm vs settle-error vs pending-redelivery per matrix.

## Test plan (TDD, behavior-first)

- Restore with a live session → active again, natural event settles and notifies once.
- Restore with a vanished session → settled `error` with the vanished-across-restart voice + notice queued.
- Restore with a session that finished while the parent was down → settled `completed`, never `error`.
- A spawned task is on disk while it runs, and absent from the running set the moment it settles.
- Pending entry at boot → one redelivery attempt, then gone regardless of outcome.
- v2 ledger on disk → discarded wholesale, clean boot (existing policy test extended).
- Suite pins: no new timers anywhere (existing scanner), no `any`, zero clones.

## Litmus

Pull the process plug between a child's last turn and its notice: after reboot the operator sees the outcome exactly once (or twice with the duplicate documented) — never zero times with a `completed` record and no evidence.

## Status

**Cycle 1 (M2, durable delivery, 2026-09-26):** ledger v3 `{ version, tasks, pending }`; `queuePending`/`dropPending` in the gate, entry written before every dial and retired on a known outcome only; boot hydrates the queue and pays it oldest-first, fire-and-forget so a held parent cannot delay tool registration; `carriedAttempts` makes a re-offered write escalate instead of resetting. Suite: 419 passing, 0 clones, coverage gate green.

**Cycle 2 (M1, durable active set + boot reconciliation, 2026-09-26):** v3 gains `active`; the running set persists through the state machine's own write funnel, so a spawn and a settlement are the only two events that write it and the advisory writers cannot; `restoreActive` hydrates it and `reconcileRestored` spends one liveness read per restored task — still working stays active, finished-while-down settles completed, unlisted settles error with the vanished voice; the settlement path itself was extracted (`settleRunningChild`) so the boot pass and the event head cannot drift apart. Suite: 425 passing, 0 clones, coverage gate green.

**M5/M10 ride along, M7/M13/lockfile stay declined.**
