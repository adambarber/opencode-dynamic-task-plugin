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

const NO_SLEEP = async () => {};

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

describe("notify gate: notifyParent", () => {
  beforeEach(() => {
    clearNotifyLedger();
  });

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = promptClient([]);
    const delivered = await notifyParent(client, "parent_1", "hello", {
      childSessionId: "ses_a1",
      kind: "completed",
      sleep: NO_SLEEP,
    });
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
    const delivered = await notifyParent(client, "parent_1", "hello", {
      childSessionId: "ses_b1",
      kind: "error",
      sleep: NO_SLEEP,
    });
    assert.strictEqual(delivered, false);
    assert.strictEqual(calls.length, 2, "exactly one retry");
    const record = getLatestNotification("ses_b1");
    assert.deepStrictEqual({ delivered: record.delivered, attempts: record.attempts }, { delivered: false, attempts: 2 });
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = promptClient([new Error("blip")]);
    const delivered = await notifyParent(client, "parent_1", "hello", {
      childSessionId: "ses_c1",
      kind: "completed",
      sleep: NO_SLEEP,
    });
    assert.strictEqual(delivered, true);
    assert.strictEqual(getLatestNotification("ses_c1").attempts, 2);
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
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
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
    release();
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
    let releaseRetry;
    const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
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
    releaseRetry();
    const firstDelivered = await first;          // stale-generation commit lands (transport succeeded)
    assert.strictEqual(firstDelivered, true, "the retry genuinely delivered — history says so");

    const second = await notifyParent(client, "parent_1", "turn 2", opts);
    assert.strictEqual(second, true, "the revived turn must not be poisoned by the stale commit");
  });

  it("delivery chains are FIFO-bounded like the dedup gate", async () => {
    let release;
    const transportGate = new Promise((resolve) => { release = resolve; });
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
    release();
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
