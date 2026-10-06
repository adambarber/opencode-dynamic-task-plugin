/**
 * The caps channel, end to end.
 *
 * The claim these cases exist for is the one the whole migration was for: a cap an
 * operator sets in a dialog is the cap the NEXT dispatch is judged against, with no
 * restart and no file. Everything else here — the refusal, the unreadable document, the
 * two projects — is what has to be true for that to be a fact rather than a hope.
 *
 * They run against the production store, the production handlers and the production
 * client reader. Only the host's key-value table is faked, because that is the one
 * boundary a test may own: it is the host's storage, not ours.
 */
import { assert, describe, it } from "./support/runner.js";
import { liveAgentCaps, resetLiveAgentCaps } from "../../dist/shared/caps.js";
import { OverlayRpc } from "../../dist/shared/overlay-rpc.js";
import { createMockClient } from "./support/mock-host.js";
import { overlayChannel } from "./support/overlay-channel.js";
import { overlayKey } from "../../dist/shared/overlay-store.js";
import { withTempDir } from "./support/fixtures.js";

/** The base a bare boot would have in force: defaults, with nothing stated. */
const BASE = { agents: {}, maxConcurrent: 4, maxDepth: 2 };

/** One project, a channel over it, and the caps an operator would state. */
const withChannel = (fn, options = {}) =>
  withTempDir(async (directory) => {
    resetLiveAgentCaps();
    return fn(directory, overlayChannel(directory, BASE, { host: options.host }));
  });

describe("the caps channel", () => {
  it("makes a stated cap the one a dispatch is judged against", async () => {
    await withChannel(async (directory, channel) => {
      assert.equal(liveAgentCaps(BASE).agents.general?.maxConcurrent, undefined, "nothing is stated before the edit");
      await channel.seed({ agents: { general: { maxConcurrent: 7 } } });
      assert.equal(liveAgentCaps(BASE).agents.general.maxConcurrent, 7, "the stored cap is the cap in force, with no restart");
    });
  });

  it("stores what it applied, under one address per project", async () => {
    await withChannel(async (directory, channel) => {
      await channel.seed({ agents: { general: { maxConcurrent: 7 } } });
      const stored = channel.kv.get(overlayKey(directory));
      assert.deepEqual(JSON.parse(stored), { agents: { general: { maxConcurrent: 7 } } });
    });
  });

  it("keeps one project's caps out of another's, over ONE host table", async () => {
    // The host's store is global, so this is the real shape: two projects, one table.
    // A key that forgot the project would make the second read report the first's caps,
    // and that is the whole claim.
    await withTempDir(async (here) => {
      await withTempDir(async (there) => {
        resetLiveAgentCaps();
        const shared = createMockClient();
        await overlayChannel(here, BASE, { table: shared }).seed({ agents: { general: { maxConcurrent: 2 } } });
        const other = overlayChannel(there, BASE, { table: shared });
        assert.equal((await other.read()).present, false, "another project has no caps merely because this one does");
        assert.notEqual(overlayKey(here), overlayKey(there), "and the two are not even stored at the same address");
      });
    });
  });

  it("refuses a payload that is not caps, and applies nothing", async () => {
    await withChannel(async (directory, channel) => {
      const before = channel.kv.size;
      await assert.rejects(
        channel.client.rpc(OverlayRpc).write({ caps: { agents: { general: { maxConcurrent: 0 } } } }),
        /caps/i,
        "a cap of zero is not a cap, and the host is told so",
      );
      assert.equal(channel.kv.size, before, "a refused payload is not stored");
      assert.equal(liveAgentCaps(BASE).agents.general, undefined, "a refused payload changes no policy");
    });
  });

  it("says a write did not happen when the host will not store it", async () => {
    await withChannel(
      async (directory, channel) => {
        await assert.rejects(channel.seed({ agents: { general: { maxConcurrent: 3 } } }), /stored|could not/i);
        assert.equal(liveAgentCaps(BASE).agents.general, undefined, "an unstored cap is not an applied one");
      },
      { host: { storageWriteThrows: true } },
    );
  });

  it("names a stored document it cannot read, rather than reporting no caps", async () => {
    await withChannel(async (directory, channel) => {
      channel.kv.set(overlayKey(directory), "{not json");
      const read = await channel.read();
      assert.equal(read.present, true, "something is stored, so this is not an empty project");
      assert.match(read.problem, /could not be read/, "and the operator is told why their caps are not applying");
      assert.equal(read.caps, null, "an unreadable document is not handed on as caps");
    });
  });
});