# 17 — Transient failures: name the cause, and stop reporting the network

## Why

A child that dies of a socket reset has not done anything wrong. The parent
cannot cause it, cannot fix it, and cannot act on it — and yet the notification
gate reported it in exactly the same words it used for a child whose work
genuinely broke. A parent handed an undifferentiated failure has two options:
ignore every failure, or investigate every one. On a network that drops, the
second is what happens, and it is expensive: the 2026-09 field corpus shows
blocked children whose parent conversations opened on a child that had already
been dealt with.

The distinction existed, but only as prose. `isTransientOutcomeError` matched
fragments of the error string and appended a sentence to the notification
naming `task_continue`. So the parent could *read* the difference in one
notification and could not *know* it anywhere else — `task_result`,
`task_list` and `task_status` all reported the same `error`, and a parent
inspecting a child minutes later had no way to recover which kind of failure it
was.

The previous decision, recorded in `05-notification-gate.md`, was deliberately
against retrying: *"retrying a failed turn needs a budget, and the settlement
layer arms no clocks — the operator stays the retry loop."* That was the right
call with nothing to supply a budget. This task supplies the budget, so the
decision is reversed rather than merely amended.

## The dangerous primitive

A free-text error string carrying two unrelated facts: a network condition that
says nothing about the work, and a fault in the work itself. They arrive in the
same field of the same message, and the consumer is a language model deciding
what to do next.

## The chokepoint

One classifier, in `shared/failure-class.ts`, owns both the decision and the
wording that announces it. `FailureClass` is `none | transient | structural`;
`classifyFailure(verdict, detail)` decides it and `failureNote` renders it.

Both live together deliberately. They were in two modules when the decision was a
boolean and the wording a sentence, and that is how a sentence ends up describing
a classification that no longer exists. The `Failure class: <word>` label is the
part that is a contract — a parent or a tool can grep for it — while the prose
after the colon is free to be reworded.

`shared/transient-resume.ts` owns the budget and the single question of whether
a settlement may be resumed instead of reported.

## Why the classifier is conservative

This is not decoration: it arms a revival, and the two error directions are not
symmetric.

- A false **Transient** resurrects work the operator meant to stop, spends a
  concurrency slot, and can hide a genuinely broken child behind endless retries.
- A false **Structural** costs exactly one extra message to a human.

So every ambiguous case resolves Structural, and a marker must be an affirmative
claim about the *network* before the classifier will say Transient. Three
corrections the old fragment table did not need, because a wrong hint cost
nothing:

- **`"unavailable"` is a substring of `Model tried to call unavailable tool
  'invalid'`.** Harmless in a sentence; as a trigger it is an endless retry of a
  model that will never call that tool. `"temporar"` covers the honest phrasings
  without the substring that swept in the fatal ones.
- **A bare abort is Structural.** The host reports an operator's `task_interrupt`
  through the same aborted-turn shape a dropped connection produces, so a revival
  firing on the first would be a child that ignores the stop button.
- **The status codes are word-bounded.** A bare `.includes("500")` reads a token
  budget ("max tokens 500") as an upstream failure, and each false hit spends a
  slot on a revival.

## The budget, and what makes silence honest

`TRANSIENT_RESUME_BUDGET` is 2. A single blip is the case this exists for; two
covers a retry that lands on a second blip, which on a flaky link is ordinary.
Beyond that the child reports, because by then the likeliest explanation is not
the network.

The count lives on the record as `TaskRecordBase.transientResumes`, incremented by
`reviveRetainedTask` — so it counts revivals whoever asked for them, and a parent
who has revived a child three times is not surprised when the plugin stops
reviving it on its own. It rides on the record *at the moment of revival* rather
than on a second write, so the same `Running` change that publishes the revival
publishes the count; a counter kept anywhere else would be a second thing to
forget to persist. It is deliberately **not** advisory: a budget that resets on
boot is no budget at all during the outage it exists for.

It is optional on the record, and `?? 0` is the whole meaning of its absence — a
fresh spawn has spent nothing, and a ledger written before the field existed has
nothing to report.

## The one revival path

Three steps in a fixed order, in `entry/lifecycle.ts:reviveWithPrompt`:

1. `reviveRetainedTask` — re-claims the child's concurrency slot, spends one unit
   of budget, publishes the new running record.
2. `gateLedger.forgetChild` — **the load-bearing step.** A resumed task is a fresh
   settlement subject. Without this the child's *next real* outcome is
   deduplicated against the turn that already settled, so a child that recovers
   from a blip and then genuinely fails reports nothing, forever. That is the one
   failure this feature must be structurally unable to cause, and
   `transient-resume.test.js` pins it.
3. `fireChildPrompt` — the child's new turn, told what happened and that nothing
   it was asked to do has changed.

`task_continue` and the settlement both go through it. A second revival would be a
second place for the dedup to be forgotten and a second place for the cap check
to be skipped.

## What a resume is not allowed to assume

`transientResumeAvailable` requires a cap source and returns false without one.
`agentCapacityRefusal` reads a missing cap source as "no limit", which is right
for a fresh dispatch that validated its own bounds and wrong here: a silent
revival that skipped the cap check would quietly spend budget the operator set.
The requirement is on the *caller* rather than the callee because the settlement
reaches it without a tool scope — so `capSource` is threaded from `index.ts` and
the boot pass deliberately passes none.

**The boot pass never resumes.** Most of what it settles is a child that *vanished*
across the restart, and reviving its record would send a prompt to a session the
host no longer has. It always reports, and the reason it can is the one that
belongs: the parent is told its child is missing.

## Degradation direction

Every way this can be wrong fails toward **reporting**, never toward silence: a
structural failure is never resumed, a spent budget is never resumed, an unknown
cap is never resumed, an interrupt is never resumed, and a refused revival
(concurrent settler won, no slot free, record gone) falls through to the notice
that was already owed. The feature can only ever be too quiet, never too loud —
and when the budget *is* spent, the note says so, so a parent reads it as a
lasting outage rather than one unlucky turn.

## Contract test

`transient-resume.test.js` — five cases against the real host shapes:

- a transient failure notifies nothing and runs the child again;
- a structural failure still notifies, labelled;
- an interrupt is reported, never resumed;
- silence holds for the whole budget, then reports, naming the spent retries;
- **the child's real outcome is still delivered after a resume** (the dedup).

`failure-class.test.js` — the table, including the `unavailable tool` regression
and the bare abort. The failed-turn fixture carries **no `parts` key**, because
that is what the host sends for a turn that produced no output; a fixture adding
`parts: []` would pass the reader's guard for the wrong reason, which is how a
fully green suite shipped a 12% false-success rate on aborted children.

Harness: `childFailingWith(detail)` in `support/integration.js`, one arrangement
that was being built inline in seven places. The harness also gained
`setTranscript(sessionId, messages)`, because the case that matters most — one
child, two settlements, two fates — was otherwise impossible to write without a
second harness and a second child.

## Proof

`npx tsc --noEmit` exit 0; `npm run test:duplication` → `Found 0 clones`;
`node --test src/tests/*.test.js` → 709 passing, 0 failing; `npm run test:coverage`
exit 0 (90 lines / 80 branches / 90 functions).

## Status

Complete.
