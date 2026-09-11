# 03 — Prompt/Hydration Dance

**Doctrine:** Tenets 1, 6, 12. Prompt invocation plus result extraction is a fragile dance with hidden steps — get it right once, test the real primitive.

## Evidence

- Success is lossy: event handler resolves `{ text: "(completed)" }` (`src/index.ts:449`) and notifies with `latestText = "(completed)"` (`src/index.ts:452-457`), never calling `readSessionMessages`/`getLatestAssistantText` that `task_result` already uses (`src/index.ts:1094-1112`).
- `task_continue` on active sessions double-waits: `await session.prompt` (`src/index.ts:1027-1030`) then parks on `pendingSyncRequests` for a future event (`src/index.ts:1032-1049`); `baselineCount` (line 1026) computed, never used. The retained-continuation path (`src/index.ts:985-1012`) repeats it.
- Background spawn is fire-and-forget with log-only failure: `client.session.prompt(...).catch(safeLog)` (`src/index.ts:845-850`). Transient prompt failure leaves a task active until timeout with no cause recorded.
- Extraction helpers (`extractTextFromPromptResult`, `extractTextFromParts`, `extractSessionStatus`) each enumerate candidate shapes — a Tenet 2 enumeration standing in for a bound/guarantee, with no fallback direction when all shapes miss.

## Choke point

- **Primitive:** `client.session.prompt` + result hydration.
- **Funnel:** one `runPrompt(sessionId, parts)` dance: invoke, extract via the candidate chain, hydrate from `session.messages` when the return shape is thin, classify (text / empty / error / not-found) in one place. Sync, continue, and background all call it; background's "don't await" becomes "await inside the bound with notification on settle" rather than a detached promise.
- **Enforcement:** build invariant — no direct `client.session.prompt` outside the dance module. Prompt-failure classification lives with the dance, not per call site.
- **Contract test:** against a faithful fake session (real shape variants, transient failures, empty parts) — never a mock of the extractor itself. Pins: thin return + rich messages hydrates; prompt rejection classifies as retryable vs terminal; background prompt failure records cause and transitions instead of stalling to timeout.
- **Degradation:** empty result → explicit `(No assistant text found)` with message count (as `task_result` already does); prompt transport failure → named error with retryability, recorded on the task; never a bare `"(completed)"` standing in for unknown output.

## Scope

Rewrite the three call sites to the dance; delete the double-wait; make background prompt failure a first-class transition. Preserve the background-prompt wrapper text (`buildBackgroundPrompt`) verbatim.

## Litmus

A newcomer cannot call `session.prompt` directly or invent a new placeholder string — the build fails, and every prompt outcome is classifiable from task state alone.

## Status

**Complete** — 2026-09-11. Proof: notifications carry hydrated child text (`COMPLETED_OK` asserted production-driven); `task_continue` (active + retained-spawn) resolves the prompt result via `withBound` — no event parking; background prompt failure transitions to error and notifies immediately; `getLatestAssistantText`/`extractMessages` moved to `prompt.ts` with `hydrateLatestText` (never throws, callers keep their fallback markers); full suite 239/239 in ~11s, coverage gate green, 0 clones.

Root-caused along the way: the parked-waiter hang — when a background arm fired while a follow-up waited, `handleTimeout` cancelled the waiter's timer without resolving it, hanging `task_continue` forever. Single-wait removes the race class structurally (the waiter map is deleted); no test ever let the arm win before, which is why the suite stayed green around it.

Decisions: `extractTextFromPromptResult` empty output still yields `(Subagent completed)`; retained late-outcomes route through new `noteLateOutcome` (timed_out→completed/error, any-terminal→error) instead of raw assignment; `buildBackgroundPrompt` text verbatim.
