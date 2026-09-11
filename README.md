# OpenCode Dynamic Task Plugin

Background subagent orchestration for [OpenCode](https://opencode.ai) — spawn, track, resume, and interrupt child sessions with automatic parent notifications.

## Quick Start

```jsonc
// ~/.config/opencode/profiles/lean2/opencode.jsonc
"plugin": ["file:///path/to/dynamic-task-plugin/dist/index.js"]
```

```bash
npm install && npm run build
```

## Tools

| Tool | Description |
|------|-------------|
| `dynamic_task` | Spawn a subagent session (sync or background) |
| `task_continue` | Send a follow-up prompt to a running session |
| `task_result` | Poll a session's latest status and output (live API) |
| `task_interrupt` | Abort a running child session |
| `task_list` | List all tracked tasks with lifecycle states |
| `task_status` | Detailed tracked state for one task (store read, no API calls) |

### Key parameters

```
dynamic_task(
  description="Review PR",
  subagent_type="reviewer",
  prompt="Review for bugs",
  await_response=false,             // background mode (default)
  timeout_ms=300000,                // 5 minute timeout
  model="opencode-go/mimo-v2.5",   // model override
  depends_on=["ses_t1", "ses_t2"]  // tasks start after deps complete (unknown ids pass)
)
```

## How Background Tasks Work

1. A child session is spawned with `await_response=false`
2. The prompt is wrapped with background-task instructions
3. Control returns immediately with the session ID
4. On completion (or timeout), a `[dynamic-task-notify]` message arrives in the parent

**Notifications are exactly-once.** A completion guard prevents duplicates. Post-timeout completions arrive as `completed_after_timeout`.

## Configuration

Set via environment variables or `.opencode/dynamic-task-plugin.jsonc`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_TASK_TIMEOUT` | `120000` | Default timeout (ms) |
| `DYNAMIC_TASK_MAX_CONCURRENT` | `4` | Max concurrent background tasks |
| `DYNAMIC_TASK_CACHE_TTL` | `300000` | Agent list cache TTL (ms) |
| `DYNAMIC_TASK_DEBUG` | off | `1` to enable per-session debug logs |
| `DYNAMIC_TASK_DEBUG_BLOCKLIST` | `prompt,fullPrompt` | Fields to exclude from logs |

### State Files

Both live in the **project directory the host provides** (never the process CWD — running the test suite writes no state into the repo):

- `.dynamic-task-ledger.json` — retained-task crash recovery, written atomically on every retained mutation.
- `.dynamic-task-logs/` — per-session debug logs, only created when `DYNAMIC_TASK_DEBUG=1`.

## Architecture

```
src/
├── index.ts                 Orchestrator — tool/event wiring
├── plugin-entry.ts          Clean ESM re-export
├── debug-logger.ts          Opt-in diagnostics (off by default)
└── shared/
    ├── client.ts            SDK facade — the only @opencode-ai/sdk import
    ├── config.ts            Normalization, 4-layer precedence, TimerProvider
    ├── bound.ts             Execution bound — the single wait/timeout funnel
    ├── admission.ts         Admission gate — validate-then-register funnel
    ├── prompt.ts            Prompt dance — payload shape, hydration, routing
    ├── notify.ts            Parent-notification gate + bounded ledger
    ├── task-policy.ts       Pure validators — agent, lineage, depth
    ├── task-state.ts        TaskStore (active/retained), transition matrix
    ├── session-lifecycle.ts Event parsing, status normalization, unknown-narrowing readers
    ├── task-formatting.ts   Result/status/continue formatting
    └── question-handling.ts Question API auto-answer/reject
```

## Development

```bash
npm test                  # full suite + safety invariants (node:test)
npm run lint              # tsc --noEmit (full strict flags)
npm run build             # compiles to dist/
npm run test:coverage     # 90/80/90 gate enforced
npm run test:duplication  # jscpd clone gate (zero clones)
```

## License

MIT
