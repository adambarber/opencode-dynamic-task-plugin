// task_notify executor: the child's mid-flight voice. Advisory metadata on
// the active record, delivery through the gate — never a settlement.
import type { ToolContext } from "@opencode-ai/plugin";
import { isEventRecord, resolveParentSessionId } from "../shared/session-lifecycle.js";
import { notifyParent, formatParentNotification, noticeDedupKey } from "../shared/notify.js";
import { pruneRetainedTasks, findTask, annotateNotice } from "../shared/task-state.js";
import type { ToolDeps } from "./context.js";
import {
  CALLER_UNKNOWN,
  MESSAGE_REQUIRED,
  noticeTooLong,
  NOT_A_TRACKED_TASK,
  alreadySettledNotice,
  NOTICE_PARENTLESS,
  NOTICE_SENT,
  NOTICE_UNSENT,
} from "../shared/voice.js";

export interface NotifyArgs {
  message?: unknown;
}

export async function executeTaskNotify(deps: ToolDeps, args: NotifyArgs, ctx: ToolContext): Promise<string> {
  const { client, store, config } = deps;
  const callerId = resolveParentSessionId(ctx);
  if (!callerId || callerId === "unknown") {
    return CALLER_UNKNOWN;
  }
  if (!isEventRecord(args) || typeof args.message !== "string" || !args.message.trim()) {
    return MESSAGE_REQUIRED;
  }
  const message = args.message.trim();
  if (message.length > 4000) {
    return noticeTooLong(message.length);
  }

  pruneRetainedTasks(store, config);
  const task = findTask(store, callerId);
  if (!task) {
    return NOT_A_TRACKED_TASK;
  }
  if (task.state !== "active") {
    return alreadySettledNotice(task.state);
  }

  annotateNotice(store, callerId, message);
  if (task.parentSessionId === "unknown") {
    return NOTICE_PARENTLESS;
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
  return delivered ? NOTICE_SENT : NOTICE_UNSENT;
}
