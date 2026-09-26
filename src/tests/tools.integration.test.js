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
  deferred, events, setupHarness, setupTwoTurnHarness, sleep, tmpProjectDir, withAskedChild,
  withLoggedChild,
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
 * A steer that will lose a race to an interrupt, and the report it hands back.
 * The steps are always the same — boot a child, park the steer's abort at the
 * gate, interrupt first, then let the steer land behind the winner — and two
 * cases were spelling them out, which is how a case ends up racing something
 * other than a settlement.
 */
async function steerLosingToInterrupt(gateOpts) {
  const { h, c, id } = await withChild();
  const { release } = h.client.gateAbort(gateOpts);
  const steer = c.steer("pivot");
  await sleep(10);
  await c.interrupt();
  release();
  return { h, c, id, out: await steer };
}

/**
 * A spawned dep, a strict depender's refusal while it lived, and how the dep
 * then ends. The dependency gate is two rules — depends_on and
 * depends_on_settled — and each test exercises one; the live-dep precondition,
 * the refusal it produces, and the ending that makes the dep stop being live
 * are one arrangement, so they are named once and a case declares only its end.
 */
async function withRefusedDep(ended = (h, dep) => h.settle(dep.id)) {
  const h = await setupHarness();
  const dep = await h.spawn({ description: "dep task" });
  const refused = await h.trySpawn({
    description: "blocked task", subagent_type: "explore", prompt: "hi", depends_on: [dep.id],
  });
  answerSays(refused, "Dependencies pending");
  answerSays(refused, dep.id, "names the dep");
  await ended(h, dep);
  return { h, dep, refused };
}

/**
 * Arm a turn replacement, then deliver bare terminal copies — endings with no
 * turn behind them, which is exactly what a just-replaced turn's in-flight
 * copies look like. A replacement that has been seen working for nothing yet
 * owns no ending, so none of them may settle it — and the one notice the parent
 * should end up with is the replacement's own ending, once it has run.
 */
async function echoesCannotSettle(h, c, id, arm) {
  const before = h.notices().length;
  await arm();
  await h.fireEvent(events.idle(id));
  await h.fireEvent(events.idle(id));
  assert.strictEqual(await stateOf(c), "State: active", "an echo is not the replacement turn's ending");
  assert.strictEqual(h.notices().length, before, "no premature completion is notified");
  await h.fireEvent(events.working(id));
  const note = await h.settledNotice(id);
  answerSays(note, "completed successfully", "the eventual ending is still a settlement");
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
/**
 * Assert that the gate settled a question by rejecting it exactly once, and
 * return the recorded host call.
 *
 * It asserts; it does not fire. Firing is the caller's job, through
 * `withAskedChild` or a hand-built event for the cases a plain ask cannot express
 * (a settled child, a multi-part ask) — so the one assertion every refusal needs
 * lives in one place and a new caller cannot quietly skip it.
 *
 * It no longer returns a rejection REASON: the host's reject endpoint takes no
 * body, so there is no channel from the gate to the asking session, and a reason
 * asserted on the wire would be asserting something the contract makes
 * impossible. The reason is asserted where it lands instead — the operator's
 * block claim, or the debug log.
 */
function assertQuestionRejected(h) {
  const calls = h.questionCalls();
  assert.strictEqual(calls.length, 1, "one rejection, never a silent stall");
  assert.strictEqual(calls[0].method, "reject");
  return calls[0];
}

/**
 * The state line and nothing else. The status view also names the last
 * notification's kind, which is history, so a substring over the whole report
 * cannot tell a state claim from a mention of one. One reader, because every
 * settlement test asks the same question of the same view.
 */
const stateOf = async (child) =>
  (await child.status()).split("\n").find((line) => line.startsWith("State: ")) ?? "(no state line)";

/**
 * One dispatch's tool input, for the raw `dynamic_task.execute` calls that
 * cannot go through a spawn helper. The argument shape IS the tool's contract,
 * and it was spelled out by hand at every one of these sites — so a required
 * field could be missing from the very case testing its neighbour.
 */
const dispatchArgs = (description, over = {}) => ({ description, subagent_type: "explore", prompt: "hi", ...over });

/** A harness that admits exactly one child, so the second dispatch is the case. */
const withSingleSlot = () => setupHarness({ options: { maxConcurrent: 1 } });

/**
 * A fresh project directory, and the clock its records are aged against. The
 * durability cases write timestamps relative to a reading, so the directory and
 * the reading are one arrangement rather than two independent choices — and a
 * case that picks them apart is measuring nothing.
 */
const projectWithClock = () => ({ directory: tmpProjectDir(), now: Date.now() });

/**
 * What a tool's answer says. Every assertion in this file is a claim about the
 * prose a tool returned — a gate's refusal, a record's verdict, a settlement's
 * wording — and the answer is the only evidence there is, so it rides in the
 * failure: a red case must show what the tool actually said, not that some word
 * was missing from it. `note` is the case's own claim on top of the reason.
 */
function answerSays(answer, reason, note) {
  assert.ok(answer.includes(reason), `${note ? `${note}. ` : ""}got: ${answer}`);
}
/**
 * The durable reader's input, written as given. The file name and the version
 * are the reader's contract, not a case's business — and four cases were each
 * spelling out all three, which is four chances to write a document the boot
 * quietly ignores.
 */
const writeLedger = (directory, document) =>
  writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({ version: 3, ...document }));

/**
 * Wait for an observable, and fail rather than hang. The bound is the only clock
 * in a poll: boot does not block on what it redelivers, so a case that has to
 * see a later effect waits for the effect — never sleeps in its place — and the
 * bound is what turns "never arrives" into a failure.
 */
async function waitFor(predicate, what) {
  for (let tries = 0; tries < 300; tries++) {
    if (predicate()) return;
    await sleep(1);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// --- Tests -----------------------------------------------------------------

describe("dynamic_task validation", () => {

  it("rejects missing subagent_type with the available list", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", prompt: "hi" });
    answerSays(out, "No subagent_type");
    answerSays(out, "explore", "lists agents");
    });

  it("rejects unknown agents", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", subagent_type: "nope", prompt: "hi" });
    answerSays(out, 'Agent "nope" not found');
    });

  it("rejects missing and oversized prompts", async () => {
    const h = await setupHarness();
    answerSays(await h.trySpawn({ description: "task t", subagent_type: "explore" }), "Invalid prompt");
    const overlong = "x".repeat(100001);
    answerSays(await h.trySpawn({ description: "task t", subagent_type: "explore", prompt: overlong }), "Prompt too long");
    });

  it("rejects bare model ids at admission, before creating a session", async () => {
    const h = await setupHarness();
    const before = h.client._state.sessions.size;
    const out = await h.trySpawn({ description: "task t", subagent_type: "explore", prompt: "hi", model: "GLM-5.3-Flash" });
    answerSays(out, "Invalid model");
    answerSays(out, "providerID/modelID", "names the shape");
    answerSays(out, "GLM-5.3-Flash", "names the suspect");
    assert.strictEqual(h.client._state.sessions.size, before, "no session created for a bad id");
    });

  it("echoes a qualified model in the spawn confirmation", async () => {
    const { h, c, out, id } = await withChild({ spawn: { model: "nvidia/z-ai/glm-5.3" } });
    answerSays(out, "Model: nvidia/z-ai/glm-5.3");
  });

  it("admits any agent by default — general dispatches", async () => {
    const { h, c, out, id } = await withChild({ spawn: { subagent_type: "general" } });
    answerSays(out, "@general");
  });

  it("rejects overlong descriptions at admission", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "x".repeat(3000), subagent_type: "explore", prompt: "hi" });
    answerSays(out, "Description too long", "labels stay short");
    });

  it("task_list names pruned expiries", async () => {
    const { h, c, id } = await withSettledChild({ harness: { options: { retainedTaskTtlMs: 1 } } });
    await sleep(5);
    const list = await h.tool.task_list.execute({});
    answerSays(list, "Pruned: 1 expired", "expiry is visible");
  });

  it("rejects blocked agents when the operator configures the blocklist", async () => {
    const h = await setupHarness({ options: { blockedAgents: ["general"] } });
    const out = await h.trySpawn({ description: "task t", subagent_type: "general", prompt: "hi" });
    answerSays(out, "blocked");
    });

  it("rejects over the concurrency limit", async () => {
    const limited = await withSingleSlot();
    const first = await limited.spawn({ description: "task one" });
    assert.ok(first.out.includes("in background"), `first must spawn. got: ${first.out}`);

    const second = await limited.tool.dynamic_task.execute(dispatchArgs("task two"), { sessionID: "p1" });
    answerSays(second, "Cannot run more than");
    answerSays(second, "task_list", "points at the slot holders");
    });

  it("surfaces session.create failures", async () => {
    const failing = await setupHarness({ hooks: { createThrowsOnce: true } });
    const out = await failing.tool.dynamic_task.execute(dispatchArgs("task t"), { sessionID: "p1" });
    answerSays(out, "ERROR");
    answerSays(out, "create failed");
    });

  it("returns immediately even while the child prompt never settles", async () => {
    // The non-blocking promise, falsifiable: a hung child prompt must not
    // hold the spawn call. No clock can rescue this — there is no clock.
    const hooks = { promptHangIds: new Set() };
    const h = await setupHarness({ hooks: hooks });
    hooks.promptHangIds.add("ses_mock_1");
    const { out, id } = await h.spawn();
    answerSays(out, "in background");
    assert.ok(id, "session id returned synchronously with the spawn line");
    assert.strictEqual(h.notices().length, 0, "nothing settles without an event");
    });
});

describe("task_continue branches", () => {

  it("rejects missing args and oversized prompts", async () => {
    const h = await setupHarness();
    assert.ok((await h.tool.task_continue.execute({})).includes("required"));
    const overlong = "x".repeat(100001);
    const long = await h.tool.task_continue.execute({ session_id: "ses_mock_1", prompt: overlong });
    answerSays(long, "Prompt too long");
    });

  it("steers a still-running task — the turn stops and the message becomes the next turn", async () => {
    const { h, c, id } = await withChild();
    const out = await c.steer("follow up");
    answerSays(out, "Steer sent");
    answerSays(out, "task_interrupt", "names the stall recovery");
    assert.ok(h.client._state.aborted.includes(id), "the running turn is stopped first");
    const followUps = h.client._state.promptBodies.filter(
    (p) => p.to === id && p.body.parts[0].text.includes("follow up"),
    );
    assert.strictEqual(followUps.length, 1, "the message becomes the next turn");
    assert.ok(
    followUps[0].body.parts[0].text.includes("[Parent steer"),
    `framed as a preemption. got: ${followUps[0].body.parts[0].text}`,
    );
    assert.strictEqual(await stateOf(c), "State: active", "a steer never settles");
  });

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
      answerSays(status, "active", "a non-terminal signal must not settle");
      assert.strictEqual(ctx.h.notices().length, 0, "nothing is notified");
      const note = await ctx.h.settledNotice(ctx.id);
      answerSays(note, "completed successfully", "the real event still settles");
    });
  }

  // A turn end is published more than once: the host's status channel and the
  // idle event each say the turn ended. The one-shot steer claim consumed the
  // FIRST of them, so the second settled the replacement turn as completed
  // while the child was still working — a "completed successfully" notice with
  // mid-work text as the latest output, and a ledger deaf to the real ending.
  it("a turn end that publishes several terminal events cannot settle a just-steered turn", async () => {
    const { h, c, id } = await withChild();
    await echoesCannotSettle(h, c, id, () => c.steer("pivot"));
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
      answerSays(out, "revived", "closes the loop in one call");
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
    const { h, out } = await steerLosingToInterrupt();
    answerSays(out, "interrupted", "truthful report");
    assert.ok(!out.includes("Steer sent"), `must not claim a steer that never happened. got: ${out}`);
    assert.strictEqual(
    h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
    0,
    "no replacement prompt fires on a settled task",
    );
    });

  it("a steer racing a concurrent settlement reports the winner truthfully", async () => {
    const { h, out } = await steerLosingToInterrupt({ fails: true });
    answerSays(out, "interrupted", "reports the actual winner");
    assert.ok(!out.includes("settled as error"), `no false error claim. got: ${out}`);
    assert.strictEqual(
    h.notices().filter((n) => n.message.includes("Steer failed")).length,
    0,
    "no second notice over the winner's outcome",
    );
    });

  it("steer on a vanished session settles error instead of stranding", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortFailIds: new Set(["ses_mock_1"]) } } });
    answerSays(await c.steer("pivot"), "not found");
    assert.strictEqual(await stateOf(c), "State: error", "settled error, never stranded active");
  });

  it("a failed steer abort stays active and sends nothing", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.steer("pivot");
    answerSays(out, "abort failed", "reports the gap");
    answerSays(out, "active", "admits the child may be live");
    assert.strictEqual(
    h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
    0,
    "no competing prompt races the live turn",
    );
    assert.strictEqual(await stateOf(c), "State: active", "stays settable");
    await h.settle(id);
    assert.strictEqual(h.notices().length, 1, "the live turn still settles");
  });

  it("revives a settled task and the new turn settles again", async () => {
    const { h, c, id } = await withSettledChild();
    assert.strictEqual(h.notices().length, 1, "first turn settles");

    const out = await c.steer("summarize");
    answerSays(out, "Follow-up sent");
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
    assert.ok(h.noticeBodies()[1].includes("completed successfully"));
  });

  it("a late echo from the turn a revival replaced cannot settle the revival", async () => {
    const { h, c, id } = await withSettledChild();
    await echoesCannotSettle(h, c, id, () => c.steer("continue"));
  });

  it("interrupted children are not revived — the guidance says spawn fresh", async () => {
    const { h, c, id } = await withChild();
    await c.interrupt();
    const out = await c.steer("again");
    answerSays(out, "not revived");
    answerSays(out, "dynamic_task", "points at the fresh-spawn path");
  });

  it("a revived turn does not wear the previous turn's notification", async () => {
    const { h, c, id } = await withSettledChild();
    await sleep(10);
    await c.steer("again");
    const status = await c.status();
    assert.ok(!status.includes("Last notification"), `new turn, nothing reported yet. got: ${status}`);
    const summary = await c.result();
    assert.ok(!summary.includes("Last notification"), `same for result reads. got: ${summary}`);
  });

  it("reviving with a model override reroutes and persists it", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ model: "nvidia/z-ai/glm-5.3" });
    await h.settle(id);
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "again", model: "other/thing-1" });
    answerSays(out, "Follow-up sent");
    const routed = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.deepStrictEqual(routed[routed.length - 1].body.model, { providerID: "other", modelID: "thing-1" });
    const status = await c.status();
    answerSays(status, "Model: other/thing-1", "persists on the record");
    });

  it("a bare model on continue fails without touching the task", async () => {
    const { h, c, id } = await withSettledChild();
    const before = h.client._state.promptBodies.length;
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "again", model: "bare-id" });
    answerSays(out, "Invalid model");
    assert.strictEqual(h.client._state.promptBodies.length, before, "no prompt fires");
    const status = await c.status();
    answerSays(status, "completed", "still settled");
  });

  it("unknown sessions are refused as untracked", async () => {
    const h = await setupHarness();
    const out = await h.tool.task_continue.execute({
      session_id: "ses_missing",
      prompt: "hello?",
      });
    answerSays(out, "not a tracked task");
    });
});

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
    const status = await c.status();
    answerSays(status, "active", "task stays active");
    answerSays(status, "need DB credentials", "notice recorded on the task");

    await h.settle(id);
    assert.strictEqual(h.notices().length, 2, "settlement still reports");
  });

  it("distinct long notices sharing a prefix both deliver", async () => {
    const { h, c, id } = await withChild();
    const first = await c.notify("a".repeat(200) + "1");
    const second = await c.notify("a".repeat(200) + "2");
    answerSays(first, "Message sent to parent");
    answerSays(second, "Message sent to parent", "prefix collision must not suppress");
    assert.strictEqual(h.notices().length, 2);
  });

  // One hypothesis: a repeat of an identical notice never redelivers, and the
  // child is told both that and what to do instead.
  it("a suppressed duplicate says to say something new", async () => {
    const { h, c, id } = await withChild();
    await c.notify("still working");
    const again = await c.notify("still working");
    answerSays(again, "duplicate suppressed", "keeps the kind");
    answerSays(again, "Say something new", "tells the child what to do");
    assert.strictEqual(h.notices().length, 1, "the parent hears it once");
  });

  it("an unreachable parent is reported distinctly from a duplicate", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { promptFailIds: new Set(["p1"]) } } });
    const out = await c.notify("hello?");
    answerSays(out, "did not acknowledge", "names the failure");
    assert.ok(!out.includes("duplicate"), `never confuses the two. got: ${out}`);
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
    const out = await withShrunkBounds(() => c.notify("are you there?"));
    assert.strictEqual(h.notices().length, 1, "the host really did put it in the parent's context");
    assert.ok(!out.includes("not sent"), `a held write was dialed, not lost. got: ${out}`);
    assert.ok(!/retry/i.test(out), `retrying a delivered notice duplicates it. got: ${out}`);
  });


  it("a suppressed duplicate shows as Suppressed in task_result, never FAILED", async () => {
    const { h, c, id } = await withChild();
    await c.notify("status: compiling");
    await c.notify("status: compiling");
    const summary = await c.result();
    assert.ok(
    summary.includes("Suppressed (duplicate — already delivered)"),
    `the duplicate must read as suppression. got: ${summary}`,
    );
    assert.ok(!summary.includes("FAILED"), `suppression is not a delivery failure. got: ${summary}`);
  });

  it("refuses untracked callers and settled tasks", async () => {
    const { h, c } = await withSettledChild();
    answerSays(await h.tool.task_notify.execute({ message: "hi" }, { sessionID: "ses_stranger" }), "Not a tracked task");
    answerSays(await c.notify("too late"), "the task already settled");
    });

  it("validates message shape and length", async () => {
    const { h, c, id } = await withChild();
    assert.ok((await c.notify("  ")).includes("required"));
    const long = await c.notify("x".repeat(4001));
    answerSays(long, "too long");
  });
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
    answerSays(note, "transient", "names the failure class");
    answerSays(note, "task_continue", "points at resume");
    });

  it("fatal error settlements carry no resume hint", async () => {
    const note = await settleWithMessageError("permission denied for model");
    answerSays(note, "permission denied", "keeps the cause");
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
    answerSays(summary, "Status: unknown");
    assert.ok(summary.startsWith("## Task Result"), `one format for all reads. got: ${summary}`);
    });

  it("task_result maps a failed read to error state", async () => {
    // The read that fails is the one the tool actually makes. A transport
    // failure is reported as an error status, never as a quiet success.
    const failing = await setupHarness({ hooks: { messages: () => { throw new Error("boom"); } } });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: error");
    answerSays(summary, "boom", "the cause rides along");
    });

  it("a tracked task whose read fails still reports the store's own state", async () => {
    const summary = await resultForUnreadableChild();
    answerSays(summary, "Status: active", "the store is the authority");
    answerSays(summary, "(API unavailable)", "the failed read says so");
    assert.ok(!summary.includes("Server status"), `no reading, no liveness block. got: ${summary}`);
  });

  it("a status channel that cannot be asked renders the record without a diagnosis", async () => {
    // Absence of a reading is not evidence of anything. The record renders; the
    // stall line may fire on the plugin's own clock, but nothing claims to know
    // what turn the server is on.
    const { c } = await withChild({ harness: { hooks: { statusThrows: new Error("status down") } } });
    const status = await c.status();
    answerSays(status, "State: active");
    answerSays(status, "Last plugin event:", "the plugin's own clock still reads");
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
      answerSays(summary, expected, "no invention");
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
    answerSays(summary, "Status: unknown");
    assert.ok(!summary.includes("Server status"), `nothing was learned. got: ${summary}`);
  });

  it("a retryable transport failure says so", async () => {
    const refused = await setupHarness({ hooks: { messages: () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    } } });
    const summary = await refused.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: error");
    answerSays(summary, "(retryable)", "a refused connection is worth retrying");
  });

  it("interrupt on a settled task reports the settled state, not a fresh interrupt", async () => {
    const { h, c, id } = await withSettledChild();
    const done = await c.interrupt();
    answerSays(done, "already settled as completed", "truthful report");
    assert.ok(!/^Session .* interrupted\.$/.test(done), `must not claim a fresh interrupt. got: ${done}`);
    assert.strictEqual(await stateOf(c), "State: completed", "history untouched");
  });

  it("task_interrupt settles as interrupted, preserves history, and reaches the API", async () => {
    const { h, c, id } = await withChild();
    const done = await c.interrupt();
    answerSays(done, "interrupted");
    assert.ok(h.client._state.aborted.includes(id), "abort must reach the API");
    // P1a contract: the record survives (history preserved) and no event can
    // re-settle it — the synchronous claim happened BEFORE the abort.
    assert.strictEqual(await stateOf(c), "State: interrupted", "history preserved");
    await h.settle(id);
    assert.strictEqual(h.notices().length, 0, "the abort's own idle event must not notify");
  });

  it("task_interrupt requires a session id and names missing sessions", async () => {
    const h = await setupHarness();
    assert.ok((await h.tool.task_interrupt.execute({})).includes("required"));
    const missing = await setupHarness({ hooks: { abortFailIds: new Set(["ses_ghost"]) } });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    answerSays(out, "not found");
    });

  it("a failed abort leaves a live task active — the natural event still settles it", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.interrupt();
    answerSays(out, "abort failed", "reports the abort gap");
    answerSays(out, "active", "admits the child may be live");
    const status = await c.status();
    answerSays(status, "active", "speculative claim withdrawn");
    // The child's genuine terminal event still settles and notifies.
    await h.settle(id);
    assert.strictEqual(h.notices().length, 1, "natural completion delivers");
    assert.ok(h.noticeBodies()[0].includes("completed successfully"));
  });

  it("a failed abort on a settled task records the gap without disturbing history", async () => {
    const { h, c, out } = await withBrokenAbortSettledChild();
    answerSays(out, "already settled as completed");
    answerSays(out, "ECONNREFUSED", "gap recorded in the report");
    const status = await c.status();
    answerSays(status, "completed");
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
    const { directory, now } = projectWithClock();
    writeLedger(directory, {
      pending: [],
      tasks: {
        ses_blocked1: {
          childSessionId: "ses_blocked1", parentSessionId: "p1", agentName: "explore",
          description: "waiting on the key", lineage: ["explore"], state: "blocked",
          startedAt: now - 5000, retainedAt: now - 100,
        },
      },
    });
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
      answerSays(out, member.id, "the report names ${member.id}");
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
    answerSays(out, "everything", "the rejected value is quoted back");
    answerSays(out, "subtree", "the choices are named");
    assert.ok((await stateOf(h, grandchild.id)).includes("active"), "nothing was stopped");
  });

  it("a settled descendant is not named: there was nothing to stop there", async () => {
    const { h, child, grandchild } = await withSettledDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    assert.ok(!out.includes(grandchild.id), `the finished child is not re-aborted. got: ${out}`);
    answerSays(out, child.id, "the task the caller named is still answered");
  });

  it("a settled task still has a live child below it, and the child is stopped", async () => {
    // The walk starts at the named session whatever state it is in, so a
    // finished parent is not a wall: the grandchild it left running is exactly
    // the work an interrupt is for, and reporting only "already settled" would
    // hand back a clean answer over work that is still spending tokens.
    const { h, child, grandchild } = await withDispatchTree();
    await h.settle(child.id);
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    answerSays(out, "already settled as completed", "the root's own truth");
    answerSays(out, grandchild.id, "the live child below it is named");
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
    answerSays(out, "notification: disabled");
    await h.settle(id);
    const summary = await c.result();
    assert.match(summary, /FAILED|delivered: false|no parent/, `deafness must be distinguishable from silence. got: ${summary}`);
    });

  it("post-create registration failure notifies instead of stranding error", async () => {
    // Same-tick race through the advisory check: both spawns see an empty
    // slot, both create, the loser hits the authoritative register gate.
    const h = await withSingleSlot();
    const [r1, r2] = await Promise.all([
    h.tool.dynamic_task.execute(dispatchArgs("racer one"), { sessionID: "p1" }),
    h.tool.dynamic_task.execute(dispatchArgs("racer two"), { sessionID: "p1" }),
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
    answerSays(note, "ended with an error", "error kind");
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
    answerSays(summary, "error", "task must be retained as error");
    // The lifecycle event that follows must not double-settle.
    await failing.settle(id);
    assert.strictEqual(notes.length, 1, "exactly-once survives a late idle");
    });

  it("repeated terminal events notify exactly once", async () => {
    const { h, c, id } = await withSettledChild();
    await h.settle(id);
    await h.fireEvent(events.status(id));
    assert.strictEqual(h.notices().length, 1, "one settled turn, one notice");
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
  it("an active child with options is answered, at the host's own route and shape", async () => {
    // Two claims, one subject: that the event the host ACTUALLY publishes
    // reaches the gate at all, and that what it answers with is the shape the
    // host accepts. Both used to be two tests, which is why they drifted — and
    // the drift is the defect class: a gate that answers on a shape the host
    // rejects looks identical to one that works, right up until a live child
    // waits forever. `question.asked` is the spelling; /question/{requestID} and
    // one entry per asked question are the contract.
    const { h } = await withAskedChild("q1", "yes", "no");
    const calls = h.questionCalls();
    assert.strictEqual(calls.length, 1, "question.asked must reach the gate — it is the spelling the host publishes");
    assert.deepStrictEqual(
      calls[0],
      { method: "reply", requestID: "q1", answers: [["yes"]] },
      "the first option is the answer, addressed at /question/{requestID}/reply",
    );
    assert.strictEqual(h.notices().length, 0, "an answered question is not a block");
  });

  it("a question the gate cannot answer is rejected, and the claim is the parent's to act on", async () => {
    // Nothing to answer with means reject, not silence. The reject endpoint
    // declares `body?: never` and returns a bare boolean, so a reason has no
    // channel from this gate to the asking session — the promise this gate used to
    // make, that the reason is the child's only description of what it can do
    // next, was undeliverable by the very mechanism claiming it, and misaddressed
    // besides: it told the READER (the parent) to call task_notify, a child-only
    // tool. So the claim reaches the operator through the last-notice line, and
    // must LEAD with the parent's remedy — that line truncates at 120 chars, and
    // a diagnosis-first message told the operator what happened and not what to do.
    const { h, c } = await withAskedChild("q2");
    const call = assertQuestionRejected(h);
    assert.strictEqual(call.requestID, "q2", "refused at the host's own route");
    const claim = await c.status();
    assert.match(claim, /Last notice/, `the refusal is recorded for the operator. got: ${claim}`);
    assert.match(claim, /task_continue/, `names the tool the PARENT holds. got: ${claim}`);
    assert.doesNotMatch(claim, /task_notify/, `never tells the parent to use a child-only tool. got: ${claim}`);
    assert.ok(!/when it resumes/.test(claim), `never tells anyone to wait. got: ${claim}`);
  });

  it("unmatched question events are left untouched (fail-closed scoping)", async () => {
    const h = await setupHarness();
    await h.fireEvent(events.questionAsked(undefined, { id: "q1", questions: [] }));
    await h.fireEvent(events.ask("ses_stranger", "q9", "yes"));
    await h.fireEvent(events.questionReplied({ requestID: "q1" }));
    assert.strictEqual(h.notices().length, 0, "no parent traffic for questions");
    assert.strictEqual(h.questionCalls().length, 0, "never touches foreign questions");
  });

  it("a multi-part ask is rejected, never half-answered", async () => {
    // `answers` is one entry per asked question, so the gate can satisfy a
    // single-part ask and nothing else. Answering the first part of a two-part
    // ask would retire the question with the child never having seen the second
    // answer — a silent loss wearing a success, which is the exact failure the
    // question gate exists to prevent. So a multi-part ask is a rejection.
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

  it("a question the gate could not answer is a block the settlement must not report as a success", async () => {
    // The gate is the plugin BLOCKING the child: it refused the question, so it
    // knows the child cannot finish on that point — it knows more than the child
    // recorded. If the child does not itself call task_notify, the settlement read
    // nothing and reported the block as a success — the same false success,
    // arriving through a different door. The gate is the second source of the
    // claim, and it must reach the same funnel.
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

  it("a settled child's question is rejected, and the reason is recorded where it can be read", async () => {
    // A settled child cannot answer its own question and its answer would be
    // worthless anyway, so the question is closed. The guidance cannot ride the
    // rejection (no body), so it is asserted in the log — the operator's copy.
    await withLoggedChild({}, async ({ h, id, c, log }) => {
      await h.fireEvent(events.ask(id, "q3", "yes"));
      assertQuestionRejected(h);
      const text = log();
      assert.match(text, /question-retained-rejected/, `the settlement is logged as one. got: ${text}`);
      assert.match(text, /settled/i, `and it says the task is settled. got: ${text}`);
      await c.interrupt();
    });
  });

  it("a failed retained rejection is logged as failed, never as rejected", async () => {
    await withLoggedChild({ hooks: { questionRejectThrows: true } }, async ({ h, id, c, log }) => {
      await h.fireEvent(events.ask(id, "q9", "yes"));
      const text = log();
      answerSays(text, "question-retained-reject-failed", "failure logged");
      assert.ok(!text.includes('"eventName":"question-retained-rejected"'), `must not claim rejection. got: ${text}`);
      await c.interrupt();
    });
  });

  it("a question id already used by a tracked task cannot divert a foreign question onto it", async () => {
    // The gate used to remember which session owned which question id, and forget
    // that when a reply arrived — a cross-event correlation the host makes
    // unnecessary, because an asked question NAMES its session. A stale entry
    // would divert a later question from someone else onto a task already
    // answered. Reading the owner off the event cannot go stale.
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

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const hooks = { promptFailIds: new Set(["p1"]) };
    const h = await setupHarness({ hooks: hooks });
    const { id, c } = await h.spawn({ description: "doomed parent task" });
    await h.settle(id);
    assert.strictEqual(h.notices().length, 0, "nothing delivered");
    await sleep(600); // detached delivery runs the gate's 250ms retry cycle
    const summary = await c.result();
    answerSays(summary, "FAILED", "delivery failure surfaced");
    });

  it("a failed delivery does not consume the settlement — redelivery can succeed", async () => {
    // p1's prompt fails ONLY on the first attempt (child prompt ok, parent
    // notify attempt 1 fails, attempt 2 succeeds): the record is a history,
    // not a veto — exactly-once is about successful deliveries.
    const { h, c } = await withSettledChild({ harness: { hooks: { notifyTransport: { failTimes: 1 } } } });
    await sleep(500); // one retry cycle at the gate's fixed backoff
    assert.strictEqual(h.notices().length, 1, "the retry delivered");
    const summary = await c.result();
    answerSays(summary, "completed", "final record is a success");
    });
});

describe("task fleet views", () => {
  it("task_list shows active and retained tasks", async () => {
    const h = await setupHarness();
    const one = await h.spawn({ description: "fleet one" });
    const two = await h.spawn({ description: "fleet two" });
    await h.settle(two.id);
    const list = await h.tool.task_list.execute({});
    answerSays(list, one.id) && list.includes(two.id, "both fleets visible");
    answerSays(list, "Active: 1/4");
    answerSays(list, "Retained: 1");
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
      answerSays(list, "Active: 1/4", "one task is still running");
      const section = list.slice(0, list.indexOf("Retained:"));
      answerSays(section, child.id, "the running task is there");
      assert.ok(!section.includes(grandchild.id), `the finished one is not in the tree. got: ${section}`);
      answerSays(list, grandchild.id, "history still has it");
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
      answerSays(list, "Pruned: 1", "the prune is reported");
      const grandchildLine = lineFor(list, grandchild.id);
      answerSays(grandchildLine, `spawned by ${child.id}, not tracked`, "the severed link is named");
      answerSays(list, "Active: 1/4", "the child is still the one running task");
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
    answerSays(detail, id);
    answerSays(detail, "explore");
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    answerSays(missing, "unknown");
    assert.ok((await h.tool.task_status.execute({})).includes("required"));
    });
});

describe("admission dependencies", () => {
  it("refuses until deps complete, admits after", async () => {
    const { h, dep } = await withRefusedDep();
    const admitted = await h.spawn({ description: "ready task", depends_on: [dep.id] });
    assert.ok(admitted.out.includes("in background"), `got: ${admitted.out}`);
    });

  it("names the blocking dep state, and depends_on_settled admits settled failures", async () => {
    const { h, dep } = await withRefusedDep((harness, d) => harness.fireEvent(events.error(d.id)));
    const again = await h.trySpawn({ description: "strict task", subagent_type: "explore", prompt: "hi", depends_on: [dep.id] });
    answerSays(again, `${dep.id} (error)`, "names the terminal state");

    const admitted = await h.spawn({ description: "lenient task", depends_on_settled: [dep.id] });
    assert.ok(admitted.out.includes("in background"), `settled failure satisfies. got: ${admitted.out}`);
    const status = await h.tool.task_status.execute({ session_id: admitted.id });
    answerSays(status, dep.id, "the settled wait is recorded");
    });

  it("unknown deps are treated as satisfied", async () => {
    const { h, c, out, id } = await withChild({ spawn: { description: "lone task", depends_on: ["ses_gone"] } });
    answerSays(out, "in background");
  });
  });

describe("admission lineage", () => {
  it("nested spawns inherit the parent lineage", async () => {
    const h = await setupHarness({ options: { blockedAgents: [] } });
    const one = await h.spawn({ description: "parent task" });
    const two = await h.spawn({ description: "nested task", subagent_type: "general" }, { sessionID: one.id });
    assert.ok(two.out.includes("in background"), `nested spawn admitted. got: ${two.out}`);
    const status = await h.tool.task_status.execute({ session_id: two.id });
    answerSays(status, "explore \u2192 general", "parent chain visible");
    await h.tool.task_interrupt.execute({ session_id: one.id });
    });

  it("same-agent nesting is admitted only with the recursion flag", async () => {
    const strict = await setupHarness();
    const one = await strict.spawn({ description: "parent task" });
    const denied = await strict.tool.dynamic_task.execute(
    { description: "nested task", subagent_type: "explore", prompt: "hi" },
    { sessionID: one.id },
    );
    answerSays(denied, "Recursive delegation blocked");
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
    answerSays(text, "background child task", "wrapped");
    answerSays(text, "task_notify", "teaches the notify channel");
    answerSays(text, "Review for bugs", "carries the payload");
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
      answerSays(note, "ended with an error", "must report error");
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
    answerSays(note, "ended with an error");
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
    answerSays(status, "interrupted", "converges interrupted");
    });

  it("boot restore honors the configured retention cap", async () => {
    const { directory, now } = projectWithClock();
    const tasks = {};
    for (let i = 1; i <= 4; i++) {
      tasks[`ses_boot${i}`] = {
        childSessionId: `ses_boot${i}`, parentSessionId: "p", agentName: "explore",
        description: "d", lineage: [], state: "completed", startedAt: now - 1000, retainedAt: now - i,
      };
    }
    writeLedger(directory, { tasks });
    await withEnv("DYNAMIC_TASK_RETAINED_MAX_ENTRIES", "2", async () => {
      const h = await setupHarness({ hooks: {}, directory });
      const list = await h.tool.task_list.execute({});
      answerSays(list, "Retained: 2", "configured cap honored");
    });
    });

  it("clean completions still report success unchanged", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "clean" });
    const note = await h.settledNotice(id);
    answerSays(note, "completed successfully");
    answerSays(note, "COMPLETED_OK", "carries assistant text");
    });

  it("a deleted session settles as error, never as success", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "deleted child" });
    const note = (await h.noticeAfter(events.deleted(id))).message;
    answerSays(note, "ended with an error", "deletion is a failure");
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);
    });
});

// ─── Durable delivery (docs/tasks/11-durability.md, M2) ──────────────────
// The hole this closes: the plugin settled a task and THEN dialed the parent, so
// a crash in between left a `completed` record with no notice and no evidence one
// was owed. The debt is written before the dial now, which makes a crash cost a
// duplicate notice — visible, and the direction the spec takes deliberately.
describe("boot redelivers what the last boot owed", () => {
  const owed = (overrides = {}) => ({
    parentSessionId: "ses_parent", childSessionId: "ses_owed", kind: "completed",
    text: "[dynamic-task-notify]\nsession ses_owed owed this", attempts: 1, ...overrides,
  });

  // Every case here is the same world with one debt in it, so the world is built
  // once: a project directory carrying an owed notice, and a plugin booted on it.
  const bootWithOwed = async (owedEntries, hooks = {}) => {
    const directory = tmpProjectDir();
    writeLedger(directory, {
      tasks: {
        ses_owed: {
          childSessionId: "ses_owed", parentSessionId: "ses_parent", agentName: "general",
          description: "owed", lineage: [], state: "completed", startedAt: 1, retainedAt: 2,
        },
      },
      pending: owedEntries,
    });
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
  it("an owed notice is delivered once at boot and retired from disk", async () => {
    const { directory, notices } = await bootWithOwed([owed()]);

    assert.deepStrictEqual(
      notices().map((n) => [n.to, n.message.includes("owed this")]),
      [["ses_parent", true]],
      "exactly the owed write, to the parent it was addressed to",
    );
    await waitFor(() => {
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
    await waitFor(() => client._state.notifyCalls.length > 0, "the redelivery to dial");
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
  const running = (childSessionId, overrides = {}) => ({
    childSessionId, parentSessionId: "ses_parent", agentName: "general",
    description: "running across restart", lineage: [], state: "active", startedAt: 1, ...overrides,
  });

  const bootWithRunners = async (actives, hostStatusSeed) => {
    const directory = tmpProjectDir();
    writeLedger(directory, { tasks: {}, active: actives, pending: [] });
    const harness = await setupHarness({ hooks: { hostStatusSeed }, directory });
    return { directory, ...harness };
  };

  const ledgerActive = (directory) => JSON.parse(readFileSync(join(directory, ".dynamic-task-ledger.json"), "utf8")).active;

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
    await waitFor(() => notices().length > 0, "the vanished child to settle");
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
    await waitFor(() => notices().length > 0, "the finished child to settle");
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
    const h = await withSingleSlot();
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
    answerSays(status, "interrupted", "settled as intended");
    });

  it("a sync-throwing prompt failure settles the task out of active", async () => {
    const hooks = { promptSyncThrowIds: new Set(["ses_mock_1"]) };
    const h = await setupHarness({ hooks: hooks });
    // The spawn line still returns — create succeeded; the prompt throws
    // synchronously inside the fire-and-forget path, which owns the settle.
    const { out } = await h.spawn({ description: "sync fail" });
    answerSays(out, "in background", "spawn reports success first");
    await sleep(50);
    const status = await h.tool.task_status.execute({ session_id: "ses_mock_1" });
    assert.ok(!/\[active\]|state: active|Status: active/.test(status), `must not linger active. got: ${status}`);
    answerSays(status, "error", "settled as error");
    });
});
