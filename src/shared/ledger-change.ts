// The ledger change vocabulary: what one process says it did, in the words the
// merge on the other side of a file read understands.
//
// Its own module because it is a contract between two halves that must not
// import each other to agree: the store and the notification gate both emit
// changes, the ledger merge consumes them, and the notification gate reads the
// merge. A vocabulary that lived in the merge's module would make one of those
// three edges a cycle.

//jscpd:ignore-start
import type { SessionId } from "./ids.js";
import type { PendingDelivery } from "./notify.js";
import type { ActiveTaskState, RetainedTaskState } from "./task-state.js";

//jscpd:ignore-end
/**
 * The discriminant of a ledger change, as an enum rather than a union of string
 * literals: the merge is the whole consumer of it, and a switch written against
 * raw literals is a switch a rename breaks without a type error.
 *
 * The WIRE values are the literals, so the on-disk format is unchanged. A change
 * carries `id` where it acts on a task and `record` where it owes or retires a
 * delivery, so the two spellings stay distinct arms rather than one arm with
 * fields that may be undefined.
 */
export enum LedgerChangeKind {
  Running = "running",
  Settled = "settled",
  Stopped = "stopped",
  Forgotten = "forgotten",
  Owed = "owed",
  Delivered = "delivered",
}

export type LedgerChange =
  | { readonly kind: LedgerChangeKind.Running; readonly id: SessionId; readonly record: ActiveTaskState }
  | { readonly kind: LedgerChangeKind.Settled; readonly id: SessionId; readonly record: RetainedTaskState }
  | { readonly kind: LedgerChangeKind.Stopped; readonly id: SessionId }
  | { readonly kind: LedgerChangeKind.Forgotten; readonly id: SessionId }
  | { readonly kind: LedgerChangeKind.Owed; readonly record: PendingDelivery }
  | { readonly kind: LedgerChangeKind.Delivered; readonly record: PendingDelivery };
