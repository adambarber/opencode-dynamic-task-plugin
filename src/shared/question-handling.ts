// src/shared/question-handling.ts
// Question auto-answer policy (Task 04). A background child must never sit on a
// human prompt: a live child's question is answered with an option the host
// offered, a settled child's question is rejected, and a question that cannot be
// attributed to one of this plugin's tasks is never touched.
//
// Nothing here reads a host shape or spells a host field on its own. Event names
// and payloads come from src/shared/host-events.ts, and the question namespace is
// typed from the SDK in src/shared/client.ts — because the version of this file
// that read `question.created` and answered with `properties.answers` described
// a host that does not exist: opencode publishes `question.asked`, carrying
// `questions: QuestionInfo[]`, and routes replies to `/question/{requestID}`.

import { errorMessage } from "./session-lifecycle.js";
import { isEventRecord } from "./host-shape.js";
import { QUESTION_NO_ANSWER, QUESTION_SETTLED } from "./voice.js";
import type { OpenCodeClient } from "./client.js";

export type QuestionDecision =
  | { action: "reply"; answer: string }
  | { action: "reject"; reason: string };

export interface QuestionResult {
  succeeded: boolean;
  reason?: string;
}

// Pure decision, on what the host actually offered. `answer` is null when the
// gate has nothing to give: no options, or a multi-part ask the single-answer
// reply endpoint cannot satisfy (see host-events.AskedQuestion.answer).
//
// Both rejection reasons are operator voice (voice.ts), because each one is the
// only description of what can happen next — but note WHERE that text lands. The
// reject endpoint declares `body?: never`, so this gate cannot inject a reason
// into the asking session. The reason reaches the operator through the block
// claim the caller writes, and the child's own view is the host's rejection.
export function decideQuestion(
  taskState: "active" | "retained",
  answer: string | null,
): QuestionDecision {
  if (taskState === "retained") {
    return { action: "reject", reason: QUESTION_SETTLED };
  }
  if (answer === null || answer.length === 0) {
    return { action: "reject", reason: QUESTION_NO_ANSWER };
  }
  return { action: "reply", answer };
}

// Settlement transport: guards on inputs, and an "already resolved" answer
// (or a 404/409 race with a human) counts as success — the question closed,
// which is all the background task wanted. Reply and reject differ only in which
// host method they invoke and what body they send, so the guard and the failure
// meaning cannot drift apart between them.
function sendQuestionSettlement(questionId: string, send: () => Promise<unknown>): Promise<QuestionResult> {
  return send()
    .then(() => ({ succeeded: true }))
    .catch((error: unknown) => classifySettlementFailure(questionId, error));
}

function classifySettlementFailure(questionId: string, error: unknown): QuestionResult {
  const status = isEventRecord(error) ? (error as Record<string, unknown>).status : undefined;
  const message = errorMessage(error);
  if (status === 409 || /already (resolved|answered)|question not found|not found/i.test(message)) {
    return { succeeded: true, reason: "already_resolved" };
  }
  if (status === 404 || /no such question|missing/i.test(message)) {
    return { succeeded: true, reason: "already_resolved" };
  }
  return { succeeded: false, reason: `${questionId}: ${message}` };
}

export function replyToQuestion(client: OpenCodeClient, questionId: string, answer: string): Promise<QuestionResult> {
  if (!questionId || !answer) {
    return Promise.resolve({ succeeded: false, reason: "missing question id or answer" });
  }
  // The host routes /question/{requestID}/reply — `requestID`, not `id` — and
  // wants `answers`: one entry per asked question, each the list of chosen
  // labels. A bare `answer` string is silently the wrong shape.
  return sendQuestionSettlement(questionId, () =>
    client.question.reply({ path: { requestID: questionId }, body: { answers: [[answer]] } }),
  );
}

// No `reason` parameter: the reject endpoint accepts no body, so there is
// nothing to send one in. Callers that need the reason recorded log it there —
// which is also the only place it can honestly go.
export function rejectQuestion(client: OpenCodeClient, questionId: string): Promise<QuestionResult> {
  if (!questionId) {
    return Promise.resolve({ succeeded: false, reason: "missing question id" });
  }
  return sendQuestionSettlement(questionId, () =>
    client.question.reject({ path: { requestID: questionId } }),
  );
}
