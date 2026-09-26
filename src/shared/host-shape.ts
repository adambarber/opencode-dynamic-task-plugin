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

/** Read a nested field as a non-empty string, or undefined. */
export function eventString(event: unknown, ...path: string[]): string | undefined {
  const value = eventField(event, ...path);
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
