# 10 — Parent→Child Steer

**Doctrine:** Tenets 3, 7, 11 (settlement lives at the notification layer) plus the turn-replacement thesis: a mid-flight parent message must stop the running turn and become the next user turn — never queue behind it. A queued prompt leaves ordering to the server and lets the child settle without ever seeing the message.

## Evidence (orchestration audit, 2026-09-22)

- `task_continue` hard-refused active tasks (`src/index.ts`: "still running … wait for its notification"), so a parent that saw a child go wrong mid-turn had no voice until settlement. The only parent→child injection was the question auto-answer (canned first suggestion) — not an arbitrary message.
- The capability was always present server-side (`session.abort` ends the turn, the session stays addressable), only the policy forbade it.

## Decisions

- **One parent→child voice.** `task_continue` carries all follow-ups, behavior keyed on store state: active = steer, settled = revive. A separate `task_send` verb was rejected (same ruling as 09's one child→parent channel: purpose-specific signal tools rejected). Interrupted tasks are still never revived.
- **Stop, append, re-submit.** The steer claims synchronously (before any await) via `markSteerPending`, awaits `abortSession` (the one `session.abort` funnel — the `await` sits here, beside the claim that orders it; 404-versus-transport classification is decided inside it), then fires the parent text wrapped as a preempting user turn (`[Parent steer — …]`) through the existing `fireChildPrompt` path. The task stays `active`; the claim is advisory metadata, never a lifecycle mutation.
- **Echo suppression lives at the gate.** `handleChildLifecycleEvent` consumes the claim (`consumeSteerPending`) and drops the aborted turn's terminal event without settling or notifying. Suppression in the tool handler would race the event pump — it belongs at the single-winner settlement site, beside the interrupt claim that mirrors it (interrupt settles *first* so the abort echo can't misclaim; steer holds *active* so the echo can't settle).
- **Failure semantics, each honest about knowledge:**
  - Abort 404 / not-found → the session is gone; settle `error` (deletion-is-failure) with a notification naming the steer, so the ledger never strands an active task with no server side.
  - Abort transport failure → disarm the claim and stay `active` *without* sending: the turn may still be running, and a replacement prompt would compete with it instead of replacing it. The live turn's genuine terminal event still settles it.
  - Post-abort prompt failure reuses the `onPromptFailure` classify/settle path (retryable stays active, non-retryable settles `error` with the requested model named).
- **Settle-while-steering:** the claim is re-validated after the awaited abort. A task settled non-interrupted mid-steer is auto-revived in the same call (M9 — the abort proved the session live, so no second round-trip); an interrupted task receives no replacement prompt and gets a truthful settled-as-interrupted report instead of a false "Steer sent". Firing onto an interrupted session would launch an untracked turn.
- **Guarantee is presence, not obedience:** "Guaranteed read" means the message is a user turn before the next assistant turn. The brief (`buildBackgroundPrompt`) teaches preemption discipline ("a parent message preempts your current turn — read it first, then continue") plus the L2 line ("answer any question yourself with your best judgment, never wait"). An explicit steer supersedes the question auto-answer.
- **Known limitation (documented, not fixed):** concurrent steers on one child are not serialized — a second steer can settle on the first replacement turn's event while its own prompt still runs. Orchestrator discipline stays one-steer-at-a-time; a per-child steer queue is deferred until a field repro demands it.
- **Residual risk (accepted):** if the server never emits the aborted turn's echo, the claim eats the replacement turn's genuine terminal event and the task strands active (recoverable by `task_interrupt`). N1's post-abort re-check narrows this window without closing it: a pre-steer turn that settled *before* the abort returns still has its echo consumed (the task never left active), so the replacement prompt can fire onto a dead session — accepted residual (Scenario B). This inverts the pre-steer failure (wrong settlement + lost work) into a visible stall, and matches the interrupt path's own documented assumption that aborts provoke idle/error events.

## Choke point

- **Primitive:** parent→child mid-flight message.
- **Funnel:** `task_continue`'s active branch (entry) + `markSteerPending`/`consumeSteerPending` (`task-state.ts`) + echo consumption in `handleChildLifecycleEvent`. The abort itself funnels through the entry (safety-invariants create/abort rule covers spawn/interrupt/steer paths).
- **Enforcement:** lifecycle-field scanner extended to `steerPending` — outside `task-state.ts` it may be read, never written.
- **Contract test:** steer aborts then prompts with the preemption frame and stays active; the abort echo settles nothing and notifies nothing while the next genuine event settles once; vanished-session steer settles `error`; failed-abort steer stays active and sends nothing.
- **Degradation:** every abort outcome reports truthfully (stopped / not-found-settled / still-live-unsent); stranded-active always ends at operator `task_interrupt`.

## Litmus

A parent can stop a wrong-direction child mid-turn and redirect it without waiting for settlement — and the redirected turn's outcome still reports exactly once.

## Status

**Complete** — 2026-09-22. Proof: 4 steer integration tests (send, echo-consumed-then-genuine-settles, vanished-settles-error, failed-abort-stays-active); `buildBackgroundPrompt` pins the preemption + self-answer lines; full suite green, coverage gate green, 0 clones.
