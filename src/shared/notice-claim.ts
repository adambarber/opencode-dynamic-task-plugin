// src/shared/notice-claim.ts
// What a mid-flight notice CLAIMS, and the advisory writers that record it.
//
// A notice claim is notification vocabulary that lives ON the store record: the
// settlement reads it to tell a blocked turn from a finished one. It lived in
// `task-state.ts` beside the lifecycle it never mutates — advisory metadata the
// read side may consult and no lifecycle transition reads — and that file
// outgrew the line cap. The writer funnel (`annotateActive`) stays where the
// lifecycle lives; these writers borrow it, they do not own a second one.

import { activeFor, annotateActive } from "./task-state.js";
import type { TaskStore } from "./store.js";
import type { ActiveTaskState } from "./task-state.js";

/**
/**
 * What a mid-flight notice CLAIMS about the child's own state. It rides the ONE
 * child→parent channel (no purpose-specific tool): `progress` is information,
 * `needs_input` is the child saying this turn cannot finish without the parent.
 * The claim is what the settlement reads, so a child that ends its turn blocked
 * is recorded as blocked — the alternative was reporting it as a success.
 *
 * An enum rather than a string-literal union, because a union invites `claim
 * === "needs_input"` and a raw literal in a comparison is a rename that compiles
 * clean and a value nobody updates. The member is the value; the string is only
 * what crosses the wire.
 */
export enum NoticeClaim {
  Progress = "progress",
  NeedsInput = "needs_input",
}

// The claims, as data: the tool validates its argument against this list, so an
// unrecognized claim is refused rather than quietly downgraded to progress — a
// typo'd `needs_input` would settle the child as a success.
export const NOTICE_CLAIMS: readonly NoticeClaim[] = Object.values(NoticeClaim);

/**
 * Is this a claim? A predicate rather than a list lookup behind a cast: the tool
 * receives `unknown` from the host, and a cast is a promise that someone else
 * checked. This is the check, and it narrows the value in the same breath.
 */
export function isNoticeClaim(value: unknown): value is NoticeClaim {
  return typeof value === "string" && Object.values<string>(NoticeClaim).includes(value);
}

// Notice announcements are recorded on the active entry by the gate module —
// advisory metadata, never a lifecycle mutation.
// The notice a turn declares, assembled once. The `claim` is what the settlement
// reads to tell a blocked turn from a finished one, so it is not optional in the
// record and this is the one place that says so.
export function noticeRecord(message: string, claim: NoticeClaim, at: number): ActiveTaskState["lastNotice"] {
  return { at, claim, message };
}

export function annotateNotice(store: TaskStore, childSessionId: string, message: string, claim: NoticeClaim): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.lastNotice = noticeRecord(message, claim, Date.now());
  });
}

/**
 * Whether this active task declared that its turn is ending blocked — the one
 * input to the settlement that separates "finished the work" from "cannot
 * finish without the parent".
 *
 * Scoped to the turn that made the declaration: a steer stamped AFTER the
 * declaration IS the answer, so the ending turn (which declared nothing) is
 * settled on its own claim. A turn replacement is the only boundary a record
 * has, and a revival produces a new record with no declaration at all.
 */
export function declaredBlocked(store: TaskStore, childSessionId: string): boolean {
  const active = activeFor(store, childSessionId);
  if (!active?.lastNotice || active.lastNotice.claim !== NoticeClaim.NeedsInput) return false;
  return active.lastNotice.at > (active.replacedAt ?? 0);
}

// Turn attribution (parent→child turn replacement): armed synchronously by
// task_continue before aborting the running turn, and by every revival, because
// a replaced turn's terminal copies can still be in flight. Advisory like a
// notice — the task stays active either way — so this pair may read and clear
// the stamps but never moves a lifecycle state.
export function markTurnReplacement(store: TaskStore, childSessionId: string): boolean {
  return annotateActive(store, childSessionId, (active) => {
    active.replacedAt = Date.now();
  });
}

/**
 * Drop turn attribution when the replacement never happened — the abort may not
 * have reached the server, so the ORIGINAL turn is still live and will show its
 * own life signs.
 */
export function clearTurnReplacement(store: TaskStore, childSessionId: string): boolean {
  const active = activeFor(store, childSessionId);
  if (!active || active.replacedAt === undefined) return false;
  delete active.replacedAt;
  return true;
}

