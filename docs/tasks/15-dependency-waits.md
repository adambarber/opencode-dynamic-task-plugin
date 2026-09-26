# 15 — A refused dispatch is state, not a sentence

**Status:** shipped 2026-09-26.
**Doctrine:** Tenet 1 (one owner for words), 2 (one decision, many read-only projections), 4 (one channel, one funnel), 7 (one name per concept), 11 (deliberate degradation, fail toward recoverable).

## The hole, stated once

`depends_on` is checked once, at admission, and the check produces a *string*.
The plugin then forgets the dispatch entirely. Three things follow, and all three
belong to the parent's context — which is the thing the plugin exists to hold:

1. The parent must carry the wait in prose ("B is blocked on A") across turns.
2. The parent must be alive at the moment A settles to re-dispatch.
3. Nothing in the record connects the settlement of A to the refusal of B, so
   the parent has to notice that connection itself, from prose it wrote earlier.

So a dependency planner is really a polling loop written in the parent's own
attention span. That is a clock, in the one place this system's doctrine says a
clock must not be.

## The decision: the plugin remembers the wait, the parent resumes the dispatch

The refused dispatch is held as state and announced when it is answered. The
alternative — the plugin holding the prompt and performing the dispatch itself
when the edge clears — was considered and **rejected for now**, for a reason
worth recording rather than rediscovering:

- A held prompt is unbounded text in the ledger, and a dispatch whose context
  went stale while it waited is a dispatch that runs against assumptions nobody
  holds any more.
- A queued dispatch has no session, so `task_continue`, `task_status`,
  `task_result` and `task_interrupt` would each need an honest answer for an id
  that does not exist. Four tools learning a state that is not a session is a
  large surface for a capability gap.
- Promotion would be a **third structural writer** into the running set,
  alongside spawn and settlement. Two writers is a funnel; three starts to be a
  choreography.

The parent wrote the dispatch, so the parent resumes it, and the parent's turn is
already being prompted by the settlement that released it. The plugin's whole
obligation narrows to *saying when the gate will now admit it* — which is the
part that was actually missing.

**Escape hatch:** promoting the dispatch itself is a documented follow-up. It
needs a durable prompt payload and a queued branch in the four session tools, and
nothing in the current design blocks it — `holdDispatchWait` is the one writer
and the wait is already keyed, so promotion slots in beside it rather than
through it.

## Three properties that make it a state machine and not a string

- **One predicate, two callers.** `releaseWaitsFor` asks
  `resolveDependencies(...)` — the gate's own function — whether a wait is now
  admissible. Two hand-written readiness rules would drift, and the drift would
  surface as the plugin refusing a dispatch it had just promised. The same
  predicate raising `dependenciesPending` at admission and clearing the wait at
  settlement is what makes those two facts the *same* fact.
- **Readiness is not a timeout.** A wait resolves as `ready` when the gate admits
  it, and as `dead` when the gate still refuses **and** no unmet edge is still
  running. An edge that settled without completing will not run again, so
  continuing to wait on it is waiting on nothing. Dead is a resolution, not a
  failure: the parent is told to re-plan, which is a recoverable instruction.
- **Exactly-once is structural.** A resolved wait is deleted from the store by
  the function that announces it, so a wait *cannot* be announced twice — there is
  no dedup key to get wrong, and a later turn on an unrelated task has nothing
  left to say.

## The plugin's words are still the parent's words

The wait is keyed by `(parentSessionId, description)` — the parent's own
description of its own dispatch. The release message names that description back.
The plugin never invents an id the parent would then have to learn, and the
parent does not have to remember which of its refusals a given settlement
answers. `MAX_WAITS` (64) bounds the map: it is a courtesy ledger to a live
parent, not a history, and the oldest wait is the one least likely to still be
wanted.

## Why it is process memory, not ledger truth

A wait carries no prompt and no session, so persisting it would buy nothing that
survives: across a restart the wait and the parent that asked for it are gone
together, and a hint that outlived its asker would have nobody to inform. Keeping
it out of the ledger also keeps the settlement path from acquiring a filesystem
write — the same reason `durableActiveTask` strips the advisory fields.

## Where the release rides

`settleRunningChild` is the one place a task settles, so the release is called
there and nowhere else, after the settlement claim is already taken. It cannot
fail loudly: an unanswered hint leaves the parent waiting, which is exactly the
state this replaced — no worse, and the wait is already out of the store.

The hint goes to the **waiting** parent, not the settling task's parent, grouped
by parent so one parent hears one message however many of its waits a single
settlement released. It rides on `deliverParent` like every other parent-directed
write, so a waiting parent that is mid-turn gets the same bounded, held,
ledger-recorded treatment as a settlement notice.
