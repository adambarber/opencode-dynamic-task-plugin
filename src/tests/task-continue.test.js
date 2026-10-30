/**
 * task_continue — steering a child, and what a steer is allowed to do to a task
 * that has already settled.
 *
 * The steer stops the running turn and its message becomes the next one, so every
 * case here is a race: the turn ending, the abort failing, the settlement landing
 * mid-flight. The contract is that a steer never settles, never claims a steer
 * that never happened, and revives rather than strands.
 */

import { ENV } from "../../dist/shared/config.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { answerMatches, answerOmits, answerSays, assert, assertNeedsSessionId, assertNoticeCount, bootOn, bounded, childFailingWith, deferred, deliveriesTo, describe, dialCount, drainNotices, eventHarness, events, it, promptsSaying, promptsToCarrying, promptText, promptTextsTo, retainedEntry, sentPrompts, setupHarness, setupTwoTurnHarness, sleep, stateOf, statusOmits, statusSays, textDeclaresKind, waitFor, wasAborted, withChild, withEnv, withSettledChild } from "./support/index.js";

/**
 * A steer that will lose a race to an interrupt, and the report it hands back.
 * The steps are always the same — boot a child, park the steer's abort at the
 * gate, interrupt first, then let the steer land behind the winner — and two
 * cases were spelling them out, which is how a case ends up racing something
 * other than a settlement.
 */
/**
 * A steer that is already at the abort gate, ten milliseconds in. The gate is the
 * whole point of these cases — the steer is supposed to LOSE, so it has to
 * have reached its abort before the winner arrives — and that window was a
 * literal in each case, which is a number a reader has nothing to check it
 * against. One call, so the two races being tested are the same race.
 */
async function steerAtTheGate(h, c, gateOpts) {
  const { release } = h.client.gateAbort(gateOpts);
  const steer = c.steer("pivot");
  await sleep(10);
  return { release, steer };
}

async function steerLosingToInterrupt(gateOpts) {
  const { h, c, id } = await withChild();
  const { release, steer } = await steerAtTheGate(h, c, gateOpts);
  await c.interrupt();
  release();
  return { c, h, id, out: await steer };
}

/**
 * Arm a turn replacement, then deliver bare terminal copies — endings with no
 * turn behind them, which is exactly what a just-replaced turn's in-flight
 * copies look like. A replacement that has been seen working for nothing yet
 * owns no ending, so none of them may settle it — and the one notice the parent
 * should end up with is the replacement's own ending, once it has run.
 */
async function echoesCannotSettle(child, arm) {
  const { c, h, id } = child;
  // The baseline must be QUIESCENT, not instant: a prior settle's delivery rides
  // the claim window, and a `before` taken at time zero would count that late
  // arrival as a premature notice — the count would be wrong in exactly the way
  // this test exists to catch, for the wrong reason. Whatever the arrangement
  // has legitimately delivered by now IS the baseline; the echoes under test
  // must add nothing to it.
  await drainNotices(h);
  const before = h.notices().length;
  await arm();
  await h.fireEvent(events.idle(id));
  await h.fireEvent(events.idle(id));
  assert.strictEqual(await stateOf(c), "State: active", "an echo is not the replacement turn's ending");
  await assertNoticeCount(h, before, "no premature completion is notified");
  await h.fireEvent(events.working(id));
  const note = await h.settledNotice(id);
  textDeclaresKind(note.message, "completed", "the eventual ending is still a settlement");
}

/**
 * One child, two turns, with turn one's settlement doomed — the harness fails
 * that first notification, arming a retry. What the caller's next line does is
 * decide WHEN the revival lands relative to the stale retry, which is the whole
 * subject of the two tests that start here.
 */
async function reviveAfterFailedDelivery() {
  const h = await setupTwoTurnHarness();
  const { id, c } = await h.spawn({ prompt: "turn one" });
  await h.settle(id); // attempt 1 fails; the retry is armed at the fixed backoff
  const cont = await c.steer("turn two");
  answerSays(cont, "Follow-up sent");
  return { c, h, id };
}

/**
 * That revival, raced against the stale retry from one side or the other.
 *
 * The two orderings are the whole point: the retry is armed at a fixed backoff, so
 * "the stale commit lands first" and "the revival lands first" are the two ways a
 * generation-keyed store gets this wrong, and one of them is a pass by accident.
 * The order is the argument, so it is the only thing the caller states, and both
 * runs must end with BOTH turns delivered.
 */
async function reviveRacingAStaleRetry(order) {
  const { h, id } = await reviveAfterFailedDelivery();
  if (order === "stale retry first") {
    await sleep(350); // the stale retry lands and commits while the revival is live
    await h.settle(id);
  } else {
    await h.settle(id);
    await sleep(600);
  }
  await assertBothTurnsDelivered(h);
}

/** Two turns, two settlements, and no suppression of the second. */
async function assertBothTurnsDelivered(h) {
  // Waited on: delivery rides the durable claim's bounded window, so reading the
  // count at time zero (or at a fixed sleep beside it) fails by arithmetic.
  await waitFor(() => h.notices().length >= 2, "both turns' notices to arrive");
  const notes = h.notices();
  assert.strictEqual(notes.length, 2, `both turns deliver. got: ${notes.length}`);
  assert.ok(notes[0].message.includes("TURN-ONE-OUTPUT"), `turn order preserved. first: ${notes[0]?.message}`);
  assert.ok(notes[1].message.includes("TURN-TWO-OUTPUT"), `second: ${notes[1]?.message}`);
}

/**
 * A child on an INBOX-CAPABLE host. The verdict is installed BY THE BOOT from
 * the mock's shape — arming a global around the boot would be overwritten the
 * moment setup probed a non-inbox fake — so the hook is the seam, and the
 * fixture names the arrangement every native-steer case starts from.
 */
const withInboxChild = () => withChild({ harness: { hooks: { inboxHost: true } } });

describe("task_continue branches", () => {

  it("rejects missing args and oversized prompts", async () => {
    const h = await setupHarness();
    await assertNeedsSessionId(h.tool.task_continue);
    const overlong = "x".repeat(100001);
    const long = await h.tool.task_continue.execute({ prompt: overlong, session_id: "ses_mock_1" });
    answerSays(long, "Prompt too long");
    });

  it("steers a still-running task — the turn stops and the message becomes the next turn", async () => {
    const { h, c, id } = await withChild();
    const out = await c.steer("follow up");
    answerSays(out, "Steer sent");
    answerSays(out, "task_interrupt", "names the stall recovery");
    assert.ok(wasAborted(h.client, id), "the running turn is stopped first");
        const followUps = promptsToCarrying(h.client, id, "follow up");
    assert.strictEqual(followUps.length, 1, "the message becomes the next turn");
    assert.ok(
    promptText(followUps[0]).includes("[Parent steer"),
    `framed as a preemption. got: ${promptText(followUps[0])}`,
    );
    assert.strictEqual(await stateOf(c), "State: active", "a steer never settles");
  });

  // The steer-storm contract (issue #36): the two ways a steer can land on an
  // active task are DIFFERENT operations with different costs, and the result
  // must say which happened. An in-flight turn makes the steer an abort of real
  // work; an idle one makes it a plain message. A host that did not answer the
  // presence read must not be dressed as either.
  const steerCases = [
    ["steering a child whose turn is in flight names the abort at the call",
      {}, async ({ c, h, id }) => {
        const result = await c.steer("pivot");
        assert.ok(result.includes("the in-flight turn was aborted"), "abort cost named at the call");
        assert.ok(wasAborted(h.client, id), "the running turn is stopped first");
        assert.ok(!result.includes("no turn was running"), "no idle claim on an in-flight turn");
      }],
    ["steering an active-idle task says the message was sent, not that work died",
      {}, async ({ c, h, id }) => {
        h.setHostStatus(id, "succeeded");
        const out = await c.steer("pivot");
        answerSays(out, "no turn was running", "the truth: nothing was aborted");
        answerSays(out, "it will read it on its next turn", "the idle wording");
        answerOmits(out, "aborted", "an idle task cost nothing");
                assert.strictEqual(promptsToCarrying(h.client, id, "pivot").length, 1, "the message still fires");
      }],
    ["an unanswered presence read is named as unknown, never dressed as either",
      { hooks: { presenceThrows: new Error("status down") } }, async ({ c }) => {
        const result = await c.steer("pivot");
        assert.ok(result.includes("did not answer"), "gap named as a gap");
        assert.ok(!result.includes("was aborted"), "no abort claim without a reading");
        assert.ok(!result.includes("no turn was running"), "and no idle claim either");
      }],
  ];
  for (const [name, harness, expect] of steerCases) {
    it(name, async () => {
      const ctx = await withChild({ harness });
      await expect(ctx);
    });
  }

  // The storm signature (issue #36): a SECOND steer of the same message inside
  // the window means the first steer's replacement turn was never allowed to
  // run, so the repeat must say so — in the same voice, once.
  it("a repeat steer of the same message inside the window names the discarded turn", async () => {
    const { c } = await withChild();
    await c.steer("pivot");
    const out = await c.steer("pivot");
    answerSays(out, "This is a repeat steer", "the storm signature is named");
    answerSays(out, "before it could do its work", "the discarded turn is named");
  });

  it("a steer with a different message is not marked as a repeat", async () => {
    const { c: child } = await withChild();
    await child.steer("pivot");
    const other = await child.steer("other direction");
    answerSays(other, "no turn was running", "the second steer's own truth");
    answerOmits(other, "repeat steer", "a different message is a fresh instruction, not a storm");
  });

  // --- The native steer (Session Inbox host, v2.1.4+) ------------------------
  // On a host that presents the inbox surface, steering a running child is one
  // prompt with delivery "steer": the host promotes it at the child's next step
  // boundary. No abort is ordered, so no work is discarded — and the machinery
  // that existed to police the abort (the turn-replacement stamp, the echo
  // suppression) is dead weight on this path. The liveness read stays, because
  // the result still says WHICH steer happened, but its wording is the native
  // truth: steered, not aborted.
  it("steering a running child on an inbox host sends the prompt with delivery steer and aborts nothing", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { inboxHost: true } } });
    const steerResult = await c.steer("follow up");
    assert.ok(!wasAborted(h.client, id), "no interrupt is ordered");
    answerSays(steerResult, "Steer sent", "the steer is confirmed");
    answerSays(steerResult, "next step boundary", "the native cost is named: none");
    answerOmits(steerResult, "aborted", "nothing was aborted");
        assert.deepStrictEqual(deliveriesTo(h.client, id), ["steer"], "the prompt carried the native delivery");
    assert.strictEqual(promptsToCarrying(h.client, id, "follow up").length, 1, "the message is the parent's words");
    const state = await stateOf(c);
    assert.ok(state.includes("State: active"), "a steer never settles");
  });

  // One hypothesis: a disturbance that is not a terminal signal — an abort echo
  // from a steer, a retryable transport blip — leaves the task active and

  // silent, so nothing is deafened and the child's own terminal event settles it.
  const disturbScenarios = [
    // The steer makes the child echo the abort, and that first idle IS the echo:
    // the next genuine event is the one that settles. Fired bare, because an
    // echo by definition arrives with no turn behind it.
    ["a steered turn's abort echo never settles the task, but the next genuine event does",
      {}, async ({ c, h, id }) => { await c.steer("pivot"); await h.fireEvent(events.idle(id)); }],
    // A transport blip (ETIMEDOUT) says nothing about the child: the turn may
    // well be running, so the task stays active and waits for its own event.
    ["a retryable prompt failure leaves the task active — its event settles it",
      { hooks: { childPromptFailOnce: { code: "ETIMEDOUT", message: "connect ETIMEDOUT" } } },
      async () => { await sleep(50); }], // the fire-and-forget catch has run
  ];
  for (const [scenarioName, scenarioHarness, scenarioDisturb] of disturbScenarios) {
    it(scenarioName, async () => {
      const scenarioCtx = await withChild({ harness: scenarioHarness });
      await scenarioDisturb(scenarioCtx);
      const status = await scenarioCtx.c.status();
      answerSays(status, "active", "a non-terminal signal must not settle");
      await assertNoticeCount(scenarioCtx.h, 0, "nothing is notified");
      const note = await scenarioCtx.h.settledNotice(scenarioCtx.id);
      textDeclaresKind(note.message, "completed", "the real event still settles");
    });
  }

  // The NATIVE steer (an inbox-capable host) is not an abort: the message is
  // promoted at the running turn's next step boundary, so no work is discarded
  // and no replacement turn exists. The abort-echo cases above are LEGACY
  // semantics; on a capable host a bare terminal event after a steer IS the
  // genuine ending — no stamp may suppress it — and no abort may reach the
  // transport at all.
  describe("a native steer on an inbox-capable host", () => {
    it("steers without ordering an abort — the turn keeps running", async () => {
      const { c, h } = await withInboxChild();
      const out = await c.steer("pivot");
      answerSays(out, "Steer sent", "the steer is reported");
      answerOmits(out, "no abort is claimed", "abort");
      assert.deepStrictEqual(h.client.testState.abortAttempts, [], "no interrupt was ordered");
      assert.strictEqual(await stateOf(c), "State: active", "the task stays active");
    });

    it("carries the message into the child's context as a promoted prompt, not a replacement turn", async () => {
      const inboxChild = await withInboxChild();
      const { c, h, id } = inboxChild;
      await c.steer("pivot");
            const deliveries = h.client.testState.promptDeliveries.filter((d) => d.to === id);
      assert.ok(deliveries.length >= 1, "the delivery was recorded");
      assert.deepStrictEqual(deliveries[deliveries.length - 1].delivery, "steer", "the steer verdict rode the prompt");
    });

    it("arms no echo suppression — a bare terminal event after the steer is the genuine ending", async () => {
      const { c, h, id } = await withInboxChild();
      await c.steer("pivot");
      await h.fireEvent(events.idle(id));
      await waitFor(() => h.notices().length >= 1, "the settlement to arrive");
      const note = h.noticeFor(id);
      textDeclaresKind(note?.message ?? "", "completed", "the terminal event settles normally — nothing to suppress");
    });
  });

  // A turn end is published more than once: the host's status channel and the
  // idle event each say the turn ended. The one-shot steer claim consumed the
  // FIRST of them, so the second settled the replacement turn as completed
  // while the child was still working — a "completed successfully" notice with
  // mid-work text as the latest output, and a ledger deaf to the real ending.
  it("a turn end that publishes several terminal events cannot settle a just-steered turn", async () => {
    const { h, c, id } = await withChild();
    await echoesCannotSettle({ c, h, id }, () => c.steer("pivot"));
  });

  // A transcript the plugin cannot read cannot back a success, so the
  // settlement reads error and names the missing quote, not silence.
  it("a settlement whose transcript cannot be read settles error, and says the quote is missing", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ prompt: "turn one" });
    h.client.makeUnreadable(id);
    await h.settle(id);
    await sleep(20);
    const notice = h.noticeFor(id);
    assert.ok(notice, "the outcome is the parent's only route to the child — it cannot ride behind a read");
    textDeclaresKind(notice.message, "error", "a success we cannot read is none");
    answerMatches(
      notice.message,
      /transcript could not be read/,
      `names the missing quote instead of passing silence off as one`,
    );
  });

  // The host holds a write to a mid-turn parent rather than refusing it, and the
  // hold can outlast the parent's attention. A pending record is the honest
  // interim state; a FAILED one would be a lie the parent recovers from wrongly.
  it("a write the host holds reads as PENDING, not FAILED, and is delivered once when the host answers", async () => {
    await bounded(20, async () => {
      const held = deferred();
      const h = await setupHarness({ hooks: { notifyTransport: { hang: held.promise } } });
      const { id, c } = await h.spawn({ prompt: "turn one" });
      await h.settle(id, "completed");
      // The dial rides the claim window before it parks on the hang, so PENDING
      // is waited on, not slept for.
      await waitFor(async () => {
        const status = await c.status();
        return status.includes("PENDING");
      }, "the held write to read as PENDING");
      assert.doesNotMatch(await c.status(), /FAILED/, "held is not failed — the host may still deliver it");
      held.resolve();
      await held.promise;
      await sleep(20);
      answerMatches(await c.status(), /delivered in 1 attempt/, "the record ends up truthful");
      assert.strictEqual(
        dialCount(h.client),
        1,
        "exactly one copy ever dialed: a held write is never retried behind the parent's back",
      );
    });
  });

  // M9: a settlement can still win a steer — the running turn can complete
  // inside the abort window, and the replaced turn's own prompt delivery can
  // fail there. Either way the steer re-validates, finds a settled task, and
  // revives it in the same call rather than demanding a second round-trip.
  //
  // Both settlers are here because they are not the same code path, and the
  // sequence a live smoke test ran is one where the parent ended up with no
  // notification at all. Whatever the live transport did, the contract is: a
  // revived turn settles on its own and its settlement is delivered, so the
  // assertion below is the parent's only route to that outcome.
  const midSteerSettlers = [
    ["the running turn completing", async ({ h, c }) => { await h.settle(c.id, "completed"); }],
    ["the replaced turn's prompt delivery failing", async ({ release }) => { release(); }],
  ];
  for (const [name, settle] of midSteerSettlers) {
    it(`a steer racing ${String(name)} auto-revives, and the revived turn still notifies`, async () => {
      const h = await setupHarness();
      const { release } = h.client.gateChildPrompt();
      const { c } = await h.spawn({ prompt: "turn one" });
      const { release: releaseAbort, steer } = await steerAtTheGate(h, c);
      await settle({ c, h, release });
      await sleep(30);
      releaseAbort(); // the abort lands; the steer re-validates and finds it settled
      const out = await steer;
            answerSays(out, "revived", "closes the loop in one call");
      assert.strictEqual(
        promptTextsTo(h.client, c.id).filter((t) => t === "pivot").length,
        1,
        "the message fires as the fresh turn",
      );
      await h.settle(c.id, "completed");
      await sleep(20);
      answerMatches(await c.status(), /State: completed/, "the revived turn settles on its own");
      await assertNoticeCount(h, 2, "the settlement the parent was told about, and the one that carries the outcome");
    });
  }

  it("a task settling mid-steer never receives the replacement prompt", async () => {
    const { h, out } = await steerLosingToInterrupt();
    answerSays(out, "interrupted", "truthful report");
    answerOmits(out, "Steer sent", "must not claim a steer that never happened");
    assert.strictEqual(promptsSaying(h.client, "pivot"), 0, "no replacement prompt fires on a settled task");
    });

  it("a steer racing a concurrent settlement reports the winner truthfully", async () => {
    const { h, out } = await steerLosingToInterrupt({ fails: true });
    answerSays(out, "interrupted", "reports the actual winner");
    answerOmits(out, "settled as error", "no false error claim");
    assert.strictEqual(
    h.notices().filter((n) => n.message.includes("Steer failed")).length,
    0,
    "no second notice over the winner's outcome",
    );
    });

  it("steer on a vanished session settles error instead of stranding", async () => {
    const { c } = await withChild({ harness: { hooks: { abortFailIds: new Set(["ses_mock_1"]) } } });
    answerSays(await c.steer("pivot"), "not found");
    assert.strictEqual(await stateOf(c), "State: error", "settled error, never stranded active");
  });

  it("a failed steer abort stays active and sends nothing", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.steer("pivot");
    answerSays(out, "abort failed", "reports the gap");
    answerSays(out, "active", "admits the child may be live");
    assert.strictEqual(promptsSaying(h.client, "pivot"), 0, "no competing prompt races the live turn");
    assert.strictEqual(await stateOf(c), "State: active", "stays settable");
    await h.settle(id);
    await assertNoticeCount(h, 1, "the live turn still settles");
  });

  it("revives a settled task and the new turn settles again", async () => {
    const { h, c, id } = await withSettledChild();
    await assertNoticeCount(h, 1, "first turn settles");

    const out = await c.steer("summarize");
    answerSays(out, "Follow-up sent");
        const followUps = promptsToCarrying(h.client, id, "summarize");
    assert.strictEqual(followUps.length, 1, "the same session is revived, not replaced");

    // The settled turn published its ending more than once, and the extra copy
    // can still be in flight when the revival fires — so the revived turn runs
    // its own events before it can end.
    await h.fireEvent(events.working(id));
    await h.settle(id);
    await assertNoticeCount(h, 2, "revival earns a fresh settlement");
    textDeclaresKind(h.noticeBodies()[1], "completed", "and the notice says so");
  });

  it("a late echo from the turn a revival replaced cannot settle the revival", async () => {
    const { h, c, id } = await withSettledChild();
    await echoesCannotSettle({ c, h, id }, () => c.steer("continue"));
  });

  it("interrupted children are not revived — the guidance says spawn fresh", async () => {
    const { c } = await withChild();
    await c.interrupt();
    const out = await c.steer("again");
    answerSays(out, "not revived");
    answerSays(out, "dynamic_task", "points at the fresh-spawn path");
  });

  it("a revived turn does not wear the previous turn's notification", async () => {
    const { c } = await withSettledChild();
    await sleep(10);
    await c.steer("again");
    await statusOmits(c, "Last notification", "new turn, nothing reported yet");
    const summary = await c.result();
    answerOmits(summary, "Last notification", "same for result reads");
  });

  it("reviving with a model override reroutes and persists it", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ model: "nvidia/z-ai/glm-5.3" });
    await h.settle(id);
    const out = await h.tool.task_continue.execute({ model: "other/thing-1", prompt: "again", session_id: id });
    answerSays(out, "Follow-up sent");
    await sleep(0); // fire-and-forget prompt lands on the next microtask
        // v2 routes via `switchModel`, not a model key on the prompt body — the prompt
    // itself carries only text, and the route is the host's own record of it.
    assert.deepStrictEqual(h.client.testState.routed.get(id), { agent: "explore", modelID: "thing-1", providerID: "other" });
    await statusSays(c, "Model: other/thing-1", "persists on the record");
    });

  it("a bare model on continue fails without touching the task", async () => {
    const { h, c, id } = await withSettledChild();
    const before = sentPrompts(h.client).length;
    const out = await h.tool.task_continue.execute({ model: "bare-id", prompt: "again", session_id: id });
    answerSays(out, "Invalid model");
    assert.strictEqual(sentPrompts(h.client).length, before, "no prompt fires");
    await statusSays(c, "completed", "still settled");
  });

  it("unknown sessions are refused as untracked", async () => {
    const h = await setupHarness();
    const out = await h.tool.task_continue.execute({
      prompt: "hello?",
      session_id: "ses_missing",
      });
    answerSays(out, "not a tracked task");
    });
});

describe("error settlement guidance", () => {
  // A transient failure no longer produces a notice at all: it is resumed in
  // silence under a budget, and the parent hears about it only once that budget
  // is spent. That contract, and the guidance a spent budget carries, live in
  // transient-resume.test.js — where the feature is now tested rather than here,
  // because it is no longer about task_continue.
  //
  // What is left in this file is the half that is true of every REPORTED
  // failure: a fatal cause keeps its own words, and is never dressed up as a blip.
  it("fatal error settlements carry no resume hint", async () => {
    const { h, id } = await childFailingWith("permission denied for model");
    await h.fireEvent(events.error(id));
    await assertNoticeCount(h, 1, "error settles exactly once");
    const [note] = h.noticeBodies();
    answerSays(note, "permission denied", "keeps the cause");
    answerOmits(note, "transient", "no resume hint for fatal");
  });
});

// ─── Outcome correctness (field repro 2026-09-11T19:30:00.485Z) ─────
// A provider 429 exhausts retries and the server emits session.error (payload
// in properties.error, NO status) plus a terminal idle. The message stream
// records the failure on the assistant message's info.error. The old handler
// read only event status paths, saw "", and told the parent "completed
// successfully" with "Latest output: (completed)". These tests pin the fix.

describe("outcome correctness: failed turns never report success", () => {
  // Fatal by the host's own verdict: isRetryable:false means the host calls the
  // turn dead, so these report error. A retryable:true error on an idle is the
  // host reestablishing the connection — the plugin defers to it and resumes
  // silently within the budget (covered in settlement.test.js).
  const erroredMessages = () => [
  { info: { role: "user" }, parts: [] },
  {
    info: { error: { data: { isRetryable: false, message: "Too Many Requests", statusCode: 429 }, name: "APIError" }, role: ASSISTANT_ROLE },
    parts: [],
    },
  ];

  // One hypothesis: a child the host can no longer vouch for settles as ERROR
  // and never claims success — whether the messages say so or the session is
  // simply gone. Each case brings its own way of being unvouchable.
  const unvouchable = [
    ["idle terminal event over an errored message stream notifies error, not success",
      { messages: erroredMessages }, (id) => events.idle(id, {}), "Too Many Requests"],
    ["deleted session with stale idle status notifies error, never success",
      {}, (id) => events.deleted(id, { info: { status: "idle" } }), null],
  ];
  for (const [name, hooks, terminal, detail] of unvouchable) {
    it(name, async () => {
      const h = await setupHarness({ hooks });
      const { id, c } = await h.spawn({ description: "unvouchable child" });
      const notice = await h.noticeAfter(terminal(id));
      const note = notice.message;
      textDeclaresKind(note, "error", "must report error");
      if (detail) assert.ok(note.includes(detail), `must carry provider detail. got: ${note}`);
      const state = await c.status();
      assert.ok(state.includes("error"), `state settles error. got: ${state}`);
    });
  }

  it("session.error event notifies error even when hydration finds nothing", async () => {
    const h = await eventHarness({ messages: () => [] });
    const { id } = await h.spawn({ description: "err evt" });
    const note = await h.noticeAfter(
      events.error(id, { data: { message: "Too Many Requests" }, name: "APIError" }),
    );
    textDeclaresKind(note.message, "error", "the error event settles error");
  });

  it("a burst of terminal events notifies the parent exactly once", async () => {
    const h = await eventHarness({ messages: erroredMessages });
    const { id } = await h.spawn({ description: "burst" });
    // The field log showed three terminal events within 1ms for one failure.
    await Promise.all([
    h.fireEvent(events.error(id)),
    h.fireEvent(events.idle(id)),
    h.fireEvent(events.idle(id, {})),
    ]);
    await sleep(30);

    await assertNoticeCount(h, 1, "single winner must notify once");
    textDeclaresKind(h.noticeBodies()[0], "error", "the winner's notice says what happened");
    });

  // The poisoning window: turn 1's delivery fails attempt 1, the operator
  // continues before the 250ms retry resolves, and the retry then succeeds —
  // an in-flight commit from the old generation must not reserve the key
  // that turn 2's settlement needs.
  it("a revived turn is never suppressed by its predecessor's late retry", async () => {
    await reviveRacingAStaleRetry("stale retry first");
  });

  // Same harness, opposite timing: the revival lands BEFORE the retry
  // resolves, so serialization — not generations — carries the order.
  it("turns settle in claim order — a stale retry never jumps a new turn", async () => {
    await reviveRacingAStaleRetry("revival first");
  });

  it("concurrent interrupts converge on interrupted, never stuck-active", async () => {
    const h = await setupHarness();
    const { release } = h.client.gateAbort({ fails: true });
    const {c} = (await h.spawn());
    const p1 = c.interrupt();
    await sleep(10);
    const r2 = await c.interrupt();
    release();
    await p1;
    answerOmits(r2, "not a tracked task", "second interrupt sees the tracked task");
    await statusSays(c, "interrupted", "converges interrupted");
    });

  it("boot restore honors the configured retention cap", async () => {
    await withEnv(ENV.retainedTaskMaxEntries, "2", async () => {
      const h = await bootOn((now) => {
        const tasks = {};
        for (let i = 1; i <= 4; i++) {
          tasks[`ses_boot${i}`] = retainedEntry({
            childSessionId: `ses_boot${i}`,
            parentSessionId: "p",
            retainedAt: now - i,
            startedAt: now - 1000,
          });
        }
        return { tasks };
      });
      const list = await h.tool.task_list.execute({});
      answerSays(list, "Retained: 2", "configured cap honored");
    });
  });

  it("clean completions still report success unchanged", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "clean" });
    const note = await h.settledNotice(id);
    textDeclaresKind(note.message, "completed", "a clean completion settles completed");
    answerSays(note.message, "COMPLETED_OK", "carries assistant text");
    });

  it("a deleted session settles as error, never as success", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "deleted child" });
    const notice = await h.noticeAfter(events.deleted(id));
    const note = notice.message;
    textDeclaresKind(note, "error", "deletion is a failure");
    });
});
