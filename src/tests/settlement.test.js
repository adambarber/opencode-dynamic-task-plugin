/**
 * Who decides an outcome, and what the parent is told about it.
 *
 * The notification layer owns settlement: no per-call clock, no timeout, one
 * winner per turn. So the cases here are about the seams — a parent that cannot
 * be reached, a slot lost after the session was created, a delivery that is
 * still owed — rather than about any one tool.
 */

import { abortedSessions, answerMatches, answerOmits, answerSays, assert, assertNoticeCount, deferred, describe, dispatchArgs, eventHarness, events, harnessRejectingPrompt, it, notifiedNotes, sessionIds, setupHarness, sleep, textDeclaresKind, waitFor, wasAborted, withChild, withSettledChild, withSingleSlot } from "./support/index.js";

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
    // v2 removed the host log sink, so "no host log call" is now structural rather
    // than behavioral — the instrument that still has teeth is the transcript-read
    // counter: a non-terminal event must not cost a host round-trip either.
    const before = h.client.testState.transcriptReads;
    for (let i = 0; i < 50; i += 1) await h.fireEvent(events.working("ses_hot"));
    assert.strictEqual(h.client.testState.transcriptReads, before,
      "delivering 50 events cost transcript reads: the per-event head is paid once per part, and one turn in a large session has thousands of parts");
  });
  it("parentless settlements leave a visible non-delivery record", async () => {
    const { h, c, id, out } = await withChild({
      ctx: {},
      spawn: { description: "orphan task", prompt: "hi" },
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
    await assertNoticeCount(h, 1, "the error settlement notifies");
    const [note] = h.noticeBodies();
    textDeclaresKind(note, "error", "error kind");
    });

  it("settlement does not hold the event pump on slow transport", async () => {
    const gate = deferred();
    const h = await setupHarness({ hooks: { notifyTransport: { hang: gate } } });
    const { id } = await h.spawn();
    const settled = h.settle(id);
    const winner = await Promise.race([settled.then(() => "event"), sleep(500).then(() => "timeout")]);
    assert.strictEqual(winner, "event", "event handler must not wait for delivery transport");
    // The dial is DETACHED from the event head — that is the claim — and it now
    // also waits out the durable claim's window before it is made, so the fault
    // is engaged by WAITING for the dial, never by hoping teardown is late
    // enough. The harness's engagement rule is right: a fault that never fired
    // proves nothing.
    await waitFor(() => h.client.testState.notifyCalls.length > 0, "the dial to be attempted");
    gate.resolve();
    await settled;
  });

  it("background prompt failure settles as error and notifies once", async () => {
    const failing = await harnessRejectingPrompt("ses_mock_1");
    const { id } = await failing.spawn({ description: "doomed task" });
    await sleep(50); // the fire-and-forget catch schedules the settlement
    const notes = notifiedNotes(failing.client);
    assert.strictEqual(notes.length, 1, "exactly 1 prompt error notification");
    textDeclaresKind(notes[0].message, "error", "error-kind notification");
    const summary = await failing.tool.task_result.execute({ session_id: id });
    answerSays(summary, "error", "task must be retained as error");
    // The lifecycle event that follows must not double-settle.
    await failing.settle(id);
    assert.strictEqual(notes.length, 1, "exactly-once survives a late idle");
    });

  it("repeated terminal events notify exactly once", async () => {
    const { h, id } = await withSettledChild();
    await h.settle(id);
    await h.fireEvent(events.idle(id));
    await assertNoticeCount(h, 1, "one settled turn, one notice");
  });

  it("init guard disables the plugin without required client APIs", async () => {
    const mod = await import("../../dist/index.js");
    const { v2Context } = await import("./support/harness.js");
    // v2 entry is `{id, setup}` and the host calls `setup(context)` — a context
    // whose client lacks the core domains must register nothing, not throw.
    const { context, rawTools } = v2Context({}, "/tmp");
    await mod.default.setup(context);
    assert.ok(!rawTools.has("dynamic_task"), "no tools registered without the core APIs");
    });

  it("defers settlement when a retry is scheduled", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "retry task" });
    // A retry scheduled means the turn is not over — no settlement yet.
    await h.fireEvent(events.retryScheduled(id, { at: Date.now(), attempt: 1, error: { message: "rate limited", retryAfterMs: 5000, type: "provider" } }));
    await assertNoticeCount(h, 0, "retry scheduled does not settle");
    // Idle after retry should not settle as Completed — defer until execution event.
    await h.fireEvent(events.idle(id));
    await assertNoticeCount(h, 0, "idle after retry does not settle as completed");
  });


  it("an empty-content terminal turn settles as error, not completed with stale words", async () => {
    const stale = "Reading the three target tests...";
    const staleMsgs = [
      { content: [{ text: stale, type: "text" }], time: { completed: Date.now() - 10000, created: Date.now() - 10000 }, type: "assistant" },
      { content: [], time: { completed: Date.now(), created: Date.now() }, type: "assistant" },
    ];
    const h = await setupHarness({
      hooks: {
        messages: () => staleMsgs,
      },
    });
    const { id } = await h.spawn({ description: "empty stop task" });
    const note = await h.settledNotice(id);
    textDeclaresKind(note.message, "error", "empty-content turn is an error, not completed");
    answerSays(note.message, "The turn ended with no content", "honest empty-content note");
    answerOmits(note.message, stale, "stale last words are not quoted");
    const summary = await h.child(id).result();
    answerSays(summary, "error", "task retained as error");
  });
  it("a genuine completion notifies completed with real content", async () => {
    const real = "The task produced real output.";
    const h = await setupHarness({
      hooks: {
        // single message with real content
        messages: () => [
          { content: [{ text: real, type: "text" }], type: "assistant" },
        ],
      },
    });
    const { id } = await h.spawn({ description: "real completion task" });
    const note = await h.settledNotice(id);
    textDeclaresKind(note.message, "completed", "genuine completion is completed, not error");
    answerSays(note.message, real, "notification quotes real content");
    answerOmits(note.message, "No text was captured from that turn", "no empty-content marker");
    const summary = await h.child(id).result();
    answerSays(summary, "completed", "task retained as completed");
  });

});

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const h = await harnessRejectingPrompt("p1");
    const { id, c } = await h.spawn({ description: "doomed parent task" });
    await h.settle(id);
    await assertNoticeCount(h, 0, "nothing delivered");
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
    await assertNoticeCount(h, 1, "the retry delivered");
    const summary = await c.result();
    answerSays(summary, "completed", "final record is a success");
    });
});
