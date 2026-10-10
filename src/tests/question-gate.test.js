/**
 * The permission gate, end to end — a child's ask reaches the plugin, and the gate
 * closes it.
 *
 * Two claims, one subject: that the event the host ACTUALLY publishes reaches the
 * gate at all, and that what it answers with is the shape the host accepts. Both
 * used to be two tests, which is why they drifted — and the drift is the defect
 * class: a gate that answers on a shape the host rejects looks identical to one
 * that works, right up until a live child waits forever.
 *
 * v2 is why this suite has one answer instead of two. `permission.asked` carries
 * `{id, sessionID, action, resources}` with no options and no labels, so there is
 * no "best choice" left to compute: the only answer the plugin API accepts is
 * `permission.reply({decision: "once" | "always" | "reject"})`, and DENY is it.
 */

//jscpd:ignore-start
import { answerMatches, answerOmits, answerSays, assertNoticeCount, assertPermissionDenied, stateOf } from "./support/assertions.js";
import { setupHarness, withAskedChild, withChild, withLoggedChild } from "./support/harness.js";
import { events } from "./support/mock-host.js";
import { assert, describe, it } from "./support/runner.js";

//jscpd:ignore-end
describe("permission gate: child asks settle", () => {
  it("a live child's ask is denied, at the host's own route and shape", async () => {
    const { h } = await withAskedChild("q1");
    const calls = h.permissionCalls();
    assert.strictEqual(calls.length, 1, "permission.asked must reach the gate — it is the spelling the host publishes");
    assert.deepStrictEqual(
      calls[0],
      { decision: "reject", requestID: "q1", sessionID: calls[0]?.sessionID },
      "v2 answers a whole request with one decision word, and deny is the only one this plugin grants",
    );
    assertNoticeCount(h, 0, "a denied ask is settled, not a stall");
  });

  // A refusal has no body in v2 — `permission.reply` carries a decision and nothing
  // else — so the reason has no channel from this gate to the asking session. The
  // promise this gate used to make, that the reason is the child's only description
  // of what it can do next, was undeliverable by the very mechanism claiming it,
  // and misaddressed besides: it told the READER (the parent) to call task_notify,
  // a child-only tool. So the claim reaches the operator through the last-notice
  // line, and must LEAD with the parent's remedy — that line truncates at 120
  // chars, and a diagnosis-first message told the operator what happened and not
  // what to do.
  it("the refusal is the parent's to act on, and the reason is recorded for the operator", async () => {
    const { h, c } = await withAskedChild("q2");
    assert.strictEqual(assertPermissionDenied(h).requestID, "q2", "denied by request id, at the host's route");
    const claim = await c.status();
    answerMatches(claim, /Last notice/, "the refusal is recorded for the operator");
    answerMatches(claim, /task_continue/, "names the tool the PARENT holds");
    assert.doesNotMatch(claim, /task_notify/, `never tells the parent to use a child-only tool. got: ${claim}`);
    assert.ok(!/when it resumes/.test(claim), `never tells anyone to wait. got: ${claim}`);
  });

  it("unmatched asks are left untouched (fail-closed scoping)", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.permissionAsked(undefined, { action: "edit", id: "q1", resources: [] }));
    await h.fireEvent(events.ask("ses_stranger", "q9"));
    await h.fireEvent(events.permissionReplied({ requestID: "q1" }));
    assertNoticeCount(h, 0, "no parent traffic for asks");
    assert.strictEqual(h.permissionCalls().length, 0, "never touches foreign asks");
  });

  // The gate is the plugin BLOCKING the child: it denied the ask, so it knows the
  // child cannot finish on that point — it knows more than the child recorded. If
  // the child does not itself call task_notify, the settlement read nothing and
  // reported the block as a success — the same false success arriving through a
  // different door. The gate is the second source of the claim, and it must reach
  // the same funnel.
  it("a denied ask is a block the settlement must not report as a success", async () => {
    const { h, c, id } = await withAskedChild("q-block");
    assert.strictEqual(assertPermissionDenied(h).requestID, "q-block");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked", `the gate's block is the record's block.`);
  });

  it("a child that asked nothing is never blocked", async () => {
    const { h, c, id } = await withChild();
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed", `no ask means no block.`);
    assert.strictEqual(h.permissionCalls().length, 0, "and the gate stays off the host entirely");
  });

  // A settled child cannot answer its own ask and its answer would be worthless
  // anyway, so it is closed. The guidance cannot ride the refusal (no body), so it
  // is asserted in the log — the operator's copy.
  it("a settled child's ask is denied, and the reason is recorded where it can be read", async () => {
    await withLoggedChild({}, async ({ h, id, log }) => {
      await h.fireEvent(events.ask(id, "q3"));
      assertPermissionDenied(h);
      const text = log();
      answerMatches(text, /ask-retained-denied/, "the denial is logged as one");
      answerMatches(text, /settled/i, "and it says the task is settled");
    });
  });

  it("a failed denial is logged as failed, never as denied", async () => {
    await withLoggedChild({ hooks: { permissionReplyThrows: true } }, async ({ h, id, log }) => {
      await h.fireEvent(events.ask(id, "q9"));
      const text = log();
      answerSays(text, "ask-retained-deny-failed", "failure logged");
      answerOmits(text, '"eventName":"ask-retained-denied"', "must not claim the denial");
    });
  });

  // The gate used to remember which session owned which ask id, and forget that
  // when a reply arrived — a cross-event correlation the host makes unnecessary,
  // because an asked permission NAMES its session. A stale entry would divert a
  // later ask from someone else onto a task already closed. Reading the owner off
  // the event cannot go stale.
  it("an ask id already used by a tracked task cannot divert a foreign ask onto it", async () => {
    const h = await setupHarness();
    const mine = await h.spawn({ description: "tracked owner" });
    await h.fireEvent(events.ask(mine.id, "q-shared"));
    assert.strictEqual(h.permissionCalls().length, 1, "the tracked task's ask is denied");
    await h.fireEvent(events.permissionReplied({ requestID: "q-shared", sessionID: "ses_someone_else" }));
    await h.fireEvent(events.ask("ses_someone_else", "q-shared"));
    assert.strictEqual(h.permissionCalls().length, 1, "a foreign ask is never settled on the tracked task's behalf");
  });

  it("a retired ask is not a settlement the gate owes anyone", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.permissionReplied({ requestID: "q-done", sessionID: "ses_x" }));
    await h.fireEvent(events.permissionCancelled({ requestID: "q-done", sessionID: "ses_x" }));
    assert.strictEqual(h.permissionCalls().length, 0, "the gate acts on asks, not on retirements");
  });
});