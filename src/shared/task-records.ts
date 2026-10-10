// src/shared/task-records.ts
// What a task record IS: the lifecycle vocabulary, the shape of both durable
// halves, and the advisories that are stripped on the way to disk.
//
// This was the top of task-state.ts, and it is a different subject from what is
// below it. A record's fields answer "what may a durable fact about a child
// contain"; the machine answers "what may happen to it". Mixing them meant that
// reading the state matrix required holding the record schema in mind, and that
// the fifteen modules which only want `TaskState` imported a file four times
// their size in order to name it.
//
// The settled half was already split out (settled-record.ts); this is the other
// half, and the union of the two belongs to the machine that consumes both.

import type { SessionId } from "./ids.js";
import type { NoticeClaim } from "./notice-claim.js";
import type { ModelOverride } from "./prompt.js";
import type { ParentSession } from "./session-lifecycle.js";

/**
 * A task's lifecycle state.
 *
 * `blocked` is a state of its own: the child ended its turn needing the parent's
 * answer. Not a success and not a failure — the child worked, it could not
 * finish, and the plugin recorded `completed` for exactly this case, a false
 * success claim about a task that delivered no result. It is terminal (the turn
 * is over) and revivable (the parent's answer is a new turn).
 *
 * An enum, not a string-literal union, for the same reason as NoticeClaim: a
 * union is an invitation to compare against a raw literal, and the wire string is
 * the only place a literal belongs.
 */
export enum TaskState {
  Active = "active",
  Completed = "completed",
  Error = "error",
  Blocked = "blocked",
  Interrupted = "interrupted",
}

// The states, as data: the durable reader validates a restored record against
// this list, so a state cannot be added to the machine and forgotten by the
// reader that has to understand it.
export const TASK_STATES: readonly TaskState[] = Object.values(TaskState);
// A set lookup never narrows its key; the predicate below does the naming.
const TASK_STATE_LIST: readonly unknown[] = Object.values(TaskState);
export function isTaskState(value: unknown): value is TaskState {
  return TASK_STATE_LIST.includes(value);
}

/**
 * A settlement, named — and the names are the machine's OWN terminal states, so
 * a verdict is directly claimable, notifiable, and renderable without a second
 * lookup table translating between three parallel spellings of the same fact.
 *
 * `interrupted` is absent on purpose: it is claimed by the interrupt funnel, not
 * arrived at by a turn ending.
 */
export type SettlementVerdict = Extract<TaskState, TaskState.Completed | TaskState.Blocked | TaskState.Error>;

/**
 * A state a task reports once it has stopped: the machine's own terminal states.
 *
 * Named once because four places spelled it as `Exclude<TaskState, TaskState.Active>`
 * and a fifth read it as a bare `string` — which is how a settled state reached a
 * sentence that renders it without anyone having said which states exist. A task
 * that has stopped is never `active`, so the two vocabularies ("what a stopped task
 * reports" and "a state, any state") are different questions, and answering the
 * first with the second let every caller accept a value the machine cannot hold.
 */
export type SettledTaskState = Exclude<TaskState, TaskState.Active>;


type LineageStep = string;
export type LineagePath = LineageStep[];

// The identity and routing of a task: the store's record, the durable entry the
// loader narrows an untrusted file to, and the reference the plugin hands to the
// prompt path are one contract wearing three coats. Declared once, so a field
// added to a task is added here — a fourth coat is a fourth place a rename or a
// new required field silently fails to reach.
export interface TaskIdentity {
  childSessionId: SessionId;
  parentSessionId: ParentSession;
  // The REGISTRY id: the routing key the host resolves and the policy key the caps
  // fold on. Never rendered to an operator as-is — renderers read `agentLabel`.
  agentName: string;
  // The display label snapshotted at dispatch. Optional so rows written before the
  // field existed still load; renderers fall back to `agentName` for those.
  agentLabel?: string;
  description: string;
}

// A model override as the parent spelled it, as a PAIR — the record, the route
// and the confirmation that renders it all need the same one, so it is named once
// where the parse that produces it lives (ModelOverride, in prompt.ts) rather than
// declared a second time beside the field that holds it. An inline spelling in
// each is three places for a rename to miss.
export interface TaskRecordBase extends TaskIdentity {
  startedAt: number;
  lineage: LineagePath;
  // The agent is the routing fact, and it was here all along: `agentName` is on
  // `TaskIdentity`, so a task has always known which agent occupies its slot. The
  // lane field it used to carry alongside was a SECOND answer to the same question,
  // and the two were free to disagree — which is how a capped lane got filled by
  // children that were dispatched somewhere else. There is one key now.
  requestedModel?: ModelOverride | undefined;
  dependsOn?: string[] | undefined;
  // Admission-time only: ids that needed settlement, not success, before this
  // task spawned. Persisted so status renders the full dependency picture.
  dependsOnSettled?: string[] | undefined;
  /**
   * How many times this child has been brought back to life.
   *
   * A count of REVIVALS, not of automatic ones. A revival is a revival whoever
   * asked for it, and treating a parent's `task_continue` as free would let a
   * child that has been revived three times quietly resume itself forever.
   *
   * Optional, and `?? 0` is the whole meaning of its absence at every reader: a
   * fresh spawn has spent nothing, and a ledger written before this field
   * existed has nothing to report. It is deliberately NOT one of the advisory
   * fields — it must survive a restart, because a budget that resets on boot is
   * no budget at all during the outage it exists for.
   */
  transientResumes?: number | undefined;
}

// What admission registers: the record minus the clock the store owns. The
// advisory fields below are lifecycle-written, so a registration cannot set them.
export type NewTaskRegistration = Omit<TaskRecordBase, "startedAt">;

/**
 * The advisory fields — the ones a fresh process cannot verify, and so the only
 * ones that may never reach disk. A mid-flight notice and an activity heartbeat
 * belong to the process that observed them, and turn attribution belongs to
 * in-flight events that died with it: a fresh boot that inherited any of them
 * would be trusting a claim it cannot verify — and would re-persist a heartbeat on
 * every host event, putting a file write in the event head.
 *
 * The list lives HERE, exported, because three readers need it: the strip below,
 * the durable write, and the suite that has to prove the strip happens. It was
 * written out in the settle path and again on the durable write, in different
 * orders, and a fifth advisory field added to the record had to be remembered in
 * both places — while the tests, which named their advisories one case at a time,
 * would not have covered the fifth at all.
 */
export const ADVISORY_FIELDS = ["lastNotice", "lastActivityAt", "turnLiveAt", "replacedAt"] as const;
// The tuple above is the whole advisory set: a fifth advisory stops being
// `never` here, so the build fails until the list names it.
type UnlistedAdvisory = Exclude<keyof ActiveTaskState, "state" | keyof TaskRecordBase | (typeof ADVISORY_FIELDS)[number]>;
const everyAdvisoryIsListed: UnlistedAdvisory extends never ? true : never = true;
void everyAdvisoryIsListed;
export function withoutAdvisory(record: ActiveTaskState): TaskRecordBase {
  // The advisory half, dropped by name: a fifth advisory field fails the
  // return type below, so the drop set cannot silently go stale.
  const { lastNotice, lastActivityAt, turnLiveAt, replacedAt, ...base } = record;
  return base;
}

export interface ActiveTaskState extends TaskRecordBase {
  state: TaskState.Active;
  // Latest mid-flight notice from the child (advisory metadata, not a lifecycle
  // field). `claim` is what the child said about itself: `needs_input` means
  // this turn is ending because it needs the parent, and the settlement reads it
  // to record `blocked` instead of a false success. Last one wins, so a child
  // that declares a block and then reports progress is believed again.
  lastNotice?: { message: string; at: number; claim: NoticeClaim } | undefined;
  // Latest time the host emitted ANY event for this child's session — the
  // event funnel's own proof the turn is moving. Without it "last activity"
  // could only mean "spawned" or "called task_notify", so a child working
  // through a long tool chain read as silent since spawn. Advisory like the
  // notice: never a lifecycle field, stripped at settlement so the durable
  // ledger carries no heartbeat.
  lastActivityAt?: number | undefined;
  /**
   * Turn attribution, part 1. Stamped ONLY when this turn REPLACED a previous
   * turn on the same session (a steer, a revival) — a fresh spawn has no prior
   * turn whose ending could still be in flight.
   *
   * A turn end is published more than once by the host (the status channel and
   * the idle event each say the turn ended), and those copies can still be in
   * flight when a replacement is dispatched. Until the replacement shows a life
   * sign, no terminal event can be attributed to it — see
   * `terminalEventIsAttributable`, the one gate that decides this.
   */
  replacedAt?: number | undefined;
  /**
   * Turn attribution, part 2: the last moment the CURRENT turn was observed
   * doing something. Terminal events do not count — a turn ENDING is not the
   * turn working, and counting it is what let an echo vouch for itself.
   */
  turnLiveAt?: number | undefined;
  // Parent steer in flight: set synchronously by task_continue before aborting
  // the running turn, consumed by the lifecycle handler to suppress that
  // turn's terminal echo. Advisory, never a lifecycle mutation — the task
  // stays active either way, and settlement strips it.
}
