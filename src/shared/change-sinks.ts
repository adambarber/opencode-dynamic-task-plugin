// The two change publishers: the only code in the plugin that hands a change to
// a sink. Split out from the record accessors beside them because a publisher has
// no opinion about WHICH record a change is about — it is the one layer that is
// deliberately ignorant of settled versus running, which is what makes it possible
// to read and check it on its own.

import type { TaskStore } from "./store.js";
import type { LedgerChange } from "./ledger-change.js";

/**
 * The one retained-write funnel: it states WHAT moved, not the resulting map.
 *
 * `changes` is empty-able and `store.onRetainedChange` is optional, so a caller
 * can hand this an empty list and the call will succeed while the durable file
 * learns nothing — the plugin's own writer returns on a zero-length payload
 * before it writes. Every caller therefore passes the record it mutated rather
 * than a notification that it mutated one.
 */
export function emitRetainedChange(store: TaskStore, ...changes: LedgerChange[]): void {
  store.onRetainedChange?.(changes);
}

/**
 * The running set's publisher, named for symmetry with emitRetainedChange above —
 * and the symmetry is load-bearing, not cosmetic. The change is an ARGUMENT here,
 * so it is computed by the caller before this is called. The first version of this
 * encapsulation wrote `store.onActiveChange?.([store.markRunning(...)])` instead,
 * and the arguments of an optional call are not evaluated when the call is skipped:
 * the write stopped happening whenever nothing had installed an observer, so a
 * store with no durable writer attached silently stopped being a store. 47 tests
 * caught it, but only because they attach no observer. Passing the change in makes
 * the write unconditional by construction rather than by care.
 */
export function notifyRunning(store: TaskStore, ...changes: LedgerChange[]): void {
  store.onActiveChange?.(changes);
}
