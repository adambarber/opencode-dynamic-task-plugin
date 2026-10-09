// src/shared/session-lifecycle.ts
// Which session is whose parent, and what a create response says about it.
//
// The third of four subjects that used to share this file. The event readers are
// now in host-events.ts (the file that NAMES host events is the file that READS
// them), the abort funnel is in session-abort.ts, and the durable ledger is in
// task-ledger.ts. What is left is the one question none of those answer: not
// "what did the host say" or "may I stop it" or "what survives a crash", but
// "who is this session's parent" — which every task record is built around.
//
// Durable state resolves from the host-provided project `directory` — never
// process CWD, which for tests and multi-project hosts is somebody else's tree.

//jscpd:ignore-start
import { type SessionId, sessionIdOf } from "./ids.js";
import { envelopeShells } from "./host-events.js";
import { eventWord, isEventRecord } from "./host-shape.js";

//jscpd:ignore-end
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
export const UNKNOWN_PARENT = "unknown" as const;

/** The parent a child carries: a real session, or the recorded unknown. */
export type ParentSession = SessionId | typeof UNKNOWN_PARENT;

/** Whether a parent id names nobody: absent, or the recorded unknown. */
export function isParentless(parentSessionId: ParentSession | null | undefined): parentSessionId is typeof UNKNOWN_PARENT | null | undefined {
  return !parentSessionId || parentSessionId === UNKNOWN_PARENT;
}

export function resolveParentSessionId(ctx: SessionContext): SessionId | null {
  if (!isEventRecord(ctx)) return null;
  const record = ctx;
  const session = isEventRecord(record.session) ? record.session : undefined;
  const candidates: unknown[] = [
    record.sessionID,
    record.sessionId,
    record.session_id,
    session ? session.id : undefined,
    record.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const id = sessionIdOf(candidate);
      if (id !== undefined) return id;
    }
  }
  return null;
}

// Session-create responses arrive wrapped in the transport envelope and, under
// some hosts, a second session envelope — unwrap known shells recursively,
// never blindly.
export function validateSessionResult(result: unknown): SessionId | null {
  if (!isEventRecord(result)) return null;
  const record = result;
  if (typeof record.id === "string" && record.id) return sessionIdOf(record.id) ?? null;
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
