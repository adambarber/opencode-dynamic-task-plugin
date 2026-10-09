/**
 * The model ladder: four layers, one order, asked in one place.
 *
 * The ladder is the whole feature, so these cases are about PRECEDENCE and nothing
 * else — which layer answers, and what happens when the layer above it says nothing.
 * Each case drives the real `resolveChildModel` with real settings and a real read
 * function, because a stubbed ladder would be a stub testing a stub.
 *
 * What is deliberately NOT here: whether the dispatch path routes the resolved pair.
 * That is `child-model.test.js`, which runs a whole dispatch and asserts what the host
 * was asked to switch the child's session to.
 */
//jscpd:ignore-start
import { assert, describe, it } from "./support/runner.js";
import {
  isModelOverride,
  modelOverrideOf,
  readModelSetting,
  resolveAgentModel,
  resolveChildModel,
  spellModel,
} from "../../dist/shared/model-choice.js";
import { agentKey } from "../../dist/shared/agent-key.js";

//jscpd:ignore-end
// The dispatching parent's own model, as the host reads it: a session row.
const PARENT_MODEL = { modelID: "glm-5.3", providerID: "z-ai" };

/** A scope with nothing stated anywhere. */
const EMPTY = { agents: {} };

/** The settings an operator states, in the two places a document can state them. */
const scope = (model, agents = {}) => ({ agents, ...(model === undefined ? {} : { model }) });

/** A settings object that counts the inheritance reads made through it. */
function countingInherit(answer = PARENT_MODEL) {
  const state = { calls: 0 };
  return {
    inherit: () => {
      state.calls += 1;
      return Promise.resolve(answer);
    },
    state,
  };
}

describe("the model ladder, layer by layer", () => {
  it("layer 4: the dispatch's own model beats everything below it", async () => {
    const inherit = countingInherit();
    const resolved = await resolveChildModel({
      agent: "explore",
      inherit: inherit.inherit,
      requested: { modelID: "explicit", providerID: "given" },
      scope: scope({ modelID: "global", providerID: "global" }, { explore: { model: { modelID: "own", providerID: "own" } } }),
    });
    assert.deepEqual(resolved, { modelID: "explicit", providerID: "given" }, "the argument wins, and the layers below are never consulted");
    assert.equal(inherit.state.calls, 0, "and the parent's own model is not read — no host call is spent on an answer already held");
  });

  it("layer 3: the agent's own setting beats the global one", async () => {
    const inherit = countingInherit();
    const resolved = await resolveChildModel({
      agent: "explore",
      inherit: inherit.inherit,
      scope: scope({ modelID: "global", providerID: "global" }, { explore: { model: { modelID: "own", providerID: "own" } } }),
    });
    assert.deepEqual(resolved, { modelID: "own", providerID: "own" }, "the agent's own model");
    assert.equal(inherit.state.calls, 0, "and inheritance is never reached");
  });

  it("layer 2: the global setting answers an agent with none of its own", async () => {
    const inherit = countingInherit();
    const resolved = await resolveChildModel({
      agent: "general",
      inherit: inherit.inherit,
      scope: scope({ modelID: "global", providerID: "global" }, { explore: { model: { modelID: "own", providerID: "own" } } }),
    });
    assert.deepEqual(resolved, { modelID: "global", providerID: "global" }, "a DIFFERENT agent's setting does not apply — the key space is the agent, not the document");
    assert.equal(inherit.state.calls, 0, "and the parent is not read");
  });

  it("layer 1: with nothing stated anywhere, the dispatching parent's own model is inherited", async () => {
    const inherit = countingInherit();
    const resolved = await resolveChildModel({ agent: "explore", inherit: inherit.inherit, scope: EMPTY });
    assert.deepEqual(resolved, PARENT_MODEL, "the parent's own model");
    assert.equal(inherit.state.calls, 1, "and it WAS read, which is the only reason this layer can be live");
  });

  it("an agent's setting is found by any spelling of its name", async () => {
    // The fold is the caps module's, and both sides of the lookup go through it: a
    // config key and a host name differ only in case, and only one side being folded is
    // how a cap an operator set applies to no agent at all.
    const resolved = await resolveChildModel({
      agent: "Explore",
      inherit: () => Promise.resolve(undefined),
      scope: scope(undefined, { explore: { model: { modelID: "own", providerID: "own" } } }),
    });
    assert.deepEqual(resolved, { modelID: "own", providerID: "own" }, "the key was folded, so the setting is found");
  });

  it("a parent with no model of its own leaves the child on the host default", async () => {
    const resolved = await resolveChildModel({ agent: "explore", inherit: () => Promise.resolve(undefined), scope: EMPTY });
    assert.equal(resolved, undefined, "no override, which is the behaviour that shipped before this feature");
  });

  it("a settings object composes the pair, so the ladder never parses one", async () => {
    // The pair is the internal type; the qualified TEXT is the document's shape. Reading
    // it at the boundary is what keeps the ladder free of a parse per dispatch.
    const resolved = await resolveChildModel({
      agent: "explore",
      inherit: () => Promise.resolve(undefined),
      scope: scope({ modelID: "glm-5.3", providerID: "z-ai" }),
    });
    assert.deepEqual(resolved, { modelID: "glm-5.3", providerID: "z-ai" });
  });
});

describe("a stated model, read out of untrusted JSON", () => {
  it("reads the qualified text a person types in a config file", () => {
    assert.deepEqual(readModelSetting("z-ai/glm-5.3"), { modelID: "glm-5.3", providerID: "z-ai" });
  });

  it("reads the pair the plugin writes", () => {
    assert.deepEqual(readModelSetting({ modelID: "glm-5.3", providerID: "z-ai" }), { modelID: "glm-5.3", providerID: "z-ai" });
  });

  it("rejects a bare model id, because it would route nowhere", () => {
    // The argument gate's own rule: the provider prefix is required, so a stated bare
    // id must be DROPPED rather than producing a pair with an empty provider.
    assert.equal(readModelSetting("glm-5.3"), undefined);
  });

  it("rejects the other ways a field can be wrong", () => {
    const bad = [
      undefined, null, 7, true, [], {}, "",
      "  ", "p/", "/m",
      { providerID: "z-ai" }, { modelID: "glm-5.3" },
      { providerID: "", modelID: "x" }, { providerID: "p", modelID: "" },
      { modelID: 5, providerID: "p" },
    ];
    for (const value of bad) {
      assert.equal(readModelSetting(value), undefined, `${JSON.stringify(value)} is not a model`);
    }
  });

  it("accepts whitespace around a qualified id", () => {
    assert.deepEqual(readModelSetting("  z-ai/glm-5.3  "), { modelID: "glm-5.3", providerID: "z-ai" });
  });

  it("spells a pair the way the argument gate and the host's catalog do", () => {
    assert.equal(spellModel({ modelID: "glm-5.3", providerID: "z-ai" }), "z-ai/glm-5.3");
  });

  it("guards over unknown input, which is what the writers ask", () => {
    assert.equal(isModelOverride("z-ai/glm-5.3"), true);
    assert.equal(isModelOverride({ modelID: "x", providerID: "p" }), true);
    assert.equal(isModelOverride("glm-5.3"), false);
    assert.equal(isModelOverride(undefined), false);
  });
});

describe("the session's own model, projected to the routing pair", () => {
  it("reads the host's session row", () => {
    // The host stores `{id, providerID, variant?}` and the plugin routes a pair, so the
    // projection happens once, here, rather than at the read site.
    const session = { id: "ses_parent", model: { id: "glm-5.3", providerID: "z-ai" } };
    assert.deepEqual(modelOverrideOf(session), { modelID: "glm-5.3", providerID: "z-ai" });
  });

  it("answers undefined for a session with no model of its own", () => {
    assert.equal(modelOverrideOf({ id: "ses_1" }), undefined, "a session that never had one set has nothing to hand down");
  });

  it("answers undefined for anything that is not a session", () => {
    const bad = [undefined, null, 7, "ses_1", [], { model: "z-ai/glm-5.3" }, { model: { id: "x" } }, { model: { providerID: "p" } }];
    for (const value of bad) {
      assert.equal(modelOverrideOf(value), undefined, `${JSON.stringify(value)} is not a session`);
    }
  });
});

describe("an agent's own setting, resolved from a scope", () => {
  it("resolves a folded key", () => {
    const stated = scope(undefined, { explore: { model: { modelID: "own", providerID: "own" } } });
    assert.deepEqual(resolveAgentModel(stated, "EXPLORE"), { modelID: "own", providerID: "own" });
  });

  it("falls back to the global setting", () => {
    assert.deepEqual(resolveAgentModel(scope({ modelID: "g", providerID: "gp" }), "explore"), { modelID: "g", providerID: "gp" });
  });

  it("answers undefined when nothing is stated", () => {
    assert.equal(resolveAgentModel(EMPTY, "explore"), undefined);
  });

  it("folds a key the same way the caps module does", () => {
    assert.equal(agentKey("  Explore  "), "explore", "the shared fold is one function, owned by neither concept");
  });
});
