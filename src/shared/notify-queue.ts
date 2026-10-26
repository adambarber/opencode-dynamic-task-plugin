// src/shared/notify-queue.ts — the durable queue of owed parent writes.
// The delivery record ledger is process memory, so a crash between "the task settled"
// and "the parent was told" left a record reading `completed` with no notice and no
// evidence one was owed. This queue is that missing evidence: an entry is written
// BEFORE the dial and retired only when the outcome is known, so a crash costs a
// duplicate notice, which is visible, instead of a silent deafness, which is not.
// At-least-once across a restart, exactly-once within a boot — deliberately.
// (docs/tasks/11-durability.md, M2)

import type { SessionId } from "./ids.js";
import { type LedgerChange, LedgerChangeKind } from "./ledger-change.js";
import { NotifyKind } from "./notification-text.js";
import { LogLevel, safeLog } from "./notify-log.js";
import type { ParentSession } from "./session-lifecycle.js";

/**
 * Who a delivery is for. The two records that carry a delivery each spelled this
 * triple out, and it is the triple owedIdentity hashes — so a field added here had
 * two declarations to reach and a third meaning to keep in step.
 */
export interface DeliveryTarget {
  parentSessionId: ParentSession;
  childSessionId: SessionId;
  kind: NotifyKind;
}

export interface PendingDelivery extends DeliveryTarget {
  /** The exact text owed. A redelivery must not have to reconstruct it. */
  text: string;
  /** How many attempts the boots before this one already spent. */
  attempts: number;
}

/**
 * A debt that can be DIALED: the same record, narrowed to a parent that exists.
 *
 * `PendingDelivery` answers "what is owed"; this answers "what can be sent". The
 * difference is one field — a parentless debt is retired and named rather than
 * dialed — and narrowing it by hand at each reader is a cast each reader gets to
 * disagree about, which is how a phantom session gets dialed. Named once, beside
 * the type it narrows, so the guard produces it and no reader rebuilds it.
 */
export type DeliverableDebt = PendingDelivery & { parentSessionId: SessionId };

/** Same bound as the in-memory record ledger: a bounded queue is a bounded file. */
const NOTIFY_LEDGER_MAX = 200;

const pendingDeliveries: PendingDelivery[] = [];
// Installed once at boot by the persistence dance. Tenet 9: process-global by
// design — every entry is keyed by a server-unique child session id.
let persistPending: ((changes: readonly LedgerChange[]) => void) | null = null;

// `null` is a legal argument, not an oversight: boot installs persistence once and
// the suite installs and REMOVES it, and a setter that cannot be undone makes every
// case after the installing one depend on it.
export function configurePendingPersistence(persist: ((changes: readonly LedgerChange[]) => void) | null): void {
  persistPending = persist;
}

export function getPendingDeliveries(): PendingDelivery[] {
  return [...pendingDeliveries];
}

/** Boot hydration: what the ledger owed becomes what this process owes. */
export function restorePendingDeliveries(entries: PendingDelivery[]): void {
  pendingDeliveries.length = 0;
  pendingDeliveries.push(...entries);
}

/**
 * The debt the gate writes down before dialing. The queue and the receipt are the
 * same owed write at two attempt counts, so it is assembled once here rather than
 * spelled out at the gate and again by whatever seeds a ledger.
 */
export function owedDelivery(target: DeliveryTarget, text: string, attempts: number): PendingDelivery {
  return { ...target, attempts, text };
}

// One owed write per gate claim: a settlement is identified by its kind, a notice by
// its text — exactly what the gate dedups notices on, so this reproduces the claim's
// identity without a second copy of the key. Two DIFFERENT notices are two debts.
/**
 * What makes two owed notices the SAME notice. Exported because the ledger merge has
 * to answer that too, and a second spelling of identity would let one notice be
 * written as two and dropped as one.
 */
export function owedIdentity(entry: PendingDelivery): string {
  return entry.kind === NotifyKind.Notice ? `${entry.childSessionId}\u0000notice\u0000${entry.text}` : `${entry.childSessionId}\u0000${entry.kind}`;
}

// "Is this one already owed, and where" — the single read both queue writers need,
// composed once so the pair cannot disagree about what identity means.
function indexOfOwedEntry(entry: PendingDelivery): number {
  return indexOfOwed(owedIdentity(entry));
}

/**
 * Make room for one more debt, and hand back the one dropped. A parent that refuses
 * every write owes a debt per notice, and the queue is DURABLE, so it is bounded at
 * the record ledger's size. The debt dropped is the one CLOSEST TO ITS BOUND: room for
 * a fresh debt is never made by dropping another fresh debt.
 */
function evictDebtRoomFor(entry: PendingDelivery): PendingDelivery | null {
  if (pendingDeliveries.length < NOTIFY_LEDGER_MAX) return null;
  let worstAt = 0;
  let [worst] = pendingDeliveries;
  for (let i = 1; i < pendingDeliveries.length; i++) {
    const candidate = pendingDeliveries[i];
    if (candidate !== undefined && worst !== undefined && candidate.attempts > worst.attempts) {
      worstAt = i;
      worst = candidate;
    }
  }
  if (worst === entry) return null;
  return pendingDeliveries.splice(worstAt, 1)[0] ?? null;
}

export const announceDropped = (dropped: PendingDelivery | null): void => {
  if (dropped === null) return;
  void safeLog(LogLevel.Warn, `Dynamic task plugin: the queue of undelivered notices is full, so a ${dropped.kind} notice owed to parent ${dropped.parentSessionId} ` +
    `for task ${dropped.childSessionId ?? "(root)"} was DROPPED after ${dropped.attempts} attempt(s). It will not be retried.`);
};

export function queuePending(entry: PendingDelivery): PendingDelivery | null {
  const at = indexOfOwedEntry(entry);
  if (at === -1) return queueNewDelivery(entry);
  pendingDeliveries[at] = entry;
  // The notice itself is the change, so the shared ledger is told which one was owed
  // rather than being handed this process's whole queue to re-serialize.
  persistPending?.([{ kind: LedgerChangeKind.Owed, record: entry }]);
  return null;
}

/** A delivery nothing was already owed for: it has to find room, possibly taking some. */
function queueNewDelivery(entry: PendingDelivery): PendingDelivery | null {
  // Evicted BEFORE the push, so the ledger hears about the loss in the same change
  // list as the debt that took the room — a queue and a ledger that disagree here
  // resurrect the dropped debt on the next boot.
  const dropped = evictDebtRoomFor(entry);
  pendingDeliveries.push(entry);
  const changes: LedgerChange[] = [{ kind: LedgerChangeKind.Owed, record: entry }];
  if (dropped !== null) changes.unshift({ kind: LedgerChangeKind.Delivered, record: dropped });
  persistPending?.(changes);
  return dropped;
}

export function dropPending(entry: PendingDelivery): void {
  const at = indexOfOwedEntry(entry);
  if (at === -1) return;
  pendingDeliveries.splice(at, 1);
  persistPending?.([{ kind: LedgerChangeKind.Delivered, record: entry }]);
}

function indexOfOwed(identity: string): number {
  return pendingDeliveries.findIndex((owed) => owedIdentity(owed) === identity);
}