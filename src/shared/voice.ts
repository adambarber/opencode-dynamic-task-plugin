// Operator voice (shared): every word the tools return, in one place
// (Tenets 1, 7). Executors own decisions; they do not own wording — a change
// here is a change to the operator contract, reviewable in one diff, and the
// suite pins substrings of these so drift turns red.
// Explicitly OUT of scope: notification kind headers/tails (the notify gate's
// vocabulary), formatter renders (task-formatting), admission/config error
// builders (their funnels), and child prompt framing (prompt content, not
// operator voice). Centralize the primitive "words in tool results", not all
// strings everywhere.

import type { DependencyBlock } from "./admission.js";

// ─── Tool descriptions (inventory scanned in tools/index.ts) ─────────────

export const DYNAMIC_TASK_DESCRIPTION =
  "Spawn a subagent task. Returns immediately — the task never blocks this session. Its outcome arrives exactly once as a [dynamic-task-notify] message when it settles; the child can also send mid-flight [dynamic-task-notice] notices with task_notify. Inspect with task_result/task_status/task_list; steer a running child or revive a settled one with task_continue; stop it with task_interrupt.";

export const TASK_CONTINUE_DESCRIPTION =
  "Send a follow-up prompt to a tracked child session and return immediately. A running child is steered: its current turn is aborted and the message becomes its next turn, staying active. A settled child is revived for a fresh turn. Either way the next outcome arrives as a dynamic-task-notify message. Interrupted tasks are never revived — spawn a fresh dynamic_task instead. When the task settles mid-steer, the call revives it automatically unless interrupted; a turn that stays active with no outcome may have stalled — task_status shows activity, task_interrupt recovers. A revived turn may override the model; steers keep the task's model.";

export const TASK_NOTIFY_DESCRIPTION =
  "Send a message to the parent session while running: progress, findings, or a block needing parent input. This is a mid-flight notice, not a settlement — the task stays active and reports normally when it finishes. If you are blocked, say exactly what would unblock you; the parent can reply via task_continue. Notices arrive as [dynamic-task-notice], distinct from the [dynamic-task-notify] settlement tag. (Children spawned by dynamic_task only.)";

export const MODEL_ARG_DESCRIPTION =
  "Optional model override as providerID/modelID exactly as spelled in opencode.jsonc (e.g. \"nvidia/z-ai/glm-5.3\"). Bare ids are rejected at admission.";

export const TASK_RESULT_DESCRIPTION =
  "Fetch latest known child session result/status without sending a new prompt.";

export const TASK_INTERRUPT_DESCRIPTION =
  "Terminate a child session by request. The task settles as interrupted synchronously; its history is preserved. An interrupted child is not revived by task_continue — spawn a fresh dynamic_task instead.";

export const TASK_LIST_DESCRIPTION =
  "List all tracked tasks with their lifecycle states.";

export const TASK_STATUS_DESCRIPTION =
  "Detailed tracked state for one task without calling the API.";

// ─── Shared validation ───────────────────────────────────────────────────

export const INVALID_PROMPT = "ERROR: Invalid prompt. Must be a non-empty string.";

export const PROMPT_REQUIRED = "ERROR: prompt is required and must be a non-empty string.";

// The size bound lives beside the sentence that reports it: the number in the
// message and the number the gate compares are the same declaration.
export const MAX_PROMPT_CHARS = 100000;

export function promptTooLong(length: number): string {
  return `ERROR: Prompt too long (${length} chars). Max: ${MAX_PROMPT_CHARS}.`;
}

export const PERMISSION_DENIED = "ERROR: Permission denied.";

// ─── Spawn ───────────────────────────────────────────────────────────────

export function dependenciesPending(pending: DependencyBlock[]): string {
  return [
    `ERROR: Dependencies pending: ${pending.map((p) => `${p.id} (${p.state})`).join(", ")}.`,
    "Complete them first (unknown ids are treated as satisfied; depends_on_settled only waits for settlement).",
  ].join("\n");
}

export function createFailed(response: unknown): string {
  return `ERROR: Failed to create session. Response: ${JSON.stringify(response)}`;
}

export function spawnConfirmation(input: {
  agentName: string;
  childSessionId: string;
  model: string | null;
  parentSessionId: string | null;
}): string {
  const head = [
    `Spawned @${input.agentName} in background.`,
    `Session: ${input.childSessionId}`,
    `Model: ${input.model ?? "(default)"}`,
  ];
  if (input.parentSessionId) {
    return [
      ...head,
      `Async notification: enabled (parent ${input.parentSessionId})`,
      "The outcome arrives unprompted as a dynamic-task-notify message; use task_result to inspect progress meanwhile.",
    ].join("\n");
  }
  return [
    ...head,
    "Async notification: disabled (parent session ID not available in tool context)",
  ].join("\n");
}

export function agentGone(agentName: string): string {
  return `ERROR: Agent "${agentName}" not found.`;
}

// ─── Continue / steer ────────────────────────────────────────────────────

export function steerMissing(sessionId: string): { notify: string; report: string } {
  return {
    notify: `Steer failed: session "${sessionId}" not found on the server.`,
    report: `ERROR: Session "${sessionId}" not found — steer failed; task settled as error, history preserved.`,
  };
}

export function steerWonBySettler(sessionId: string, state: string): string {
  return `Session "${sessionId}" is gone on the server, but the task had already settled as ${state} — history preserved.`;
}

export function steerStateUnknown(sessionId: string): string {
  return `ERROR: steer failed for "${sessionId}"; task state unknown — history unavailable.`;
}

export function steerAutoRevived(sessionId: string, agentName: string, state: string): string {
  return `The task had settled as ${state} mid-steer, so it was revived and the message sent as a fresh turn. Follow-up sent to ${sessionId} (@${agentName}). The reply arrives as a dynamic-task-notify message.`;
}

export function steerSettledMidway(state: string): string {
  const remedy = state === "interrupted"
    ? "interrupted tasks are not revived — spawn a fresh dynamic_task instead"
    : "use task_continue to revive it for another turn";
  return `Message not sent: the task settled as ${state} while its turn was stopping; ${remedy}.`;
}

export function steerAbortFailed(abortError: string): string {
  return `ERROR: abort failed (${abortError}) — task left active; the running turn was not stopped, so no message was sent. Retry task_continue to steer again.`;
}

export function steerSent(sessionId: string, agentName: string): string {
  return `Steer sent to ${sessionId} (@${agentName}): the running turn was stopped and the message was sent as the next turn. The task stays active; its outcome arrives as a dynamic-task-notify message. If no outcome arrives, the turn stalled: check task_status, recover with task_interrupt.`;
}

export function descriptionTooLong(length: number): string {
  return `ERROR: Description too long (${length} chars). Max: 2000 — keep the label short; put detail in prompt.`;
}

export function untrackedSession(sessionId: string): string {
  return `ERROR: Session "${sessionId}" is not a tracked task. Use task_list to see tracked sessions, or dynamic_task to start a new one.`;
}

export function followupSent(childSessionId: string, agentName: string): string {
  return `Follow-up sent to ${childSessionId} (@${agentName}). The reply arrives as a dynamic-task-notify message.`;
}

// ─── Child notify ────────────────────────────────────────────────────────

export const CALLER_UNKNOWN = "ERROR: Unable to resolve the calling session.";

export const MESSAGE_REQUIRED = "ERROR: message is required.";

export function noticeTooLong(length: number): string {
  return `ERROR: message too long (${length} chars). Max: 4000 — this goes into the parent's conversation; summarize.`;
}

export const NOT_A_TRACKED_TASK =
  "ERROR: Not a tracked task. Child-to-parent messages route through the task ledger; only sessions spawned by dynamic_task can notify.";

export function alreadySettledNotice(state: string): string {
  return `Message not sent: the task already settled (${state}).`;
}

export const NOTICE_PARENTLESS =
  "Message recorded locally; this task has no parent session to deliver to.";

export const NOTICE_SENT = "Message sent to parent.";

export const NOTICE_DUPLICATE_SUPPRESSED =
  "Message not sent: this exact notice was already delivered (duplicate suppressed). Say something new and call task_notify again.";

export const NOTICE_PARENT_UNREACHABLE =
  "Message not sent: the parent did not acknowledge after 2 attempts. The notice is recorded locally; retry task_notify later.";

// ─── Interrupt ───────────────────────────────────────────────────────────

export function interruptUnknown(sessionId: string): string {
  return `ERROR: Session "${sessionId}" not found.`;
}

export function interruptAbortedUntracked(sessionId: string): string {
  return `Session ${sessionId} aborted (not a tracked task).`;
}

export function interruptAbortFailedActive(abortMessage: string): string {
  return `ERROR: abort failed (${abortMessage}) — task left active; its lifecycle events will still settle it. Retry task_interrupt to abort again.`;
}

export function interruptAbortFailedRetained(abortMessage: string): string {
  return `ERROR: abort failed (${abortMessage}) — task retained as interrupted; history preserved. Retry task_interrupt to abort again.`;
}

export function interruptAbortFailedSettled(abortMessage: string, state: string): string {
  return `ERROR: abort failed (${abortMessage}) — task already settled as ${state}; history preserved.`;
}

export function interruptServerGone(sessionId: string): string {
  return `ERROR: Session "${sessionId}" not found — history preserved.`;
}

export function interruptAlreadySettled(sessionId: string, state: string): string {
  return `Session ${sessionId} already settled as ${state}; abort sent to the server, history preserved.`;
}

export function taskInterrupted(sessionId: string): string {
  return `Session ${sessionId} interrupted.`;
}
