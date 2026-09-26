/**
* Tools integration — the non-blocking contract end to end.
*
* Drives the REAL plugin (tools + event handler) with a hookable mock
* client. Settlement is event-driven: tests settle children by firing the
* lifecycle events the server would fire, never by waiting on clocks.
* Every spawn returns immediately; every notification arrives exactly
* once per settled turn; task_notify is the child's general channel.
*/

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deferred, events, setupHarness, setupTwoTurnHarness, sleep, tmpProjectDir,
  withChild, withDispatchTree, withEnv, withSettledChild, withSettledDispatchTree,
  resultForChild, resultForUnreadableChild,
} from './support/harness.js';
import { shrinkBoundsForTesting } from "../../dist/shared/execution-bound.js";

/**
 * Run `fn` with every deadline shrunk to a value a test can outwait. The timer
 * is real and still fires — only the patience changes, so a test that observes a
 * bound proves the bound rather than proving a mocked clock.
 */
async function withShrunkBounds(fn) {
  const restore = shrinkBoundsForTesting(20);
  try {
    return await fn();
  } finally {
    restore();
  }
}

// A message carrying no clock at all — the case where an age must not be
// invented from the spawn. Shaped like the host's (`info` + `parts`) so the
// absence of a time is the only difference from a real message.
const UNCLOCKED_MESSAGE = { info: { role: "user" }, parts: [{ type: "text", text: "go" }] };

/**
 * Boot, spawn, and start a steer whose abort parks at the gate — the
 * arrangement every steer race needs. What races the steer is the caller's
 * next line; `steer` is the still-pending promise to await after the release.
 */
async function racingSteer(gateOpts) {
  const { h, c, id } = await withChild();
  const { release } = h.client.gateAbort(gateOpts);
  const steer = c.steer("pivot");
  await sleep(10);
  return { h, c, id, steer, release };
}

/**
 * A spawned dep, plus a strict depender's refusal. The dependency gate is two
 * rules — depends_on and depends_on_settled — and each test exercises one; the
 * "a live dep blocks" precondition belongs to both, so it is named once.
 */
async function withRefusedDep() {
  const h = await setupHarness();
  const dep = await h.spawn({ description: "dep task" });
  const refused = await h.trySpawn({
    description: "blocked task", subagent_type: "explore", prompt: "hi", depends_on: [dep.id],
  });
  assert.ok(refused.includes("Dependencies pending"), `got: ${refused}`);
  assert.ok(refused.includes(dep.id), `names the dep. got: ${refused}`);
  return { h, dep, refused };
}

/**
 * Arm a turn replacement, then deliver bare terminal copies — endings with no
 * turn behind them, which is exactly what a just-replaced turn's in-flight
 * copies look like. A replacement that has been seen working for nothing yet
 * owns no ending, so none of them may settle it. Returns the ONE notice the
 * parent should end up with, from the replacement's own ending once it has run.
 */
async function echoesCannotSettle(h, c, id, arm) {
  const before = h.notices().length;
  await arm();
  await h.fireEvent(events.idle(id));
  await h.fireEvent(events.idle(id));
  const status = await c.status();
  assert.ok(status.includes("active"), `an echo is not the replacement turn's ending. got: ${status}`);
  assert.strictEqual(h.notices().length, before, "no premature completion is notified");
  await h.fireEvent(events.working(id));
  return h.settledNotice(id);
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
  assert.ok(cont.includes("Follow-up sent"), `got: ${cont}`);
  return { h, c, id };
}

/** Two turns, two settlements, and no suppression of the second. */
async function assertBothTurnsDelivered(h) {
  await sleep(30);
  const notes = h.notices();
  assert.strictEqual(notes.length, 2, `both turns deliver. got: ${notes.length}`);
  assert.ok(notes[0].message.includes("TURN-ONE-OUTPUT"), `turn order preserved. first: ${notes[0]?.message}`);
  assert.ok(notes[1].message.includes("TURN-TWO-OUTPUT"), `second: ${notes[1]?.message}`);
}

/**
 * A child whose abort transport is down, settled — the arrangement behind both
 * "the gap is recorded" and "success is not annotated by a failed abort".
 */
async function withBrokenAbortSettledChild() {
  const h = await setupHarness({ hooks: { abortThrows: "ECONNREFUSED" } });
  const { id, c } = await h.spawn();
  await h.settle(id);
  return { h, c, id, out: await c.interrupt() };
}

/**
 * A child's tool asks the parent a question and the parent never answers: the
 * plugin rejects it ONCE, never silently. The reason it rejects with is the
 * whole contract — it is a child's only description of the way out — so this
 * returns it for the caller to assert, rather than each test re-deriving it.
 */
async function assertQuestionRejected(h, event) {
  await h.fireEvent(event);
  const calls = h.questionCalls();
  assert.strictEqual(calls.length, 1, "one rejection, never a silent stall");
  assert.strictEqual(calls[0].method, "reject");
  return calls[0].reason;
}

/**
 * The state line and nothing else. The status view also names the last
 * notification's kind, which is history, so a substring over the whole report
 * cannot tell a state claim from a mention of one. One reader, because every
 * settlement test asks the same question of the same view.
 */
const stateOf = async (child) =>
  (await child.status()).split("\n").find((line) => line.startsWith("State: ")) ?? "(no state line)";

// --- Tests -----------------------------------------------------------------

describe("dynamic_task validation", () => {

  it("rejects missing subagent_type with the available list", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", prompt: "hi" });
    assert.ok(out.includes("No subagent_type"), `got: ${out}`);
    assert.ok(out.includes("explore"), `lists agents. got: ${out}`);
    });

  it("rejects unknown agents", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", subagent_type: "nope", prompt: "hi" });
    assert.ok(out.includes('Agent "nope" not found'), `got: ${out}`);
    });

  it("rejects missing and oversized prompts", async () => {
    const h = await setupHarness();
    const missing = await h.trySpawn({ description: "task t", subagent_type: "explore" });
    assert.ok(missing.includes("Invalid prompt"), `got: ${missing}`);

    const long = await h.trySpawn({ description: "task t", subagent_type: "explore", prompt: "x".repeat(100001) });
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
    });

  it("rejects bare model ids at admission, before creating a session", async () => {
    const h = await setupHarness();
    const before = h.client._state.sessions.size;
    const out = await h.trySpawn({ description: "task t", subagent_type: "explore", prompt: "hi", model: "GLM-5.3-Flash" });
    assert.ok(out.includes("Invalid model"), `got: ${out}`);
    assert.ok(out.includes("providerID/modelID"), `names the shape. got: ${out}`);
    assert.ok(out.includes("GLM-5.3-Flash"), `names the suspect. got: ${out}`);
    assert.strictEqual(h.client._state.sessions.size, before, "no session created for a bad id");
    });

  it("echoes a qualified model in the spawn confirmation", async () => {
    const { h, c, out, id } = await withChild({ spawn: { model: "nvidia/z-ai/glm-5.3" } });
    assert.ok(out.includes("Model: nvidia/z-ai/glm-5.3"), `got: ${out}`); });

  it("admits any agent by default — general dispatches", async () => {
    const { h, c, out, id } = await withChild({ spawn: { subagent_type: "general" } });
    assert.ok(out.includes("@general"), `got: ${out}`); });

  it("rejects overlong descriptions at admission", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "x".repeat(3000), subagent_type: "explore", prompt: "hi" });
    assert.ok(out.includes("Description too long"), `labels stay short. got: ${out}`);
    });

  it("task_list names pruned expiries", async () => {
    const { h, c, id } = await withSettledChild({ harness: { options: { retainedTaskTtlMs: 1 } } });
    await sleep(5);
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes("Pruned: 1 expired"), `expiry is visible. got: ${list}`); });

  it("rejects blocked agents when the operator configures the blocklist", async () => {
    const h = await setupHarness({ options: { blockedAgents: ["general"] } });
    const out = await h.trySpawn({ description: "task t", subagent_type: "general", prompt: "hi" });
    assert.ok(out.includes("blocked"), `got: ${out}`);
    });

  it("rejects over the concurrency limit", async () => {
    const limited = await setupHarness({ options: { maxConcurrent: 1 } });
    const first = await limited.spawn({ description: "task one" });
    assert.ok(first.out.includes("in background"), `first must spawn. got: ${first.out}`);

    const second = await limited.tool.dynamic_task.execute(
    { description: "task two", subagent_type: "explore", prompt: "hi" },
    { sessionID: "p1" },
    );
    assert.ok(second.includes("Cannot run more than"), `got: ${second}`);
    assert.ok(second.includes("task_list"), `points at the slot holders. got: ${second}`);
    });

  it("surfaces session.create failures", async () => {
    const failing = await setupHarness({ hooks: { createThrowsOnce: true } });
    const out = await failing.tool.dynamic_task.execute(
    { description: "task t", subagent_type: "explore", prompt: "hi" },
    { sessionID: "p1" },
    );
    assert.ok(out.includes("ERROR"), `got: ${out}`);
    assert.ok(out.includes("create failed"), `got: ${out}`);
    });

  it("returns immediately even while the child prompt never settles", async () => {
    // The non-blocking promise, falsifiable: a hung child prompt must not
    // hold the spawn call. No clock can rescue this — there is no clock.
    const hooks = { promptHangIds: new Set() };
    const h = await setupHarness({ hooks: hooks });
    hooks.promptHangIds.add("ses_mock_1");
    const { out, id } = await h.spawn();
    assert.ok(out.includes("in background"), `got: ${out}`);
    assert.ok(id, "session id returned synchronously with the spawn line");
    assert.strictEqual(h.notices().length, 0, "nothing settles without an event");
    });
});

describe("task_continue branches", () => {

  it("rejects missing args and oversized prompts", async () => {
    const h = await setupHarness();
    assert.ok((await h.tool.task_continue.execute({})).includes("required"));
    const long = await h.tool.task_continue.execute({
      session_id: "ses_mock_1",
      prompt: "x".repeat(100001),
      });
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
    });

  it("steers a still-running task — the turn stops and the message becomes the next turn", async () => {
    const { h, c, id } = await withChild();
    const out = await c.steer("follow up");
    assert.ok(out.includes("Steer sent"), `got: ${out}`);
    assert.ok(out.includes("task_interrupt"), `names the stall recovery. got: ${out}`);
    assert.ok(h.client._state.aborted.includes(id), "the running turn is stopped first");
    const followUps = h.client._state.promptBodies.filter(
    (p) => p.to === id && p.body.parts[0].text.includes("follow up"),
    );
    assert.strictEqual(followUps.length, 1, "the message becomes the next turn");
    assert.ok(
    followUps[0].body.parts[0].text.includes("[Parent steer"),
    `framed as a preemption. got: ${followUps[0].body.parts[0].text}`,
    );
    const status = await c.status();
    assert.ok(status.includes("active"), `a steer never settles. got: ${status}`); });

  // One hypothesis: a disturbance that is not a terminal signal — an abort echo
  // from a steer, a retryable transport blip — leaves the task active and
  // silent, so nothing is deafened and the child's own terminal event settles it.
  const disturbances = [
    // The steer makes the child echo the abort, and that first idle IS the echo:
    // the next genuine event is the one that settles. Fired bare, because an
    // echo by definition arrives with no turn behind it.
    ["a steered turn's abort echo never settles the task, but the next genuine event does",
      {}, async ({ c, h, id }) => { await c.steer("pivot"); await h.fireEvent(events.idle(id)); }],
    // A transport blip (ETIMEDOUT) says nothing about the child: the turn may
    // well be running, so the task stays active and waits for its own event.
    ["a retryable prompt failure leaves the task active — its event settles it",
      { hooks: { childPromptFailOnce: { message: "connect ETIMEDOUT", code: "ETIMEDOUT" } } },
      async () => { await sleep(50); }], // the fire-and-forget catch has run
  ];
  for (const [name, harness, disturb] of disturbances) {
    it(name, async () => {
      const ctx = await withChild({ harness });
      await disturb(ctx);
      const status = await ctx.c.status();
      assert.ok(status.includes("active"), `a non-terminal signal must not settle. got: ${status}`);
      assert.strictEqual(ctx.h.notices().length, 0, "nothing is notified");
      const note = await ctx.h.settledNotice(ctx.id);
      assert.ok(note.includes("completed successfully"), `the real event still settles. got: ${note}`);
    });
  }

  // A turn end is published more than once: the host's status channel and the
  // idle event each say the turn ended. The one-shot steer claim consumed the
  // FIRST of them, so the second settled the replacement turn as completed
  // while the child was still working — a "completed successfully" notice with
  // mid-work text as the latest output, and a ledger deaf to the real ending.
  it("a turn end that publishes several terminal events cannot settle a just-steered turn", async () => {
    const { h, c, id } = await withChild();
    const note = await echoesCannotSettle(h, c, id, () => c.steer("pivot"));
    assert.ok(note.includes("completed successfully"), `got: ${note}`);
  });

  // A child's outcome reaches the parent through exactly one path, and that path
  // quotes the child's last words before it speaks. A transcript that cannot be
  // read must not be mistaken for a child that said nothing: "(completed)" is a
  // plausible reading and a false one, and the parent would act on it.
  it("a settlement whose transcript cannot be read still notifies, and says the quote is missing", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ prompt: "turn one" });
    h.client.makeUnreadable(id);
    await h.settle(id, "completed");
    await sleep(20);
    const notice = h.noticeFor(id);
    assert.ok(notice, "the outcome is the parent's only route to the child — it cannot ride behind a read");
    assert.match(notice.message, /completed successfully/, `the settlement still notifies. got: ${notice.message}`);
    assert.match(
      notice.message,
      /transcript could not be read/,
      `and names the missing quote instead of passing "(completed)" off as one. got: ${notice.message}`,
    );
  });

  // The host holds a write to a mid-turn parent rather than refusing it, and the
  // hold can outlast the parent's attention. A pending record is the honest
  // interim state; a FAILED one would be a lie the parent recovers from wrongly.
  it("a write the host holds reads as PENDING, not FAILED, and is delivered once when the host answers", async () => {
    await withShrunkBounds(async () => {
      const held = deferred();
      const h = await setupHarness({ hooks: { notifyTransport: { hang: held.promise } } });
      const { id, c } = await h.spawn({ prompt: "turn one" });
      await h.settle(id, "completed");
      await sleep(40);
      assert.match(await c.status(), /PENDING/, "the parent can SEE that its child spoke and it has not arrived");
      assert.doesNotMatch(await c.status(), /FAILED/, "held is not failed — the host may still deliver it");
      held.resolve();
      await held.promise;
      await sleep(20);
      assert.match(await c.status(), /delivered in 1 attempt/, `the record ends up truthful. got: ${await c.status()}`);
      assert.strictEqual(
        h.client._state.notifyCalls.length,
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
    it(`a steer racing ${name} auto-revives, and the revived turn still notifies`, async () => {
      const h = await setupHarness();
      const { release } = h.client.gateChildPrompt();
      const { c } = await h.spawn({ prompt: "turn one" });
      const { release: releaseAbort } = h.client.gateAbort();
      const steer = c.steer("pivot");
      await sleep(10);
      await settle({ h, c, release });
      await sleep(30);
      releaseAbort(); // the abort lands; the steer re-validates and finds it settled
      const out = await steer;
      assert.ok(out.includes("revived"), `closes the loop in one call. got: ${out}`);
      assert.strictEqual(
        h.client._state.promptBodies.filter((p) => p.body.parts[0].text === "pivot").length,
        1,
        "the message fires as the fresh turn",
      );
      await h.settle(c.id, "completed");
      await sleep(20);
      assert.match(await c.status(), /State: completed/, "the revived turn settles on its own");
      assert.strictEqual(
        h.notices().length,
        2,
        "the settlement the parent was told about, and the one that carries the outcome. got: "
          + h.notices().map((n) => n.message.split("\n")[1]).join(" | "),
      );
    });
  }

  it("a task settling mid-steer never receives the replacement prompt", async () => {
    const { h, c, steer, release } = await racingSteer();
    await c.interrupt();
    release();
    const out = await steer;
    assert.ok(!out.includes("Steer sent"), `must not claim a steer that never happened. got: ${out}`);
    assert.ok(out.includes("interrupted"), `truthful report. got: ${out}`);
    assert.strictEqual(
    h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
    0,
    "no replacement prompt fires on a settled task",
    );
    });

  it("a steer racing a concurrent settlement reports the winner truthfully", async () => {
    const { h, c, steer, release } = await racingSteer({ fails: true });
    await c.interrupt();
    release();
    const out = await steer;
    assert.ok(out.includes("interrupted"), `reports the actual winner. got: ${out}`);
    assert.ok(!out.includes("settled as error"), `no false error claim. got: ${out}`);
    assert.strictEqual(
    h.notices().filter((n) => n.message.includes("Steer failed")).length,
    0,
    "no second notice over the winner's outcome",
    );
    });

  it("steer on a vanished session settles error instead of stranding", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortFailIds: new Set(["ses_mock_1"]) } } });
    const out = await c.steer("pivot");
    assert.ok(out.includes("not found"), `got: ${out}`);
    const status = await c.status();
    assert.ok(status.includes("error"), `settled error, never stranded active. got: ${status}`); });

  it("a failed steer abort stays active and sends nothing", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.steer("pivot");
    assert.ok(out.includes("abort failed"), `reports the gap. got: ${out}`);
    assert.ok(out.includes("active"), `admits the child may be live. got: ${out}`);
    assert.strictEqual(
    h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
    0,
    "no competing prompt races the live turn",
    );
    const status = await c.status();
    assert.ok(status.includes("active"), `stays settable. got: ${status}`);
    await h.settle(id);
    assert.strictEqual(h.notices().length, 1, "the live turn still settles"); });

  it("revives a settled task and the new turn settles again", async () => {
    const { h, c, id } = await withSettledChild();
    assert.strictEqual(h.notices().length, 1, "first turn settles");

    const out = await c.steer("summarize");
    assert.ok(out.includes("Follow-up sent"), `got: ${out}`);
    const followUps = h.client._state.promptBodies.filter(
    (p) => p.to === id && p.body.parts[0].text.includes("summarize"),
    );
    assert.strictEqual(followUps.length, 1, "the same session is revived, not replaced");

    // The settled turn published its ending more than once, and the extra copy
    // can still be in flight when the revival fires — so the revived turn runs
    // its own events before it can end.
    await h.fireEvent(events.status(id, "busy"));
    await h.settle(id);
    assert.strictEqual(h.notices().length, 2, "revival earns a fresh settlement");
    assert.ok(h.noticeBodies()[1].includes("completed successfully")); });

  it("a late echo from the turn a revival replaced cannot settle the revival", async () => {
    const { h, c, id } = await withSettledChild();
    const note = await echoesCannotSettle(h, c, id, () => c.steer("continue"));
    assert.ok(note.includes("completed successfully"), `got: ${note}`);
  });

  it("interrupted children are not revived — the guidance says spawn fresh", async () => {
    const { h, c, id } = await withChild();
    await c.interrupt();
    const out = await c.steer("again");
    assert.ok(out.includes("not revived"), `got: ${out}`);
    assert.ok(out.includes("dynamic_task"), `points at the fresh-spawn path. got: ${out}`); });

  it("a revived turn does not wear the previous turn's notification", async () => {
    const { h, c, id } = await withSettledChild();
    await sleep(10);
    await c.steer("again");
    const status = await c.status();
    assert.ok(!status.includes("Last notification"), `new turn, nothing reported yet. got: ${status}`);
    const summary = await c.result();
    assert.ok(!summary.includes("Last notification"), `same for result reads. got: ${summary}`); });

  it("reviving with a model override reroutes and persists it", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ model: "nvidia/z-ai/glm-5.3" });
    await h.settle(id);
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "again", model: "other/thing-1" });
    assert.ok(out.includes("Follow-up sent"), `got: ${out}`);
    const routed = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.deepStrictEqual(routed[routed.length - 1].body.model, { providerID: "other", modelID: "thing-1" });
    const status = await c.status();
    assert.ok(status.includes("Model: other/thing-1"), `persists on the record. got: ${status}`);
    });

  it("a bare model on continue fails without touching the task", async () => {
    const { h, c, id } = await withSettledChild();
    const before = h.client._state.promptBodies.length;
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "again", model: "bare-id" });
    assert.ok(out.includes("Invalid model"), `got: ${out}`);
    assert.strictEqual(h.client._state.promptBodies.length, before, "no prompt fires");
    const status = await c.status();
    assert.ok(status.includes("completed"), `still settled. got: ${status}`); });

  it("unknown sessions are refused as untracked", async () => {
    const h = await setupHarness();
    const out = await h.tool.task_continue.execute({
      session_id: "ses_missing",
      prompt: "hello?",
      });
    assert.ok(out.includes("not a tracked task"), `got: ${out}`);
    });
});

describe("task_notify: the child-to-parent channel", () => {

  it("delivers a mid-flight notice and leaves the task active", async () => {
    const { h, c, id } = await withChild();
    const out = await c.notify("blocked: need DB credentials");
    assert.ok(out.includes("Message sent to parent"), `got: ${out}`);
    const notes = h.notices();
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].to === "p1", "notice routes to the parent session");
    assert.ok(notes[0].message.includes("running child task"), `notice kind. got: ${notes[0].message}`);
    assert.ok(notes[0].message.includes("blocked: need DB credentials"));

    // A notice is not a settlement: the child still completes and reports.
    const status = await c.status();
    assert.ok(status.includes("active"), `task stays active. got: ${status}`);
    assert.ok(status.includes("need DB credentials"), `notice recorded on the task. got: ${status}`);

    await h.settle(id);
    assert.strictEqual(h.notices().length, 2, "settlement still reports"); });

  it("distinct long notices sharing a prefix both deliver", async () => {
    const { h, c, id } = await withChild();
    const first = await c.notify("a".repeat(200) + "1");
    const second = await c.notify("a".repeat(200) + "2");
    assert.ok(first.includes("Message sent to parent"), `got: ${first}`);
    assert.ok(second.includes("Message sent to parent"), `prefix collision must not suppress. got: ${second}`);
    assert.strictEqual(h.notices().length, 2); });

  // One hypothesis: a repeat of an identical notice never redelivers, and the
  // child is told both that and what to do instead.
  it("a suppressed duplicate says to say something new", async () => {
    const { h, c, id } = await withChild();
    await c.notify("still working");
    const again = await c.notify("still working");
    assert.ok(again.includes("duplicate suppressed"), `keeps the kind. got: ${again}`);
    assert.ok(again.includes("Say something new"), `tells the child what to do. got: ${again}`);
    assert.strictEqual(h.notices().length, 1, "the parent hears it once"); });

  it("an unreachable parent is reported distinctly from a duplicate", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { promptFailIds: new Set(["p1"]) } } });
    const out = await c.notify("hello?");
    assert.ok(out.includes("did not acknowledge"), `names the failure. got: ${out}`);
    assert.ok(!out.includes("duplicate"), `never confuses the two. got: ${out}`); });


  it("a suppressed duplicate shows as Suppressed in task_result, never FAILED", async () => {
    const { h, c, id } = await withChild();
    await c.notify("status: compiling");
    await c.notify("status: compiling");
    const summary = await c.result();
    assert.ok(
    summary.includes("Suppressed (duplicate — already delivered)"),
    `the duplicate must read as suppression. got: ${summary}`,
    );
    assert.ok(!summary.includes("FAILED"), `suppression is not a delivery failure. got: ${summary}`); });

  it("refuses untracked callers and settled tasks", async () => {
    const h = await setupHarness();
    const stranger = await h.tool.task_notify.execute({ message: "hi" }, { sessionID: "ses_stranger" });
    assert.ok(stranger.includes("Not a tracked task"), `got: ${stranger}`);

    const { id, c } = await h.spawn();
    await h.settle(id);
    const late = await c.notify("too late");
    assert.ok(/settled/i.test(late), `got: ${late}`);
    });

  it("validates message shape and length", async () => {
    const { h, c, id } = await withChild();
    assert.ok((await c.notify("  ")).includes("required"));
    const long = await c.notify("x".repeat(4001));
    assert.ok(long.includes("too long"), `got: ${long}`); });
});

describe("error settlement guidance", () => {
  async function settleWithMessageError(detail) {
    const h = await setupHarness({
      hooks: { messages: () => [{ info: { role: "assistant", error: { data: { message: detail } } }, parts: [] }] },
      });
    const { id, c } = await h.spawn();
    await h.fireEvent(events.error(id));
    assert.strictEqual(h.notices().length, 1, "error settles exactly once");
    return h.noticeBodies()[0];
    }

  it("transient error settlements name task_continue as the resume path", async () => {
    const note = await settleWithMessageError("429 rate limit exceeded, retry shortly");
    assert.ok(note.includes("transient"), `names the failure class. got: ${note}`);
    assert.ok(note.includes("task_continue"), `points at resume. got: ${note}`);
    });

  it("fatal error settlements carry no resume hint", async () => {
    const note = await settleWithMessageError("permission denied for model");
    assert.ok(note.includes("permission denied"), `keeps the cause. got: ${note}`);
    assert.ok(!note.includes("transient"), `no resume hint for fatal. got: ${note}`);
    });
});

describe("task_result and task_interrupt paths", () => {

  it("task_result requires a session id", async () => {
    const h = await setupHarness();
    assert.ok((await h.tool.task_result.execute({})).includes("required"));
    });

  // One hypothesis: task_result reports the STORE's state, and the liveness read
  // underneath it is the SERVER's own word plus the child's own last message —
  // never a guess about message shapes. Each case names the fragments that must
  // (or must not) be in the report for its state.
  const reports = [
    ["task_result reports store state for active tasks with the server's liveness beside it",
      withChild, [["Status: active", true], ["Server status: busy", true], ["task_status", true], ["Tracked: yes", true]]],
    ["task_result never guesses a status from the message stream",
      withChild, [["suggests", false], ["Last child message", true], ["Last plugin event", true]]],
    ["task_result reports a settled state with no liveness noise when the server is quiet",
      withSettledChild, [["Status: completed", true], ["Server status", false], ["Last child message", false]]],
  ];
  for (const [name, scenario, expectations] of reports) {
    it(name, async () => {
      const { c } = await scenario();
      const summary = await c.result();
      for (const [fragment, present] of expectations) {
        assert.ok(
          summary.includes(fragment) === present,
          `${present ? "must" : "must not"} contain ${fragment}. got: ${summary}`,
        );
      }
    });
  }

  // Liveness is a four-way question and each answer names its own source, so a
  // reader can never take "active" for "working" or a stall for a store that
  // simply has not been told. The two failure modes are the ones that produce
  // wrong recoveries: waiting on a dead child, and interrupting a live one.
  const liveness = [
    ["a running child reads the server's word and the child's own last message",
      async ({ c, id }) => {
        const out = await c.status();
        return [out, [[/Server status: busy/, true], [/Last child message: \d+s ago/, true]]];
      }],
    ["a just-steered turn waiting to start reads as pending, not as work in progress",
      async ({ c }) => {
        // The abort parks the turn on the server, so the status channel reads
        // idle until the replacement's first event — the exact window turn
        // attribution exists to cover.
        await c.steer("pivot");
        const out = await c.status();
        return [out, [[/Server status: idle/, true], [/replacement turn has not started/i, true], [/stalled/i, false]]];
      }],
    ["a store the server has stopped reporting is flagged, not read as work",
      async ({ h, c }) => {
        h.setHostStatus(c.id, "idle");
        const out = await c.status();
        return [out, [[/missed the ending/i, true], [/task_interrupt/, true]]];
      }],
    ["a settled child the server still calls busy says its settlement was premature",
      async ({ h, c }) => {
        await h.settle(c.id);
        h.setHostStatus(c.id, "busy");
        const out = await c.status();
        return [out, [[/Server status: busy/, true], [/still working/i, true]]];
      }],
  ];
  for (const [name, read] of liveness) {
    it(name, async () => {
      const ctx = await withChild();
      const [out, expectations] = await read(ctx);
      for (const [pattern, present] of expectations) {
        assert.ok(
          pattern.test(out) === present,
          `${present ? "must" : "must not"} match ${pattern}. got: ${out}`,
        );
      }
    });
  }

  it("task_result maps API 404 to unknown, in the same markdown voice", async () => {
    const h = await setupHarness();
    const summary = await h.tool.task_result.execute({ session_id: "ses_gone" });
    assert.ok(summary.includes("Status: unknown"), `got: ${summary}`);
    assert.ok(summary.startsWith("## Task Result"), `one format for all reads. got: ${summary}`);
    });

  it("task_result maps a failed read to error state", async () => {
    // The read that fails is the one the tool actually makes. A transport
    // failure is reported as an error status, never as a quiet success.
    const failing = await setupHarness({ hooks: { messages: () => { throw new Error("boom"); } } });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes("Status: error"), `got: ${summary}`);
    assert.ok(summary.includes("boom"), `the cause rides along. got: ${summary}`);
    });

  it("a tracked task whose read fails still reports the store's own state", async () => {
    const summary = await resultForUnreadableChild();
    assert.ok(summary.includes("Status: active"), `the store is the authority. got: ${summary}`);
    assert.ok(summary.includes("(API unavailable)"), `the failed read says so. got: ${summary}`);
    assert.ok(!summary.includes("Server status"), `no reading, no liveness block. got: ${summary}`);
  });

  it("a status channel that cannot be asked renders the record without a diagnosis", async () => {
    // Absence of a reading is not evidence of anything. The record renders; the
    // stall line may fire on the plugin's own clock, but nothing claims to know
    // what turn the server is on.
    const { c } = await withChild({ harness: { hooks: { statusThrows: new Error("status down") } } });
    const status = await c.status();
    assert.ok(status.includes("State: active"), `got: ${status}`);
    assert.ok(status.includes("Last plugin event:"), `the plugin's own clock still reads. got: ${status}`);
    assert.ok(!status.includes("Server status"), `an unanswered channel renders nothing. got: ${status}`);
    assert.ok(!status.includes("missed the ending"), `no reading, no verdict. got: ${status}`);
  });

  // What a child's *written* output is reported as when there is none to
  // report. One arrangement — a child whose single message carries no clock and
  // no assistant text, which is exactly what a plugin booted mid-turn sees —
  // and the two lines that must state the absence rather than invent it.
  const nothingWritten = [
    ["no message times", "Last child message: (none yet)"],
    ["no assistant text", "(No assistant text found)"],
  ];
  for (const [name, expected] of nothingWritten) {
    it(`a child with ${name} says so rather than guessing an age`, async () => {
      const summary = await resultForChild([UNCLOCKED_MESSAGE]);
      assert.ok(summary.includes(expected), `no invention. got: ${summary}`);
    });
  }

  // The message list is `{ info, parts }` per item — the clock lives on `info`.
  // Reading `time` off the item is not a crash: it renders as "this child has
  // never written a message", which is what a live smoke test caught on a child
  // that had written three.
  it("a child's last message time comes off the message's info, not the item", async () => {
    const writtenAt = Date.now() - 45_000;
    const summary = await resultForChild([
      { info: { role: "assistant", time: { created: writtenAt, completed: writtenAt } }, parts: [{ type: "text", text: "done" }] },
    ]);
    assert.match(summary, /Last child message: 4[0-9]s ago/, `the child's own clock. got: ${summary}`);
  });

  it("an untracked session with no status channel is unknown, not idle", async () => {
    // No record to reconcile and no server word: the only honest status is the
    // absence of one. Reporting "completed" here is how a caller resumes a
    // session that is still working.
    const h = await setupHarness({
      hooks: {
        statusThrows: new Error("status down"),
        messages: () => [{ role: "assistant", parts: [{ type: "text", text: "working" }] }],
      },
    });
    const summary = await h.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes("Status: unknown"), `got: ${summary}`);
    assert.ok(!summary.includes("Server status"), `nothing was learned. got: ${summary}`);
  });

  it("a retryable transport failure says so", async () => {
    const refused = await setupHarness({ hooks: { messages: () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    } } });
    const summary = await refused.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes("Status: error"), `got: ${summary}`);
    assert.ok(summary.includes("(retryable)"), `a refused connection is worth retrying. got: ${summary}`);
  });

  it("interrupt on a settled task reports the settled state, not a fresh interrupt", async () => {
    const { h, c, id } = await withSettledChild();
    const done = await c.interrupt();
    assert.ok(done.includes("already settled as completed"), `truthful report. got: ${done}`);
    assert.ok(!/^Session .* interrupted\.$/.test(done), `must not claim a fresh interrupt. got: ${done}`);
    const status = await c.status();
    assert.ok(status.includes("completed"), `history untouched. got: ${status}`); });

  it("task_interrupt settles as interrupted, preserves history, and reaches the API", async () => {
    const { h, c, id } = await withChild();
    const done = await c.interrupt();
    assert.ok(done.includes("interrupted"), `got: ${done}`);
    assert.ok(h.client._state.aborted.includes(id), "abort must reach the API");
    // P1a contract: the record survives (history preserved) and no event can
    // re-settle it — the synchronous claim happened BEFORE the abort.
    const status = await c.status();
    assert.ok(status.includes("interrupted"), `history preserved. got: ${status}`);
    await h.settle(id);
    assert.strictEqual(h.notices().length, 0, "the abort's own idle event must not notify"); });

  it("task_interrupt requires a session id and names missing sessions", async () => {
    const h = await setupHarness();
    assert.ok((await h.tool.task_interrupt.execute({})).includes("required"));
    const missing = await setupHarness({ hooks: { abortFailIds: new Set(["ses_ghost"]) } });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    assert.ok(out.includes("not found"), `got: ${out}`);
    });

  it("a failed abort leaves a live task active — the natural event still settles it", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.interrupt();
    assert.ok(out.includes("abort failed"), `reports the abort gap. got: ${out}`);
    assert.ok(out.includes("active"), `admits the child may be live. got: ${out}`);
    const status = await c.status();
    assert.ok(status.includes("active"), `speculative claim withdrawn. got: ${status}`);
    // The child's genuine terminal event still settles and notifies.
    await h.settle(id);
    assert.strictEqual(h.notices().length, 1, "natural completion delivers");
    assert.ok(h.noticeBodies()[0].includes("completed successfully")); });

  it("a failed abort on a settled task records the gap without disturbing history", async () => {
    const { h, c, out } = await withBrokenAbortSettledChild();
    assert.ok(out.includes("already settled as completed"), `got: ${out}`);
    assert.ok(out.includes("ECONNREFUSED"), `gap recorded in the report. got: ${out}`);
    const status = await c.status();
    assert.ok(status.includes("completed"), `got: ${status}`);
    assert.ok(!status.includes("Abort error"), `a success record stays clean. got: ${status}`);
    });
});

describe("a child that needs input is not a success", () => {
  // The spawn contract tells a child to notify the parent when it is blocked.
  // When that child's turn then ended, the plugin recorded `completed` and told
  // the parent "Background task completed successfully" — a false success claim
  // about a task that did no work, in the ledger, the tree, and every read. The
  // child already knows it is blocked; the record has to be able to say so.
  it("a child that declared it needs input settles as blocked, and the parent is told to answer", async () => {
    const { h, c, id } = await withChild();
    await c.notify("I need the API key to continue.", { kind: "needs_input" });
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked", "the record says what happened");
    const body = h.noticeBodies()[0];
    assert.match(body, /needs input|blocked/i, `the parent is told the task is waiting. got: ${body}`);
    assert.match(body, /task_continue/, `and how to answer it. got: ${body}`);
    assert.ok(!/completed successfully/.test(body), `never a success claim. got: ${body}`);
  });

  it("a child that declared nothing still settles completed", async () => {
    // The guard on the whole change: the state is earned by a declaration, not
    // assumed for every ending turn.
    const { h, c, id } = await withChild();
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed");
  });

  it("a failed turn outranks a needs-input declaration", async () => {
    const { h, c, id } = await withChild();
    await c.notify("blocked on the key", { kind: "needs_input" });
    await h.fireEvent(events.status(id, "error"));
    assert.strictEqual(await stateOf(c), "State: error", "a failure is not a question");
  });

  it("a declaration belongs to the turn that made it", async () => {
    // A steer that lands AFTER the declaration is the answer: the ending turn
    // made no new claim, so its ending is its own. Without the turn scoping a
    // child that got its answer mid-turn would still be reported as waiting.
    const { h, c, id } = await withChild();
    await c.notify("which environment?", { kind: "needs_input" });
    await c.steer("staging");
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed", "the answer moved it on");
  });

  it("a blocked task is answerable: it revives and stops being blocked", async () => {
    const { h, c, id } = await withChild();
    await c.notify("I need the key.", { kind: "needs_input" });
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked");
    await c.steer("here is the key");
    assert.strictEqual(await stateOf(c), "State: active", "answered tasks run again");
  });

  it("a blocked record survives a restart as blocked, and is still answerable", async () => {
    // The durable reader once validated a restored record against its OWN
    // hand-written list of states, so a state added to the machine was silently
    // dropped on the next boot — the plugin forgetting, in one process, that it
    // had ever asked a parent a question. The list is the machine's now, and
    // this test fails the moment a new state is not in it.
    const directory = tmpProjectDir();
    const now = Date.now();
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({
      version: 3,
      pending: [],
      tasks: {
        ses_blocked1: {
          childSessionId: "ses_blocked1", parentSessionId: "p1", agentName: "explore",
          description: "waiting on the key", lineage: ["explore"], state: "blocked",
          startedAt: now - 5000, retainedAt: now - 100,
        },
      },
    }));
    const h = await setupHarness({ hooks: {}, directory });
    const c = h.child("ses_blocked1");
    assert.strictEqual(await stateOf(c), "State: blocked", "the restored record is not dropped");
    const answer = await c.steer("here is the key");
    assert.match(answer, /Follow-up sent/, `still answerable after a restart. got: ${answer}`);
    assert.strictEqual(await stateOf(c), "State: active", `got: ${await c.status()}`);
  });

  it("the declaration rides the notice channel, and an unknown claim is refused", async () => {
    const { c } = await withChild();
    const refused = await c.notify("asking", { kind: "urgent" });
    assert.match(refused, /urgent/, `the rejected value is quoted back. got: ${refused}`);
    assert.match(refused, /needs_input/, `the choices are named. got: ${refused}`);
  });
});

describe("subtree interrupt: stopping a task stops everything under it", () => {
  // A dispatch is a tree, so an interrupt that stops only the session it was
  // handed reports success while a descendant keeps spending tokens. Each case
  // names the set the plugin acted on, and each member's own truth.
  //
  // Two levels is the deepest tree reachable today (see withDispatchTree); the
  // walk is depth-agnostic, so nothing here is written to two levels.
  const stateOf = async (h, id) => h.tool.task_status.execute({ session_id: id });

  it("one interrupt stops the whole tree and names every member", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    for (const member of [child, grandchild]) {
      assert.ok(out.includes(member.id), `the report names ${member.id}. got: ${out}`);
      assert.ok((await stateOf(h, member.id)).includes("interrupted"), `${member.id} is stopped`);
    }
  });

  it("scope self stops only the session it was handed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id, scope: "self" });
    assert.ok(!out.includes(grandchild.id), `a descendant was not acted on, so it is not named. got: ${out}`);
    assert.ok((await stateOf(h, child.id)).includes("interrupted"), "the handed session is stopped");
    assert.ok((await stateOf(h, grandchild.id)).includes("active"), "the descendant is still running");
  });

  it("an unrecognized scope is refused, never silently widened or narrowed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id, scope: "everything" });
    assert.ok(out.includes("everything"), `the rejected value is quoted back. got: ${out}`);
    assert.ok(out.includes("subtree"), `the choices are named. got: ${out}`);
    assert.ok((await stateOf(h, grandchild.id)).includes("active"), "nothing was stopped");
  });

  it("a settled descendant is not named: there was nothing to stop there", async () => {
    const { h, child, grandchild } = await withSettledDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    assert.ok(!out.includes(grandchild.id), `the finished child is not re-aborted. got: ${out}`);
    assert.ok(out.includes(child.id), `the task the caller named is still answered. got: ${out}`);
  });

  it("a settled task still has a live child below it, and the child is stopped", async () => {
    // The walk starts at the named session whatever state it is in, so a
    // finished parent is not a wall: the grandchild it left running is exactly
    // the work an interrupt is for, and reporting only "already settled" would
    // hand back a clean answer over work that is still spending tokens.
    const { h, child, grandchild } = await withDispatchTree();
    await h.settle(child.id);
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    assert.ok(out.includes("already settled as completed"), `the root's own truth. got: ${out}`);
    assert.ok(out.includes(grandchild.id), `the live child below it is named. got: ${out}`);
    assert.ok((await stateOf(h, grandchild.id)).includes("interrupted"), "the grandchild is stopped");
  });

  it("the whole tree is claimed before the first abort reaches the server", async () => {
    // The claim is what orders the echoes: a terminal event for a task whose
    // interrupt claim has already been taken finds settled history instead of
    // an active record, so it cannot report a completion the parent was just
    // told about. With claims taken one abort at a time, the descendant is
    // still active while the first abort is in flight — and this is the window
    // the ordering makes unrepresentable.
    const { h, child, grandchild } = await withDispatchTree();
    const gate = h.client.gateAbort();
    const pass = h.tool.task_interrupt.execute({ session_id: child.id });
    await sleep(30);
    assert.ok((await stateOf(h, child.id)).includes("interrupted"), "the root is claimed");
    assert.ok((await stateOf(h, grandchild.id)).includes("interrupted"), "the descendant is claimed too, before any abort returned");
    gate.release();
    await pass;
  });
});

describe("settlement: the notification layer owns outcomes", () => {
  it("parentless settlements leave a visible non-delivery record", async () => {
    const { h, c, id, out } = await withChild({
      spawn: { description: "orphan task", prompt: "hi" },
      ctx: {},
      });
    assert.ok(out.includes("notification: disabled"), `got: ${out}`);
    await h.settle(id);
    const summary = await c.result();
    assert.ok(summary.includes("FAILED") || summary.includes("delivered: false") || summary.includes("no parent"), `deafness must be distinguishable from silence. got: ${summary}`);
    });

  it("post-create registration failure notifies instead of stranding error", async () => {
    // Same-tick race through the advisory check: both spawns see an empty
    // slot, both create, the loser hits the authoritative register gate.
    const h = await setupHarness({ options: { maxConcurrent: 1 } });
    const args = (description) => ({ description, subagent_type: "explore", prompt: "hi" });
    const [r1, r2] = await Promise.all([
    h.tool.dynamic_task.execute(args("racer one"), { sessionID: "p1" }),
    h.tool.dynamic_task.execute(args("racer two"), { sessionID: "p1" }),
    ]);
    assert.strictEqual([r1, r2].filter((r) => r.includes("in background")).length, 1, "one winner");
    assert.strictEqual([r1, r2].filter((r) => r.includes("ERROR")).length, 1, "one loser");
    const winner = /Session: (\S+)/.exec([r1, r2].find((r) => r.includes("in background")))?.[1];
    const loser = [...h.client._state.sessions].find((id) => id !== winner);
    assert.ok(loser, "loser session was created");
    assert.ok(h.client._state.aborted.includes(loser), `loser aborted, no orphan. aborted=${h.client._state.aborted}`);
    await sleep(50); // detached error-settlement delivery
    assert.strictEqual(h.notices().length, 1, "the error settlement notifies");
    const note = h.noticeBodies()[0];
    assert.ok(note.includes("ended with an error"), `error kind. got: ${note}`);
    });

  it("settlement does not hold the event pump on slow transport", async () => {
    const gate = deferred();
    const h = await setupHarness({ hooks: { notifyTransport: { hang: gate } } });
    const { id, c } = await h.spawn();
    const settled = h.settle(id);
    const winner = await Promise.race([settled.then(() => "event"), sleep(500).then(() => "timeout")]);
    assert.strictEqual(winner, "event", "event handler must not wait for delivery transport");
    gate.resolve();
    await settled;
    });

  it("background prompt failure settles as error and notifies once", async () => {
    const hooks = { promptFailIds: new Set(["ses_mock_1"]) };
    const failing = await setupHarness({ hooks: hooks });
    const { id } = await failing.spawn({ description: "doomed task" });
    await sleep(50); // the fire-and-forget catch schedules the settlement
    const notes = failing.client._state.notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 prompt error notification");
    assert.match(notes[0].message, /ended with an error/i, "error-kind notification");
    const summary = await failing.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("error"), `task must be retained as error. got: ${summary}`);
    // The lifecycle event that follows must not double-settle.
    await failing.settle(id);
    assert.strictEqual(notes.length, 1, "exactly-once survives a late idle");
    });

  it("repeated terminal events notify exactly once", async () => {
    const { h, c, id } = await withSettledChild();
    await h.settle(id);
    await h.fireEvent(events.status(id));
    assert.strictEqual(h.notices().length, 1, "one settled turn, one notice"); });

  it("unmatched question events are left untouched (fail-closed scoping)", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.question(undefined, [], { id: "q1" }));
    await h.fireEvent(events.question("ses_stranger", [{ text: "yes" }], { id: "q9" }));
    await h.fireEvent(events.questionReplied({ id: "q1" }));
    assert.strictEqual(h.notices().length, 0, "no parent traffic for questions");
    assert.strictEqual(h.questionCalls().length, 0, "never touches foreign questions");
    });

  it("init guard disables the plugin without required client APIs", async () => {
    const mod = await import("../../dist/index.js");
    const pluginFn = mod.default || mod;
    const result = await pluginFn({ client: {}, directory: "/tmp" }, {});
    assert.deepStrictEqual(result, {});
    });
});

/**
 * A dispatch the gate refuses, in the parent's own words — the pair every wait
 * test needs, and the words the release message has to name back. Asserting the
 * refusal here means each case below states only what it is actually about.
 */
async function refuseDispatch(h, description, depends_on, depends_on_settled) {
  const refusal = await h.trySpawn({
    description,
    prompt: "do the downstream thing",
    subagent_type: "general",
    depends_on,
    ...(depends_on_settled ? { depends_on_settled } : {}),
  });
  assert.match(refusal, /Dependencies pending/, `the dispatch was refused. got: ${refusal}`);
  return refusal;
}

/**
 * Settle an edge the way a FAILURE does: the host says error, then the turn
 * ends. Separate from `settle` because the error word is the whole difference
 * between a dependency that releases a wait and one that kills it, and it is
 * not a thing a test should spell out twice.
 */
async function failEdge(h, id) {
  await h.fireEvent(events.status(id, "error"));
  await h.settle(id);
}

/**
 * Settle something, and hand back what the parent was told about a refused
 * dispatch of `description`. The COUNT is asserted here because both "announced
 * once" and "announced not at all" are the contract, and the caller states
 * which — so no case has to restate it, and none can quietly accept a second.
 */
async function announcedAbout(h, description, action, expected = 1) {
  const hints = await h.noticesMatching(new RegExp(description), action, expected);
  const report = `announced ${expected} time(s). got: ${JSON.stringify(h.noticeBodies())}`;
  assert.strictEqual(hints.length, expected, report);
  return hints[0] ?? { message: "", to: "" };
}

/**
 * One running edge, and one dispatch refused on it — THE scenario this suite is
 * about, so it is built once and each case states only what it varies. Returns
 * the edge, because what a case does next is always something TO the edge.
 */
async function refusedOnOneEdge(h, description, kind = "strict") {
  const edge = await h.spawn({ description: "edge work" });
  const settledOnly = kind === "settled";
  await refuseDispatch(
    h,
    description,
    settledOnly ? undefined : [edge.id],
    settledOnly ? [edge.id] : undefined,
  );
  return edge;
}

/** The scenario, ready to observe: a fresh parent, one running edge, one refused dispatch. */
async function refusedDispatchScenario(kind) {
  const h = await setupHarness();
  return { h, edge: await refusedOnOneEdge(h, "consume the edge", kind) };
}

describe("dependency waits are state, not prose the parent must remember", () => {
  // A refused depends_on was advice in a string and nothing else. The plugin
  // forgot the dispatch, so the parent had to carry the wait in prose, be alive
  // when the dependency settled, and re-dispatch from memory. Every one of those
  // is the parent's context, which is exactly what the plugin exists to hold.
  it("a refused dispatch is remembered and announced the moment its edge clears", async () => {
    const { h, edge } = await refusedDispatchScenario();
    const hint = await announcedAbout(h, "consume the edge", () => h.settle(edge.id));
    assert.strictEqual(hint.to, "p1", `and it goes to the parent that asked. got: ${hint.to}`);
    assert.match(hint.message, /can go now/i, `in words that ask for the action. got: ${hint.message}`);
  });

  it("a wait whose edge settled short of completed is announced as dead, not as ready", async () => {
    // The edge can never satisfy a strict depends_on again — it will not run
    // again. Announcing nothing would leave the parent waiting on a task that
    // is gone; announcing it as ready would hand it a dispatch whose gate
    // refuses, which reads as the plugin contradicting itself.
    const { h, edge } = await refusedDispatchScenario();
    const hint = await announcedAbout(h, "consume the edge", () => failEdge(h, edge.id));
    assert.match(hint.message, /never run/i, `named as unrunnable. got: ${hint.message}`);
    assert.ok(!/can go now/i.test(hint.message), `never announced as ready. got: ${hint.message}`);
  });

  it("a wait with an edge still running is not announced, and it resolves on the LAST edge", async () => {
    const h = await setupHarness();
    const one = await h.spawn({ description: "edge one" });
    const two = await h.spawn({ description: "edge two" });
    await refuseDispatch(h, "consume both", [one.id, two.id]);

    await announcedAbout(h, "consume both", () => h.settle(one.id), 0);
    await announcedAbout(h, "consume both", () => h.settle(two.id));
  });

  it("a wait cleared by settlement only, and announced exactly once", async () => {
    // depends_on_settled waits for any terminal state, so a failed edge still
    // releases it — the wait is about the gate's readiness, not about success.
    const { h, edge } = await refusedDispatchScenario("settled");
    const released = await announcedAbout(h, "consume the edge", () => failEdge(h, edge.id));
    assert.match(released.message, /can go now/i, `a settled edge is enough. got: ${released.message}`);

    // The wait is gone from the store when it is announced, so a later turn on
    // an unrelated task has nothing left to say about it.
    await announcedAbout(h, "consume the edge", async () => {
      const other = await h.spawn({ description: "unrelated work" });
      await h.settle(other.id);
    }, 0);
  });
});

describe("question gate: child questions settle", () => {
  it("answers from an active child are auto-answered with the first option", async () => {
    const { h, c, id } = await withChild();
    await h.fireEvent(events.question(id, [{ text: "yes" }, { text: "no" }], { id: "q1" }));
    const calls = h.questionCalls();
    assert.strictEqual(calls.length, 1, "exactly one settlement");
    assert.deepStrictEqual(calls[0], { method: "reply", id: "q1", answer: "yes" });
    assert.strictEqual(h.notices().length, 0);
    await h.fireEvent(events.questionReplied({ id: "q1" })); });

  it("an answerless question tells the child the path that exists, not one that does not", async () => {
    // The rejection is the ONLY thing a blocked child sees at the moment it is
    // blocked. It used to read "steer with task_continue when it resumes" — a
    // parent tool, and an instruction to WAIT, in a system whose own spawn prompt
    // says never wait. The child was left with a blocked turn and no durable
    // claim to make, so it either stalled or settled as a success. The remedy it
    // is given is the one it can act on in its own turn.
    const { h, id } = await withChild();
    const reason = await assertQuestionRejected(h, events.question(id, [], { id: "q2" }));
    assert.match(reason, /task_notify/, `names the tool the child holds. got: ${reason}`);
    assert.match(reason, /needs_input/, `and the claim that makes the block durable. got: ${reason}`);
    assert.ok(!/when it resumes/.test(reason), `never tells a child to wait. got: ${reason}`);
  });

  it("a question the gate could not answer is a block the settlement must not report as a success", async () => {
    // The gate is the plugin BLOCKING the child: it told the child that nobody
    // can answer. It knows the child cannot finish on that point, so it knows
    // more than the child recorded. If the child does not itself call
    // task_notify, the settlement read nothing and reported the block as a
    // success — the same false success, arriving through a different door. The
    // gate is the second source of the claim, and it must reach the same funnel.
    const { h, c, id } = await withChild();
    await h.fireEvent(events.question(id, [], { id: "q-block" }));
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: blocked", `the gate's block is the record's block.`);
  });

  it("a question the gate ANSWERED is not a block — the child kept moving", async () => {
    const { h, c, id } = await withChild();
    await h.fireEvent(events.question(id, [{ text: "yes" }], { id: "q-answered" }));
    await h.settle(id);
    assert.strictEqual(await stateOf(c), "State: completed", `an answered question blocks nothing.`);
  });

  it("settled task questions are rejected with settled guidance", async () => {
    const { h, c, id } = await withSettledChild();
    const reason = await assertQuestionRejected(h, events.question(id, [{ text: "yes" }], { id: "q3" }));
    assert.ok(reason.includes("settled"), `must say the task is settled. got: ${reason}`); });

  it("a failed retained rejection is logged as failed, never as rejected", async () => {
    const directory = tmpProjectDir();
    await withEnv("DYNAMIC_TASK_DEBUG", "1", async () => {
      const { h, id, c } = await withSettledChild({
        harness: { hooks: { questionRejectThrows: true }, directory },
      });
      await h.fireEvent(events.question(id, [{ text: "yes" }], { id: "q9" }));
      const log = readFileSync(join(directory, ".dynamic-task-logs", `parent-p1__child-${id}.log`), "utf8");
      assert.ok(log.includes("question-retained-reject-failed"), `failure logged. got: ${log}`);
      assert.ok(!log.includes('"eventName":"question-retained-rejected"'), `must not claim rejection. got: ${log}`);
      await c.interrupt();
    });
    });

  it("request_id linkage is forgotten on reply — no stale attribution", async () => {
    const h = await setupHarness();
    const one = await h.spawn({ description: "first owner" });
    await h.fireEvent(events.question(one.id, [{ text: "yes" }], { request_id: "q-stale" }));
    assert.strictEqual(h.questionCalls().length, 1, "first question answered");
    // Reply arrives under request_id only (no id field).
    await h.fireEvent(events.questionReplied({ request_id: "q-stale" }));
    await h.tool.task_interrupt.execute({ session_id: one.id });
    const two = await h.spawn({ description: "second owner" });
    await h.fireEvent(events.question(two.id, [{ text: "yes" }], { request_id: "q-stale" }));
    const last = h.questionCalls()[h.questionCalls().length - 1];
    assert.strictEqual(last.method, "reply", `stale linkage must not divert to the settled owner. got: ${JSON.stringify(last)}`);
    assert.strictEqual(last.id, "q-stale");
    });

  it("reply failure falls back to rejection", async () => {
    const failing = await setupHarness({ hooks: { questionReplyThrows: true } });
    const { id } = await failing.spawn();
    await failing.fireEvent(events.question(id, [{ text: "yes" }], { id: "q4" }));
    const calls = failing.questionCalls();
    assert.ok(calls.some((c) => c.method === "reject"), "fallback rejection must fire");
    });
});

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const hooks = { promptFailIds: new Set(["p1"]) };
    const h = await setupHarness({ hooks: hooks });
    const { id, c } = await h.spawn({ description: "doomed parent task" });
    await h.settle(id);
    assert.strictEqual(h.notices().length, 0, "nothing delivered");
    await sleep(600); // detached delivery runs the gate's 250ms retry cycle
    const summary = await c.result();
    assert.ok(summary.includes("FAILED"), `delivery failure surfaced. got: ${summary}`);
    });

  it("a failed delivery does not consume the settlement — redelivery can succeed", async () => {
    // p1's prompt fails ONLY on the first attempt (child prompt ok, parent
    // notify attempt 1 fails, attempt 2 succeeds): the record is a history,
    // not a veto — exactly-once is about successful deliveries.
    const { h, c } = await withSettledChild({ harness: { hooks: { notifyTransport: { failTimes: 1 } } } });
    await sleep(500); // one retry cycle at the gate's fixed backoff
    assert.strictEqual(h.notices().length, 1, "the retry delivered");
    const summary = await c.result();
    assert.ok(summary.includes("completed"), `final record is a success. got: ${summary}`);
    });
});

describe("task fleet views", () => {
  it("task_list shows active and retained tasks", async () => {
    const h = await setupHarness();
    const one = await h.spawn({ description: "fleet one" });
    const two = await h.spawn({ description: "fleet two" });
    await h.settle(two.id);
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes(one.id) && list.includes(two.id), `both fleets visible. got: ${list}`);
    assert.ok(list.includes("Active: 1/4"), `got: ${list}`);
    assert.ok(list.includes("Retained: 1"), `got: ${list}`);
    });

  // A dispatch is a tree, and the flat list hid that: the one fact that
  // decides HOW to stop a runaway task — it is a grandchild, not a sibling —
  // was in the store and in no view. The tree costs no extra host read, because
  // the store already holds every edge.
  describe("the running fleet renders as the tree it is", () => {
    const lineFor = (list, sessionId) =>
      list.split("\n").find((line) => line.includes(sessionId)) ?? `(no line for ${sessionId})`;

    it("a grandchild is shown under the task that spawned it", async () => {
      const { h, child, grandchild } = await withDispatchTree();
      const list = await h.tool.task_list.execute({});
      const childLine = lineFor(list, child.id);
      const grandchildLine = lineFor(list, grandchild.id);
      assert.ok(/^- /.test(childLine), `a root sits flush. got: ${childLine}`);
      assert.ok(/^  - /.test(grandchildLine), `a descendant is indented under it. got: ${grandchildLine}`);
    });

    it("a finished task is history, not part of the running tree", async () => {
      const { h, child, grandchild } = await withSettledDispatchTree();
      const list = await h.tool.task_list.execute({});
      assert.ok(list.includes("Active: 1/4"), `one task is still running. got: ${list}`);
      const section = list.slice(0, list.indexOf("Retained:"));
      assert.ok(section.includes(child.id), `the running task is there. got: ${section}`);
      assert.ok(!section.includes(grandchild.id), `the finished one is not in the tree. got: ${section}`);
      assert.ok(list.includes(grandchild.id), `history still has it. got: ${list}`);
    });

    it("a pruned parent is named, never silently dropped from the tree", async () => {
      // Retention prunes finished records. When the pruned task is the parent of
      // something still running, the child cannot be indented under a row that
      // is gone — so it names the parent it lost instead of reading as a root.
      // A root is a task whose parent nobody has stopped.
      const { h, child, grandchild } = await withDispatchTree({ options: { retainedTaskTtlMs: 1 } });
      await h.settle(child.id);
      await sleep(10);
      const list = await h.tool.task_list.execute({});
      assert.ok(list.includes("Pruned: 1"), `the prune is reported. got: ${list}`);
      const grandchildLine = lineFor(list, grandchild.id);
      assert.ok(grandchildLine.includes(`spawned by ${child.id}, not tracked`), `the severed link is named. got: ${grandchildLine}`);
      assert.ok(list.includes("Active: 1/4"), `the child is still the one running task. got: ${list}`);
    });

    it("the tree spends no host read", async () => {
      const { h } = await withDispatchTree();
      await h.tool.task_list.execute({});
      assert.strictEqual(h.client._state.statusReads, 0, "a view of records the store already holds must not read the host");
    });
  });

  it("task_status details tracked tasks and unknowns", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "status probe" });
    const detail = await c.status();
    assert.ok(detail.includes(id), `got: ${detail}`);
    assert.ok(detail.includes("explore"), `got: ${detail}`);
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    assert.ok(missing.includes("unknown"), `got: ${missing}`);
    assert.ok((await h.tool.task_status.execute({})).includes("required"));
    });
});

describe("admission dependencies", () => {
  it("refuses until deps complete, admits after", async () => {
    const { h, dep } = await withRefusedDep();

    await h.settle(dep.id);
    const admitted = await h.spawn({ description: "ready task", depends_on: [dep.id] });
    assert.ok(admitted.out.includes("in background"), `got: ${admitted.out}`);
    });

  it("names the blocking dep state, and depends_on_settled admits settled failures", async () => {
    const { h, dep } = await withRefusedDep();
    await h.fireEvent(events.error(dep.id));
    const again = await h.trySpawn({ description: "strict task", subagent_type: "explore", prompt: "hi", depends_on: [dep.id] });
    assert.ok(again.includes(`${dep.id} (error)`), `names the terminal state. got: ${again}`);

    const admitted = await h.spawn({ description: "lenient task", depends_on_settled: [dep.id] });
    assert.ok(admitted.out.includes("in background"), `settled failure satisfies. got: ${admitted.out}`);
    const status = await h.tool.task_status.execute({ session_id: admitted.id });
    assert.ok(status.includes(dep.id), `the settled wait is recorded. got: ${status}`);
    });

  it("unknown deps are treated as satisfied", async () => {
    const { h, c, out, id } = await withChild({ spawn: { description: "lone task", depends_on: ["ses_gone"] } });
    assert.ok(out.includes("in background"), `got: ${out}`); });
  });

describe("admission lineage", () => {
  it("nested spawns inherit the parent lineage", async () => {
    const h = await setupHarness({ options: { blockedAgents: [] } });
    const one = await h.spawn({ description: "parent task" });
    const two = await h.spawn({ description: "nested task", subagent_type: "general" }, { sessionID: one.id });
    assert.ok(two.out.includes("in background"), `nested spawn admitted. got: ${two.out}`);
    const status = await h.tool.task_status.execute({ session_id: two.id });
    assert.ok(status.includes("explore \u2192 general"), `parent chain visible. got: ${status}`);
    await h.tool.task_interrupt.execute({ session_id: one.id });
    });

  it("same-agent nesting is admitted only with the recursion flag", async () => {
    const strict = await setupHarness();
    const one = await strict.spawn({ description: "parent task" });
    const denied = await strict.tool.dynamic_task.execute(
    { description: "nested task", subagent_type: "explore", prompt: "hi" },
    { sessionID: one.id },
    );
    assert.ok(denied.includes("Recursive delegation blocked"), `got: ${denied}`);
    await strict.tool.task_interrupt.execute({ session_id: one.id });

    const lenient = await setupHarness({ options: { allowSameAgentRecursion: true } });
    const two = await lenient.spawn({ description: "parent task" });
    const admitted = await lenient.spawn(
    { description: "nested task", subagent_type: "explore" },
    { sessionID: two.id },
    );
    assert.ok(admitted.out.includes("in background"), `flag honored. got: ${admitted.out}`);
    await lenient.tool.task_interrupt.execute({ session_id: two.id });
    });
});

describe("prompt routing contract", () => {
  it("model override travels on the prompt, not the create call", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "model task", model: "prov/model-x" });
    await sleep(0); // the fire-and-forget prompt records one microtask later
    const created = h.client._state.sessionBodies.get(id);
    assert.ok(created && !("agent" in created) && !("model" in created), `create shape. got: ${JSON.stringify(created)}`);
    const bodies = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.ok(bodies.length >= 1, "child prompt recorded");
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.deepStrictEqual(bodies[0].body.model, { providerID: "prov", modelID: "model-x" });
    });

  it("prompts without override carry the agent and no model", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "plain task" });
    await sleep(0);
    const bodies = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.ok(bodies.length >= 1);
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.ok(!("model" in bodies[0].body), `no model key. got: ${JSON.stringify(bodies[0].body)}`);
    });

  it("child prompts carry the background-task wrapper instructions", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ prompt: "Review for bugs" });
    await sleep(0);
    const text = h.client._state.promptBodies.find((p) => p.to === id).body.parts[0].text;
    assert.ok(text.includes("background child task"), `wrapped. got: ${text}`);
    assert.ok(text.includes("task_notify"), `teaches the notify channel. got: ${text}`);
    assert.ok(text.includes("Review for bugs"), `carries the payload. got: ${text}`);
    });
});

// --- State scoping (contamination regression) -------------------------------
// Root cause of the poisoned repo ledger: persistence resolved against the
// process CWD, not the plugin's project directory. Pins: retained mutations
// write inside the directory the host provided, and the CWD is untouched.
describe("ledger follows the plugin directory, never the process cwd", () => {
  it("persists retained tasks under the provided directory only", async () => {
    const dir = tmpProjectDir();
    const cwdLedger = join(process.cwd(), ".dynamic-task-ledger.json");
    const cwdBefore = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;

    const h = await setupHarness({ hooks: {}, directory: dir });
    const { id, c } = await h.spawn({ description: "scoped" });
    await h.settle(id);
    await sleep(30); // onRetainedChange fires synchronously; sleep is for CI, not the contract.

    const ledgerFile = join(dir, ".dynamic-task-ledger.json");
    assert.ok(existsSync(ledgerFile), "ledger must be written inside the plugin directory");
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.ok(ledger.tasks?.[id], "completed task must be retained in the project ledger");

    const cwdAfter = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;
    assert.strictEqual(cwdAfter, cwdBefore, "the suite must never create or mutate the cwd ledger");
    });
});

// ─── Outcome correctness (field repro 2026-09-11T19:30:00.485Z) ─────
// A provider 429 exhausts retries and the server emits session.error (payload
// in properties.error, NO status) plus a terminal idle. The message stream
// records the failure on the assistant message's info.error. The old handler
// read only event status paths, saw "", and told the parent "completed
// successfully" with "Latest output: (completed)". These tests pin the fix.

describe("outcome correctness: failed turns never report success", () => {
  const erroredMessages = () => [
  { info: { role: "user" }, parts: [] },
  {
    info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429, isRetryable: true } } },
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
      const note = (await h.noticeAfter(terminal(id))).message;
      assert.ok(note.includes("ended with an error"), `must report error. got: ${note}`);
      if (detail) assert.ok(note.includes(detail), `must carry provider detail. got: ${note}`);
      assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);
      assert.ok((await c.status()).includes("error"), `state settles error. got: ${await c.status()}`);
    });
  }

  it("session.error event notifies error even when hydration finds nothing", async () => {
    const h = await setupHarness({ hooks: { messages: () => [] } });
    const { id, c } = await h.spawn({ description: "err evt" });
    const note = (await h.noticeAfter(
      events.error(id, { name: "APIError", data: { message: "Too Many Requests" } }),
    )).message;
    assert.ok(note.includes("ended with an error"), `got: ${note}`);
    });

  it("a burst of terminal events notifies the parent exactly once", async () => {
    const h = await setupHarness({ hooks: { messages: erroredMessages } });
    const { id, c } = await h.spawn({ description: "burst" });
    // The field log showed three terminal events within 1ms for one failure.
    await Promise.all([
    h.fireEvent(events.error(id)),
    h.fireEvent(events.status(id)),
    h.fireEvent(events.idle(id, {})),
    ]);
    await sleep(30);

    assert.strictEqual(h.notices().length, 1, "single winner must notify once");
    assert.ok(h.noticeBodies()[0].includes("ended with an error"));
    });



  it("a revived turn is never suppressed by its predecessor's late retry", async () => {
    // The poisoning window: turn 1's delivery fails attempt 1, the operator
    // continues before the 250ms retry resolves, and the retry then succeeds —
    // an in-flight commit from the old generation must not reserve the key
    // that turn 2's settlement needs.
    const { h, id } = await reviveAfterFailedDelivery();
    await sleep(350); // the stale retry lands and commits while the revival is live
    await h.settle(id);
    await assertBothTurnsDelivered(h);
    });

  it("turns settle in claim order — a stale retry never jumps a new turn", async () => {
    // Same harness, opposite timing: the revival lands BEFORE the retry
    // resolves, so serialization — not generations — carries the order.
    const { h, id } = await reviveAfterFailedDelivery();
    await h.settle(id);
    await sleep(600);
    await assertBothTurnsDelivered(h);
    });

  it("concurrent interrupts converge on interrupted, never stuck-active", async () => {
    const h = await setupHarness();
    const { release } = h.client.gateAbort({ fails: true });
    const { id, c } = await h.spawn();
    const p1 = c.interrupt();
    await sleep(10);
    const r2 = await c.interrupt();
    release();
    await p1;
    assert.ok(!r2.includes("not a tracked task"), `second interrupt sees the tracked task. got: ${r2}`);
    const status = await c.status();
    assert.ok(status.includes("interrupted"), `converges interrupted. got: ${status}`);
    });

  it("boot restore honors the configured retention cap", async () => {
    const directory = tmpProjectDir();
    const now = Date.now();
    const tasks = {};
    for (let i = 1; i <= 4; i++) {
      tasks[`ses_boot${i}`] = {
        childSessionId: `ses_boot${i}`, parentSessionId: "p", agentName: "explore",
        description: "d", lineage: [], state: "completed", startedAt: now - 1000, retainedAt: now - i,
      };
    }
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({ version: 3, tasks, pending: [] }));
    await withEnv("DYNAMIC_TASK_RETAINED_MAX_ENTRIES", "2", async () => {
      const h = await setupHarness({ hooks: {}, directory });
      const list = await h.tool.task_list.execute({});
      assert.ok(list.includes("Retained: 2"), `configured cap honored. got: ${list}`);
    });
    });

  it("clean completions still report success unchanged", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "clean" });
    const note = await h.settledNotice(id);
    assert.ok(note.includes("completed successfully"), `got: ${note}`);
    assert.ok(note.includes("COMPLETED_OK"), `carries assistant text. got: ${note}`);
    });

  it("a deleted session settles as error, never as success", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "deleted child" });
    const note = (await h.noticeAfter(events.deleted(id))).message;
    assert.ok(note.includes("ended with an error"), `deletion is a failure. got: ${note}`);
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);
    });
});

// ─── Durable delivery (docs/tasks/11-durability.md, M2) ──────────────────
// The hole this closes: the plugin settled a task and THEN dialed the parent, so
// a crash in between left a `completed` record with no notice and no evidence one
// was owed. The debt is written before the dial now, which makes a crash cost a
// duplicate notice — visible, and the direction the spec takes deliberately.
describe("boot redelivers what the last boot owed", () => {
  const owedLedger = (directory, owed) =>
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({
      version: 3,
      tasks: {
        ses_owed: {
          childSessionId: "ses_owed", parentSessionId: "ses_parent", agentName: "general",
          description: "owed", lineage: [], state: "completed", startedAt: 1, retainedAt: 2,
        },
      },
      pending: owed,
    }));

  const owed = (overrides = {}) => ({
    parentSessionId: "ses_parent", childSessionId: "ses_owed", kind: "completed",
    text: "[dynamic-task-notify]\nsession ses_owed owed this", attempts: 1, ...overrides,
  });

  // Every case here is the same world with one debt in it, so the world is built
  // once: a project directory carrying an owed notice, and a plugin booted on it.
  const bootWithOwed = async (owedEntries, hooks = {}) => {
    const directory = tmpProjectDir();
    owedLedger(directory, owedEntries);
    const harness = await setupHarness({ hooks, directory });
    return { directory, ...harness };
  };

  const onDisk = (directory) => {
    try {
      return JSON.parse(readFileSync(join(directory, ".dynamic-task-ledger.json"), "utf8"));
    } catch {
      return null;
    }
  };
  // Boot does not block on redelivery (a held parent must not delay every tool
  // by the write bound), so the observable is waited on — never a sleep standing
  // in for a contract.
  const until = async (predicate, what) => {
    for (let tries = 0; tries < 300; tries++) {
      if (predicate()) return;
      await sleep(1);
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  it("an owed notice is delivered once at boot and retired from disk", async () => {
    const { directory, notices } = await bootWithOwed([owed()]);

    assert.deepStrictEqual(
      notices().map((n) => [n.to, n.message.includes("owed this")]),
      [["ses_parent", true]],
      "exactly the owed write, to the parent it was addressed to",
    );
    await until(() => {
      const ledger = onDisk(directory);
      return Array.isArray(ledger?.pending) && ledger.pending.length === 0;
    }, "the debt to be retired once the parent answered");
  });

  it("a redelivery the host still holds is not retried here — it waits for the next boot", async () => {
    // A held write re-arms its own debt inside the gate, so the queue is not
    // empty afterwards: what must not happen is a SECOND dial in this boot. (The
    // retry itself belongs to a refused write, covered where the transport can
    // refuse: notify.test.js scripts the rejection.) The wait is on the DIAL,
    // not on the queue — the restored ledger already holds the entry, so the
    // queue cannot tell "not yet redelivered" from "redelivered and held".
    const { directory, client } = await bootWithOwed([owed()], { notifyTransport: { hang: new Promise(() => {}) } });
    await until(() => client._state.notifyCalls.length > 0, "the redelivery to dial");
    assert.strictEqual(client._state.notifyCalls.length, 1, "one dial, then the host holds it");
    assert.strictEqual(onDisk(directory).pending.length, 1, "the unanswered write is owed again");
  });

  it("a v2 ledger boots clean rather than half-restored", async () => {
    const directory = tmpProjectDir();
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({ version: 2, tasks: {} }));
    const h = await setupHarness({ hooks: {}, directory });
    assert.deepStrictEqual(h.notices(), [], "nothing to redeliver from a past this build cannot read");
    assert.strictEqual(onDisk(directory).version, 2, "and no debt invented from it — the file is untouched");
  });
});

// ─── Durable active set (docs/tasks/11-durability.md, M1) ────────────────
// The hole this closes: a child still running when the parent stopped had no
// record anywhere, so its terminal event found nothing to settle and dropped —
// it burned tokens and reported nothing. The running set is on disk now, and the
// next boot makes exactly one liveness read per restored task to decide what
// happened to it. No clocks, no polling: the host's own status words are the
// answer, and each cell below is a different set of words.
describe("boot reconciles what the last boot was still running", () => {
  const runningLedger = (directory, actives) =>
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({
      version: 3, tasks: {}, active: actives, pending: [],
    }));

  const running = (childSessionId, overrides = {}) => ({
    childSessionId, parentSessionId: "ses_parent", agentName: "general",
    description: "running across restart", lineage: [], state: "active", startedAt: 1, ...overrides,
  });

  const bootWithRunners = async (actives, hostStatusSeed) => {
    const directory = tmpProjectDir();
    runningLedger(directory, actives);
    const harness = await setupHarness({ hooks: { hostStatusSeed }, directory });
    return { directory, ...harness };
  };

  const ledgerActive = (directory) => JSON.parse(readFileSync(join(directory, ".dynamic-task-ledger.json"), "utf8")).active;
  const untilSettled = async (notices, what) => {
    for (let tries = 0; tries < 300; tries++) {
      if (notices().length > 0) return;
      await sleep(1);
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  it("a child the host is still working stays active and settles on its own event", async () => {
    const h = await bootWithRunners({ ses_live: running("ses_live") }, { ses_live: "busy" });
    const status = await h.tool.task_status.execute({ session_id: "ses_live" }, { sessionID: "ses_parent" });
    assert.match(status, /State: active/, "still running is still active");
    assert.deepStrictEqual(h.noticeBodies(), [], "no notice for a task that is not over");

    const notice = await h.settledNotice("ses_live");
    assert.match(notice, /completed successfully/, "its genuine terminal event settles it, once");
  });

  it("a child the host no longer lists settles error, saying it vanished across the restart", async () => {
    const { directory, notices } = await bootWithRunners({ ses_gone: running("ses_gone") }, {});
    await untilSettled(notices, "the vanished child to settle");
    const [notice] = notices();
    assert.strictEqual(notice.to, "ses_parent", "delivered to the parent it was spawned for");
    assert.match(notice.message, /ended with an error/);
    assert.match(notice.message, /vanish/i, "the parent is told it vanished, not that its work failed");
    assert.match(notice.message, /restart/i, "and when the loss of contact happened");
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [], "nothing is left pretending to run");
  });

  it("a child that finished while the parent was down settles completed, not error", async () => {
    // The host says the turn is over and the transcript still reads: this is
    // finished work, and settling it error would invent a failure nobody saw.
    const { notices } = await bootWithRunners({ ses_idle: running("ses_idle") }, { ses_idle: "idle" });
    await untilSettled(notices, "the finished child to settle");
    assert.match(notices()[0].message, /completed successfully/);
    assert.doesNotMatch(notices()[0].message, /ended with an error/);
  });

  it("a spawned task is on disk while it runs, and gone from the active set once it settles", async () => {
    const directory = tmpProjectDir();
    const h = await setupHarness({ hooks: {}, directory });
    const { id } = await h.spawn({ description: "durable active" });
    await sleep(30); // the spawn observer writes synchronously; the sleep is for CI, not the contract.
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [id], "a running child is durable");

    await h.settle(id);
    await sleep(30);
    assert.deepStrictEqual(ledgerActive(directory), {}, "and stops being a running task the moment it settles");
  });
});

describe("spawn resilience: no untracked child survives a failure", () => {
  it("a concurrency rejection leaves no orphan session behind", async () => {
    const h = await setupHarness({ options: { maxConcurrent: 1 } });
    const first = await h.spawn({ description: "one" });
    const before = new Set(h.client._state.sessions);

    const second = await h.trySpawn({ description: "two", subagent_type: "explore", prompt: "hi" });
    assert.ok(/cannot run more than|cannot register|concurrency|limit/i.test(second), `must reject. got: ${second}`);

    // Orphan-free invariant: any session the rejection created must be
    // aborted. (A pre-create check that never creates also passes.)
    const created = [...h.client._state.sessions].filter((id) => !before.has(id));
    for (const id of created) {
      assert.ok(h.client._state.aborted.includes(id), `orphan ${id} must be aborted`);
      }
    });

  it("task_interrupt reports the server 404 without lingering active state", async () => {
    const h = await setupHarness({ hooks: { abortFailIds: new Set(["ses_mock_1"]) } });
    const { id, c } = await h.spawn({ description: "ghost" });
    const res = await c.interrupt();
    assert.ok(/not found/i.test(res), `reports the server 404. got: ${res}`);

    const status = await c.status();
    assert.ok(status.includes("interrupted"), `settled as intended. got: ${status}`);
    });

  it("a sync-throwing prompt failure settles the task out of active", async () => {
    const hooks = { promptSyncThrowIds: new Set(["ses_mock_1"]) };
    const h = await setupHarness({ hooks: hooks });
    // The spawn line still returns — create succeeded; the prompt throws
    // synchronously inside the fire-and-forget path, which owns the settle.
    const { out } = await h.spawn({ description: "sync fail" });
    assert.ok(out.includes("in background"), `spawn reports success first. got: ${out}`);
    await sleep(50);
    const status = await h.tool.task_status.execute({ session_id: "ses_mock_1" });
    assert.ok(!/\[active\]|state: active|Status: active/.test(status), `must not linger active. got: ${status}`);
    assert.ok(status.includes("error"), `settled as error. got: ${status}`);
    });
});
