//jscpd:ignore-start
import { type DeliveryTarget } from "./notify-queue.js";

//jscpd:ignore-end
// src/shared/notify-records.ts — what the gate wrote down, once per write.
// The receipts: an operator opening a parent session sees these words, and a status
// view reads them to answer "was it told?" without re-dialing the host.
// Tenet 9: process-global — every key is a server-unique child session id, so two
// plugin instances cannot share one; only the bounded memory window is shared.
export interface NotificationRecord extends DeliveryTarget {
  at: number;
  message: string;
  attempts: number;
  delivered: boolean;
  // Set only on the duplicate-suppression path: a verbatim repeat that never
  // dialed — distinct from a failed delivery, where nothing was attempted.
  suppressed?: boolean;
  // The host HOLDS a write to a mid-turn parent rather than refusing it, so a held
  // request can outlive any parent's attention span: dialed, not yet answered.
  pending?: boolean;
  // The debt spent its budget and was WRITTEN OFF — the opposite promise to a failed
  // delivery, and what makes an unbounded redelivery loop a terminated one.
  expired?: boolean;
}

const notifyLedger: NotificationRecord[] = [];
const NOTIFY_LEDGER_MAX = 200;

/** How a write ended: the record's own outcome fields, picked rather than written out,
 * so a fourth outcome added to the record cannot silently miss the emit. */
export type DeliveryOutcome = Pick<NotificationRecord, "delivered" | "attempts" | "suppressed" | "pending" | "expired">;

export function notifyRecord(
  target: DeliveryTarget,
  message: string,
  outcome: DeliveryOutcome,
): NotificationRecord {
  return {
    ...target,
    at: Date.now(),
    attempts: outcome.attempts,
    delivered: outcome.delivered,
    message,
    ...(outcome.suppressed ? { suppressed: true } : {}),
    ...(outcome.pending ? { pending: true } : {}),
    ...(outcome.expired ? { expired: true } : {}),
  };
}

export function recordNotification(entry: NotificationRecord): void {
  notifyLedger.push(entry);
  if (notifyLedger.length > NOTIFY_LEDGER_MAX) notifyLedger.shift();
}

export function getLatestNotification(childSessionId: string): NotificationRecord | null {
  for (let i = notifyLedger.length - 1; i >= 0; i--) {
    const entry = notifyLedger[i];
    if (entry && entry.childSessionId === childSessionId) return entry;
  }
  return null;
}

// Turn-scoped read: a revived task is a new turn, so records older than its start
// belong to the previous turn. Same-ms records still show — harmless.
export function getTurnNotification(childSessionId: string, turnStartedAt: number): NotificationRecord | null {
  const latest = getLatestNotification(childSessionId);
  if (!latest || latest.at < turnStartedAt) return null;
  return latest;
}

export function clearDeliveryLedger(): void {
  notifyLedger.length = 0;
}
