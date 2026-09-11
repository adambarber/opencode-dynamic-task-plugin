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
