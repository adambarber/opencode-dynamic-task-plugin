/**
 * A gate world that owes nothing to the suite it serves.
 *
 * The notify ledger and the pending queue are PROCESS-GLOBAL (production never
 * resets anything), so every case that exercises `notifyParent` has to start from
 * an empty one. Three describes in notification-gate.test.js each spelled that
 * reset out by hand, and the copies drifted: one seeded a status the others did
 * not, and the duplication gate flagged them for good reason. The isolation is the
 * subject of those suites, so it belongs to one funnel that states it once — and
 * the world it hands back is a live view, so a case cannot capture a stale one.
 */

import { afterEach, beforeEach } from "./runner.js";
import { clearNotifyLedger, configurePendingPersistence, restorePendingDeliveries } from "../../../dist/shared/notify.js";
import { PARENT } from "./harness.js";
import { recordingClient } from "./mock-host.js";

/**
 * The notify ledger, the pending queue, and the persistence hook — all three are
 * PROCESS-GLOBAL, and a case that leaves any of them behind decides the next case's
 * result. Stated once so a suite cannot reset two of the three.
 */
export const cleanNotifyState = () => {
  clearNotifyLedger();
  restorePendingDeliveries([]);
  configurePendingPersistence(null);
};

/**
 * Register the per-case reset and hand back a view of the world each case sees.
 *
 * `respond` is the host's answer to a write; `status` seeds the parent's
 * liveness so a refusal-by-mid-turn-parent is reachable without a fixture flag.
 */
export function isolatedGate({ respond = async () => ({ ok: true }), status } = {}) {
  let world = null;
  const live = () => {
    if (!world) throw new Error("isolatedGate: no world outside a case — register it in a describe");
    return world;
  };
  beforeEach(() => {
    cleanNotifyState();
    world = recordingClient(respond);
    if (status) world.setStatus(PARENT, status);
  });
  afterEach(() => {
    cleanNotifyState();
    world = null;
  });
  return {
    get calls() {
      return live().calls;
    },
    get client() {
      return live().client;
    },
    setStatus: (id, type) => live().setStatus(id, type),
    /** The texts the world was actually asked to write, in order. */
    get wrote() {
      return live().calls.map((call) => call.text);
    },
  };
}