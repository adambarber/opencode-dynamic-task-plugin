// Who may stop a session.
//
// The plugin is one of several programs writing to a host that holds other
// people's work. An `session.abort` is the sharpest thing it can do: it kills a
// turn, and the host reports the request as interrupted — so a wrong one does not
// look like a mistake to the person on the other end. It looks like the agent
// stopped listening mid-sentence.
//
// This suite is the proof of one rule:
//
//   The plugin stops a session it dispatched, and never the session it is
//   speaking in.
//
// "Dispatched" means the store holds a record, because the store is the only
// thing that knows what this process started. The rule is enforced at the abort
// funnel rather than at the tools that call it, so a fourth caller inherits it
// instead of re-deciding it.
//
// Every ownership case below asserts on the abort REQUEST, not on whether the
// host obeyed. Against a host that does not own an id the two diverge exactly
// where the bug lives: the previous implementation asked the server to kill the
// caller's own session, and a test written against `wasAborted` saw a clean 404
// and called it correct.
import { describe, it } from "./support/runner.js";
import assert from "node:assert";

import {
  setupHarness,
  withChild,
  withDispatchTree,
  abortWasRequestedFor,
  abortRequests,
  wasAborted,
  bounded,
  sessionIds,
  sleep,
} from "./support/harness.js";
import { answerOmits, answerSays } from "./support/assertions.js";
import { withSingleSlot } from "./support/integration.js";

// The caller's own session, as the host names it. The harness uses this id for
// the parent throughout; a suite that invented a parent id would be testing a
// session the plugin never sees.
const PARENT = "p1";

// `task_interrupt` as the tool map exposes it, with the calling session named
// explicitly — the caller is CONTEXT, never an argument, because that
// distinction is the whole subject of the suite.
const interruptFrom = (h, sessionId, caller = PARENT) =>
  h.tool.task_interrupt.execute({ session_id: sessionId }, { sessionID: caller });

// Two dispatches started together against one slot. The loser has already been
// created by the host when its registration is refused, so the session exists,
// runs, and has no record — the orphan. Two awaited spawns never produce it: the
// pre-create re-check refuses the second before the host is asked, which is why
// the race has to be the arrangement rather than a fixture flag.
const raceForOrphan = async (h) => {
  const before = new Set(sessionIds(h.client));
  const answers = await Promise.all([
    h.trySpawn({ description: "winner", subagent_type: "explore", prompt: "hi" }),
    h.trySpawn({ description: "loser", subagent_type: "explore", prompt: "hi" }),
  ]);
  const created = sessionIds(h.client).filter((id) => !before.has(id));
  // The orphan is identified by what it IS, not by what happened to it: a
  // session the host created that no dispatch confirmation ever names. Reading
  // it off `wasAborted` instead would make the fixture depend on the behaviour
  // under test, so the test would stop reporting the defect once it was fixed.
  const orphan = created.find((id) => !answers.some((a) => a.includes(id)));
  return { answers, orphan };
};

describe("abort ownership", () => {
  // ── the rule, as the reported bug ─────────────────────────────────────────

  it("a caller that names its own session does not kill its own turn", async () => {
    // The symptom: a turn comes back `interrupted` before the model was ever
    // dispatched. Nothing in a parent's turn is a child of itself, so the answer
    // is always a refusal. The session is seeded live so the host WOULD have
    // obeyed — this is the shape that killed the turn, reproduced.
    const h = await setupHarness({ hostStatusSeed: { [PARENT]: "busy" } });

    const answer = await interruptFrom(h, PARENT);

    assert.deepStrictEqual(
      abortRequests(h.client),
      [],
      `the request itself is the bug, whether or not the host obeyed: ${JSON.stringify(abortRequests(h.client))}`,
    );
    answerSays(answer, "Refused", "names the refusal");
  });

  it("a caller that names its own session is told it is the caller", async () => {
    const h = await setupHarness({ hostStatusSeed: { [PARENT]: "busy" } });

    const answer = await interruptFrom(h, PARENT);

    answerSays(answer, "itself", "says why");
  });

  it("a child interrupting itself is refused, though the store tracks it", async () => {
    // The case a `store.activeTasks.has(id)` guard misses: the child's own record
    // IS in the store, because its parent put it there. "Is this mine" and "is
    // this me" are different questions, and only asking the second stops a child
    // from taking its own turn down.
    const { h, c } = await withChild({ spawn: { description: "self-stopper" } });

    const answer = await interruptFrom(h, c.id, c.id);

    assert.strictEqual(abortWasRequestedFor(h.client, c.id), false, "a child must not abort itself");
    answerSays(answer, "Refused", "names the refusal");
  });

  it("a session this dispatch never created is refused, not probed", async () => {
    // A hallucinated id, or one belonging to a window this process has nothing
    // to do with. The host would answer 404 and the report would read `untracked`
    // — indistinguishable from success, which is why the request is the assertion.
    const h = await setupHarness();
    await h.spawn({ description: "one" });

    const answer = await interruptFrom(h, "ses_someone_elses");

    assert.strictEqual(
      abortWasRequestedFor(h.client, "ses_someone_elses"),
      false,
      `no request may reach the server: ${JSON.stringify(abortRequests(h.client))}`,
    );
    answerSays(answer, "Refused", "names the refusal");
  });

  // ── the rule must not cost the plugin the thing it is for ─────────────────

  it("a tracked child is still stopped", async () => {
    const { h, c } = await withChild({ spawn: { description: "stoppable" } });

    const answer = await interruptFrom(h, c.id);

    assert.ok(wasAborted(h.client, c.id), `a tracked child must be aborted. got: ${answer}`);
    answerSays(answer, "interrupted");
  });

  it("a live grandchild is reached through a settled child", async () => {
    // The walk passes through settled records. A subtree stop that stopped at the
    // first settled ancestor would leave real work running behind a report that
    // reads as a clean stop.
    const { h, child, grandchild } = await withDispatchTree();
    await h.settle(child.id);

    const answer = await interruptFrom(h, child.id);

    assert.ok(wasAborted(h.client, grandchild.id), `got: ${answer}`);
  });

  it("a settled child's history is preserved and its abort still sent", async () => {
    // Naming a settled task is an explicit ask. Answering with silence would be
    // a lie in the other direction: the parent asked what it costs to stop
    // something already stopped, and the answer is nothing at all.
    const { h, c } = await withChild({ spawn: { description: "already done" } });
    await h.settle(c.id);

    const answer = await interruptFrom(h, c.id);

    assert.ok(abortWasRequestedFor(h.client, c.id), `got: ${answer}`);
    answerSays(answer, "already settled");
  });

  it("every member of a subtree stop reports its own truth", async () => {
    // A partial stop must not read as a clean one — the reason the report is a
    // ledger rather than a sentence.
    const { h, child, grandchild } = await withDispatchTree();

    const answer = await interruptFrom(h, child.id);

    for (const id of [child.id, grandchild.id]) {
      assert.ok(wasAborted(h.client, id), `${id} must be aborted. got: ${answer}`);
    }
    answerSays(answer, "subtree");
  });

  // ── an orphan is ours, because we made it ────────────────────────────────

  it("a dispatch that loses the race for a slot kills the session it created", async () => {
    // The one case where a session exists, is running, and the store has no
    // record of it: this process created it and could not register it. Leaving it
    // alone is the plugin's leak, so it has to be stoppable — which means it has
    // to be the plugin's.
    const h = await withSingleSlot();

    const { orphan } = await raceForOrphan(h);

    assert.strictEqual(typeof orphan, "string", "fixture: the race produced an orphan");
    assert.ok(
      abortWasRequestedFor(h.client, orphan),
      `orphan ${orphan} must be aborted. requests: ${JSON.stringify(abortRequests(h.client))}`,
    );
  });

  it("an orphan leaves a record, so a killed dispatch is still visible", async () => {
    // The kill above is necessary and not sufficient: a session the plugin made
    // and destroyed should not vanish from the operator's view. Every fleet view
    // reads the store, so a retained record is what makes it reportable — and
    // what brings the orphan under the same retained cap as everything else.
    const h = await withSingleSlot();

    const { orphan } = await raceForOrphan(h);
    const listed = await h.tool.task_list.execute({});

    answerSays(listed, orphan, "the orphan is listed");
    assert.match(listed, /error/i, "as the failure it is");
  });

  // ── a steer is an abort too ──────────────────────────────────────────────

  it("a child steering itself is refused rather than killing its own turn", async () => {
    // `task_continue` on a running task is abort-then-prompt. With the store
    // holding the child's own record, the self case passes every ownership check
    // a task-shaped id would — and takes the child's turn down with it, so the
    // replacement prompt then launches onto a dead session.
    const { h, c } = await withChild({ spawn: { description: "self-steerer" } });

    const answer = await h.tool.task_continue.execute(
      { session_id: c.id, prompt: "actually, do this instead" },
      { sessionID: c.id },
    );

    assert.strictEqual(abortWasRequestedFor(h.client, c.id), false, "a child must not abort itself");
    answerSays(answer, "Refused", "names the refusal");
  });

  it("a parent steering its child still works", async () => {
    const { h, c } = await withChild({ spawn: { description: "steerable" } });

    const answer = await h.tool.task_continue.execute(
      { session_id: c.id, prompt: "also check the logs" },
      { sessionID: PARENT },
    );

    assert.ok(abortWasRequestedFor(h.client, c.id), `a steer must abort first. got: ${answer}`);
  });

  it("a self-steer leaves the child running rather than stranding it", async () => {
    // A refusal must have no side effects on the way out. Today the self-steer
    // succeeds, the abort kills the turn, and the steer claim then SUPPRESSES that
    // turn's terminal echo — so the store waits for a replacement turn that will
    // never start, and the child sits `active` for the rest of the process's
    // life. The tell is that pending-replacement line: a healthy active child does
    // not carry it.
    const { h, c } = await withChild({ spawn: { description: "survivor" } });

    await h.tool.task_continue.execute({ session_id: c.id, prompt: "no" }, { sessionID: c.id });

    const status = await h.tool.task_status.execute({ session_id: c.id });
    answerOmits(status, "replacement turn has not started", "the child was not left mid-steer");
    answerSays(status, "active", "and is still a live task");
  });

  // ── the host is not obliged to answer ─────────────────────────────────────

  it("an abort the host never answers cannot hang the tool", async () => {
    // Every other host call the plugin makes is bounded. An unbounded one is not
    // a slow report — it is a tool call that never returns, holding a turn open
    // for as long as the server stays quiet, which is precisely the condition
    // under which nobody is watching.
    //
    // The host LOSES this one abort and answers the next, so the case is about a
    // single lost packet rather than a dead server, and so the harness can still
    // tear the child down afterwards. Raced against a local deadline as well:
    // `bounded` shrinks a bound that does not exist yet, so at baseline this
    // would await a promise nobody ever settles, and a test for a missing bound
    // has to FAIL rather than hang the suite forever.
    const { h, c } = await withChild({
      harness: { hooks: { abortLoseOnceIds: new Set(["ses_mock_1"]) } },
      spawn: { description: "doomed" },
    });
    assert.strictEqual(c.id, "ses_mock_1", "fixture: the hook names the child it will lose");

    const answer = await Promise.race([
      bounded(250, () => interruptFrom(h, c.id)),
      sleep(1000).then(() => "THE TOOL NEVER ANSWERED"),
    ]);

    assert.notStrictEqual(answer, "THE TOOL NEVER ANSWERED", "a deadline is still an answer");
    answerSays(answer, "interrupt", "the report names what it did not finish");
  });

  it("an unowned id never reaches the transport, so a dead host cannot hang it", async () => {
    // The refusal is decided before any transport is touched: no await stands
    // between the decision and the answer, which is what makes it cheap and what
    // makes it true when the server is gone.
    //
    // Raced against a local deadline rather than wrapped in `bounded`, because
    // `bounded` shrinks a bound that does not exist yet: at baseline this awaits
    // a host that never answers, and a test for a missing bound has to FAIL
    // rather than hang the suite forever.
    const h = await setupHarness({ hooks: { abortHangIds: new Set(["ses_stranger"]) } });

    const answer = await Promise.race([
      interruptFrom(h, "ses_stranger"),
      sleep(1000).then(() => "THE TOOL NEVER ANSWERED"),
    ]);

    assert.notStrictEqual(answer, "THE TOOL NEVER ANSWERED", "a refusal needs no server");
    answerSays(answer, "Refused");
    assert.deepStrictEqual(abortRequests(h.client), [], "no request was ever made");
  });
});
