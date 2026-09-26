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
| `task_continue` | Steer a running child (its turn stops, the message becomes the next turn) or revive a settled one |
| `task_notify` | Child-to-parent channel: progress, findings, or a block needing input (requires a child agent with plugin tools, e.g. `general` — read-only agents such as `explore` cannot signal) |
| `task_result` | Report tracked status (the store's own state, authoritative for settleability) beside a sourced live read: the server's own turn status, the child's last message time, and this plugin's last observed event |
| `task_interrupt` | Stop a running child session (abort attempted; state settled first) |
| `task_list` | List all tracked tasks with lifecycle states |
| `task_status` | Detailed tracked state for one task, beside the same sourced live read `task_result` makes |

### Key parameters

```
dynamic_task(
  description="Review PR",
  subagent_type="reviewer",
  prompt="Review for bugs",
  model="opencode-go/mimo-v2.5",   // providerID/modelID as spelled in opencode.jsonc (bare ids rejected)
  depends_on=["ses_t1", "ses_t2"]  // tasks start after deps complete (unknown ids pass)
  depends_on_settled=["ses_t3"]     // tasks start after deps settle, whatever the outcome
)

task_continue(session_id="ses_child", prompt="Also check error handling")

task_notify(message="blocked: need DB credentials to continue")  // from inside a child
```

## How Tasks Settle

The plugin arms no timers and never waits. Every task runs in the background.
Settled turns report exactly once through a `[dynamic-task-notify]` message
in the parent; a child's mid-flight `task_notify` arrives separately as a
`[dynamic-task-notice]` message, so settlement vs. spoke routes on the tag
without parsing prose. `task_result` and `task_status` both report the store's
own state as the authority on settleability, and every live line beside it names
its own source: `Server status:` is the server's word, `Last child message:` is
the child's own transcript, `Last plugin event:` is what this plugin's event
head has seen. No view infers a status the sources did not state — a session the
server does not list reads as `unknown`, not as idle. There is
no timeout to configure: a slow child is indistinguishable from a working one
by design, and the only bound on a child is operator intent (`task_interrupt`).

1. `dynamic_task` spawns a child session, wraps the prompt with
   background-task instructions, and returns the session id immediately.
2. Mid-flight, the child may `task_notify` the parent — blocked, progress, or
   anything worth surfacing before it converges.
3. On the child's terminal lifecycle event, the parent is notified once with
   the latest outcome (exactly-once, deduped per settled turn).
4. `task_continue` steers a running child — its current turn aborts and the
   message becomes its next turn, staying active — or revives a settled task
   for another turn through the same single gate. Interrupted children are not
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
| `DYNAMIC_TASK_FORBIDDEN_AGENTS` | `(empty — all agents dispatch)` | Comma-separated blocked agent names |
| `DYNAMIC_TASK_ALLOW_SAME_AGENT_RECURSION` | `false` | Allow an agent to spawn itself |
| `DYNAMIC_TASK_DEBUG` | off | `1` to enable per-session debug logs |
| `DYNAMIC_TASK_DEBUG_BLOCKLIST` | `prompt,fullPrompt` | Fields to exclude from logs |

### State Files

Both live in the **project directory the host provides** (never the process CWD — running the test suite writes no state into the repo):

- `.dynamic-task-ledger.json` — retained-task crash recovery, written atomically on every retained mutation.
- `.dynamic-task-logs/` — per-session debug logs, only created when `DYNAMIC_TASK_DEBUG=1`.

**Only settled records persist.** Active tasks live in process memory, so
restarting the parent mid-child leaves that child running with no record: its
terminal events find nothing to settle and drop, and nothing can be read about
it afterwards. Retained (settled) records survive the restart, which is what
makes the ledger useful for reading history. Closing the active-task half is
specified, not implemented — see `docs/tasks/11-durability.md`.

## Architecture

```
src/
├── index.ts                 Thin entry — boot, event head, tool inventory
├── plugin-entry.ts          Clean ESM re-export
├── debug-logger.ts          Opt-in diagnostics (off by default, total writes)
├── entry/
│   ├── state.ts             Per-instance boot (config, store, ledger wiring)
│   ├── questions.ts         Question-gate dispatch (attribute, then settle)
│   └── lifecycle.ts         Prompt dance, parent delivery, settlement handler
├── tools/
│   ├── index.ts             Tool inventory (the Task-00 fidelity gate scans this)
│   ├── context.ts           Shared deps, guards, session readers
│   ├── spawn.ts             dynamic_task executor (the only session.create site)
│   ├── continue.ts          task_continue executor (steer + revive)
│   ├── notice.ts            task_notify executor (mid-flight voice)
│   ├── read.ts              task_result/status/list executors (store record + the one shared live liveness read)
│   └── interrupt.ts         task_interrupt executor (settle-first abort)
└── shared/
    ├── client.ts            SDK facade — the only @opencode-ai/sdk import
    ├── config.ts            Normalization, 4-layer precedence, concurrency limit
    ├── admission.ts         Admission gate — validate-then-register funnel
    ├── prompt.ts            Prompt dance — payload shape, hydration, routing
    ├── notify.ts            Parent-notification gate: exactly-once per turn
    ├── task-policy.ts       Pure validators — agent, lineage, depth
    ├── task-state.ts        TaskStore (active/retained), settle & revival matrix
    ├── liveness.ts          The one live liveness read — the server's turn status + the child's own last message
    ├── session-lifecycle.ts Event parsing, status normalization, ledger I/O
    ├── task-formatting.ts   Result/status/fleet formatting for humans
    └── question-handling.ts Question API auto-answer/reject
```

## Development

```bash
npm test                  # build + clone gate + full suite (node:test) — the one command a change must pass
npm run lint              # tsc --noEmit (full strict flags)
npm run build             # compiles to dist/
npm run test:coverage     # build + clone gate + 90/80/90 coverage gate enforced
npm run test:duplication  # jscpd clone gate (zero clones) — runs inside npm test too
```

## License

MIT
