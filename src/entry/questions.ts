// Ask gate dispatch (entry): attribute through the gate, then deny.
// Unattributable asks (including the operator's own) are never touched —
// the gate fails closed on ambiguity.
//
// Attribution is per-event and stateless: the host names the asking session on
// `permission.asked`, so a correlation map across events is not needed and could
// only mis-attribute a reused id. A map this gate used to keep existed to bridge an
// `asked` event that carried no session id — a shape the host has never published.

import { debugLog } from "../debug-logger.js";
import type { OpaqueHost } from "../shared/client.js";
import { isHostAsked, readHostAsk } from "../shared/host-events.js";
import { sessionIdOf } from "../shared/ids.js";
import { annotateNotice, NoticeClaim } from "../shared/notice-claim.js";
import { decideAsk, denyAsk } from "../shared/question-handling.js";
import { findTask, type TaskIdentity, TaskState, type TaskStore } from "../shared/task-state.js";

// One reporting tail for every denial: a denied ask is logged by outcome and the tag
// names which arm of the gate refused it. The reason is logged rather than sent — the
// host's decision carries no body, so a reason can only ever reach the operator here.
//
// The parent to tell is read off the record rather than passed beside it: a refusal
// reported to the wrong parent is the one mistake this tail cannot be asked to make
// twice, and a caller with a record in hand cannot get it wrong.
async function reportRefusal(
  host: OpaqueHost,
  ask: { askId: string; sessionId: string },
  record: Pick<TaskIdentity, "parentSessionId">,
  arm: "ask-auto" | "ask-retained",
  reason: string,
): Promise<void> {
  const { askId, sessionId } = ask;
  const result = await denyAsk(host, sessionId, askId);
  debugLog(record.parentSessionId, sessionId, `${arm}-${result.succeeded ? "denied" : "deny-failed"}`, {
    askId,
    reason,
    ...(result.succeeded ? {} : { failure: result.reason }),
  });
}

// True when this event was an ask the gate consumed (caller returns).
// False for anything else (caller falls through to lifecycle handling).
export async function handleAskEvent(
  host: OpaqueHost,
  store: TaskStore,
  eventType: string,
  event: unknown,
): Promise<boolean> {
  if (!isHostAsked(eventType)) return false;

  const ask = readHostAsk(event);
  if (!ask) {
    debugLog("unknown", "unknown", "ask-malformed", { type: eventType });
    return true;
  }
  const { askId, sessionId } = ask;
  // One reader, one preference. `findTask` already answers "is this one of ours"
  // and already resolves the only ambiguity there is — a session id in both halves
  // (a settled child that was revived) is the RUNNING one, because that is the
  // half whose turn can still end. Reaching into the two maps here restated that
  // preference in a call site, which is how it would come to disagree.
  const task = findTask(store, sessionId);

  if (task?.state === TaskState.Active) {
    await annotateActiveRefusal(host, store, ask, task);
  } else if (task !== null) {
    // A settled child cannot answer its own ask, and its answer would be worthless
    // anyway — so the ask is closed rather than left open.
    await reportRefusal(host, ask, task, "ask-retained", decideAsk("retained"));
  } else {
    debugLog("unknown", "unknown", "ask-unmatched", { askId, type: eventType });
  }
  // Every disposition ends here: the ask was ours, and all three have consumed it.
  return true;
}

/**
 * The gate just refused the child, so nobody can answer and the child knows it.
 *
 * The plugin knows it too, so the refusal IS the needs_input declaration, routed
 * through the one claim funnel the child's own task_notify would have used. Without
 * this the block was visible only in text the child never receives: a child that
 * ended its turn without re-declaring settled as a success.
 *
 * The claim IS the reason, with no wrapper: a preamble saying what the reason
 * already says only pushes the parent's remedy further out.
 */
async function annotateActiveRefusal(
  host: OpaqueHost,
  store: TaskStore,
  ask: { askId: string; sessionId: string },
  active: Pick<TaskIdentity, "parentSessionId">,
): Promise<void> {
  const reason = decideAsk("active");
  const sid = sessionIdOf(ask.sessionId);
  if (sid === undefined) return;
  annotateNotice(store, sid, reason, NoticeClaim.NeedsInput);
  await reportRefusal(host, ask, active, "ask-auto", reason);
}