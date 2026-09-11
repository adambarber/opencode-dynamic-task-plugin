// src/shared/question-handling.ts
// Question gate (Task 04) — the ONLY module that attributes child questions
// to tracked tasks and settles them. Resolve-then-validate: candidate owner
// ids are resolved from the event first, then checked against the task
// store in the same place. Fail-closed scoping: unattributable questions
// (including the operator's own) are never touched.
// ref:opencode-sdk-question — client.question API method signatures
// ref:opencode-sdk-events — event type definitions and property shapes
// ref:runtime-observation — production event payloads from session logs

import type { TaskStore } from "./task-state.js";
import type { OpenCodeClient } from "./client.js";
import { eventField, isEventRecord, errorMessage } from "./session-lifecycle.js";

export interface QuestionEvent {
  type: "question.created" | "question.replied" | "question.rejected";
  properties?: {
    id?: string;
    request_id?: string;
    task_id?: string;
    session_id?: string;
    answers?: Array<{ text?: string; value?: string }>;
    /** @deprecated Use `id` instead — kept for backward compatibility */
    requestID?: string;
    [key: string]: unknown;
  };
}

/**
 * Extract request ID from a Question event.
 * Priority chain: event.properties.id (primary) -> request_id -> task_id -> requestID (legacy)
 *
 * The `id` field is preferred because it uniquely identifies the question instance
 * for reply/reject API calls, while `request_id` may be a broader correlation scope.
 */
export function getRequestIdFromQuestion(event: unknown): string | null {
  const properties = eventField(event, "properties");
  if (!isEventRecord(properties)) return null;
  for (const key of ["id", "request_id", "task_id", "requestID"]) {
    const value = properties[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Verify that a raw event matches expected question event shape.
 * This is a runtime guard against SDK shape drift.
 */
export function isValidQuestionEvent(event: unknown): event is QuestionEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return (
    e.type === "question.created" ||
    e.type === "question.replied" ||
    e.type === "question.rejected"
  );
}

/**
 * Normalize question answers to a flat string array.
 * Handles: string items, { text, value } objects, null, undefined, and non-array inputs.
 */
export function normalizeQuestionAnswers(answers: unknown): string[] {
  if (!Array.isArray(answers)) return [];
  return answers
    .map((a: unknown): string => {
      if (typeof a === "string") return a;
      if (isEventRecord(a)) {
        const text = typeof a.text === "string" ? a.text : "";
        const value = typeof a.value === "string" ? a.value : "";
        return text || value;
      }
      return "";
    })
    .filter(Boolean);
}

/**
 * Shared idempotent-call core: runs the API call, absorbs already-resolved
 * (409 Conflict) as success, and never throws. Both reply and reject funnel
 * through here — one place owns the settlement semantics.
 */
async function invokeQuestionApi(
  call: () => Promise<unknown>,
): Promise<{ succeeded: boolean; reason?: string }> {
  try {
    await call();
    return { succeeded: true };
  } catch (err: unknown) {
    const reason = errorMessage(err);
    if (reason.includes("already resolved") || eventField(err, "status") === 409) {
      return { succeeded: true, reason: "already_resolved" };
    }
    return { succeeded: false, reason: reason || String(err) };
  }
}

// ─── Question→session linkage ──────────────────────────────────────
// Owned here (Tenet 5): resolution remembers it, replied/rejected forgets
// it. Never accessed directly outside this module.

const questionSessions = new Map<string, string>();

export function rememberQuestionSession(questionId: string, childSessionId: string): void {
  questionSessions.set(questionId, childSessionId);
}

export function forgetQuestionSession(questionId: string): void {
  questionSessions.delete(questionId);
}

// ─── resolveQuestionSession ──────────────────────────────────────────
// Resolve-then-validate gate. The question id uses the same priority chain
// as the API calls; owner candidates cover both casings, both nestings,
// and task ids — each validated against tracked tasks before use.
// Returns null only when the event carries no question id at all.
// A resolved-but-unknown childSessionId means "leave untouched".

export interface ResolvedQuestion {
  questionId: string;
  childSessionId: string | null;
}

const OWNER_KEYS = [
  "sessionID",
  "sessionId",
  "session_id",
  "task_id",
  "taskId",
] as const;

export function resolveQuestionSession(event: unknown, store: TaskStore): ResolvedQuestion | null {
  const questionId = getRequestIdFromQuestion(event);
  if (!questionId) return null;
  const properties = eventField(event, "properties");
  const data = eventField(event, "data");
  const props = isEventRecord(properties) ? properties : {};
  const payload = isEventRecord(data) ? data : {};

  const remembered = questionSessions.get(questionId);
  if (remembered) return { questionId, childSessionId: remembered };

  const candidates = [
    ...OWNER_KEYS.map((key) => props[key]),
    ...OWNER_KEYS.map((key) => payload[key]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      if (store.activeTasks.has(candidate) || store.retainedTasks.has(candidate)) {
        return { questionId, childSessionId: candidate };
      }
    }
  }

  return { questionId, childSessionId: null };
}

// ─── decideQuestion ──────────────────────────────────────────────────
// Deliberate degradation (Tenet 11), recorded per kind. Active children
// keep moving (first suggestion, recorded); nothing answerable or already
// gone gets a rejection with the recovery path; the caller never guesses.

export type QuestionDecision =
  | { action: "reply"; answer: string }
  | { action: "reject"; reason: string };

export function decideQuestion(kind: "active" | "retained", answers: string[]): QuestionDecision {
  if (kind === "retained") {
    return {
      action: "reject",
      reason: "This task timed out in the parent session. No response will be provided.",
    };
  }
  if (answers.length > 0) {
    const [first] = answers;
    if (first !== undefined) {
      return { action: "reply", answer: first };
    }
  }
  return {
    action: "reject",
    reason: "Background task — use task_continue for follow-up",
  };
}

/**
 * Idempotent reply to a question.
 * Silently succeeds if question is already resolved (409 Conflict).
 * Never throws — returns a result object.
 */
export async function replyToQuestion(
  client: OpenCodeClient,
  questionId: string,
  answer: string
): Promise<{ succeeded: boolean; reason?: string }> {
  if (!questionId || !answer) {
    return { succeeded: false, reason: "Missing questionId or answer" };
  }
  return invokeQuestionApi(() =>
    client.question.reply({
      path: { id: questionId },
      body: { answer },
    })
  );
}

/**
 * Idempotent rejection of a question.
 * Silently succeeds if question is already resolved.
 * Never throws — returns a result object.
 */
export async function rejectQuestion(
  client: OpenCodeClient,
  questionId: string,
  reason: string
): Promise<{ succeeded: boolean; reason?: string }> {
  if (!questionId) {
    return { succeeded: false, reason: "Missing questionId" };
  }
  return invokeQuestionApi(() =>
    client.question.reject({
      path: { id: questionId },
      body: { reason },
    })
  );
}
