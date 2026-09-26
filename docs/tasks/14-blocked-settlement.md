# 14 — A blocked child is not a success

**Status:** shipped 2026-09-26.
**Doctrine:** Tenets 1 and 7 (one owner for words, one owner for decisions), 8 (states are the claim), 11 (deliberate degradation, fail toward recoverable).

## The hole, stated once

The spawn prompt tells a child: *if blocked mid-task, call `task_notify` with what
you need.* The child does. Then its turn ends — and the plugin records
`completed`, writes `completed` to the durable ledger, renders `completed` in the
tree, and sends the parent **"Background task completed successfully."** The only
trace of the question is the prose the child wrote and the tag the parent saw a
few seconds earlier.

That is a false success claim, in every view, about a task that delivered no
result. It is also the exact input M6 (dependency edges as live state) needs and
cannot have: a `blocked` dependency that counts as satisfied hands the next task
an unfinished edge and calls it progress.

## The decision, and its shape

The child already knows it is blocked. The missing thing was for the record to be
able to say so — so the claim is a **payload kind on the one general
child→parent channel** (`kind: "needs_input"`), never a purpose-specific tool
(Tenets 4, 6: one channel, one funnel).

Three properties had to be settled before writing it:

- **The names are the machine's own.** `SettlementVerdict` is
  `Extract<TaskState, "completed" | "blocked" | "error">` — a verdict is directly
  claimable and notifiable, and the wire kind and the state are the *same word*,
  so `let kind: NotifyKind = verdict` is a compile-time proof that a settled
  `blocked` cannot be announced as a success. There is no second lookup table to
  translate between three spellings of one fact.
- **The decision happens once, before the claim.** `settlementVerdict()` takes the
  host's own word, the event, and the child's declaration and returns the single
  verdict that the claim, the notification kind, and the fallback wording all
  read. The code it replaced re-derived the outcome from a status string at three
  points, and the derivation is where the false success came from.
- **The fallback words live in `voice.ts`.** `(completed)` / `(error — no
  detail)` / `(blocked — the child said nothing further)` are operator voice, and
  a fallback reading `completed` where the truth was `blocked` is the bug, not a
  cosmetic issue. `settlementFallback(verdict, errorDetail)` is exhaustive over
  the verdict, so a new verdict cannot arrive without its words.

## What the state is and is not

- **Terminal.** The turn is over; nothing else will settle it.
- **Revivable.** The parent's answer *is* a new turn, so `task_continue` revives
  it exactly like a completed task. Only `interrupted` is never revived.
- **Never rewritten to `error`.** `noteLateOutcome` exists to correct a *false
  success*. `blocked` is not a success claim, so there is nothing to correct — and
  keeping it out preserves exactly-once for a task the parent is about to answer.
- **Not dependency-satisfying.** `SATISFIED_DEPENDENCY_STATES` stays
  `["completed"]` deliberately and is *not* derived from the machine: deriving it
  would make every new state an unexamined satisfying state.
  `SETTLED_DEPENDENCY_STATES` *is* derived (`TASK_STATES` minus `active`) — a
  dependency that will not run again cannot be waited on, whatever it settled as.

## The declaration is scoped to its turn

A steer stamped *after* a declaration is the parent's answer. Without scoping, a
child that asked a question, was answered mid-turn, and then completed would still
settle as `blocked` — a false claim in the opposite direction. The record has
exactly one turn boundary (`replacedAt`, stamped by every steer and revival), and
a notice already carries its own timestamp, so the predicate is one comparison:
`lastNotice.at > (replacedAt ?? 0)`. A revival produces a new record with no
declaration at all, and the answer to a block starts a turn that must make its own
claim.

## Failing toward recoverable

A declaration is honoured even if the child went on to finish the same turn. The
asymmetry decides it: recording `blocked` when the work was actually done costs a
revivable task whose first act is to say "already finished"; recording `completed`
when the child really is stuck costs an unfinished task that nothing will ever
revive. The plugin believes the explicit claim.

## The drift that would have eaten it

`session-lifecycle.ts` validated every restored record against its **own
hand-written** `state: "active" | "completed" | "error" | "interrupted"` union
and a four-way disjunction. Adding `blocked` to the machine would have made the
durable reader **silently drop** every blocked record on the next boot — the
plugin forgetting, in one process, that it had ever asked a parent a question.
The reader now takes the machine's `TaskState` and tests membership in
`TASK_STATES`, and the contract test writes a blocked record to a ledger on disk
and boots: a state added to the machine without its reader fails there.

## Enforcement

- Contract tests (integration): declared → `blocked` and the parent is told to
  answer; undeclared → `completed` (the guard on the change); `error` status
  outranks a declaration; a declaration followed by a steer settles `completed`;
  a blocked task revives; an unknown claim is refused with both claims named; a
  blocked record survives a restart and is still answerable.
- Wording lives in `voice.ts` (`settlementFallback`, `noticeClaimRefused`) and in
  the notify gate's kind table — the two places the existing suites already pin.
- The claim vocabulary is data (`NOTICE_CLAIMS`) and the tool validates its
  `kind` argument against it, so a typo'd `needs_input` is refused rather than
  downgraded to progress.

## Deliberately not done

- **Blocking the child on the answer.** The child cannot be held: the host
  accepts a prompt to a mid-turn parent and *holds* the request, so a "wait for
  the answer" turn would be a child burning a turn doing nothing. The child ends
  its turn, is recorded `blocked`, and the parent's answer revives it.
- **A second notification kind for a late answer.** One settlement, one notice.
- **Persisting the declaration across a restart.** It rides the advisory
  `lastNotice`, which `durableActiveTask` strips: a fresh process cannot verify a
  claim the child made in the previous one. A restored task that was mid-declaration
  settles as its ending turn reads, and the boot pass already names a vanished
  child rather than calling its work failed.
