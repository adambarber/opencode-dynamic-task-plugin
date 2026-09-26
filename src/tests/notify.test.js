/**
 * Notification gate contract — kind mapping, exactly-once delivery with one
 * retry, and a bounded record ledger. Fast by construction: the retry sleep
 * is injectable; real timers are never awaited.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  notifyParent,
  getLatestNotification,
  clearNotifyLedger,
  gateLedger,
  notifyChainCount,
  getPendingDeliveries,
  restorePendingDeliveries,
} from "../../dist/shared/notify.js";
import { bounded, deferred } from './support/harness.js';

const NO_SLEEP = async () => {};

/** The answer a host gives a write it accepted — stated once, because "accepted" is the claim. */
const accepted = () => ({ ok: true });

/**
 * The gated parent transport, in its two forms. Every write records its args
 * (so "never dialed" is observable) and then parks on `gate` until the test
 * resolves it; `throwFirst` fails the first write and parks the rest, which is
 * the shape the retry-then-hold tests need. Parked means parked — awaiting
 * anything that is not the gate's promise (a deferred object, say) lets the
 * write resolve immediately, and a test written that way asserts a concurrency
 * claim while actually exercising a transport that answered at once.
 *
 * The option vocabulary is CLOSED. A misspelled key that is silently ignored
 * makes the transport behave like the plan nobody asked for, and the test then
 * passes against a delivery the host never performed — the mock, not the gate,
 * becomes the thing under test.
 */
function gatedClient(gate, options = {}) {
  const unknown = Object.keys(options).filter((key) => key !== "throwFirst");
  if (unknown.length > 0) throw new Error(`gatedClient: unknown option(s) ${unknown.join(", ")}`);
  let thrownOnce = false;
  return recordingClient(async () => {
    if (options.throwFirst && !thrownOnce) {
      thrownOnce = true;
      throw new Error("parent busy");
    }
    await gate.promise;
    return { ok: true };
  });
}

/**
 * A client whose every parent write parks until the returned gate is released —
 * the transport that held a completion notice on the wire for twenty minutes in
 * the field. `release` answers the held write and waits one macrotask turn,
 * which is exactly long enough for the continuations already queued against that
 * answer to have run — an observable, not a sleep.
 */function heldWriteClient() {
  const gate = deferred();
  const held = gatedClient(gate);
  return {
    ...held,
    release: async () => {
      gate.resolve();
      await gate.promise;
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/**
 * A client whose only method is the parent write, plus the list of writes that
 * actually reached it. Every test in this file needs the same two things — a
 * transport whose answer the test decides, and the count of writes that got
 * there — and they were two hand-written client literals per test, so "dialed
 * exactly once" was answered by whichever literal that test happened to copy. One
 * wrapper, one recording: a test that wants the write to park, to throw, or to
 * note its own ordering says so in `respond`, and the record is the same record.
 */
function recordingClient(respond) {
  const calls = [];
  return {
    calls,
    client: {
      session: {
        prompt: async (args) => {
          calls.push(args);
          return respond(args);
        },
      },
    },
  };
}

/** The transport that answers at once — the default, and a script of outcomes when asked for one. */
function answeredClient(script = []) {
  // script: Array<"ok"|Error> consumed per prompt call.
  return recordingClient(async () => {
    const step = script.length > 0 ? script.shift() : "ok";
    if (step instanceof Error) throw step;
    return { ok: true };
  });
}


// The gate's own inputs: which child, what kind, and no real backoff — the
// retry count is the thing under test, so waiting for it proves nothing.
const gate = (childSessionId, kind) => ({ childSessionId, kind, sleep: NO_SLEEP });

/**
 * The outcome every delivery test ends on: the verdict AND how many writes
 * actually reached the transport. These belong in one assertion because the
 * count is what makes the verdict mean "exactly once" — a test that asserts the
 * verdict alone cannot tell a delivered write from a second copy beside it.
 */
function assertDelivered(verdict, calls, expectedCalls, why) {
  assert.strictEqual(verdict, true, why);
  assert.strictEqual(calls.length, expectedCalls, `${expectedCalls} write(s) reached the parent`);
}

/**
 * Run `body` against a client that HOLDS every parent write: the deadline is
 * shrunk to something a test can outwait, the write stays held until the body
 * releases it, and the hold and the production bounds are restored whatever the
 * body does. The deadline is shrunk, never mocked — the timer is real, only the
 * patience changes.
 */
async function withHeldWrites(body) {
  return bounded(20, async () => {
    const held = heldWriteClient();
    try {
      return await body(held);
    } finally {
      await held.release();
    }
  });
}

describe("notify gate: notifyParent", () => {
  beforeEach(() => {
    clearNotifyLedger();
  });

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = answeredClient([]);
    const delivered = await notifyParent(client, "parent_1", "hello", gate("ses_a1", "completed"));
    assert.strictEqual(delivered, true);
    assert.strictEqual(calls.length, 1);
    const record = getLatestNotification("ses_a1");
    assert.deepStrictEqual(
      { delivered: record.delivered, attempts: record.attempts, kind: record.kind },
      { delivered: true, attempts: 1, kind: "completed" },
    );
  });

  it("retries once, then records failure", async () => {
    const { client, calls } = answeredClient([new Error("down"), new Error("still down")]);
    const delivered = await notifyParent(client, "parent_1", "hello", gate("ses_b1", "error"));
    assert.strictEqual(delivered, false);
    assert.strictEqual(calls.length, 2, "exactly one retry");
    const record = getLatestNotification("ses_b1");
    assert.deepStrictEqual({ delivered: record.delivered, attempts: record.attempts }, { delivered: false, attempts: 2 });
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = answeredClient([new Error("blip")]);
    const delivered = await notifyParent(client, "parent_1", "hello", gate("ses_c1", "completed"));
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
      const delivered = await notifyParent(client, "parent_1", "hello", gate("ses_held1", "completed"));
      assert.strictEqual(delivered, false, "the caller is not held hostage to a busy parent");
      assert.strictEqual(calls.length, 1, "dialed once — a held write is never retried");
      const waiting = getLatestNotification("ses_held1");
      assert.strictEqual(waiting.pending, true, "recorded as held, not as a failure");
      assert.strictEqual(waiting.delivered, false);
      await release();
      const settled = getLatestNotification("ses_held1");
      assert.strictEqual(settled.pending, undefined, "the record is corrected when the host answers");
      assert.strictEqual(settled.delivered, true);
      assert.strictEqual(calls.length, 1, "still exactly one copy");
    });
  });

  it("a held write still blocks a second copy of the same kind until it answers", async () => {
    await withHeldWrites(async ({ client }) => {
      await notifyParent(client, "parent_1", "first", gate("ses_held2", "completed"));
      const again = await notifyParent(client, "parent_1", "second", gate("ses_held2", "completed"));
      assert.strictEqual(again, false, "the outstanding claim refuses the duplicate");
      assert.strictEqual(getLatestNotification("ses_held2").suppressed, true, "and says why");
    });
  });

  // A held write outlives the world that issued it. When the gate is reset the
  // same child id may belong to a completely different child, and a stale
  // "delivered" landing afterwards would reserve that child's first
  // notification as a duplicate. The per-child generation cannot catch this: a
  // reset restarts those at zero.
  it("an answer that arrives after the gate was reset lands in nothing", async () => {
    await withHeldWrites(async ({ client, release }) => {
      await notifyParent(client, "parent_1", "from the old world", gate("ses_reset1", "completed"));
      clearNotifyLedger();
      await release();
      assert.strictEqual(
        getLatestNotification("ses_reset1"),
        null,
        "the old world's answer cannot write into the new one",
      );
      assert.strictEqual(
        await notifyParent(client, "parent_1", "from the new world", gate("ses_reset1", "completed")),
        true,
        "and the id is free again for whoever holds it now",
      );
    });
  });

  it("same-child deliveries serialize in claim order", async () => {
    const order = [];
    const { client } = recordingClient(async ({ body }) => {
      const text = body.parts[0].text;
      order.push(`start:${text}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${text}`);
      return { ok: true };
    });
    const [ra, rb] = await Promise.all([
      notifyParent(client, "p", "first", gate("ses_chain1", "completed")),
      notifyParent(client, "p", "second", gate("ses_chain1", "error")),
    ]);
    assert.strictEqual(ra && rb, true, "both deliver");
    assert.deepStrictEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  });

  it("concurrent same-key writes deliver once — in-flight claims close the race", async () => {
    const parked = deferred();
    const { client, calls } = gatedClient(parked);
    const opts = gate("ses_race1", "completed");
    const first = notifyParent(client, "parent_1", "hello", opts);
    const second = notifyParent(client, "parent_1", "hello", opts);
    await new Promise((r) => setTimeout(r, 10)); // chained transport runs async; claims are sync
    assert.strictEqual(calls.length, 1, "the second in-flight write must never dial");
    parked.resolve();
    assert.deepStrictEqual((await Promise.all([first, second])).sort(), [false, true]);
  });

  it("settles deliver exactly once per kind", async () => {
    const { client, calls } = answeredClient([]);
    const settled = (message) => notifyParent(client, "parent_1", message, gate("ses_d1", "completed"));
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

  it("a distinct error can follow a delivered completion", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(client, "parent_1", "done", gate("ses_e1", "completed"));
    const escalated = await notifyParent(client, "parent_1", "actually failed", gate("ses_e1", "error"));
    assertDelivered(escalated, calls, 2);
  });

  it("notices dedup by message-derived key, not by kind", async () => {
    const { client, calls } = answeredClient([]);
    const opts = (message) => ({ ...gate("ses_f1", "notice"), dedupKey: `notice:${message}` });
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on X", opts("blocked on X")), true);
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on Y", opts("blocked on Y")), true);
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on X", opts("blocked on X")), false);
    assert.strictEqual(calls.length, 2);
  });

  it("revival clears settle-dedup so the next completion can deliver", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(client, "parent_1", "turn 1", gate("ses_g1", "completed"));
    gateLedger.forgetChild("ses_g1");
    const second = await notifyParent(client, "parent_1", "turn 2", gate("ses_g1", "completed"));
    assertDelivered(second, calls, 2);
  });

  it("a late commit from before revival cannot reserve the revived turn's key", async () => {
    // The poisoning window: an in-flight delivery claimed before forgetChild
    // succeeds after it. Its commit belongs to the previous generation — it
    // may emit history but must not reserve the key the revived turn needs.
    const retryGate = deferred();
    const { client } = gatedClient(retryGate, { throwFirst: true });
    const opts = gate("ses_gen1", "completed");
    const first = notifyParent(client, "parent_1", "turn 1", opts);
    await new Promise((r) => setTimeout(r, 10)); // the retry has dialed and is held
    gateLedger.forgetChild("ses_gen1");          // revival: new generation, cleared pending
    retryGate.resolve();
    const firstDelivered = await first;          // stale-generation commit lands (transport succeeded)
    assert.strictEqual(firstDelivered, true, "the retry genuinely delivered — history says so");

    const second = await notifyParent(client, "parent_1", "turn 2", opts);
    assert.strictEqual(second, true, "the revived turn must not be poisoned by the stale commit");
  });

  it("delivery chains are FIFO-bounded like the dedup gate", async () => {
    const transportGate = deferred();
    const { client } = recordingClient(async () => {
      await transportGate;
      return { ok: true };
    });
    const pending = [];
    for (let i = 0; i < 1005; i++) {
      pending.push(notifyParent(client, "p", `m${i}`, gate(`ses_ch${i}`, "completed")));
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
      await notifyParent(client, "parent_1", `msg ${i}`, gate(`ses_${i}`, "completed"));
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
      await notifyParent(client, "p", `m${i}`, gate(`ses_ev${i}`, "completed"));
    }
    const again = await notifyParent(client, "p", "again", gate("ses_ev1004", "completed"));
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
describe("durable pending delivery: the queue IS the crash window", () => {
  // The queue is process-global, so each case states its own starting world
  // rather than inheriting whatever ran before it.
  beforeEach(() => {
    clearNotifyLedger();
    restorePendingDeliveries([]);
  });

  const queuedFor = (childSessionId) =>
    getPendingDeliveries().filter((entry) => entry.childSessionId === childSessionId);

  it("the write is already on the queue at the moment it dials", async () => {
    // Ordering is the whole contract: an entry written after the dial is a
    // comment, not a guarantee. The client reads the queue mid-prompt.
    let atDial = null;
    const { client } = recordingClient(async () => {
      atDial = queuedFor("ses_pre").map((entry) => entry.kind);
      return { ok: true };
    });
    await notifyParent(client, "parent_1", "settled", gate("ses_pre", "completed"));
    assert.deepStrictEqual(atDial, ["completed"], "queued before the dial, not after it");
  });

  it("a held write stays queued until the host answers, then leaves", async () => {
    await withHeldWrites(async ({ client, release }) => {
      await notifyParent(client, "parent_1", "held", gate("ses_heldq", "completed"));
      assert.strictEqual(queuedFor("ses_heldq").length, 1, "an unanswered write is still owed");
      assert.strictEqual(getLatestNotification("ses_heldq").pending, true, "and the record says so");
      await release();
      assert.strictEqual(queuedFor("ses_heldq").length, 0, "the answer retires the debt");
      assert.strictEqual(getLatestNotification("ses_heldq").delivered, true);
    });
  });

  it("a delivered write leaves nothing owed, a failed one neither", async () => {
    const { client } = answeredClient([]);
    await notifyParent(client, "parent_1", "ok", gate("ses_okq", "completed"));
    assert.deepStrictEqual(queuedFor("ses_okq"), [], "delivered: the debt is settled");

    const failing = answeredClient([new Error("down"), new Error("still down")]);
    await notifyParent(failing.client, "parent_1", "no", gate("ses_noq", "error"));
    assert.deepStrictEqual(queuedFor("ses_noq"), [], "a known failure is a known outcome, not a debt");
    assert.strictEqual(getLatestNotification("ses_noq").delivered, false);
  });

  it("a suppressed repeat never dials and never queues", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(client, "parent_1", "once", gate("ses_supp", "completed"));
    await notifyParent(client, "parent_1", "once", gate("ses_supp", "completed"));
    assert.strictEqual(calls.length, 1, "suppressed: nothing dialed");
    assert.deepStrictEqual(queuedFor("ses_supp"), [], "nothing dialed, nothing owed");
  });

  it("a redelivery counts on from the last boot's attempts, not from zero", async () => {
    // The attempt count is the only visible signal that a parent keeps not
    // answering: reset to zero, a write held across five restarts would read as
    // five first tries and the escalation would be invisible.
    const { client, calls } = answeredClient([]);
    await notifyParent(client, "parent_1", "owed", { ...gate("ses_carry", "completed"), carriedAttempts: 2 });
    assert.strictEqual(calls.length, 1, "one redelivery attempt, not three");
    assert.strictEqual(getLatestNotification("ses_carry").attempts, 3, "third attempt overall, not first");
  });

  it("a restored queue keeps its attempts and its order — oldest debt first", () => {
    // Boot reads this array and redelivers in order, so both properties belong
    // to the redelivery's correctness, not to the reader's tidiness.
    restorePendingDeliveries([
      { parentSessionId: "p1", childSessionId: "ses_old", kind: "completed", text: "a", attempts: 2 },
      { parentSessionId: "p1", childSessionId: "ses_new", kind: "error", text: "b", attempts: 1 },
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
