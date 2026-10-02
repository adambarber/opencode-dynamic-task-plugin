// Question gate dispatch (entry): attribute through the gate, then settle.
// Unattributable questions (including the operator's own) are never touched —
// the gate fails closed on ambiguity.
//
// Attribution is per-event and stateless: the host names the asking session on
// `question.asked`, so a correlation map across events is not needed and could
// only mis-attribute a reused id. The map this gate used to keep existed to
// bridge an `asked` event that carried no session id — a shape the host has
// never published.
import type { OpaqueHost } from "../shared/client.js";
import { annotateNotice, findTask, NoticeClaim, TaskState, type TaskIdentity, type TaskStore } from "../shared/task-state.js";
import { debugLog } from "../debug-logger.js";
import { isQuestionAsked, readAskedQuestion } from "../shared/host-events.js";
import { replyToQuestion, rejectQuestion, decideQuestion, QuestionAction } from "../shared/question-handling.js";

// One reporting tail for every rejection: a rejected question is logged by
// outcome and the tag names which arm of the gate refused it. Both rejection arms
// (a live child's failed auto-answer, a settled child's unanswered question)
// route through it, so the log vocabulary cannot drift between them. The
// rejection REASON is logged rather than sent — the host's reject endpoint takes
// no body, so a reason can only ever reach the operator here.
//
// The parent to tell is read off the record rather than passed beside it: a
// refusal reported to the wrong parent is the one mistake this tail cannot be
// asked to make twice, and a caller with a record in hand cannot get it wrong.
async function reportRefusal(
  host: OpaqueHost,
  asked: { questionId: string; sessionId: string },
  record: Pick<TaskIdentity, "parentSessionId">,
  arm: "question-auto" | "question-retained",
  reason: string,
): Promise<void> {
  const { questionId, sessionId } = asked;
  const result = await rejectQuestion(host, questionId);
  debugLog(record.parentSessionId, sessionId, `${arm}-${result.succeeded ? "rejected" : "reject-failed"}`, {
    questionId,
    reason,
    ...(result.succeeded ? {} : { failure: result.reason }),
  });
}

// True when this event was a question the gate consumed (caller returns).
// False for anything else (caller falls through to lifecycle handling).
export async function handleQuestionEvent(
  host: OpaqueHost,
  store: TaskStore,
  eventType: string,
  event: unknown,
): Promise<boolean> {
  if (!isQuestionAsked(eventType)) return false;

  const asked = readAskedQuestion(event);
  if (!asked) {
    debugLog("unknown", "unknown", "question-malformed", { type: eventType });
    return true;
  }
  const { questionId, sessionId, answer } = asked;
  // One reader, one preference. `findTask` already answers "is this one of ours"
  // and already resolves the only ambiguity there is — a session id in both halves
  // (a settled child that was revived) is the RUNNING one, because that is the
  // half whose turn can still end. Reaching into the two maps here restated that
  // preference in a call site, which is how it would come to disagree.
  const task = findTask(store, sessionId);

  if (task?.state === TaskState.Active) {
    const active = task;
    const decision = decideQuestion("active", answer);
    if (decision.action === QuestionAction.Reply) {
      const result = await replyToQuestion(host, questionId, decision.answer);
      if (result.succeeded) {
        debugLog(active.parentSessionId, sessionId, "question-auto-answered", {
          questionId,
          answer: decision.answer,
        });
        return true;
      }
      debugLog(active.parentSessionId, sessionId, "question-auto-answer-failed", {
        questionId,
        reason: result.reason,
      });
      await reportRefusal(host, asked, active, "question-auto", "Background task question auto-answer failed");
      return true;
    }
    // The gate just refused the child its question — nobody can answer, and the
    // child knows it. The plugin knows it too, so the refusal IS the needs_input
    // declaration, routed through the one claim funnel the child's own
    // task_notify would have used. Without this the block was visible only in
    // text the child never receives (the reject endpoint takes no body): a child
    // that ended its turn without re-declaring settled as a success. An
    // ANSWERED question records nothing — there the child kept moving.
    //
    // The claim IS the reason, with no wrapper: a preamble saying what the
    // reason already says only pushes the parent's remedy further out, and the
    // status view truncates.
    annotateNotice(store, sessionId, decision.reason, NoticeClaim.NeedsInput);
    await reportRefusal(host, asked, active, "question-auto", decision.reason);
    return true;
  }

  if (task !== null) {
    // A settled child cannot answer its own question, and its answer would be
    // worthless anyway — so the question is closed rather than left open.
    const decision = decideQuestion("retained", answer);
    if (decision.action === QuestionAction.Reject) {
      await reportRefusal(host, asked, task, "question-retained", decision.reason);
    }
    return true;
  }

  debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
  return true;
}
