# Docs

Design doctrine: **Choke Point Theory** (`2026-09-10-choke-point-theory-of-software-design.md`) — if the same shape of bug is fixed in three places, there is one missing choke point. Every task below names its dangerous primitive, its single funnel, its build enforcement, its contract test, and its degradation direction.

Work proceeds in order. Each task doc is the spec for one unit of work — no code lands without its doc's litmus passing.

## Task order

| # | Doc | Primitive | Why first | Status |
|---|-----|-----------|-----------|--------|
| 00 | `tasks/00-fidelity-ground-truth.md` | Stale docs as hazard | Planners inherit phantom capabilities; fix the world model before the mechanism | Complete |
| 01 | `tasks/01-lifecycle-choke-point.md` | Task state mutation | Every stall fix touches state; bypasses make all later guarantees folklore | Complete |
| 02 | `tasks/02-execution-bound.md` | Unbounded wait | Timeout-as-detector is masking; bound execution, don't enumerate bad shapes | Complete |
| 03 | `tasks/03-prompt-hydration-dance.md` | Prompt → result | Placeholder `"(completed)"` makes communication lossy even on success | Complete |
| 04 | `tasks/04-question-gate.md` | Child questions | Unmatched questions deadlock children — the dominant mid-feature stall | Complete |
| 05 | `tasks/05-notification-gate.md` | Parent notification | Best-effort prompt injection loses the one signal the planner waits on | Complete |
| 06 | `tasks/06-persistence-and-observability.md` | Ephemeral store + phantom reads | Restart orphans; `task_list`/`task_status` advertised but absent | Complete |
| 07 | `tasks/07-admission-gate.md` | Spawn admission | `depends_on`, lineage, dispatch each re-approach the same gate differently | Complete |
| 08 | `tasks/08-strong-types.md` | Untyped boundaries | `any` at four seams defeats review; close them with guard-first types | Complete |
| 09 | `tasks/09-non-blocking-settlement.md` | Per-call clocks | Timeout-as-detector is masking; settlement is event-driven, the only bound is operator intent | Complete |
| 10 | `tasks/10-parent-steer.md` | Parent→child steer | A queued follow-up races the running turn; stop-append-resubmit at the lifecycle gate | Complete |
| 11 | `tasks/11-durability.md` | Durable liveness + delivery | Settlement is durable, delivery and actives are not — one schema migration, not four bugs | Design |

Each doc carries its proof (commands, results, decisions) in its Status section.

Conventions: plain markdown, no frontmatter, evidence cited as `path:line`. No new tooling or deps introduced by docs work.
