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
- **Cycle 5 (message/part/result family, 2026-09-11):** defined discriminated unions over `{type:"text", text:string}` parts for `extractTextFrom*`/`extractMessages`/`getLatestAssistantText` group — the only genuine type design in the program. Types: `TextPart`, `Message`, `MessageWithLegacyRoles`, `PromptResult` (union), `ExtractionResult` (discriminated). Runtime extraction functions already use `unknown` and `isEventRecord` guards, so no refactoring needed; types document the contract and enable downstream tooling. Full suite 295/295, coverage gate green, 0 clones.

## Status

**Analysis recorded** — 2026-09-11. Proof: full inventory above against the merged tree (286/286 green at merge). Implementation pending on the types branch, after the dependency update to the target versions lands on `main`.

**Cycle 5 complete** — 2026-09-11. Proof: `TextPart`, `Message`, `PromptResult`, `ExtractionResult` types defined; runtime functions (`extractTextFromParts`, `getLatestAssistantText`, `extractMessages`) already use proper `unknown` guards and pass through the type shapes; tests 295/295, coverage 96.37% (87.97% branches), 0 clones.
