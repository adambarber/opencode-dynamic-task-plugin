// The TUI's end of the caps channel.
//
// The dialog must not learn that caps live in the server's store: it is a screen that
// reads an overlay and asks for one to be written. This module is the whole of that
// conversation — the client the host builds, the narrowing of the answer, and the
// refusal that becomes a toast instead of an exception. Both sides are the same
// definition, so a payload the server stops accepting is a payload this stops
// offering.

import type { Plugin } from "@opencode/plugin/tui";
import type { AgentOverlay } from "../shared/caps.js";
import type { OverlayRead } from "../shared/overlay-store.js";
import { OverlayRpc } from "../shared/overlay-rpc.js";
import { readOverlayPayload } from "../shared/overlay-rpc.js";
import { errorMessage, isPlainRecord } from "../shared/host-shape.js";

/** What a write achieved: the caps are in force, or here is why they are not. */
export type WriteOutcome = { problem: string } | { written: true };

export interface OverlayChannel {
  /** The caps in force, and anything wrong with them. Never throws. */
  read: () => Promise<OverlayRead>;
  /** Store caps, or say why not. Never throws: a refusal is an answer here. */
  write: (caps: AgentOverlay) => Promise<WriteOutcome>;
}

/**
 * The channel, built from the TUI host's own client.
 *
 * `context.client` is the same client the server plugin's RPC is reached through, so
 * the call carries this window's location — which is why no method takes a directory
 * and why a dialog cannot reach another project's caps.
 */
export function overlayChannel(ctx: Plugin.Context): OverlayChannel {
  const client = ctx.client.rpc(OverlayRpc);
  return {
    read: async () => readOverlayPayload(await client.read({})),
    write: async (caps) => {
      try {
        await client.write({ caps });
        return { written: true };
      } catch (error: unknown) {
        return { problem: writeRefusal(error) };
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
  return errorMessage(error);
}