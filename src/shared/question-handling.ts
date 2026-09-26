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

import { errorMessage } from "./host-shape.js";
import { isEventRecord } from "./host-shape.js";
import { QUESTION_NO_ANSWER, QUESTION_SETTLED } from "./voice.js";
import type { OpenCodeClient } from "./client.js";

/**
 * What answering a question amounts to. An enum rather than a string-literal
 * union, because the caller branches on it to choose which host method to
 * invoke — a raw literal in that branch is a rename that compiles clean and
 * silently answers the wrong way.
 */
export enum QuestionAction {
  Reply = "reply",
  Reject = "reject",
}

export type QuestionDecision =
  | { action: QuestionAction.Reply; answer: string }
  | { action: QuestionAction.Reject; reason: string };

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
    return { action: QuestionAction.Reject, reason: QUESTION_SETTLED };
  }
  if (answer === null || answer.length === 0) {
    return { action: QuestionAction.Reject, reason: QUESTION_NO_ANSWER };
  }
  return { action: QuestionAction.Reply, answer };
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

// A question that is already closed still counts as closed, and the host says so
// two different ways: 409 when a human or a race got there first, 404 when the
// question is gone from its table. Both are the outcome the background task
// wanted and both are ONE reason, so the recognizers are named side by side
// instead of spelled as two branches returning the same verdict — a branch that
// returns the same thing twice is a branch whose two conditions can be reasoned
// about separately and cannot.
const ALREADY_CLOSED: ReadonlyArray<{ status: number; says: RegExp }> = [
  { status: 409, says: /already (resolved|answered)|question not found|not found/i },
  { status: 404, says: /no such question|missing/i },
];

function classifySettlementFailure(questionId: string, error: unknown): QuestionResult {
  const status = isEventRecord(error) ? (error as Record<string, unknown>).status : undefined;
  const message = errorMessage(error);
  if (ALREADY_CLOSED.some(({ status: code, says }) => status === code || says.test(message))) {
    return { succeeded: true, reason: "already_resolved" };
  }
  return { succeeded: false, reason: `${questionId}: ${message}` };
}

// A settlement this gate never sent: asked to close a question it cannot even
// address. Named once so the refusal shape is one thing, and a caller that
// forgets the guard fails the same way every other refusal fails.
function unsent(reason: string): Promise<QuestionResult> {
  return Promise.resolve({ succeeded: false, reason });
}

/**
 * Answer a question on behalf of a child.
 *
 * The host routes /question/{requestID}/reply — `requestID`, not `id` — and wants
 * `answers`: one entry per asked question, each the list of chosen labels. A bare
 * `answer` string is silently the wrong shape.
 */
export function replyToQuestion(client: OpenCodeClient, questionId: string, answer: string): Promise<QuestionResult> {
  if (!questionId || !answer) return unsent("missing question id or answer");
  return sendQuestionSettlement(questionId, () =>
    client.question.reply({ path: { requestID: questionId }, body: { answers: [[answer]] } }),
  );
}

// No `reason` parameter: the reject endpoint accepts no body, so there is
// nothing to send one in. Callers that need the reason recorded log it there —
// which is also the only place it can honestly go.
export function rejectQuestion(client: OpenCodeClient, questionId: string): Promise<QuestionResult> {
  if (!questionId) return unsent("missing question id");
  return sendQuestionSettlement(questionId, () => client.question.reject({ path: { requestID: questionId } }));
}
