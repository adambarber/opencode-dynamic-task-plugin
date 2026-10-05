import { accepted, answeredClient, gate, queuedFor, withHeldWrites } from "./support/notify-setup.js";
import { assert, describe, it } from "./support/runner.js";
import { configurePendingPersistence, getLatestNotification, getPendingDeliveries, notifyParent, restorePendingDeliveries } from "../../dist/shared/notify.js";
import { recordingClient } from "./support/mock-host.js";
import { opaqueHost } from "./support/opaque-host.js";
describe("durable pending delivery: the queue IS the crash window", () => {
  // Two cases in this block are the same ARRANGEMENT — a completed delivery, with
  // something recorded from inside the dial — and only the probe differs. One
  // builder so each case states its own probe: written out, both were a four-line
  // `recordingClient(async () => { ...; return accepted() })` plus a
  // `notifyParent` tail, which is shared shape and no shared logic, and the
  // duplication gate reads shape as duplication.
  const probingDial = (childSessionId, probe) => {
    const { client } = recordingClient(async () => {
      probe();
      return accepted();
    });
    return () => notifyParent(opaqueHost(client), "parent_1", "settled", gate(childSessionId, "completed"));
  };

  it("the write is already on the queue at the moment it dials", async () => {
    // Ordering is the whole contract: an entry written after the dial is a
    // comment, not a guarantee. The client reads the queue mid-prompt.
    let atDial = null;
    await probingDial("ses_pre", () => {
      atDial = queuedFor("ses_pre").map((entry) => entry.kind);
    })();
    assert.deepStrictEqual(atDial, ["completed"], "queued before the dial, not after it");
  });

  it("the DEBT is persisted before the dial, and the receipt only after it", async () => {
    // The in-memory ordering above is not the claim; the DURABLE ordering is. A
    // debt recorded after the dial is a comment about what was about to happen,
    // not a guarantee that survives the process dying mid-request — which is the
    // one window this whole mechanism exists for. The re-read each persist costs
    // is the deliberate price of not being the process that deletes another
    // process's running task, so these writes are not overhead to be debounced,
    // and this case is what stops anyone proposing that: batching the Owed write,
    // or the Delivered one, fails here before it ships.
    //
    // `owed` and `delivered` are persist writes; `dial` is this probe running
    // inside `session.prompt`. The one assertion is the whole interleaving.
    const order = [];
    configurePendingPersistence((changes) => changes.forEach((change) => order.push(change.kind)));
    await probingDial("ses_persisted", () => order.push("dial"))();
    assert.deepStrictEqual(order, ["owed", "dial", "delivered"], "owed, then the request, then the receipt — in that order");
  });

  it("a held write stays queued until the host answers, then leaves", async () => {
    await withHeldWrites(async ({ client, release }) => {
      await notifyParent(opaqueHost(client), "parent_1", "held", gate("ses_heldq", "completed"));
      assert.strictEqual(queuedFor("ses_heldq").length, 1, "an unanswered write is still owed");
      assert.strictEqual(getLatestNotification("ses_heldq").pending, true, "and the record says so");
      await release();
      assert.strictEqual(queuedFor("ses_heldq").length, 0, "the answer retires the debt");
      assert.strictEqual(getLatestNotification("ses_heldq").delivered, true);
    });
  });

  it("a delivered write leaves nothing owed, a failed one neither", async () => {
    const { client } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "ok", gate("ses_okq", "completed"));
    assert.deepStrictEqual(queuedFor("ses_okq"), [], "delivered: the debt is settled");

    const failing = answeredClient([new Error("down"), new Error("still down")]);
    await notifyParent(opaqueHost(failing.client), "parent_1", "no", gate("ses_noq", "error"));
    assert.deepStrictEqual(queuedFor("ses_noq"), [], "a known failure is a known outcome, not a debt");
    assert.strictEqual(getLatestNotification("ses_noq").delivered, false);
  });

  it("a suppressed repeat never dials and never queues", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "once", gate("ses_supp", "completed"));
    await notifyParent(opaqueHost(client), "parent_1", "once", gate("ses_supp", "completed"));
    assert.strictEqual(calls.length, 1, "suppressed: nothing dialed");
    assert.deepStrictEqual(queuedFor("ses_supp"), [], "nothing dialed, nothing owed");
  });

  it("a redelivery counts on from the last boot's attempts, not from zero", async () => {
    // The attempt count is the only visible signal that a parent keeps not
    // answering: reset to zero, a write held across five restarts would read as
    // five first tries and the escalation would be invisible.
    const { client, calls } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "owed", { ...gate("ses_carry", "completed"), carriedAttempts: 2 });
    assert.strictEqual(calls.length, 1, "one redelivery attempt, not three");
    assert.strictEqual(getLatestNotification("ses_carry").attempts, 3, "third attempt overall, not first");
  });

  it("a restored queue keeps its attempts and its order — oldest debt first", () => {
    // Boot reads this array and redelivers in order, so both properties belong
    // to the redelivery's correctness, not to the reader's tidiness.
    restorePendingDeliveries([
      { attempts: 2, childSessionId: "ses_old", kind: "completed", parentSessionId: "p1", text: "a" },
      { attempts: 1, childSessionId: "ses_new", kind: "error", parentSessionId: "p1", text: "b" },
    ]);
    const restored = getPendingDeliveries();
    assert.deepStrictEqual(
      restored.map((entry) => [entry.childSessionId, entry.attempts]),
      [["ses_old", 2], ["ses_new", 1]],
      "attempts and FIFO order both survive the durability boundary",
    );
    assert.strictEqual(restored[0].text, "a", "the owed text is the exact write, not a recipe to rebuild it");
  });
});

