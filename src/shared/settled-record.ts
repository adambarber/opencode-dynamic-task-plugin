// The settled record: what a finished child's history is, the one way to read it,
// and the one way to amend it.
//
// This is the boundary `task-state.ts` claims for itself in its "settled-record
// primitives" section and did not have. It exists because a settled record is the
// one thing in the store that is BOTH live state and durable fact: it is read by
// the tools, amended by the interrupt and settlement edges, and written to the
// ledger by a sink that will happily accept an empty change and discard it. Keeping
// the read, the amendment, and the change that carries it in one file is what makes
// "a retained record is only ever read here, changed there, and published once"
// checkable by reading one screen.

import { LedgerChangeKind, type LedgerChange } from "./ledger-change.js";
import { emitRetainedChange } from "./change-sinks.js";
import type { TaskStore } from "./store.js";
// Types only. The record shapes stay declared in `task-state` because they are
// the store's own vocabulary and a dozen modules import them by name; importing
// the ENUM as a type rather than a value is what keeps this file from forming a
// runtime cycle back through it.
import type { ActiveTaskState, TaskRecord, TaskRecordBase, TaskState } from "./task-state.js";
import type { FailureClass } from "./failure-class.js";

export interface RetainedTaskState extends TaskRecordBase {
  state: Exclude<TaskState, TaskState.Active>;
  retainedAt: number;
  abortError?: string | undefined;
  /**
   * Why the child failed, when it failed — `None` for a child that finished, and
   * absent for a record written before the field existed.
   *
   * Settled-only, so a revival drops it: a running child has no failure, and
   * carrying a stale class onto the new turn would have `task_list` reporting a
   * blip against work that is currently running.
   *
   * Durable rather than advisory. A parent that inspects a child after the fact
   * asks "was this the network or was this the work", and that question is still
   * answerable a week later; it is exactly the kind of claim a fresh process can
   * verify, so it belongs on disk.
   */
  failureClass?: FailureClass | undefined;
  // Last successful abort landing on this record. Guards withdrawInterruptClaim
  // against concurrent interrupts (F-R4): a stale claim never resurrects a
  // child a newer abort already killed. Transient bookkeeping, not ledger
  // truth — the reader drops it on load.
  lastAbortAt?: number | undefined;
}

/**
 * The settled (retained) record for a child, or undefined. One accessor because
 * "what is this child's settled record" is one question with one answer — and
 * because each call site wrote the lookup with its own idea of what an absent
 * record MEANS: one edge threw, one returned false, one built a refusal
 * sentence. The absence signal is declared once here; the policy that answers it
 * stays with the edge, because an internal rollback and a policy revival
 * genuinely disagree about a missing record.
 */
export function retainedFor(store: TaskStore, childSessionId: string): RetainedTaskState | undefined {
  return store.retainedTasks.get(childSessionId);
}

/**
 * Act on a settled record WITHOUT owing the file a change, because the change
 * is either transient (the reader drops it on load) or is published by the reclaim
 * the action performs. `decideRetained` below is the opposite contract, and the
 * two compose rather than each repeating the other.
 *
 * This is where "a record that is gone is a no-op" is decided. It used to be
 * restated at each of the three sites that read a settled record, which is three
 * chances to spell the absence signal differently.
 */
export function actOnSettled(
  store: TaskStore,
  childSessionId: string,
  act: (retained: RetainedTaskState) => boolean,
): boolean {
  const retained = retainedFor(store, childSessionId);
  if (retained === undefined) return false;
  return act(retained);
}

/**
 * The change that asserts a settled record. Declared once because it is a VALUE
 * and not a decision: two sites had spelled the same literal, and a change kind
 * that quietly stopped carrying its record would have been invisible in both.
 */
export const settledChange = (id: string, record: RetainedTaskState): LedgerChange => ({
  kind: LedgerChangeKind.Settled,
  id,
  record,
});

/**
 * The ONE way a settled record is AMENDED, for the amendments that are ledger
 * truth. All three halves are load-bearing and none is the caller's business: a
 * record that is gone must be a no-op, a decision that declines itself must not
 * publish, and the change that travels to the file must carry the record AS
 * AMENDED.
 *
 * That last half is the one this function was missing, and the omission was a
 * durable defect rather than a lost optimization: the late-outcome escalation
 * rewrote a recorded `completed` to `error` and published a change with no
 * record on it, so the plugin's own writer returned on the zero-length payload
 * and never wrote. The correction lived in memory and the next boot read the
 * success back off the disk.
 */
export function decideRetained(
  store: TaskStore,
  childSessionId: string,
  amend: (retained: RetainedTaskState) => LedgerChange | false,
): boolean {
  return actOnSettled(store, childSessionId, (retained) => {
    const change = amend(retained);
    if (change === false) return false; // the amendment declined itself
    emitRetainedChange(store, change);
    return true;
  });
}

/**
 * A record's failure class, or undefined when it has none.
 *
 * The field is settled-only, so every reader that wants it is holding a union of
 * the two record shapes and TypeScript cannot tell it which. Narrowing that in
 * the reader is the shape of a missing abstraction: the check gets written again
 * at the next call site, and the day one of them forgets, a class silently reads
 * as absent — which is the same false answer as no class at all.
 *
 * It lives here, beside the type that declares the field, and reaches the record
 * union by TYPE only: the body is pure, so the two files keep their existing
 * one-way dependency without this becoming a runtime edge.
 */
/**
 * The two motion clocks, for a record that may have settled.
 *
 * A `TaskRecord` is a running task OR a settled one, and only the running shape carries
 * them — so a reader holding the union cannot reach either field without this. It is the
 * same settled-safe accessor as `failureClassOf`, for the same reason: the knowledge that
 * a field belongs to one shape lives once, beside the shape, rather than at each reader
 * that has to guess.
 *
 * Two numbers rather than the resolved age, because the AGE is a judgement with a
 * threshold in it and belongs to the renderer; these are observations, and either can be
 * absent.
 */
export const motionClocksOf = (task: TaskRecord | null | undefined): { lastActivityAt?: number | undefined; lastNoticeAt?: number | undefined } =>
  task !== null && task !== undefined && "lastActivityAt" in task
    ? { lastActivityAt: (task as ActiveTaskState).lastActivityAt, lastNoticeAt: (task as ActiveTaskState).lastNotice?.at }
    : {};

export const failureClassOf = (task: TaskRecord | null | undefined): FailureClass | undefined =>
  task !== null && task !== undefined && "failureClass" in task
    ? (task as RetainedTaskState).failureClass
    : undefined;

/**
 * Stamp a successful abort landing on a retained record (F-R4): concurrent
 * interruptors observe it through `withdrawInterruptClaim`'s guard.
 *
 * Deliberately off `decideRetained`, and off the publishing path entirely:
 * `lastAbortAt` is transient bookkeeping the ledger reader drops on load by
 * design, so writing it would be a file write for a field that is not ledger
 * truth. `decideRetained`'s docblock says why it is not one of its amendments.
 */
export function noteAbortLanded(store: TaskStore, childSessionId: string): boolean {
  return actOnSettled(store, childSessionId, (retained) => {
    retained.lastAbortAt = Date.now();
    return true;
  });
}
