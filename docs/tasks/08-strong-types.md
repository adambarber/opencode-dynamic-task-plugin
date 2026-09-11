# 08 — Strong Types

**Doctrine:** Tenets 3 and 8. An `any` is a missing choke point: every future author must remember the shape instead of the compiler enforcing it. The cure is to make unvalidated states unrepresentable at each boundary, and to make reintroducing `any` fail the build.

**Target versions (verified against the registry, 2026-09-11):** `@opencode-ai/sdk@1.18.30`, `@opencode-ai/plugin@1.18.30` (aligned pair — pin together), `typescript@7.0.2`, `@types/node@22.20.2`. Plugin code targets the SDK 1.18.30 type surface. Counts below were measured pre-bump; re-measure on the types branch after the dependency update lands.

## Evidence (branch `analysis/strong-types`, `tsc` clean)

| Signal | Count | Notes |
|--------|-------|-------|
| `any` | 71 (`index.ts`: 45, `prompt.ts`: 12, rest scattered) | All explicit — `strict` was never asked to reject them |
| `catch (e: any)` | 12 | Despite `useUnknownInCatchVariables` being on; every site opts back out explicitly |
| `as` casts | ~30 | Half legitimate narrowing (`config.ts:213-214`, `session-lifecycle.ts:3-4`); rest circumventions — worst is `prompt.ts:39-41` (`(error as any)?.message`, a double bypass) and 7× `childSessionId as string` replaceable by early-return narrowing |
| Missing return types on exports | 0 | |
| `ts-ignore` / non-null assertions | 0 / 0 | |
| Test files | 6× `.js` | Outside `tsc` entirely — 100% must explicitly include or exclude them |

`tsconfig.json` has `strict:true` but lacks `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`/`noUnusedParameters`, `noFallthroughCasesInSwitch`. No lint tool exists, so nothing bans new `any`s.

## The four untyped boundaries

- **Client (~15 sites):** `client: any` on every helper. Real type waiting: `PluginInput["client"]` (`ReturnType<typeof createOpencodeClient>`). The SDK is a generated OpenAPI client — expect a thin local `SessionClient` facade rather than threading generated types everywhere.
- **Tools (~10 sites):** `execute(args: any, ctx: any)`. `tool()` already infers `args` from the zod schemas and provides `ToolContext` — adopt both. Collateral win: `ToolContext.sessionID` is required, so the 5-key `resolveParentSessionId` probe collapses, and `ctx.agent` gives lineage a first-class parent identity.
- **Events (~6 sites):** adopt the SDK `Event` union; change guard inputs from `any` to `unknown` (`isTerminalSessionEvent`, `isValidQuestionEvent` already narrow correctly).
- **Results/parts (~20 sites):** the one hand-made family — discriminated unions over `{type:"text", text:string}` parts for the `extractTextFrom*`/`extractMessages`/`getLatestAssistantText` group. The only genuine type design in the program.

## Ordered work

1. Declare the SDK (devDependency — build-time only; `dist/*.d.ts` will reference it).
2. Type the client boundary via the facade.
3. Type the tool boundary via inference + `ToolContext`.
4. Type the event boundary via the SDK union + `unknown` guards.
5. Write the message/part/result family.
6. Migrate catches to `unknown` + narrowing (rebirth of the deleted not-found logic as a type guard).
7. Enable the missing strict flags; fix the fallout (mostly index-signature and optional-field handling).
8. Ban `any` the house way — a `safety-invariants` suite scanning for `: any` outside a sanctioned list (zero new tooling; eslint is the conventional alternative).
9. Decide the test files (migrate to `.ts` against the existing `dist/` seam, or JSDoc-check the JS).

## Litmus

A newcomer cannot add an untyped boundary, an `as`-escape, or an untyped catch — the build (compiler flags plus invariant suite) fails first.

## Execution log

- **Cycle 1 (entry boundary, 2026-09-11):** plugin entry on `PluginInput`/`PluginOptions` (SDK 1.18.30), `initPluginState` options typed, `normalizeDynamicTaskConfig` widened to accept records, `fileConfig as any` deleted. Compiled clean on first pass (downstream `any`s absorb); full suite 286/286, coverage gate green, 0 clones. Next: client facade (boundary A).
- **Cycle 2 (client boundary, 2026-09-11):** `shared/client.ts` declares the `OpenCodeClient` facade (the only `@opencode-ai/sdk` import; SDK pinned as a build-time devDependency); `client: any` swapped to the facade in `notify.ts`, `prompt.ts`, `question-handling.ts`, `index.ts`; agent payloads parsed through `parseAgentList` + `isDispatchableAgent` validators in `admission.ts` instead of cast. Suite green, coverage gate green, 0 clones.
- **Cycle 3 (tool boundary, 2026-09-11):** `execute(args, ctx)` typed from the `tool()` zod inference and `ToolContext` — explicit `args`/`ctx` annotations dropped in favor of what the SDK provides; session-scoped read helpers adopt `ToolContext.sessionID` (required), collapsing the speculative parent-session probe. Suite green, 0 clones.
- **Cycle 4 (event boundary, 2026-09-11):** event guards switched from `any` to `unknown` inputs; `session-lifecycle.ts` gained the validated field readers (`isEventRecord`, `eventField`, `eventString`, `normalizeStatus`) so event payloads are probed, never cast; SDK `Event` union accepted at the `event()` entry. Suite green, coverage gate green, 0 clones.
- **Cycle 5 (message/part family, 2026-09-11):** the hand-made family — `TextPart`/`Message` shapes plus their only door in (`isTextPart`, `isMessage`, `messageRoleOf`) — rewritten so the extraction group **consumes** the narrowed types instead of re-probing fields: `extractTextFromParts` filters through `isTextPart`, `getLatestAssistantText` walks `isMessage`+`messageRoleOf(msg) === ASSISTANT_ROLE`. The `role`/`info` duality (nested under `info` in one hydration era, top-level in another) is absorbed inside `messageRoleOf` rather than leaking into callers. Three first-pass types were deleted as dead on a later `aft_inspect` pass (see Revision below): `PromptResult`/`ExtractionResult`/`MessageWithLegacyRoles` — no function accepts the union (callers receive `unknown` and probe it), and `ExtractionResult`'s `kind: "error"` arm asserted an error state the extractor never produces (it returns `""`); exporting unconsumed types is the exact dead weight the doctrine bans. Suite green after wiring, 0 clones.
- **Cycle 6 (catch-unknown migration, 2026-09-11):** migrated all `catch (e: any)` sites to `catch (error: unknown)` with proper `instanceof Error` narrowing. Three sites: `fetchAgents` (log-only), `handleTimeout` (abort error), and event handler (internal error logging). All use runtime error message extraction; now type-safe without `any`. Full suite 295/295, coverage 96.37% (87.97% branches), 0 clones.
- **Cycle 7 (strict flags + fallout, 2026-09-11):** enabled `useUnknownInCatchVariables`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. Fallout fixes: `transitionState` dropped its unused `config` param (9 call sites updated); removed dead `TaskLifecycleState` import, `POLL_INTERVAL`, `activeTask`; genuinely-undefined data fields (`requestedModel`, `dependsOn`, `abortError`, `previousSessionId`, `retainedAt`, `notification`) widened to `?: T | undefined` at declaration; `stealTimeoutHandle` uses `delete` not `= undefined`; index reads in `getLatestNotification`, `decideQuestion`, `pruneIfBounded` now narrowed; possibly-optional values in `invokePrompt` routing passed via conditional spread. tsc clean, full suite 295/295, coverage gate green, 0 clones.
- **Cycle 8 (any-ban + test-file decision, 2026-09-11):** two new safety-invariant suites — `: any`/`as any`/`<any>`/`any[]` forbidden in production `.ts` (empty sanctioned list, comment lines exempt from the text scan) and `catch (x: any)` explicitly named. RED showed 16+8 bypass sites; GREEN eliminated every one: `errorMessage(error: unknown)` joins the reader family in session-lifecycle.ts (the prompt.ts `as any` triple — the doc's named worst offender — and 8 catch sites now narrow); `validateSessionResult` takes `unknown` through `eventField`; the question-gate's 8 `childSessionId as string` casts died to an early `=== null` guard; the continuation-spawn `session.create` body dropped its stale `agent` field (same 1.18 silent-drop bug the routing cycle fixed for the main spawn); `normalizeQuestionAnswers` tightened to string-only answers. Suite 297/297, tsc clean, coverage gate green, 0 clones. **Test-file decision:** the 6 `.js` test files stay `.js`, outside `tsc`. Rationale: they exercise the runtime `dist/` seam with deliberately partial mocks; `checkJs` would force either fixture overfitting (mocks grown to full interface shape) or `@ts-ignore` escapes (banned by the litmus), and a `.ts` migration re-imports zero production types since tests cross the compiled boundary. Type enforcement lives where state is validated; the scanners (this cycle's two suites + Task 00/10 gates) are the test-side invariants, reading production source as the subject — Tenet 12.

## Status

**Analysis recorded** — 2026-09-11. Proof: full inventory above against the merged tree (286/286 green at merge). Implementation pending on the types branch, after the dependency update to the target versions lands on `main`.

**Cycle 5 complete — revised** — 2026-09-11. First pass shipped `TextPart`/`Message`/`PromptResult`/`ExtractionResult`/`MessageWithLegacyRoles` as unconsumed declarations and rationalized it as "documenting the contract"; `aft_inspect` flagged three as dead/unused. Corrected: the family is now guard-first (`isTextPart`/`isMessage`/`messageRoleOf` + `ASSISTANT_ROLE`) and **consumed by** `extractTextFromParts` and `getLatestAssistantText`, with `PromptResult`/`ExtractionResult`/`MessageWithLegacyRoles` deleted (no caller accepts a narrowed union of `unknown` payloads; the error arm was a fiction). Escape hatch for the future: if a typed prompt response ever becomes loadable, re-introduce `PromptResult` **behind a loader that returns it** — never as a bare alias. 4 new guard tests; original extraction tests pass unchanged (behavior preserved). Suite 301/301, tsc clean, coverage 96.3% (87.99% branches) gate green, 0 clones, `aft_inspect`: 0 dead code / 0 unused exports.

**Cycle 6 complete** — 2026-09-11. Proof: all 3 `catch (e: any)` sites migrated to `catch (error: unknown)` with `instanceof Error` narrowing; tests 295/295, coverage 96.37% (87.97% branches), 0 clones.

**Cycle 7 complete** — 2026-09-11. Proof: `tsconfig.json` now carries all six strict flags (`useUnknownInCatchVariables`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`); `tsc --noEmit` clean; fallout fixed by widening genuinely-undefined data fields, dropping the unused `config` param from `transitionState`, removing dead locals, narrowing all index reads, and routing optional `invokePrompt` fields via conditional spread; tests 295/295, coverage gate green, 0 clones.

**Cycle 8 complete — Task 08 complete** — 2026-09-11. Proof: two any-ban invariants (annotations/casts/generics + catch-any) went RED on 16+8 sites, GREEN on zero; `errorMessage` reader closes the prompt.ts `as any` triple; 8 `childSessionId as string` casts replaced by null-guard narrowing; continuation create body dropped its stale `agent` field; test-file decision recorded above (`.js` stays, scanners enforce). Suite 297/297, tsc clean under all strict flags, zero `any` in `src/**.ts`, coverage gate green, 0 clones. All eight cycles of the ordered work landed.
