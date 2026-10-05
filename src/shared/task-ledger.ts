// src/shared/task-ledger.ts
// The durable ledger: the one file that survives this process.
//
// It was the largest of four subjects inside session-lifecycle.ts, and the
// atomic-write dance pin already sanctioned that file by name — so the behavior
// this module is trusted for was owned by a module whose name said nothing about
// persistence. Durable state resolves from the host-provided project `directory`,
// never process CWD, which for tests and multi-project hosts is somebody else's tree.

import { type ActiveTaskState, type LineagePath, type RetainedTaskState, type TaskIdentity, type TaskRecordBase, oldestRetainedId } from "./task-state.js";
import { type LedgerChange, LedgerChangeKind } from "./ledger-change.js";
import { type LedgerChangeSink, type TaskStore } from "./store.js";
import { NOTIFY_KINDS, type PendingDelivery, owedIdentity } from "./notify.js";
import { TaskState, isTaskState, withoutAdvisory } from "./task-records.js";
import { dirname, join } from "node:path";
import { errorMessage, isEventRecord } from "./host-shape.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { DEFAULT_CONFIG } from "./config.js";
import { emitRetainedChange } from "./change-sinks.js";
import { homedir } from "node:os";
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

// A settled record additionally carries the clock that ordered it. A running
// one must NOT: `retainedAt` on an active entry would mean nothing.
function isValidRetainedEntry(value: unknown): value is ValidLedgerEntry & { state: Exclude<RetainedTaskState["state"], "active">; retainedAt: number } {
  return isValidLedgerEntry(value)
    && value.state !== TaskState.Active
    && typeof value.retainedAt === "number"
    && Number.isFinite(value.retainedAt);
}

// v3: durable delivery. v2 held settled records only, so a crash between
// settling and telling the parent left a `completed` with no notice and no
// evidence one was owed; `pending` is that evidence, written before each dial.
// v3 also carries `active` — the running set — because a child that is still
// working at the moment the process dies is exactly the record whose absence
// leaves a next boot with nothing to reconcile. Retained kinds are the three
// terminal states. Every other version is discarded wholesale — a
// partially-restored past reads as history, and is worse than a clean boot.
// File shape: { version, tasks: { [childSessionId]: entry }, active: { [childSessionId]: entry }, pending: [owed write] }.
export const TASK_LEDGER_VERSION = 3;

/**
 * The whole durable file, as the one dance sees it.
 */
export interface TaskLedgerFile {
  retained: Map<string, RetainedTaskState>;
  active: Map<string, ActiveTaskState>;
  pending: PendingDelivery[];
}

/**
 * A ledger that was READ, plus why it was thrown away when it was not.
 *
 * `discarded` is null when the file was read (including when there was no file,
 * which is a first boot and loses nothing). It exists because the alternative
 * was a boot that silently invents a clean slate: a torn write, a hand-edited
 * file, or a version this build does not speak all produce an EMPTY ledger, and
 * an empty ledger is indistinguishable from a project that has never run a task.
 * A parent owed a completion notice would never receive it, and the plugin —
 * whose whole claim is that it does not lose track of a child — would have lost
 * one in silence. Discarding is the right call; discarding QUIETLY is not, so
 * the reason travels out beside the maps and the boot reports it. This is the
 * read side of the pair `persistLedger` already reports on the write side.
 *
 * It is a fact about the READ and not a field of the file, which is why it is
 * not on `TaskLedgerFile`: nothing writes a reason for discarding into the
 * document it is describing.
 *
 * `unreadable` is the sharper of the two, and it is a separate field because
 * `discarded` conflates two worlds that must be treated oppositely. A file whose
 * RECORDS were dropped was read: the survivors are in hand, so writing onto it
 * merges onto a known document and is the ordinary case. A file that could not be
 * read at all was not, and writing onto it is not a merge — it is a replacement
 * of whatever the operator (or another process) had, by a view of the world this
 * process built without ever having seen the file. The writer needs that
 * distinction, and reading it out of `discarded`'s prose would make the two
 * wordings load-bearing.
 */
export interface LoadedTaskLedger extends TaskLedgerFile {
  discarded: string | null;
  /** True only when NOTHING was parsed: a torn write, a foreign version, a non-object. */
  unreadable: boolean;
}

const FALLBACK_LEDGER_ROOT = join(homedir(), ".local", "share", "opencode-dynamic-task");

// Ledger and debug root resolve from the host-provided project directory —
// the same root as the plugin config file — never process CWD. With no
// directory at all (tests, bare hosts), fall back to a private state dir.
export function resolveTaskLedgerPath(directory: string): string {
  if (directory) return join(directory, ".dynamic-task-ledger.json");
  return join(FALLBACK_LEDGER_ROOT, "ledger.json");
}

// An owed write is all-or-nothing: the boot must be able to deliver it exactly,
// so a missing parent, an empty text, an unknown kind, or a non-finite attempt
// count disqualifies the whole entry. Half an entry would dial a message nobody
// can account for.
function isPendingDelivery(value: unknown): value is PendingDelivery {
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
    childSessionId: entry.childSessionId,
    parentSessionId: entry.parentSessionId,
    agentName: entry.agentName,
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

export function loadTaskLedger(filePath: string): LoadedTaskLedger {
  const retained = new Map<string, RetainedTaskState>();
  const active = new Map<string, ActiveTaskState>();
  const pending: PendingDelivery[] = [];
  // Every road out of here that throws durable state away says which road it
  // was. One count for records dropped inside an otherwise-readable file, and
  // one reason for a file that could not be read at all: those are different
  // failures and an operator needs to tell them apart.
  //
  // ONE return, on purpose. Three returns that each built the same object is
  // three places to add a field, and the one somebody forgets is a silent
  // discard — which is the failure this whole shape exists to remove.
  let discarded: string | null = null;
  let unreadable = false;
  let dropped = 0;
  if (filePath && existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!isEventRecord(parsed) || parsed.version !== TASK_LEDGER_VERSION || !isEventRecord(parsed.tasks)) {
        const version = isEventRecord(parsed) ? JSON.stringify(parsed.version) : "not an object";
        discarded = `unreadable as a v${TASK_LEDGER_VERSION} ledger file (version field: ${version})`;
        unreadable = true;
      } else {
        if (Array.isArray(parsed.pending)) {
          for (const entry of parsed.pending) {
            if (isPendingDelivery(entry)) pending.push(entry);
            else dropped++;
          }
        }
        if (isEventRecord(parsed.active)) {
          for (const [key, entry] of Object.entries(parsed.active)) {
            if (isValidLedgerEntry(entry) && entry.state === TaskState.Active && entry.childSessionId === key) {
              active.set(key, { ...hydratedBase(entry), state: TaskState.Active });
            } else {
              dropped++;
            }
          }
        }
        const taskEntries = isEventRecord(parsed.tasks) ? Object.entries(parsed.tasks) : [];
        for (const [key, entry] of taskEntries) {
          // The map key is canonical identity: an entry disagreeing with its key
          // is corrupt, not merely mislabeled.
          if (isValidRetainedEntry(entry) && key.startsWith("ses_") && entry.childSessionId === key) {
            const {abortError} = entry;
            const {failureClass} = entry;
            retained.set(key, {
              ...hydratedBase(entry),
              retainedAt: entry.retainedAt,
              state: entry.state,
              ...(typeof abortError === "string" ? { abortError } : {}),
              // A class the file does not carry, or carries as a word this build
              // does not speak, is DROPPED rather than guessed — the same rule the
              // `lane` field below follows, for the same reason: a structural
              // failure read as transient is worse than an unclassified one,
              // because it tells a person the work is fine. A file written before
              // classes existed lands here with no field and reads as unclassified,
              // which is the honest reading of a record that never said.
              ...(isFailureClass(failureClass) ? { failureClass } : {}),
            });
          } else {
            dropped++;
          }
        }
        // A child occupies exactly ONE half. See `dropSettledShadows` for why this
        // is resolved here rather than trusted from the writer.
        dropped += dropSettledShadows(retained, active);
        if (dropped > 0) discarded = `${dropped} record(s) in the file failed validation and were dropped`;
      }
    } catch (error: unknown) {
      // A torn write is the ordinary way to get here, and this is the one place
      // it is survivable: the file is all the plugin has, and a partial parse is
      // still a record of what the last boot knew.
      discarded = `unparseable (${errorMessage(error)})`;
      unreadable = true;
    }
  }
  return { active, discarded, pending, retained, unreadable };
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
function dropSettledShadows(
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
 * What a set of changes does to a ledger. Pure, and the whole of the merge
 * policy in one place: entries this process did not touch are carried through
 * untouched, which is the entire claim.
 */
export function mergeLedgerChange(onDisk: TaskLedgerFile, changes: readonly LedgerChange[]): TaskLedgerFile {
  const retained = new Map(onDisk.retained);
  const active = new Map(onDisk.active);
  const pending = [...onDisk.pending];
  for (const change of changes) {
    switch (change.kind) {
      // Grouped in the shape the notice cases below already use: a kind that
      // differs only in WHICH VERB it uses belongs next to its twin, so each verb
      // is written once. Spelled as four arms, the pair read as near-identical
      // blocks — `active.delete(change.id); break;` twice over — which is one
      // decision restated in the one place a reader looks to learn what a kind does.
      case LedgerChangeKind.Settled:
      case LedgerChangeKind.Forgotten: {
        if (change.kind === LedgerChangeKind.Settled) retained.set(change.id, change.record);
        else retained.delete(change.id);
        active.delete(change.id);
        break;
      }
      case LedgerChangeKind.Running:
      case LedgerChangeKind.Stopped: {
        if (change.kind === LedgerChangeKind.Stopped) {
          active.delete(change.id);
        } else {
          // A child occupies EXACTLY ONE half of the ledger. A `Running` change is
          // the reclaim, so it also CLEARS the settled record it replaces. It did not,
          // and a revived or withdrawn child then sat in both halves at once: the
          // boot pass found the settled record first and restored a genuinely running
          // child as completed — a durable false success, not a wrong answer to a live
          // question, and so invisible to anything that read the store instead of the
          // file.
          retained.delete(change.id);
          active.set(change.id, change.record);
        }
        break;
      }
      // One lookup for both: what makes two notices the SAME notice is
      // `owedIdentity`, and the two cases differ only in what they do about it.
      case LedgerChangeKind.Owed:
      case LedgerChangeKind.Delivered: {
        const identity = owedIdentity(change.record);
        const at = pending.findIndex((owed) => owedIdentity(owed) === identity);
        if (change.kind === LedgerChangeKind.Delivered) {
          if (at !== -1) pending.splice(at, 1);
        } else if (at === -1) pending.push(change.record);
        else pending[at] = change.record;
        break;
      }
    }
  }
  return { active, pending, retained };
}

export function saveTaskLedger(ledger: TaskLedgerFile, filePath: string): string {
  if (!filePath) {
    throw new Error("Task ledger path is required");
  }
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        version: TASK_LEDGER_VERSION,
        tasks: Object.fromEntries(ledger.retained),
        // Shaped here, at the ledger boundary: the one place that knows which
        // half of a live record is durable.
        active: Object.fromEntries([...ledger.active].map(([id, record]) => [id, durableActiveTask(record)])),
        pending: ledger.pending,
      },
      null,
      2,
    ),
  );
  renameSync(tmpPath, filePath);
  return filePath;
}

// Boot revival: the ledger's read side. Entries the reader already validated
// into the live maps — the reader owns shape truth, this owns placement.
/**
 * Boot hydration for the running half, as ONE change rather than N.
 *
 * One write, and that is the load-bearing part. Placing each record through
 * `setActive` meant a boot rewrote the file once per restored task, each write
 * serializing a map that had already grown: restoring 200 records issued 200
 * writes and 4.8 MB of JSON to produce a 30 KB file, every boot, for no change in
 * content — the file ALREADY holds these records, they were just read from it.
 *
 * So the restore places and then tells the funnel ONCE. It does not bypass it —
 * spawn, revive and settlement still go through `setActive`/`removeActive` — and
 * a restore that dropped a record (the cap fired, or the other half outranked
 * it) is still followed by a write, so the file never disagrees with memory.
 *
 * The concurrency cap is deliberately NOT applied: it is an admission policy
 * about work this process starts, and these tasks are already running
 * server-side. Over-cap actives block new admissions until they settle.
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

