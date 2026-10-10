/**
 * The model ladder through a whole dispatch: what the host was asked to switch the
 * child's session to, and what the record says about it.
 *
 * `model-choice.test.js` proves the ladder's ORDER. This proves the dispatch is where
 * the ladder is asked -- that a configured layer reaches the routing, that an inherited
 * one is read from the dispatching parent's own session, and that the record holds what
 * was resolved rather than what was merely requested.
 */

import { resetAgentCache } from "../../dist/shared/admission.js";
import { assert, describe, it, PARENT, setupHarness, sleep } from "./support/index.js";

const GLOBAL = { modelID: "global-model", providerID: "global-provider" };
const OWN = { modelID: "own-model", providerID: "own-provider" };
const PARENT_MODEL = { id: "parent-model", providerID: "parent-provider" };

/** What the host was asked to run the child on, from its own routing table. */
const routedModelOf = (h, id) => h.client.testState.routed.get(id);

/**
 * The record the dispatch registered, read through the ledger the plugin itself writes.
 *
 * A restart's own answer rather than a map the store holds: the durable reader is what a
 * fresh process would load, so a record asserted here is one that survives the boot.
 */
const recordOf = async (h, id) => {
  const ledger = await h.readLedger();
  const found = [...ledger.active.values(), ...ledger.retained.values()].find((entry) => entry.childSessionId === id);
  assert.ok(found, `the child must be in the ledger, got ${ledger.active.size} active and ${ledger.retained.size} retained`);
  return found;
};

/**
 * A dispatch whose parent is running a model of its own.
 *
 * The parent's model is set through the host's own `switchModel`, which its projector
 * writes onto the session row -- so the inheritance layer reads a model the host really
 * holds rather than one a fixture invented beside it.
 */
async function withParentModel(hooks = {}, options = {}) {
  const h = await setupHarness({ hooks, options });
  h.client.testState.sessions.add(PARENT);
  await h.setSessionModel(PARENT, PARENT_MODEL);
  return h;
}

/**
 * One dispatch, run to its routing: the host's routed model and the record the plugin
 * wrote. Every ladder case is this shape with a different parent, settings and spawn.
 */
async function dispatchFor(parentOptions, spawn, { parent = true } = {}) {
  resetAgentCache();
  const h = parent ? await withParentModel({}, parentOptions) : await setupHarness({});
  const { out, id } = await h.spawn(spawn);
  await sleep(0);
  return { h, id, out, record: await recordOf(h, id), routed: routedModelOf(h, id) };
}

/** The confirmation line the spawning turn is told back, for a dispatch with these settings. */
async function confirmationOf(parentOptions, { parent = true } = {}) {
  const { out } = await dispatchFor(parentOptions, { description: "confirm", prompt: "hi", subagent_type: "explore" }, { parent });
  return out;
}

/** A dispatch with the host's session-read count taken before it, for the no-read claims. */
async function readsBefore(parentOptions, spawn) {
  resetAgentCache();
  const h = await withParentModel({}, parentOptions);
  const before = h.client.testState.presenceReads;
  await h.spawn(spawn);
  await sleep(0);
  return { before, h };
}

describe("the ladder, asked at the dispatch boundary", () => {
  it("layer 4: the dispatch's own model beats the agent's and the global one", async () => {
    const { routed, record } = await dispatchFor({ agents: { explore: { model: OWN } }, model: GLOBAL }, { description: "explicit", model: "given/given-model", prompt: "hi", subagent_type: "explore" });
    assert.deepEqual(routed, { agent: "explore", modelID: "given-model", providerID: "given" },
      "the host was told the ARGUMENT's model, not either configured one");
    assert.deepEqual(record.requestedModel, { modelID: "given-model", providerID: "given" }, "and the record holds exactly that");
  });

  it("layer 3: the agent's own model beats the global one and the parent's", async () => {
    const { routed, record } = await dispatchFor({ agents: { explore: { model: OWN } }, model: GLOBAL }, { description: "own", prompt: "hi", subagent_type: "explore" });
    assert.deepEqual(routed, { agent: "explore", ...OWN }, "the agent's own model is what the host was told");
    assert.deepEqual(record.requestedModel, OWN, "and the record holds it");
  });

  it("layer 2: the global model answers an agent with none of its own", async () => {
    const { routed, record } = await dispatchFor({ model: GLOBAL }, { description: "global", prompt: "hi", subagent_type: "general" });
    assert.deepEqual(routed, { agent: "general", ...GLOBAL }, "the global model reaches every agent that states none");
    assert.deepEqual(record.requestedModel, GLOBAL, "and the record holds it");
  });

  it("layer 2 does not apply to an agent that states one of its own", async () => {
    const { routed } = await dispatchFor({ agents: { explore: { model: OWN } }, model: GLOBAL }, { description: "other agent", prompt: "hi", subagent_type: "general" });
    assert.deepEqual(routed, { agent: "general", ...GLOBAL }, "a DIFFERENT agent's setting is not the fleet's setting");
  });

  it("layer 1: with nothing stated, the dispatching parent's own model is inherited", async () => {
    const { routed, record } = await dispatchFor({}, { description: "inherit", prompt: "hi", subagent_type: "explore" });
    assert.deepEqual(routed, { agent: "explore", modelID: "parent-model", providerID: "parent-provider" },
      "the child is switched onto the model its parent is itself running");
    assert.deepEqual(record.requestedModel, { modelID: "parent-model", providerID: "parent-provider" },
      "and the SNAPSHOT is on the record, so a later switch by the parent does not retroactively change this child");
  });

  it("layer 1 is read per dispatch, so a nested dispatch inherits what its parent was switched onto", async () => {
    // The child's own session carries the switch made for it, so a grandchild inherits
    // the child's model rather than the root's -- which is the whole difference between
    // a live read and a snapshot taken at boot.
    resetAgentCache();
    const h = await withParentModel();
    const child = await h.spawn({ description: "child", prompt: "hi", subagent_type: "explore" });
    await sleep(0);
    await h.setSessionModel(child.id, { id: "child-model", providerID: "child-provider" });
    const grandchild = h.child(child.id, { description: "grandchild", prompt: "hi", subagent_type: "explore" });
    await sleep(0);
    assert.deepEqual(routedModelOf(h, grandchild.id), { agent: "explore", modelID: "child-model", providerID: "child-provider" },
      "the grandchild inherits the model its parent was switched onto");
  });

  it("a configured layer spends no host call at all", async () => {
    // The whole argument for the thunk: inheritance is a wire read, so a layer that can
    // answer without it must not pay for it. A dispatch that read the parent's session
    // anyway would spend one bounded call per spawn on an answer already held.
    const { h, before } = await readsBefore({ agents: { explore: { model: OWN } } }, { description: "no read", prompt: "hi", subagent_type: "explore" });
    assert.equal(h.client.testState.presenceReads, before, "no session read was made for a model already configured");
  });

  it("an unreadable parent costs the child the inheritance and nothing else", async () => {
    // The parent is gone: the host's own not-found. The dispatch must still succeed,
    // because an inheritance that can refuse a dispatch is a default that can fail.
    const { out, routed, record } = await dispatchFor({}, { description: "orphan parent", prompt: "hi", subagent_type: "explore" }, { parent: false });
    assert.match(out, /Spawned @Explore/, "the dispatch succeeded with no parent to inherit from");
    assert.equal(routed.modelID, undefined, "and no model was routed -- the host default answers");
    assert.equal(record.requestedModel, undefined, "with nothing on the record to contradict it");
  });

  it("the confirmation names the RESOLVED model, not only a requested one", async () => {
    // The parent reads this line to know what its child is running. Under layer 2 that is
    // a fact it never stated and could not otherwise see, so the configured model has to
    // be the one printed.
    const out = await confirmationOf({ model: GLOBAL });
    assert.match(out, /Model: global-provider\/global-model/, "the global model, spelled the way it is typed");
  });

  it("a dispatch with no model anywhere still says the default", async () => {
    const out = await confirmationOf({}, { parent: false });
    assert.match(out, /Model: \(default\)/, "unchanged from before the feature");
  });
});
