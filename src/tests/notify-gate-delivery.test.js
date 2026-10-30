
import { clearNotifyLedger, configureDeliveryClaims, gateLedger, getLatestNotification, notifyChainCount, notifyParent, resetDeliveryClaims } from "../../dist/shared/notify.js";
import { afterEach, assert, beforeEach, deferred, describe, it, opaqueHost, promptText, recordingClient } from "./support/index.js";
import { accepted, answeredClient, assertDelivered, gatedClient, gateOpts, withHeldWrites } from "./support/notify-setup.js";

describe("notify gate: notifyParent", () => {
  beforeEach(clearNotifyLedger);

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = answeredClient([]);
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gateOpts("ses_a1", "completed"));
    assert.strictEqual(delivered, true);
    assert.strictEqual(calls.length, 1);
    const record = getLatestNotification("ses_a1");
    assert.deepStrictEqual(
      { attempts: record.attempts, delivered: record.delivered, kind: record.kind },
      { attempts: 1, delivered: true, kind: "completed" },
    );
  });

  it("retries once, then records failure", async () => {
    const { client, calls } = answeredClient([new Error("down"), new Error("still down")]);
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gateOpts("ses_b1", "error"));
    assert.strictEqual(delivered, false);
    assert.strictEqual(calls.length, 2, "exactly one retry");
    const record = getLatestNotification("ses_b1");
    assert.deepStrictEqual({ attempts: record.attempts, delivered: record.delivered }, { attempts: 2, delivered: false });
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = answeredClient([new Error("blip")]);
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gateOpts("ses_c1", "completed"));
    assert.strictEqual(delivered, true);
    assert.strictEqual(getLatestNotification("ses_c1").attempts, 2);
  });

  // Field loss, observed live: the host accepts a prompt to a parent that is
  // mid-turn and HOLDS the request until that turn ends — twenty minutes, in
  // the run that named this. Nothing in the plugin misbehaved; the gate simply
  // had no answer to wait on, and a caller that waits on no answer tells the
  // parent nothing, records nothing, and looks healthy while it happens.
  //
  // So a held write is a third outcome, not a failure: the caller is released,
  // the record says PENDING, the write is not retried (the host may still land
  // it, and a second copy is the duplicate this gate exists to prevent), and
  // the record turns truthful whenever the host answers.
  it("a write the host holds is recorded pending, never failed, and lands when the host answers", async () => {
    await withHeldWrites(async ({ client, calls, release }) => {
      const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gateOpts("ses_held1", "completed"));
      assert.strictEqual(delivered, false, "the caller is not held hostage to a busy parent");
      assert.strictEqual(calls.length, 1, "dialed once — a held write is never retried");
      const waiting = getLatestNotification("ses_held1");
      assert.strictEqual(waiting.pending, true, "recorded as held, not as a failure");
      assert.strictEqual(waiting.delivered, false);
      await release();
      const settled = getLatestNotification("ses_held1");
      assert.deepStrictEqual(
        { delivered: settled.delivered, pending: settled.pending },
        { delivered: true, pending: undefined },
        "the record is corrected when the host answers",
      );
      assert.strictEqual(calls.length, 1, "still exactly one copy");
    });
  });

  it("a held write still blocks a second copy of the same kind until it answers", async () => {
    await withHeldWrites(async ({ client }) => {
      await notifyParent(opaqueHost(client), "parent_1", "first", gateOpts("ses_held2", "completed"));
      const again = await notifyParent(opaqueHost(client), "parent_1", "second", gateOpts("ses_held2", "completed"));
      assert.strictEqual(again, false, "the outstanding claim refuses the duplicate");
      assert.strictEqual(getLatestNotification("ses_held2").suppressed, true, "and says why");
    });
  });

});

describe("notify gate: what the gate refuses to deliver twice", () => {
  beforeEach(clearNotifyLedger);

  // A held write outlives the world that issued it. When the gate is reset the
  // same child id may belong to a completely different child, and a stale
  // "delivered" landing afterwards would reserve that child's first
  // notification as a duplicate. The per-child generation cannot catch this: a
  // reset restarts those at zero.
  it("an answer that arrives after the gate was reset lands in nothing", async () => {
    await withHeldWrites(async ({ client, release }) => {
      await notifyParent(opaqueHost(client), "parent_1", "from the old world", gateOpts("ses_reset1", "completed"));
      clearNotifyLedger();
      await release();
      assert.strictEqual(
        getLatestNotification("ses_reset1"),
        null,
        "the old world's answer cannot write into the new one",
      );
      assert.strictEqual(
        await notifyParent(opaqueHost(client), "parent_1", "from the new world", gateOpts("ses_reset1", "completed")),
        true,
        "and the id is free again for whoever holds it now",
      );
    });
  });

  it("same-child deliveries serialize in claim order", async () => {
    const order = [];
    const { client } = recordingClient(async (args) => {
      const text = promptText(args);
      order.push(`start:${text}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${text}`);
      return accepted();
    });
    const [ra, rb] = await Promise.all([
      notifyParent(opaqueHost(client), "p", "first", gateOpts("ses_chain1", "completed")),
      notifyParent(opaqueHost(client), "p", "second", gateOpts("ses_chain1", "error")),
    ]);
    assert.strictEqual(ra && rb, true, "both deliver");
    assert.deepStrictEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  });

  it("concurrent same-key writes deliver once — in-flight claims close the race", async () => {
    const parked = deferred();
    const { client, calls } = gatedClient(parked);
    const opts = gateOpts("ses_race1", "completed");
    const first = notifyParent(opaqueHost(client), "parent_1", "hello", opts);
    const second = notifyParent(opaqueHost(client), "parent_1", "hello", opts);
    await new Promise((r) => setTimeout(r, 10)); // chained transport runs async; claims are sync
    assert.strictEqual(calls.length, 1, "the second in-flight write must never dial");
    parked.resolve();
    const outcomes = await Promise.all([first, second]);
    assert.deepStrictEqual(outcomes.toSorted(), [false, true]);
  });

  it("settles deliver exactly once per kind", async () => {
    const { client, calls } = answeredClient([]);
    const settled = (message) => notifyParent(opaqueHost(client), "parent_1", message, gateOpts("ses_d1", "completed"));
    const first = await settled("hello");
    const second = await settled("hello again");
    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
    assert.strictEqual(calls.length, 1, "duplicate never reaches the parent");
    const record = getLatestNotification("ses_d1");
    assert.strictEqual(record.delivered, false);
    assert.strictEqual(record.attempts, 0, "suppressed before dialing");
    assert.strictEqual(record.suppressed, true, "suppression is visible, distinct from failure");
  });

  it("an escalated error follows a delivered completion", async () => {
    const clientCalls = answeredClient([]);
    const { client, calls } = clientCalls;
    await notifyParent(opaqueHost(client), "parent_1", "done", gateOpts("ses_e1", "completed"));
    const escalated = await notifyParent(opaqueHost(client), "parent_1", "actually failed", gateOpts("ses_e1", "error"));
    assertDelivered(escalated, calls, 2);
  });

  it("notices dedup by message-derived key, not by kind", async () => {
    const { client, calls } = answeredClient([]);
    const opts = (message) => ({ ...gateOpts("ses_f1", "notice"), dedupKey: `notice:${message}` });
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on X", opts("blocked on X")), true);
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on Y", opts("blocked on Y")), true);
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on X", opts("blocked on X")), false);
    assert.strictEqual(calls.length, 2);
  });

  it("revival clears settle-dedup so the next completion can deliver", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "turn 1", gateOpts("ses_g1", "completed"));
    gateLedger.forgetChild("ses_g1");
    const second = await notifyParent(opaqueHost(client), "parent_1", "turn 2", gateOpts("ses_g1", "completed"));
    assertDelivered(second, calls, 2);
  });

  it("a late commit from before revival cannot reserve the revived turn's key", async () => {
    // The poisoning window: an in-flight delivery claimed before forgetChild
    // succeeds after it. Its commit belongs to the previous generation — it
    // may emit history but must not reserve the key the revived turn needs.
    const retryGate = deferred();
    const { client } = gatedClient(retryGate, { throwFirst: true });
    const opts = gateOpts("ses_gen1", "completed");
    const first = notifyParent(opaqueHost(client), "parent_1", "turn 1", opts);
    await new Promise((r) => setTimeout(r, 10)); // the retry has dialed and is held
    gateLedger.forgetChild("ses_gen1");          // revival: new generation, cleared pending
    retryGate.resolve();
    const firstDelivered = await first;          // stale-generation commit lands (transport succeeded)
    assert.strictEqual(firstDelivered, true, "the retry genuinely delivered — history says so");

    const second = await notifyParent(opaqueHost(client), "parent_1", "turn 2", opts);
    assert.strictEqual(second, true, "the revived turn must not be poisoned by the stale commit");
  });

  it("delivery chains are FIFO-bounded like the dedup gate", async () => {
    const transportGate = deferred();
    const { client } = recordingClient(async () => {
      await transportGate.promise;
      return { ok: true };
    });
    const pending = [];
    for (let i = 0; i < 1005; i++) {
      pending.push(notifyParent(opaqueHost(client), "p", `m${i}`, gateOpts(`ses_ch${i}`, "completed")));
    }
    assert.strictEqual(notifyChainCount(), 1000, `chain map FIFO-capped. got ${notifyChainCount()}`);
    transportGate.resolve();
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 0)); // chain-drop handlers are detached
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(notifyChainCount(), 0, "settled chains never leak");
  });

  it("ledger is bounded and latest-wins per child", async () => {
    const { client } = answeredClient([]);
    for (let i = 0; i < 205; i++) {
      await notifyParent(opaqueHost(client), "parent_1", `msg ${i}`, gateOpts(`ses_${i}`, "completed"));
    }
    assert.ok(getLatestNotification("ses_204"), "newest retained");
    assert.strictEqual(getLatestNotification("ses_0"), null, "oldest evicted");
  });

  it("unknown children have no record", () => {
    assert.strictEqual(getLatestNotification("ses_missing"), null);
  });

  it("recent keys still dedupe after mass delivery (bounded window documented)", async () => {
    const { client } = answeredClient([]);
    for (let i = 0; i < 1005; i++) {
      await notifyParent(opaqueHost(client), "p", `m${i}`, gateOpts(`ses_ev${i}`, "completed"));
    }
    const again = await notifyParent(opaqueHost(client), "p", "again", gateOpts("ses_ev1004", "completed"));
    assert.strictEqual(again, false, "in-window keys still dedupe; eviction only touches the oldest");
  });
});

// The crash window this queue exists to close: the plugin used to move a task to
// `completed` and then dial the parent, so a crash in between left a record that
// read as finished with no notice and no evidence one was owed — the one failure
// mode the gate's own delivery ledger is blind to. The entry is therefore written
// BEFORE the dial and retired only when the outcome is known, which makes a
// duplicate after a crash the visible, accepted cost: a missing notice is silent
// deafness, a duplicate is a line the operator can read.

// The gate claim and the durable delivery claim are taken SEPARATELY, in two
// places: the gate claim synchronously at the top of notifyParent, the delivery
// claim inside run(). If run() throws AFTER the gate claim was taken but before
// any releasing arm (commit/standDown/deferDebt) runs, the gate key stays in
// inFlight for the life of the process and every later notifyParent for that
// (child, kind) is suppressed with { suppressed: true } — the queued debt only
// ever paid by a restart. The claim walk (takeDeliveryClaim) is where a throwing
// run() starts: its very first host read can reject as a transport error before
// any delivering arm has a chance to release the gate claim.
describe("notify gate: a claim released when the delivery claim walk throws", () => {
  // A claim store whose FIRST read rejects with a transport error: takeDeliveryClaim
  // throws before any delivering arm of run() can run. (Post-Bug-2 the durable
  // store converts a raw scan rejection into a partial read, so no host fault
  // drives a throw here — this one-shot rejection is the honest way to exercise
  // the invariant the fix guards: the in-memory gate claim must not outlive run().)
  beforeEach(() => {
    clearNotifyLedger();
    let reads = 0;
    configureDeliveryClaims({
      drop: () => {},
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("ECONNRESET: claim walk refused");
        return null;
      },
      settled: async () => {},
      write: () => {},
    });
  });
  afterEach(resetDeliveryClaims);

  it("releases the gate claim, so the next notice for the same child is delivered, not suppressed", async () => {
    const { client } = answeredClient([]);
    await assert.rejects(
      notifyParent(opaqueHost(client), "parent_1", "turn 1", gateOpts("ses_leak1", "completed")),
      /ECONNRESET/,
      "a transport fault in the claim walk rejects out of notifyParent",
    );
    const retried = await notifyParent(opaqueHost(client), "parent_1", "turn 2", gateOpts("ses_leak1", "completed"));
    assert.strictEqual(retried, true, "the gate claim was released, so the notice is delivered rather than suppressed");
    assert.strictEqual(getLatestNotification("ses_leak1").suppressed, undefined, "and it is not the suppressed path");
  });
});
