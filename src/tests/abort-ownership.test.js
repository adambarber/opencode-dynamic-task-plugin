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
//jscpd:ignore-start
import {
  abortRequests,
  answerOmits,
  answerSays,
  assert,
  assertRefusedWithoutReachingTheHost,
  assertStopped,
  bounded,
  describe,
  interruptAs,
  it,
  sleep,
  withChild,
  withLostAbort,
  withOrphan,
  withRefusedStop,
  withSelfStop,
  withStoppedChild,
  withStoppedTreeChild,
} from "./support/index.js";

//jscpd:ignore-end
// The caller's own session, as the host names it. The harness uses this id for
// the parent throughout; a suite that invented a parent id would be testing a
// session the plugin never sees.


describe("abort ownership", () => {
  // ── the rule, as the reported bug ─────────────────────────────────────────

  it("a caller that names its own session does not kill its own turn", async () => {
    // The reported symptom: a turn comes back `interrupted` before the model was
    // ever dispatched. Seeded live, so the host WOULD have obeyed.
    const { h } = await withSelfStop({ note: "a caller is never a target of its own turn" });


    assert.deepStrictEqual(
      abortRequests(h.client),
      [],
      `the request itself is the bug, whether or not the host obeyed: ${JSON.stringify(abortRequests(h.client))}`,
    );
  });

  it("a caller that names its own session is told it is the caller", async () => {
    const { answer } = await withSelfStop({ note: "the refusal a caller can act on" });

    answerSays(answer, "itself", "says why");
  });

  it("a child interrupting itself is refused, though the store tracks it", async () => {
    // What a `store.activeTasks.has(id)` guard misses: the child's own record IS in
    // the store. "Is this mine" and "is this me" are different questions.
    const { id } = await withRefusedStop({
      arrange: (h) => h.spawn({ description: "self-stopper" }),
      callerFrom: "seeded",
      note: "a child must not stop its own turn",
    });

    assert.ok(id, "fixture: the store really did hold the child's own record");
  });

  it("a session this dispatch never created is refused, not probed", async () => {
    // A hallucinated id, or one belonging to a window this process has nothing
    // to do with. The host would answer 404 and the report would read `untracked`
    // — indistinguishable from success, which is why the request is the assertion.
    await withRefusedStop({
      arrange: async (h) => h.spawn({ description: "one" }),
      note: "an id this plugin never made",
      target: "ses_someone_elses",
    });
  });

  // ── the rule must not cost the plugin the thing it is for ─────────────────

  it("a tracked child is still stopped", async () => {
    const { answer } = await withStoppedChild({ spawn: { description: "stoppable" } });

    answerSays(answer, "interrupted");
  });

  it("a live grandchild is reached through a settled child", async () => {
    const { grandchild } = await withStoppedTreeChild({ settled: true });

    assert.ok(grandchild.id, "the walk reached a live grandchild through a settled child");
  });

  it("a settled child's history is preserved and its abort still sent", async () => {
    // Naming a settled task is an explicit ask, and silence would be its own lie.
    const { h, c } = await withChild({ spawn: { description: "already done" } });
    await h.settle(c.id);

    const answer = await interruptAs(h, c.id);
    assertStopped(h, c.id, answer, "naming a settled task is still the plugin's to answer");

    answerSays(answer, "already settled");
  });

  it("every member of a subtree stop reports its own truth", async () => {
    // A partial stop must not read as a clean one: the report is a ledger.
    const { answer } = await withStoppedTreeChild();

    answerSays(answer, "subtree");
  });

  // ── an orphan is ours, because we made it ────────────────────────────────

  it("a dispatch that loses the race for a slot kills the session it created", async () => {
    const { h, orphan } = await withOrphan();
    assertStopped(h, orphan, "", `the orphan ${orphan} is the plugin's to kill`);
  });

  it("an orphan leaves a record, so a killed dispatch is still visible", async () => {
    const { h, orphan } = await withOrphan();
    const listed = await h.tool.task_list.execute({});

    answerSays(listed, orphan, "the orphan is listed");
    assert.match(listed, /error/i, "as the failure it is");
  });

  // ── a steer is an abort too ──────────────────────────────────────────────

  it("a child steering itself is refused rather than killing its own turn", async () => {
    // A steer is abort-then-prompt, so the self case passes every ownership check.
    const { h, c } = await withChild({ spawn: { description: "self-steerer" } });

    const answer = await c.tool("task_continue")({ prompt: "actually, do this instead" }, { sessionID: c.id });

    assertRefusedWithoutReachingTheHost(h, answer, c.id, "a steer is an abort, and this one is its own");
  });

  it("a parent steering its child still works", async () => {
    const { h, c } = await withChild({ spawn: { description: "steerable" } });

    await c.steer("also check the logs");

    assertStopped(h, c.id, "", "a parent steering its child aborts first");
  });

  it("a self-steer leaves the child running rather than stranding it", async () => {
    // A refusal must have no side effects on the way out. Today the self-steer
    // succeeds, the abort kills the turn, and the steer claim then SUPPRESSES that
    // turn's terminal echo — so the store waits for a replacement turn that will
    // never start, and the child sits `active` for the rest of the process's
    // life. The tell is that pending-replacement line: a healthy active child does
    // not carry it.
    const { h, c } = await withChild({ spawn: { description: "survivor" } });

    await h.tool.task_continue.execute({ prompt: "no", session_id: c.id }, { sessionID: c.id });

    const status = await h.tool.task_status.execute({ session_id: c.id });
    answerOmits(status, "replacement turn has not started", "the child was not left mid-steer");
    answerSays(status, "active", "and is still a live task");
  });

  // ── the host is not obliged to answer ─────────────────────────────────────

  it("an abort the host never answers cannot hang the tool", async () => {
    const { h, c } = await withLostAbort();

    const answer = await Promise.race([
      bounded(250, () => interruptAs(h, c.id)),
      sleep(1000).then(() => "THE TOOL NEVER ANSWERED"),
    ]);

    assert.notStrictEqual(answer, "THE TOOL NEVER ANSWERED", "a deadline is still an answer");
    answerSays(answer, "interrupt", "the report names what it did not finish");
  });

  it("an unowned id never reaches the transport, so a dead host cannot hang it", async () => {
    // The refusal is decided before any transport is touched, so it is cheap and
    // true when the server is gone. Raced against a local deadline rather than
    // wrapped in `bounded`, which would await a host that never answers.
    const raced = withRefusedStop({
      harness: { hooks: { abortHangIds: new Set(["ses_stranger"]) } },
      note: "an unowned id",
      target: "ses_stranger",
    });

    const answer = await Promise.race([raced, sleep(1000).then(() => "THE TOOL NEVER ANSWERED")]);

    assert.notStrictEqual(answer, "THE TOOL NEVER ANSWERED", "a refusal needs no server");
  });
});
