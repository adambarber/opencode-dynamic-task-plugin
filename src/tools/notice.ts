// task_notify executor: the child's mid-flight voice. Advisory metadata on
// the active record, delivery through the gate — never a settlement.
import type { ToolContext } from "@opencode-ai/plugin";
import { isEventRecord } from "../shared/host-shape.js";
import { isParentless } from "../shared/session-lifecycle.js";
import { notifyParent, formatParentNotification, noticeDedupKey, getLatestNotification } from "../shared/notify.js";
import { pruneRetainedTasks, findTask, annotateNotice, NOTICE_CLAIMS, type NoticeClaim } from "../shared/task-state.js";
import { callerSessionId, type ToolDeps } from "./context.js";
import {
  CALLER_UNKNOWN,
  MESSAGE_REQUIRED,
  noticeTooLong,
  NOT_A_TRACKED_TASK,
  alreadySettledNotice,
  NOTICE_PARENTLESS,
  NOTICE_SENT,
  NOTICE_DUPLICATE_SUPPRESSED,
  NOTICE_PARENT_UNREACHABLE,
  NOTICE_PENDING_ACK,
  noticeClaimRefused,
} from "../shared/voice.js";

export interface NotifyArgs {
  message?: unknown;
  kind?: unknown;
}

export async function executeTaskNotify(deps: ToolDeps, args: NotifyArgs, ctx: ToolContext): Promise<string> {
  const { client, store, config } = deps;
  const callerId = callerSessionId(ctx);
  if (callerId === undefined) {
    return CALLER_UNKNOWN;
  }
  if (!isEventRecord(args) || typeof args.message !== "string" || !args.message.trim()) {
    return MESSAGE_REQUIRED;
  }
  const message = args.message.trim();
  if (message.length > 4000) {
    return noticeTooLong(message.length);
  }
  // The claim this notice makes about the child's own state, on the ONE
  // child→parent channel. Default is progress; an unrecognized kind is refused
  // rather than downgraded, because a typo'd `needs_input` would settle the
  // child as a success — the exact false claim the kind exists to prevent.
  if (args.kind !== undefined && !NOTICE_CLAIMS.includes(args.kind as NoticeClaim)) {
    return noticeClaimRefused(String(args.kind));
  }
  const claim = (args.kind as NoticeClaim | undefined) ?? "progress";

  pruneRetainedTasks(store, config);
  const task = findTask(store, callerId);
  if (!task) {
    return NOT_A_TRACKED_TASK;
  }
  if (task.state !== "active") {
    return alreadySettledNotice(task.state);
  }

  annotateNotice(store, callerId, message, claim);
  if (isParentless(task.parentSessionId)) {
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
  if (delivered) return NOTICE_SENT;
  // The gate resolves synchronously after this await, so the latest record
  // is ours. It carries the verdict, and the three ways of not delivering are
  // three different things to tell the child: nothing dialed, dialed and lost,
  // or dialed and in the host's hand. Collapsing the last two is what once
  // told a child to retry a message the parent had already read.
  const record = getLatestNotification(task.childSessionId);
  if (record && record.message === parentMessage && record.suppressed) {
    return NOTICE_DUPLICATE_SUPPRESSED;
  }
  if (record?.pending) return NOTICE_PENDING_ACK;
  return NOTICE_PARENT_UNREACHABLE;
}
