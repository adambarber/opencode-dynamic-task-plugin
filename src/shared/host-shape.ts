// src/shared/host-shape.ts
// Total, non-throwing readers into host shapes — the bottom of the dependency
// graph for anything the host hands us (event payloads, session-API envelopes,
// tool arguments).
//
// They live here, apart from session-lifecycle, because they are a shape layer
// with no policy in them: the lifecycle module needs them, and host-events —
// which pins event NAMES against the SDK's union — needs them too. Keeping them
// in session-lifecycle made host-events depend on the module that would depend
// on it back. This module imports nothing, so that cycle cannot exist.

/**
 * The only sanctioned narrowing of a host payload. Field access goes through
 * eventField/eventString and never through a cast: a cast is a claim about a
 * shape nobody checked, and these readers are how a claim gets checked.
 */
export function isEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read a nested field by path, stopping at the first non-record. */
export function eventField(event: unknown, ...path: string[]): unknown {
  let current: unknown = event;
  for (const key of path) {
    if (!isEventRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * A host string field as a word: an absent one is `""`, never undefined, so a
 * comparison against the host's vocabulary below is total rather than a
 * three-armed `??`.
 *
 * A reader that answers undefined leaves every consumer to decide what absence
 * means, and four consumers in the event module each answered it the same way
 * while looking like four independent decisions. The entry's debug line wants
 * "(none)" for a human instead, which is a different decision and keeps saying
 * so in its own words.
 */
export const eventWord = (event: unknown, ...path: string[]): string => eventString(event, ...path) ?? "";

/**
 * Read a nested field as a non-empty string, or undefined.
 */
export function eventString(event: unknown, ...path: string[]): string | undefined {
  const value = eventField(event, ...path);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The one way this codebase turns an unknown throwable into words.
 *
 * It lived in session-lifecycle, which is the wrong floor for it twice over: the
 * modules that most need to name a failure are the low ones (the notification
 * gate, the tool executors), and they could only reach it by importing a module
 * that imports them back. One site paid for that with a hand-rolled
 * `error instanceof Error ? error.message : String(error)` — a second spelling
 * of a reader that already exists, and the one spelling that loses an error
 * object's `message` when it is a record rather than an Error.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isEventRecord(error) && "message" in error) return String(error["message"]);
  return String(error);
}

/**
 * An agent as the host's API describes it: a name, and whatever else it said.
 *
 * It lives in the shape layer rather than beside the admission gate that first
 * needed it, because the dispatch policy reads the same record from the other
 * side and cannot import a module that imports it. Two spellings of "an agent,
 * unvalidated" meant two places for a field to be forgotten — and the second
 * spelling was anonymous, so the policy function's parameter said nothing about
 * what it was being handed.
 */
export interface AgentRecord {
  name: string;
  [key: string]: unknown;
}
