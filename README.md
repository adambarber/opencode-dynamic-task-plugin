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
| `task_result` | Poll a session's latest status and output |
| `task_interrupt` | Abort a running session |

> Planned but not yet implemented: `task_list`, `task_status` — see `docs/tasks/06-persistence-and-observability.md`.

### Key parameters

```
dynamic_task(
  description="Review PR",
  subagent_type="reviewer",
  prompt="Review for bugs",
  await_response=false,             // background mode (default)
  timeout_ms=300000,                // 5 minute timeout
  model="opencode-go/mimo-v2.5",   // model override
  depends_on=["ses_t1", "ses_t2"]  // accepted but not yet enforced — see docs/tasks/07-admission-gate.md
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

## Architecture

```
src/
├── index.ts                 Orchestrator — tool/event wiring
├── plugin-entry.ts          Clean ESM re-export
├── debug-logger.ts          Opt-in diagnostics (off by default)
└── shared/
    ├── config.ts            Normalization, 4-layer precedence, TimerProvider
    ├── task-policy.ts       Pure validators — agent, lineage, depth
    ├── task-state.ts        TaskStore (active/retained), transition matrix
    ├── session-lifecycle.ts Event parsing, status normalization
    ├── task-formatting.ts   Notifications, prompt wrapping
    └── question-handling.ts Question API auto-answer/reject
```

## Development

```bash
npm test                  # 217 tests
npm run lint              # tsc --noEmit
npm run build             # compiles to dist/
npm run test:coverage     # 90/80/90 gate enforceed
```

## License

MIT
