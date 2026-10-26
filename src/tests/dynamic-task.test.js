/**
 * dynamic_task — the spawn tool, end to end against the real plugin.
 *
 * Every refusal a dispatch can get, the two gates in front of it (dependencies and
 * lineage), what the prompt actually carries, and the promise the tool makes:
 * return immediately, create nothing it cannot keep, and leave no orphan behind.
 */

import { createIntentKey, intentPrefix } from "../../dist/shared/create-intent.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { abortWasRequestedFor, announcedAbout, answerOmits, answerSays, assert, assertNoticeCount, confirmationFor, describe, dispatchArgs, eventHarness, events, failEdge, harnessThrowingPrompt, it, PARENT, promptsTo, promptTextsTo, refusedOnOneEdge, refusedOverEdges, sessionBody, sessionCount, setupHarness, sleep, statusSays, wasAborted, withChild, withRefusedSecondSpawn, withSingleSlot } from "./support/index.js";

/**
 * A create that made a session and then refused to say so, by either door.
 *
 * Both orphans below are the same claim about the host — it DID create the session, so
 * there is a running child nobody can name — reached through a different failure. Spelled
 * twice it was a clone, and the copy is what drifted: the second test inherited the first
 * test's assertions and added none of its own.
 */
async function orphanCreatedButUnnamed(description, hooks) {
  const h = await setupHarness({ hooks });
  const out = await h.trySpawn({ description, prompt: "hi", subagent_type: "explore" });
  assert.strictEqual(sessionCount(h.client), 1, "the host DID create a session, so the orphan is real");
  return { h, out };
}

describe("dynamic_task validation", () => {

  it("rejects missing subagent_type with the available list", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", prompt: "hi" });
    answerSays(out, "No subagent_type");
    answerSays(out, "Explore", "lists agents by label");
    });

  it("rejects unknown agents", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "task t", prompt: "hi", subagent_type: "nope" });
    answerSays(out, 'Agent "nope" not found');
    });

  it("rejects missing and oversized prompts", async () => {
    const h = await setupHarness();
    answerSays(await h.trySpawn({ description: "task t", subagent_type: "explore" }), "Invalid prompt");
    const overlong = "x".repeat(100001);
    answerSays(await h.trySpawn({ description: "task t", prompt: overlong, subagent_type: "explore" }), "Prompt too long");
    });

  it("rejects bare model ids at admission, before creating a session", async () => {
    const h = await setupHarness();
    const before = sessionCount(h.client);
    const out = await h.trySpawn({ description: "task t", model: "GLM-5.3-Flash", prompt: "hi", subagent_type: "explore" });
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
    answerSays(out, "@General", "the confirmation names the label");
  });

  it("rejects overlong descriptions at admission", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({ description: "x".repeat(3000), prompt: "hi", subagent_type: "explore" });
    answerSays(out, "Description too long", "labels stay short");
    });

  it("rejects blocked agents when the operator configures the blocklist", async () => {
    const h = await setupHarness({ options: { blockedAgents: ["general"] } });
    const out = await h.trySpawn({ description: "task t", prompt: "hi", subagent_type: "general" });
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

  // One refusal, two facts. A create the host REFUSED never produced a session, so
  // there was no id, nothing to abort and no history to preserve — reporting it in
  // the voice of a session lost after create invents three events that did not happen.
  it("does not claim a session existed when the create itself was refused", async () => {
    const refusing = await setupHarness({ hooks: { createRefusedMissing: true } });
    const out = await refusing.tool.dynamic_task.execute(dispatchArgs("task t"), { sessionID: "p1" });
    answerSays(out, "ERROR");
    answerSays(out, "not found on the server");
    for (const claim of ["the new session", "after create", "aborted", "history preserved"]) {
      answerOmits(out, claim, "the create was refused, so none of that happened");
    }
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
    const { out } = await orphanCreatedButUnnamed("unnamed child", { createReturnsIdless: true });
    answerSays(out, "unnamed child", "the title is how the parent finds the session nobody reported");
    answerSays(out, "p1", "and the parent it was created under, which is how a session list is filtered");
    answerSays(out, "may exist", "without claiming a session the host may never have made");
    answerSays(out, "stop it by hand", "and saying what the parent can still do about it");
    });

  // The SAME orphan, reached by the other door. A create bound that fires has already
  // handed the request over, so the session exists and the plugin holds no id for it —
  // and this used to throw a bare `Error`, which the parent reads as "the command
  // failed" and answers by dispatching again. That is a second session per retry.
  //
  // So the refusal has to say three things: that the host WAS sent the create, that a
  // re-run can leave two, and where the lookup is. Asserted separately because a single
  // OR over them would pass on any one of the three — which is exactly what the old
  // coverage did, and why this shape shipped untested.
  it("a create the host never answers says it may have landed, and names the record that proves it", async () => {
    const { h, out } = await orphanCreatedButUnnamed("hung child", { createHangsAfterCreate: true });
    answerSays(out, "did not answer", "the request was sent and never confirmed — not a refused command");
    answerSays(out, "may exist", "and the session may be running with nothing tracking it");
    answerSays(out, "can leave two", "because a parent told this failed can be trusted to try again");
    answerSays(out, intentPrefix(h.directory), "and the record that says which creates are still outstanding");

    // The refusal must not read as a clean failure, because that is what invites the
    // retry: nothing here may claim nothing happened.
    assert.ok(!/ERROR: Failed to create session\. Response: null/.test(out) || /did not answer/.test(out),
      "the expiry must not be reported as a plain unanswered create with no phase");
    });

  // The record is the whole point: a lookup after the fact has to be able to answer
  // whether a create is outstanding, or it is a log line rather than a mechanism. And
  // the lookup goes through `createIntentKey` because the key is HASHED — so "search by
  // title" is a computation, not a scan, and a test that grepped the raw keys would be
  // asserting something the plugin cannot do.
  it("an issued-but-unanswered create is addressable by the key the caller computes", async () => {
    const h = await setupHarness({ hooks: { createHangsAfterCreate: true } });
    await h.trySpawn({ description: "recorded child", prompt: "hi", subagent_type: "explore" });

    const key = createIntentKey({ parentSessionId: PARENT, title: "recorded child" }, h.directory);
    // The host's table, not a reader over a FRESH store: the plugin's write chain is
    // sealed inside its own store, so `settled()` here would wait an empty queue and
    // report a drop that has not left it. What a restart reads is this table.
    await sleep(20);
    const found = h.kv.get(key);
    assert.ok(found !== undefined, `the outstanding create is at its computed key; saw ${JSON.stringify([...h.kv.keys()])}`);
    assert.ok(!found?.toString().includes("undefined"), "and the key resolved from real parts, not a stringified hole");
    assert.deepStrictEqual(JSON.parse(found), { parentSessionId: PARENT, title: "recorded child" },
      "and the record carries the two facts that identify the session nobody is tracking");
    });

  // The other half of the binary: a create that ANSWERED leaves nothing behind. A record
  // that outlived its window would be a second place the child lives, and the lookup
  // would start answering "outstanding" for dispatches that are already tracked.
  it("a create that answered leaves no record, so the lookup has a binary answer", async () => {
    const h = await setupHarness();
    await h.trySpawn({ description: "settled child", prompt: "hi", subagent_type: "explore" });

    await sleep(20);
    const intents = [...h.kv.keys()].filter((key) => key.startsWith(`${intentPrefix(h.directory)}/`));
    assert.deepStrictEqual(intents, [], "a tracked child is the ledger's to name, and only the ledger names it");
    });

  // The non-blocking promise, falsifiable: a hung child prompt must not
  // hold the spawn call. No clock can rescue this — there is no clock.
  it("returns immediately even while the child prompt never settles", async () => {
    const hooks = { promptHangIds: new Set() };
    const h = await setupHarness({ hooks });
    hooks.promptHangIds.add("ses_mock_1");
    const { out, id } = await h.spawn();
    answerSays(out, "in background");
    assert.ok(id, "session id returned synchronously with the spawn line");
    await assertNoticeCount(h, 0, "nothing settles without an event");
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
    depends_on: [dep.id], description: "blocked task", prompt: "hi", subagent_type: "explore",
  });
  answerSays(refused, "Dependencies pending");
  answerSays(refused, dep.id, "names the dep");
  await ended(h, dep);
  return { dep, h, refused };
}

describe("admission dependencies", () => {
  it("refuses until deps complete, admits after", async () => {
    const { h, dep } = await withRefusedDep();
    const admitted = await h.spawn({ depends_on: [dep.id], description: "ready task" });
    assert.ok(admitted.out.includes("in background"), `got: ${admitted.out}`);
    });

  it("names the blocking dep state, and depends_on_settled admits settled failures", async () => {
    const { h, dep } = await withRefusedDep((harness, d) => harness.fireEvent(events.error(d.id)));
    const again = await h.trySpawn({ depends_on: [dep.id], description: "strict task", prompt: "hi", subagent_type: "explore" });
    answerSays(again, `${dep.id} (error)`, "names the terminal state");

    const admitted = await h.spawn({ depends_on_settled: [dep.id], description: "lenient task" });
    assert.ok(admitted.out.includes("in background"), `settled failure satisfies. got: ${admitted.out}`);
    const status = await h.tool.task_status.execute({ session_id: admitted.id });
    answerSays(status, dep.id, "the settled wait is recorded");
    });

  it("unknown deps are treated as satisfied", async () => {
    const { out } = await withChild({ spawn: { depends_on: ["ses_gone"], description: "lone task" } });
    answerSays(out, "in background");
  });
});

/** The scenario, ready to observe: a fresh parent, one running edge, one refused dispatch. */
async function refusedDispatchScenario(kind) {
  const h = await setupHarness();
  return { edge: await refusedOnOneEdge(h, "consume the edge", kind), h };
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
    answerSays(status, "Explore → General", "the chain reads in labels");
    await h.tool.task_interrupt.execute({ session_id: one.id });
    });

  it("same-agent nesting is admitted only with the recursion flag", async () => {
    const strict = await setupHarness();
    const one = await strict.spawn({ description: "parent task" });
    const denied = await strict.tool.dynamic_task.execute(
    { description: "nested task", prompt: "hi", subagent_type: "explore" },
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
    assert.deepStrictEqual(h.client.testState.routed.get(id), { agent: "explore", modelID: "model-x", providerID: "prov" });
    });

  it("prompts without override route the agent and no model", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "plain task" });
    await sleep(0);
    const bodies = promptsTo(h.client, id);
    assert.ok(bodies.length >= 1);
    assert.deepStrictEqual(h.client.testState.routed.get(id), { agent: "explore" });
    });

  it("child prompts carry the background-task wrapper instructions", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ prompt: "Review for bugs" });
    await sleep(0);
    const [text] = promptTextsTo(h.client, id);
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
