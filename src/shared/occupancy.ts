/**
 * src/shared/occupancy.ts
 * How many tasks are running, by agent — the ONE fold, over records rather than a store.
 *
 * It was two functions in `task-state.ts`, each looping over `store.activeTasks`, and a
 * TUI that wanted the same number had nowhere to go. The TUI is a different process from
 * the one that owns the tasks: it has no store, only the ledger the store is itself
 * hydrated from. A fold that requires a `TaskStore` therefore left that surface free to
 * invent its own predicate for "running" — and a corner counting three children beside a
 * capacity gate that has counted two is two answers to one question, with no screen able
 * to say which is right.
 *
 * So the rule takes RECORDS. Both callers hand it the set they already hold: the server
 * the store's running half, the TUI the ledger's. The dependency runs the way it does
 * everywhere else here — inward, and across as data — and the only thing this module needs
 * to know about a task is the one field the count is keyed on.
 *
 * `ActiveTaskState` is a TYPE import, and it is a cycle with `task-state.ts` that is
 * sound in one direction only: this module names the type and never the class, exactly as
 * `store.ts` names the same type while `task-state` names the class. `verbatimModuleSyntax`
 * is what keeps the edge from becoming a runtime one.
 */
import { agentKey } from "./caps.js";
import type { ActiveTaskState } from "./task-state.js";

/**
 * Running records to running tasks per agent, by folded key.
 *
 * A record's `agentName` is the host's spelling and a policy key is `agentKey`'s, so the
 * fold is what keeps an agent the host names `Explore` from reading as idle while its cap
 * is written under `explore` — undercounting a busy agent being the one direction of error
 * that never announces itself. One normalizer, on both sides, is the whole fix.
 */
export function foldActiveByAgent(records: Iterable<ActiveTaskState>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = agentKey(record.agentName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Running tasks across EVERY agent — the number the cross-agent ceiling is judged against,
 * and the numerator of the TUI's counter.
 *
 * Summed from the fold rather than from the size of whatever set was handed over, so the
 * total and the per-agent rows on `task_list` cannot be two different counts of the same
 * set. `checkAgentCapacity` reads `totalActive` off the same pair, which is what makes a
 * ceiling refusal and a gauge reading the same measurement.
 */
export function totalActiveOf(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}
