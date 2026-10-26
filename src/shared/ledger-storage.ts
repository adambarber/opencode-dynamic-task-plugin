// src/shared/ledger-storage.ts
// The durable ledger, on the host's own per-key plugin storage.
//
// THE CHANGE, and why it is not a preference: the ledger used to be ONE file that
// every OpenCode process in a project re-read, merged and rewrote in full on every
// mutation. Two processes therefore alternated destroying each other's running-task
// records — each writing the whole file from its own in-memory view (#3078). The
// merge policy that papered over it could only preserve what a process had already
// seen, so the collision was structural, not a bug in the merge.
//
// Per-key storage removes the collision rather than managing it: two processes
// writing DIFFERENT children touch DIFFERENT keys, and neither reads the other's.
//
// THE ORDER RULE, which is what makes a partial application safe. Every write is a
// PUT before its matching DROP, so a refused write leaves the child in BOTH halves or
// in the half it already occupied — never in neither. `dropSettledShadows` reconciles
// "both halves" at the next load, and it already existed to defend against exactly
// that, so a refusal degrades into the contradiction the reader was built to settle
// rather than into a lost child.

import { createHash } from "node:crypto";
import { type DeliveryClaimStore, type DeliveryMark, isDeliveryMark, SETTLEMENT_DEDUP_KEYS } from "./delivery-claim.js";
import { isEventRecord } from "./host-shape.js";
import { type SessionId, sessionIdOf } from "./ids.js";
import { type LedgerChange, LedgerChangeKind } from "./ledger-change.js";
import { owedIdentity, type PendingDelivery } from "./notify.js";
import type { Read, StateFacade } from "./state-facade.js";
import {
  activeFrom,
  dropSettledShadows,
  durableActiveTask,
  isActiveEntry,
  isPendingDelivery,
  isRetainedEntry,
  retainedFrom,
} from "./task-ledger.js";
import type { ActiveTaskState, RetainedTaskState } from "./task-state.js";

/**
 * A record, as the host can hold it. The value is JSON TEXT rather than a structured
 * object, and that is not a retreat: `Storage.set` accepts `Schema.Json`, which has
 * no `undefined`, so a record whose optional fields are absent would need a cast to
 * claim otherwise. Text is what the old file held byte for byte, so a record written
 * by the previous build and one written by this build have the same shape, and the
 * facade already reads both encodings. The KEY is what the collision fix turned on.
 */
function stored(record: object): string {
  return JSON.stringify(record);
}

/**
 * The durable schema's version, held in ONE place because it is a value three
 * prefixes are built from. A future format reads a different root and therefore
 * cannot half-read this one — the property a version field inside a single document
 * had to earn, and which per-key storage gets from the key space instead.
 */
export const LEDGER_VERSION = 4;

const ROOT = `ledger/v${LEDGER_VERSION}`;

/**
 * The project dimension of every key. The host's storage namespace is scoped to
 * the PLUGIN, not the project, and the host loads one plugin instance per project
 * app-boot — so without a directory in the key, every project's boot restores every
 * other project's fleet, counts it against this project's concurrency caps, and
 * settles its children. The digest keeps a raw path out of the key: the host treats
 * `/` as hierarchy and readers scan by prefix, so a path would split and over-match.
 * Same directory, same digest — the merge contract between two processes on ONE
 * project (#3085) is preserved, because the key is a pure function of the directory.
 */
const projectSegment = (directory: string): string => createHash("sha256").update(directory).digest("hex");

/**
 * What each half is addressed under, asked for rather than spelled: a reader that
 * builds its own prefix from the key layout re-derives the layout, and then a bump to
 * the version is two changes instead of one. Absolute, per project: a fixture that
 * seeds a record must spell the key the WRITER spells it, which is this function.
 *
 * The v3 layout had NO project segment, so a v4 boot cannot see v3 records — they
 * belong to the abandoned host-wide namespace and are never adopted, which is the
 * migration: old cross-project ghosts age out of the retained TTL and the active
 * half is re-derived by each project's own boot.
 */
export const ledgerPrefixes = (directory: string): Record<"active" | "delivered" | "pending" | "retained", string> => {
  const root = ledgerRoot(directory);
  return {
    active: `${root}/active`,
    delivered: `${root}/delivered`,
    pending: `${root}/pending`,
    retained: `${root}/retained`,
  };
};

/**
 * The per-project roots the boot reads. One digest of the directory, shared by
 * every half: a project's whole ledger is one subtree of the namespace, and a
 * foreign project's subtree is unreachable from here by construction.
 */
export const ledgerRoot = (directory: string): string => `${ROOT}/${projectSegment(directory)}`;

/** An owed notice as it is held: the record, plus the clock that orders the queue. */
interface StoredNotice extends PendingDelivery {
  owedAt: number;
}

function isStoredNotice(value: unknown): value is StoredNotice {
  return isPendingDelivery(value) && typeof owedAtOf(value) === "number";
}

function owedAtOf(value: PendingDelivery): unknown {
  return isEventRecord(value) ? value.owedAt : undefined;
}

/**
 * Every key the ledger addresses, in one place, because a test that seeds a record
 * must spell the key the WRITER spells it: a fixture written against its own idea of
 * the layout would pass against a writer that moved, and fail against a real host.
 */
export const LEDGER_KEYS = {
  active: (directory: string, childSessionId: string): string =>
    `${ledgerRoot(directory)}/active/${childSessionId}`,
  // A settlement claim, keyed by the child and the delivery's own key: the child
  // scopes it so a revival can clear it by construction, and the digest bounds the
  // key because a notice's key carries its whole text.
  delivered: (directory: string, childSessionId: string, dedupKey: string): string =>
    `${ledgerRoot(directory)}/delivered/${childSessionId}/${createHash("sha256").update(dedupKey).digest("hex")}`,
  pending: (directory: string, identity: string): string =>
    `${ledgerRoot(directory)}/pending/${createHash("sha256").update(identity).digest("hex")}`,
  retained: (directory: string, childSessionId: string): string =>
    `${ledgerRoot(directory)}/retained/${childSessionId}`,
};

/**
 * The durable claim store, over the same validated facade the ledger uses.
 *
 * A function of its own rather than a method on the ledger store because the
 * ledger's language is task changes and this is about deliveries — but it is the
 * SAME facade, so a claim rides the same write chain and the same bound as every
 * other durable write, and the SAME project root: a claim is visible to every
 * process of THIS project, and to no other project's instance.
 */
export function createDeliveryClaimStore(facade: StateFacade, directory: string): DeliveryClaimStore {
  const keyAt = (childSessionId: SessionId, dedupKey: string): string => LEDGER_KEYS.delivered(directory, childSessionId, dedupKey);
  return {
    drop: (childSessionId, dedupKey) => facade.drop(keyAt(childSessionId, dedupKey)),
    read: async (childSessionId, dedupKey) => {
      const one = await facade.readOne(keyAt(childSessionId, dedupKey), isDeliveryMark);
      return one.present ? one.value : null;
    },
    settled: () => facade.settled(),
    write: (childSessionId, dedupKey, mark: DeliveryMark) => facade.put(keyAt(childSessionId, dedupKey), stored(mark)),
  };
}

/** What a boot read: the records, and what it could not say about them. */
interface LoadedLedger {
  active: Map<SessionId, ActiveTaskState>;
  /** Host-held values that were not records. Counted, never handed over. */
  dropped: number;
  /** The host did not answer, so this is a PARTIAL read. Never call it an empty one. */
  incomplete: boolean;
  pending: PendingDelivery[];
  retained: Map<SessionId, RetainedTaskState>;
}

export interface LedgerStore {
  load: () => Promise<LoadedLedger>;
  persist: (changes: readonly LedgerChange[]) => void;
}

/**
 * The child a key names, or null when the record disagrees with its own key. The
 * key is canonical identity here exactly as it was on disk: a record filed under
 * someone else's name is corrupt, not merely mislabelled, and admitting it would
 * restore one child under another's id.
 */
function childOf(prefix: string, key: string, childSessionId: string): SessionId | null {
  const id = sessionIdOf(childSessionId);
  return id !== undefined && key.startsWith(`${prefix}/`) && key.slice(prefix.length + 1) === id ? id : null;
}

/**
 * The ledger, over a validated facade, for ONE project directory. Refusals are
 * NOT reported here: the store underneath already reports every read and every
 * write it refuses, and a second reporter would put the same loss on two channels
 * with two different wordings.
 */
export function createLedgerStore(facade: StateFacade, directory: string): LedgerStore {
  /** When each notice was first owed, so a retry does not reorder the queue. */
  const owedAges = new Map<string, number>();
  let clock = Date.now();

  const readAll = async <T>(prefix: string, guard: (value: unknown) => value is T): Promise<Read<T>> => facade.readAll(prefix, guard);
  const prefixes = ledgerPrefixes(directory);

  return {
    load: async () => {
      const [active, retained, pending] = await Promise.all([
        readAll(prefixes.active, isActiveEntry),
        readAll(prefixes.retained, isRetainedEntry),
        readAll(prefixes.pending, isStoredNotice),
      ]);
      const running = new Map<SessionId, ActiveTaskState>();
      let dropped = 0;
      for (const [key, entry] of active.records) {
        const child = childOf(prefixes.active, key, entry.childSessionId);
        if (child === null) dropped++;
        else running.set(child, activeFrom(entry));
      }
      const settled = new Map<SessionId, RetainedTaskState>();
      for (const [key, entry] of retained.records) {
        const child = childOf(prefixes.retained, key, entry.childSessionId);
        if (child === null) dropped++;
        else settled.set(child, retainedFrom(entry));
      }
      const notices = [...pending.records];
      for (const [key, entry] of notices) {
        owedAges.set(key, entry.owedAt);
        clock = Math.max(clock, entry.owedAt);
      }
      // Oldest first, with the key as the tiebreak: two notices owed inside one
      // millisecond must still be delivered in one fixed order across boots.
      notices.sort((left, right) => left[1].owedAt - right[1].owedAt || left[0].localeCompare(right[0]));
      dropped += pending.dropped + active.dropped + retained.dropped;
      dropped += dropSettledShadows(settled, running);
      return {
        active: running,
        dropped,
        incomplete: active.incomplete || pending.incomplete || retained.incomplete,
        pending: notices.map(([, entry]) => entry),
        retained: settled,
      };
    },
    persist: (changes) => {
      for (const change of changes) apply(change);
    },
  };

  /** One change, as the key-level operations it means. PUT first, then DROP. */
  function apply(change: LedgerChange): void {
    switch (change.kind) {
      case LedgerChangeKind.Running: {
        facade.put(LEDGER_KEYS.active(directory, change.id), stored(durableActiveTask(change.record)));
        facade.drop(LEDGER_KEYS.retained(directory, change.id));
        break;
      }
      case LedgerChangeKind.Stopped:
        facade.drop(LEDGER_KEYS.active(directory, change.id));
        break;
      case LedgerChangeKind.Settled: {
        facade.put(LEDGER_KEYS.retained(directory, change.id), stored(change.record));
        facade.drop(LEDGER_KEYS.active(directory, change.id));
        break;
      }
      case LedgerChangeKind.Forgotten: {
        facade.drop(LEDGER_KEYS.retained(directory, change.id));
        // A forgotten child takes its settlement claims with it, so the markers stay
        // bounded by the retained history rather than growing with every task ever run.
        for (const dedupKey of SETTLEMENT_DEDUP_KEYS) facade.drop(LEDGER_KEYS.delivered(directory, change.id, dedupKey));
        break;
      }
      // One lookup for both, because what makes two notices the SAME notice is
      // `owedIdentity`, and the two differ only in which way they answer it.
      case LedgerChangeKind.Owed: {
        facade.put(LEDGER_KEYS.pending(directory, owedIdentity(change.record)), stored({ ...change.record, owedAt: owedAt(change.record) }));
        break;
      }
      case LedgerChangeKind.Delivered:
        facade.drop(LEDGER_KEYS.pending(directory, owedIdentity(change.record)));
        break;
    }
  }

  /** The age a notice keeps once it is owed again, so a retry cannot jump the queue. */
  function owedAt(record: PendingDelivery): number {
    return owedAges.get(LEDGER_KEYS.pending(directory, owedIdentity(record))) ?? clock;
  }
}