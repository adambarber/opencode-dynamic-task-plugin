// src/shared/question-handling.ts
// Question auto-answer policy (Task 04). Background children must never sit
// on a human prompt: an active child's question is answered with the first
// suggestion, a settled child's question is rejected, and an unattributable
// question is never touched. The SDK `question` namespace lives beyond the
// generated client surface — it is typed via OpenCodeClient, not cast here.

import { eventField, eventString, errorMessage, isEventRecord, type SessionContext } from "./session-lifecycle.js";
import type { OpenCodeClient } from "./client.js";
import type { TaskStore } from "./task-state.js";

export interface QuestionTarget {
  questionId: string;
  childSessionId: string | null;
}

export type QuestionDecision =
  | { action: "reply"; answer: string }
  | { action: "reject"; reason: string };

export interface QuestionResult {
  succeeded: boolean;
  reason?: string;
}

const NO_ANSWER = "No suggestion available - background task cannot answer; steer with task_continue when it resumes";

// Pure decision: active children keep moving (first suggestion, recorded);
// settled children cannot answer and are closed explicitly.
export function decideQuestion(
  taskState: "active" | "retained",
  answers: string[],
): QuestionDecision {
  if (taskState === "retained") {
    return { action: "reject", reason: "This task has already settled. No response will be provided." };
  }
  const answer = answers[0];
  if (!answer) return { action: "reject", reason: NO_ANSWER };
  return { action: "reply", answer };
}

// SDK payloads vary: answers arrive as strings or single-field objects;
// accept non-empty values, drop the rest.
export function normalizeQuestionAnswers(raw: unknown): string[] {
  const answers: string[] = [];
  if (!Array.isArray(raw)) return answers;
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.length > 0) answers.push(item);
    } else if (isEventRecord(item)) {
      const value = eventString(item, ["text"])
        ?? eventString(item, ["value"])
        ?? eventString(item, ["answer"])
        ?? eventString(item, ["label"]);
      if (value) answers.push(value);
    }
  }
  return answers;
}

// Question ids arrive under varying field names across SDK payload shapes.
// Accepts either the full event (drills into properties) or bare properties.
export function getRequestIdFromQuestion(eventOrProperties: unknown): string | null {
  const properties = eventField(eventOrProperties, "properties") ?? eventOrProperties;
  return eventString(properties, ["id"])
    ?? eventString(properties, ["request_id"])
    ?? eventString(properties, ["task_id"])
    ?? eventString(properties, ["requestID"])
    ?? null;
}

export function isValidQuestionEvent(event: unknown): boolean {
  const type = eventString(event, ["type"]) ?? "";
  return type === "question.created" || type === "question.replied" || type === "question.rejected";
}

export function resolveQuestionSession(event: unknown, store: TaskStore): QuestionTarget | null {
  const properties = eventField(event, "properties");
  if (!isEventRecord(properties)) return null;

  const questionId = getRequestIdFromQuestion(event);
  if (!questionId) return null;
  // Remembered linkage first: the question id was tied to a child when the
  // created event arrived, so later events resolve even without session ids.
  const remembered = questionSessions.get(questionId);
  if (remembered) return { questionId, childSessionId: remembered };
  const candidate = eventString(properties, ["sessionID"])
    ?? eventString(properties, ["sessionId"])
    ?? eventString(properties, ["session_id"])
    // task_id doubles as an owner hint when a different field carried the
    // question id (see getRequestIdFromQuestion's priority chain).
    ?? (questionId !== eventString(properties, ["task_id"]) ? eventString(properties, ["task_id"]) : null)
    ?? null;
  // Attribution is bounded to this plugin's own tasks: a question from any
  // other session (including the operator's) passes through untouched.
  const tracked = candidate !== null
    && (store.activeTasks.has(candidate) || store.retainedTasks.has(candidate));
  return { questionId, childSessionId: tracked ? candidate : null };
}

// Settlement transport: guards on inputs, and an "already resolved" answer
// (or a 409/404 race with a human) counts as success — the question closed,
// which is all the background task wanted. Linkage is forgotten once the
// question no longer exists.
function settleQuestionError(questionId: string, error: unknown): QuestionResult {
  const status = isEventRecord(error) ? (error as Record<string, unknown>).status : undefined;
  const message = errorMessage(error);
  if (status === 409 || /already (resolved|answered)|question not found|not found/i.test(message)) {
    forgetQuestionSession(questionId);
    return { succeeded: true, reason: "already_resolved" };
  }
  if (status === 404 || /no such question|missing/i.test(message)) {
    forgetQuestionSession(questionId);
    return { succeeded: true, reason: "already_resolved" };
  }
  return { succeeded: false, reason: message };
}

export function replyToQuestion(client: OpenCodeClient, questionId: string, answer: string): Promise<QuestionResult> {
  if (!questionId || !answer) {
    return Promise.resolve({ succeeded: false, reason: "missing question id or answer" });
  }
  return client.question
    .reply({ path: { id: questionId }, body: { answer } })
    .then(() => ({ succeeded: true }))
    .catch((error: unknown) => settleQuestionError(questionId, error));
}

export function rejectQuestion(client: OpenCodeClient, questionId: string, reason: string): Promise<QuestionResult> {
  if (!questionId) {
    return Promise.resolve({ succeeded: false, reason: "missing question id" });
  }
  return client.question
    .reject({ path: { id: questionId }, body: { reason } })
    .then(() => ({ succeeded: true }))
    .catch((error: unknown) => settleQuestionError(questionId, error));
}

// question.asked carries no session id; correlate asked → replied.
// FIFO-capped: questions that never resolve (operator abandons the child)
// must not grow the map unboundedly; the oldest correlations are least
// likely to receive a late settlement event.
const QUESTION_CORRELATION_MAX = 256;
const questionSessions = new Map<string, string>();

export function rememberQuestionSession(questionId: string, childSessionId: string): void {
  questionSessions.set(questionId, childSessionId);
  if (questionSessions.size > QUESTION_CORRELATION_MAX) {
    const oldest = questionSessions.keys().next();
    if (!oldest.done) questionSessions.delete(oldest.value);
  }
}

export function forgetQuestionSession(questionId: string): void {
  questionSessions.delete(questionId);
}

export function resolveQuestionSessionId(ctx: SessionContext): string | null {
  return ctx.sessionID ?? ctx.sessionId ?? ctx.session_id ?? null;
}

export function _clearQuestionSessionsForTests(): void {
  questionSessions.clear();
}
