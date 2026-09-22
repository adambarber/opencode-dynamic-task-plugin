// task_notify executor: the child's mid-flight voice. Advisory metadata on
// the active record, delivery through the gate — never a settlement.
import type { ToolContext } from "@opencode-ai/plugin";
import { isEventRecord, resolveParentSessionId } from "../shared/session-lifecycle.js";
import { notifyParent, formatParentNotification, noticeDedupKey } from "../shared/notify.js";
import { pruneRetainedTasks, findTask, annotateNotice } from "../shared/task-state.js";
import type { ToolDeps } from "./context.js";

export interface NotifyArgs {
  message?: unknown;
}

export async function executeTaskNotify(deps: ToolDeps, args: NotifyArgs, ctx: ToolContext): Promise<string> {
  const { client, store, config } = deps;
  const callerId = resolveParentSessionId(ctx);
  if (!callerId || callerId === "unknown") {
    return "ERROR: Unable to resolve the calling session.";
  }
  if (!isEventRecord(args) || typeof args.message !== "string" || !args.message.trim()) {
    return "ERROR: message is required.";
  }
  const message = args.message.trim();
  if (message.length > 4000) {
    return `ERROR: message too long (${message.length} chars). Max: 4000 — this goes into the parent's conversation; summarize.`;
  }

  pruneRetainedTasks(store, config);
  const task = findTask(store, callerId);
  if (!task) {
    return "ERROR: Not a tracked task. Child-to-parent messages route through the task ledger; only sessions spawned by dynamic_task can notify.";
  }
  if (task.state !== "active") {
    return `Message not sent: the task already settled (${task.state}).`;
  }

  annotateNotice(store, callerId, message);
  if (task.parentSessionId === "unknown") {
    return "Message recorded locally; this task has no parent session to deliver to.";
  }
  const parentMessage = formatParentNotification(
    { childSessionId: task.childSessionId, description: task.description },
    "notice",
    message,
  );
  const delivered = await notifyParent(client, task.parentSessionId, parentMessage, {
    childSessionId: task.childSessionId,
    kind: "notice",
    dedupKey: noticeDedupKey(message),
  });
  return delivered
    ? "Message sent to parent."
    : "Message not sent: an identical notice was already delivered (duplicate suppressed), or the parent was unreachable.";
}
