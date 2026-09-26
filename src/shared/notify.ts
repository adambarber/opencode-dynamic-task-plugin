// Notification gate (Task 05): one parent-write primitive, one delivery ledger.
// Kinds: completed/error settle a task once (the lifecycle event drives them);
// "notice" is the child's general mid-flight voice — progress, findings, or a
// block needing parent input — deduped by message text so verbatim repeats land
// once while new information always passes.
// The plugin arms no timers of its own; every deadline it does have is owned by
// execution-bound, including the one on the parent prompt itself — the host
// holds a write to a mid-turn parent rather than refusing it, so "slow" and
// "never" are the same call from inside the gate.
import type { OpenCodeClient } from "./client";
import { withBound, WRITE_BOUNDS } from "./execution-bound.js";

// Client logging that never throws: a dead log call must not break a
// lifecycle path. Best-effort visibility, owned beside the parent-write gate.
export async function safeLog(
  client: OpenCodeClient,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await client.app.log({ body: { service: "dynamic-task", level, message } });
  } catch {
    // logging is best-effort by design
  }
}

export type NotifyKind = "completed" | "error" | "notice";

export interface NotificationRecord {
  at: number;
  parentSessionId: string;
  childSessionId: string;
  kind: NotifyKind;
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

const notifyLedger: NotificationRecord[] = [];
// Tenet 9: process-global by design — every key is a server-unique child
// session id, so two plugin instances cannot share a key; only the bounded
// memory window is shared, which is benign.
const NOTIFY_LEDGER_MAX = 200;

export function recordNotification(entry: NotificationRecord): void {
  notifyLedger.push(entry);
  if (notifyLedger.length > NOTIFY_LEDGER_MAX) notifyLedger.shift();
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

// Event-driven kinds only: terminal statuses map to the two settlement kinds;
// deletion is a failure, never a success (a vanished session did not finish).
export function resolveNotifyKind(status: string): NotifyKind | null {
  if (status === "error" || status === "deleted") return "error";
  if (status === "idle") return "completed";
  return null;
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
      if (delivered.size > GATE_MAX_CHILDREN) {
        const oldest = delivered.keys().next();
        if (!oldest.done) delivered.delete(oldest.value);
      }
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
  const emit = (outcome: { delivered: boolean; attempts: number; suppressed?: boolean; pending?: boolean }): void =>
    record({
      at: Date.now(), parentSessionId, childSessionId: opts.childSessionId, kind, message,
      attempts: outcome.attempts, delivered: outcome.delivered,
      ...(outcome.suppressed ? { suppressed: true } : {}),
      ...(outcome.pending ? { pending: true } : {}),
    });
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
  const commit = (outcome: { delivered: boolean; attempts: number }) => {
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
    emit(outcome);
    return outcome.delivered;
  };
  const run = async (): Promise<boolean> => {
    // The request is made ONCE and kept, because "slow" and "never" are the
    // same call from here: its answer may arrive long after this returns, and
    // the ledger must be able to say so rather than guess which it was.
    const request = attempt();
    const bounded = await withBound(WRITE_BOUNDS.parentPrompt, () => request, () => null).catch(() => null);
    if (bounded?.timedOut) {
      // Same epoch rule as commit(): the held write is recorded only while the
      // gate still knows the child it belongs to.
      if (epoch === gateEpoch) emit({ delivered: false, attempts: 1, pending: true });
      // A held write is NOT retried — the host may still deliver it, and a
      // second copy of the same kind is the duplicate this gate exists to
      // prevent. The claim stays held while the request is outstanding, so
      // nothing slips in behind it, and the record ends up truthful whenever
      // the host finally answers.
      void request.then(
        () => commit({ delivered: true, attempts: 1 }),
        () => commit({ delivered: false, attempts: 2 }),
      );
      return false;
    }
    if (bounded) return commit({ delivered: true, attempts: 1 });
    // The request FAILED rather than merely ran long — a busy parent can also
    // refuse outright, and one retry has always been the gate's answer to that.
    await sleep(NOTIFY_RETRY_DELAY_MS);
    try {
      await attempt();
      return commit({ delivered: true, attempts: 2 });
    } catch {
      return commit({ delivered: false, attempts: 2 });
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
  notice: { tag: "[dynamic-task-notice]", header: "Message from a running child task:", bodyLabel: "", tail: "If the child needs input, reply with task_continue(session_id=...); the task stays active until it settles." },
};

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
  return [
    shape.tag,
    shape.header,
    `Session: ${state.childSessionId}`,
    `Description: ${state.description}`,
    body,
    ...(shape.tail ? [shape.tail] : []),
  ].join("\n");
}

export function truncateText(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

// Push-path bound: the notification is injected into the parent's
// conversation, so it stays bounded — but truncation is never silent: the
// tail names the full-text recovery path (the pull path is untruncated).
export const NOTIFICATION_MAX_CHARS = 8000;
