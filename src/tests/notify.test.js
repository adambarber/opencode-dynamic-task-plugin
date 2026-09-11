/**
 * Notification gate contract (Task 05) — kind matrix, delivery with one
 * retry, and a bounded record ledger. Fast by construction: retry delay is
 * injectable, real timers only where firing is asserted.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  resolveNotifyKind,
  notifyParent,
  getLatestNotification,
  resetNotificationLog,
  MAX_NOTIFICATION_RECORDS,
} from "../../dist/shared/notify.js";

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
  it("timeout trigger always maps to timeout", () => {
    assert.strictEqual(resolveNotifyKind("timeout", "", false), "timeout");
    assert.strictEqual(resolveNotifyKind("timeout", "error", true), "timeout");
  });

  it("event trigger maps status and race state", () => {
    assert.strictEqual(resolveNotifyKind("event", "error", false), "error");
    assert.strictEqual(resolveNotifyKind("event", "idle", true), "completed_after_timeout");
    assert.strictEqual(resolveNotifyKind("event", "idle", false), "completed");
  });
});

describe("notify gate: notifyParent", () => {
  beforeEach(() => {
    resetNotificationLog();
  });

  it("delivers on first attempt and records success", async () => {
    const { client, calls } = promptClient([]);
    const record = await notifyParent(
      client, "parent_1", "hello",
      { childSessionId: "ses_1", kind: "completed" },
      { retryDelayMs: 0 },
    );
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(
      { delivered: record.delivered, attempts: record.attempts, kind: record.kind },
      { delivered: true, attempts: 1, kind: "completed" },
    );
    assert.deepStrictEqual(getLatestNotification("ses_1"), record);
  });

  it("retries once, then records failure with the cause", async () => {
    const { client, calls } = promptClient([new Error("down"), new Error("still down")]);
    const record = await notifyParent(
      client, "parent_1", "hello",
      { childSessionId: "ses_1", kind: "timeout" },
      { retryDelayMs: 0 },
    );
    assert.strictEqual(calls.length, 2, "exactly one retry");
    assert.strictEqual(record.delivered, false);
    assert.strictEqual(record.attempts, 2);
    assert.ok(record.error.includes("still down"), `last error kept. got: ${record.error}`);
  });

  it("second-attempt success records delivered with attempts=2", async () => {
    const { client } = promptClient([new Error("blip")]);
    const record = await notifyParent(
      client, "parent_1", "hello",
      { childSessionId: "ses_1", kind: "completed" },
      { retryDelayMs: 0 },
    );
    assert.strictEqual(record.delivered, true);
    assert.strictEqual(record.attempts, 2);
  });

  it("ledger is bounded and latest-wins per child", async () => {
    assert.ok(MAX_NOTIFICATION_RECORDS > 0, "bound is named");
    const { client } = promptClient([]);
    for (let i = 0; i < MAX_NOTIFICATION_RECORDS + 5; i++) {
      await notifyParent(
        client, "parent_1", `msg ${i}`,
        { childSessionId: `ses_${i}`, kind: "completed" },
        { retryDelayMs: 0 },
      );
    }
    const latest = getLatestNotification(`ses_${MAX_NOTIFICATION_RECORDS + 4}`);
    assert.ok(latest, "newest retained");
    assert.strictEqual(getLatestNotification("ses_0"), undefined, "oldest evicted");
  });

  it("unknown children have no record", () => {
    assert.strictEqual(getLatestNotification("ses_missing"), undefined);
  });
});
