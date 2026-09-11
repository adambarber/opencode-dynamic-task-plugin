const NOTIFY_MAX_TEXT = 1200;

export function truncateText(text: string, maxChars: number = NOTIFY_MAX_TEXT): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

export function buildBackgroundPrompt(prompt: string): string {
  return [
    "You are running as a background child task.",
    "Return a final, self-contained answer.",
    "Do not wait for parent follow-up.",
    "If blocked, state the blocker explicitly.",
    "",
    prompt,
  ].join("\n");
}

export function formatParentNotification(
  state: { childSessionId: string; description: string; timeoutMs: number },
  kind: "timeout" | "completed" | "completed_after_timeout" | "error",
  resultText = ""
): string {
  const safeResult = truncateText(resultText || "(No text output)");

  if (kind === "timeout") {
    return [
      "[dynamic-task-notify]",
      `Background task did not report completion before timeout (${Math.round(state.timeoutMs / 1000)}s).`,
      `Session: ${state.childSessionId}`,
      `Description: ${state.description}`,
      "Use task_result to inspect the latest state.",
    ].join("\n");
  }

  if (kind === "error") {
    return [
      "[dynamic-task-notify]",
      "Background task ended with an error.",
      `Session: ${state.childSessionId}`,
      `Description: ${state.description}`,
      `Latest output: ${safeResult}`,
      "Use task_result or task_continue to inspect or recover.",
    ].join("\n");
  }

  if (kind === "completed_after_timeout") {
    return [
      "[dynamic-task-notify]",
      "Background task completed after an earlier timeout notification.",
      `Session: ${state.childSessionId}`,
      `Description: ${state.description}`,
      `Latest output: ${safeResult}`,
    ].join("\n");
  }

  return [
    "[dynamic-task-notify]",
    "Background task completed successfully.",
    `Session: ${state.childSessionId}`,
    `Description: ${state.description}`,
    `Latest output: ${safeResult}`,
  ].join("\n");
}

export interface FleetRow {
  childSessionId: string;
  agentName: string;
  description: string;
  state: string;
  isBackground: boolean;
  startedAt: number;
}

function formatAge(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function formatFleetRow(row: FleetRow, now: number): string {
  const mode = row.isBackground ? "bg" : "sync";
  return `- ${row.childSessionId} @${row.agentName} [${row.state}/${mode}] ${row.description} (${formatAge(now - row.startedAt)})`;
}

export function formatTaskListSummary(input: {
  active: FleetRow[];
  retained: FleetRow[];
  maxConcurrent: number;
}): string {
  const now = Date.now();
  const bgActive = input.active.filter((t) => t.isBackground).length;
  const lines = [
    "## Task List",
    "",
    `Active background: ${bgActive}/${input.maxConcurrent}`,
    ...(input.active.length > 0 ? input.active.map((t) => formatFleetRow(t, now)) : ["(none)"]),
    "",
    `Retained: ${input.retained.length}`,
    ...(input.retained.length > 0 ? input.retained.map((t) => formatFleetRow(t, now)) : ["(none)"]),
  ];
  return lines.join("\n");
}

export function formatTaskStatusDetail(
  task: {
    childSessionId: string;
    parentSessionId: string;
    agentName: string;
    description: string;
    lineage: string[];
    state: string;
    isBackground: boolean;
    startedAt: number;
    retainedAt?: number;
    timeoutNotified: boolean;
    completed: boolean;
    requestedModel?: string;
    dependsOn?: string[];
  },
  notification?: { kind: string; delivered: boolean; attempts: number } | null,
): string {
  const lines = [
    "## Task Status",
    "",
    `Session: ${task.childSessionId}`,
    `Parent: ${task.parentSessionId}`,
    `Agent: ${task.agentName}`,
    `State: ${task.state}`,
    `Mode: ${task.isBackground ? "background" : "sync"}`,
    `Description: ${task.description}`,
    `Lineage: ${task.lineage.length > 0 ? task.lineage.join(" \u2192 ") : "(root)"}`,
    `Model: ${task.requestedModel || "(default)"}`,
    `Depends on: ${task.dependsOn && task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "(none)"}`,
    `Timeout notified: ${task.timeoutNotified ? "yes" : "no"}`,
    `Completed: ${task.completed ? "yes" : "no"}`,
  ];
  if (notification) {
    lines.push(
      notification.delivered
        ? `Last notification: ${notification.kind} (delivered in ${notification.attempts} attempt(s))`
        : `Last notification: ${notification.kind} (FAILED after ${notification.attempts} attempt(s))`,
    );
  }
  return lines.join("\n");
}

export function formatTaskResultSummary(input: {
  sessionId: string;
  status: string;
  messageCount: number;
  latestText: string;
  tracked: boolean;
  timeoutNotified: boolean;
  notification?: { kind: string; delivered: boolean; attempts: number } | null;
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
    `Tracked background task: ${input.tracked ? "yes" : "no"}`,
    `Timeout notification sent: ${input.timeoutNotified ? "yes" : "no"}`,
  ];

  if (input.notification) {
    lines.push(
      input.notification.delivered
        ? `Last notification: ${input.notification.kind} (delivered in ${input.notification.attempts} attempt(s))`
        : `Last notification: ${input.notification.kind} (FAILED after ${input.notification.attempts} attempt(s))`,
    );
  }

  lines.push(
    "",
    "### Latest Assistant Output",
    input.latestText || "(No assistant text found)",
    "",
    action,
  );

  if (input.debugShape) {
    lines.push("", "### Debug: Raw Session Response Shape", "```", input.debugShape, "```");
  }

  return lines.join("\n");
}
