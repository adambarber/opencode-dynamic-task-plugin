// The durable claim on a parent-owed write: the cross-instance half of the gate.
//
// The in-memory gate (notify-gate) settles who has been told what ONCE PER
// PROCESS, and that is exactly right — a process cannot deliver the same thing
// twice for its own race. What it cannot see is a SECOND opencode process on the
// same project: plugins load per server, the operator running two windows on one
// repo is ordinary (#3085), and the terminal event that ends a child is broadcast
// to every subscriber. So two processes each settle the same child, each claim it
// in their own memory, and each dial the parent — measured 2026-10-10, eight
// identical "Kind: completed" notices in eight milliseconds for one child.
//
// The host's own key/value store is the only cross-process arbiter the platform
// exposes: one SQLite table, per-key atomic upsert, shared by every process on the
// project. It has no compare-and-swap, so the claim is taken by write-then-re-read
// with a short quiescent pause — the same shape any storage without CAS requires.
// The marker is written BEFORE the write and left in place when it lands, so an
// instance that arrives later reads it and stands down; a failed write drops it so
// a retry can pass; a revival clears it so the child's next settlement is a fresh
// fact. The debt is still queued before the dial, so a crash costs at-least-once
// redelivery — the claim is what makes two LIVE processes exactly-once.

import { randomUUID } from "node:crypto";
import type { SessionId } from "./ids.js";
import { NotifyKind } from "./notification-text.js";

/** What one process leaves behind when it delivers: who, and when, and a token to verify. */
export interface DeliveryMark {
  at: number;
  token: string;
}

export function isDeliveryMark(value: unknown): value is DeliveryMark {
  if (typeof value !== "object" || value === null) return false;
  const mark = value as DeliveryMark;
  return typeof mark.token === "string" && typeof mark.at === "number";
}

/**
 * The durable side, as this module needs it: read one marker, write one, drop one,
 * and await the write chain. Keyed by the child and the delivery's own key, which
 * is what makes two settlements of one child the SAME claim — and the ledger owns
 * the key layout, so this module never spells a storage address.
 */
export interface DeliveryClaimStore {
  read: (childSessionId: SessionId, dedupKey: string) => Promise<DeliveryMark | null>;
  write: (childSessionId: SessionId, dedupKey: string, mark: DeliveryMark) => void;
  drop: (childSessionId: SessionId, dedupKey: string) => void;
  settled: () => Promise<void>;
}

// Process-global, like the gate it backs: one plugin instance, one store. Installed
// once at boot, and `null` is a legal value — a caller with no durable state keeps
// the in-memory gate's guarantee and nothing weaker.
let claimStore: DeliveryClaimStore | null = null;

export function configureDeliveryClaims(store: DeliveryClaimStore | null): void {
  claimStore = store;
}

/**
 * The dedup keys a SETTLEMENT uses, which is the kind itself: these are the writes
 * that are event-driven and therefore broadcast, so these are the ones a second
 * process races. A notice is delivered by the one process that serviced the child's
 * tool call, so it is not duplicated across instances and is left to the in-memory
 * gate's finer, per-text dedup.
 */
export const SETTLEMENT_DEDUP_KEYS: readonly string[] = [
  NotifyKind.Completed,
  NotifyKind.Error,
  NotifyKind.Blocked,
];

/**
 * How long a claimant waits before re-reading, so a competing write on the other
 * process has landed. The host is SQLite, where one commit is one round trip, so
 * this is a few times that; it delays only the delivery, which is already
 * fire-and-forget, and only for settlements — never the interactive notice path.
 */
const CLAIM_QUIESCENCE_MS = 20;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

/**
 * Take the durable claim on one parent-owed write.
 *
 * Returns true when this instance owns the write (it may dial) and false when
 * another instance already delivered it (it must stand down). With no store
 * configured it returns true, so a caller without durable state behaves exactly as
 * it did before this existed. The protocol, in order, is read → write → settle →
 * pause → re-read: the re-read is what makes the LAST committed claimant the single
 * winner, because two writers to one key cannot both see their own token last.
 */
export async function takeDeliveryClaim(childSessionId: SessionId, dedupKey: string): Promise<boolean> {
  const store = claimStore;
  if (store === null) return true;
  // Already delivered — by an earlier instance, or a boot that ran before this one.
  if ((await store.read(childSessionId, dedupKey)) !== null) return false;
  const mark: DeliveryMark = { at: Date.now(), token: randomUUID() };
  store.write(childSessionId, dedupKey, mark);
  await store.settled();
  await pause(CLAIM_QUIESCENCE_MS);
  const after = await store.read(childSessionId, dedupKey);
  return after !== null && after.token === mark.token;
}

/**
 * Free the claim on a write that did NOT land, so the queued debt can be offered
 * again — in this process or another. Deliberately separate from `take`: a
 * successful delivery keeps its mark, which is what makes a later instance stand
 * down rather than redeliver.
 */
export function releaseDeliveryClaim(childSessionId: SessionId, dedupKey: string): void {
  claimStore?.drop(childSessionId, dedupKey);
}

/**
 * Forget a child's settlement claims, for a revival: a child brought back to life
 * is a fresh settlement subject, so its next ending must be deliverable. The three
 * settlement keys are known, so this needs no enumeration — the property that lets
 * it stay synchronous inside the revival.
 */
export function forgetChildDeliveryClaims(childSessionId: SessionId): void {
  if (claimStore === null) return;
  for (const dedupKey of SETTLEMENT_DEDUP_KEYS) claimStore.drop(childSessionId, dedupKey);
}

/** Test seam: drop the configured store. Production installs one per boot. */
export function resetDeliveryClaims(): void {
  claimStore = null;
}
