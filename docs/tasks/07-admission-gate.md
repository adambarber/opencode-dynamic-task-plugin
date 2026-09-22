# 07 — Admission Gate

**Doctrine:** Tenets 3, 4, 8. Spawn admission is a resolve-then-validate gate: resolve what the caller asked for against the live registry, then validate policy — in one place, in that order.

## Evidence

- Three policies re-approach admission separately: `validateAgent` (blocked list, `src/shared/task-policy.ts:29-48`), `validateLineage` (recursion/depth, `src/shared/task-policy.ts:83-116`), `isDispatchableAgent` (mode tri-state, `src/shared/task-policy.ts:60-64`, fixed in `eed3a04`).
- The composition in `src/index.ts:721-756` validates *after* `fetchAgents` filtering, against a possibly stale cache (Task 00/01 evidence: 5-min TTL, warn-and-stale `src/index.ts:269-299`). Registry drift presents as "agent not found" with no retry.
- `createDummyLineage` (`src/index.ts:504-523`) resolves lineage by comparing the caller's session ID against child-session keys — different namespaces — so `validateLineage` receives a vacuous input in production. Pure, tested, ineffective when wired.
- `depends_on` accepted, stored, unenforced (Task 00). No admission site owns ordering.
- `allowSameAgentRecursion` exists in config (`src/shared/config.ts:34`) but `validateLineage` never reads it — absolute block regardless of setting. Dead option.

## Choke point

- **Primitive:** admitting a spawn (agent resolution + policy validation + dependency readiness).
- **Funnel:** one `admitSpawn(request, ctx, store, registry)` gate: resolve first (name normalization → live registry lookup with one retry on transient fetch failure → lineage resolved via `parentID` chains, not session-ID equality), then validate (dispatchable → blocked → recursion/depth honoring `allowSameAgentRecursion` → dependencies all `completed`). Every spawn path (`dynamic_task`, retained-continuation in `task_continue`) passes through it.
- **Enforcement:** build invariant — no direct `agents.find`, `validateAgent`, `validateLineage`, or `registerActiveTask` outside the gate. The gate is the only caller of registration.
- **Contract test:** registry-shape variants (missing `mode`, legacy `type`, mixed case/`@` prefix) plus dependency states (pending → refuse with blocker set; completed → admit). Tests the real composition, not each validator in isolation.
- **Degradation:** each refusal names its reason and remedy (available agents / blocker set / lineage chain / pending dependency IDs). Transient registry failure → one retry, then explicit error — never silent stale-cache dispatch. `depends_on` unmet → refuse with the pending set, not unordered spawn.

## Scope

Build the gate, route both spawn sites through it, resolve lineage from `parentID` chains, honor `allowSameAgentRecursion`, enforce `depends_on` readiness. Keep `maxDepth: 2`, `blockedAgents: ["general"]` defaults unchanged.

## Litmus

A newcomer cannot spawn a session except through the admission gate — the build fails — and every refusal tells the planner exactly what to do next.

## Status

**Complete** — 2026-09-11. Proof: `allowSameAgentRecursion` honored (unit + nested integration, strict refusal pinned); `resolveDependencies` unit-pinned (none/completed/running/failed/unknown) with integration refusal-then-admission; `formatAdmissionError` renders all four refusal kinds identically to the old inline strings; fetch retry covered; lineage inheritance integration-pinned — which exposed the double-count (parent re-append collapsed depth and display, both fixed to verbatim); continuation policy implemented (dead → re-admit on ancestors-only lineage → spawn or named refusal, registry-drift covered); full suite 286/286, coverage gate green, 0 clones.

Decisions: unknown dep ids pass (aged-out tolerance over deadlock); resumption checks ancestors-only (continuing is not re-delegating); all four bounded-prompt sites share `awaitContinuation`; refusal rendering centralized in the gate.

Follow-up 2026-09-12 (orphan on concurrency rejection): background concurrency is pre-checked via `checkConcurrencyLimit(countActiveBackgroundTasks(store), config)` BEFORE `session.create` — rejecting after create left an untracked child running on the server. `registerActiveTask` re-checks as the authoritative gate (same-tick race); any post-create failure now aborts the untracked session or settles a registered task to `error` (which also fixes sync-mode prompt rejects lingering as permanently active). `countActiveBackgroundTasks` extracted as the single count source.

Follow-up 2026-09-12 (entry-contract: the host invokes every entry export as a candidate plugin function): server agent discovery (`buildAgentList`, `fetchAgents` + cache, `resetAgentCache`) moved here from the entry — agent shape is this module's domain. `safeLog` moved to `notify.ts` (client-communication domain).

## Known fork (found during foundation, pinned by tools.integration tests)

Retained-continue on an async-dead session reports timeout; only a synchronously-throwing prompt reaches the spawn-new path. Whether a dead continuation should retry, replan, or refuse is continuation policy — decided here, in the gate, not in the tool handler.

Follow-up 2026-09-14 (adversarial review F-4): the agent-list cache is scoped per client (`WeakMap` keyed on the client object, TTL unchanged). The process-global cache let one plugin instance — or a host probe with a different client — be served another client's agent list. `resetAgentCache` invalidates all clients' entries via an epoch bump; stale-on-total-failure stays per-client (a client's last known list, never another's).

Follow-up 2026-09-22 (orchestration audit H1: silent bad model ids): `parseModelOverride` accepted anything, so a bare id failed after session creation on the lifecycle path as `(error — no detail)` naming nothing. Fix is admission-shape, not an allowlist (the server accepts ids absent from config): `describeModelShapeError` (`prompt.ts`) rejects empty-`providerID` before `session.create` with the qualified `providerID/modelID` form, and the requested string is echoed in the spawn confirmation and in every spawn/prompt-failure error settlement — failures name the suspect.

Follow-up 2026-09-22 (orchestration audit M1: failed deps deadlock dependents): `resolveDependencies` admitted only `completed`, so a failed/interrupted dep blocked forever with a stateless `Dependencies pending`. The gate now distinguishes settled from succeeded: `depends_on` stays strict-`completed`; a new opt-in `depends_on_settled` list admits any terminal state (completed/error/interrupted) while still blocking actives. Strict wins on overlap; unknown ids still pass (GC-tolerance). The rejection names each blocker's terminal state (`ses_x (error)`), and both lists persist on the record so `task_status` renders the full picture.
