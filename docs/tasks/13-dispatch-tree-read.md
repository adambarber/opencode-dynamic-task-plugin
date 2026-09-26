# 13 — The Dispatch Tree Read

**Doctrine:** Tenet 11 (the degradation direction is "operator looks, then acts"), Tenet 12 (ground truth, not inference), Choke Point Theory. A dispatch is a tree; the fleet view was a list, and the shape was in the store the whole time.

## The hole, stated once

`task_list` printed one flat line per tracked task. The single fact an operator needs before stopping a runaway child — *is it a sibling or is it a grandchild?* — existed in the store (`parentSessionId`) and in no view. So the recovery from a runaway tree was: interrupt the one you can see, read the report, notice something else is still running, and repeat. The subtree stop ([12](12-subtree-interrupt.md)) removed the repetition; this is the read that shows what the repetition was hiding.

## Decisions (binding on the implementation)

- **The running fleet renders as the tree, and history stays flat.** A running task is kept with everything below it — a running grandchild does not make its parent vanish — and a settled task is kept ONLY when a running descendant needs it to hold its place. Settled leaves are dropped from the tree because the Retained section already lists them, so the view gains structure without gaining duplicates.
- **A severed parent link is named, never flattened.** Retention prunes finished records, so a running task's parent can be gone. Rendered flush, that task reads as a ROOT, and a root is a task whose parent nobody has stopped — the exact misreading that sends an operator at the wrong thing. The row carries `spawned by <id>, not tracked`.
- **The tree costs no host read.** The store already holds every edge. A view that spent one `session.status` call per row would turn one question into a burst of transport against a host that answers the whole fleet in one; the harness counts those reads, so "no fan-out" is asserted rather than assumed.
- **`Active: n/m` counts RUNNING rows, not rendered rows.** The tree can hold settled ancestors, so the count is passed beside the rows rather than recounted in the formatter — the number and the list cannot drift apart.
- **One walker.** `dispatchForest` (nested `DispatchNode`s) is the store's only idea of the shape; the stop (`subtreeTaskIds`) and this read are two questions about it. Edges are `parentSessionId`, never `lineage` (agent names). Both maps are walked, because a finished task is still the parent of something running. The walk terminates on a cycle that admission cannot produce but a hand-edited record file could, and any record left unplaced becomes a root of its own rather than going missing from the view.

## Choke point (all three components)

- **Primitive:** read the fleet as the shape it has.
- **Funnel:** `dispatchForest` in `task-state.ts` (the one walk) + `liveBranch` in `tools/read.ts` (the one "what is running" filter) + `formatTreeRow`/`formatTaskListSummary` in `task-formatting.ts` (the one rendering of depth and of a severed link). No new state, no new read, no new tool surface.
- **Enforcement:** the existing store-mutation invariants already cover the walk; the renderer's depth comes only from `DispatchNode.depth`, so indentation cannot be invented per call site.
- **Contract tests:** a grandchild is indented under its parent; a finished task is history, not tree; a pruned parent is named and the running child keeps its place; the view spends zero status reads; and at the formatter level, indentation and the severed-link wording are pinned where they are decided.

## Degradation

A cycle in a hand-edited store surfaces as extra roots rather than vanishing rows. A parent the plugin never tracked (another instance, a record from before this feature) is reported as untracked on the child's row. A wide agent set makes deeper trees and needs no change here.

## Litmus

An operator with one runaway task opens `task_list` once and can say which call to make.

## Status

**Complete** — 2026-09-26. Four new integration tests plus two formatter-level ones; full suite green, 0 clones, coverage gate green. Two-level fixtures are shared through the harness (`withDispatchTree`, `withSettledDispatchTree`) so the views and the stop cannot describe two different trees.
