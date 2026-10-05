// src/shared/durable-store.ts
// The host's storage, as one store: per-key upserts, bounded, applied in order.
//
// The host keeps plugin records in its own SQLite table and `set` is one atomic
// upsert per key, so a record no longer needs a read-modify-write to be safe.

import { type OpaqueHost, callHost } from "./client.js";
import { READ_BOUNDS, WRITE_BOUNDS } from "./execution-bound.js";
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import type { StorageScanResult } from "@opencode/plugin/storage";
import { errorMessage } from "./host-shape.js";

/** Whatever the host will store, derived from the host's own declaration. */
export type StoredValue = Parameters<StorageDomain["set"]>[1];

/** The page a host answers with when its scan is finished: no rows, no cursor. */
const FINISHED_PAGE: StorageScanResult = { entries: [] };

// The host clamps a scan to 1..1000 and defaults to 100. Boot reads every record
// it is entitled to, so ask for the ceiling and pay one round trip per thousand.
const SCAN_PAGE = 1_000;

/** What a scan found, and whether it reached the end. An unreadable scan is not an empty one. */
export interface Scan {
  entries: ReadonlyMap<string, StoredValue>;
  complete: boolean;
}

export interface Store {
  /** Enqueue a durable write. Returns once it is QUEUED, never once it is stored. */
  put: (key: string, value: StoredValue) => void;
  /** Enqueue a durable removal, ordered against every write. */
  drop: (key: string) => void;
  /** Read every record under `prefix`, following the host's cursor to the end. */
  load: (prefix: string) => Promise<Scan>;
  /** The write chain, so a caller that must observe durability can await it. */
  settled: () => Promise<void>;
}

/** A refusal is reported where it happens; the chain only carries the failure. */
export function createStore(host: OpaqueHost, onRefusal: (what: string) => void): Store {
  // One chain for every key. Two writes to the same key racing would let an
  // earlier record land after a later removal, and the stale one would survive.
  let tail: Promise<void> = Promise.resolve();

  // What each key must END UP holding, kept because a bound reports without
  // cancelling: a write the plugin gave up on can still land later, and it would
  // restore a value the plugin has already moved past. One small entry per key,
  // which is why it is never pruned — it is the store's intent, not its content.
  const intent = new Map<string, StoredValue | null>();

  const enqueue = (work: () => Promise<void>): void => {
    // The catch is on the chain itself: a broken chain would strand every write
    // behind it, so one failure may never become everyone's failure.
    tail = tail.then(work).catch((error: unknown) => {
      onRefusal(`durable write failed: ${errorMessage(error)}`);
    });
  };

  const write = (key: string, value: StoredValue | null): void => {
    intent.set(key, value);
    enqueue(() => apply(key));
  };

  // The whole point of `apply`: the chain advances on the DEADLINE so a host that
  // never answers cannot wedge every write behind one hung call, and last-write-wins
  // is restored afterwards rather than assumed.
  const apply = async (key: string): Promise<void> => {
    const wanted = intent.get(key) ?? null;
    const answer = await callHost(
      host,
      WRITE_BOUNDS.storage,
      (context) => (wanted === null ? context.storage.remove(key) : context.storage.set(key, wanted)),
      null,
    );
    if (!answer.timedOut) return;
    onRefusal(`refused the write to ${key}: no answer in ${WRITE_BOUNDS.storage}ms`);
    void answer.finished.catch(() => {}).then(() => enqueue(() => apply(key)));
  };

  return {
    drop: (key) => write(key, null),
    load: async (prefix) => {
      const found = new Map<string, StoredValue>();
      let after: string | undefined = undefined;
      for (;;) {
        const page = await callHost(
          host,
          READ_BOUNDS.storage,
          // `after` is OMITTED rather than passed undefined: the host declares it
          // optional but not nullable, and the first page is a different request
          // from every page after it.
          (context) =>
            context.storage.scan(
              after === undefined ? { limit: SCAN_PAGE, prefix } : { after, limit: SCAN_PAGE, prefix },
            ),
          FINISHED_PAGE,
        );
        // A read that timed out returns what it already had, never a clean slate:
        // an empty ledger and an unreadable one must stay distinguishable.
        if (page.timedOut) {
          onRefusal(`refused the read of ${prefix}: no answer in ${READ_BOUNDS.storage}ms`);
          return { complete: false, entries: found };
        }
        for (const entry of page.value.entries) found.set(entry.key, entry.value);
        if (page.value.next === undefined) return { complete: true, entries: found };
        after = page.value.next;
      }
    },
    put: (key, value) => write(key, value),
    settled: () => tail,
  };
}