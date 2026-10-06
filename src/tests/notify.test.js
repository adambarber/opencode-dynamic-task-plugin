//jscpd:ignore-start
import { answeredClient, boot, gate, heldWriteClient, queuedFor, withUnansweredWrite, writesTo } from "./support/notify-setup.js";
import { assert, describe, it } from "./support/runner.js";
import { formatParentNotification, isParentNotification, notificationTag } from "../../dist/shared/notification-text.js";
import { gateLedger, getLatestNotification, noticeDedupKey, notifyParent, truncateText } from "../../dist/shared/notify.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { bounded } from "./support/harness.js";
import { opaqueHost } from "./support/opaque-host.js";
//jscpd:ignore-end
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
    return { owed: queuedFor(CHILD).map((entry) => entry.attempts), writes: calls.length };
  };
  // One transcript, three shapes, and the difference IS the check: a clock with no
  // completion is a turn the host abandoned, while no clock at all is a host that
  // described nothing — and reading the second as the first declares every parent
  // the plugin cannot fully describe dead. `ASSISTANT_ROLE`, not a retyped word.
  const stuckTurn = (at) => [{ parts: [], role: ASSISTANT_ROLE, time: { created: at } }];
  const BUSY = ({ setStatus }) => setStatus("parent_1", "open");
  const WEDGED = ({ setMessages }) => setMessages("parent_1", stuckTurn(1));
  const CLOCKLESS = ({ setMessages }) => setMessages("parent_1", [{ parts: [], role: ASSISTANT_ROLE }]);
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
    it(`a parent that is ${String(label)} at EVERY boot still reaches the bound and retires`, async () => {
      const { held, record } = await aDebtWalkedToItsBound(world, `a ${JSON.stringify(label)} refusal spends an attempt`);

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
    const first = noticeDedupKey(`${"a".repeat(200)  }1`);
    const second = noticeDedupKey(`${"a".repeat(200)  }2`);
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
