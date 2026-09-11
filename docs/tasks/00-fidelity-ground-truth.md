# 00 — Fidelity Ground Truth

**Doctrine:** Tenet 8 corollary — a guarantee no newcomer can verify is folklore. Stale docs are a hazard class: planners generate plans the substrate cannot execute, which presents as transient failure.

## Evidence (audit branch, no code changes)

| Claim | Ground truth |
|-------|--------------|
| README advertises `task_list`, `task_status` | `README.md:23-24` lists them; `src/index.ts:675,896,1079,1156` registers only `dynamic_task`, `task_continue`, `task_result`, `task_interrupt`. Grep hits zero in `src/` |
| `depends_on` waits for dependencies | Accepted `src/index.ts:695`, stored `src/index.ts:798`, never read. `README.md:37` documents behavior that does not exist |
| `CONSOLIDATED-PLAN.md` is current | Tracked file claims "114 tests pass" (`CONSOLIDATED-PLAN.md:9-14`); repo reports 130 (`README.md:83`), transcripts show 134+5. Commit queue described already landed |
| Transcripts are regression artifacts | `test-results-may-5.md`, `test11052026.md` are committed session logs (2k+ lines of tool I/O), escape `.gitignore:12-17` session patterns by filename |
| Task-ID persistence recovers crashes | Writer inverts the map `src/index.ts:802-804` (`set(childSessionId, description)` vs loader contract `src/shared/session-lifecycle.ts:102-115` keyed by task ID). Live `.dynamic-task-ids.json:1` holds test-fixture shape |

## Choke point

- **Primitive:** the documented capability set.
- **Funnel:** `README.md` + `docs/` describe exactly what `src/` registers. No capability is documented twice.
- **Enforcement:** a CI check that fails on drift — every `tool({` registration in `src/index.ts` has a matching README row; every README tool row has a registration; every accepted arg (`depends_on`, `model`, `timeout_ms`) has an enforcement site or is marked unimplemented. Newcomer adding a tool without docs (or docs without a tool) turns the build red.
- **Contract test:** doc-inventory test, not a mock — walks the real source tree.
- **Degradation:** unimplemented args are rejected with an explicit error, never silently accepted.

## Scope

1. Rewrite `README.md` tool table to the four real tools; mark `depends_on` as accepted-but-unenforced until Task 07.
2. Archive (not rewrite): move `CONSOLIDATED-PLAN.md`, `re-verify-prompt.md`, `test-results-may-5.md`, `test11052026.md` out of the planning path so no future agent treats them as current. Deletion vs `docs/archive/` is the implementer's call; record it here.
3. Delete or quarantine `.dynamic-task-ids.json` fixture content; Task 06 owns the real format.

## Litmus

A newcomer who has never read this doc cannot merge a new tool, arg, or behavior without updating the single capability inventory — the build fails first.
