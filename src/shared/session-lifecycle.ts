// src/shared/session-lifecycle.ts
// Session and event boundary (Task 08): typed readers for host events and
// session-API payloads, durable ledger (de)serialization, and the one
// sanctioned PluginInput→client augmentation cast. Pure glue: policy lives
// in the task modules, not here.
//
// Durable state (the ledger, the debug log root) resolves from the
// host-provided project `directory` — never process CWD, which for tests and
// multi-project hosts is somebody else's tree.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenCodeClient } from "./client.js";
import { LedgerChangeKind, type LedgerChange } from "./ledger-change.js";
import { TaskState } from "./task-state.js";
import type { RetainedTaskState, ActiveTaskState, LineagePath, TaskIdentity, TaskRecordBase } from "./task-state.js";
import { TASK_STATES, withoutAdvisory } from "./task-state.js";
import { NOTIFY_KINDS, owedIdentity, type PendingDelivery } from "./notify.js";
import { eventField, eventString, eventWord, isEventRecord, errorMessage } from "./host-shape.js";
import { SESSION_DELETED, isTurnEnding } from "./host-events.js";

// Host event payloads are untyped JSON at this boundary; the total readers that
// narrow them live in host-shape.ts, the bottom of the shape layer.

// The names the host puts a payload under once the transport envelope is
// stripped. `data` is the SDK's own (the client resolves to { data, request,
// response } by default), the rest are route-specific envelopes older hosts
// and the plugin's own tests have both been seen to use.
const PAYLOAD_KEYS = ["data", "body", "agents", "result", "session", "output"] as const;

/**
 * What the host actually returned, with the transport envelope removed.
 *
 * The SDK client resolves every call to `{ data, request, response }` — its
 * `responseStyle` default is "fields", not "data" — so a reader that looks for
 * a field at the top level is reading a field that is one level too high, and
 * it fails by finding nothing rather than by throwing. That is the worst
 * failure mode available here: a status read that silently answers "no session"
 * for a child that is working. Every host read unwraps through this one
 * function, so the envelope is knowledge this module owns.
 */
export function hostPayload(result: unknown): unknown {
  if (!isEventRecord(result)) return result;
  for (const inner of envelopeShells(result)) return inner;
  // No envelope: the payload is the record itself (a map keyed by session id,
  // or a session record carrying its own id).
  return result;
}

/**
 * The shells the transport may have wrapped a payload in, in the order they are
 * tried. One walk, because the knowledge is one fact: the SDK resolves every
 * call to an envelope and a second shell is possible under some hosts, so a
 * reader that rolls its own loop is a reader that can disagree with the next one
 * about what the shells are.
 */
function* envelopeShells(record: Record<string, unknown>): Generator<unknown> {
  for (const key of PAYLOAD_KEYS) {
    const inner = record[key];
    if (inner !== undefined) yield inner;
  }
}

// The settlement kind reader's own vocabulary normalizer: the host spells a
// status as a bare string in one event shape and as {type} in another, and the
// two must not become two different words.
export function normalizeStatus(raw: unknown): string {
  if (typeof raw === "string") return raw.toLowerCase();
  if (isEventRecord(raw) && typeof raw.type === "string") return raw.type.toLowerCase();
  return "";
}

// The ONE child-abort site. Tenet 9 keeps the await at the call site — a steer
// must abort exactly where its claim requires, an interrupt exactly where its
// claim sits — so the funnel takes the ordering-preserving shape: it performs
// the call and hands back what the failure MEANS, never what to do about it.
//
// Two meanings, and they are the whole reason this is one funnel: a "not
// found" child is dead (settle/report it), while any other transport failure
// may never have reached the server, so the turn may still be running and a
// caller that treats it as a kill replaces a live turn instead of stopping it.
export interface AbortOutcome {
  serverGone: boolean;
  transportError: string | undefined;
}

export function abortSession(client: OpenCodeClient, sessionId: string): Promise<AbortOutcome> {
  return client.session
    .abort({ path: { id: sessionId } })
    .then((): AbortOutcome => ({ serverGone: false, transportError: undefined }))
    .catch((error: unknown): AbortOutcome => {
      const message = errorMessage(error);
      return message.includes("not found")
        ? { serverGone: true, transportError: undefined }
        : { serverGone: false, transportError: message };
    });
}

// Session id lives at properties.info.id (host) or properties.sessionID
// (tests); aggregate/top-level spellings are fallbacks. A missing prefix
// means the payload is not a session event.
export function getSessionIdFromEvent(event: unknown): string | null {
  const properties = eventField(event, "properties");
  const sid =
    eventString(properties, "sessionID")
    ?? eventString(properties, "sessionId")
    ?? eventString(properties, "info", "id")
    ?? eventString(event, "data", "sessionId")
    ?? eventString(event, "data", "sessionID")
    ?? eventString(event, "data", "info", "id")
    ?? eventString(event, "properties", "aggregateID")
    ?? eventString(event, "aggregateID")
    ?? eventString(event, "id")
    ?? eventString(event, "sessionID");
  if (!sid || !sid.startsWith("ses_")) return null;
  return sid;
}

// Lifecycle status extraction for every observed event shape: properties
// (host), data.info (sync updates), or type/name keywords as last resort.
// The nested {type:"error"} spelling is host-real and must not be missed —
// a failed child reported as success is the worst possible outcome.
export function getEventLifecycleStatus(event: unknown): string {
  const properties = eventField(event, "properties");
  const infoStatus =
    eventString(properties, "info", "status")
    ?? eventString(properties, "info", "status", "type")
    ?? eventString(event, "data", "info", "status")
    ?? eventString(event, "data", "info", "status", "type");
  if (infoStatus) return normalizeStatus(infoStatus);
  const status =
    eventString(properties, "status")
    ?? eventString(properties, "status", "type");
  if (status) return normalizeStatus(status);
  const source = eventWord(event, "type") + eventWord(event, "name");
  if (source.includes("idle")) return "idle";
  if (source.includes("error")) return "error";
  if (source.includes("delet")) return "deleted";
  return source.includes(".") ? (source.split(".").pop() ?? "").toLowerCase() : source.toLowerCase();
}

/**
 * The two lifecycle words that end a task BADLY rather than successfully.
 *
 * The lifecycle status itself is an OPEN vocabulary — it is whatever the host
 * said, lowercased — so it cannot be an enum, and that means a comparison against
 * these two words is a raw literal in a place that has to know them. So they are
 * named here, once, and every caller asks the question instead of restating the
 * answer. A caller that spells its own copy of this pair is a caller whose idea
 * of "the child died" can drift from everyone else's.
 */
const ENDED_BADLY = ["error", "deleted"] as const;

/** Did this lifecycle status end the task in failure rather than in success? */
export function endedBadly(status: string): boolean {
  return (ENDED_BADLY as readonly string[]).includes(status);
}

const TERMINAL_EVENT_STATUSES = ["idle", "completed", "error", "deleted"];

// The turn-ending events are named in host-events.ts against the SDK's own union
// — no `includes("delet")` substring guess, which is what a belief that
// "spellings differ across releases" buys: a typo'd name matches nothing and a
// near-miss name matches too much. The sync channel also carries lifecycle state
// in data.info.status, so that remains a terminal signal.
export function isTerminalSessionEvent(event: unknown): boolean {
  const type = eventWord(event, "type");
  if (isTurnEnding(type)) return true;
  if (type === SESSION_DELETED) return true;
  return TERMINAL_EVENT_STATUSES.includes(getEventLifecycleStatus(event));
}

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
    && TASK_STATES.includes(state as TaskState)
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
 */
export interface LoadedTaskLedger extends TaskLedgerFile {
  discarded: string | null;
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
    && typeof kind === "string" && NOTIFY_KINDS.some((known) => known === kind)
    && typeof text === "string" && text.length > 0
    && typeof attempts === "number" && Number.isFinite(attempts)
  );
}

// The identity, routing and admission facts both durable halves carry. Built in
// one expression: a hydrated record is complete at birth. Post-construction
// field assignment would belong to the state machine (task-state), and the
// lifecycle scanner rightly forbids it here.
function hydratedBase(entry: ValidLedgerEntry): TaskRecordBase {
  const dependsOn = entry.dependsOn;
  const dependsOnSettled = entry.dependsOnSettled;
  const requestedModel = entry.requestedModel;
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
      && typeof requestedModel["providerID"] === "string"
      && typeof requestedModel["modelID"] === "string"
      ? { requestedModel: { providerID: requestedModel["providerID"], modelID: requestedModel["modelID"] } }
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
  let dropped = 0;
  if (filePath && existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!isEventRecord(parsed) || parsed.version !== TASK_LEDGER_VERSION || !isEventRecord(parsed["tasks"])) {
        const version = isEventRecord(parsed) ? JSON.stringify(parsed["version"]) : "not an object";
        discarded = `unreadable as a v${TASK_LEDGER_VERSION} ledger file (version field: ${version})`;
      } else {
        if (Array.isArray(parsed["pending"])) {
          for (const entry of parsed["pending"]) {
            if (isPendingDelivery(entry)) pending.push(entry);
            else dropped++;
          }
        }
        if (isEventRecord(parsed["active"])) {
          for (const [key, entry] of Object.entries(parsed["active"])) {
            if (isValidLedgerEntry(entry) && entry.state === TaskState.Active && entry.childSessionId === key) {
              active.set(key, { ...hydratedBase(entry), state: TaskState.Active });
            } else {
              dropped++;
            }
          }
        }
        for (const [key, entry] of Object.entries(parsed["tasks"] as Record<string, unknown>)) {
          // The map key is canonical identity: an entry disagreeing with its key
          // is corrupt, not merely mislabeled.
          if (isValidRetainedEntry(entry) && key.startsWith("ses_") && entry.childSessionId === key) {
            const abortError = entry["abortError"];
            retained.set(key, {
              ...hydratedBase(entry),
              state: entry.state,
              retainedAt: entry.retainedAt,
              ...(typeof abortError === "string" ? { abortError } : {}),
            });
          } else {
            dropped++;
          }
        }
        if (dropped > 0) discarded = `${dropped} record(s) in the file failed validation and were dropped`;
      }
    } catch (error: unknown) {
      // A torn write is the ordinary way to get here, and this is the one place
      // it is survivable: the file is all the plugin has, and a partial parse is
      // still a record of what the last boot knew.
      discarded = `unparseable (${errorMessage(error)})`;
    }
  }
  return { retained, active, pending, discarded };
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
  return { retained, active, pending };
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

// Parent session resolution: the SDK context field first, then the
// historical spellings. Deliberately not `extends ToolContext`: ToolContext.metadata is a method,
// so this shape is a structural subset. No ambient fallback: a stray env var
// must never route root-session prompts to a phantom parent — callers that
// need an injected identity pass it in the context.
export interface SessionContext {
  sessionID?: string;
  sessionId?: string;
  session_id?: string;
}

/**
 * The parent a child records when there is none to name.
 *
 * It is a load-bearing word, not a placeholder: it is the only thing that makes
 * a non-delivery read as "this child has no parent to notify" instead of "no
 * event has arrived yet" in task_result. Four modules produced it and three
 * tested for it, all as a bare literal in a `string` field, so nothing but a
 * reader's memory kept the producer and the checkers in agreement — a change to
 * the convention would have moved the writes and left the checks, and the
 * rendering would have started calling a parentless child undelivered by some
 * other reason.
 *
 * Produce it with `|| UNKNOWN_PARENT`, test it with isParentless.
 */
export const UNKNOWN_PARENT = "unknown";

/** Whether a parent id names nobody: absent, or the recorded unknown. */
export function isParentless(parentSessionId: string | null | undefined): boolean {
  return !parentSessionId || parentSessionId === UNKNOWN_PARENT;
}

export function resolveParentSessionId(ctx: SessionContext): string | null {
  if (!isEventRecord(ctx)) return null;
  const record = ctx as Record<string, unknown>;
  const session = isEventRecord(record["session"]) ? record["session"] : undefined;
  const candidates: unknown[] = [
    record["sessionID"],
    record["sessionId"],
    record["session_id"],
    session ? session["id"] : undefined,
    record["id"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

// Session-create responses arrive wrapped in the transport envelope and, under
// some hosts, a second session envelope — unwrap known shells recursively,
// never blindly.
export function validateSessionResult(result: unknown): string | null {
  if (!isEventRecord(result)) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  for (const inner of envelopeShells(record)) {
    const found = validateSessionResult(inner);
    if (found) return found;
  }
  return null;
}

// session.deleted may arrive name-only (no status field): a vanished session
// is a failure, never a clean completion — deletion needs two probes.
export function eventLooksDeleted(event: unknown): boolean {
  const type = eventWord(event, "type");
  const name = eventWord(event, "name");
  return type.includes("deleted") || name.includes("deleted");
}
