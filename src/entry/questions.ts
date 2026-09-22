// Question gate dispatch (entry): attribute through the gate, then settle.
// Unattributable questions (including the operator's own) are never
// touched — the gate fails closed on ambiguity.
import type { OpenCodeClient } from "../shared/client.js";
import type { TaskStore } from "../shared/task-state.js";
import { debugLog } from "../debug-logger.js";
import { eventField } from "../shared/session-lifecycle.js";
import {
  normalizeQuestionAnswers,
  replyToQuestion,
  rejectQuestion,
  resolveQuestionSession,
  getRequestIdFromQuestion,
  decideQuestion,
  rememberQuestionSession,
  forgetQuestionSession,
} from "../shared/question-handling.js";

// True when this event was a question the gate consumed (caller returns).
// False for anything else (caller falls through to lifecycle handling).
export async function handleQuestionEvent(
  client: OpenCodeClient,
  store: TaskStore,
  eventType: string,
  event: unknown,
): Promise<boolean> {
  if (eventType === "question.replied" || eventType === "question.rejected") {
    // Release uses getRequestIdFromQuestion's first-match spelling ladder
    // — the same ladder the created path keyed the linkage with, so a
    // reply carrying only request_id releases a request_id-keyed link.
    // A reply that spells the id differently from the create event finds
    // no entry to forget; the linkage lingers until a reply matches.
    const questionId = getRequestIdFromQuestion(event);
    if (questionId) {
      forgetQuestionSession(questionId);
    }
    return true;
  }
  if (eventType === "question.created") {
    const resolved = resolveQuestionSession(event, store);
    if (!resolved) {
      debugLog("unknown", "unknown", "question-missing-id", { type: eventType });
      return true;
    }
    const { questionId, childSessionId } = resolved;
    if (childSessionId === null) {
      debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
      return true;
    }
    const active = store.activeTasks.get(childSessionId);
    const retained = active ? undefined : store.retainedTasks.get(childSessionId);

    if (active) {
      rememberQuestionSession(questionId, childSessionId);
      const answers = normalizeQuestionAnswers(eventField(event, "properties", "answers"));
      const decision = decideQuestion("active", answers);
      if (decision.action === "reply") {
        const result = await replyToQuestion(client, questionId, decision.answer);
        if (result.succeeded) {
          debugLog(active.parentSessionId, childSessionId, "question-auto-answered", {
            questionId,
            answer: decision.answer,
          });
        } else {
          debugLog(active.parentSessionId, childSessionId, "question-auto-answer-failed", {
            questionId,
            reason: result.reason,
          });
          const rejectResult = await rejectQuestion(client, questionId,
            "Background task question auto-answer failed");
          if (!rejectResult.succeeded) {
            debugLog(active.parentSessionId, childSessionId, "question-auto-reject-failed", {
              questionId,
              reason: rejectResult.reason,
            });
          }
        }
      } else {
        const result = await rejectQuestion(client, questionId, decision.reason);
        if (!result.succeeded) {
          debugLog(active.parentSessionId, childSessionId, "question-auto-reject-failed", {
            questionId,
            reason: result.reason,
          });
        } else {
          debugLog(active.parentSessionId, childSessionId, "question-auto-rejected", {
            questionId,
          });
        }
      }
    } else if (retained) {
      rememberQuestionSession(questionId, childSessionId);
      const decision = decideQuestion("retained", []);
      if (decision.action === "reject") {
        const result = await rejectQuestion(client, questionId, decision.reason);
        if (!result.succeeded) {
          debugLog(retained.parentSessionId, childSessionId, "question-retained-reject-failed", {
            questionId,
            reason: result.reason,
          });
        } else {
          debugLog(retained.parentSessionId, childSessionId, "question-retained-rejected", { questionId });
        }
      }
    } else {
      debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
    }
    return true;
  }
  return false;
}
