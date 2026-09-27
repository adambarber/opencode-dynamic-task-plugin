// Notification gate (Task 05): one parent-write primitive, one delivery ledger.
// Kinds: completed/error settle a task once (the lifecycle event drives them);
// "notice" is the child's general mid-flight voice — progress, findings, or a
// block needing parent input — deduped by message text so verbatim repeats land
// once while new information always passes.
// The plugin arms no timers of its own; every deadline it does have is owned by
// execution-bound, including the one on the parent prompt itself — the host
// holds a write to a mid-turn parent rather than refusing it, so "slow" and
// "never" are the same call from inside the gate.
import { LedgerChangeKind, type LedgerChange } from "./ledger-change.js";
import type { OpenCodeClient } from "./client";
import { withBound, WRITE_BOUNDS } from "./execution-bound.js";
import { textBlock } from "./text-block.js";
import { evictOldest } from "./bounded-map.js";
import { errorMessage } from "./host-shape.js";
import { TaskState, type SettlementVerdict } from "./task-state.js";

// Client logging that never throws: a dead log call must not break a
// lifecycle path. Best-effort visibility, owned beside the parent-write gate.
/**
 * The one host call logging needs — OPTIONAL, and that is the point.
 *
 * Narrower than `OpenCodeClient` for the same reason `AgentLister` is narrower than it:
 * every call site of this function uses it to reach `app.log` and nothing else, and a
 * parameter typed as the whole client rejects a caller holding a different SDK
 * generation's client over capabilities this function never touches. The alternative
 * was a cast at each such caller, and a cast is an assertion that outlives its reason.
 *
 * The log call itself is optional because the two SDK generations spell it
 * differently and a client from the TUI side cannot be required to carry the server
 * side's shape. Requiring it would mean a cast on the one path that logs a failed
 * agent read — and this function has ALWAYS swallowed every failure, including a
 * missing call, so a client that cannot log is not a new case. Making that guarantee
 * structural is better than making it true by inspection of a try block.
 */
export interface LogSink {
  // `unknown`, and that is the point: the call is CHECKED at the boundary rather than
  // asserted in a type. The two SDK generations this plugin runs against spell `app.log`
  // differently — the server's takes `{ body }` and the TUI's takes an optional query
  // object with a wider body — so no single signature accepts both, and writing one
  // would have rejected a client that logs perfectly well. The alternative was a cast
  // at every cross-process call site; this is one named question instead.
  app: { log?: unknown };
}

/** The body this plugin writes, and the only one it writes. */
interface LogBody {
  service: string;
  level: "info" | "warn" | "error";
  message: string;
}

/**
 * The `app.log` call, or null when this client has no usable one.
 *
 * The same sanctioned idiom as `hasQuestionCall` below, for the same reason: the cast
 * widens to an untyped map to ASK whether the key is a function, which is the question
 * — it does not assert an answer. Narrowing what was found is a second step with its
 * own check, so a client whose `log` is a string of the wrong length fails to log
 * rather than throwing inside a catch that swallows it.
 */
function hostLogCall(client: LogSink | null | undefined): ((args: { body: LogBody }) => Promise<unknown>) | null {
  const log = client?.app?.log;
  if (typeof log !== "function") return null;
  const call = log as (args: { body: LogBody }) => Promise<unknown>;
  return typeof call === "function" ? call : null;
}

export async function safeLog(
  client: LogSink,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  const log = hostLogCall(client);
  if (!log) return;
  try {
    await log({ body: { service: "dynamic-task", level, message } });
  } catch {
    // logging is best-effort by design
  }
}

/**
 * Contain a failure in work that must not take the host's turn with it: one
 * normalization of the unknown, one level, and the caller's own words for what
 * failed and what was done about it.
 *
 * Not a wrapper for every catch. A child that was created and then failed has to
 * be aborted, and that arm keeps its own body — that failure is not contained,
 * it is undone. This is for the failures the process walks away from, and the
 * level is warn because the turn continued: a failure worth `error` here would
 * be one the turn did not survive.
 *
 * The two callers that need this arm each restated it, and one of them spelled
 * the normalization out by hand while the other used errorMessage — two
 * spellings of one fact about an unknown throwable, which is the drift this
 * arrangement exists to end.
 */
export async function containFailure(
  client: OpenCodeClient,
  what: string,
  error: unknown,
  tail = "",
): Promise<void> {
  await safeLog(client, "warn", `${what}: ${errorMessage(error)}${tail ? `; ${tail}` : ""}`);
}

/**
 * What a settlement or a mid-flight notice tells the parent, as an enum rather
 * than a string-literal union: a union invites `kind === "notice"`, and a raw
 * literal in a comparison is a rename that compiles clean. The member is the
 * value; the literal is only what the parent reads on the wire.
 */
export enum NotifyKind {
  Completed = "completed",
  Error = "error",
  Blocked = "blocked",
  Notice = "notice",
}

/**
 * Who a delivery is for. The two records that carry a delivery each spelled this
 * triple out, and it is the triple owedIdentity hashes — so a field added to
 * "which parent, which child, which kind" had two declarations to reach and a
 * third meaning to keep in step.
 */
export interface DeliveryTarget {
  parentSessionId: string;
  childSessionId: string;
  kind: NotifyKind;
}

export interface NotificationRecord extends DeliveryTarget {
  at: number;
  message: string;
  attempts: number;
  delivered: boolean;
  // Set only on the duplicate-suppression path: a verbatim repeat that never
  // dialed. Distinct from a failed delivery — nothing was attempted.
  suppressed?: boolean;
  // The host HOLDS a write to a parent that is mid-turn rather than refusing
  // it, and a held request can outlive any parent's attention span (twenty
  // minutes, observed). A pending record says exactly that: dialed, not yet
  // answered, and the parent may still receive it. It is neither a failure nor a
  // success, and it stays in the ledger until the host answers either way.
  pending?: boolean;
}

const notifyLedger: NotificationRecord[] = [];// Tenet 9: process-global by design — every key is a server-unique child
// session id, so two plugin instances cannot share a key; only the bounded
// memory window is shared, which is benign.
const NOTIFY_LEDGER_MAX = 200;

/**
 * What the gate knows when it writes a delivery down: the target, the exact text,
 * and how the write ended. One assembly of a NotificationRecord, because the
 * optional fields are the claim that distinguishes a suppression, a held write
 * and a failure — and the entry's own non-delivery (there is no parent to dial)
 * was assembling the record by hand beside it.
 */
/**
 * How a write ended: the record's own outcome fields, picked rather than written
 * out. The three spellings this replaces were each a hand-maintained copy of four
 * fields declared twenty lines above, so a fourth outcome could be added to the
 * record and silently not reach the builder or the emit.
 */
export type DeliveryOutcome = Pick<NotificationRecord, "delivered" | "attempts" | "suppressed" | "pending">;

export function notifyRecord(
  target: DeliveryTarget,
  message: string,
  outcome: DeliveryOutcome,
): NotificationRecord {
  return {
    ...target,
    at: Date.now(),
    message,
    attempts: outcome.attempts,
    delivered: outcome.delivered,
    ...(outcome.suppressed ? { suppressed: true } : {}),
    ...(outcome.pending ? { pending: true } : {}),
  };
}

export function recordNotification(entry: NotificationRecord): void {
  notifyLedger.push(entry);
  if (notifyLedger.length > NOTIFY_LEDGER_MAX) notifyLedger.shift();
}

/**
 * The debt the gate writes down before dialing. The queue and the receipt are the
 * same owed write at two attempt counts, so it is assembled once here rather than
 * spelled out at the gate and again by whatever seeds a ledger.
 */
export function owedDelivery(target: DeliveryTarget, text: string, attempts: number): PendingDelivery {
  return { ...target, text, attempts };
}

export function getLatestNotification(childSessionId: string): NotificationRecord | null {
  for (let i = notifyLedger.length - 1; i >= 0; i--) {
    const entry = notifyLedger[i];
    if (entry && entry.childSessionId === childSessionId) return entry;
  }
  return null;
}

// Turn-scoped read: a revived task is a new turn (fresh startedAt), so
// history from before its start belongs to the previous turn and must not
// read as the current turn's status. Same-ms records still show — harmless.
export function getTurnNotification(childSessionId: string, turnStartedAt: number): NotificationRecord | null {
  const latest = getLatestNotification(childSessionId);
  if (!latest || latest.at < turnStartedAt) return null;
  return latest;
}

// ── Durable delivery queue (docs/tasks/11-durability.md, M2) ──────────────
// The delivery ledger above is process memory, so a crash between "the task
// settled" and "the parent was told" left a record reading `completed` with no
// notice and no evidence one was owed — the one failure mode the gate cannot
// otherwise see. This queue is that missing evidence: an entry is written BEFORE
// the dial and retired only when the outcome is known, so a crash costs a
// duplicate notice, which is visible, instead of a silent deafness, which is not.
// At-least-once across a restart, exactly-once within a boot — deliberately.
export interface PendingDelivery extends DeliveryTarget {
  /** The exact text owed. A redelivery must not have to reconstruct it. */
  text: string;
  /** How many attempts the boots before this one already spent. */
  attempts: number;
}

// The kinds, as data: the ledger reader validates a restored entry against this
// list, so the two can never disagree about what a kind is.
export const NOTIFY_KINDS: readonly NotifyKind[] = Object.values(NotifyKind);

/**
 * The one place a settlement's verdict and its notification kind meet.
 *
 * They are the same three words, and they are two types because they are two
 * different facts: the verdict is what the RECORD says happened, the kind is
 * what the PARENT is told. A switch rather than a lookup table so adding a
 * verdict is a compile error here, in the one function that has to answer for
 * it — a table would default and let a new ending be announced as something it
 * is not, which is the false-success claim this plugin exists to avoid.
 */
export function settlementKind(verdict: SettlementVerdict): NotifyKind {
  switch (verdict) {
    case TaskState.Completed:
      return NotifyKind.Completed;
    case TaskState.Error:
      return NotifyKind.Error;
    case TaskState.Blocked:
      return NotifyKind.Blocked;
  }
}

const pendingDeliveries: PendingDelivery[] = [];
// Installed once at boot by the persistence dance. Tenet 9: process-global by
// design — every entry is keyed by a server-unique child session id.
let persistPending: ((changes: readonly LedgerChange[]) => void) | null = null;

export function configurePendingPersistence(persist: (changes: readonly LedgerChange[]) => void): void {
  persistPending = persist;
}

export function getPendingDeliveries(): PendingDelivery[] {
  return pendingDeliveries.slice();
}

/** Boot hydration: what the ledger owed becomes what this process owes. */
export function restorePendingDeliveries(entries: PendingDelivery[]): void {
  pendingDeliveries.length = 0;
  pendingDeliveries.push(...entries);
}

// One owed write per gate claim. A settlement is identified by its kind; a notice
// by its text, which is exactly what the gate dedups notices on
// (noticeDedupKey), so this reproduces the claim's identity without keeping a
// second copy of the key. Two DIFFERENT notices from one child are two debts.
/**
 * What makes two owed notices the SAME notice. Exported because the ledger merge
 * has to answer that question too, and a second spelling of identity would let
 * one notice be written as two and dropped as one.
 */
export function owedIdentity(entry: PendingDelivery): string {
  return entry.kind === NotifyKind.Notice ? `${entry.childSessionId}\u0000notice\u0000${entry.text}` : `${entry.childSessionId}\u0000${entry.kind}`;
}

// "Is this one already owed, and where" — the single read both queue writers need,
// composed once so the pair cannot disagree about what identity means.
function indexOfOwedEntry(entry: PendingDelivery): number {
  return indexOfOwed(owedIdentity(entry));
}

function queuePending(entry: PendingDelivery): void {
  const at = indexOfOwedEntry(entry);
  if (at === -1) pendingDeliveries.push(entry);
  else pendingDeliveries[at] = entry;
  // The notice itself is the change, so the shared ledger is told which one was
  // owed rather than being handed this process's whole queue to re-serialize.
  persistPending?.([{ kind: LedgerChangeKind.Owed, record: entry }]);
}

function dropPending(entry: PendingDelivery): void {
  const at = indexOfOwedEntry(entry);
  if (at === -1) return;
  pendingDeliveries.splice(at, 1);
  persistPending?.([{ kind: LedgerChangeKind.Delivered, record: entry }]);
}

function indexOfOwed(identity: string): number {
  return pendingDeliveries.findIndex((owed) => owedIdentity(owed) === identity);
}

// Bumped by every reset. A claim remembers the epoch it was issued under, so an
// answer that arrives after the gate was reset cannot land in the new world —
// where the same child id may belong to an entirely different child, and a
// stale "delivered" would suppress that child's real first notification. The
// per-child generation cannot catch this: a reset restarts those at zero.
let gateEpoch = 0;

export function clearNotifyLedger(): void {
  notifyLedger.length = 0;
  gateLedger.clear();
  gateEpoch++;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

const NOTIFY_RETRY_DELAY_MS = 250;

interface NotifyParentOptions {
  sleep?: (ms: number) => Promise<void>;
  record?: (entry: NotificationRecord) => void;
  childSessionId: string;
  kind: NotifyKind;
  dedupKey?: string;
  // Attempts earlier boots already spent on this exact write, restored from the
  // durable queue. Counting from there is what makes a redelivery that keeps
  // getting held escalate visibly instead of looking like a fresh first try.
  carriedAttempts?: number;
}

interface GateLedger {
  record(childSessionId: string, dedupKey: string, generation: number): boolean;
  // Revival resets settle-dedup: a continued task is a fresh settlement
  // subject, so its next completed/error must be deliverable even though the
  // prior turn's kind was recorded. Delivery history stays in the ledger.
  // Bumping the generation is what makes that safe against in-flight work:
  // claims/commits from before the bump can no longer reserve keys.
  forgetChild(childSessionId: string): void;
  // In-flight claim: closes the check-then-act race between concurrent
  // same-key writers. A claim is synchronous; the winner dials, losers are
  // suppressed before touching transport. Returns the generation the claim
  // was bound to (null = refused), so the later commit can prove it still
  // belongs to the current turn. Released on delivery failure so a failed
  // settlement stays redeliverable — only success reserves the key.
  claim(childSessionId: string, dedupKey: string): number | null;
  release(childSessionId: string, dedupKey: string, generation: number): void;
  // Test-only isolation: the gate is process-global by design.
  clear(): void;
}

// Notification decisions are process memory; durable task state is the ledger.
// Tenet 8: one place to grep for "who got told what, once". dedupKey defaults
// to kind (settle-once semantics); "notice" callers pass a message-derived key.
// Session ids are globally unique, so entries outlive their usefulness once a
// child leaves the retained ledger — the gate is FIFO-bounded to stay honest
// about exactly-once without growing without limit.
// Every key is bound to a per-child generation: forgetChild (revival) bumps it
// and clears the child's pending claims, so an in-flight commit from a
// previous turn emits history but can never reserve the revived turn's key.
const GATE_MAX_CHILDREN = 1000;

function duplicateOf(map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): boolean {
  return map.get(childSessionId)?.has(dedupKey) ?? false;
}

function currentGeneration(generations: Map<string, number>, childSessionId: string): number {
  return generations.get(childSessionId) ?? 0;
}

function createGateLedger(): GateLedger {
  const delivered = new Map<string, Set<string>>();
  const inFlight = new Map<string, Set<string>>();
  const generations = new Map<string, number>();
  const drop = (map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): void => {
    const keys = map.get(childSessionId);
    if (!keys) return;
    keys.delete(dedupKey);
    if (keys.size === 0) map.delete(childSessionId);
  };
  return {
    record(childSessionId, dedupKey, generation) {
      if (currentGeneration(generations, childSessionId) !== generation) return false;
      const kinds = delivered.get(childSessionId) ?? new Set();
      if (kinds.has(dedupKey)) return false;
      kinds.add(dedupKey);
      delivered.set(childSessionId, kinds);
      evictOldest(delivered, GATE_MAX_CHILDREN);
      return true;
    },
    claim(childSessionId, dedupKey) {
      if (duplicateOf(delivered, childSessionId, dedupKey) || duplicateOf(inFlight, childSessionId, dedupKey)) return null;
      const pending = inFlight.get(childSessionId) ?? new Set();
      pending.add(dedupKey);
      inFlight.set(childSessionId, pending);
      return currentGeneration(generations, childSessionId);
    },
    release(childSessionId, dedupKey, generation) {
      // A stale generation's pending entry was already cleared by forgetChild;
      // dropping here could only hit the current generation's claim.
      if (currentGeneration(generations, childSessionId) !== generation) return;
      drop(inFlight, childSessionId, dedupKey);
    },
    forgetChild(childSessionId) {
      const next = currentGeneration(generations, childSessionId) + 1;
      generations.set(childSessionId, next);
      if (generations.size > GATE_MAX_CHILDREN) {
        const oldest = generations.keys().next();
        if (!oldest.done) generations.delete(oldest.value);
      }
      delivered.delete(childSessionId);
      inFlight.delete(childSessionId);
    },
    clear() {
      delivered.clear();
      inFlight.clear();
      generations.clear();
    },
  };
}

export const gateLedger = createGateLedger();

// Per-child serialization: detached deliveries of one child execute in claim
// order, so a stale retry can never land after a newer turn's message. Only
// transport is serialized — claims stay synchronous, and the chain is dropped
// once its tail settles so child ids never leak. The map is FIFO-bounded to
// the same 1000-child window as the dedup gate: an evicted child keeps
// delivery (claims are synchronous) but loses ordering against a re-spawn
// after 1000 other children chained first — bounded memory, documented window.
const notifyChains = new Map<string, Promise<unknown>>();

// The gate: every parent-directed write goes through here. One retry (a busy
// parent prompt can transiently fail), honest failure, recorded either way.
export async function notifyParent(
  client: OpenCodeClient,
  parentSessionId: string,
  message: string,
  opts: NotifyParentOptions,
): Promise<boolean> {
  const kind = opts.kind;
  const sleep = opts.sleep ?? defaultSleep;
  const record = opts.record ?? recordNotification;
  const dedupKey = opts.dedupKey ?? opts.kind;
  const emit = (outcome: DeliveryOutcome): void =>
    record(notifyRecord({ parentSessionId, childSessionId: opts.childSessionId, kind }, message, outcome));
  const generation = gateLedger.claim(opts.childSessionId, dedupKey);
  const epoch = gateEpoch;
  if (generation === null) {
    emit({ delivered: false, attempts: 0, suppressed: true });
    return Promise.resolve(false);
  }
  const attempt = () =>
    client.session.prompt({
      path: { id: parentSessionId },
      body: { parts: [{ type: "text", text: message }] },
    });
  // The owed write, built once: the queue holds the exact text, so a boot that
  // redelivers it has nothing to reconstruct and no way to say something else.
  // Attempts count from the last boot's, so the record and the queue agree on
  // how many times this parent has already been dialed for this write.
  const carried = opts.carriedAttempts ?? 0;
  const owed = owedDelivery({ parentSessionId, childSessionId: opts.childSessionId, kind }, message, carried);
  // Owed BEFORE the dial, every attempt: the debt must be on disk while the
  // request is in flight, because that window is the crash this exists for.
  const dial = async (attempts: number) => {
    queuePending({ ...owed, attempts: carried + attempts });
    return attempt();
  };
  const commit = (outcome: DeliveryOutcome) => {
    // Two kinds of staleness, checked before anything is written:
    // Generation-bound: a revival (forgetChild) between this claim and this
    // commit makes the generation stale — history is emitted, the key is not
    // reserved, and the revived turn's claim stays intact.
    // Epoch-bound: a whole-gate reset between the claim and this commit means
    // the gate no longer knows this child at all, and the record belongs to a
    // world that is gone. Nothing is emitted and nothing is reserved.
    if (epoch !== gateEpoch) return outcome.delivered;
    gateLedger.release(opts.childSessionId, dedupKey, generation);
    if (outcome.delivered) gateLedger.record(opts.childSessionId, dedupKey, generation);
    // Retire the debt, then write the receipt: a crash in between costs a
    // redelivery the operator can see, never a record with no notice behind it.
    dropPending({ ...owed, attempts: outcome.attempts });
    emit(outcome);
    return outcome.delivered;
  };
  const run = async (): Promise<boolean> => {
    // The request is made ONCE and kept, because "slow" and "never" are the
    // same call from here: its answer may arrive long after this returns, and
    // the ledger must be able to say so rather than guess which it was.
    const request = dial(1);
    const bounded = await withBound(WRITE_BOUNDS.parentPrompt, () => request, () => null).catch(() => null);
    if (bounded?.timedOut) {
      // Same epoch rule as commit(): the held write is recorded only while the
      // gate still knows the child it belongs to.
      if (epoch === gateEpoch) emit({ delivered: false, attempts: carried + 1, pending: true });
      // A held write is NOT retried — the host may still deliver it, and a
      // second copy of the same kind is the duplicate this gate exists to
      // prevent. The claim stays held while the request is outstanding, so
      // nothing slips in behind it, and the record ends up truthful whenever
      // the host finally answers.
      void request.then(
        () => commit({ delivered: true, attempts: carried + 1 }),
        () => commit({ delivered: false, attempts: carried + 2 }),
      );
      return false;
    }
    if (bounded) return commit({ delivered: true, attempts: carried + 1 });
    // The request FAILED rather than merely ran long — a busy parent can also
    // refuse outright, and one retry has always been the gate's answer to that.
    await sleep(NOTIFY_RETRY_DELAY_MS);
    try {
      await dial(2);
      return commit({ delivered: true, attempts: carried + 2 });
    } catch {
      return commit({ delivered: false, attempts: carried + 2 });
    }
  };
  const prev = notifyChains.get(opts.childSessionId) ?? Promise.resolve();
  const cur: Promise<boolean> = prev.then(run, run);
  notifyChains.set(opts.childSessionId, cur);
  if (notifyChains.size > GATE_MAX_CHILDREN) {
    const oldest = notifyChains.keys().next();
    if (!oldest.done) notifyChains.delete(oldest.value);
  }
  void cur.then(
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
  );
  return cur;
}

/** Test seam: current per-child delivery chain count. Production never calls this. */
export function notifyChainCount(): number {
  return notifyChains.size;
}

// Notice dedup keys hash the FULL message: a fixed prefix slice collides
// distinct long notices sharing a prefix. FNV-1a, no dependency; length is
// folded in so equal hashes with different lengths still separate.
export function noticeDedupKey(message: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `notice:${(hash >>> 0).toString(36)}:${message.length}`;
}

// Wire format the parent actually sees. Notification text is owned by the
// gate; task-formatting only renders store reads. One renderer, params
// everywhere the kinds differ: tag, header, body label, tail hint.
// Settlement (completed/error) and mid-flight voice (notice) carry distinct
// tags so orchestrators route them without parsing prose.

const NOTIFICATION_KINDS: Record<NotifyKind, { tag: string; header: string; bodyLabel: string; tail: string }> = {
  completed: { tag: "[dynamic-task-notify]", header: "Background task completed successfully.", bodyLabel: "Latest output", tail: "" },
  error: { tag: "[dynamic-task-notify]", header: "Background task ended with an error.", bodyLabel: "Latest output", tail: "Use task_result or task_continue to inspect or recover." },
  blocked: { tag: "[dynamic-task-notify]", header: "Background task needs input from you — it stopped with its question, having delivered no result.", bodyLabel: "What it needs", tail: "Answer with task_continue(session_id=...): the task is settled as blocked and runs again on your answer. If it cannot be answered, task_interrupt ends it." },
  notice: { tag: "[dynamic-task-notice]", header: "Message from a running child task:", bodyLabel: "", tail: "If the child needs input, reply with task_continue(session_id=...); the task stays active until it settles." },
};

/**
 * The tag a kind of parent notification carries. Exported because the tag IS the
 * routing contract — a host orchestrator tells a settlement from a mid-flight notice
 * by it, without parsing prose — so the cases that pin that routing need the tag and
 * not a retyped copy of its two spellings.
 */
export function notificationTag(kind: NotifyKind): string {
  return NOTIFICATION_KINDS[kind].tag;
}

/**
 * Whether a parent-directed text is one of our notifications, by its tag. The tag IS
 * the routing contract — a host orchestrator that routes on it would not parse the
 * prose — so anything that has to tell a notification from child work asks here
 * rather than retyping the two spellings. The mock transport routes on it, which is
 * why a marker that changed without this would have left every test classifying its
 * own notifications as child work and passing.
 */
export function isParentNotification(text: string): boolean {
  return Object.values(NOTIFICATION_KINDS).some((shape) => text.includes(shape.tag));
}

export function formatParentNotification(
  state: {
    childSessionId: string;
    description: string;
  },
  kind: NotifyKind,
  resultText = "",
): string {
  const shape = NOTIFICATION_KINDS[kind];
  const full = resultText.trim() ? resultText : "(No text output)";
  const safeResult = full.length > NOTIFICATION_MAX_CHARS
    ? `${full.slice(0, NOTIFICATION_MAX_CHARS)}... [truncated — full output via task_result(session_id=${state.childSessionId})]`
    : full;
  const body = shape.bodyLabel ? `${shape.bodyLabel}: ${safeResult}` : safeResult;
  return textBlock(
    shape.tag,
    shape.header,
    `Session: ${state.childSessionId}`,
    `Description: ${state.description}`,
    body,
    shape.tail || undefined,
  );
}

export function truncateText(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

// Push-path bound: the notification is injected into the parent's
// conversation, so it stays bounded — but truncation is never silent: the
// tail names the full-text recovery path (the pull path is untruncated).
export const NOTIFICATION_MAX_CHARS = 8000;
