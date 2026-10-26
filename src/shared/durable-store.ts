// src/shared/durable-store.ts
// The host's storage, as one store: per-key upserts, bounded, applied in order.
//
// The host keeps plugin records in its own SQLite table and `set` is one atomic
// upsert per key, so a record no longer needs a read-modify-write to be safe.

import type { StorageDomain } from "@opencode/plugin/promise/storage";
import type { StorageScanResult } from "@opencode/plugin/storage";
import { callHost, type OpaqueHost } from "./client.js";
import { READ_BOUNDS, WRITE_BOUNDS } from "./execution-bound.js";
import { errorMessage } from "./host-shape.js";

/** Whatever the host will store, derived from the host's own declaration. */
type StoredValue = Parameters<StorageDomain["set"]>[1];

/** The page a host answers with when its scan is finished: no rows, no cursor. */
const FINISHED_PAGE: StorageScanResult = { entries: [] };

// The host clamps a scan to 1..1000 and defaults to 100. Boot reads every record
// it is entitled to, so ask for the ceiling and pay one round trip per thousand.
const SCAN_PAGE = 1_000;
/** What a scan found, and whether it reached the end. An unreadable scan is not an empty one. */
interface Scan {
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

  // Applies enqueued for a key but not yet executed, timeout retries included:
  // each enqueue counts one and each execution spends its own. The count is what
  // a refusal consults before it gives a key up — see `apply`.
  const queued = new Map<string, number>();

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

  // One more attempt at a key goes on the chain. Counted, because the intent is
  // the obligation and the count is who is left holding it.
  const enqueueApply = (key: string): void => {
    queued.set(key, (queued.get(key) ?? 0) + 1);
    enqueue(() => apply(key));
  };

  const write = (key: string, value: StoredValue | null): void => {
    intent.set(key, value);
    enqueueApply(key);
  };

  // The whole point of `apply`: the chain advances on the DEADLINE so a host that
  // never answers cannot wedge every write behind one hung call, and last-write-wins
  // is restored afterwards rather than assumed.
  //
  // A host that REFUSES is a third answer, and the one that got left unwritten. A
  // rejection escaping here poisons the chain the next write waits on, so every later
  // write to every key fails with it and the plugin's view of durability becomes a lie
  // told to nobody. The refusal is therefore taken INSIDE the bound — one key, one
  // reason, given up rather than retried into the same answer.
  /** The give-up arm: the key is yielded only when no queued apply still serves its intent. */
  const refused = (key: string, why: string, queuedKeyLeft: boolean): void => {
    if (!queuedKeyLeft) intent.delete(key);
    onRefusal(`refused the write to ${key}: ${why}`);
  };

  /** This execution consumes its own count; the remainder is what a refusal may still find. */
  const consumeCount = (key: string): void => {
    const stillQueued = (queued.get(key) ?? 1) - 1;
    if (stillQueued > 0) queued.set(key, stillQueued);
    else queued.delete(key);
  };

  const apply = async (key: string): Promise<void> => {
    consumeCount(key);
    const wanted = intent.get(key) ?? null;
    const refusal = { why: null as string | null };
    const answer = await callHost(
      host,
      WRITE_BOUNDS.storage,
      async (context) => {
        try {
          return wanted === null ? await context.storage.remove(key) : await context.storage.set(key, wanted);
        } catch (error) {
          refusal.why = errorMessage(error);
          return undefined;
        }
      },
      null,
    );
    if (refusal.why !== null) {
      // The refusal gives up on THIS attempt, not on the key's obligation: the
      // intent is what the caller last asked the key to hold, and a newer write
      // queued behind this one re-attempts it on the next apply. Clearing the
      // intent here would turn that queued SET into a REMOVE — the refused write
      // would delete a NEWER write's intent, which is durable data lost in
      // silence. So the key is given up only when no queued apply is left to
      // serve the intent.
      refused(key, refusal.why, queued.has(key));
      return;
    }
    if (!answer.timedOut) return;
    onRefusal(`refused the write to ${key}: no answer in ${WRITE_BOUNDS.storage}ms`);
    void answer.finished.catch(() => {}).then(() => enqueueApply(key));
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