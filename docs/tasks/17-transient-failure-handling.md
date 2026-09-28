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

## The recovery brief, and what it is not

A dead child leaves the parent reconstructing what it was in the middle of. The
brief is the one fact it cannot get any other way — **which files that child
changed** — taken from the child's own transcript, and rendered by `task_result` as
`Changed: edit src/a.ts, write src/b.ts (incomplete)`.

It is emphatically **not** the working tree. Dirty files belong to every child
running against the project at once, so "what did this child change" cannot be
answered by asking git; it can only be answered by what this child actually called.
It is also free: `task_result` already reads that transcript to count messages, and
nothing was added to the settlement's event head.

Two shape decisions came from the host's own store rather than from taste, queried
rather than assumed (`ToolState.input` is `{[key: string]: unknown}` in the SDK, so
neither `filePath` nor the status vocabulary is discoverable from types):

- **The mutators are an allowlist** (`edit`, `write`). Every tool carrying a
  `filePath` includes `read` — 36,951 of them against 25,211 edits — and also
  `glob`, `bash` and `aft_search`, which name a path for their own reasons. A tool
  absent from the set is *not reported*, so a future mutator is a missing line and
  never a wrong one.
- **`incomplete`, not `failed`.** The first version compared the raw status to
  `"error"`, which the strong-types gate correctly refused as a tag compared as a
  string — and fixing it properly found a better fact. A call still `running` when
  its child died has also not landed, and it is half-applied work that a resuming
  parent must know about. So the projector answers "is this on disk" once, against
  the host's one settled status, and the reader never sees a status string at all.

`toolCallOf` is a **projector, not a type predicate**, because the fields the reader
needs are not on the part itself. The first version was a guard, and a predicate
that returns `true` has already promised a shape whose `status` is `undefined` — the
test asking whether a rejected write was marked incomplete is what caught it.

Bounded at six with `+N more`: a child that rewrote twenty files needs the first few
and the count, and a line long enough to wrap stops being a line. Omitted entirely
when nothing changed, because a read-only child is the common case and
`Changed: none` is a line a parent learns to skip.

## Degradation direction

Every way this can be wrong fails toward **reporting**, never toward silence: a
structural failure is never resumed, a spent budget is never resumed, an unknown
cap is never resumed, an interrupt is never resumed, and a refused revival
(concurrent settler won, no slot free, record gone) falls through to the notice
that was already owed. The feature can only ever be too quiet, never too loud —
and when the budget *is* spent, the note says so, so a parent reads it as a
lasting outage rather than one unlucky turn.

## The record carries it, because a moment does not

The notification is a moment. A parent who inspects a child an hour later asks
the same question and has to be able to answer it, so the class is a durable field
on the settled record: `RetainedTaskState.failureClass`.

It is **settled-only** — `reclaimAsActive` drops it, because a running child has no
failure and a stale class would have `task_list` reporting a blip against work
currently in progress. It is **not** advisory: the question stays answerable a week
later, and it is exactly the kind of claim a fresh process can verify, so it
belongs on disk. A record with no class is a failure of unknown cause and reads as
such, which is what the prompt-failure path produces — it has a different question
to answer (was the *write* refused, not did the work fail) and no transcript to
classify.

### One amendment, not two

`noteLateOutcome` is now `recordSettledOutcome(store, id, outcome, failureClass?)`:
the state correction and the class ride on the **same** `decideRetained` publish.
That is not tidiness. A child that ended `idle` over an errored stream — the single
most common real failure, and the one `isMessage` used to hide — is exactly the
case that needs the correction, so a separate write for the class would double
every ordinary settlement's ledger traffic.

It also declined to publish when it had nothing to record. A change asserting a
record identical to the one already on disk is a file write for no fact, and
`persistLedger` discarding a zero-length payload is the same defect that once hid
a real correction.

It lives in `task-state.ts` rather than beside the other settled-record primitives
because its guard compares against `TaskState.Completed`, and that module imports
the enum as a **type** on purpose — naming it as a value would close the runtime
cycle its own docblock says keeps the two files from having one.

### The classification reads the CONCLUDED verdict

The settlement takes the host's `idle` as its first verdict, hydrates, and only
then discovers the turn ended over an errored stream. Both the correction and the
classification are therefore taken from `concluded`, a value fixed *before*
anything is recorded. Classifying the host's original `idle` describes a state the
record is no longer in, which is how a structural failure ends up labelled "no
failure class" — and the first version of this code did exactly that.

## Readers

`task_result` and `task_status` render the class through one
`failureClassLines` helper, and the line it prints is `failureNote`'s own sentence
rather than a restatement of it — the notification and the readers must not be able
to disagree about what a class *means*, and two phrasings of one classification is
how that happens. Omitted for `none` and for a record written before the field
existed, so a success never carries a line teaching the parent to skip it.

`task_list` does **not** show it: those rows are one line per task in a fleet view,
and a parent scanning twenty children needs the shape, not the diagnosis. The
inspection tools are where a diagnosis belongs.

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

`task-formatting.test.js` — `readers say WHY a child failed`: the class line from
`task_result`, from `task_status`, and **absent** on a success. The last is the one
that matters: a renderer that printed the line unconditionally would teach the
parent to ignore it. And `task_result briefs the parent on what the child touched`:
the verb, the incomplete marker, and silence for a child that changed nothing.

`prompt.test.js` — `touchedFiles`, on part fixtures transcribed from the host's own
store: the mutators with their verbs, a `read` correctly ignored, a rejected write
and a still-running edit both marked incomplete, one file counted once, and no
messages reading as no changes.

Harness: `childFailingWith(detail)` in `support/integration.js`, one arrangement
that was being built inline in seven places. The harness also gained
`setTranscript(sessionId, messages)`, because the case that matters most — one
child, two settlements, two fates — was otherwise impossible to write without a
second harness and a second child.

## Proof

`npx tsc --noEmit` exit 0; `npm run test:duplication` → `Found 0 clones`;
`node --test src/tests/*.test.js` → 723 passing, 0 failing; `npm run test:coverage`
exit 0 (90 lines / 80 branches / 90 functions).

## Status

Complete.
