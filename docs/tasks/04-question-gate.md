# 04 — Question Gate

**Doctrine:** Tenets 1, 4, 11. Child questions are taint egress across a boundary — resolve first, then validate, in one gate, with a deliberate outcome when no one can answer.

## Evidence

- `questionIdToSessionId` is populated only inside the branch that requires it to already be populated: read at `src/index.ts:595`, set at `src/index.ts:613` inside `else if (childSessionId && ...)`. Bootstrapping is impossible.
- Fallback intended to map questions to sessions is an empty loop: `src/index.ts:597-602` (`// Find by matching session ID pattern`, no body).
- Every real question falls through to `src/index.ts:642-644` (`question-unmatched`, debug-log only). The auto-answer (`src/index.ts:617-631`) and auto-reject (`src/index.ts:633-641`) paths are unreachable in production; `src/shared/question-handling.ts` (reply/reject idempotency, 409-tolerance) is correct code with no live caller supplying a session.
- No degradation direction is documented: unmatched = child blocks silently.

## Choke point

- **Primitive:** any `question.reply`/`question.reject` egress, and any spelling of a question event. The host publishes `question.asked` and `question.replied` (plus `question.v2.*`); it has never published `question.created`, which this doc previously named as the primitive. Every name is now pinned in `src/shared/host-events.ts` as `satisfies Event["type"]`, so a name the host does not declare does not compile.
- **Funnel:** one `resolveQuestionSession(event, store)` gate — resolve first (event `session_id`/`task_id` properties, then question→session map, then active-task scan by owning session), then validate (active vs retained vs unknown) in the same place. All question traffic passes through it.
- **Enforcement:** build invariant — no direct `client.question.reply/reject` outside the gate module; `questionIdToSessionId` owned by the gate, never touched by the event handler directly.
- **Contract test:** real question-event shapes, pinned to the SDK's declarations — `question.asked` carries `id` and `sessionID`; a RETIRED question carries `requestID`, a different key. The four-name ladder (`id`/`request_id`/`task_id`/`requestID`) this test once enumerated was two-thirds invented: `request_id` and `task_id` exist on no host version. `readAskedQuestion`/`readRetiredQuestionId` (`src/shared/host-events.ts`) validate exactly the fields the gate consumes and return the SDK's own declared type, so a field the host does not carry cannot be read as if it were there. Includes the unmatched case. Pins the mapping priority chain, not a mock of it.
- **Degradation (explicit):** active task + answers present → reply the first option (recorded), in the host's shape: the route is `/question/{requestID}/reply` and the body is one entry per asked question, each a list of chosen labels. A multi-part ask is therefore NOT answerable by this gate — answering the first part would retire the question with the child never having seen the rest — so it is rejected. Active + no options → reject, and record the `blocked` claim (the gate is the plugin blocking the child, so it is the second source of the claim — see 14-blocked-settlement). Retained/settled → reject with settled guidance (kept M3 behavior). Unattributable (no id, unknown id, ambiguous — including the operator's own questions) → **left untouched**, log only. Rationale (decided in implementation): auto-settling a question that cannot be positively attributed risks hijacking the human's own flow — a hung child is visible and recoverable, a corrupted operator intent is not. Fail-closed on ambiguity is the deliberate direction.
- **A rejection reaches the PARENT, because the child cannot be reached at all** (`voice.ts`, `QUESTION_NO_ANSWER`, 2026-09-26): the host's reject endpoint declares `body?: never` and returns a bare boolean. There is no channel from this gate into the asking session — so the promise that the reason is the child's only description of the way out was undeliverable by the very mechanism claiming it, and misaddressed besides: the text told the READER (the parent) to call `task_notify`, a child-only tool. The claim is the parent's to act on, it leads with the parent's own remedy (`task_continue`) because the status view truncates that line at 120 chars, and it never says "wait" in a system whose spawn prompt forbids waiting.

## Scope

Implement the resolver, wire the existing `replyToQuestion`/`rejectQuestion` helpers behind it, delete the empty loop. Preserve 409-already-resolved idempotency.

## Litmus

A newcomer cannot answer or reject a question except through the gate — the build fails — and every question event produces exactly one recorded decision.

## Status

**Complete** — 2026-09-11. Proof: `resolveQuestionSession`/`decideQuestion` unit-pinned (priority chain, store-validated ownership, no-guess rule, all three degradation kinds); integration through the real event handler — auto-answer, guidance rejection, retained rejection, reply-failure fallback, and foreign-question untouchedness; linkage map moved into the gate with its own build invariant; full suite 251/251, coverage gate green, 0 clones.

Decisions: linkage state owned by the gate module (`remember`/`forget`); session/task id candidates cover both casings and nestings; reply-failure still falls back to rejection (defense in depth); `question-auto-answered`/`rejected` debug records added so every settlement is observable.

**Amended 2026-09-26** (2ca5adc): a rejected question is no longer advice in a string — it is the record's own `blocked` claim. Proof: unit-pinned on `decideQuestion`'s reason, and integration-pinned that an unanswerable question settles `blocked` while an answered one settles `completed`.

**Amended 2026-09-26** (428226a, live falsification): the gate was written against a question surface the host does not have, and every blocked-settlement path was dead on arrival. Three defects, one cause — the namespace was hand-declared rather than derived, so nothing about it could be wrong loudly:

- the reply route read `path.id`; the host routes `/question/{requestID}`
- the answer was a bare string; the host takes one entry per asked question, each a list of chosen labels
- the gate listened for `question.created`, which no host version publishes

The suite was green throughout, because the harness had invented `question.created` to match. Fixed at the chokepoints rather than at the call sites: the question namespace is now derived from the generated SDK client (the three wrong field names are unrepresentable, not merely corrected), and every event name is `satisfies Event["type"]`. The detection gap is closed too — the harness imports its event types from production, and two standing rules in `safety-invariants.test.js` fail the build if a fixture or a production file spells a host event type. Both rules were falsified before being trusted.

**The lesson is why this gate is documented at this elevation:** a fixture that invents a host event certifies a gate that listens for it. A green suite proved the fixture agreed with itself and nothing else. Tenet 12 is not a formality here; it is the only thing standing between this gate and a second dead path.
