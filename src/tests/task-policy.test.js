/**
 * task-policy.ts — the pure rules about who may be dispatched, and how deep.
 *
 * No I/O and no store: a name, a lineage and a config in, a verdict out. That is
 * why the fixtures are only a config — a case here is a decision over an input,
 * so a new spelling of a refusal is a new row rather than another arrangement.
 */

import { admits, assertIs, assertNothing, refuses } from "./support/assertions.js";
import { assert, describe, it } from "./support/runner.js";
import { blockingConfig, defaultConfig } from "./support/fixtures.js";
import {
  buildTaskLineage,
  depthLimits,
  isSameAgent,
  normalizeAgentName,
  validateAgent,
  validateLineage,
} from "../../dist/shared/task-policy.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";

// type PolicyResult is type-only, imported via the functions' return types
describe("normalizeAgentName", () => {
  it("lowercases and trims agent names", () => {
    assert.strictEqual(normalizeAgentName("General"), "general");
    assert.strictEqual(normalizeAgentName("  REVIEWER "), "reviewer");
  });

  it("strips @ prefix", () => {
    assert.strictEqual(normalizeAgentName("@general"), "general");
    assert.strictEqual(normalizeAgentName("@Reviewer"), "reviewer");
  });

  it("returns null for unsupported types", () => {
    assertNothing(normalizeAgentName(null), "no name at all");
    assertNothing(normalizeAgentName(undefined), "an absent name");
    assertNothing(normalizeAgentName(123), "a name that is not a string");
    assertNothing(normalizeAgentName(""), "an empty name");
  });
});

describe("validateAgent", () => {
  const config = blockingConfig();

  // Admission is one decision over one input, so the cases are a table: a new
  // spelling of "blocked" is a new row, not a fourth copy of the same three
  // lines. The optional pattern is for the message a refusal carries — the one
  // thing an `ok: false` alone does not pin down.
  const admissions = [
    ["rejects a configured blocked agent", "general", false, /general/i],
    ["rejects @General (normalized)", "@General", false],
    ["allows non-blocked agents", "reviewer", true],
  ];
  for (const [name, agent, ok, refusedWith] of admissions) {
    it(name, () => {
      const result = validateAgent(agent, config);
      assert.strictEqual(result.ok, ok);
      if (refusedWith) assert.match(result.error, refusedWith);
    });
  }

  it("allows agents not in blockedAgents", () => {
    const customConfig = normalizeDynamicTaskConfig({ blockedAgents: ["coder"] });
    assert.strictEqual(validateAgent("reviewer", customConfig).ok, true);
    assert.strictEqual(validateAgent("coder", customConfig).ok, false);
    admits(validateAgent("general", customConfig), "general is NOT blocked here");
  });
});

describe("isSameAgent", () => {
  it("detects same agent ignoring @ prefix and case", () => {
    assert.strictEqual(isSameAgent("reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("Reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("@reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("@Reviewer", "reviewer"), true);
  });

  it("rejects different agents", () => {
    assert.strictEqual(isSameAgent("reviewer", "coder"), false);
    assertIs(isSameAgent("explore", "general"), false, "two different agents are two agents");
  });
});

describe("validateLineage", () => {
  // A depth case is about three things at once — the cap, the set of agents that
  // could actually be spent, and whether repeating one is allowed — so they are named
  // here once and each case says which it is about.
  //
  // No lane argument: `validateLineage` used to take the lane separately from the
  // cap so its refusal could name it. The cap now ARRIVES resolved from the agent
  // being dispatched, so the agent is the only name there is and passing a second one
  // was a second answer to "who is this about".
  const FOUR_AGENTS = ["general", "coder", "explore", "reviewer"];
  const depth = (lineage, child, { maxDepth = 2, agents = FOUR_AGENTS, recursion = false } = {}) =>
    validateLineage(lineage, child, { allowSameAgentRecursion: recursion, maxDepth }, agents);

  it("rejects same-agent anywhere in lineage", () => {
    const result = refuses(depth(["reviewer"], "reviewer"), "the agent is already in the lineage");
    assert.match(result.error, /recursion|same-agent|already present/i);
  });

  it("rejects same-agent deep in lineage", () => {
    refuses(depth(["general", "coder", "explore"], "general"), "presence anywhere in the lineage counts");
  });

  it("rejects when next depth exceeds maxDepth", () => {
    const result = refuses(depth(["general", "coder"], "explore"), "the next step is past maxDepth");
    assert.match(result.error, /depth/i);
  });

  it("allows different-agent chain within depth limit", () => {
    admits(depth(["general"], "coder"), "a different agent within the depth limit");
  });

  it("does not mutate lineage arrays", () => {
    const lineage = ["general", "coder"];
    const copy = [...lineage];
    depth(lineage, "explore"); // should fail — exceeds depth
    assert.deepStrictEqual(lineage, copy, "Lineage must not be mutated");
  });

  it("a negative cap is no limit, however few agents there are", () => {
    admits(depth(["a", "b", "c"], "d", { agents: ["a"], maxDepth: -1 }), "an unlimited depth is not capped by breadth");
  });

  it("the refusal names the AGENT, because the cap it broke is that agent's", () => {
    // The cap arrives already resolved from the agent being dispatched, so the agent
    // is the only name the refusal has. It used to take a lane as a fifth argument
    // solely to print it — and a second name for "who is this about" is a second
    // answer, free to disagree with the one that set the cap.
    const result = refuses(depth(["general", "coder"], "explore"), "the agent is named");
    assert.match(result.error, /agent "explore"/);
    assert.doesNotMatch(result.error, /lane/i, "the vocabulary is the operator's, and lanes are gone");
  });

  describe("which constraint binds", () => {
    it("reports the cap as binding when the agent set is wide enough", () => {
      assert.deepStrictEqual(depthLimits({ allowSameAgentRecursion: false, maxDepth: 3 }, FOUR_AGENTS), {
        boundBy: "agent-cap", configured: 3, effective: 3,
      });
    });

    it("reports the AGENT SET as binding when it is narrower than the cap", () => {
      // The case the whole value exists for: a maxDepth of 4 on a project with
      // two usable agent types is a 2, and the number in the config is a lie the
      // operator cannot see.
      assert.deepStrictEqual(depthLimits({ allowSameAgentRecursion: false, maxDepth: 4 }, ["general", "coder"]), {
        boundBy: "agent-set", configured: 4, effective: 2,
      });
    });

    it("counts DISTINCT normalized names, so @General and general are one agent", () => {
      assert.strictEqual(
        depthLimits({ allowSameAgentRecursion: false, maxDepth: 9 }, ["general", "@General", " coder "]).effective,
        2,
      );
    });

    it("ignores the agent set entirely when same-agent recursion is allowed", () => {
      assert.deepStrictEqual(depthLimits({ allowSameAgentRecursion: true, maxDepth: 9 }, ["general"]), {
        boundBy: "agent-cap", configured: 9, effective: 9,
      });
    });

    it("says which one bound, in the refusal the parent reads", () => {
      const result = refuses(
        depth(["general", "coder"], "explore", { agents: ["general", "coder"], maxDepth: 4 }),
        "the chain is at the agent-set bound, not the configured cap",
      );
      assert.match(result.error, /only 2 distinct agent/);
      assert.match(result.error, /allowSameAgentRecursion/, "the message names the other lever");
    });
  });
});

describe("buildTaskLineage", () => {
  it("appends child agent to parent lineage", () => {
    const result = buildTaskLineage(["general", "coder"], "explore");
    assert.deepStrictEqual(result, ["general", "coder", "explore"]);
  });

  it("handles empty parent lineage", () => {
    const result = buildTaskLineage([], "reviewer");
    assert.deepStrictEqual(result, ["reviewer"]);
  });
});

describe("task policy: invalid inputs", () => {

  it("validateAgent rejects empty names", () => {
    assert.strictEqual(validateAgent("", defaultConfig).ok, false);
    refuses(validateAgent(null, defaultConfig), "a dispatch that named no agent");
  });

  it("validateLineage rejects empty child names", () => {
    refuses(validateLineage([], "", defaultConfig), "a lineage with an empty child name");
  });
});
