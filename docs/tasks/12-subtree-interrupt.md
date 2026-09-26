# 12 — Subtree Interrupt

**Doctrine:** Tenet 9 (the claim orders the abort), Tenet 4 (settle at the single-winner gate), Tenet 7 (settlement lives at the notification layer). A dispatch is a tree, so a stop that reaches one node reports a success over work that is still running.

## The hole, stated once

`task_interrupt` settled and aborted exactly the session it was handed. A child that had spawned a grandchild kept it running: the parent's report said the task was interrupted, the ledger said `interrupted`, and the grandchild went on spending tokens with nothing left to settle it. The operator's only recovery was to interrupt every descendant by hand — from a `task_list` that did not show the tree.

## Decisions (binding on the implementation)

- **The subtree is the default; `scope: "self"` is the escape hatch.** A stop named one session while work below it lives is a partial stop reported as a whole one, and the failure mode is silence, not an error the caller can see. Narrowing must be asked for explicitly. An unrecognized `scope` is refused with both choices named: silently widening kills work the caller did not name, and silently narrowing leaves a descendant running behind a clean-looking report.
- **Edges are `parentSessionId`, not `lineage`.** `lineage` holds agent NAMES — the delegation policy's input, and it cannot answer "is this task below that one". The walk runs through RETAINED records too: a finished child can still have left a live grandchild, and that grandchild is exactly what a stop is for. A finished task named as the root is therefore not a wall, and the walk still reaches through it.
- **Settled descendants are not re-aborted.** Aborting settled history is a no-op on the server and a line of noise in the report. The abort set is the root plus every ACTIVE descendant; the report names only what the plugin acted on.
- **Every target is claimed before the first abort reaches the server.** The claim is the synchronous settle; it is what orders the abort's own echoes, because a terminal event for an already-claimed task finds settled history instead of an active record. Claim one abort at a time and every descendant is still live while the first abort is in flight — the window in which a real terminal event settles a child the same call is stopping, as a *completion*, with a notification. Pinning this is a mid-pass observation (the harness gates the first abort and reads the descendant's state while the pass is parked), and it is falsifiable: the interleaved variant fails exactly that test.
- **Per-member outcomes, one voice.** A single task is a sentence; a tree is a ledger of them — one line per member, each with its own truth, so a partial stop can never read as a clean one. The words come from one function (`interruptReport`) whether there is one member or five, so the two reports cannot drift into saying different things about the same outcome. A transport failure on one member withdraws only that member's claim; the rest stay stopped.
- **Depth is bounded by the agent set, not by this code.** Lineage accumulates every ancestor's agent name and no agent may appear twice, so a chain is at most as long as there are agents (two today). The walk is depth-agnostic — a wider agent set simply makes deeper trees — and nothing in the implementation or the tests assumes two levels.

## Choke point (all three components)

- **Primitive:** stop a dispatch, not a session.
- **Funnel:** `subtreeTaskIds` in `task-state.ts` (the one place that knows the shape of the tree) + `claimInterrupt`/`abortClaimed` in `tools/interrupt.ts` (the one place that claims, aborts, and classifies an outcome) + `interruptReport`/`interruptSubtreeReport` in `voice.ts` (one wording for one outcome). `abortSession` remains the only `session.abort` funnel, and the existing store-mutation invariant still covers the tree walk.
- **Enforcement:** no new rule was needed — the claims go through `transitionState` and the records are written by the state machine, so the Task-01 invariant already forbids a bypass. The scope argument is a closed enum in the tool schema, so an unrecognized value cannot reach the executor as a valid one.
- **Contract tests:** a three-node-free two-level tree stopped by one call; `scope: "self"` leaves the descendant active; an unrecognized scope stops nothing; a settled descendant is not named; a settled root still has its live child stopped; and the claim-before-abort ordering, observed mid-pass through a gated abort.

## Degradation

Every member reports its own outcome, including the ones the server refused. A subtree the plugin cannot see (spawned by another instance, or before a boot that lost the record) is outside the walk — the report says how far the reach went, and `scope: "self"` plus an explicit id remains the operator's manual path.

## Litmus

A parent with a runaway tree calls `task_interrupt` once, and afterwards nothing under it is running — or the report says exactly which member is still live and why.

## Status

**Complete** — 2026-09-26. Six new subtree tests; the full suite green, 0 clones, coverage gate green. The interrupted-storm risk that drove the design (a notification storm from per-descendant settlement) does not exist by construction: the interrupt path settles without notifying, and every claim lands before any abort, so no descendant's ending can be misread as a completion.
