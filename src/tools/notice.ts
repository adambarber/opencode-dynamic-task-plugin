// task_notify executor: the child's mid-flight voice. Advisory metadata on
// the active record, delivery through the gate — never a settlement.

import type { ToolContext } from "@opencode/plugin/promise/tool";
import { isEventRecord } from "../shared/host-shape.js";
import { annotateNotice, isNoticeClaim, NoticeClaim } from "../shared/notice-claim.js";
import { formatParentNotification, NotifyKind } from "../shared/notification-text.js";
import { LogLevel, getLatestNotification, noticeDedupKey, notifyParent, safeLog, takeNotice } from "../shared/notify.js";
import { isParentless } from "../shared/session-lifecycle.js";
import { findTask, pruneRetainedTasks, TaskState } from "../shared/task-state.js";
import {
  alreadySettledNotice,
  CALLER_UNKNOWN,
  MESSAGE_REQUIRED,
  NOT_A_TRACKED_TASK,
  NOTICE_DUPLICATE_SUPPRESSED,
  NOTICE_PARENTLESS,
  NOTICE_PENDING_ACK,
  NOTICE_SENT,
  noticeRateLimited,
  noticeClaimRefused,
  noticeTooLong,
  parentUndelivered,
} from "../shared/voice.js";
import type { NotifyArgs } from "./args.js";
import { callerSessionId, type ToolDeps } from "./context.js";






export async function executeTaskNotify(deps: ToolDeps, args: NotifyArgs, ctx: ToolContext): Promise<string> {
  const { host, store, config } = deps;
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
  const claimed = args.kind === undefined ? NoticeClaim.Progress : args.kind;
  if (!isNoticeClaim(claimed)) {
    return noticeClaimRefused(String(args.kind));
  }
  const claim = claimed;

  pruneRetainedTasks(store, config);
  const task = findTask(store, callerId);
  if (!task) {
    return NOT_A_TRACKED_TASK;
  }
  if (task.state !== TaskState.Active) {
    return alreadySettledNotice(task.state);
  }

  const now = Date.now();
  const { allowed, summaryOwed } = takeNotice(callerId, config.noticeMaxPerMinute, now);
  // When the bucket recovers from a suppression, tell the parent once how many
  // notices were lost. This is a system message, so it bypasses the child's bucket.
  if (summaryOwed > 0 && !isParentless(task.parentSessionId)) {
    const summary = `Suppressed ${summaryOwed} notice(s) from this child sent faster than ${config.noticeMaxPerMinute} per minute.`;
    await notifyParent(host, task.parentSessionId, formatParentNotification(
      { childSessionId: task.childSessionId, description: task.description },
      NotifyKind.Notice,
      summary,
    ), {
      childSessionId: task.childSessionId,
      dedupKey: noticeDedupKey(summary),
      kind: NotifyKind.Notice,
    });
  }
  if (!allowed) {
    safeLog(LogLevel.Warn, `Dynamic task plugin: rate-limited a task_notice from child ${callerId} over ${config.noticeMaxPerMinute} per minute; notice not delivered.`);
    return noticeRateLimited(config.noticeMaxPerMinute);
  }

  annotateNotice(store, callerId, message, claim);
  if (isParentless(task.parentSessionId)) {
    return NOTICE_PARENTLESS;
  }
  const parentMessage = formatParentNotification(
    { childSessionId: task.childSessionId, description: task.description },
    NotifyKind.Notice,
    message,
  );
  const delivered = await notifyParent(host, task.parentSessionId, parentMessage, {
    childSessionId: task.childSessionId,
    dedupKey: noticeDedupKey(message),
    kind: NotifyKind.Notice,
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
  return parentUndelivered(record);
}
