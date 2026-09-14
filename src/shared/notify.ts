// Notification gate (Task 05): one parent-write primitive, one delivery ledger.
// Kinds: completed/error settle a task once (the lifecycle event drives them);
// "notice" is the child's general mid-flight voice — progress, findings, or a
// block needing parent input — deduped by message text so verbatim repeats land
// once while new information always passes.
// The plugin arms no timers; only the parent prompt itself is bounded by transport.
import type { OpenCodeClient } from "./client";

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
}

const notifyLedger: NotificationRecord[] = [];
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

export function clearNotifyLedger(): void {
  notifyLedger.length = 0;
  gateLedger.clear();
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
  record(childSessionId: string, dedupKey: string): boolean;
  // Revival resets settle-dedup: a continued task is a fresh settlement
  // subject, so its next completed/error must be deliverable even though the
  // prior turn's kind was recorded. Delivery history stays in the ledger.
  forgetChild(childSessionId: string): void;
  // In-flight claim: closes the check-then-act race between concurrent
  // same-key writers. A claim is synchronous; the winner dials, losers are
  // suppressed before touching transport. Released on delivery failure so a
  // failed settlement stays redeliverable — only success reserves the key.
  claim(childSessionId: string, dedupKey: string): boolean;
  release(childSessionId: string, dedupKey: string): void;
  // Test-only isolation: the gate is process-global by design.
  clear(): void;
}

// Notification decisions are process memory; durable task state is the ledger.
// Tenet 8: one place to grep for "who got told what, once". dedupKey defaults
// to kind (settle-once semantics); "notice" callers pass a message-derived key.
// Session ids are globally unique, so entries outlive their usefulness once a
// child leaves the retained ledger — the gate is FIFO-bounded to stay honest
// about exactly-once without growing without limit.
const GATE_MAX_CHILDREN = 1000;

function duplicateOf(map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): boolean {
  return map.get(childSessionId)?.has(dedupKey) ?? false;
}

function createGateLedger(): GateLedger {
  const delivered = new Map<string, Set<string>>();
  const inFlight = new Map<string, Set<string>>();
  const drop = (map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): void => {
    const keys = map.get(childSessionId);
    if (!keys) return;
    keys.delete(dedupKey);
    if (keys.size === 0) map.delete(childSessionId);
  };
  return {
    record(childSessionId, dedupKey) {
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
      if (duplicateOf(delivered, childSessionId, dedupKey) || duplicateOf(inFlight, childSessionId, dedupKey)) return false;
      const pending = inFlight.get(childSessionId) ?? new Set();
      pending.add(dedupKey);
      inFlight.set(childSessionId, pending);
      return true;
    },
    release(childSessionId, dedupKey) {
      drop(inFlight, childSessionId, dedupKey);
    },
    forgetChild(childSessionId) {
      delivered.delete(childSessionId);
      inFlight.delete(childSessionId);
    },
    clear() {
      delivered.clear();
      inFlight.clear();
    },
  };
}

export const gateLedger = createGateLedger();

// Per-child serialization: detached deliveries of one child execute in claim
// order, so a stale retry can never land after a newer turn's message. Only
// transport is serialized — claims stay synchronous, and the chain is dropped
// once its tail settles so child ids never leak.
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
  const emit = (delivered: boolean, attempts: number) =>
    record({ at: Date.now(), parentSessionId, childSessionId: opts.childSessionId, kind, message, attempts, delivered });
  if (!gateLedger.claim(opts.childSessionId, dedupKey)) {
    emit(false, 0);
    return Promise.resolve(false);
  }
  const attempt = () =>
    client.session.prompt({
      path: { id: parentSessionId },
      body: { parts: [{ type: "text", text: message }] },
    });
  const commit = (delivered: boolean, attempts: number) => {
    gateLedger.release(opts.childSessionId, dedupKey);
    if (delivered) gateLedger.record(opts.childSessionId, dedupKey);
    emit(delivered, attempts);
    return delivered;
  };
  const run = async (): Promise<boolean> => {
    try {
      await attempt();
      return commit(true, 1);
    } catch {
      await sleep(NOTIFY_RETRY_DELAY_MS);
      try {
        await attempt();
        return commit(true, 2);
      } catch {
        return commit(false, 2);
      }
    }
  };
  const prev = notifyChains.get(opts.childSessionId) ?? Promise.resolve();
  const cur: Promise<boolean> = prev.then(run, run);
  notifyChains.set(opts.childSessionId, cur);
  void cur.then(
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
  );
  return cur;
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
// everywhere the kinds differ: header, body label, tail hint.

const NOTIFICATION_KINDS: Record<NotifyKind, { header: string; bodyLabel: string; tail: string }> = {
  completed: { header: "Background task completed successfully.", bodyLabel: "Latest output", tail: "" },
  error: { header: "Background task ended with an error.", bodyLabel: "Latest output", tail: "Use task_result or task_continue to inspect or recover." },
  notice: { header: "Message from a running child task:", bodyLabel: "", tail: "If the child needs input, reply with task_continue(session_id=...); the task stays active until it settles." },
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
    "[dynamic-task-notify]",
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
