/**
 * Who decides an outcome, and what the parent is told about it.
 *
 * The notification layer owns settlement: no per-call clock, no timeout, one
 * winner per turn. So the cases here are about the seams — a parent that cannot
 * be reached, a slot lost after the session was created, a delivery that is
 * still owed — rather than about any one tool.
 */

import { abortedSessions, answerMatches, answerOmits, answerSays, assert, assertNoticeCount, deferred, describe, dispatchArgs, eventHarness, events, harnessRejectingPrompt, it, notifiedNotes, promptsTo, sessionIds, setupHarness, sleep, textDeclaresKind, waitFor, wasAborted, withChild, withSettledChild, withSingleSlot } from "./support/index.js";

// A retry announcement defers the idle that follows it: the turn is not over.
const assertIdleDeferredDuringRetry = async (h, id, announce) => {
  await h.fireEvent(announce(id));
  await h.fireEvent(events.idle(id));
  await assertNoticeCount(h, 0, "idle during a declared retry does not settle");
};

// A deferred turn settles once its replacement turn finishes (working + succeeded).
const settleThenRace = async (h, id) => {
  await h.fireEvent(events.working(id));
  await h.fireEvent(events.succeeded(id));
  await sleep(50);
  return h.noticeKinds().length;
};

// A child whose last message carries the host's OWN retry verdict on the error
// union (data.isRetryable): the classification must honor it over prose.
// A harness whose child's transcript reads as the given messages: the shared
// setup for every case that scripts what the host's turn said.
const transcriptHarness = async (messages, description) => {
  const h = await setupHarness({ hooks: { messages: () => messages } });
  const { id } = await h.spawn({ description });
  return { h, id };
};

// The host's own retry verdict on the error union, plus an EARLIER completed
// message whose words are stale by the final report: the quote must reach the
// error, never the old text.
const retryableErrorHarness = async (isRetryable, prose, stale = "the previous stage of the work") => {
  const { h, id } = await transcriptHarness(
    [
      { content: [{ text: stale, type: "text" }], role: "assistant", time: { completed: Date.now() - 10000, created: Date.now() - 10000 } },
      { info: { error: { data: { isRetryable, message: prose, statusCode: 503 }, name: "APIError" }, role: "assistant" }, parts: [] },
    ],
    "host-verdict error task",
  );
  return { h, id, prose, stale };
};

// The budget's arc, shared by every blip doctrine: silent within the budget,
// one honest transient report at its end. The buddy is the harness plus its
// child and the stale words the report must not quote.
const budgetThenTransientReport = async (buddy, notYet) => {
  const { h, id, stale } = buddy;
  const { TRANSIENT_RESUME_BUDGET } = await import("../../dist/shared/transient-resume.js");
  await settleRepeat(h, id, TRANSIENT_RESUME_BUDGET);
  await assertNoticeCount(h, 0, notYet);
  await settleOnce(h, id);
  await assertNoticeCount(h, 1, "the budget's end is reported");
  const [note] = h.notices();
  await assertsTransientReport(note, stale, id, h);
};

const settleRepeat = async (h, id, times) => {
  for (let spent = 0; spent < times; spent += 1) {
    await h.settle(id);
    await sleep(150);
  }
};

const settleOnce = async (h, id) => {
  await h.settle(id);
  await sleep(150);
};

// A child whose every turn ends empty reads as the interruption signature, so
// the harness is the same for each budget case.
const emptyTurnHarness = async (stale = "Reading the three target tests...") => {
  const staleMsgs = [
    { content: [{ text: stale, type: "text" }], time: { completed: Date.now() - 10000, created: Date.now() - 10000 }, type: "assistant" },
    { content: [], time: { completed: Date.now(), created: Date.now() }, type: "assistant" },
  ];
  const h = await setupHarness({ hooks: { messages: () => staleMsgs } });
  const { id } = await h.spawn({ description: "empty stop task" });
  return { h, id, stale };
};

const assertsTransientReport = async (note, stale, id, h) => {
  textDeclaresKind(note.message, "error", "reported as the error it became");
  answerSays(note.message, "Failure class: transient", "named a blip, not broken work");
  answerOmits(note.message, stale, "stale last words are not quoted");
  const summary = await h.child(id).result();
  answerSays(summary, "error", "task retained as error");
};

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
  // #9: a RETRYABLE failure on the INITIAL prompt (the transport refuses before
  // the prompt is ever accepted) has no turn running and no terminal event ever
  // coming — the old code returned on retryable, stranding the task Active and
  // holding its concurrency slot forever. Because no turn started, the retryable
  // failure must settle the task (error kind, transient class) rather than leave
  // a zombie.
  it("an initial prompt refused retryably settles as error, never stranding active", async () => {
    const refusing = await setupHarness({
      hooks: { childPromptFailOnce: { code: "ETIMEDOUT", message: "connect ETIMEDOUT" } },
    });
    const { id } = await refusing.spawn({ description: "never-accepted task" });
    await waitFor(() => notifiedNotes(refusing.client).length === 1, "the retryable prompt-failure settlement to land");
    const [note] = notifiedNotes(refusing.client);
    textDeclaresKind(note.message, "error", "error-kind notification");
    answerSays(note.message, "Failure class: transient", "the retryable classification rides in the notice");
    answerSays(await refusing.tool.task_result.execute({ session_id: id }), "error", "task is retained as error, not stranded active");
    // A late terminal signal (a child that never ran cannot send one, but a
    // stray event must not double-notify) still settles exactly once.
    await refusing.settle(id);
    assert.strictEqual(notifiedNotes(refusing.client).length, 1, "exactly-once survives a late signal");
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

  it("a genuine completion notifies completed with real content", async () => {
    const real = "The task produced real output.";
    const { h, id } = await transcriptHarness([{ content: [{ text: real, type: "text" }], type: "assistant" }], "real completion task");
    const note = await h.settledNotice(id);
    textDeclaresKind(note.message, "completed", "genuine completion is completed, not error");
    answerSays(note.message, real, "notification quotes real content");
    answerOmits(note.message, "No text was captured from that turn", "no empty-content marker");
    const summary = await h.child(id).result();
    answerSays(summary, "completed", "task retained as completed");
  });

});

describe("settlement defers around host retries and empty-turn blips", () => {
  // A retry announced by EITHER host channel defers settlement: the static
  // session.retry.scheduled, or the in-flight session.status {type: "retry"}.
  // The payload shapes differ, the deferral must not.
  it("defers settlement when a retry is announced — session.retry.scheduled or session.status", async () => {
    for (const announce of [
      (sid) => events.retryScheduled(sid, { at: Date.now(), attempt: 1, error: { message: "rate limited", retryAfterMs: 5000, type: "provider" } }),
      (sid) => events.statusRetry(sid, 1),
    ]) {
      const h = await setupHarness();
      const { id } = await h.spawn({ description: "retry task" });
      await assertIdleDeferredDuringRetry(h, id, announce);
      // The retry's own turn settles it once it finishes.
      const race = await settleThenRace(h, id);
      assert.strictEqual(race, 1, "one notice from the retry's own outcome");
    }
  });

  // The retry-pending marker is not a one-way latch: the first sign the turn is
  // alive again (status busy / execution.started) clears it, so the idle that
  // ends a LATER turn settles instead of being deferred forever.
  it("a turn that is alive again clears the retry-pending marker", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "recovered retry task" });
    await assertIdleDeferredDuringRetry(h, id, (sid) => events.statusRetry(sid, 1));
    // The retry begins running: the recovery window is over.
    await h.fireEvent(events.statusBusy(id));
    await h.fireEvent(events.working(id));
    await h.fireEvent(events.idle(id));
    await waitFor(() => h.noticeKinds().length > 0, "the recovered turn's idle settles it");
    const [note] = h.notices();
    textDeclaresKind(note.message, "completed", "not deferred: the retry window closed when the turn ran");
  });


  it("an empty-content terminal turn resumes silently, then reports transient when the budget is spent", async () => {
    const { h, id, stale } = await emptyTurnHarness();
    await budgetThenTransientReport({ h, id, stale }, "empty-content blips are resumed, not reported");
    const { TRANSIENT_RESUME_BUDGET } = await import("../../dist/shared/transient-resume.js");
    assert.strictEqual(promptsTo(h.client, id).length, 1 + TRANSIENT_RESUME_BUDGET, "one resume prompt per budgeted blip");
  });

  // The host's own retry verdict is the signal: isRetryable:true on the error's
  // data means the child recovers on its own even when the message text matches
  // no symptom fragment — silence within the budget, one honest transient report
  // at the end. isRetryable:false means the host itself calls it fatal; nothing
  // resumes, whatever the prose looks like.
  it("a host-marked retryable error with unmatched prose resumes silently, then reports transient", async () => {
    const { h, id, stale } = await retryableErrorHarness(true, "the upstream service returned an error");
    await budgetThenTransientReport({ h, id, stale }, "host-stated retryable blips are resumed, not reported");
  });

  it("a host-marked non-retryable error is reported immediately, whatever the prose says", async () => {
    const { h, id } = await retryableErrorHarness(false, "socket hang up");
    await h.settle(id);
    await sleep(150);
    await assertNoticeCount(h, 1, "host-stated fatal errors are not resumed");
    const [note] = h.notices();
    textDeclaresKind(note.message, "error", "reported as the error it became");
    answerSays(note.message, "Failure class: structural", "the host's non-retryable verdict outranks transient-looking prose");
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
