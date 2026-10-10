/**
 * The overlay channel must name its project on every call.
 *
 * The TUI's RPC client does not attach a location of its own: a bare call resolves to
 * the server's default project, which is never the window's project. The consequence
 * seen live: the dialog rendered a clean ceiling from a different project's empty
 * overlay, with no degraded signal — the worst kind of empty.
 */

//jscpd:ignore-start
import { overlayChannel } from "../../dist/tui/overlay-client.js";
import { assert, describe, it } from "./support/runner.js";

//jscpd:ignore-end
/** A TUI context in which rpc.subclient records what options the dialog sent. */
function ctxRecording(record) {
  return {
    client: {
      rpc: () => ({
        read: async (input, options) => { record.push(options); return { present: false }; },
        write: async (input, options) => { record.push(options); return { confirmed: true }; },
      }),
    },
    location: { directory: "/Users/op/project" },
  };
}

describe("the overlay channel, and the location it declares", () => {
  it("names the window's directory on every read", async () => {
    const record = [];
    await overlayChannel(ctxRecording(record)).read();
    assert.deepEqual(record, [{ location: { directory: "/Users/op/project" } }], "a read that names no location reads the server's default project");
  });

  it("names the window's directory on every write", async () => {
    const record = [];
    await overlayChannel(ctxRecording(record)).write({});
    assert.deepEqual(record, [{ location: { directory: "/Users/op/project" } }], "a write that names no location writes the server's default project");
  });
});
