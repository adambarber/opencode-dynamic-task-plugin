# Docs

Design doctrine: **Choke Point Theory** — if the same shape of bug is fixed in three places, there is one missing choke point. Every task below names its dangerous primitive, its single funnel, its build enforcement, its contract test, and its degradation direction.

Work proceeds in order. Each task doc is the spec for one unit of work — no code lands without its doc's litmus passing.

## Task order

| # | Doc | Primitive | Why first |
|---|-----|-----------|-----------|
| 00 | `tasks/00-fidelity-ground-truth.md` | Stale docs as hazard | Planners inherit phantom capabilities; fix the world model before the mechanism |
| 01 | `tasks/01-lifecycle-choke-point.md` | Task state mutation | Every stall fix touches state; bypasses make all later guarantees folklore |
| 02 | `tasks/02-execution-bound.md` | Unbounded wait | Timeout-as-detector is masking; bound execution, don't enumerate bad shapes |
| 03 | `tasks/03-prompt-hydration-dance.md` | Prompt → result | Placeholder `"(completed)"` makes communication lossy even on success |
| 04 | `tasks/04-question-gate.md` | Child questions | Unmatched questions deadlock children — the dominant mid-feature stall |
| 05 | `tasks/05-notification-gate.md` | Parent notification | Best-effort prompt injection loses the one signal the planner waits on |
| 06 | `tasks/06-persistence-and-observability.md` | Ephemeral store + phantom reads | Restart orphans; `task_list`/`task_status` advertised but absent |
| 07 | `tasks/07-admission-gate.md` | Spawn admission | `depends_on`, lineage, dispatch each re-approach the same gate differently |

Conventions: plain markdown, no frontmatter, evidence cited as `path:line`. No new tooling or deps introduced by docs work.
