/**
 * task_notify — the child's one channel to its parent.
 *
 * A notice is not a settlement: the child is still running, and the record has to
 * say so while recording what it said. The one gesture that changes an outcome is
 * `needs_input`, and that is why it lives here rather than in the settlement
 * file — a child declaring it is stuck is the child speaking, and the settlement
 * only reads what the channel recorded.
 */

import assert from "node:assert";
import { agentDeclaring, allowAction, denyAction, events } from "./support/mock-host.js";
import { answerMatches, answerOmits, answerSays, assertNoticeCount, stateOf, stillActive, textDeclaresKind } from "./support/assertions.js";
import { bounded, confirmationFor, declareNeedsInput, promptTextsTo, setupHarness, sleep, withChild, withSettledChild } from "./support/harness.js";
import { describe, it } from "./support/runner.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { bootOn } from "./support/integration.js";

describe("task_notify: the child-to-parent channel", () => {

  it("delivers a mid-flight notice and leaves the task active", async () => {
    const { h, c, id } = await withChild();
    const out = await c.notify("blocked: need DB credentials");
    answerSays(out, "Message sent to parent");
    const notes = h.notices();
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].to === "p1", "notice routes to the parent session");
    assert.ok(notes[0].message.includes("running child task"), `notice kind. got: ${notes[0].message}`);
    assert.ok(notes[0].message.includes("blocked: need DB credentials"));

    // A notice is not a settlement: the child still completes and reports.
    const status = await stillActive(c, "task stays active");
    answerSays(status, "need DB credentials", "notice recorded on the task");

    await h.settle(id);
    assertNoticeCount(h, 2, "settlement still reports");
  });

  it("distinct long notices sharing a prefix both deliver", async () => {
    const { h, c } = await withChild();
    const first = await c.notify(`${"a".repeat(200)  }1`);
    const second = await c.notify(`${"a".repeat(200)  }2`);
    answerSays(first, "Message sent to parent");
    answerSays(second, "Message sent to parent", "prefix collision must not suppress");
    assertNoticeCount(h, 2, "two long notices sharing a prefix both deliver");
  });

  // One hypothesis: a repeat of an identical notice never redelivers, and the
  // child is told both that and what to do instead.
  it("a suppressed duplicate says to say something new", async () => {
    const { h, c } = await withChild();
    await c.notify("still working");
    const again = await c.notify("still working");
    answerSays(again, "duplicate suppressed", "keeps the kind");
    answerSays(again, "Say something new", "tells the child what to do");
    assertNoticeCount(h, 1, "the parent hears it once");
  });

  it("an unreachable parent is reported distinctly from a duplicate", async () => {
    const { c } = await withChild({ harness: { hooks: { promptFailIds: new Set(["p1"]) } } });
    const out = await c.notify("hello?");
    answerSays(out, "did not acknowledge", "names the failure");
    answerOmits(out, "duplicate", "never confuses the two");
  });

  // A held write is the case the PARENT-facing record already learned to name
  // honestly (05-notification-gate: the host puts the notification in the
  // parent's context while the call it was dialed on is still open, so "not
  // sent" is false the moment the parent has read it). Live-observed
  // 2026-09-26: a child was told "Message not sent ... retry task_notify
  // later" for a notice already in the parent's transcript — and the harness
  // could not catch it, because it modelled a held write as one that neither
  // lands NOR settles, while the real host does both. The child-facing voice
  // must therefore read the record's own verdict, which separates held
  // (dialed, may still land) from failed (never delivered).
  it("a held parent write does not report a delivered notice as unsent", async () => {
    const { h, c } = await withChild({
      harness: { hooks: { notifyTransport: { hold: new Promise(() => {}) } } },
    });
    const out = await bounded(20, () => c.notify("are you there?"));
    assertNoticeCount(h, 1, "the host really did put it in the parent's context");
    answerOmits(out, "not sent", "a held write was dialed, not lost");
    assert.ok(!/retry/i.test(out), `retrying a delivered notice duplicates it. got: ${out}`);
  });


  it("a suppressed duplicate shows as Suppressed in task_result, never FAILED", async () => {
    const { c } = await withChild();
    await c.notify("status: compiling");
    await c.notify("status: compiling");
    const summary = await c.result();
    assert.ok(
    summary.includes("Suppressed (duplicate — already delivered)"),
    `the duplicate must read as suppression. got: ${summary}`,
    );
    answerOmits(summary, "FAILED", "suppression is not a delivery failure");
  });

  it("refuses untracked callers and settled tasks", async () => {
    const { h, c } = await withSettledChild();
    answerSays(await h.tool.task_notify.execute({ message: "hi" }, { sessionID: "ses_stranger" }), "Not a tracked task");
    answerSays(await c.notify("too late"), "the task already settled");
    });

  it("validates message shape and length", async () => {
    const { c } = await withChild();
    assert.ok((await c.notify("  ")).includes("required"));
    const long = await c.notify("x".repeat(4001));
    answerSays(long, "too long");
  });
});

// The spawn contract tells a child to notify the parent when it is blocked.
// When that child's turn then ended, the plugin recorded `completed` and told
// the parent "Background task completed successfully" — a false success claim
// about a task that did no work, in the ledger, the tree, and every read. The
// child already knows it is blocked; the record has to be able to say so.
describe("a child that needs input is not a success", () => {
  it("a child that declared it needs input settles as blocked, and the parent is told to answer", async () => {
    const { h, c, id } = await withChild();
    await declareNeedsInput(c, "I need the API key to continue.");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked", "the record says what happened");
    // The LAST notice is the settlement: the declaration arrived first as a
    // mid-flight notice, and the case that used to read `notices[0]` matched
    // that one, so a plugin which never settled at all would have passed.
    const body = h.noticeBodies().at(-1);
    textDeclaresKind(body, "blocked", "the settlement says the task is waiting");
    answerMatches(body, /task_continue/, "and how to answer it");
  });

  // The guard on the whole change: the state is earned by a declaration, not
  // assumed for every ending turn.
  it("a child that declared nothing still settles completed", async () => {
    const { h, id } = await withChild();
    await h.settle(id);
    assert.strictEqual(await stateOf(h.child(id)), "State: completed");
  });

  // And earned by the RIGHT declaration. A progress notice is the child's
  // ordinary mid-flight voice — the gesture the spawn prompt tells every child
  // to use — so if any notice at all read as "blocked", the documented way to
  // report progress would manufacture a blocked verdict for a child that then
  // finished its work. Nothing in the suite held that apart before: mutating
  // the claim check away left all 468 cases green, because the only cases that
  // reached this line had already declared needs_input or nothing.
  it("a child that reported progress and then finished is not blocked", async () => {
    const { h, c, id } = await withChild();
    await c.notify("found the config file, reading it now");
    await h.settle(id);
    assert.strictEqual(
      await stateOf(c),
      "State: completed",
      "a progress notice is the child talking, not the child stuck",
    );
  });

  it("a failed turn outranks a needs-input declaration", async () => {
    const { h, c, id } = await withChild();
    await declareNeedsInput(c, "blocked on the key");
    // A failed turn is the host's `session.error`, not a status word. It used to be
    // written as `session.status` carrying the word "error", which the host cannot
    // emit — its status map holds running turns and nothing else.
    await h.fireEvent(events.error(id));
    assert.strictEqual(await stateOf(c), "State: error", "a failure is not a question");
  });

  // A steer that lands AFTER the declaration is the answer: the ending turn
  // made no new claim, so its ending is its own. Without the turn scoping a
  // child that got its answer mid-turn would still be reported as waiting.
  it("a declaration belongs to the turn that made it", async () => {
    const { h, c, id } = await withChild();
    await declareNeedsInput(c, "which environment?");
    await c.steer("staging");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed", "the answer moved it on");
  });

  it("a blocked task is answerable: it revives and stops being blocked", async () => {
    const { h, c, id } = await withChild();
    await declareNeedsInput(c, "I need the key.");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked");
    await c.steer("here is the key");
    assert.strictEqual(await stateOf(c), "State: active", "answered tasks run again");
  });

  // The durable reader once validated a restored record against its OWN
  // hand-written list of states, so a state added to the machine was silently
  // dropped on the next boot — the plugin forgetting, in one process, that it
  // had ever asked a parent a question. The list is the machine's now, and
  // this test fails the moment a new state is not in it.
  it("a blocked record survives a restart as blocked, and is still answerable", async () => {
    const h = await bootOn((now) => ({
      pending: [],
      tasks: {
        ses_blocked1: {
          agentName: "explore", childSessionId: "ses_blocked1", description: "waiting on the key", lineage: ["explore"], parentSessionId: "p1", retainedAt: now - 100, startedAt: now - 5000, state: "blocked",
        },
      },
    }));
    const c = h.child("ses_blocked1");
    assert.strictEqual(await stateOf(c), "State: blocked", "the restored record is not dropped");
    const answer = await c.steer("here is the key");
    answerMatches(answer, /Follow-up sent/, "still answerable after a restart");
    assert.strictEqual(await stateOf(c), "State: active", `got: ${await c.status()}`);
  });

  it("the declaration rides the notice channel, and an unknown claim is refused", async () => {
    const { c } = await withChild();
    const refused = await c.notify("asking", { kind: "urgent" });
    answerMatches(refused, /urgent/, "the rejected value is quoted back");
    answerMatches(refused, /needs_input/, "the choices are named");
  });
});

// --- The prompt must not promise a channel the child does not have ------------
// The background opening tells every child it may call `task_notify`, which is
// true of a child the host provisions with the task_* map and false of a
// read-only agent. Found by a live smoke test: an @explore child, told to call
// task_notify, replied in prose that the tool was not in its toolset and
// "I will not fabricate a call to it" — then settled `completed`. That is the
// harm: a child that is genuinely stuck, unable to declare `needs_input` because
// the channel does not exist for it, is reported to the parent as a SUCCESS.
//
// Both directions are pinned. Absent knowledge keeps the instruction (silently
// dropping it would blind the common child to its own voice, which is a far worse
// failure than the one being fixed); only a positive declaration that the tool is
// missing changes the text.
describe("the background prompt tells a child the truth about its own voice", () => {
  /** The opening text a freshly spawned child was sent. */
  const openingFor = async (h, description) => {
    const { id } = await h.spawn({ description });
    await sleep(0);
    return promptTextsTo(h.client, id)[0];
  };

  it("omits the task_notify order when the agent's ruleset denies it", async () => {
    const h = await setupHarness({ hooks: { agentsList: agentDeclaring([allowAction("read"), denyAction(NOTIFY_TOOL)]) } });
    const prompt = await openingFor(h, "read-only worker");
    // Asserted on the ORDER, not the bare word: the replacement text names the
    // tool in order to explain its absence, which is more useful to the child
    // than a sentence about a tool it has never heard of. The ruleset that denies
    // it is the only v2 declaration that deprives the child — an unmentioned tool
    // is a tool the child may still call and be asked about.
    answerOmits(prompt, `call ${NOTIFY_TOOL}`, "a channel the child provably lacks is not offered as an option");
    answerOmits(prompt, "needs_input", "and it is not promised an outcome it cannot reach");
    answerSays(prompt, "final message", "it is told where to put what it would have said");
  });

  it("offers the channel when the ruleset simply does not mention it", async () => {
    const h = await setupHarness({ hooks: { agentsList: agentDeclaring([allowAction("read"), allowAction("glob")]) } });
    answerSays(await openingFor(h, "tool not ruled on"), NOTIFY_TOOL,
      "a ruleset silent on the tool leaves it callable — the host's no-match answer is `ask`, not `deny`");
  });

  it("keeps the instruction when the agent says nothing about its tools", async () => {
    const h = await setupHarness({ hooks: { agentsList: [{ mode: "subagent", name: "explore", permissions: [] }] } });
    answerSays(await openingFor(h, "unknown tool set"), NOTIFY_TOOL, "no declaration means no reason to hide the channel");
  });
});

// The other half of the same fact, told to the other party. The child-facing
// text stops the child ordering a tool it lacks; this stops the PARENT reading a
// stuck child as a success — and it is the parent's half that decides whether
// anyone ever reads that final message at all, so neither half is optional.
//
// Warned, never refused: a read-only agent is a good worker and the only thing
// it loses is its mid-flight voice. Refusing the dispatch would ban the very
// workers whose output is worth waiting for.
describe("the spawn confirmation tells the parent what its child cannot report", () => {
  it("names the limit when the agent declares the tool absent", async () => {
    const h = await setupHarness({ hooks: { agentsList: agentDeclaring([allowAction("read"), denyAction(NOTIFY_TOOL)]) } });
    const out = await confirmationFor(h, "read-only worker");
    answerSays(out, `no ${NOTIFY_TOOL}`, "the parent is told the child has no voice at all");
    answerSays(out, "settle as completed", "because that is the failure the parent is otherwise blind to");
  });

  it("says nothing extra when the agent has the tool", async () => {
    const h = await setupHarness({ hooks: { agentsList: agentDeclaring([allowAction("read"), allowAction(NOTIFY_TOOL)]) } });
    const out = await confirmationFor(h, "ordinary worker");
    answerOmits(out, `no ${NOTIFY_TOOL}`, "a child that can report is not warned about reporting");
  });

  it("says nothing extra when the tool set is unknown", async () => {
    const h = await setupHarness({ hooks: { agentsList: [{ mode: "subagent", name: "explore", permissions: [] }] } });
    const out = await confirmationFor(h, "undeclared worker");
    answerOmits(out, `no ${NOTIFY_TOOL}`, "absence of knowledge must not manufacture a warning either");
  });
});
