// Presentation for fleet/status/result reads. Notification text is owned by
// the gate (notify.ts); this module only renders store records for humans.
// truncateText and formatAge live in notify.ts / task-state.ts respectively —
// one home each, imported here.
import { truncateText, type NotificationRecord } from "./notify.js";
import { formatAge, turnReplacementPending, type TaskRecord } from "./task-state.js";
import { hostTurnRunning, type LivenessReading } from "./liveness.js";

// Stall visibility without clocks-as-decisions: past this age an active turn
// with no activity renders a warning line. Display only — nothing branches
// on it (Tenet 11: the degradation direction is "operator looks, then acts").
export const STALE_TURN_AFTER_MS = 10 * 60 * 1000;

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
  pruned: number;
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
  if (input.pruned > 0) {
    lines.push(`Pruned: ${input.pruned} expired retained task(s)`);
  }
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

/**
 * The liveness block, shared by both read tools: one rendering of one reading,
 * so `task_result` and `task_status` can never disagree about the same child.
 *
 * Every line names its source, because the sources answer different questions
 * and the reader needs to know which one spoke — the server's own word for the
 * turn, the child's own message clock, and this plugin's observation of motion
 * (finer than the message clock, since a streaming turn writes parts for
 * minutes before it completes a message).
 */
export function formatLivenessLines(
  task: TaskRecord,
  liveness: LivenessReading | null,
): string[] {
  const lines: string[] = [];
  // A settled record has one liveness question left — "is the server still
  // working on this?" — so the sourced lines ride along only when the answer
  // can be yes. Rendering "not listed by the server" beside a task that is
  // already settled reads as a fault in a view that has none.
  if (liveness && (task.state === "active" || hostTurnRunning(liveness))) {
    lines.push(`Server status: ${liveness.hostState ?? "(not listed by the server)"}`);
    lines.push(
      liveness.lastMessageAt === null
        ? "Last child message: (none yet)"
        : `Last child message: ${formatAge(liveness.lastMessageAt)} ago`,
    );
  }
  if (task.state === "active") {
    // Observed motion, newest of three clocks: the event heartbeat (any host
    // event for this child's session), an explicit notice, and the spawn as
    // the floor for a child that has gone unheard since it was registered.
    const observed = Math.max(task.startedAt, task.lastNotice?.at ?? 0, task.lastActivityAt ?? 0);
    lines.push(`Last plugin event: ${formatAge(observed)} ago`);
    // The three states an active task can be in, each its own failure with its
    // own action — so they read as distinct, and none of them reads as
    // patience. Without a server reading only the silence is knowable, and
    // silence alone must not be dressed up as a diagnosis.
    if (liveness && turnReplacementPending(task)) {
      if (!hostTurnRunning(liveness)) {
        lines.push(
          "The replacement turn has not started yet: the store holds this task active until the server shows it working again. This resolves on its own — re-check if it does not.",
        );
      }
    } else if (liveness && !hostTurnRunning(liveness)) {
      // The store is waiting on an ending the server has already delivered and
      // this plugin did not hear. Nothing will settle it, which is the one
      // liveness reading that must never be mistaken for patience.
      lines.push(
        "Warning: the server reports no turn running, but the store says active and no turn replacement is outstanding — this plugin missed the ending, so nothing will settle it. Adopt the result with task_continue, or clear it with task_interrupt.",
      );
    } else if (Date.now() - observed > STALE_TURN_AFTER_MS) {
      lines.push(
        `Warning: no child events in ${formatAge(observed)} (one long tool call is silent too) — an outstanding steer may have stalled; task_continue again or task_interrupt to recover.`,
      );
    }
  } else if (liveness && hostTurnRunning(liveness)) {
    // A settled record the server still calls busy: the child is working, so
    // the settlement was premature and its output is not final.
    lines.push(
      "The server reports this session still working, so this settlement was premature — the child's output is not final.",
    );
  }
  return lines;
}

export function formatTaskStatusDetail(
  task: TaskRecord,
  notification: NotificationRecord | null,
  liveness?: LivenessReading | null,
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
    ...formatLivenessLines(task, liveness ?? null),
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
  // The store record behind the Status line, when there is one — its liveness
  // block is the same one task_status renders, so the two tools cannot tell
  // different stories about the same child.
  task?: TaskRecord | null | undefined;
  liveness?: LivenessReading | null | undefined;
}): string {
  const running = input.status === "busy" || input.status === "active";
  // task_status is the settleability authority (it renders the same liveness
  // block beside the store's own state), so a running child is pointed there
  // rather than back at this tool, which cannot answer the question.
  const action =
    running
      ? "Recommended next action: use task_status for settleability, or task_result again later."
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

  if (input.task) {
    lines.push(...formatLivenessLines(input.task, input.liveness ?? null));
  } else if (input.liveness) {
    // An untracked session has no store record to reconcile, so only the
    // sourced facts render — never a status inferred from message shapes.
    lines.push(`Server status: ${input.liveness.hostState ?? "(not listed by the server)"}`);
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
