// src/shared/question-handling.ts
// Ask settlement policy. A background child must never sit on a human prompt: a live
// child's ask is DENIED, a settled child's is denied, and an ask that cannot be
// attributed to one of this plugin's tasks is never touched.
//
// v2 replaced the free-text question with a PERMISSION: `permission.asked` carries
// `{id, sessionID, action, resources}` with no options and no labels, and the only
// answer the plugin API accepts is `permission.reply({decision: "once" | "always" |
// "reject"})`. So there is nothing left to auto-answer — a permission is a yes/no
// about a named action, not a question with a best choice.
//
// The single answer is DENY, and that is a decision rather than a leftover: allowing
// an action on a parent's behalf is a privilege the plugin was never granted, and
// denying is what this gate already did whenever it could not compute an answer. The
// refusal is still reported to the parent as the child's `needs_input`, so a child
// blocked this way stays visibly blocked instead of settling as a success.

import { errorMessage, isEventRecord } from "./host-shape.js";
import { QUESTION_NO_ANSWER, QUESTION_SETTLED } from "./voice.js";
import { callHost, hasPermissionReply, probeHost, type OpaqueHost, type OpenCodeClient } from "./client.js";
import { WRITE_BOUNDS } from "./execution-bound.js";

export interface QuestionResult {
  succeeded: boolean;
  reason?: string;
}

/**
 * Why this ask is refused, in operator voice, for the two cases there are.
 *
 * Declared once because both render sites used to say it and they drifted: they
 * agreed while the channel answered and could not agree about a failed one.
 */
export function decideAsk(taskState: "active" | "retained"): string {
  return taskState === "retained" ? QUESTION_SETTLED : QUESTION_NO_ANSWER;
}

/** Deny one ask. The only settlement this plugin makes, and the only verb it needs. */
export function denyAsk(host: OpaqueHost, sessionId: string, requestId: string): Promise<QuestionResult> {
  if (!sessionId || !requestId) return unsent("missing ask id or session id");
  if (!probeHost(host, hasPermissionReply)) return unsent("this host's context has no permission.reply");
  return sendDenial(host, requestId, (client) =>
    client.permission.reply({ sessionID: sessionId, requestID: requestId, decision: "reject" }),
  );
}

// Settlement transport: guards on inputs, and an "already resolved" answer
// (or a 404/409 race with a human) counts as success — the ask closed,
// which is all the background task wanted.
async function sendDenial(
  host: OpaqueHost,
  requestId: string,
  send: (client: OpenCodeClient) => Promise<unknown>,
): Promise<QuestionResult> {
  try {
    // Bounded like every other write, and for the same reason: the caller awaits this
    // to decide what happens to a child's turn. A timeout travels the throw path so the
    // failure is classified as one, rather than being a second kind of answer.
    const settled = await callHost(host, WRITE_BOUNDS.question, send, undefined);
    if (settled.timedOut) throw new Error(`ask denial unanswered after ${WRITE_BOUNDS.question}ms`);
    return { succeeded: true };
  } catch (error: unknown) {
    return classifyDenialFailure(requestId, error);
  }
}

// An ask that is already closed still counts as closed, and the host says so two
// different ways: 409 when a human or a race got there first, 404 when the ask is gone
// from its table. Both are the outcome the background task wanted and both are ONE
// reason, so the recognizers are named side by side instead of spelled as two branches
// returning the same verdict.
const ALREADY_CLOSED: ReadonlyArray<{ status: number; says: RegExp }> = [
  { status: 409, says: /already (resolved|answered|decided)|permission not found|not found/i },
  { status: 404, says: /no such (ask|permission)|missing/i },
];

function classifyDenialFailure(requestId: string, error: unknown): QuestionResult {
  const status = isEventRecord(error) ? (error as Record<string, unknown>).status : undefined;
  const message = errorMessage(error);
  if (ALREADY_CLOSED.some(({ status: code, says }) => status === code || says.test(message))) {
    return { succeeded: true, reason: "already_resolved" };
  }
  return { succeeded: false, reason: `${requestId}: ${message}` };
}

// A settlement this gate never sent: asked to close an ask it cannot even address.
// Named once so the refusal shape is one thing, and a caller that forgets the guard
// fails the same way every other refusal fails.
function unsent(reason: string): Promise<QuestionResult> {
  return Promise.resolve({ succeeded: false, reason });
}