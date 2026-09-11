// src/shared/question-handling.ts
// Question API integration for background task management.
// ref:opencode-sdk-question — client.question API method signatures
// ref:opencode-sdk-events — event type definitions and property shapes
// ref:runtime-observation — production event payloads from session logs

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
export function getRequestIdFromQuestion(event: QuestionEvent): string | null {
  return (
    event?.properties?.id ||
    event?.properties?.request_id ||
    event?.properties?.task_id ||
    event?.properties?.requestID ||
    null
  );
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
    .map((a: any) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") return a?.text || a?.value || "";
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
  } catch (err: any) {
    if (err?.message?.includes("already resolved") || err?.status === 409) {
      return { succeeded: true, reason: "already_resolved" };
    }
    return { succeeded: false, reason: err?.message || String(err) };
  }
}

/**
 * Idempotent reply to a question.
 * Silently succeeds if question is already resolved (409 Conflict).
 * Never throws — returns a result object.
 */
export async function replyToQuestion(
  client: any,
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
  client: any,
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
