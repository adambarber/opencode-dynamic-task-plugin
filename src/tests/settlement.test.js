/**
 * Who decides an outcome, and what the parent is told about it.
 *
 * The notification layer owns settlement: no per-call clock, no timeout, one
 * winner per turn. So the cases here are about the seams — a parent that cannot
 * be reached, a slot lost after the session was created, a delivery that is
 * still owed — rather than about any one tool.
 */

import { describe, it } from "./support/runner.js";
import assert from "node:assert";
import { abortedSessions, notifiedNotes, sessionIds, setupHarness, sleep, wasAborted, withChild, withSettledChild } from "./support/harness.js";
import { deferred, events } from "./support/mock-host.js";
import { answerMatches, answerSays, assertNoticeCount } from "./support/assertions.js";
import { dispatchArgs, eventHarness, harnessRejectingPrompt, hostStatus, withSingleSlot } from "./support/integration.js";

describe("settlement: the notification layer owns outcomes", () => {
  // The head that sees EVERY event is the most-executed code in the plugin, so
  // what it charges the host is a design claim and not a detail. A single turn
  // in a large session delivers one event per part — coda's 5,399-part session
  // pays it thousands of times in one turn — and a per-event host log call is
  // that many round trips for a line nobody reads: the host log contains zero of
  // them, so the whole cost is waste with no observability bought in exchange.
  // Measured on coda 2026-09-28, where a restored 1,318-message session admitted a
  // turn and never dispatched it to the model while three other projects
  // streamed normally on the same host.
  it("the event head charges the host nothing per event", async () => {
    const h = await eventHarness();
    const before = h.logs().length;
    for (let i = 0; i < 50; i += 1) await h.fireEvent(events.working("ses_hot"));
    assert.deepStrictEqual(h.logs().slice(before), [],
      "delivering 50 events wrote host log lines: the per-event head is paid once per part, and one turn in a large session has thousands of parts");
  });
  it("parentless settlements leave a visible non-delivery record", async () => {
    const { h, c, id, out } = await withChild({
      spawn: { description: "orphan task", prompt: "hi" },
      ctx: {},
      });
    answerSays(out, "notification: disabled");
    await h.settle(id);
    const summary = await c.result();
    answerMatches(summary, /FAILED|delivered: false|no parent/, "deafness must be distinguishable from silence");
    });

  // Same-tick race through the advisory check: both spawns see an empty
  // slot, both create, the loser hits the authoritative register gate.
  it("post-create registration failure notifies instead of stranding error", async () => {
    const h = await withSingleSlot();
    const [r1, r2] = await Promise.all([
    h.tool.dynamic_task.execute(dispatchArgs("racer one"), { sessionID: "p1" }),
    h.tool.dynamic_task.execute(dispatchArgs("racer two"), { sessionID: "p1" }),
    ]);
    assert.strictEqual([r1, r2].filter((r) => r.includes("in background")).length, 1, "one winner");
    assert.strictEqual([r1, r2].filter((r) => r.includes("ERROR")).length, 1, "one loser");
    const winner = /Session: (\S+)/.exec([r1, r2].find((r) => r.includes("in background")))?.[1];
    const loser = sessionIds(h.client).find((id) => id !== winner);
    assert.ok(loser, "loser session was created");
    assert.ok(wasAborted(h.client, loser), `loser aborted, no orphan. aborted=${abortedSessions(h.client)}`);
    await sleep(50); // detached error-settlement delivery
    assertNoticeCount(h, 1, "the error settlement notifies");
    const note = h.noticeBodies()[0];
    answerSays(note, "ended with an error", "error kind");
    });

  it("settlement does not hold the event pump on slow transport", async () => {
    const gate = deferred();
    const h = await setupHarness({ hooks: { notifyTransport: { hang: gate } } });
    const { id } = await h.spawn();
    const settled = h.settle(id);
    const winner = await Promise.race([settled.then(() => "event"), sleep(500).then(() => "timeout")]);
    assert.strictEqual(winner, "event", "event handler must not wait for delivery transport");
    gate.resolve();
    await settled;
    });

  it("background prompt failure settles as error and notifies once", async () => {
    const failing = await harnessRejectingPrompt("ses_mock_1");
    const { id } = await failing.spawn({ description: "doomed task" });
    await sleep(50); // the fire-and-forget catch schedules the settlement
    const notes = notifiedNotes(failing.client);
    assert.strictEqual(notes.length, 1, "exactly 1 prompt error notification");
    answerMatches(notes[0].message, /ended with an error/i, "error-kind notification");
    const summary = await failing.tool.task_result.execute({ session_id: id });
    answerSays(summary, "error", "task must be retained as error");
    // The lifecycle event that follows must not double-settle.
    await failing.settle(id);
    assert.strictEqual(notes.length, 1, "exactly-once survives a late idle");
    });

  it("repeated terminal events notify exactly once", async () => {
    const { h, id } = await withSettledChild();
    await h.settle(id);
    await hostStatus(h, id);
    assertNoticeCount(h, 1, "one settled turn, one notice");
  });

  it("init guard disables the plugin without required client APIs", async () => {
    const mod = await import("../../dist/index.js");
    const pluginFn = mod.default || mod;
    const result = await pluginFn({ client: {}, directory: "/tmp" }, {});
    assert.deepStrictEqual(result, {});
    });
});

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const h = await harnessRejectingPrompt("p1");
    const { id, c } = await h.spawn({ description: "doomed parent task" });
    await h.settle(id);
    assertNoticeCount(h, 0, "nothing delivered");
    await sleep(600); // detached delivery runs the gate's 250ms retry cycle
    const summary = await c.result();
    answerSays(summary, "FAILED", "delivery failure surfaced");
    });

  // p1's prompt fails ONLY on the first attempt (child prompt ok, parent
  // notify attempt 1 fails, attempt 2 succeeds): the record is a history,
  // not a veto — exactly-once is about successful deliveries.
  it("a failed delivery does not consume the settlement — redelivery can succeed", async () => {
    const { h, c } = await withSettledChild({ harness: { hooks: { notifyTransport: { failTimes: 1 } } } });
    await sleep(500); // one retry cycle at the gate's fixed backoff
    assertNoticeCount(h, 1, "the retry delivered");
    const summary = await c.result();
    answerSays(summary, "completed", "final record is a success");
    });
});
