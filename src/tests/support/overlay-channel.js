/**
 * The caps channel, stood up for a screen.
 *
 * A limits dialog no longer reads a file: it asks the server plugin's RPC for the caps
 * and writes them back through it. So a TUI suite needs the server's half present, or it
 * would be testing a screen against a fiction it invented — and every such fiction is
 * where a reader that only exists in the test goes to hide.
 *
 * What this builds is therefore mostly PRODUCTION: the real store, the real handlers,
 * the real definitions, and the real client reader the dialog uses. Exactly one boundary
 * is faked — the host's key-value table — which is the same single boundary the ledger's
 * own suites fake, and for the same reason.
 */
//jscpd:ignore-start
import assert from "node:assert/strict";
import { OverlayRpc } from "../../../dist/shared/overlay-rpc.js";
import { armFault } from "./faults.js";
import { createMockClient } from "./mock-host.js";
import { createOverlayStore } from "../../../dist/shared/overlay-store.js";
import { createRpc } from "./mock-rpc.js";
import { facadeOver } from "./durable-world.js";
import { overlayHandlers } from "../../../dist/entry/state.js";

//jscpd:ignore-end
/**
 * The host table behind one project, and the hooks object that made it.
 *
 * MEMOIZED, because the table is the one thing that has to be the same object twice: a
 * case seeds caps through the channel and then reads them through a different store, and
 * two tables would make the second read answer about an empty project. The key is a
 * temp directory, which is unique per case, so nothing is shared that should not be.
 *
 * The HOOKS TRAVEL WITH IT because they are the only way to make this fake hostile, and
 * the fake reads them out of its own closure: the ledger `armFault` writes is an
 * accounting record, not an input. Arming through the ledger alone left the host
 * perfectly well and the case asserting a refusal that never happened.
 */
const tables = new Map();

/**
 * One project's channel: the production store over the faked table, the production
 * handlers, and the host client the dialog reaches it with.
 *
 * `config` is the boot policy the write path applies caps over, passed in rather than
 * imported: the harness that owns it already holds it, and a shared import here would
 * close a cycle between the two support modules for the sake of one constant.
 */
export function overlayChannel(directory, config, { host = {}, table } = {}) {
  // One table per project by default, and a SHARED one on request — because the host's
  // store really is global, so the claim that two projects cannot see each other's caps
  // can only be asked of two projects sharing one table.
  const memoized = tables.get(directory);
  const held = table ?? memoized?.client ?? createMockClient(host);
  // A borrowed table keeps the hooks its OWN creator armed it with, so arming through
  // this channel would be arming a different fake than the one being read.
  const hooks = table === undefined ? (memoized?.hooks ?? host) : null;
  if (table === undefined) tables.set(directory, { client: held, hooks });
  const facade = facadeOver(held);
  const store = createOverlayStore(facade, directory);
  const rpc = createRpc();
  rpc.register(OverlayRpc, overlayHandlers(store, config, directory));
  return {
    /** The host's own table, for the one claim that is about what was STORED. */
    kv: held.testState.kv,
    read: () => store.read(),
    /** Store caps as the dialog does: through the channel and its declared methods. */
    seed: async (caps) => {
      await rpc.subclient(OverlayRpc).write({ caps });
    },
    store,
    /**
     * Arm a fault on the host BEHIND this channel, once the screen is already up.
     *
     * Arming it through `host` refuses the seed as well, so a case about a refused write
     * would open on a screen that never had caps in the first place.
     *
     * The FLAG is what makes the host hostile and `armFault` is what makes the suite
     * insist the fault engaged; both are done, because the fake reads the flag and the
     * teardown rule reads the ledger, and setting one is not setting the other.
     */
    arm: (name) => {
      assert.ok(hooks !== null, `cannot arm ${name} on a table this channel did not build — arm it on the client that owns it`);
      hooks[name] = true;
      armFault(held.testState, name);
    },
    /** The host's client, as the TUI sees it. */
    client: { rpc: rpc.subclient },
  };
}