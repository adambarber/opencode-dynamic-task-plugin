/**
 * task-policy.ts — the pure rules about who may be dispatched, and how deep.
 *
 * No I/O and no store: a name, a lineage and a config in, a verdict out. That is
 * why the fixtures are only a config — a case here is a decision over an input,
 * so a new spelling of a refusal is a new row rather than another arrangement.
 */

import { describe, it, assert } from "./support/runner.js";
import {
  buildTaskLineage,
  isSameAgent,
  normalizeAgentName,
  validateAgent,
  validateLineage,
} from "../../dist/shared/task-policy.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { admits, assertIs, assertNothing, refuses } from "./support/assertions.js";
import { blockingConfig, defaultConfig } from "./support/fixtures.js";

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
  const config = normalizeDynamicTaskConfig({ maxDepth: 2 });

  it("rejects same-agent anywhere in lineage", () => {
    const result = refuses(validateLineage(["reviewer"], "reviewer", config), "the agent is already in the lineage");
    assert.match(result.error, /recursion|same-agent|already present/i);
  });

  it("rejects same-agent deep in lineage", () => {
    refuses(validateLineage(["general", "coder", "explore"], "general", config), "presence anywhere in the lineage counts");
  });

  it("rejects when next depth exceeds maxDepth", () => {
    const result = refuses(validateLineage(["general", "coder"], "explore", config), "the next step is past maxDepth");
    assert.match(result.error, /depth/i);
  });

  it("allows different-agent chain within depth limit", () => {
    admits(validateLineage(["general"], "coder", config), "a different agent within the depth limit");
  });

  it("does not mutate lineage arrays", () => {
    const lineage = ["general", "coder"];
    const copy = [...lineage];
    validateLineage(lineage, "explore", config); // should fail — exceeds depth
    assert.deepStrictEqual(lineage, copy, "Lineage must not be mutated");
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
