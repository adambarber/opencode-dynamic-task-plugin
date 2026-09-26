// Question gate dispatch (entry): attribute through the gate, then settle.
// Unattributable questions (including the operator's own) are never touched —
// the gate fails closed on ambiguity.
//
// Attribution is per-event and stateless: the host names the asking session on
// `question.asked`, so a correlation map across events is not needed and could
// only mis-attribute a reused id. The map this gate used to keep existed to
// bridge an `asked` event that carried no session id — a shape the host has
// never published.
import type { OpenCodeClient } from "../shared/client.js";
import { annotateNotice, type TaskStore } from "../shared/task-state.js";
import { debugLog } from "../debug-logger.js";
import { isQuestionAsked, readAskedQuestion } from "../shared/host-events.js";
import { replyToQuestion, rejectQuestion, decideQuestion } from "../shared/question-handling.js";

// One reporting tail for every rejection: a rejected question is logged by
// outcome and the log prefix names who owned the child. Both rejection arms (a
// live child's failed auto-answer, a settled child's unanswered question) route
// through it, so the log vocabulary cannot drift between them. The rejection
// REASON is logged rather than sent — the host's reject endpoint takes no body,
// so a reason can only ever reach the operator here.
async function reportAutoReject(
  client: OpenCodeClient,
  questionId: string,
  childSessionId: string,
  logParentSessionId: string,
  reason: string,
  logPrefix: string,
): Promise<void> {
  const result = await rejectQuestion(client, questionId);
  debugLog(logParentSessionId, childSessionId, `${logPrefix}-${result.succeeded ? "rejected" : "reject-failed"}`, {
    questionId,
    reason,
    ...(result.succeeded ? {} : { failure: result.reason }),
  });
}

// True when this event was a question the gate consumed (caller returns).
// False for anything else (caller falls through to lifecycle handling).
export async function handleQuestionEvent(
  client: OpenCodeClient,
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
  const active = store.activeTasks.get(sessionId);
  const retained = active ? undefined : store.retainedTasks.get(sessionId);

  if (active) {
    const decision = decideQuestion("active", answer);
    if (decision.action === "reply") {
      const result = await replyToQuestion(client, questionId, decision.answer);
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
      await reportAutoReject(
        client,
        questionId,
        sessionId,
        active.parentSessionId,
        "Background task question auto-answer failed",
        "question-auto",
      );
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
    annotateNotice(store, sessionId, decision.reason, "needs_input");
    await reportAutoReject(
      client,
      questionId,
      sessionId,
      active.parentSessionId,
      decision.reason,
      "question-auto",
    );
    return true;
  }

  if (retained) {
    // A settled child cannot answer its own question, and its answer would be
    // worthless anyway — so the question is closed rather than left open.
    const decision = decideQuestion("retained", answer);
    if (decision.action === "reject") {
      await reportAutoReject(
        client,
        questionId,
        sessionId,
        retained.parentSessionId,
        decision.reason,
        "question-retained",
      );
    }
    return true;
  }

  debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
  return true;
}
