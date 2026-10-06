// The TUI's end of the caps channel.
//
// The dialog must not learn that caps live in the server's store: it is a screen that
// reads an overlay and asks for one to be written. This module is the whole of that
// conversation — the client the host builds, the narrowing of the answer, and the
// refusal that becomes a toast instead of an exception. Both sides are the same
// definition, so a payload the server stops accepting is a payload this stops
// offering.

//jscpd:ignore-start
import { OverlayRpc, readOverlayPayload } from "../shared/overlay-rpc.js";
import { errorMessage, isPlainRecord } from "../shared/host-shape.js";
import type { AgentOverlay } from "../shared/caps.js";
import type { OverlayRead } from "../shared/overlay-store.js";
import type { Plugin } from "@opencode/plugin/tui";

//jscpd:ignore-end
/** What a write achieved: the caps are in force, or here is why they are not. */
export type WriteOutcome = { problem: string; unknown?: boolean } | { written: true };

/**
 * What a read produced: the caps the store holds, or here is why they are unknown.
 *
 * An outcome rather than a bare value, because a read is not guaranteed to have one and
 * the difference has to survive to the screen. `read` promised never to throw and did not
 * keep it — there was no `try` on it while the write below it had one — so a channel that
 * is simply absent reached `openLimits`, which the command registration `void`s. The
 * result was an unhandled rejection: no dialog, no toast, and nothing in the log.
 */
export type ReadOutcome = { problem: string; read?: never } | { read: OverlayRead };

export interface OverlayChannel {
  /** The caps in force, and anything wrong with them. Never throws. */
  read: () => Promise<ReadOutcome>;
  /** Store caps, or say why not. Never throws: a refusal is an answer here. */
  write: (caps: AgentOverlay) => Promise<WriteOutcome>;
}

/**
 * The channel, built from the TUI host's own client.
 *
 * `context.client` is the same client the server plugin's RPC is reached through. The
 * window's location travels explicitly in the options on every call: the TUI client does
 * not attach one, and a bare call resolves to the server's default project instead of
 * this window's.
 */
export function overlayChannel(ctx: Plugin.Context): OverlayChannel {
  const client = ctx.client.rpc(OverlayRpc);
  const directory = ctx.location?.directory;
  const options = directory === undefined ? {} : { location: { directory } };
  return {
    // Same shape as the write below, for the same reason: the caller cannot tell a
    // refusal from a crash unless both arrive as values, and one of the two used to
    // arrive as a rejection with nowhere to go.
    read: async () => {
      try {
        return { read: readOverlayPayload(await client.read({}, options)) };
      } catch (error: unknown) {
        return { problem: readRefusal(error) };
      }
    },
    write: async (caps) => {
      try {
        await client.write({ caps }, options);
        return { written: true };
      } catch (error: unknown) {
        // `unknown` because the route failing and the server refusing are different
        // facts with different consequences, and the caller needs the first to keep the
        // caps it just wrote rather than discard them.
        return { problem: writeRefusal(error), unknown: true };
      }
    },
  };
}

/**
 * Why a write was refused, in the operator's own terms.
 *
 * The host answers a declared error by name, and the reason is in its data, so both are
 * read: the name says the caps were not stored, the reason says which of the two ways
 * that happened. Falling back to the message keeps the toast honest when the failure is
 * the host's own rather than ours.
 */
function writeRefusal(error: unknown): string {
  const data = isPlainRecord(error) && isPlainRecord(error.data) ? error.data : null;
  const reason = data && typeof data.reason === "string" ? data.reason : null;
  const named = isPlainRecord(error) && error.name === "not_writable";
  if (named && reason !== null) return reason === "not an overlay" ? "that is not a set of caps" : "the caps could not be stored";
  // A channel that DIED is not a server that refused. The server answers `not_writable`
  // by name; anything else is the route itself failing, and reporting it as "the caps
  // could not be stored" tells the operator a false thing about a mutation the store may
  // well have applied before the connection went away.
  return "the caps channel is not answering, so this write is not known to have landed";
}

/**
 * Why the caps could not be read.
 *
 * The mock refuses an unlistened method with `rpc.method_not_found` and its own comment
 * calls it "the failure a TUI really hits when the server plugin is not loaded" — so this
 * is the ordinary first-run case, not an exotic one, and it is named as what it is rather
 * than as a store that is somehow empty.
 */
function readRefusal(error: unknown): string {
  return isPlainRecord(error) && error.name === "method_not_found"
    ? "this project has no caps yet — the server plugin is not answering"
    : errorMessage(error);
}