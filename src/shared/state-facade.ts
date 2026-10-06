// src/shared/state-facade.ts
// Safe durable state: the ONE seam where a record crosses into or out of the host.
//
// The store owns the mechanism. This owns the two questions the mechanism cannot
// answer: is what came back a record, and did it all come back?

import { createHash } from "node:crypto";
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
/**
 * One record's outcome.
 *
 * `present` is separate from `value` for the same reason `dropped` is separate from
 * `records`: a document that was stored and could not be read has to be tellable
 * from one that was never written, or an operator whose caps silently stopped
 * applying has no way to find out why.
 */
export interface One<T> {
  dropped: boolean;
  incomplete: boolean;
  present: boolean;
  value: T;
}

export interface StateFacade extends Omit<Store, "load"> {
  /** The single record at `key`. See why this is not just `readAll` below. */
  readOne: <T>(key: string, guard: Guard<T>) => Promise<One<T>>;
  /**
   * Every record under `prefix`, each validated before it is returned. A record
   * that fails its guard is counted and withheld: handing a caller something it
   * did not check is how one bad record becomes a bad fleet.
   */
  readAll: <T>(prefix: string, guard: Guard<T>) => Promise<Read<T>>;
}

/** The one reader, so no caller re-implements validation against a raw scan. */
export function createStateFacade(store: Store): StateFacade {
  const readAll = async <T>(prefix: string, guard: Guard<T>): Promise<Read<T>> => {
    const scan = await store.load(prefix);
    const records = new Map<string, T>();
    let dropped = 0;
    for (const [key, raw] of scan.entries) {
      const value: unknown = typeof raw === "string" ? safeParse(raw) : raw;
      if (guard(value)) records.set(key, value);
      else dropped++;
    }
    return { dropped, incomplete: !scan.complete, records };
  };
  return {
    drop: (key) => store.drop(key),
    put: (key, value) => store.put(key, value),
    readAll,
    // A key IS a prefix of itself, so this is `readAll` with the fleet semantics taken
    // off — and, deliberately, with the same bound. A singleton read that reached the
    // host by another route would be the one read in this module with no deadline.
    readOne: async <T>(key: string, guard: Guard<T>): Promise<One<T>> => {
      const { dropped, incomplete, records } = await readAll(key, guard);
      const found = records.get(key);
      return { dropped: dropped > 0, incomplete, present: found !== undefined, value: found as T };
    },
    settled: () => store.settled(),
  };
}

/**
 * The address of one durable record.
 *
 * Callers supply the parts and never spell the shape: a missing separator, or a
 * prefix that is not a prefix, is the class of bug that surfaces only as "the record
 * I wrote is not there". Every part is digested because the parts include a directory,
 * and a path is not a record key — the host treats `/` as its own hierarchy and
 * readers scan by prefix, so a raw path would both split and over-match.
 */
export function recordKey(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}/${parts.map((part) => createHash("sha256").update(part).digest("hex")).join("/")}`;
}

/** A JSON parse that reports failure instead of throwing, because a bad record is data. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
