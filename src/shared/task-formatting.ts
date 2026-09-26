// Presentation for fleet/status/result reads. Notification text is owned by
// the gate (notify.ts); this module only renders store records for humans.
// truncateText and formatAge live in notify.ts / task-state.ts respectively —
// one home each, imported here.
import { truncateText, type NotificationRecord } from "./notify.js";
import { formatAge, turnReplacementPending, type TaskRecord, type ActiveTaskState, type RetainedTaskState, type TaskIdentity } from "./task-state.js";
import { isParentless } from "./session-lifecycle.js";
import { hostTurnRunning, type LivenessReading } from "./liveness.js";
import { textBlock } from "./text-block.js";

// Stall visibility without clocks-as-decisions: past this age an active turn
// with no activity renders a warning line. Display only — nothing branches
// on it (Tenet 11: the degradation direction is "operator looks, then acts").
export const STALE_TURN_AFTER_MS = 10 * 60 * 1000;

export function buildBackgroundPrompt(prompt: string): string {
  return textBlock(
    "You are running as a background child task.",
    "Return a final, self-contained answer.",
    "Do not wait for parent follow-up.",
    "The parent may steer you mid-run: a parent message preempts your current turn — read it first, then continue.",
    "Answer any question yourself with your best judgment, never wait.",
    "If blocked mid-task, call task_notify with what you need and kind:\"needs_input\" — the task then settles as blocked instead of as a success, and the parent may answer via task_continue.",
    "",
    prompt,
  );
}

/**
 * The row a fleet table renders, named as a projection of the identity it
 * prints: the three identity fields it shows, plus the two that are the fleet's
 * to know. Spelling them out instead of picking them meant a rename of an
 * identity field reached the table by a reader's memory.
 */
export interface FleetRow extends Pick<TaskIdentity, "childSessionId" | "agentName" | "description"> {
  state: string;
  startedAt: number;
}

function formatFleetRow(row: FleetRow): string {
  return `- ${row.childSessionId} @${row.agentName} [${row.state}] ${row.description} (${formatAge(row.startedAt)})`;
}

// One running task with its place in the dispatch tree. The parent link rides
// along because a task whose parent is gone must say so: rendered flush it
// reads as a root, and a root is a task whose parent nobody has stopped.
export interface TreeRow extends FleetRow {
  depth: number;
  parentSessionId: string;
  parentTracked: boolean;
}

function formatTreeRow(row: TreeRow): string {
  const indent = "  ".repeat(row.depth);
  const link = row.parentTracked ? "" : ` — spawned by ${row.parentSessionId}, not tracked`;
  return `${indent}- ${row.childSessionId} @${row.agentName} [${row.state}] ${row.description} (${formatAge(row.startedAt)})${link}`;
}

export function formatTaskListSummary(input: {
  // The running fleet as the tree it is: every active task, plus the settled
  // ancestors that place it. `activeCount` is the number of RUNNING rows in it,
  // kept beside the rows rather than recounted here so the count and the list
  // cannot disagree.
  tree: TreeRow[];
  activeCount: number;
  retained: FleetRow[];
  maxConcurrent: number;
  pruned: number;
}): string {
  return textBlock(
    "## Task List",
    "",
    `Active: ${input.activeCount}/${input.maxConcurrent}`,
    input.tree.length > 0 ? input.tree.map(formatTreeRow) : "(none)",
    "",
    `Retained: ${input.retained.length}`,
    input.retained.length > 0 ? input.retained.map(formatFleetRow) : "(none)",
    input.pruned > 0 ? `Pruned: ${input.pruned} expired retained task(s)` : undefined,
  );
}

// Four honest outcomes: a delivered notice, a suppressed verbatim repeat (never
// dialed), a parentless non-delivery (nowhere to dial), and a write the host is
// still holding. Only a real attempt that failed may read as FAILED — and a
// held write may NOT, because the host may yet deliver it and a "FAILED" the
// parent acts on would be a lie with consequences.
function formatNotificationLine(notification: NotificationRecord): string {
  if (notification.suppressed) {
    return `Last notification: ${notification.kind} — Suppressed (duplicate — already delivered)`;
  }
  if (!notification.delivered && notification.attempts === 0 && isParentless(notification.parentSessionId)) {
    return `Last notification: ${notification.kind} — Not delivered (no parent session)`;
  }
  if (notification.pending) {
    // The wording names what is actually known, and no more. Live evidence:
    // the host puts the notification in the parent's context AS A USER MESSAGE
    // while the call it was dialed on stays open — so "the parent has not
    // answered" was false as soon as the parent had read it, and the parent is
    // the one reading this line. Unacknowledged is the truth: the host has not
    // confirmed, and the message may be in the parent's context now or arrive
    // when its turn ends.
    return `Last notification: ${notification.kind} (PENDING — dialed, unacknowledged; the parent may already have it, or get it when its turn ends)`;
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
/**
 * The two liveness readings, sourced, for a task that can still be working: what
 * the server says and when the child last spoke. A settled record has one
 * liveness question left — "is the server still working on this?" — so these ride
 * along only when the answer can be yes. Rendering "not listed by the server"
 * beside a task that is already settled reads as a fault in a view that has none.
 */
function sourcedLivenessLines(task: TaskRecord, liveness: LivenessReading | null): string[] {
  if (!liveness || !(task.state === "active" || hostTurnRunning(liveness))) return [];
  return [
    `Server status: ${liveness.hostState ?? "(not listed by the server)"}`,
    liveness.lastMessageAt === null
      ? "Last child message: (none yet)"
      : `Last child message: ${formatAge(liveness.lastMessageAt)} ago`,
  ];
}

/**
 * What the plugin's own clock says, for a task the store holds active: the last
 * moment any of this plugin's three clocks saw motion, then the one diagnosis
 * that reading earns. Display only — nothing branches on the staleness threshold.
 */
function activeTurnLines(task: ActiveTaskState, liveness: LivenessReading | null): string[] {
  // Observed motion, newest of three clocks: the event heartbeat (any host
  // event for this child's session), an explicit notice, and the spawn as
  // the floor for a child that has gone unheard since it was registered.
  const observed = Math.max(task.startedAt, task.lastNotice?.at ?? 0, task.lastActivityAt ?? 0);
  // The three states an active task can be in, each its own failure with its
  // own action — so they read as distinct, and none of them reads as
  // patience. Without a server reading only the silence is knowable, and
  // silence alone must not be dressed up as a diagnosis.
  const diagnosis =
    liveness && turnReplacementPending(task)
      ? hostTurnRunning(liveness)
        ? undefined
        : "The replacement turn has not started yet: the store holds this task active until the server shows it working again. This resolves on its own — re-check if it does not."
      : liveness && !hostTurnRunning(liveness)
        ? "Warning: the server reports no turn running, but the store says active and no turn replacement is outstanding — this plugin missed the ending, so nothing will settle it. Adopt the result with task_continue, or clear it with task_interrupt."
        : Date.now() - observed > STALE_TURN_AFTER_MS
          ? `Warning: no child events in ${formatAge(observed)} (one long tool call is silent too) — an outstanding steer may have stalled; task_continue again or task_interrupt to recover.`
          : undefined;
  return [
    `Last plugin event: ${formatAge(observed)} ago`,
    ...(diagnosis ? [diagnosis] : []),
  ];
}

export function formatLivenessLines(
  task: TaskRecord,
  liveness: LivenessReading | null,
): string[] {
  return [
    ...sourcedLivenessLines(task, liveness),
    ...(task.state === "active"
      ? activeTurnLines(task, liveness)
      : // A settled record the server still calls busy: the child is working, so
        // the settlement was premature and its output is not final.
        liveness && hostTurnRunning(liveness)
        ? ["The server reports this session still working, so this settlement was premature — the child's output is not final."]
        : []),
  ];
}

export function formatTaskStatusDetail(
  task: TaskRecord,
  notification: NotificationRecord | null,
  liveness?: LivenessReading | null,
): string {
  return textBlock(
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
    task.dependsOnSettled && task.dependsOnSettled.length > 0 ? `Depends on (settled): ${task.dependsOnSettled.join(", ")}` : undefined,
    formatLivenessLines(task, liveness ?? null),
    ...(task.state === "active" ? activeStatusLines(task) : settledStatusLines(task)),
    notification ? formatNotificationLine(notification) : undefined,
  );
}

// The two mutually exclusive clocks a status detail ends on: a running task has a
// start and possibly a steer notice, a settled one has a retention age and
// possibly the abort that settled it. Each is its own lines, so the block says
// which state it is rendering instead of branching over a shared accumulator.
function activeStatusLines(task: ActiveTaskState): string[] {
  return [
    `Started: ${formatAge(task.startedAt)} ago`,
    ...(task.lastNotice
      ? [`Last notice (${formatAge(task.lastNotice.at)} ago): ${truncateText(task.lastNotice.message, 120)}`]
      : []),
  ];
}

function settledStatusLines(task: RetainedTaskState): string[] {
  return [
    `Settled: ${formatAge(task.retainedAt)} ago`,
    ...(task.abortError ? [`Abort error: ${truncateText(task.abortError, 200)}`] : []),
  ];
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
