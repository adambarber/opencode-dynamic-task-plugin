/**
 * transient-resume.ts — the budget that makes silence honest.
 *
 * A transient failure is not reported to the parent; it is resumed. That is only
 * defensible because it is BOUNDED. An unbounded revival is not a recovery, it is
 * a loop: during the outage it was built for, an unbounded version resumes a
 * child forever, never reports it, and looks exactly like a fleet of children
 * working. The bound is the only thing standing between "handled quietly" and
 * "silently lost", so it lives in one named place and every decision to resume
 * asks this module.
 *
 * The count is on the record, not here, and it counts revivals rather than
 * automatic ones. Both decisions belong to the record: the count is a property of
 * a child, and it has to survive a restart to mean anything during an outage.
 *
 * ## What a resume is allowed to assume
 *
 * Not much. A resume re-claims a concurrency slot, so it may only happen where
 * the cap is known — `capSource` is REQUIRED rather than optional, and a caller
 * that has none does not get a weaker guarantee, it gets no resume. `agentCapacityRefusal`
 * treats a missing cap source as "no limit", which is the right reading for a
 * fresh dispatch that validated its own bounds and the wrong one here: a silent
 * revival that skipped the cap check would quietly spend budget the operator set,
 * which is the kind of thing nobody notices until the cap matters.
 */

//jscpd:ignore-start
import { FailureClass, classifyFailure } from "./failure-class.js";
import type { AgentCapSource } from "./caps.js";
import type { TaskState } from "./task-state.js";
import type { TaskStore } from "./store.js";
import { retainedFor } from "./settled-record.js";

//jscpd:ignore-end
/**
 * Automatic revivals a child may be given before the next transient failure is
 * reported instead. Two, not one: a single blip is the case this is for, and two
 * covers a retry that lands on a second blip, which on a flaky link is ordinary.
 * Beyond that the child is reporting, because by then the likeliest explanation
 * is not the network.
 *
 * A value, not a config: it bounds a failure mode (a hot loop during an outage)
 * rather than expressing an operator's preference, and a preference here would be
 * a number nobody sets correctly.
 */
export const TRANSIENT_RESUME_BUDGET = 2;

/**
 * Whether this settlement may be resumed silently instead of reported.
 *
 * Three things must hold, and each answers a different way this goes wrong:
 *
 *   1. it is genuinely a network/provider failure — a structural one is the
 *      parent's actual problem, and swallowing it would be the worst outcome
 *      available here rather than merely an unhelpful one;
 *   2. the child's budget has room — otherwise an outage turns into a loop;
 *   3. the cap is known — otherwise the revival re-claims a slot it cannot check.
 *
 * The record is read from the SETTLED half, because by the time this is asked the
 * settlement has already claimed the child and moved it there; the same claim is
 * what makes the read safe, since a task that was not ours to settle is not in
 * that half at all.
 */
export function transientResumeAvailable(
  store: TaskStore,
  childSessionId: string,
  verdict: TaskState,
  errorDetail: unknown,
  capSource: AgentCapSource | undefined,
): boolean {
  if (capSource === undefined) return false;
  if (classifyFailure(verdict, errorDetail) !== FailureClass.Transient) return false;
  const spent = retainedFor(store, childSessionId)?.transientResumes ?? 0;
  return spent < TRANSIENT_RESUME_BUDGET;
}
