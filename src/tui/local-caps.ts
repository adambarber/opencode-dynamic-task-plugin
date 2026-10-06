// The TUI's own memory of the caps.
//
// The channel is a route to the server plugin's store, so it can be absent — the server
// plugin is not loaded, or the host is restarting — and a screen with no second source
// answers that by showing nothing at all. Which reads as "you have no caps" and is a
// claim about the project that nobody made. `not_writable` from the server says the same
// thing in the same way.
//
// So the caps are kept here too, in process, on every path that learns them. It is what
// the screen draws when the channel cannot answer, and it is the value a just-completed
// write confirms from immediately rather than after a round trip. Whether it was read
// back from the store or only ever written is KEPT, because the two are different claims
// and the screen has to say which one it is making.

//jscpd:ignore-start
import type { AgentOverlay } from "../shared/caps.js";

//jscpd:ignore-end
/** One project's last known caps, and how far that is known. */
interface Remembered {
  /** True when the store itself produced this, false when only a write confirmed it. */
  verified: boolean;
  overlay: AgentOverlay;
}

/**
 * Keyed by directory because the key is the project, and a window on one project must
 * not draw another's caps — the whole reason the channel carries a location. Process
 * lifetime: a TUI that outlives the server plugin is exactly the case this is for, and a
 * cache that outlived the operator's edits would not be.
 */
const memory = new Map<string, Remembered>();

/**
 * Learn the caps from the store. This is the verified half: the value came from the
 * place the dispatch path reads, so the screen is drawing in-force limits.
 */
export function rememberVerified(directory: string, overlay: AgentOverlay): void {
  memory.set(directory, { overlay, verified: true });
}

/**
 * Learn the caps from a write the channel accepted.
 *
 * NOT verified, and that is the whole distinction: the server acknowledged the write and
 * nothing has read it back. A screen drawing this says so rather than presenting an
 * unconfirmed write as the store's contents, because the operator's next decision is
 * usually whether to trust it.
 */
export function rememberWritten(directory: string, overlay: AgentOverlay): void {
  const wasVerified = memory.get(directory)?.verified === true;
  memory.set(directory, { overlay, verified: wasVerified });
}

/** What the screen can draw without the channel, or `undefined` if it has never learned. */
export function remembered(directory: string): { overlay: AgentOverlay; verified: boolean } | undefined {
  return memory.get(directory);
}

/**
 * Forget one project.
 *
 * There because a project directory is reused — a second window on the same tree is a
 * new screen, not a new project, and a reload must not hand it last session's caps as if
 * they were current.
 */
export function forget(directory: string): void {
  memory.delete(directory);
}