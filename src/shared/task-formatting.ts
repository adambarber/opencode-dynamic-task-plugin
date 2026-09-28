// Presentation for fleet/status/result reads. Notification text is owned by
// the gate (notify.ts); this module only renders store records for humans.
// truncateText is notify.ts's and imported here; formatAge is below for the
// same reason it is here at all — one caller, and that caller is the module
// whose whole job is rendering. It spent years in task-state.ts, which is a
// lifecycle module, because a formatter is easy to park next to the data it
// reads. `task-state: no file outgrows 1000 lines` is the gate that noticed.
import { truncateText, type NotificationRecord } from "./notify.js";
import { TaskState, failureClassOf, turnReplacementPending, type TaskRecord, type ActiveTaskState, type RetainedTaskState, type TaskIdentity } from "./task-state.js";
import { isParentless } from "./session-lifecycle.js";
import { hostTurnRunning, type LivenessReading, UntrackedStatus } from "./liveness.js";
import { FailureClass, failureNote } from "./failure-class.js";
import type { FileTouch } from "./prompt.js";
import { textBlock, present } from "./text-block.js";
import type { AgentOccupancy } from "./caps.js";
import { DepthBound } from "./task-policy.js";

/**
 * How long ago a moment was, in the words an operator reads.
 *
 * Ages are rendered into eight different lines across this module and into none
 * anywhere else, and a mixed convention ("45s" beside "1h 5m") makes a stalled
 * task look like a recent one. `1h 5m` rather than `1h 5m 3s` for the same
 * reason the seconds are dropped below a minute: the reader is comparing, not
 * auditing, and the more digits on the line the less of the line they read.
 */
export function formatAge(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

// The one thing a settled record can still be told: the server is working on it,
// so the settlement was premature and its output is not final. Named because it is
// rendered in more than one status view and must read identically in both.
const PREMATURE_SETTLEMENT =
  "The server reports this session still working, so this settlement was premature — the child's output is not final.";

// Stall visibility without clocks-as-decisions: past this age an active turn
// with no activity renders a warning line. Display only — nothing branches
// on it (Tenet 11: the degradation direction is "operator looks, then acts").
export const STALE_TURN_AFTER_MS = 10 * 60 * 1000;

/**
 * The opening every background child is sent.
 *
 * `canNotify` is the child's own capability, not a preference: a read-only
 * agent's children have no task_notify, and offering a channel they cannot reach
 * is an order they must either disobey or fake. See `agentCanNotify` for why
 * absent knowledge keeps the instruction.
 */
export function buildBackgroundPrompt(prompt: string, { canNotify = true }: { canNotify?: boolean } = {}): string {
  return textBlock(
    "You are running as a background child task.",
    "Return a final, self-contained answer.",
    "Do not wait for parent follow-up.",
    "The parent may steer you mid-run: a parent message preempts your current turn — read it first, then continue.",
    "Answer any question yourself with your best judgment, never wait.",
    canNotify
      ? "If blocked mid-task, call task_notify with what you need and kind:\"needs_input\" — the task then settles as blocked instead of as a success, and the parent may answer via task_continue."
      : "You have no task_notify tool, so there is no way to reach the parent mid-run. If something blocks you, say so plainly in your final message and name what you need — a task that settles without that will be read as a success.",
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
  /**
   * Carried for settled rows only, so the roll-up can say how many of the
   * failures were the network's. A running row has none, and renders nothing.
   */
  failureClass?: FailureClass | undefined;
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

/**
 * The depth cell, in the words that make it actionable.
 *
 * The whole reason the effective depth is reported at all: a cap of 4 that the
 * agent set holds to 2 is a contradiction the operator cannot see, and printing
 * "4" would be printing the number that is not in force. So the cell says which
 * constraint is binding, and the cap case says the cap plainly.
 */
function formatDepth(row: AgentOccupancy): string {
  if (row.depthEffective === null) return `depth ${row.depthConfigured} (dispatchable agents unknown)`;
  if (row.depthBoundBy === DepthBound.AgentSet) {
    return `depth ${row.depthEffective} (agent set binds; cap is ${row.depthConfigured})`;
  }
  return `depth ${row.depthConfigured}`;
}

function formatAgentRow(row: AgentOccupancy): string {
  // An agent with a cap of its own is marked, so the row answers "did I set this, or
  // am I looking at the fallback" without the operator cross-referencing the config
  // file. Only the caps they STATED are marked: marking a resolved value would claim
  // they had set something they had not.
  const stated = Object.keys(row.stated).length > 0 ? " (yours)" : "";
  return `- ${row.agent} ${row.active}/${row.maxConcurrent} at once${stated} · ${formatDepth(row)}`;
}

/**
 * The shape of a settled fleet, in the words that answer the only question a
 * count cannot: is this nine successes, or five successes and four failures?
 *
 * Ordered by the lifecycle — done, failed, stuck, stopped — so a reader can scan
 * it as a sentence, with any state this build does not know about sorted on after
 * them rather than dropped. Zeros are omitted, because "0 blocked" on every
 * ordinary list is the line a parent learns to skip.
 */
function retainedRollup(rows: FleetRow[]): string {
  if (rows.length === 0) return "";
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const lifecycle: string[] = [TaskState.Completed, TaskState.Error, TaskState.Blocked, TaskState.Interrupted];
  const known = lifecycle.filter((state) => counts.has(state));
  const unfamiliar = [...counts.keys()].filter((state) => !lifecycle.includes(state)).sort();
  const parts = [...known, ...unfamiliar].map(
    (state) => `${counts.get(state)} ${state}${networkCount(rows, state)}`,
  );
  return ` — ${parts.join(" · ")}`;
}

/**
 * How many of these failures were the network's, said once, in parentheses.
 *
 * Only for `error`, and only when there is something to say: a fleet with no
 * network failures reads "4 error", which is already true and needs no gloss.
 */
function networkCount(rows: FleetRow[], state: string): string {
  if (state !== TaskState.Error) return "";
  const blips = rows.filter((row) => row.state === state && row.failureClass === FailureClass.Transient).length;
  return blips > 0 ? ` (${blips} transient)` : "";
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
  // Omitted entirely when the agent set is empty, so a project with no
  // dispatchable agents reads exactly as it did before the feature.
  agents?: AgentOccupancy[] | undefined;
}): string {
  return textBlock(
    "## Task List",
    "",
    `Active: ${input.activeCount}/${input.maxConcurrent}`,
    input.tree.length > 0 ? input.tree.map(formatTreeRow) : "(none)",
    "",
    ...(input.agents && input.agents.length > 0
      ? ["Agents (active/cap):", ...input.agents.map(formatAgentRow), ""]
      : []),
    `Retained: ${input.retained.length}${retainedRollup(input.retained)}`,
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
  if (notification.expired) {
    // The word matters more here than anywhere else on this line. A FAILED
    // notice says "I tried and lost it", and the reader's next move is to look
    // for a retry that is not coming; an EXPIRED one says the plugin stopped
    // trying, which is a different fact with a different remedy — the parent
    // session is not answering at all. Rendering this as a failure is how a
    // written-off notice comes to look like a glitch, and the parent is the only
    // reader who can do anything about it.
    return `Last notification: ${notification.kind} (EXPIRED — undelivered after ${notification.attempts} attempt(s); this notice was given up on and will not be retried. The parent session is not accepting writes.)`;
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
  if (!liveness || !(task.state === TaskState.Active || hostTurnRunning(liveness))) return [];
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
    ...present(diagnosis),
  ];
}

export function formatLivenessLines(
  task: TaskRecord,
  liveness: LivenessReading | null,
): string[] {
  return [
    ...sourcedLivenessLines(task, liveness),
    ...(task.state === TaskState.Active
      ? activeTurnLines(task, liveness)
      : // A settled record the server still calls busy: the child is working, so
        // the settlement was premature and its output is not final.
        present(liveness && hostTurnRunning(liveness) ? PREMATURE_SETTLEMENT : undefined)),
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
    ...(task.state === TaskState.Active ? activeStatusLines(task) : settledStatusLines(task)),
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
    ...present(task.lastNotice && `Last notice (${formatAge(task.lastNotice.at)} ago): ${truncateText(task.lastNotice.message, 120)}`),
  ];
}

function settledStatusLines(task: RetainedTaskState): string[] {
  return [
    `Settled: ${formatAge(task.retainedAt)} ago`,
    ...failureClassLines(task),
    ...present(task.abortError && `Abort error: ${truncateText(task.abortError, 200)}`),
  ];
}

/**
 * Why the child failed, for any reader that holds the record.
 *
 * The line is `failureNote`'s own sentence rather than a restatement of it here:
 * the notification and this must not be able to disagree about what a class MEANS,
 * and two phrasings of one classification is exactly how that happens. It is
 * omitted for a class of `none` and for a record written before classes existed,
 * so a success never carries a line teaching the parent to skip it.
 */
function failureClassLines(task: TaskRecord | null | undefined): string[] {
  const failureClass = failureClassOf(task);
  if (failureClass === undefined || failureClass === FailureClass.None) return [];
  return [failureNote(failureClass, 0)];
}

/**
 * What the child changed, in one line, for the parent deciding what to do about a
 * dead child.
 *
 * Bounded rather than complete: a child that rewrote twenty files needs the first
 * few and the count, not twenty paths, and a line long enough to wrap stops being
 * a line. Omitted entirely when nothing changed, because a child that only read is
 * the common case and "Changed: none" is a line the parent learns to skip.
 */
const CHANGED_LISTED = 6;

function changedLines(files: FileTouch[] | undefined): string[] {
  if (!files || files.length === 0) return [];
  const listed = files.slice(0, CHANGED_LISTED).map((f) => `${f.verb} ${f.path}${f.incomplete ? " (incomplete)" : ""}`);
  const rest = files.length - listed.length;
  return [`Changed: ${listed.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`];
}

/**
 * The record every read path renders from.
 *
 * This shape was being spelled out by hand at four call sites (three in read.ts,
 * one in context.ts) while a fifth restatement sat in the tests, in a language
 * with no compiler to catch a rename. A record declared N times is N chances for
 * one side to lag, and the lag is invisible until a field silently renders
 * undefined. One declaration, and a builder that owns the boring truth.
 */
export interface TaskResultRecord {
  sessionId: string;
  /**
   * Which vocabulary this field is speaking: a store state when the session is
   * tracked, `UntrackedStatus` when it is not. The union the two producers
   * actually emit, so formatTaskResultSummary is the single place that has to
   * know what each member MEANS — and so a third vocabulary cannot be added to
   * it by widening the type to `string`.
   */
  status: TaskState | UntrackedStatus;
  messageCount: number;
  latestText: string;
  tracked: boolean;
  notification?: NotificationRecord | null | undefined;
  /**
   * The files this child changed, from its own transcript. Read only by the
   * paths that HAVE the transcript in hand; a reader that does not leaves it
   * absent, which renders as silence rather than as an empty claim.
   */
  touchedFiles?: FileTouch[] | undefined;
  // Transport/read failures render through this same funnel (never raw
  // JSON): one voice for every read path, the error rides as data.
  error?: string | undefined;
  // The store record behind the Status line, when there is one — its liveness
  // block is the same one task_status renders, so the two tools cannot tell
  // different stories about the same child.
  task?: TaskRecord | null | undefined;
  liveness?: LivenessReading | null | undefined;
}

/** What a read path must say, with the rest of the record inferable. */
export type TaskResultFacts = Pick<TaskResultRecord, "sessionId" | "status" | "latestText"> &
  Partial<Omit<TaskResultRecord, "sessionId" | "status" | "latestText">>;

/**
 * The record a read path builds. The defaults encode an invariant rather than a
 * convenience: a record built without messages is a record whose read produced
 * none, and one not marked tracked is a session this plugin has no record of.
 * A caller overrides them only when it actually read messages or holds a record.
 */
export function taskResultRecord(facts: TaskResultFacts): TaskResultRecord {
  return { messageCount: 0, tracked: false, ...facts };
}

// Why the Latest block is empty. One reason per way a read yields no text, and
// each has exactly one owner: the test suite imports these rather than retyping
// them, because a placeholder restated in a test is a second declaration of the
// production vocabulary that no compiler can check.
export const NO_ASSISTANT_TEXT = "(No assistant text found)";
export const SEE_ERROR_ABOVE = "(See error above)";
export const API_UNAVAILABLE = "(API unavailable)";
export const NO_SESSION_RECORD = "(No session record found)";

export function formatTaskResultSummary(input: TaskResultRecord): string {
  // Three questions, three named answers. `TaskResultRecord.status` used to be
  // one `string` field carrying TWO vocabularies — a store state when the
  // session is tracked, a rendered host word when it is not — so "is it
  // running" had to guess at both sets of words, and `statusFromHostState`'s
  // own vocabulary was a third. The field is the union the two halves actually
  // produce, and this is the one place that decides what each member MEANS.
  const running = input.status === UntrackedStatus.Busy || input.status === TaskState.Active;
  // task_status is the settleability authority (it renders the same liveness
  // block beside the store's own state), so a running child is pointed there
  // rather than back at this tool, which cannot answer the question.
  const action =
    running
      ? "Recommended next action: use task_status for settleability, or task_result again later."
      : input.status === TaskState.Error
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

  lines.push(...failureClassLines(input.task));
  lines.push(...changedLines(input.touchedFiles));

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
    input.latestText || NO_ASSISTANT_TEXT,
    "",
    action,
  );

  return lines.join("\n");
}
