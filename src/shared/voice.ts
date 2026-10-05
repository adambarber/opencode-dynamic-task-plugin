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
import type { WaitRelease } from "./dispatch-wait.js";
import { TaskState } from "./task-state.js";
import { type AbortRefusal, AbortRefusalKind } from "./session-lifecycle.js";
import { textBlock } from "./text-block.js";

// ─── Tool descriptions (inventory scanned in tools/index.ts) ─────────────

export const DYNAMIC_TASK_DESCRIPTION =
  "Spawn a subagent task. Returns immediately — the task never blocks this session. Its outcome arrives exactly once as a [dynamic-task-notify] message when it settles; the child can also send mid-flight [dynamic-task-notice] notices with task_notify. Inspect with task_result/task_status/task_list; steer a running child or revive a settled one with task_continue; stop it with task_interrupt.";

export const TASK_CONTINUE_DESCRIPTION =
  "Send a follow-up prompt to a tracked child session and return immediately. A running child is steered: its current turn is aborted and the message becomes its next turn, staying active. A settled child is revived for a fresh turn. Either way the next outcome arrives as a dynamic-task-notify message. Interrupted tasks are never revived — spawn a fresh dynamic_task instead. When the task settles mid-steer, the call revives it automatically unless interrupted; a turn that stays active with no outcome may have stalled — task_status shows activity, task_interrupt recovers. A revived turn may override the model; steers keep the task's model.";

export const TASK_NOTIFY_DESCRIPTION =
  "Send a message to the parent session while running: progress, findings, or a block needing parent input. This is a mid-flight notice, not a settlement — the task stays active and reports normally when it finishes. Pass kind:\"needs_input\" when this turn cannot finish without the parent: say exactly what would unblock you, and the task settles as blocked rather than as a success, and the parent can answer with task_continue. Notices arrive as [dynamic-task-notice], distinct from the [dynamic-task-notify] settlement tag. (Children spawned by dynamic_task only.)";

export const MODEL_ARG_DESCRIPTION =
  "Optional model override as providerID/modelID exactly as spelled in opencode.jsonc (e.g. \"nvidia/z-ai/glm-5.3\"). Bare ids are rejected at admission.";

export const TASK_RESULT_DESCRIPTION =
  "Fetch latest known child session result/status without sending a new prompt.";

export const TASK_INTERRUPT_DESCRIPTION =
  "Stop a child session by request, and by default everything it spawned below it: the whole subtree is settled as interrupted synchronously, before any abort is sent, and the report names each task it acted on. Pass scope:\"self\" to stop that one session. Histories are preserved, and an interrupted child is not revived by task_continue — spawn a fresh dynamic_task instead.";

export const TASK_LIST_DESCRIPTION =
  "List all tracked tasks with their lifecycle states. Running tasks are shown as the tree they are — each indented under the task that spawned it — so a runaway child is recognizable as a grandchild; a task whose parent is no longer tracked says so instead of reading as a root.";

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
  return textBlock(
    `ERROR: Dependencies pending: ${pending.map((p) => `${p.id} (${p.state})`).join(", ")}.`,
    "Complete them first (unknown ids are treated as satisfied; depends_on_settled only waits for settlement).",
    "This dispatch is being held for you: when the last dependency clears, the plugin will say so here and you can send it again.",
  );
}

// What a settlement did to the dispatches that were waiting on it. The parent
// named each one, so it is named back — the plugin never invents an id the
// parent would have to learn, and the parent does not have to remember which of
// its refusals this settlement answers.
//
// The dependency clause is deliberately UNCOUNTED. It used to vary singular or
// plural on the number of RELEASED DISPATCHES, which is not what it describes: a
// single dispatch waiting on three dependencies was told "the dependency has
// completed", and a live smoke-test agent could not tell from that whether one
// edge had cleared or all of them. The release predicate already requires every
// dependency to be ready, so "everything it waited on has cleared" is both the
// truer sentence and the shorter one.
export function waitsReleasedBody(release: WaitRelease): string {
  return textBlock(
    release.ready.length > 0 ? `Your dispatch${release.ready.length === 1 ? "" : "es"} of ${release.ready.map((w) => `"${w.description}"`).join(", ")} can go now — everything it waited on has completed. Send the same dynamic_task call again.` : undefined,
    release.dead.length > 0 ? `Your dispatch${release.dead.length === 1 ? "" : "es"} of ${release.dead.map((w) => `"${w.description}"`).join(", ")} will never run: what it waited on finished without completing, and will not run again. Re-plan it against what did land, or drop the dependency.` : undefined,
  );
}

/**
 * The create response carried no session id.
 *
 * This is the one post-create failure the plugin cannot clean up. `session.abort`
 * needs an id, so a session that cannot be named cannot be aborted, registered,
 * notified, listed, or settled — it is left running on the server, and the ledger
 * has never heard of it. The post-create path below aborts precisely to prevent
 * that, and it cannot run here.
 *
 * So the sentence carries the two facts that make the orphan findable — the title
 * it was created under and the parent it was created for, which together are how
 * a session list is filtered — and admits the session may not exist at all, since
 * a host that fails the create outright can answer just as unparseably. The
 * first half of this message used to be the whole of it, and it reads as "nothing
 * happened": a parent told a create failed has no reason to go looking for a
 * child of its own that is running unmonitored, and silence about a possibly
 * running child is the failure this plugin's whole claim is about.
 */
export function createFailed(
  response: unknown,
  session: { title: string; parentSessionId: string | null },
): string {
  return textBlock(
    `ERROR: Failed to create session. Response: ${JSON.stringify(response)}`,
    `The host answered the create without a session id, so this session could not be registered, stopped, or reported on. A session may exist that nobody is tracking: look for the title "${session.title}"${session.parentSessionId === null ? "" : ` under parent ${session.parentSessionId}`}, and stop it by hand if it is there.`,
  );
}

export function spawnConfirmation(input: {
  agentName: string;
  childSessionId: string;
  model: string | null;
  parentSessionId: string | null;
  canNotify: boolean;
}): string {
  const head = [
    `Spawned @${input.agentName} in background.`,
    `Session: ${input.childSessionId}`,
    `Model: ${input.model ?? "(default)"}`,
  ];
  // One line, and it is here rather than nowhere because the parent is the one
  // who has to know: a child of this agent cannot declare that it is stuck, so a
  // task that hits a wall settles as `completed` and arrives looking like a
  // success. Warned, not refused — a read-only agent is a perfectly good worker
  // and the only thing it loses is its mid-flight voice. See `agentCanNotify`
  // for why the plugin cannot fix this by provisioning the tool.
  const noChannel = input.canNotify
    ? []
    : [
      `Warning: @${
         input.agentName
         }'s children have no task_notify, so it cannot report progress mid-run and cannot declare that it is blocked. If it hits something it cannot finish, it will say so in its final message and the task will still settle as completed — read that message before treating the outcome as a success.`,
    ];
  // ONE return, because the two cases differ by a line and not by a shape: an earlier
  // version branched into two near-identical arrays, which is two places to edit when the
  // wording moves and one place to forget. `enabled` decides the middle, the rest of the
  // message is the same whoever is reading it.
  const enabled = input.parentSessionId !== null;
  return [
    ...head,
    enabled
      ? `Async notification: enabled (parent ${input.parentSessionId})`
      : "Async notification: disabled (parent session ID not available in tool context)",
    ...(enabled
      ? ["The outcome arrives unprompted as a dynamic-task-notify message; use task_result to inspect progress meanwhile."]
      : []),
    ...noChannel,
  ].join("\n");
}

export function agentGone(agentName: string): string {
  return `ERROR: Agent "${agentName}" not found.`;
}

// Two facts, two voices. One function used to answer both with the post-create
// wording, so a create the host REFUSED — where no session existed, no id was
// returned, nothing was aborted and there was no history — reported three events
// that never happened. It had to be two: the id is exactly what tells them apart.
export function sessionLost(sessionId: string): string {
  return `ERROR: Session "${sessionId}" not found on the server — dispatch failed after create; the session was aborted, history preserved.`;
}

export function createRefusedMissing(parentSessionId: string): string {
  return `ERROR: Session "${parentSessionId}" not found on the server — the create was refused, so no child session was created.`;
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

export function steerSettledMidway(state: TaskState | "unknown"): string {
  const remedy = state === TaskState.Interrupted
    ? "interrupted tasks are not revived — spawn a fresh dynamic_task instead"
    : "use task_continue to revive it for another turn";
  return `Message not sent: the task settled as ${state} while its turn was stopping; ${remedy}.`;
}

export function steerAbortFailed(abortError: string): string {
  return `ERROR: abort failed (${abortError}) — task left active; the running turn was not stopped, so no message was sent. Retry task_continue to steer again.`;
}

/**
 * A steer aimed at the session doing the steering. A steer is an abort first, so
 * this refusal is what stands between a child and its own dead turn — and it says
 * the task is untouched, because that is the half the caller cannot see: the
 * running turn was NOT stopped and NO message was sent, so the task is exactly as
 * it was. A refusal that only said "refused" would leave a child believing its
 * parent had redirected it.
 */
export function steerSelfRefused(sessionId: string, refusal: AbortRefusal): string {
  if (refusal.kind === AbortRefusalKind.Self) {
    return `Refused: ${sessionId} is this session itself. A steer stops the running turn before sending, so steering this session would stop the turn doing the steering — nothing was stopped and no message was sent. To redirect your own work, just do it in this turn. To steer a child, name its session id from dynamic_task.`;
  }
  return `Refused: ${sessionId} is not a session this plugin dispatched, so it is not ours to stop — nothing was stopped and no message was sent. task_continue takes a child session id from dynamic_task.`;
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

// A claim the channel does not have is refused, not downgraded: a typo'd
// needs_input that silently became progress would settle a blocked child as a
// success, which is the whole failure this channel's vocabulary exists to stop.
export function noticeClaimRefused(value: string): string {
  return `ERROR: kind "${value}" is not a notice claim. Use kind: "progress" (default) or kind: "needs_input" (this turn cannot finish without the parent).`;
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

/**
 * What a child is told when a notice did not land, derived from the record.
 *
 * A function and not a sentence with a number in it, because the number used to
 * be a literal: a redelivery carrying five earlier attempts produces a record
 * that says 7, and the old string told the child "after 2 attempts" regardless.
 * A count the sender cannot trust is worse than no count at all — it is the one
 * number a child repeats back to its parent as an explanation.
 *
 * `expired` is answered here rather than falling through, and that is the point
 * of the function: it is the only place that decides what an undelivered record
 * means, so a call site that later redelivers with a carried count cannot reach
 * for words that promise a retry the plugin has already given up on.
 */
export function parentUndelivered(record: { attempts: number; expired?: boolean } | null | undefined): string {
  const attempts = record?.attempts ?? 0;
  if (record?.expired === true) {
    return `Message not sent: this notice was given up on after ${attempts} attempt(s) and will not be retried. The parent session is not accepting writes.`;
  }
  return `Message not sent: the parent did not acknowledge after ${attempts} attempt(s). The notice is recorded locally; retry task_notify later.`;
}

// A held write is the case the parent-facing record already learned to name
// honestly (05-notification-gate): the host puts the notification in the
// parent's context while the call it was dialed on is still open, so "not
// sent" is false the moment the parent has read it. Live-observed 2026-09-26 —
// a child read the failure text above for a notice already in the parent's
// transcript, and "retry task_notify later" is a standing duplicate-order: the
// retry is the duplicate. So the child gets the honest verdict and the
// instruction that actually protects it.
export const NOTICE_PENDING_ACK =
  "Message handed to the parent, which has not acknowledged it yet: the host is holding it " +
  "until the parent's current turn ends, and it will arrive without another call from you. " +
  "Do NOT send this notice again — a second call would duplicate a message already delivered.";

// ─── Question gate ───────────────────────────────────────────────────────

// What a child is told when nothing can answer its question. The child reads
// this as the only description of the way out, so it names a tool the child
// HOLDS and a claim it can make in this very turn — and it never says "when it
// resumes", which in a system whose spawn prompt says never wait is an
// instruction to stall. (The parent tool, task_continue, is the parent's.)
// Why a child's question was refused, and what the reader can do about it.
//
// The reader is the PARENT. This text used to be addressed to the child ("call
// task_notify, end your turn") — advice the child can never receive, since the
// host's reject endpoint declares `body?: never` and there is no channel from
// this gate into the asking session. So the parent, holding a tool the child
// does not, was told to use one it does not have. And it led with the
// diagnosis, which put the actionable half past the status view's 120-char
// truncation: the operator saw why, and not what to do.
//
// Hence: the parent's own remedy first, the diagnosis after. A status line that
// truncates is fine; a message that hides its own instruction behind the
// diagnosis is not.
export const QUESTION_NO_ANSWER =
  "task_continue the child with the input it needs, then it answers. " +
  "The plugin refused the child's question — the host offered no options and a background task has no human on the other end. " +
  "The child's turn ends without an answer, so unless the parent supplies input the task settles as blocked, not as a success.";

export const QUESTION_SETTLED =
  "This task has already settled. No response will be provided.";

// ─── Settlement ──────────────────────────────────────────────────────────
// (the verdict's wording used to live here, as a "(completed)" stand-in for a
// turn that said nothing. It is gone: the placeholders read as CONTENT in the
// corpus, and the renderer now owns "no text was captured" — so a verdict can no
// longer be laundered into a quote the child never spoke.)

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

// What an interrupt did to ONE task. The executor reports facts about a stop;
// this is that fact, before any prose — so a caller acting on a subtree can
// read one member's truth without parsing a sentence, and the sentences
// themselves stay in one place (interruptReport) whether there is one member or
// a tree of them.
export type InterruptOutcome =
  | { kind: "interrupted" }
  | { kind: "untracked" }
  | { kind: "gone" }
  | { kind: "server-gone" }
  | { kind: "already-settled"; state: string }
  | { kind: "abort-failed-active"; message: string }
  | { kind: "abort-failed-retained"; message: string }
  | { kind: "abort-failed-settled"; state: string; message: string };

// The voice for one member of an interrupt, whether it stands alone or heads a
// subtree report: same words, one function, so the two reports cannot drift
// into saying different things about the same outcome.
export function interruptReport(sessionId: string, outcome: InterruptOutcome): string {
  switch (outcome.kind) {
    case "interrupted": return taskInterrupted(sessionId);
    case "untracked": return interruptAbortedUntracked(sessionId);
    case "gone": return interruptUnknown(sessionId);
    case "server-gone": return interruptServerGone(sessionId);
    case "already-settled": return interruptAlreadySettled(sessionId, outcome.state);
    case "abort-failed-active": return interruptAbortFailedActive(outcome.message);
    case "abort-failed-retained": return interruptAbortFailedRetained(outcome.message);
    case "abort-failed-settled": return interruptAbortFailedSettled(outcome.message, outcome.state);
    default: throw new Error(`unhandled interrupt outcome: ${JSON.stringify(outcome satisfies never)}`);
  }
}

// A subtree stop is a ledger, not a sentence: every task the plugin acted on,
// each with its own truth, so a partial stop can never read as a clean one. A
// refused scope stops nothing at all and says so before the choices.
export function interruptSubtreeReport(
  rootSessionId: string,
  members: readonly { sessionId: string; outcome: InterruptOutcome }[],
): string {
  return textBlock(
    `Stopped ${members.length} task(s) in the subtree rooted at ${rootSessionId}:`,
    members.map(({ sessionId, outcome }) => `- ${interruptReport(sessionId, outcome)}`),
  );
}

export function interruptScopeRefused(value: string): string {
  return `ERROR: scope "${value}" is not a scope. Use scope: "subtree" (default — the task and everything below it) or scope: "self" (that session only).`;
}

/**
 * A stop the plugin will not send. One function for both refusals, because they
 * are the same event — the tool was aimed at something it may not touch — and two
 * sentences for the same event is how one of them grows a promise the other does
 * not keep.
 *
 * The words name the target and the reason, and for the self case the words are
 * the whole point: a caller that interrupted its own session and got back
 * "untracked" would have no way to know it had just described its own turn as a
 * stranger's. So the self sentence says *itself*, in those words, and the
 * untracked sentence says what to name instead.
 */
export function interruptStopRefused(sessionId: string, refusal: AbortRefusal): string {
  if (refusal.kind === AbortRefusalKind.Self) {
    return `Refused: ${sessionId} is this session itself. A session is not a task it can interrupt — nothing under it was reached. Name a child session id from dynamic_task to stop that one (and, by default, everything below it).`;
  }
  return `Refused: ${sessionId} is not a session this plugin dispatched, so it is not ours to stop and nothing was sent. task_interrupt takes a child session id from dynamic_task.`;
}
