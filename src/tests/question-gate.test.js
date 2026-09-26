/**
 * The question gate, end to end — a child's question reaches the plugin, and the
 * gate answers it or closes it.
 *
 * Two claims, one subject: that the event the host ACTUALLY publishes reaches the
 * gate at all, and that what it answers with is the shape the host accepts. Both
 * used to be two tests, which is why they drifted — and the drift is the defect
 * class: a gate that answers on a shape the host rejects looks identical to one
 * that works, right up until a live child waits forever. `question.asked` is the
 * spelling; /question/{requestID} and one entry per asked question are the
 * contract.
 */

import { describe, it } from "./support/runner.js";
import assert from "node:assert";
import { setupHarness, withAskedChild, withChild, withLoggedChild } from "./support/harness.js";
import { events } from "./support/mock-host.js";
import { answerMatches, answerOmits, answerSays, assertNoticeCount, assertQuestionRejected, stateOf } from "./support/assertions.js";

describe("question gate: child questions settle", () => {
  it("an active child with options is answered, at the host's own route and shape", async () => {
    const { h } = await withAskedChild("q1", "yes", "no");
    const calls = h.questionCalls();
    assert.strictEqual(calls.length, 1, "question.asked must reach the gate — it is the spelling the host publishes");
    assert.deepStrictEqual(
      calls[0],
      { method: "reply", requestID: "q1", answers: [["yes"]] },
      "the first option is the answer, addressed at /question/{requestID}/reply",
    );
    assertNoticeCount(h, 0, "an answered question is not a block");
  });

  // Nothing to answer with means reject, not silence. The reject endpoint
  // declares `body?: never` and returns a bare boolean, so a reason has no
  // channel from this gate to the asking session — the promise this gate used to
  // make, that the reason is the child's only description of what it can do
  // next, was undeliverable by the very mechanism claiming it, and misaddressed
  // besides: it told the READER (the parent) to call task_notify, a child-only
  // tool. So the claim reaches the operator through the last-notice line, and
  // must LEAD with the parent's remedy — that line truncates at 120 chars, and
  // a diagnosis-first message told the operator what happened and not what to do.
  it("a question the gate cannot answer is rejected, and the claim is the parent's to act on", async () => {
    const { h, c } = await withAskedChild("q2");
    const call = assertQuestionRejected(h);
    assert.strictEqual(call.requestID, "q2", "refused at the host's own route");
    const claim = await c.status();
    answerMatches(claim, /Last notice/, "the refusal is recorded for the operator");
    answerMatches(claim, /task_continue/, "names the tool the PARENT holds");
    assert.doesNotMatch(claim, /task_notify/, `never tells the parent to use a child-only tool. got: ${claim}`);
    assert.ok(!/when it resumes/.test(claim), `never tells anyone to wait. got: ${claim}`);
  });

  it("unmatched question events are left untouched (fail-closed scoping)", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.questionAsked(undefined, { id: "q1", questions: [] }));
    await h.fireEvent(events.ask("ses_stranger", "q9", "yes"));
    await h.fireEvent(events.questionReplied({ requestID: "q1" }));
    assertNoticeCount(h, 0, "no parent traffic for questions");
    assert.strictEqual(h.questionCalls().length, 0, "never touches foreign questions");
  });

  // `answers` is one entry per asked question, so the gate can satisfy a
  // single-part ask and nothing else. Answering the first part of a two-part
  // ask would retire the question with the child never having seen the second
  // answer — a silent loss wearing a success, which is the exact failure the
  // question gate exists to prevent. So a multi-part ask is a rejection.
  it("a multi-part ask is rejected, never half-answered", async () => {
    const { h, id } = await withChild();
    await h.fireEvent(
      events.questionAsked(id, {
        id: "q-multi",
        questions: [events.hostQuestion("A?", ["a1"]), events.hostQuestion("B?", ["b1"])],
      }),
    );
    const call = assertQuestionRejected(h);
    assert.strictEqual(call.requestID, "q-multi", "rejected by id, at the host's route");
  });

  // The gate is the plugin BLOCKING the child: it refused the question, so it
  // knows the child cannot finish on that point — it knows more than the child
  // recorded. If the child does not itself call task_notify, the settlement read
  // nothing and reported the block as a success — the same false success,
  // arriving through a different door. The gate is the second source of the
  // claim, and it must reach the same funnel.
  it("a question the gate could not answer is a block the settlement must not report as a success", async () => {
    const { h, c, id } = await withAskedChild("q-block");
    assert.strictEqual(assertQuestionRejected(h).requestID, "q-block");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked", `the gate's block is the record's block.`);
  });

  it("a question the gate ANSWERED is not a block — the child kept moving", async () => {
    const { h, c, id } = await withAskedChild("q-answered", "yes");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed", `an answered question blocks nothing.`);
  });

  // A settled child cannot answer its own question and its answer would be
  // worthless anyway, so the question is closed. The guidance cannot ride the
  // rejection (no body), so it is asserted in the log — the operator's copy.
  it("a settled child's question is rejected, and the reason is recorded where it can be read", async () => {
    await withLoggedChild({}, async ({ h, id, log }) => {
      await h.fireEvent(events.ask(id, "q3", "yes"));
      assertQuestionRejected(h);
      const text = log();
      answerMatches(text, /question-retained-rejected/, "the settlement is logged as one");
      answerMatches(text, /settled/i, "and it says the task is settled");
    });
  });

  it("a failed retained rejection is logged as failed, never as rejected", async () => {
    await withLoggedChild({ hooks: { questionRejectThrows: true } }, async ({ h, id, log }) => {
      await h.fireEvent(events.ask(id, "q9", "yes"));
      const text = log();
      answerSays(text, "question-retained-reject-failed", "failure logged");
      answerOmits(text, '"eventName":"question-retained-rejected"', "must not claim rejection");
    });
  });

  // The gate used to remember which session owned which question id, and forget
  // that when a reply arrived — a cross-event correlation the host makes
  // unnecessary, because an asked question NAMES its session. A stale entry
  // would divert a later question from someone else onto a task already
  // answered. Reading the owner off the event cannot go stale.
  it("a question id already used by a tracked task cannot divert a foreign question onto it", async () => {
    const h = await setupHarness();
    const mine = await h.spawn({ description: "tracked owner" });
    const asked = { id: "q-shared", questions: [events.hostQuestion("Ship it?", ["yes"])] };
    await h.fireEvent(events.questionAsked(mine.id, asked));
    assert.strictEqual(h.questionCalls().length, 1, "the tracked task's question is answered");
    await h.fireEvent(events.questionReplied({ sessionID: "ses_someone_else", requestID: "q-shared" }));
    await h.fireEvent(events.questionAsked("ses_someone_else", asked));
    assert.strictEqual(
      h.questionCalls().length,
      1,
      "a foreign question is never settled on the tracked task's behalf",
    );
  });

  it("a retired question event is not a settlement the gate owes anyone", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.questionReplied({ sessionID: "ses_x", requestID: "q-done" }));
    await h.fireEvent(events.questionRejected({ sessionID: "ses_x", requestID: "q-done" }));
    assert.strictEqual(h.questionCalls().length, 0, "the gate acts on asked questions, not on retirements");
  });

  it("reply failure falls back to rejection", async () => {
    const failing = await setupHarness({ hooks: { questionReplyThrows: true } });
    const { id } = await failing.spawn();
    await failing.fireEvent(events.ask(id, "q4", "yes"));
    const calls = failing.questionCalls();
    assert.ok(calls.some((c) => c.method === "reject"), "fallback rejection must fire");
    });
});
