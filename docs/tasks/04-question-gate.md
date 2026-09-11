# 04 — Question Gate

**Doctrine:** Tenets 1, 4, 11. Child questions are taint egress across a boundary — resolve first, then validate, in one gate, with a deliberate outcome when no one can answer.

## Evidence

- `questionIdToSessionId` is populated only inside the branch that requires it to already be populated: read at `src/index.ts:595`, set at `src/index.ts:613` inside `else if (childSessionId && ...)`. Bootstrapping is impossible.
- Fallback intended to map questions to sessions is an empty loop: `src/index.ts:597-602` (`// Find by matching session ID pattern`, no body).
- Every real question falls through to `src/index.ts:642-644` (`question-unmatched`, debug-log only). The auto-answer (`src/index.ts:617-631`) and auto-reject (`src/index.ts:633-641`) paths are unreachable in production; `src/shared/question-handling.ts` (reply/reject idempotency, 409-tolerance) is correct code with no live caller supplying a session.
- No degradation direction is documented: unmatched = child blocks silently.

## Choke point

- **Primitive:** any `question.created` egress.
- **Funnel:** one `resolveQuestionSession(event, store)` gate — resolve first (event `session_id`/`task_id` properties, then question→session map, then active-task scan by owning session), then validate (active vs retained vs unknown) in the same place. All question traffic passes through it.
- **Enforcement:** build invariant — no direct `client.question.reply/reject` outside the gate module; `questionIdToSessionId` owned by the gate, never touched by the event handler directly.
- **Contract test:** real question-event shapes (primary `id`, legacy `request_id`/`task_id`/`requestID` per `src/shared/question-handling.ts:28-36`), including the unmatched case. Pins the mapping priority chain, not a mock of it.
- **Degradation (explicit):** active task + answers present → reply first answer (recorded); active + no answers → reject with `task_continue` guidance; retained/timed-out → reject with timeout guidance (kept M3 behavior); unattributable (no id, unknown id, ambiguous — including the operator's own questions) → **left untouched**, log only. Rationale (decided in implementation): auto-settling a question that cannot be positively attributed risks hijacking the human's own flow — a hung child is visible and recoverable, a corrupted operator intent is not. Fail-closed on ambiguity is the deliberate direction.

## Scope

Implement the resolver, wire the existing `replyToQuestion`/`rejectQuestion` helpers behind it, delete the empty loop. Preserve 409-already-resolved idempotency.

## Litmus

A newcomer cannot answer or reject a question except through the gate — the build fails — and every question event produces exactly one recorded decision.

## Status

**Complete** — 2026-09-11. Proof: `resolveQuestionSession`/`decideQuestion` unit-pinned (priority chain, store-validated ownership, no-guess rule, all three degradation kinds); integration through the real event handler — auto-answer, guidance rejection, retained rejection, reply-failure fallback, and foreign-question untouchedness; linkage map moved into the gate with its own build invariant; full suite 251/251, coverage gate green, 0 clones.

Decisions: linkage state owned by the gate module (`remember`/`forget`); session/task id candidates cover both casings and nestings; reply-failure still falls back to rejection (defense in depth); `question-auto-answered`/`rejected` debug records added so every settlement is observable.
