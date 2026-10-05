// src/shared/state-facade.ts
// Safe durable state: the ONE seam where a record crosses into or out of the host.
//
// The store owns the mechanism. This owns the two questions the mechanism cannot
// answer: is what came back a record, and did it all come back?

import { type Store } from "./durable-store.js";

/** One kind of record, and the check that says a value is one. */
export type Guard<T> = (value: unknown) => value is T;

/** A read's outcome. The three facts are separate because operators must tell them apart. */
export interface Read<T> {
  records: ReadonlyMap<string, T>;
  /** Records present but not the right shape: a discard someone has to be told about. */
  dropped: number;
  /** The host did not answer, so this is a PARTIAL read. Never call it an empty one. */
  incomplete: boolean;
}

/**
 * The facade IS the store, plus validated reads. Extending rather than restating
 * the three write methods is what makes "no caller bypasses the bound" true by
 * construction: a fourth writer added here would have nowhere to hide.
 */
export interface StateFacade extends Omit<Store, "load"> {
  /**
   * Every record under `prefix`, each validated before it is returned. A record
   * that fails its guard is counted and withheld: handing a caller something it
   * did not check is how one bad record becomes a bad fleet.
   */
  readAll: <T>(prefix: string, guard: Guard<T>) => Promise<Read<T>>;
}

/** The one reader, so no caller re-implements validation against a raw scan. */
export function createStateFacade(store: Store): StateFacade {
  return {
    drop: (key) => store.drop(key),
    put: (key, value) => store.put(key, value),
    readAll: async <T>(prefix: string, guard: Guard<T>): Promise<Read<T>> => {
      const scan = await store.load(prefix);
      const records = new Map<string, T>();
      let dropped = 0;
      for (const [key, raw] of scan.entries) {
        const value: unknown = typeof raw === "string" ? safeParse(raw) : raw;
        if (guard(value)) records.set(key, value);
        else dropped++;
      }
      return { dropped, incomplete: !scan.complete, records };
    },
    settled: () => store.settled(),
  };
}

/** A JSON parse that reports failure instead of throwing, because a bad record is data. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
