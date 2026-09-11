# Dynamic Task Plugin — Re-verification

Test 3 surgical fixes applied to the dynamic-task-plugin. Run in sequence.

## Preflight

```bash
cd /home/Dan/.config/opencode/projects/dynamic-task-plugin
npm run build && node --test src/tests/sync-mode.integration.test.js && node --test src/tests/plugin.test.js src/tests/background-completion.test.js
```

**Expected:** build clean, 139 tests passing.

---

## Test 1: Sync mode still fixed

```
dynamic_task(explore, "What is 5+7?", await_response=true, timeout_ms=30000)
```

**Expected:** returns inline with `12`, no `DIAG: poll` logs.

---

## Test 2: model parameter with string

```
dynamic_task(explore, "Say hello", await_response=false, model="ollama-cloud/deepseek-v4-flash")
```

**Expected:** spawns a background task that uses the specified model.

---

## Test 3: task_continue on completed session (should try existing)

```
dynamic_task(explore, "Name 3 cities", await_response=true, timeout_ms=30000)
→ capture session_id
task_continue(session_id="<id>", prompt="Which one has the largest population?", timeout_ms=30000)
```

**Expected:** returns immediately with a follow-up response (not a "new session" message, not a timeout).

---

## Test 4: task_continue on timed-out session (should spawn new)

```
dynamic_task(explore, "Write a very long response about everything", await_response=false)
→ capture session_id
```

Wait for timeout. Then:

```
task_continue(session_id="<id>", prompt="Summarize in one sentence", timeout_ms=30000)
```

**Expected:** may create a new continuation session if the original timed out.

---

## Test 5: No duplicate timeout notifications

```
dynamic_task(explore, "Return DONE_NOW", await_response=false)
```

**Expected:** at most one notification (either completion or timeout, not both).

---

## Acceptance Criteria

| # | Condition | Pass/Fail |
|---|-----------|-----------|
| 1 | Sync mode returns `12` inline, no `DIAG: poll` | |
| 2 | Background task spawns with specified model | |
| 3 | `task_continue` on completed session reuses existing session | |
| 4 | `task_continue` on timed-out session spawns new session gracefully | |
| 5 | No duplicate timeout/completion notifications | |

**All 5 must pass** before the fixes are verified.
