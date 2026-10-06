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
//jscpd:ignore-start
import type { ActiveTaskState } from "./task-state.js";
import { agentKey } from "./caps.js";

//jscpd:ignore-end
/**
 * Running records to running tasks per agent, by folded key.
 *
 * A record's `agentName` is the host's spelling and a policy key is `agentKey`'s, so the
 * fold is what keeps an agent the host names `Explore` from reading as idle while its cap
 * is written under `explore` — undercounting a busy agent being the one direction of error
 * that never announces itself. One normalizer, on both sides, is the whole fix.
 *
 * THE FOLD IS ALSO WHY A TOTAL CAN BE TRUSTED. The cross-agent ceiling is judged against
 * `store.activeTasks.size` while its per-agent row is judged against this fold, and those
 * are two readings of one set — which holds because the fold has NO filter: every record
 * lands in exactly one bucket, so summing the buckets equals the size. It is worth saying
 * where it lives, because it used to be documented beside a `totalActiveOf` that summed
 * these buckets, had no callers, and claimed `checkAgentCapacity` read its number. That
 * function is pure and reads whatever it is handed. The guarantee is real; it was
 * undocumented where it is produced and attributed to a function that was not on the path.
 */
export function foldActiveByAgent(records: Iterable<ActiveTaskState>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = agentKey(record.agentName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
