// src/shared/liveness.ts
// Liveness, read from its sources (Task 01 follow-up): the server's status
// channel and the child's own messages. Nothing here infers a status from
// message shapes — `session.get` carries no status field, so probing it can
// only ever guess, and a guess is what made a running child read as
// "completed" and a silent turn read as a store that had nothing to say.
//
// One read, one vocabulary. Every renderer that shows liveness renders THIS
// reading, so the two read tools can never drift into disagreeing about the
// same child — which is what turns a status line into a wrong recovery.

import type { OpenCodeClient } from "./client.js";
import { eventField, hostPayload } from "./session-lifecycle.js";
import { extractMessages } from "./prompt.js";

// The server's own words for a session's turn. It has three ("retry" is the
// provider's own, carried through), and a session it does not list has no turn
// running at all — which is a fact, not a gap.
export type HostTurnState = "busy" | "idle" | "retry" | "error";

export interface LivenessReading {
  /** The server's word for this session, or null when it lists none. */
  hostState: HostTurnState | null;
  /** When the child last wrote a message; null when it has written none. */
  lastMessageAt: number | null;
  messageCount: number;
}

/** A turn the server is running: working, or retrying on the provider's behalf. */
export function hostTurnRunning(reading: LivenessReading): boolean {
  return reading.hostState === "busy" || reading.hostState === "retry";
}

/**
 * The status word for a session no store record covers. The server's word is
 * the answer here — with nothing to reconcile it against, the only honest
 * reading is the source's own, and a session it does not list is genuinely
 * unknown rather than quiet-but-alive. "error" folds into completed: the turn
 * is over, and the error text is on the record for anyone reading it.
 */
export function statusFromHostState(hostState: HostTurnState | null): "busy" | "completed" | "unknown" {
  if (hostState === "busy" || hostState === "retry") return "busy";
  if (hostState === "idle" || hostState === "error") return "completed";
  return "unknown";
}

// The host's words, and only its words: the status channel is a map of session
// id to the server's own object, so an unknown entry is an unknown word rather
// than a value to coerce into one.
function hostTurnState(statusResult: unknown, childSessionId: string): HostTurnState | null {
  const entry = eventField(hostPayload(statusResult), childSessionId);
  const type = eventField(entry, "type");
  return type === "busy" || type === "idle" || type === "retry" || type === "error" ? type : null;
}

// The child's own clock: when the last message it wrote finished, or began —
// an unfinished turn has no completion, and its start is the honest floor.
function lastMessageAt(messages: unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const time = eventField(messages[i], "time");
    const completed = eventField(time, "completed");
    const created = eventField(time, "created");
    if (typeof completed === "number") return completed;
    if (typeof created === "number") return created;
  }
  return null;
}

/**
 * Read a child's liveness from both sources. `messages` is the session's
 * already-read message list when the caller has it — task_result needs the
 * list for its summary either way, and re-reading it would be a second copy of
 * the same fetch.
 */
export async function readLiveness(
  client: OpenCodeClient,
  childSessionId: string,
  messages?: unknown[],
): Promise<LivenessReading> {
  const list = messages ?? (await readSessionMessages(client, childSessionId));
  const statusMap = await client.session.status();
  return {
    hostState: hostTurnState(statusMap, childSessionId),
    lastMessageAt: lastMessageAt(list),
    messageCount: list.length,
  };
}

// Read-only session message fetch, shared by every reader of a child.
export async function readSessionMessages(client: OpenCodeClient, sessionId: string): Promise<unknown[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}
