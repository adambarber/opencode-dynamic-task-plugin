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

function formatNotificationLine(notification: NotificationRecord): string {
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
  debugShape?: string;
}): string {
  const action =
    input.status === "busy"
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

  if (input.debugShape) {
    lines.push("", "### Debug: Raw Session Response Shape", "```", input.debugShape, "```");
  }

  return lines.join("\n");
}
