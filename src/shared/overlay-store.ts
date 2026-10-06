// The caps overlay in the host's store: one document, one address, one writer.
//
// The ledger is a fleet of records keyed by task, and this is a singleton keyed by
// project. Both go through the same facade, so both are bounded the same way and a
// refused write is reported the same way — the point of having one store is that
// there is nowhere for a second, looser writer to hide.
//
// The address carries the project because the store is GLOBAL across projects: a
// shared key would let one project's caps bound another project's dispatch, which is
// the kind of bug that only appears when two repos are open at once.

import { sameOverlay, type AgentOverlay } from "./caps.js";
import { isPlainRecord } from "./host-shape.js";
import { type One, type StateFacade, recordKey } from "./state-facade.js";

/** One place to change it, so the prefix and the keys written under it cannot disagree. */
const OVERLAY_VERSION = 1;
const OVERLAY_PREFIX = `overlay/v${OVERLAY_VERSION}`;

/** Where one project's overlay lives. Exported so a test cannot guess the spelling. */
export const overlayKey = (directory: string): string => recordKey(OVERLAY_PREFIX, directory);

/** What the reader could not use, in the words an operator can act on. */
export const UNREADABLE = "the stored caps could not be read";

export interface OverlayStore {
  /** What is stored for this project right now, and anything wrong with it. */
  read: () => Promise<OverlayRead>;
  /**
   * Store the overlay, and report whether it is THERE afterwards.
   *
   * A boolean rather than a bare call because the store hands back a queue, not a
   * receipt: `put` returns once the write is enqueued, and a bound reports refusal
   * without cancelling. So the only honest answer to "did that save?" is to look
   * again once the queue has drained — a write that was given up on can still land
   * late, and the dialog must not claim a success the next read will contradict.
   *
   * The comparison is with the STORED CAPS rather than with their presence: a refused
   * write leaves the previous overlay exactly where it was, so presence alone reports a
   * cap in force that the operator never got.
   */
  write: (overlay: AgentOverlay) => Promise<boolean>;
}

/**
 * The overlay as it was found.
 *
 * `caps` is deliberately untyped inside: what a stored document MEANS is the caps
 * reader's judgement, and this module's only claim is that the bytes are one object.
 */
export interface OverlayRead {
  /** The caps as the operator stated them, or null when none are stored or readable. */
  caps: Record<string, unknown> | null;
  /** Something is stored here, whether or not it could be used. */
  present: boolean;
  /** Why a stored overlay is not in force, in words an operator can act on. */
  problem: string | null;
}

/**
 * The guard sees the PARSED value, not the stored text: the facade parses a string
 * record before it is offered to a guard, so a guard written for the raw text would
 * reject every document the plugin itself wrote.
 */
const isDocument = (value: unknown): value is Record<string, unknown> => isPlainRecord(value);

export function createOverlayStore(facade: StateFacade, directory: string): OverlayStore {
  return {
    read: async () => {
      const found: One<Record<string, unknown>> = await facade.readOne(overlayKey(directory), isDocument);
      // A read the host did not finish is not an empty project, and a stored document
      // the reader rejected is not an absent one. Both would otherwise report "no caps
      // are set" about caps that ARE set, which is the silence this shape exists to
      // end.
      if (found.incomplete || found.dropped) return { caps: null, present: true, problem: UNREADABLE };
      if (!found.present) return { caps: null, present: false, problem: null };
      return { caps: found.value, present: true, problem: null };
    },
    write: async (overlay) => {
      facade.put(overlayKey(directory), JSON.stringify(overlay));
      await facade.settled();
      const after = await facade.readOne(overlayKey(directory), isDocument);
      return after.present && !after.incomplete && !after.dropped && sameOverlay(overlay, after.value);
    },
  };
}