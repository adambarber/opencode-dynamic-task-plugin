/**
 * dynamic_task — the spawn tool, end to end against the real plugin.
 *
 * Every refusal a dispatch can get, the two gates in front of it (dependencies and
 * lineage), what the prompt actually carries, and the promise the tool makes:
 * return immediately, create nothing it cannot keep, and leave no orphan behind.
 */

import { describe, it } from "./support/runner.js";
import assert from "node:assert";
import { abortWasRequestedFor, confirmationFor, promptTextsTo, promptsTo, sessionBody, sessionCount, setupHarness, sleep, wasAborted, withChild } from "./support/harness.js";
import { withRefusedSecondSpawn } from "./support/stop-scenarios.js";
import { events } from "./support/mock-host.js";
import { answerOmits, answerSays, assertNoticeCount, statusSays } from "./support/assertions.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { dispatchArgs, eventHarness, harnessThrowingPrompt, withSingleSlot } from "./support/integration.js";
import {
  announcedAbout,
  failEdge,
  refusedOnOneEdge,
  refusedOverEdges,
} from "./support/dispatch-wait-scenario.js";

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
    const before = sessionCount(h.client);
    const out = await h.trySpawn({ description: "task t", subagent_type: "explore", prompt: "hi", model: "GLM-5.3-Flash" });
    answerSays(out, "Invalid model");
    answerSays(out, "providerID/modelID", "names the shape");
    answerSays(out, "GLM-5.3-Flash", "names the suspect");
    assert.strictEqual(sessionCount(h.client), before, "no session created for a bad id");
    });

  it("echoes a qualified model in the spawn confirmation", async () => {
    const { out } = await withChild({ spawn: { model: "nvidia/z-ai/glm-5.3" } });
    answerSays(out, "Model: nvidia/z-ai/glm-5.3");
  });

  it("admits any agent by default — general dispatches", async () => {
    const { out } = await withChild({ spawn: { subagent_type: "general" } });
    answerSays(out, "@general");
  });

  it("rejects overlong descriptions at admission", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "x".repeat(3000), subagent_type: "explore", prompt: "hi" });
    answerSays(out, "Description too long", "labels stay short");
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
    answerSays(second, "ConcurrencyLimitExceeded", "the refusal is the limit, in its own words");
    answerSays(second, 'agent "explore"', "and names the agent that is full, so the operator knows which knob to raise");
    answerSays(second, "1 active task", "singular for a cap of one — a slot count is read by a person");
    answerSays(second, "task_list", "points at the slot holders");
    });

  it("surfaces session.create failures", async () => {
    const failing = await setupHarness({ hooks: { createThrowsOnce: true } });
    const out = await failing.tool.dynamic_task.execute(dispatchArgs("task t"), { sessionID: "p1" });
    answerSays(out, "ERROR");
    answerSays(out, "create failed");
    });

  // The one post-create failure the plugin cannot clean up. `session.abort` needs
  // an id; an unnameable session cannot be aborted, registered, notified, listed
  // or settled, and it is left running on the server. The response says "create
  // failed" and stops there — which reads as "nothing happened", so the parent
  // never learns there is a child of its own running unmonitored.
  //
  // The message therefore carries the two facts that make it findable, the title
  // it was created under and the parent it was created for, and admits the
  // session may not exist at all: a host that fails the create outright can
  // answer just as unparseably. Asserted in both directions, because a message
  // that only says "I cannot clean this up" leaves the parent with nothing to
  // act on, and one that only names the title is a guess when there is a parent.
  it("a create response with no session id reports the orphan it cannot clean up", async () => {
    const h = await setupHarness({ hooks: { createReturnsIdless: true } });
    const out = await h.trySpawn({ description: "unnamed child", subagent_type: "explore", prompt: "hi" });

    assert.strictEqual(sessionCount(h.client), 1, "the host DID create a session, so the orphan is real");
    answerSays(out, "unnamed child", "the title is how the parent finds the session nobody reported");
    answerSays(out, "p1", "and the parent it was created under, which is how a session list is filtered");
    answerSays(out, "may exist", "without claiming a session the host may never have made");
    answerSays(out, "stop it by hand", "and saying what the parent can still do about it");
    });

  // The non-blocking promise, falsifiable: a hung child prompt must not
  // hold the spawn call. No clock can rescue this — there is no clock.
  it("returns immediately even while the child prompt never settles", async () => {
    const hooks = { promptHangIds: new Set() };
    const h = await setupHarness({ hooks: hooks });
    hooks.promptHangIds.add("ses_mock_1");
    const { out, id } = await h.spawn();
    answerSays(out, "in background");
    assert.ok(id, "session id returned synchronously with the spawn line");
    assertNoticeCount(h, 0, "nothing settles without an event");
    });
});

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
    const { out } = await withChild({ spawn: { description: "lone task", depends_on: ["ses_gone"] } });
    answerSays(out, "in background");
  });
});

/** The scenario, ready to observe: a fresh parent, one running edge, one refused dispatch. */
async function refusedDispatchScenario(kind) {
  const h = await setupHarness();
  return { h, edge: await refusedOnOneEdge(h, "consume the edge", kind) };
}

// A refused depends_on was advice in a string and nothing else. The plugin
// forgot the dispatch, so the parent had to carry the wait in prose, be alive
// when the dependency settled, and re-dispatch from memory. Every one of those
// is the parent's context, which is exactly what the plugin exists to hold.
describe("dependency waits are state, not prose the parent must remember", () => {
  it("a refused dispatch is remembered and announced the moment its edge clears", async () => {
    const { h, edge } = await refusedDispatchScenario();
    const hint = await announcedAbout(h, "consume the edge", () => h.settle(edge.id));
    assert.strictEqual(hint.to, "p1", `and it goes to the parent that asked. got: ${hint.to}`);
    assert.match(hint.message, /can go now/i, "in words that ask for the action");
  });

  // The edge can never satisfy a strict depends_on again — it will not run
  // again. Announcing nothing would leave the parent waiting on a task that
  // is gone; announcing it as ready would hand it a dispatch whose gate
  // refuses, which reads as the plugin contradicting itself.
  it("a wait whose edge settled short of completed is announced as dead, not as ready", async () => {
    const { h, edge } = await refusedDispatchScenario();
    const hint = await announcedAbout(h, "consume the edge", () => failEdge(h, edge.id));
    assert.match(hint.message, /never run/i, "named as unrunnable");
    answerOmits(hint.message, "can go now", "never announced as ready");
  });

  it("a wait with an edge still running is not announced, and it resolves on the LAST edge", async () => {
    const h = await setupHarness();
    const [one, two] = await refusedOverEdges(h, "consume both", 2);

    await announcedAbout(h, "consume both", () => h.settle(one.id), 0);
    await announcedAbout(h, "consume both", () => h.settle(two.id));
  });

  // The release predicate requires EVERY dependency to be ready, so the honest
  // sentence to a parent is one: all of them cleared. The message used to vary
  // singular or plural on the number of RELEASED DISPATCHES, which is not what
  // it describes — a single dispatch waiting on three edges was told "the
  // dependency has completed", and a live smoke-test agent could not tell from
  // that whether one edge had cleared or three.
  it("a dispatch waiting on several edges is told they all cleared, not that one did", async () => {
    const h = await setupHarness();
    const edges = await refusedOverEdges(h, "consume all three", 3);
    for (const edge of edges.slice(0, -1)) await h.settle(edge.id);

    const hint = await announcedAbout(h, "consume all three", () => h.settle(edges.at(-1).id));
    answerOmits(hint.message, "the dependency has completed", "one dispatch is not one dependency");
    answerSays(hint.message, "everything it waited on has completed", "and the true shape of the release is stated");
  });

  // depends_on_settled waits for any terminal state, so a failed edge still
  // releases it — the wait is about the gate's readiness, not about success.
  it("a wait cleared by settlement only, and announced exactly once", async () => {
    const { h, edge } = await refusedDispatchScenario("settled");
    const released = await announcedAbout(h, "consume the edge", () => failEdge(h, edge.id));
    assert.match(released.message, /can go now/i, "a settled edge is enough");

    // The wait is gone from the store when it is announced, so a later turn on
    // an unrelated task has nothing left to say about it.
    await announcedAbout(h, "consume the edge", async () => {
      const other = await h.spawn({ description: "unrelated work" });
      await h.settle(other.id);
    }, 0);
  });
});

describe("admission lineage", () => {
  it("nested spawns inherit the parent lineage", async () => {
    const h = await setupHarness({ options: { blockedAgents: [] } });
    const one = await h.spawn({ description: "parent task" });
    const two = await h.spawn({ description: "nested task", subagent_type: "general" }, { sessionID: one.id });
    assert.ok(two.out.includes("in background"), `nested spawn admitted. got: ${two.out}`);
    const status = await h.tool.task_status.execute({ session_id: two.id });
    answerSays(status, "explore → general", "parent chain visible");
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
  it("model override travels on the switch calls, not the create call", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "model task", model: "prov/model-x" });
    await sleep(0); // the fire-and-forget prompt records one microtask later
    const created = sessionBody(h.client, id);
    assert.ok(created && !("agent" in created) && !("model" in created), `create shape. got: ${JSON.stringify(created)}`);
    const bodies = promptsTo(h.client, id);
    assert.ok(bodies.length >= 1, "child prompt recorded");
    assert.deepStrictEqual(h.client._state.routed.get(id), { agent: "explore", providerID: "prov", modelID: "model-x" });
    });

  it("prompts without override route the agent and no model", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "plain task" });
    await sleep(0);
    const bodies = promptsTo(h.client, id);
    assert.ok(bodies.length >= 1);
    assert.deepStrictEqual(h.client._state.routed.get(id), { agent: "explore" });
    });

  it("child prompts carry the background-task wrapper instructions", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ prompt: "Review for bugs" });
    await sleep(0);
    const text = promptTextsTo(h.client, id)[0];
    answerSays(text, "background child task", "wrapped");
    answerSays(text, NOTIFY_TOOL, "teaches the notify channel");
    answerSays(text, "Review for bugs", "carries the payload");
    });
});

describe("spawn resilience: no untracked child survives a failure", () => {
  it("a concurrency rejection leaves no orphan session behind", async () => {
    const { h, second, created } = await withRefusedSecondSpawn();
    assert.ok(/cannot run more than|cannot register|concurrency|limit/i.test(second), `must reject. got: ${second}`);

    // Orphan-free invariant, on the REQUEST and not on the host's obedience: a
    // pre-create check that never creates also passes this.
    for (const id of created) {
      assert.ok(abortWasRequestedFor(h.client, id), `orphan ${id} must be asked to abort`);
      assert.ok(wasAborted(h.client, id), `orphan ${id} must be aborted`);
      }
    });

  it("task_interrupt reports the server 404 without lingering active state", async () => {
    const h = await eventHarness({ abortFailIds: new Set(["ses_mock_1"]) });
    const { c } = await h.spawn({ description: "ghost" });
    const res = await c.interrupt();
    assert.ok(/not found/i.test(res), `reports the server 404. got: ${res}`);

    await statusSays(c, "interrupted", "settled as intended");
    });

  it("a sync-throwing prompt failure settles the task out of active", async () => {
    const h = await harnessThrowingPrompt("ses_mock_1");
    // The spawn line still returns — create succeeded; the prompt throws
    // synchronously inside the fire-and-forget path, which owns the settle.
    const out = await confirmationFor(h, "sync fail");
    answerSays(out, "in background", "spawn reports success first");
    await sleep(50);
    const status = await h.tool.task_status.execute({ session_id: "ses_mock_1" });
    assert.ok(!/\[active\]|state: active|Status: active/.test(status), `must not linger active. got: ${status}`);
    answerSays(status, "error", "settled as error");
    });
});
