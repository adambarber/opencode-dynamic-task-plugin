# 09 — Non-Blocking Settlement

**Doctrine:** Tenets 3, 7, 11. Settlement is a property of the notification layer, never of a call site. A wall-clock bound placed where a lifecycle signal belongs converts a stall into a silent lie; the fix is to remove the clock, not tune it.

## Evidence (pre-cutover, 2026-09-12 field repro)

- Two clocks raced on one session: spawn armed 300s (`timeoutHandle`), `task_continue` stacked a 120s bound on the same task; the shorter one expired first and drove the task into `timed_out_retained` — a terminal state with no outgoing edge — permanently deafening the ledger to the child's real outcome.
- The child never died (`timeoutBehavior: "notify"`); its findings arrived only because the operator pasted them out-of-band. A green `task_result` frozen at 11 messages across four reads was the falsifiable signature.
- Notification text reported `config.defaultTimeoutMs` (900s) for a 300s bound: `ActiveTaskState` never carried the per-call value. The reviewer's validated triage (56 findings) sorted the rest of the timer funnel into "delete, don't fix" — see the cutover acceptance list.

## Decisions

- **No per-call clocks, anywhere.** `src/shared/bound.ts`, `handleTimeout`, `awaitContinuation`, `timeoutBehavior`, `timeout_ms`, `await_response`, and the timeout states are deleted — not defaulted, not widened. The only sanctioned waits are the notification gate's fixed retry backoff and lazy TTL expiry on read paths. The only bound on a child is operator intent via `task_interrupt`.
- **Tools are pure verbs.** `dynamic_task` spawns and returns; `task_continue` sends and returns (settle → revival via the single `reviveRetainedTask` choke point; active → refuse "still running"; interrupted → refuse, spawn fresh); `task_result`/`task_list`/`task_status` are store reads. Each settled turn notifies exactly once as a `[dynamic-task-notify]` message.
- **One child→parent channel.** `task_notify` is general communication; "blocked" is a payload, not a tool (ruling: purpose-specific signal tools rejected). Notices carry a separate dedup kind, so a notice never consumes the child's settlement slot — the task stays active and still reports on completion.
- **Exactly-once lives in `gateLedger`** (`src/shared/notify.ts`): synchronous in-flight claims plus `(childSessionId, deliveredKind)` keys, reset per settled turn by `forgetChild` on revival. A failed delivery does not reserve the key (redelivery stays possible); the state-machine settlement itself is single-winner and terminal — recovery rides `task_continue`, and the FAILED record surfaces via `task_result`. Dedup holds for the most recent 1000 children; evicted keys may re-deliver verbatim repeats — bounded memory, documented window.
- **Interrupt order:** transition to `interrupted` synchronously BEFORE calling the server abort, so the abort's own idle events can never be misclaimed as a completion. A 404 settles interrupted (dead means dead); an abort transport failure withdraws the speculative claim back to active so the genuine terminal event still settles it; settled history records the gap without disturbance. Interrupting an already-settled task reports the settled state truthfully.
- **`deleted` is a failure** — normalized in `resolveNotifyKind` at the single kind-resolution site.

## Invariants

- `safety-invariants` scanner forbids: `setTimeout`/`setInterval` in `src/**` except the notify retry and test-only seams; `await_response`, `timeout_ms`, `timeoutBehavior` anywhere.
- README tool rows ↔ `tool({` registrations are checked in both directions (cycle 00 invariant, extended).

## Verification

- Suite: 294 tests green; `tools.integration.test.js` rewritten to settle children by firing lifecycle events — tests never wait on clocks, they wait on microtasks.
- `DYNAMIC_TASK_BLOCKED_AGENTS=""` (empty env) cannot clear the default blocklist; an explicit `blockedAgents: []` in options/file can — the latter is a real setting, the former is an absent value.
- Live gate: restart → spawn → notify → settle → continue → settle → interrupt (pending operator run).
