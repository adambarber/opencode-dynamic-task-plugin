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
  withChild, withEnv, withSettledChild,
} from './support/harness.js';

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
 * plugin rejects it once, naming the tool that would. The rejection is the
 * contract, so it is asserted here rather than in each test that provokes it.
 */
async function assertQuestionRejectedNaming(h, event, named) {
  await h.fireEvent(event);
  const calls = h.questionCalls();
  assert.strictEqual(calls.length, 1, "one rejection, never a silent stall");
  assert.strictEqual(calls[0].method, "reject");
  assert.ok(calls[0].reason.includes(named), `must name ${named}. got: ${calls[0].reason}`);
}

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

  // M9: a settlement can still win a steer, but only one way — the replaced
  // turn's own prompt delivery failing while the steer waits on its abort. A
  // terminal event can no longer do it (turn attribution drops every ending the
  // replacement has not been seen working through), so this is the settler the
  // auto-revive actually exists for.
  it("a steer racing a prompt-delivery failure auto-revives instead of demanding a second call", async () => {
    const h = await setupHarness();
    const { release } = h.client.gateChildPrompt();
    const { id, c } = await h.spawn({ prompt: "turn one" });
    const { release: releaseAbort } = h.client.gateAbort();
    const steer = c.steer("pivot");
    await sleep(10);
    release(); // turn one's prompt fails non-retryably → the task settles error
    await sleep(30);
    releaseAbort(); // the abort lands; the steer re-validates and finds it settled
    const out = await steer;
    assert.ok(out.includes("revived"), `closes the loop in one call. got: ${out}`);
    assert.strictEqual(
    h.client._state.promptBodies.filter((p) => p.body.parts[0].text === "pivot").length,
    1,
    "the message fires as the fresh turn",
    );
  });

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

  // One hypothesis: task_result reports the STORE's state, and the live read is
  // only ever advisory — it appears while the task can still change and never
  // contradicts a settled record. Each case names the fragments that must (or
  // must not) be in the report for its state.
  const reports = [
    ["task_result reports store state for active tasks with the live read as advisory",
      withChild, [["Status: active", true], ["Live inference", true], ["task_status", true], ["Tracked: yes", true]]],
    // One default assistant message with no status field reads busy (role
    // inference needs two) — crucially never the invented "idle" the old mock
    // returned for a shape production never emits.
    ["live inference reads the message stream — production get() carries no status field",
      withChild, [["Session API suggests: busy", true], ["suggests: idle", false]]],
    ["task_result reports settled state with no advisory block",
      withSettledChild, [["Status: completed", true], ["Live inference", false]]],
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

  it("task_result maps API 404 to unknown, in the same markdown voice", async () => {
    const h = await setupHarness();
    const summary = await h.tool.task_result.execute({ session_id: "ses_gone" });
    assert.ok(summary.includes("Status: unknown"), `got: ${summary}`);
    assert.ok(summary.startsWith("## Task Result"), `one format for all reads. got: ${summary}`);
    });

  it("task_result maps transport errors to error state", async () => {
    const failing = await setupHarness({ hooks: { getThrows: Object.assign(new Error("boom"), {}) } });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes('"error"') || summary.includes("error"), `got: ${summary}`);
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

describe("question gate: child questions settle", () => {
  it("answers from an active child are auto-answered with the first option", async () => {
    const { h, c, id } = await withChild();
    await h.fireEvent(events.question(id, [{ text: "yes" }, { text: "no" }], { id: "q1" }));
    const calls = h.questionCalls();
    assert.strictEqual(calls.length, 1, "exactly one settlement");
    assert.deepStrictEqual(calls[0], { method: "reply", id: "q1", answer: "yes" });
    assert.strictEqual(h.notices().length, 0);
    await h.fireEvent(events.questionReplied({ id: "q1" })); });

  it("answerless questions are rejected with follow-up guidance", async () => {
    const { h, c, id } = await withChild();
    await assertQuestionRejectedNaming(h, events.question(id, [], { id: "q2" }), "task_continue"); });

  it("settled task questions are rejected with settled guidance", async () => {
    const { h, c, id } = await withSettledChild();
    await assertQuestionRejectedNaming(h, events.question(id, [{ text: "yes" }], { id: "q3" }), "settled"); });

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
    writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({ version: 2, tasks }));
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
