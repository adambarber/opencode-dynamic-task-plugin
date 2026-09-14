# OpenCode Dynamic Task Plugin

Background subagent orchestration for [OpenCode](https://opencode.ai) — spawn, steer, notify, and interrupt child sessions with exactly-once settlement at the notification layer.

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
| `dynamic_task` | Spawn a background subagent session; returns immediately |
| `task_continue` | Send a follow-up prompt to a settled task (revives it for a fresh turn) |
| `task_notify` | Child-to-parent channel: progress, findings, or a block needing input (requires a child agent with plugin tools, e.g. `general` — read-only agents such as `explore` cannot signal) |
| `task_result` | Poll a session's latest status and output (live API) |
| `task_interrupt` | Stop a running child session (abort attempted; state settled first) |
| `task_list` | List all tracked tasks with lifecycle states |
| `task_status` | Detailed tracked state for one task (store read, no API calls) |

### Key parameters

```
dynamic_task(
  description="Review PR",
  subagent_type="reviewer",
  prompt="Review for bugs",
  model="opencode-go/mimo-v2.5",   // model override
  depends_on=["ses_t1", "ses_t2"]  // tasks start after deps complete (unknown ids pass)
)

task_continue(session_id="ses_child", prompt="Also check error handling")

task_notify(message="blocked: need DB credentials to continue")  // from inside a child
```

## How Tasks Settle

The plugin arms no timers and never waits. Every task runs in the background
and reports each settled turn's outcome exactly once through a `[dynamic-task-notify]` message
in the parent — completion, error, or a child's `task_notify` notice. There is
no timeout to configure: a slow child is indistinguishable from a working one
by design, and the only bound on a child is operator intent (`task_interrupt`).

1. `dynamic_task` spawns a child session, wraps the prompt with
   background-task instructions, and returns the session id immediately.
2. Mid-flight, the child may `task_notify` the parent — blocked, progress, or
   anything worth surfacing before it converges.
3. On the child's terminal lifecycle event, the parent is notified once with
   the latest outcome (exactly-once, deduped per settled turn).
4. `task_continue` revives a settled task for another turn; the revived task
   settles again through the same single gate. Interrupted children are not
   revived — spawn a fresh `dynamic_task` instead.

## Configuration

Set via environment variables, `.opencode/dynamic-task-plugin.jsonc`, or the plugin tuple options in `opencode.json` (precedence: env > tuple options > file > defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_TASK_MAX_CONCURRENT` | `4` | Max concurrent background tasks |
| `DYNAMIC_TASK_MAX_DEPTH` | `2` | Max agent-lineage recursion depth |
| `DYNAMIC_TASK_CACHE_TTL` | `300000` | Agent list cache TTL (ms) |
| `DYNAMIC_TASK_RETAINED_TTL_MS` | `3600000` | Retained-task record TTL (ms) |
| `DYNAMIC_TASK_RETAINED_MAX_ENTRIES` | `100` | Retained-task record cap |
| `DYNAMIC_TASK_FORBIDDEN_AGENTS` | `general` | Comma-separated blocked agent names |
| `DYNAMIC_TASK_ALLOW_SAME_AGENT_RECURSION` | `false` | Allow an agent to spawn itself |
| `DYNAMIC_TASK_DEBUG` | off | `1` to enable per-session debug logs |
| `DYNAMIC_TASK_DEBUG_BLOCKLIST` | `prompt,fullPrompt` | Fields to exclude from logs |

### State Files

Both live in the **project directory the host provides** (never the process CWD — running the test suite writes no state into the repo):

- `.dynamic-task-ledger.json` — retained-task crash recovery, written atomically on every retained mutation.
- `.dynamic-task-logs/` — per-session debug logs, only created when `DYNAMIC_TASK_DEBUG=1`.

## Architecture

```
src/
├── index.ts                 Orchestrator — tool/event wiring, settlement gate
├── plugin-entry.ts          Clean ESM re-export
├── debug-logger.ts          Opt-in diagnostics (off by default, total writes)
└── shared/
    ├── client.ts            SDK facade — the only @opencode-ai/sdk import
    ├── config.ts            Normalization, 4-layer precedence, concurrency limit
    ├── admission.ts         Admission gate — validate-then-register funnel
    ├── prompt.ts            Prompt dance — payload shape, hydration, routing
    ├── notify.ts            Parent-notification gate: exactly-once per turn
    ├── task-policy.ts       Pure validators — agent, lineage, depth
    ├── task-state.ts        TaskStore (active/retained), settle & revival matrix
    ├── session-lifecycle.ts Event parsing, status normalization, ledger I/O
    ├── task-formatting.ts   Result/status/fleet formatting for humans
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
