/**
 * What a parent is TOLD — the words, apart from the gate that delivers them.
 *
 * The gate's facts are about a TURN: a turn ended, with this text, for this child.
 * They were once rendered as facts about the JOB ("Background task completed
 * successfully"), and that gap is where the corpus' hours went: a turn that ended
 * 46 seconds into a 62-minute run was announced as a finished task, and the
 * child's mid-thought prose, quoted under the heading "Latest output:", was read
 * as a heartbeat and as a death. So this module holds one rule and no others:
 * every sentence is a fact the plugin OBSERVED, or it is attributed to the child
 * and marked unverified, or it names the reader that does know.
 */

import { textBlock } from "./text-block.js";

// Push-path bound: the notification is injected into the parent's conversation, so
// it stays bounded — but truncation is never silent: the marker names the full-text
// recovery path (the pull path is untruncated).
export const NOTIFICATION_MAX_CHARS = 8000;

/**
 * The tool a child is offered to reach its parent.
 *
 * Named once because two facts depend on agreeing: the registry that registers it,
 * and the permission question that decides whether a child of a given agent is
 * allowed to call it. Those are one name, and a second spelling would let the plugin
 * offer a tool it then tested the child's access to under a different one.
 */
export const NOTIFY_TOOL = "task_notify";

/**
 * What a settlement or a mid-flight notice tells the parent, as an enum rather
 * than a string-literal union: a union invites `kind === "notice"`, and a raw
 * literal in a comparison is a rename that compiles clean. The member is the
 * value; the literal is only what the parent reads on the wire.
 *
 * It lives HERE, beside the wording and the field that carries it, so the
 * vocabulary of what a parent can be told is declared once with what a telling
 * looks like. The gate imports it from here — one direction — instead of the two
 * modules owning halves of one enum and importing each other.
 */
export enum NotifyKind {
  Completed = "completed",
  Error = "error",
  Blocked = "blocked",
  Notice = "notice",
}

/** Settlement (completed/error) and mid-flight voice (notice) carry distinct tags so orchestrators route them without parsing prose. */
const TEXT: Record<NotifyKind, { tag: string; header: string; bodyLabel: string; tail: string }> = {
  blocked: {
    bodyLabel: "What it needs (the child's own words)",
    header: "A turn of this background task ended on a question from the child, having delivered no result.",
    tag: "[dynamic-task-notify]",
    tail: "Answer with task_continue(session_id=...): the task is settled as blocked and runs again on your answer. If it cannot be answered, task_interrupt ends it.",
  },
  completed: {
    bodyLabel: "The child's last words in that turn (its own claim, not verified)",
    header: "A turn of this background task ended. Nothing here says whether the work is finished.",
    tag: "[dynamic-task-notify]",
    tail: "The store is the authority on what this task has produced: task_result(session_id=...) reads it.",
  },
  error: {
    bodyLabel: "The child's last words in that turn (its own claim, not verified)",
    header: "A turn of this background task ended with an error.",
    tag: "[dynamic-task-notify]",
    tail: "Read the task before treating this as a child failure: task_result(session_id=...), then task_continue(session_id=...) to retry.",
  },
  notice: {
    bodyLabel: "",
    header: "Message from a running child task (its own words, unverified):",
    tag: "[dynamic-task-notice]",
    tail: "task_continue(session_id=...) steers a running task — it replaces the child's current turn with yours. task_result(session_id=...) reads progress without disturbing it.",
  },
};

/** The tag a kind of parent notification carries — the routing contract, so an orchestrator needs not parse prose. */
export function notificationTag(kind: NotifyKind): string {
  return TEXT[kind].tag;
}

/**
 * The kind, as a FIELD rather than a tone of voice.
 *
 * The corpus spent its hours on this: parents told a success from a failure by the
 * REGISTER of the prose — "ended with an error" against a hopeful-sounding line —
 * and read a 46-second-old turn announced as a finished job. So the rendered
 * message states its own kind, and every reader (a host orchestrator, a parent
 * agent, and the tests) classifies on that field instead of guessing from wording.
 */
const KIND_FIELD = (kind: NotifyKind) => `Kind: ${kind}`;

// The kinds TEXT can answer, named once: iterating the enum's keys would
// need a cast, and a second spelling of the set would drift from TEXT.
export const NOTIFY_KINDS: readonly NotifyKind[] = [
  NotifyKind.Completed,
  NotifyKind.Error,
  NotifyKind.Blocked,
  NotifyKind.Notice,
];
export function notificationKindOf(text: string): NotifyKind | undefined {
  for (const kind of NOTIFY_KINDS) {
    if (text.includes(KIND_FIELD(kind))) return kind;
  }
  return undefined;
}

/**
 * Whether a parent-directed text is one of our notifications, by its tag. The tag IS
 * the routing contract, so anything that has to tell a notification from child work
 * asks here rather than retyping the two spellings. The mock transport routes on it,
 * which is why a marker that changed without this would have left every test
 * classifying its own notifications as child work and passing.
 */
export function isParentNotification(text: string): boolean {
  return Object.values(TEXT).some((shape) => text.includes(shape.tag));
}

export function formatParentNotification(
  state: {
    childSessionId: string;
    description: string;
  },
  kind: NotifyKind,
  resultText = "",
): string {
  const shape = TEXT[kind];
  // A turn that said nothing has no quote to print. The old stand-ins — "(completed)",
  // "(No text output)", "(error — no detail)" — read as CONTENT: corpus parents read
  // the literal "(completed)" as a five-instance death pattern and treated the raw
  // prose in its place as a status. So silence names the reader instead of wearing a
  // placeholder's clothes.
  const quoted = resultText.trim();
  const read = `task_result(session_id=${state.childSessionId})`;
  const body = quoted
    ? (shape.bodyLabel
      ? `${shape.bodyLabel}: ${truncatedForParent(quoted, state.childSessionId)}`
      : truncatedForParent(quoted, state.childSessionId))
    : `No text was captured from that turn. ${read} reads what the child actually said.`;
  return textBlock(
    shape.tag,
    KIND_FIELD(kind),
    shape.header,
    `Session: ${state.childSessionId}`,
    `Description: ${state.description}`,
    body,
    shape.tail || undefined,
  );
}

/** A cut quote must LOOK cut, and must name the child and the reader for the rest. */
function truncatedForParent(text: string, childSessionId: string): string {
  if (text.length <= NOTIFICATION_MAX_CHARS) return text;
  return `${text.slice(0, NOTIFICATION_MAX_CHARS)}... [truncated — the rest via task_result(session_id=${childSessionId})]`;
}