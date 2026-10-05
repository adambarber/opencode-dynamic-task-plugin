// src/shared/task-ledger.ts
// What a durable task record IS: the guards that decide whether host-held bytes are
// a record, and the hydration that turns one into the live shape.
//
// It was the largest of four subjects inside session-lifecycle.ts, and the
// atomic-write dance pin already sanctioned that file by name — so the behavior
// this module is trusted for was owned by a module whose name said nothing about
// persistence. WHAT a record is and WHERE it lives were the same file for the whole
// of the file-backed era, and only the second half of that has moved: the reader and
// writer are now `ledger-storage.ts`, on the host's own per-key store. A guard still
// lives here, because two readers that each decided what a record is would be two
// places for that to drift.

import { type ActiveTaskState, type LineagePath, type RetainedTaskState, type TaskIdentity, type TaskRecordBase, oldestRetainedId } from "./task-state.js";
import { type LedgerChange, LedgerChangeKind } from "./ledger-change.js";
import { DEFAULT_CONFIG } from "./config.js";
import { NOTIFY_KINDS, type PendingDelivery } from "./notify.js";
import { type LedgerChangeSink, type TaskStore } from "./store.js";
import { TaskState, isTaskState, withoutAdvisory } from "./task-records.js";
import { emitRetainedChange } from "./change-sinks.js";
import { isEventRecord } from "./host-shape.js";
import { isFailureClass } from "./failure-class.js";

// A task's durable record must be complete or absent: any field the render
// or revive path depends on disqualifies the whole entry. The guard itself
// carries the shape so the load path needs no casts. One entry type serves both
// durable halves (running and settled) — they differ in which state is legal
// and which clock must be there, not in the identity and routing fields, and
// two nearly-identical guards would be two places for them to drift.
interface ValidLedgerEntry extends TaskIdentity {
  lineage: LineagePath;
  state: TaskState;
  startedAt: number;
  retainedAt?: unknown;
  dependsOn?: unknown;
  dependsOnSettled?: unknown;
  requestedModel?: unknown;
  abortError?: unknown;
  failureClass?: unknown;
}

function isValidLedgerEntry(value: unknown): value is ValidLedgerEntry {
  if (!isEventRecord(value)) return false;
  const {
    childSessionId,
    parentSessionId,
    agentName,
    description,
    lineage,
    state,
    startedAt,
  } = value;
  return (
    typeof childSessionId === "string" && childSessionId.startsWith("ses_")
    && typeof parentSessionId === "string"
    && typeof agentName === "string"
    && typeof description === "string"
    && Array.isArray(lineage)
    && lineage.every((s): s is string => typeof s === "string")
    && isTaskState(state)
    && typeof startedAt === "number" && Number.isFinite(startedAt)
  );
}

/** A RUNNING durable entry: the ledger entry whose state must be `active`. */
export type ActiveEntry = ValidLedgerEntry;

export function isActiveEntry(value: unknown): value is ActiveEntry {
  return isValidLedgerEntry(value) && value.state === TaskState.Active;
}

/** A SETTLED durable entry: as above, plus the clock that ordered it. */
export type RetainedEntry = ValidLedgerEntry & {
  state: Exclude<RetainedTaskState["state"], "active">;
  retainedAt: number;
};

export function isRetainedEntry(value: unknown): value is RetainedEntry {
  return (
    isValidLedgerEntry(value)
    && value.state !== TaskState.Active
    && typeof value.retainedAt === "number"
    && Number.isFinite(value.retainedAt)
  );
}

/** The durable form of a running entry, hydrated into the live shape. */
export function activeFrom(entry: ActiveEntry): ActiveTaskState {
  return { ...hydratedBase(entry), state: TaskState.Active };
}

/**
 * The durable form of a settled entry, hydrated into the live shape. A class the
 * record does not carry, or carries as a word this build does not speak, is DROPPED
 * rather than guessed: a structural failure read as transient is worse than an
 * unclassified one, because it tells a person the work is fine.
 */
export function retainedFrom(entry: RetainedEntry): RetainedTaskState {
  const { abortError } = entry;
  const { failureClass } = entry;
  return {
    ...hydratedBase(entry),
    retainedAt: entry.retainedAt,
    state: entry.state,
    ...(typeof abortError === "string" ? { abortError } : {}),
    ...(isFailureClass(failureClass) ? { failureClass } : {}),
  };
}

// v3: durable delivery. v2 held settled records only, so a crash between
// settling and telling the parent left a `completed` with no notice and no
// evidence one was owed; `pending` is that evidence, written before each dial.
// v3 also carries `active` — the running set — because a child that is still
// working at the moment the process dies is exactly the record whose absence
// leaves a next boot with nothing to reconcile. Retained kinds are the three
// terminal states. Every other version is discarded wholesale — a
// partially-restored past reads as history, and is worse than a clean boot.
export function isPendingDelivery(value: unknown): value is PendingDelivery {
  if (!isEventRecord(value)) return false;
  const { parentSessionId, childSessionId, kind, text, attempts } = value;
  return (
    typeof parentSessionId === "string" && parentSessionId.length > 0
    && typeof childSessionId === "string" && childSessionId.startsWith("ses_")
    && typeof kind === "string" && NOTIFY_KINDS.some((known: string) => known === kind)
    && typeof text === "string" && text.length > 0
    && typeof attempts === "number" && Number.isFinite(attempts)
  );
}

// The identity, routing and admission facts both durable halves carry. Built in
// one expression: a hydrated record is complete at birth. Post-construction
// field assignment would belong to the state machine (task-state), and the
// lifecycle scanner rightly forbids it here.
function hydratedBase(entry: ValidLedgerEntry): TaskRecordBase {
  const {dependsOn} = entry;
  const {dependsOnSettled} = entry;
  const {requestedModel} = entry;
  return {
    agentName: entry.agentName,
    childSessionId: entry.childSessionId,
    description: entry.description,
    // `agentName` above is the whole routing key now. A record written by an older
    // build also carried a `lane`, and it is dropped rather than migrated: the lane
    // name was the operator's own vocabulary, not an agent, so there is no agent it
    // could be folded into — and a live child restored against the WRONG agent's
    // budget is worse than one restored against its own, so a record that somehow
    // reaches here without an agent is restored without caps rather than with a
    // guess. `agentName` was already required on every record, so this branch is
    // unreachable in practice; it is here because the durable read is untrusted.
    lineage: entry.lineage.filter((s): s is string => typeof s === "string"),
    parentSessionId: entry.parentSessionId,
    startedAt: entry.startedAt,
    ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn.filter((d): d is string => typeof d === "string") } : {}),
    ...(Array.isArray(dependsOnSettled) ? { dependsOnSettled: dependsOnSettled.filter((d): d is string => typeof d === "string") } : {}),
    ...(isEventRecord(requestedModel)
      && typeof requestedModel.providerID === "string"
      && typeof requestedModel.modelID === "string"
      ? { requestedModel: { modelID: requestedModel.modelID, providerID: requestedModel.providerID } }
      : {}),
  };
}

// The durable half of a running task: the core withoutAdvisory already
// declares, forced to the one state a restored record may be in.
export function durableActiveTask(record: ActiveTaskState): ActiveTaskState {
  return { ...withoutAdvisory(record), state: TaskState.Active };
}

/**
 * A child occupies exactly ONE half, so a key in BOTH halves is a file that
 * contradicts itself — and the contradiction has to be resolved where the file is
 * read, not left to whichever consumer looks first. The boot pass looks at the
 * settled half, so it read a genuinely running child as `completed`: a durable
 * false success, and one that nothing reading the store rather than the file could
 * have seen.
 *
 * The ACTIVE half wins. It was written by a process that believed the child alive;
 * the settled half is the older fact that a reclaim failed to remove. Trusting the
 * active half can only over-report liveness, and liveness is the half that gets
 * re-checked by the boot pass on its own.
 *
 * This is the reader's job and not the writer's alone. The writer does clear the
 * settled half on a reclaim, but any writer may not: a regression, a merge, a
 * hand-edit, or a bug fixed in one place and reintroduced in another. The reader
 * is the only place in the plugin that cannot regress, because it is the only place
 * the question is actually asked.
 *
 * @returns how many records were dropped, so the operator is told the file
 *   contradicted itself rather than only being told what survived.
 */
export function dropSettledShadows(
  retained: Map<string, RetainedTaskState>,
  active: Map<string, ActiveTaskState>,
): number {
  let dropped = 0;
  // Deleting during iteration is safe on a Map: the iterator visits entries
  // live, and a deleted entry is simply never visited — no snapshot needed.
  for (const key of retained.keys()) {
    if (!active.has(key)) continue;
    retained.delete(key);
    dropped++;
  }
  return dropped;
}

// Returns the path written; throws only on fs failure (the caller owns the
// retry decision). Atomic: write tmp, then rename over the target — a crash
// between the two leaves the previous complete ledger, never a truncation.
//
// The temp name is PROCESS-QUALIFIED, and that is load-bearing rather than tidy.
// A fixed `${file}.tmp` is shared state between every writer that can see this
// directory, and the rename is the collision: two opencode processes on one repo
// (or one process loading the plugin twice) both write that path, and whichever
// renames second finds the file already gone. Measured by racing two processes
// over 800 writes: 10 threw ENOENT out of the rename, against 0 of 400 in the
// single-process control. The pid is the discriminator because the failure is
// cross-process; within one process these writes are synchronous and cannot
// interleave.
/**
 * ONE change to the durable document, stated rather than implied.
 *
 * The ledger is a SHARED file. Two opencode processes in one project each hold
 * their own in-memory view of it, and the older writer re-serialized that whole
 * private view — so whichever process wrote last deleted the other's running-task
 * records outright, while the deleted process went on running the child. Nothing
 * said so: the write succeeded. That is a loss with no failure to find it by.
 *
 * So a write says what changed and the merge applies it to whatever is actually
 * on disk. Two processes touching two children then touch two keys, and neither
 * can erase the other. This is read-modify-write, chosen because refusing to
 * start a second instance in a project was ruled out: the operator running two
 * windows on one repo is ordinary, and a plugin that punishes that with silent
 * data loss is worse than one that costs an extra read per write.
 *
 * `settled` removes the record from `active` as well as writing it to
 * `retained`, because those are the same event seen from two maps; `forgotten`
 * clears both because that is what forgetting a task means.
 *
 * Two things this deliberately does NOT do, so that nobody reads them as
 * oversights:
 *
 * 1. It never adopts. A process that boots reads the whole file, so it sees the
 *    running tasks of any OTHER live process in the project and holds them as
 *    its own — counting them against its own admission limit and listing them in
 *    its own view. The merge keeps that process's WRITES from destroying those
 *    records; it cannot stop that process from reading them, because nothing on
 *    disk says whose they are. Fixing it means stamping each running record with
 *    the process that owns it and adopting only the ones whose owner is gone,
 *    which is durable-format work and its own decision.
 * 2. It does not make the retained cap global. `retainedTaskMaxEntries` is
 *    enforced against each process's own view, so N live processes can leave up
 *    to N times that many settled records on disk. Each process bounds its own
 *    history; the file bounds the sum only to the extent they do not overlap.
 */


/**
 * The one boot restore, for either half of the ledger.
 *
 * Three things are true of both halves and none of them is worth stating twice:
 * placements are collected AS they happen (so there is no second pass over the
 * records and no cast), an entry outranked by the other half is reported rather
 * than left behind, and N placements become ONE write. A boot that wrote per
 * record would read the shared file N times for no gain.
 */
function restoreInto<T extends ActiveTaskState | RetainedTaskState>(
  records: Map<string, T>,
  outrankedBy: ReadonlyMap<string, ActiveTaskState | RetainedTaskState>,
  place: (id: string, record: T, changes: LedgerChange[]) => void,
  fire: LedgerChangeSink | undefined,
): number {
  const changes: LedgerChange[] = [];
  const superseded: string[] = [];
  const restored = hydrate(records, (id, record) => place(id, record, changes), outrankedBy, superseded);
  for (const id of superseded) changes.push({ id, kind: LedgerChangeKind.Stopped });
  if (changes.length > 0) fire?.(changes);
  return restored;
}

/**
 * The running half, restored as running tasks. Over-cap actives block new
 * admissions until they settle.
 */
export function restoreActive(store: TaskStore, records: Map<string, ActiveTaskState>): number {
  return restoreInto(
    records,
    store.retainedTasks,
    (id, record, changes) => {
      changes.push(store.markRunning(id, record));
    },
    store.onActiveChange,
  );
}

/**
 * The settled half, with the same one-write shape.
 *
 * `pruneIfBounded` is what stops this being a copy of the file: the cap can drop
 * a record, and a record the running half already holds is skipped, so the
 * restored set is not always the loaded set.
 */
export function restoreRetained(
  store: TaskStore,
  records: Map<string, RetainedTaskState>,
  maxEntries: number = DEFAULT_CONFIG.retainedTaskMaxEntries,
): number {
  return restoreInto(
    records,
    store.activeTasks,
    (id, record, changes) => {
      // The cap's drop is named rather than left inside `pruneIfBounded`, which
      // has no way to hand it back: a record it drops must leave the shared file
      // too, and "this process no longer has it" is not the same claim.
      const decision = pruneIfBounded(store, record, maxEntries);
      if ("dropped" in decision) {
        // The incoming record IS the oldest, so it is the one the cap evicts, and
        // the file has to learn that — or the next boot restores what this one
        // refused. A `Forgotten` with no `Settled` beside it is the whole truth:
        // this record is not in the store, and was not for an instant of this boot.
        changes.push({ id, kind: LedgerChangeKind.Forgotten });
        return;
      }
      store.markRetained(id, decision.kept);
      if (decision.forgotten !== null) changes.push({ id: decision.forgotten, kind: LedgerChangeKind.Forgotten });
      changes.push({ id, kind: LedgerChangeKind.Settled, record: decision.kept });
    },
    store.onRetainedChange === undefined
      ? undefined
      : (changes) => emitRetainedChange(store, ...changes),
  );
}

// Restored entries bypass the runtime mutation choke points, so the cap is
// enforced here (tenet: the cap cannot be escaped by any state path).
//
// AGE is the cap's rule, so it is judged on `retainedAt` from BOTH sides. The
// only two things this can do — drop the oldest record held, or keep the one
// arriving — are the same decision only while the file's key order is its age
// order, which holds for a file this plugin wrote and for nothing else. A merge
// of two ledgers, a formatter, a hand edit or a clock that moved between two
// records all produce an order that is not an age order, and the oldest record
// then arrives LAST, so the second branch evicts a record newer than the one it
// keeps. The eviction is published as `Forgotten` and written back, so that is
// not a transient slip: the file agrees with it and the next boot restores what
// this one refused.
function pruneIfBounded(
  store: TaskStore,
  record: RetainedTaskState,
  maxEntries: number,
): { kept: RetainedTaskState; forgotten: string | null } | { dropped: true } {
  if (store.retainedTasks.size < maxEntries) return { forgotten: null, kept: record };
  const oldestId = oldestRetainedId(store);
  if (!oldestId) return { forgotten: null, kept: record };
  const oldest = store.retainedTasks.get(oldestId);
  // A tie keeps the incoming record and evicts the held one, which is what the
  // first branch did, so nothing about an already-correct case moves.
  if (oldest && record.retainedAt < oldest.retainedAt) return { dropped: true };
  store.dropRetained(oldestId);
  return { forgotten: oldestId, kept: record };
}

// Durability boundary: hydrate entries already validated by the ledger
// reader (session-lifecycle) into the live maps. The reader owns shape truth;
// this module owns placement and the caps.
//
// One loop for both halves. "Walk what the last boot left, keep what fits, count
// what came back" is one shape; the per-record work (where it lands, and what
// conflicts with it) is a function, not a copy of the loop.
//
// The conflict is handed over as the OTHER durable half rather than as a
// predicate: a settled record and a running record for one id are the same task
// seen twice, so the rule is simply "the other half outranks me" and each caller
// names the map that holds it instead of re-deriving the lookup.
function hydrate<T extends ActiveTaskState | RetainedTaskState>(
  records: Map<string, T>,
  place: (id: string, record: T) => void,
  outrankedBy: ReadonlyMap<string, ActiveTaskState | RetainedTaskState>,
  superseded: string[] = [],
): number {
  let restored = 0;
  for (const [id, record] of records) {
    if (outrankedBy.has(id)) {
      // Declined, not placed — and the caller must be able to SAY so, or the
      // entry stays in the shared file forever: this process will never place
      // it, never settle it, and never claim it.
      superseded.push(id);
      continue;
    }
    place(id, record);
    restored++;
  }
  return restored;
}

