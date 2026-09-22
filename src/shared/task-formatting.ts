// Presentation for fleet/status/result reads. Notification text is owned by
// the gate (notify.ts); this module only renders store records for humans.
// truncateText and formatAge live in notify.ts / task-state.ts respectively —
// one home each, imported here.
import { truncateText, type NotificationRecord } from "./notify.js";
import { formatAge } from "./task-state.js";

export function buildBackgroundPrompt(prompt: string): string {
  return [
    "You are running as a background child task.",
    "Return a final, self-contained answer.",
    "Do not wait for parent follow-up.",
    "The parent may steer you mid-run: a parent message preempts your current turn — read it first, then continue.",
    "Answer any question yourself with your best judgment, never wait.",
    "If blocked mid-task, call task_notify with what you need; the parent may reply via task_continue.",
    "",
    prompt,
  ].join("\n");
}

export interface FleetRow {
  childSessionId: string;
  agentName: string;
  description: string;
  state: string;
  startedAt: number;
}

function formatFleetRow(row: FleetRow): string {
  return `- ${row.childSessionId} @${row.agentName} [${row.state}] ${row.description} (${formatAge(row.startedAt)})`;
}

export function formatTaskListSummary(input: {
  active: FleetRow[];
  retained: FleetRow[];
  maxConcurrent: number;
}): string {
  const lines = [
    "## Task List",
    "",
    `Active: ${input.active.length}/${input.maxConcurrent}`,
    ...(input.active.length > 0 ? input.active.map(formatFleetRow) : ["(none)"]),
    "",
    `Retained: ${input.retained.length}`,
    ...(input.retained.length > 0 ? input.retained.map(formatFleetRow) : ["(none)"]),
  ];
  return lines.join("\n");
}

// Three honest outcomes: a delivered notice, a suppressed verbatim repeat
// (never dialed), and a parentless non-delivery (nowhere to dial). Only a
// real attempt that failed may read as FAILED.
function formatNotificationLine(notification: NotificationRecord): string {
  if (notification.suppressed) {
    return `Last notification: ${notification.kind} — Suppressed (duplicate — already delivered)`;
  }
  if (!notification.delivered && notification.attempts === 0 && notification.parentSessionId === "unknown") {
    return `Last notification: ${notification.kind} — Not delivered (no parent session)`;
  }
  return notification.delivered
    ? `Last notification: ${notification.kind} (delivered in ${notification.attempts} attempt(s))`
    : `Last notification: ${notification.kind} (FAILED after ${notification.attempts} attempt(s))`;
}

export function formatTaskStatusDetail(
  task: import("./task-state.js").TaskRecord,
  notification: NotificationRecord | null,
): string {
  const lines = [
    "## Task Status",
    "",
    `Session: ${task.childSessionId}`,
    `Parent: ${task.parentSessionId}`,
    `Agent: ${task.agentName}`,
    `State: ${task.state}`,
    `Description: ${task.description}`,
    `Lineage: ${task.lineage.length > 0 ? task.lineage.join(" → ") : "(root)"}`,
    `Model: ${task.requestedModel ? `${task.requestedModel.providerID}/${task.requestedModel.modelID}` : "(default)"}`,
    `Depends on: ${task.dependsOn && task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "(none)"}`,
    ...(task.dependsOnSettled && task.dependsOnSettled.length > 0 ? [`Depends on (settled): ${task.dependsOnSettled.join(", ")}`] : []),
  ];
  if (task.state === "active") {
    lines.push(`Started: ${formatAge(task.startedAt)} ago`);
    if (task.lastNotice) {
      lines.push(`Last notice (${formatAge(task.lastNotice.at)} ago): ${truncateText(task.lastNotice.message, 120)}`);
    }
  } else {
    lines.push(`Settled: ${formatAge(task.retainedAt)} ago`);
    if (task.abortError) {
      lines.push(`Abort error: ${truncateText(task.abortError, 200)}`);
    }
  }
  if (notification) {
    lines.push(formatNotificationLine(notification));
  }
  return lines.join("\n");
}

export function formatTaskResultSummary(input: {
  sessionId: string;
  status: string;
  messageCount: number;
  latestText: string;
  tracked: boolean;
  notification?: NotificationRecord | null | undefined;
  // Transport/read failures render through this same funnel (never raw
  // JSON): one voice for every read path, the error rides as data.
  error?: string | undefined;
  // Advisory live API inference, rendered as a subordinate block only. Never
  // overrides Status: the store is the liveness authority. Present only for
  // tracked active tasks, where the API read can disagree with the store.
  liveStatus?: string | undefined;
}): string {
  const running = input.status === "busy" || input.status === "active";
  const action =
    running
      ? "Recommended next action: use task_result again later."
      : input.status === "error"
        ? "Recommended next action: inspect latest output, then use task_continue if recovery is possible."
        : "Recommended next action: no follow-up needed unless you want to continue the child session.";

  const lines = [
    "## Task Result",
    "",
    `Session: ${input.sessionId}`,
    `Status: ${input.status}`,
    `Messages: ${input.messageCount}`,
    `Tracked: ${input.tracked ? "yes" : "no"}`,
  ];

  if (input.error !== undefined) {
    lines.push(`Error: ${input.error}`);
  }

  if (input.liveStatus !== undefined) {
    lines.push(
      "",
      "### Live inference (advisory — Status above is authoritative)",
      `Session API suggests: ${input.liveStatus} across ${input.messageCount} message(s).`,
      "This never overrides Status; confirm settleability with task_status.",
    );
  }

  if (input.notification) {
    lines.push(formatNotificationLine(input.notification));
  }

  lines.push(
    "",
    "### Latest Assistant Output",
    // Pull path: the operator asked for this output, so it is delivered
    // whole. Only the push path (parent notification) is bounded.
    input.latestText || "(No assistant text found)",
    "",
    action,
  );

  return lines.join("\n");
}
