# Dynamic Task Plugin — Consolidated Plan v2

> **Goal:** Get to "done" — commit all working code, clean up, and verify.
> No new features, no scope creep.

---

## Prerequisites

- Node.js >= 18, npm (assumed present)
- Base branch: `main` — all commits target `main`
- All 114 tests currently pass (verified), lint is clean
- No merge conflicts with `main` at this time
- After-execution review: automated (rerun verification commands)

---

## Features We Want (Final Scope)

The plugin provides these tools and behaviors — all implemented. Files marked with  are written and tested but not yet committed.

| Feature | Status | Location |
|---------|--------|----------|
| `dynamic_task` — spawn subagents (async/sync modes) |  Done | `src/index.ts` |
| `task_continue` — send follow-up prompts |  Done | `src/index.ts` |
| `task_result` — inspect session status/output |  Done | `src/index.ts` |
| `task_interrupt` — abort child sessions |  Done | `src/index.ts` |
| Async default with parent notifications |  Done | `src/index.ts` |
| Event-based sync wait (no polling) |  Done | `src/index.ts` |
| Configurable timeout with child-session interruption |  Done | `src/shared/config.ts` |
| Dual-map state (active + retained tasks) |  Done | `src/shared/task-state.ts` |
| Agent policy validation (blocked agents, recursion, depth) |  Done | `src/shared/task-policy.ts` |
| Task ID persistence (validateTaskId, load/save map) |  Written | `src/shared/session-lifecycle.ts` |
| Question API integration (auto-answer, reject, events) |  Written | `src/shared/question-handling.ts` |
| Opt-in debug logging (`DYNAMIC_TASK_DEBUG=1`) |  Done | `src/debug-logger.ts` |
| Background-task notification strings |  Done | `src/shared/task-formatting.ts` |
| Test alignment — production imports |  Done | commit `9eb178b` |
| Runtime regression tests (error classification, races) |  Done | commit `c01c6fa` |
| README with tool docs, background behavior, config |  Done | `README.md` |

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Commit introduces new type errors | Medium | Lint runs before AND after commit (belt-and-suspenders) |
| `question-handling.ts` import breaks if not added with `git add` | Medium | Explicit `git add` in commit steps, not `git commit -a` |
| Scratch deletion removes something needed | Low | All files are untracked — `git status` verified before deletion |

---

## Remaining Work

### Step 1: Commit pending production code (4 separate commits)

Each commit is logically independent. Use `git add <file>` explicitly for each.

**Commit 1 — Task ID persistence**
```
git add src/shared/session-lifecycle.ts
git commit -m "feat: add task ID persistence (validateTaskId, load/saveTaskIdMap)"
```

**Commit 2 — Question API module**
```
git add src/shared/question-handling.ts
git commit -m "feat: add Question API integration (auto-answer, reject, event handling)"
```

**Commit 3 — Debug logger null guard**
```
git add src/debug-logger.ts
git commit -m "fix: add null guard for malformed debug payloads"
```

**Commit 4 — README updates**
```
git add README.md
git commit -m "docs: add Question Integration section, update test count to 114"
```

### Step 2: Update .gitignore + clean up scratch files

Add to `.gitignore` (append before cleanup):
```
.dynamic-task-ids.json
.handoff-*
.tmp/
.yolo.json
```

Delete scratch files (all untracked — no history loss):
- `.handoff-*` — handoff drafts
- `.tmp/` — session temp files
- `.yolo.json` — experimentation scratch
- `dynamic-task-plugin-phase2-features-plan.md` — superseded plan
- Session transcript files: `dt*.md`, `ft6*`, `t4*`, `t5*`, `dynatool*`, `session-*.md`, `plan-*`

Commit the housekeeping:
```
git add .gitignore
git commit -m "chore: update .gitignore with dynamic-task artifacts, clean up scratch"
```

### Step 3: Fix README inconsistency

```
- Expected: lint passes, all 60 tests pass.
+ Expected: lint passes, all 114 tests pass.
```

### Step 4: Final verification

```bash
npm run lint           # TypeScript type check
npm test               # Full test suite (expect 114/114 pass)
```

---

## Review Gate

**Before execution:** Review this plan and confirm:
- [ ] Scope is correct (all features listed, no extra scope)
- [ ] Commit grouping is reasonable
- [ ] Scratch file deletions are safe

**After execution:** Verify:
- [ ] `git status` shows clean working tree (no untracked/modified files)
- [ ] `npm run lint` passes
- [ ] `npm test` reports 114/114 pass
- [ ] `.dynamic-task-ids.json` is now gitignored (not visible in git status)

---

## Approval

```
[ ] I approve this plan — proceed with execution
[ ] I want changes (specify below)
```
