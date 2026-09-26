/**
 * Notification gate contract — kind mapping, exactly-once delivery with one
 * retry, and a bounded record ledger. Fast by construction: the retry sleep
 * is injectable; real timers are never awaited.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  resolveNotifyKind,
  notifyParent,
  getLatestNotification,
  clearNotifyLedger,
  gateLedger,
  notifyChainCount,
} from "../../dist/shared/notify.js";
import { deferred } from './support/harness.js';
import { shrinkBoundsForTesting } from "../../dist/shared/execution-bound.js";

const NO_SLEEP = async () => {};

/**
 * A client whose every parent write parks until the returned gate is released —
 * the transport that held a completion notice on the wire for twenty minutes in
 * the field. `calls` counts writes the moment they are dialed, so "never
 * retried" is observable. `release` answers the held write and waits one
 * macrotask turn, which is exactly long enough for the continuations already
 * queued against that answer to have run — an observable, not a sleep.
 */
function heldWriteClient() {
  const held = deferred();
  const calls = [];
  return {
    calls,
    release: async () => {
      held.resolve();
      await held.promise;
      await new Promise((r) => setTimeout(r, 0));
    },
    client: {
      session: {
        prompt: async (args) => {
          calls.push(args);
          await held.promise;
          return { ok: true };
        },
      },
    },
  };
}

function promptClient(script) {
  // script: Array<"ok"|Error> consumed per prompt call.
  const calls = [];
  return {
    calls,
    client: {
      session: {
        prompt: async ({ path, body }) => {
          calls.push({ to: path.id, text: body?.parts?.[0]?.text || "" });
          const step = script.length > 0 ? script.shift() : "ok";
          if (step instanceof Error) throw step;
          return { ok: true };
        },
      },
    },
  };
}

describe("notify gate: resolveNotifyKind", () => {
  it("errors and vanished sessions are failures", () => {
    assert.strictEqual(resolveNotifyKind("error"), "error");
    assert.strictEqual(resolveNotifyKind("deleted"), "error");
  });

  it("idle completes; anything else has no kind", () => {
    assert.strictEqual(resolveNotifyKind("idle"), "completed");
    assert.strictEqual(resolveNotifyKind("busy"), null);
    assert.strictEqual(resolveNotifyKind(""), null);
  });
});

// The gate's own inputs: which child, what kind, and no real backoff — the
// retry count is the thing under test, so waiting for it proves nothing.
const gate = (childSessionId, kind) => ({ childSessionId, kind, sleep: NO_SLEEP });

/**
 * Run `body` against a client that HOLDS every parent write: the deadline is
 * shrunk to something a test can outwait, the write stays held until the body
 * releases it, and the hold and the production bounds are restored whatever the
 * body does. The deadline is shrunk, never mocked — the timer is real, only the
 * patience changes.
 */
async function withHeldWrites(body) {
  const restore = shrinkBoundsForTesting(20);
  const held = heldWriteClient();
  try {
    return await body(held);
  } finally {
    await held.release();
    restore();
  }
}

describe("notify gate: notifyParent", () => {
  beforeEach(() => {
    clearNotifyLedger();
  });

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = promptClient([]);
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
    const { client, calls } = promptClient([new Error("down"), new Error("still down")]);
    const delivered = await notifyParent(client, "parent_1", "hello", gate("ses_b1", "error"));
    assert.strictEqual(delivered, false);
    assert.strictEqual(calls.length, 2, "exactly one retry");
    const record = getLatestNotification("ses_b1");
    assert.deepStrictEqual({ delivered: record.delivered, attempts: record.attempts }, { delivered: false, attempts: 2 });
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = promptClient([new Error("blip")]);
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
    const client = {
      session: {
        prompt: async ({ body }) => {
          const text = body.parts[0].text;
          order.push(`start:${text}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end:${text}`);
          return { ok: true };
        },
      },
    };
    const opts = (kind) => ({ childSessionId: "ses_chain1", kind, sleep: NO_SLEEP });
    const [ra, rb] = await Promise.all([
      notifyParent(client, "p", "first", opts("completed")),
      notifyParent(client, "p", "second", opts("error")),
    ]);
    assert.strictEqual(ra && rb, true, "both deliver");
    assert.deepStrictEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  });

  it("concurrent same-key writes deliver once — in-flight claims close the race", async () => {
    const gate = deferred();
    const calls = [];
    const client = {
      session: {
        prompt: async (args) => {
          calls.push(args);
          await gate;
          return { ok: true };
        },
      },
    };
    const opts = { childSessionId: "ses_race1", kind: "completed", sleep: NO_SLEEP };
    const first = notifyParent(client, "parent_1", "hello", opts);
    const second = notifyParent(client, "parent_1", "hello", opts);
    await new Promise((r) => setTimeout(r, 10)); // chained transport runs async; claims are sync
    assert.strictEqual(calls.length, 1, "the second in-flight write must never dial");
    gate.resolve();
    assert.deepStrictEqual((await Promise.all([first, second])).sort(), [false, true]);
  });

  it("settles deliver exactly once per kind", async () => {
    const { client, calls } = promptClient([]);
    const first = await notifyParent(client, "parent_1", "hello", {
      childSessionId: "ses_d1",
      kind: "completed",
      sleep: NO_SLEEP,
    });
    const second = await notifyParent(client, "parent_1", "hello again", {
      childSessionId: "ses_d1",
      kind: "completed",
      sleep: NO_SLEEP,
    });
    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
    assert.strictEqual(calls.length, 1, "duplicate never reaches the parent");
    const record = getLatestNotification("ses_d1");
    assert.strictEqual(record.delivered, false);
    assert.strictEqual(record.attempts, 0, "suppressed before dialing");
    assert.strictEqual(record.suppressed, true, "suppression is visible, distinct from failure");
  });

  it("a distinct error can follow a delivered completion", async () => {
    const { client, calls } = promptClient([]);
    await notifyParent(client, "parent_1", "done", { childSessionId: "ses_e1", kind: "completed", sleep: NO_SLEEP });
    const escalated = await notifyParent(client, "parent_1", "actually failed", { childSessionId: "ses_e1", kind: "error", sleep: NO_SLEEP });
    assert.strictEqual(escalated, true);
    assert.strictEqual(calls.length, 2);
  });

  it("notices dedup by message-derived key, not by kind", async () => {
    const { client, calls } = promptClient([]);
    const opts = (message) => ({
      childSessionId: "ses_f1",
      kind: "notice",
      dedupKey: `notice:${message}`,
      sleep: NO_SLEEP,
    });
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on X", opts("blocked on X")), true);
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on Y", opts("blocked on Y")), true);
    assert.strictEqual(await notifyParent(client, "parent_1", "blocked on X", opts("blocked on X")), false);
    assert.strictEqual(calls.length, 2);
  });

  it("revival clears settle-dedup so the next completion can deliver", async () => {
    const { client, calls } = promptClient([]);
    await notifyParent(client, "parent_1", "turn 1", { childSessionId: "ses_g1", kind: "completed", sleep: NO_SLEEP });
    gateLedger.forgetChild("ses_g1");
    const second = await notifyParent(client, "parent_1", "turn 2", { childSessionId: "ses_g1", kind: "completed", sleep: NO_SLEEP });
    assert.strictEqual(second, true);
    assert.strictEqual(calls.length, 2);
  });

  it("a late commit from before revival cannot reserve the revived turn's key", async () => {
    // The poisoning window: an in-flight delivery claimed before forgetChild
    // succeeds after it. Its commit belongs to the previous generation — it
    // may emit history but must not reserve the key the revived turn needs.
    const retryGate = deferred();
    let calls = 0;
    const client = {
      session: {
        prompt: async () => {
          calls++;
          if (calls === 1) throw new Error("parent busy");
          await retryGate;
          return { ok: true };
        },
      },
    };
    const opts = { childSessionId: "ses_gen1", kind: "completed", sleep: NO_SLEEP };
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
    const client = {
      session: { prompt: async () => { await transportGate; return { ok: true }; } },
    };
    const pending = [];
    for (let i = 0; i < 1005; i++) {
      pending.push(notifyParent(client, "p", `m${i}`, {
        childSessionId: `ses_ch${i}`, kind: "completed", sleep: NO_SLEEP,
      }));
    }
    assert.strictEqual(notifyChainCount(), 1000, `chain map FIFO-capped. got ${notifyChainCount()}`);
    transportGate.resolve();
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 0)); // chain-drop handlers are detached
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(notifyChainCount(), 0, "settled chains never leak");
  });

  it("ledger is bounded and latest-wins per child", async () => {
    const { client } = promptClient([]);
    for (let i = 0; i < 205; i++) {
      await notifyParent(client, "parent_1", `msg ${i}`, { childSessionId: `ses_${i}`, kind: "completed", sleep: NO_SLEEP });
    }
    assert.ok(getLatestNotification("ses_204"), "newest retained");
    assert.strictEqual(getLatestNotification("ses_0"), null, "oldest evicted");
  });

  it("unknown children have no record", () => {
    assert.strictEqual(getLatestNotification("ses_missing"), null);
  });

  it("recent keys still dedupe after mass delivery (bounded window documented)", async () => {
    const { client } = promptClient([]);
    for (let i = 0; i < 1005; i++) {
      await notifyParent(client, "p", `m${i}`, { childSessionId: `ses_ev${i}`, kind: "completed", sleep: NO_SLEEP });
    }
    const again = await notifyParent(client, "p", "again", { childSessionId: "ses_ev1004", kind: "completed", sleep: NO_SLEEP });
    assert.strictEqual(again, false, "in-window keys still dedupe; eviction only touches the oldest");
  });
});
