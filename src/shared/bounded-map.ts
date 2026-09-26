/**
 * Keep a map bounded by its own insertion order: drop the oldest entries until
 * it is back inside the limit.
 *
 * "Oldest" is not a clock here — it is the first key the map still holds, which
 * is why this needs no timestamp and cannot be wrong about a clock it does not
 * run. A bounded map in this plugin is a courtesy ledger to a live parent, not a
 * history: the entry that goes is the one least likely to still be wanted, and
 * losing it is visible (a duplicate notice, a re-queued dispatch) rather than
 * silent.
 *
 * Both bounded maps spelled the eviction by hand, and they disagreed about its
 * shape — one looped, one evicted a single entry and trusted the map to have
 * grown by one. Same decision, two shapes, and a reader could not tell whether
 * the difference was intended. It was not: a map that grew by one is inside the
 * limit after one drop, so the loop is equivalent and there is now one shape.
 */
export function evictOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
