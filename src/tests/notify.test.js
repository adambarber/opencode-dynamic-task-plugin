/**
 * Notification gate contract — kind mapping, exactly-once delivery with one
 * retry, and a bounded record ledger. Fast by construction: the retry sleep
 * is injectable; real timers are never awaited. Also the prose the gate writes:
 * a notification is read by an orchestrator as much as by a human, so the tag,
 * the truncation and the recovery pointer are part of the contract.
 */

import { cleanNotifyState } from "./support/gate-world.js";
import { describe, it, beforeEach, afterEach, assert } from "./support/runner.js";
import { opaqueHost } from "./support/opaque-host.js";
import { clearNotifyLedger, configurePendingPersistence, gateLedger, getLatestNotification, getPendingDeliveries, noticeDedupKey, notifyChainCount, notifyParent, redeliverOwedNotifications, restorePendingDeliveries, truncateText } from "../../dist/shared/notify.js";
import { formatParentNotification, isParentNotification, notificationTag } from "../../dist/shared/notification-text.js";
import { bounded, drain } from './support/harness.js';
import { deferred, promptText, recordingClient } from './support/mock-host.js';
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";

const NO_SLEEP = async () => {};

/** The answer a host gives a write it accepted — one answer, so "accepted" is a name and not a shape. */
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
    return accepted();
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


/** The transport that answers at once — the default, and a script of outcomes when asked for one. */
function answeredClient(script = []) {
  // script: Array<"ok"|Error> consumed per prompt call.
  return recordingClient(async () => {
    const step = script.length > 0 ? script.shift() : "ok";
    if (step instanceof Error) throw step;
    return accepted();
  });
}


// The gate's own inputs: which child, what kind, and no real backoff — the
// retry count is the thing under test, so waiting for it proves nothing.
const gate = (childSessionId, kind) => ({ childSessionId, kind, sleep: NO_SLEEP });

/** The queue as one child's slice of it — module scope, because the debt's owner is the queue, not any one describe. */
const queuedFor = (childSessionId) =>
  getPendingDeliveries().filter((entry) => entry.childSessionId === childSessionId);

/**
 * The writes that carried THIS text. A boot pays the whole queue, and this file
 * leaves other children's debts behind, so a bare call count would be a count of
 * every debt in the ledger rather than of the one under test.
 */
const writesTo = (calls, text) => calls.filter((call) => call.body.parts[0].text === text);

/**
 * The clean slate every case in this file starts from, defined once because the
 * queue is DURABLE state: `clearNotifyLedger` deliberately does not touch it, so
 * without this each describe inherits whatever the previous one left owed and a
 * case is asserting against a ledger it did not build.
 *
 * Registered ONCE at module scope rather than per describe, which is both the
 * isolation the file wants and the reason the duplication gate stopped
 * reporting the same two hook lines in every block.
 */

beforeEach(cleanNotifyState);
afterEach(cleanNotifyState);

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
  beforeEach(clearNotifyLedger);

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = answeredClient([]);
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gate("ses_a1", "completed"));
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
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gate("ses_b1", "error"));
    assert.strictEqual(delivered, false);
    assert.strictEqual(calls.length, 2, "exactly one retry");
    const record = getLatestNotification("ses_b1");
    assert.deepStrictEqual({ delivered: record.delivered, attempts: record.attempts }, { delivered: false, attempts: 2 });
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = answeredClient([new Error("blip")]);
    const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gate("ses_c1", "completed"));
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
      const delivered = await notifyParent(opaqueHost(client), "parent_1", "hello", gate("ses_held1", "completed"));
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
      await notifyParent(opaqueHost(client), "parent_1", "first", gate("ses_held2", "completed"));
      const again = await notifyParent(opaqueHost(client), "parent_1", "second", gate("ses_held2", "completed"));
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
      await notifyParent(opaqueHost(client), "parent_1", "from the old world", gate("ses_reset1", "completed"));
      clearNotifyLedger();
      await release();
      assert.strictEqual(
        getLatestNotification("ses_reset1"),
        null,
        "the old world's answer cannot write into the new one",
      );
      assert.strictEqual(
        await notifyParent(opaqueHost(client), "parent_1", "from the new world", gate("ses_reset1", "completed")),
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
      notifyParent(opaqueHost(client), "p", "first", gate("ses_chain1", "completed")),
      notifyParent(opaqueHost(client), "p", "second", gate("ses_chain1", "error")),
    ]);
    assert.strictEqual(ra && rb, true, "both deliver");
    assert.deepStrictEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  });

  it("concurrent same-key writes deliver once — in-flight claims close the race", async () => {
    const parked = deferred();
    const { client, calls } = gatedClient(parked);
    const opts = gate("ses_race1", "completed");
    const first = notifyParent(opaqueHost(client), "parent_1", "hello", opts);
    const second = notifyParent(opaqueHost(client), "parent_1", "hello", opts);
    await new Promise((r) => setTimeout(r, 10)); // chained transport runs async; claims are sync
    assert.strictEqual(calls.length, 1, "the second in-flight write must never dial");
    parked.resolve();
    assert.deepStrictEqual((await Promise.all([first, second])).sort(), [false, true]);
  });

  it("settles deliver exactly once per kind", async () => {
    const { client, calls } = answeredClient([]);
    const settled = (message) => notifyParent(opaqueHost(client), "parent_1", message, gate("ses_d1", "completed"));
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
    await notifyParent(opaqueHost(client), "parent_1", "done", gate("ses_e1", "completed"));
    const escalated = await notifyParent(opaqueHost(client), "parent_1", "actually failed", gate("ses_e1", "error"));
    assertDelivered(escalated, calls, 2);
  });

  it("notices dedup by message-derived key, not by kind", async () => {
    const { client, calls } = answeredClient([]);
    const opts = (message) => ({ ...gate("ses_f1", "notice"), dedupKey: `notice:${message}` });
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on X", opts("blocked on X")), true);
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on Y", opts("blocked on Y")), true);
    assert.strictEqual(await notifyParent(opaqueHost(client), "parent_1", "blocked on X", opts("blocked on X")), false);
    assert.strictEqual(calls.length, 2);
  });

  it("revival clears settle-dedup so the next completion can deliver", async () => {
    const { client, calls } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "turn 1", gate("ses_g1", "completed"));
    gateLedger.forgetChild("ses_g1");
    const second = await notifyParent(opaqueHost(client), "parent_1", "turn 2", gate("ses_g1", "completed"));
    assertDelivered(second, calls, 2);
  });

  it("a late commit from before revival cannot reserve the revived turn's key", async () => {
    // The poisoning window: an in-flight delivery claimed before forgetChild
    // succeeds after it. Its commit belongs to the previous generation — it
    // may emit history but must not reserve the key the revived turn needs.
    const retryGate = deferred();
    const { client } = gatedClient(retryGate, { throwFirst: true });
    const opts = gate("ses_gen1", "completed");
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
      await transportGate;
      return { ok: true };
    });
    const pending = [];
    for (let i = 0; i < 1005; i++) {
      pending.push(notifyParent(opaqueHost(client), "p", `m${i}`, gate(`ses_ch${i}`, "completed")));
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
      await notifyParent(opaqueHost(client), "parent_1", `msg ${i}`, gate(`ses_${i}`, "completed"));
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
      await notifyParent(opaqueHost(client), "p", `m${i}`, gate(`ses_ev${i}`, "completed"));
    }
    const again = await notifyParent(opaqueHost(client), "p", "again", gate("ses_ev1004", "completed"));
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

// --- The redelivery budget ------------------------------------------------

/**
 * The same held transport, NEVER released.
 *
 * This exists because `withHeldWrites` releases in a `finally`, which made "a
 * write that neither resolves nor rejects" unrepresentable — and that is the
 * exact shape that shipped an unbounded redelivery with a green suite. Every
 * held-write test proved the plugin recovers once the host ANSWERS; none could
 * ask what happens when it never does, which is the only question that matters
 * for a debt that is re-offered at every boot.
 *
 * The name says it at the call site, because the failure this fixes is a test
 * that reads like all the others.
 */
async function withUnansweredWrite(body) {
  return bounded(20, () => body(heldWriteClient()));
}

/**
 * One boot, as `initPluginState` performs it: pay the durable queue through the
 * one re-offer production has.
 *
 * A boot is a PROCESS BOUNDARY, so the in-memory gate goes with it — the claim
 * ledger, the in-flight set and the delivery history are all per-process (the
 * notification ledger is documented as in-memory for exactly this reason), and
 * only the queue survives. Modelling that is what makes this a boot rather than
 * a second offer: without the reset the second entry is SUPPRESSED, because the
 * claim from the previous boot is still in flight in a process that has gone.
 *
 * `gateLedger.clear()` and NOT `clearNotifyLedger`, deliberately: the latter also
 * bumps the epoch, and a parked commit from the previous boot would then be
 * stopped by the epoch guard rather than by the retirement guard this work is
 * about. One guard per test, or the test proves the wrong one.
 */
async function boot(client, maxAttempts) {
  gateLedger.clear();
  restorePendingDeliveries(getPendingDeliveries());
  redeliverOwedNotifications(opaqueHost(client), maxAttempts);
  // Wait until this boot's own writes have reached their bound, which is what a real
  // boot does before it exits: a redelivery it could not finish is left owed for the next.
  await drain(notifyChainCount, "notify");
}

describe("notify: the redelivery budget", () => {
  // The arrangement every case here is a variation of: one child, one owed
  // notice, on a transport that never answers. Stated once, so a case says what
  // it is about — the budget, the next boot, the late answer — instead of
  // re-stating the fixture, which is what jscpd reads as a clone and what makes
  // the difference between two cases invisible on a diff.
  const CHILD = "ses_stuck";
  const settle = (held, over = {}) => notifyParent(opaqueHost(held.client), "parent_1", "owed", { ...gate(CHILD, "error"), ...over });
  const owedAt = () => queuedFor(CHILD).map((e) => e.attempts);
  /** The starting world, owed and already dialed, for the cases that begin there. */
  const givenAnUnansweredDebt = (body) =>
    withUnansweredWrite(async (held) => {
      await settle(held);
      return body(held);
    });

  /**
   * Boot a debt forward across real process boundaries, one per owed count.
   *
   * Every case in this describe is this shape — a debt owed at 1, boots that each
   * spend an attempt, and a final boot that crosses the bound — and they differ
   * only in what the parent does WHILE a boot happens, which is the thing each
   * one actually asserts. Stated once because a walk spelled out per case is what
   * jscpd reads as a clone, and because it is the walk that stops being tested
   * when it is spelled twice.
   */
  const bootForward = async (held, owedThrough, why) => {
    for (const expected of owedThrough) {
      await boot(held.client, 3);
      assert.deepStrictEqual(owedAt(), [expected], `${why} (boot ${expected})`);
    }
  };

  /**
   * A debt owed at 1, then booted forward to its bound, with the parent doing
   * `behaviour` at every boot. Answers with the held transport and the record the
   * final boot left, because both cases need to ask what the retirement said and
   * how many writes the whole life of the debt cost.
   *
   * The fixture, the walk and the retirement are the SAME WORLD, and the only
   * thing that differs between the two cases that use this is what the parent
   * does during a boot — which is precisely what each one is about. So the
   * scaffolding is named once, and a case can only differ in the behaviour it
   * tests.
   *
   * Both cases exist because the bound is the only thing standing between one
   * wedged parent and an infinite retry, and the bound is UNREACHABLE on any path
   * that does not deliver but does not spend. That is the whole defect class, and
   * it shipped twice: first for a HELD write, which re-armed its own count, and
   * then for a DEFERRED one, which re-armed at the same count it was offered. In
   * a live project the second one re-injected a synthetic user turn at every boot
   * forever (attempts 6→7 across six boots) and made the project un-typeable —
   * because redelivery IS `session.prompt`, so the retry mechanism was itself
   * what wedged it. A case per non-delivering path is what keeps the third one
   * from arriving.
   */
  const aDebtWalkedToItsBound = async (behaviour, why) =>
    givenAnUnansweredDebt(async (held) => {
      assert.deepStrictEqual(owedAt(), [1], "boot 1 is behind us: a held write leaves the debt owed at 1");
      behaviour(held);
      await bootForward(held, [2, 3], why);
      await boot(held.client, 3);
      return { held, record: getLatestNotification(CHILD) };
    });

  it("a debt the host never answers is retired at the budget, and is NOT dialed again", async () => {
    // The defect as first shipped: a redelivery the host HOLDS re-armed its own
    // count, and nothing anywhere consulted it.
    const { held, record } = await aDebtWalkedToItsBound(() => {}, "the count is carried forward");

    assert.strictEqual(writesTo(held.calls, "owed").length, 3, "three writes dialed for this debt, and no fourth");
    assert.deepStrictEqual(queuedFor(CHILD), [], "an expired debt is not owed any more");
    assert.strictEqual(record.delivered, false, "it is recorded as undelivered");
    assert.strictEqual(record.expired, true, "and as EXPIRED, which is not the same as failed");
    assert.strictEqual(record.attempts, 3, "with the count that was actually spent");
  });

  it("an expired debt leaves nothing for the NEXT boot to re-offer", async () => {
    // Retiring the entry in this process is not enough: the file is what the next
    // process reads, and a budget that only cleaned memory still wedges every boot.
    await givenAnUnansweredDebt(async (held) => {
      // One boot that pays whatever is owed, and what is still owed afterwards —
      // the whole claim of this case, so it gets a name rather than being
      // re-spelled once per assertion.
      const owedAfterABoot = async () => {
        await boot(held.client, 1);
        return queuedFor(CHILD);
      };

      assert.deepStrictEqual(await owedAfterABoot(), [], "the budget spent on that one attempt retired it");

      // The next process reads the file, finds nothing, and offers nothing. Scoped
      // to THIS debt, not to the whole queue: the queue is durable state and
      // `clearNotifyLedger` deliberately does not touch it, so other cases in this
      // file are free to leave entries behind.
      const settled = getLatestNotification(CHILD);

      assert.deepStrictEqual(await owedAfterABoot(), [], "and a further boot has nothing of it to re-offer");
      assert.deepStrictEqual(getLatestNotification(CHILD), settled, "a boot with no debt to pay changes nothing at all");
    });
  });

  it("a held write that answers AFTER expiry neither resurrects the debt nor reports delivery", async () => {
    // The obligation outliving its budget. A revival clears the in-flight claim
    // (a revived child is a new subject), so a second entry for the same debt can
    // reach the budget while the FIRST request is still on the wire — and the
    // host can then answer a write whose obligation has already ended. That
    // answer is not a delivery: the debt is gone, a newer generation owns the
    // key, and emitting here would tell the operator a notice arrived that the
    // plugin has already written off.
    const held = heldWriteClient();
    // Boot 1 at a budget of 1: dialed, owed at 1, held. The request is parked.
    await bounded(20, async () => {
      await settle(held, { maxAttempts: 1 });
      // The child is revived: a new turn, a new subject, and the in-flight claim
      // for the old one is released — which is what lets a second entry through.
      // Deliberately NOT a boot (no gate reset): the whole point is that one
      // process holds the request AND writes off the debt.
      gateLedger.forgetChild(CHILD);

      const after = await settle(held, { carriedAttempts: 1, maxAttempts: 1 });
      assert.strictEqual(after, false, "the second entry did not deliver");
      assert.deepStrictEqual(queuedFor(CHILD), [], "and expired the debt");
      const expired = getLatestNotification(CHILD);
      assert.strictEqual(expired.expired, true, "recorded as expired");

      // The host finally answers the write from boot 1, which is long past any
      // obligation to deliver it.
      await held.release();

      assert.deepStrictEqual(queuedFor(CHILD), [], "the late answer does not put the debt back on the queue");
      const afterAnswer = getLatestNotification(CHILD);
      assert.strictEqual(afterAnswer.expired, true, "and the last word on the record is still EXPIRED");
      assert.notStrictEqual(afterAnswer.delivered, true, "never reported as delivered after the plugin gave up on it");
    });
  });

  // The cases below are one world — a parent the host will not take a write from
  // — and differ only in WHICH word the host used. Everything but that is built
  // once here, because a client literal copied per case is what jscpd reads as a
  // clone, and the worse cost is that two cases can quietly stop testing the same
  // world while still looking like they do.
  //
  // The world is measured: 2026-09-28, a coda parent was admitted a turn at
  // 19:35:02 and at 19:55:19 that never reached the model and never exited, so
  // the host held every prompt after it and the project became un-typeable. Both
  // of those turns were this gate re-offering one owed debt into a session that
  // had already refused one. The second word — WEDGED — is the same refusal with
  // no live run behind it: 82 turns across 67 coda sessions, each swallowing the
  // next prompt without logging a line, and invisible to the status map that
  // reports the first.
  const toParent = async (text, opts, world) => {
    const { client, calls, ...transport } = answeredClient([]);
    world(transport);
    await notifyParent(opaqueHost(client), "parent_1", text, { ...gate(CHILD, "error"), ...opts });
    return { writes: calls.length, owed: queuedFor(CHILD).map((entry) => entry.attempts) };
  };
  // One transcript, three shapes, and the difference IS the check: a clock with no
  // completion is a turn the host abandoned, while no clock at all is a host that
  // described nothing — and reading the second as the first declares every parent
  // the plugin cannot fully describe dead. `ASSISTANT_ROLE`, not a retyped word.
  const stuckTurn = (at) => [{ role: ASSISTANT_ROLE, time: { created: at }, parts: [] }];
  const BUSY = ({ setStatus }) => setStatus("parent_1", "busy");
  const WEDGED = ({ setMessages }) => setMessages("parent_1", stuckTurn(1));
  const CLOCKLESS = ({ setMessages }) => setMessages("parent_1", [{ role: ASSISTANT_ROLE, parts: [] }]);
  const RE_OFFER = { carriedAttempts: 1, maxAttempts: 3 };
  const FRESH = {};
  /**
   * One write into `world`, asserted on both numbers that decide anything: how
   * many writes reached the host, and what the debt looks like afterwards.
   *
   * Every case below is this shape with different words, and asserting it per case
   * is both what jscpd reads as a clone and how two of them drift into checking
   * different things while still looking identical.
   */
  const expectWrite = async (world, text, opts, writes, owed, why) => {
    const sent = await toParent(text, opts, world);
    assert.strictEqual(sent.writes, writes, why);
    assert.deepStrictEqual(sent.owed, owed, `${why} — and the debt is left where that puts it`);
  };

  it("a REDELIVERY into a mid-turn parent is DEFERRED — no write, and the debt still counts", async () => {
    // So the write is not attempted — a redelivery IS `session.prompt`, and
    // attempting it is the wounding — but the debt is not exempt from the budget
    // either. Deferring is a boot that offered the debt and did not deliver it, so
    // it spends an attempt exactly as a held write does. A deferral that spends
    // NOTHING is not a deferral, it is a debt the bound can never reach: this
    // re-armed at `carried` forever and re-injected a synthetic user turn into a
    // wedged parent at every boot.
    await expectWrite(BUSY, "owed", RE_OFFER, 0, [2], "the write is not attempted at all, because a held write is what wedged the session");
    assert.strictEqual(getLatestNotification(CHILD).pending, true, "and the record says pending rather than delivered");
  });

  // One claim over two refusals, because it IS one claim: every path that
  // declines a re-offer must spend toward the bound, or the bound is unreachable
  // on that path. Mid-turn and wedged are the same sentence with different words,
  // and two copies of a boot walk is where one of them quietly stops being
  // tested while still looking like it is. Driven across real boot boundaries
  // (`boot` clears the in-memory gate, which a process boundary takes with it)
  // because re-offering in this process would be SUPPRESSED by the claim the
  // first offer still holds, and would prove nothing.
  for (const [label, world] of [["mid-turn", BUSY], ["wedged", WEDGED]]) {
    it(`a parent that is ${label} at EVERY boot still reaches the bound and retires`, async () => {
      const { held, record } = await aDebtWalkedToItsBound(world, `a ${label} refusal spends an attempt`);

      assert.deepStrictEqual(queuedFor(CHILD), [], "the boot that crosses the bound retires the debt");
      assert.strictEqual(record.expired, true, "honestly, as EXPIRED — not delivered, not failed");
      assert.strictEqual(writesTo(held.calls, "owed").length, 1, "one write for the whole life of this debt: a refusal never dials");
    });
  }

  it("a REDELIVERY into a WEDGED parent is spent, and is not dialed", async () => {
    // The third non-delivering path, and the one that cost a day of work. A turn
    // the host opened and never closed is not a wait, it is a stop: the host
    // holds every write to that session forever, creating no message and logging
    // no line — a prompt into one produced no `loop` line, so from the outside it
    // is indistinguishable from silence. The status map cannot see it, because it
    // carries live runs only. So without this the gate dials a call that will
    // never answer, holds the claim while it parks, and leaves the operator with
    // nothing naming the session that swallowed it.
    await expectWrite(WEDGED, "owed", RE_OFFER, 0, [2], "no write is attempted into a session the host has already stopped answering");
  });

  it("a parent with NO CLOCK on its last turn is not read as wedged", async () => {
    // The falsification against over-reach, and the defect the integration
    // harness caught: its default assistant turn carries no `time` at all, and a
    // guard that reads an absent clock as an absent completion declares every
    // parent the plugin cannot fully describe dead — and then owes nothing to
    // anyone. A host that described nothing has not said the turn failed.
    await expectWrite(CLOCKLESS, "clockless", RE_OFFER, 1, [], "an unclocked turn is not evidence of a wedge, so the write is made");
  });

  it("a FRESH notice to a wedged parent is still written — a guess is not a refusal", async () => {
    // The falsification in the other direction, and the reason the check is gated
    // on `carried > 0`: a first attempt has been refused by nothing yet, and
    // pre-judging an unreadable session is how a parent's results go missing
    // quietly. The same asymmetry the busy-parent defer already makes.
    await expectWrite(WEDGED, "fresh", FRESH, 1, [], "a first attempt is written rather than pre-judged");
  });

  it("a FRESH notice to a busy parent is still written — the host holds it, and that has always worked", async () => {
    // The falsification in the direction that would make the deferral a bug: 46
    // notices in the same session each drew a completed turn, most of them
    // written while the parent was busy. Only a debt that has ALREADY been
    // refused once is evidence the parent cannot take a write, so a first
    // attempt must keep making it or a busy parent silently swallows results.
    await expectWrite(BUSY, "fresh", FRESH, 1, [], "a first attempt is written, and the host holds it until the parent's turn is over");
  });

  it("a debt under its budget is untouched — the bound is not a blanket give-up", async () => {
    // Falsification in the direction that would make the budget a defect: a
    // parent that is merely slow must still be served on the next boot. Without
    // this, "expires" and "is refused early" look identical from the outside.
    const { client, calls } = answeredClient([]);
    await notifyParent(opaqueHost(client), "parent_1", "owed", { ...gate(CHILD, "error"), carriedAttempts: 1, maxAttempts: 3 });

    assert.strictEqual(calls.length, 1, "a debt inside its budget is still dialed");
    assert.strictEqual(getLatestNotification(CHILD).delivered, true, "and delivered");
    assert.deepStrictEqual(queuedFor(CHILD), [], "and settled");
  });
});

// --- The prose the gate writes -----------------------------------------------

describe("notify: the message the parent receives", () => {
  const state = { childSessionId: "ses_1", description: "Quick task" };

  it("formats completion with the wire marker and output", () => {
    const message = formatParentNotification(state, "completed", "COMPLETED_OK");
    assert.match(message, /^\[dynamic-task-notify\]/);
    assert.match(message, /Session: ses_1/);
    assert.match(message, /Description: Quick task/);
    assert.match(message, /COMPLETED_OK/);
  });

  it("formats error with recovery guidance", () => {
    const message = formatParentNotification(state, "error", "Something failed");
    assert.match(message, /Something failed/);
    assert.match(message, /task_result/);
    assert.match(message, /task_continue/);
  });

  it("formats a child notice under its own tag with the reply path", () => {
    const noticeMessage = formatParentNotification(state, "notice", "blocked on credentials");
    assert.match(noticeMessage, /dynamic-task-notice/);
    assert.match(noticeMessage, /Message from a running child task/);
    assert.match(noticeMessage, /blocked on credentials/);
    assert.match(noticeMessage, /task_continue/);
  });

  it("keeps settlements under the settlement tag, and the mid-flight notice off it", () => {
    // The tag is the routing contract a host orchestrator reads, so this pins the
    // grouping rather than a spelling: every settlement kind shares one tag, the
    // mid-flight notice has its own, and the rendered text carries the tag the kind
    // declares. Typing the marker here instead is how this case used to read.
    const settlement = notificationTag("completed");
    for (const kind of ["completed", "error", "blocked"]) {
      assert.strictEqual(notificationTag(kind), settlement, `${kind} is a settlement`);
      assert.ok(formatParentNotification(state, kind, "out").includes(settlement), `${kind} renders its tag`);
    }
    assert.notStrictEqual(notificationTag("notice"), settlement, "a mid-flight notice is not a settlement");
    assert.ok(isParentNotification(formatParentNotification(state, "notice", "x")), "and is still parent-directed");
  });

  it("says so when a turn ended with no text, and names the reader", () => {
    // The old "(No text output)" placeholder read as content in the corpus; silence
    // now reads as silence. What the payload owes a parent here is a reader.
    const message = formatParentNotification(state, "completed", "   ");
    assert.match(message, /No text was captured/);
    assert.match(message, /task_result\(session_id=ses_1\)/);
    assert.ok(!/\(No text output\)/.test(message));
  });

  it("passes mid-size payloads through whole — no silent cliff", () => {
    const body = "x".repeat(3000);
    const message = formatParentNotification(state, "completed", body);
    assert.ok(message.includes(body), "3000-char output must survive the push path intact");
  });

  it("bounds huge payloads but points at task_result for the rest", () => {
    const message = formatParentNotification(state, "completed", "x".repeat(9000));
    assert.ok(message.length < 9000, "push path stays bounded");
    assert.match(message, /task_result/, "truncation names the full-text recovery path");
    assert.match(message, /ses_1/, "pointer names the session");
  });
});

describe("notify: dedup key and truncation", () => {
  it("noticeDedupKey separates distinct long messages sharing a prefix", () => {
    const first = noticeDedupKey("a".repeat(200) + "1");
    const second = noticeDedupKey("a".repeat(200) + "2");
    assert.notStrictEqual(first, second, "full content keys the dedup, not a prefix");
    assert.strictEqual(noticeDedupKey("same"), noticeDedupKey("same"), "deterministic");
  });

  it("truncateText caps long output", () => {
    const out = truncateText("x".repeat(1300));
    assert.strictEqual(out.length, 1203);
    assert.ok(out.endsWith("..."));
    assert.strictEqual(truncateText("short"), "short");
  });
});
