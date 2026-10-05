/**
 * config.ts — where a limit comes from, and what happens when a source is unusable.
 *
 * Three levels (tuple options, file, env) and a default under all of them, plus
 * the JSONC file layer. The subject throughout is precedence: which level wins,
 * and what an unusable value at one level does to the level below it.
 */

import { assert, describe, it } from "./support/runner.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The repository root, for the source-count pin that cannot retype the path. */

import { DEFAULT_CONFIG, DYNAMIC_TASK_FILE, ENV, normalizeDynamicTaskConfig, parseDynamicTaskJsonc, readDynamicTaskPolicy } from "../../dist/shared/config.js";
import { checkAgentCapacity, knownCappedAgents, resolveAgentCaps } from "../../dist/shared/caps.js";
import { tmpFilePath, withEnv, withTempFile } from "./support/harness.js";
import { REPO_ROOT } from "./support/corpus.js";
import { assertAnswer, assertNothing } from "./support/assertions.js";
import { bothCaps } from "./support/fixtures.js";

/**
 * The safe config defaults, asserted as a set. They are one contract — two
 * limits, a blocklist, a flag and three positive TTLs — and the ladder was
 * hand-written at each site that cared, so a new default could be added without
 * any of them noticing. Reused by the cases that feed garbage in and expect
 * exactly these values back.
 */
function assertSafeDefaults(config) {
  assert.strictEqual(config.maxDepth, 2);
  assert.strictEqual(config.maxConcurrent, 4);
  assert.deepStrictEqual(config.blockedAgents, []);
  assert.strictEqual(config.allowSameAgentRecursion, false);
  assert.ok(config.agentCacheTtlMs > 0);
  assert.ok(config.retainedTaskTtlMs > 0);
  assert.ok(config.retainedTaskMaxEntries > 0);
  assert.ok(config.pendingMaxAttempts > 0);
}

// One hypothesis: an absent or unusable env value yields the default. `undefined`
// is the "not set" case, which withEnv understands as unset.
describe("maxConcurrent default", () => {
  const unusable = [
    ["defaults to 4 when env is not set", undefined],
    ["ignores non-numeric env maxConcurrent", "bogus"],
  ];
  for (const [name, value] of unusable) {
    it(name, async () => {
      await withEnv(ENV.maxConcurrent, value, async () => {
        assert.strictEqual(normalizeDynamicTaskConfig({}).maxConcurrent, 4);
      });
    });
  }
});

describe("normalizeDynamicTaskConfig", () => {
  it("returns safe defaults when given empty options", () => {
    assertSafeDefaults(normalizeDynamicTaskConfig({}));
  });

  it("returns safe defaults when given null/undefined options", () => {
    assert.strictEqual(normalizeDynamicTaskConfig(null).maxDepth, 2);
    assert.strictEqual(normalizeDynamicTaskConfig(undefined).maxDepth, 2);
  });

  it("respects plugin tuple options overriding defaults", () => {
    const config = normalizeDynamicTaskConfig({
      blockedAgents: ["general", "coder"],
      maxConcurrent: 8,
      maxDepth: 3,
    });
    assert.strictEqual(config.maxDepth, 3);
    assert.strictEqual(config.maxConcurrent, 8);
    assert.deepStrictEqual(config.blockedAgents, ["general", "coder"]);
  });

  it("ignores unknown, malformed, or hostile option fields", () => {
    const config = normalizeDynamicTaskConfig({ maxConcurrent: "8", unknownField: "ignored" });
    assert.strictEqual(config.maxConcurrent, 4, "string numbers must not slip in");
    assert.ok(!("unknownField" in config));
  });

  it("lets env override tuple options", async () => {
    await withEnv(ENV.maxConcurrent, "7", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 2 }).maxConcurrent, 7);
    });
  });

  it("reads the redelivery budget from env, file and defaults, in that order", async () => {
    // The bound on an owed notification is the one setting whose wrong value
    // wedges a project rather than merely mis-sizing a window, so every level
    // that can move it is pinned. The default is spelled as a literal because
    // there is deliberately no shared constant to spell: the gate's own backstop
    // is a funnel safety for a caller that names no bound, not the same number,
    // and a test that tied them together would pin a coincidence as a contract.
    assert.strictEqual(normalizeDynamicTaskConfig({}).pendingMaxAttempts, 3);
    assert.strictEqual(normalizeDynamicTaskConfig({ pendingMaxAttempts: 9 }).pendingMaxAttempts, 9);

    await withEnv(ENV.pendingMaxAttempts, "5", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ pendingMaxAttempts: 9 }).pendingMaxAttempts, 5);
    });
    await withEnv(ENV.pendingMaxAttempts, "bogus", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ pendingMaxAttempts: 9 }).pendingMaxAttempts, 9, "an unusable env value falls through, it does not zero the bound");
    });
  });

  it("treats empty-string env var as 'not set' and falls through to the next level", async () => {
    await withEnv(ENV.maxConcurrent, "", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 5 }).maxConcurrent, 5);
    });
  });

  it("empty-string env var falls through to the default blocklist", async () => {
    await withEnv(ENV.blockedAgents, "", async () => {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, []);
    });
  });

  it("explicit env forbidden agents overrides blockedAgents", async () => {
    await withEnv(ENV.blockedAgents, "coder,reviewer", async () => {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, ["coder", "reviewer"]);
    });
  });

  it("a comma-only forbidden-agents env does not clear the blocklist", async () => {
    for (const junk of [",", " , ", ",,"]) {
      await withEnv(ENV.blockedAgents, junk, async () => {
        assert.deepStrictEqual(normalizeDynamicTaskConfig({}).blockedAgents, [], `env=${JSON.stringify(junk)}`);
      });
    }
  });
});

describe("config file layer", () => {
  it("file config fills gaps below tuple options", () => {
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 }, { maxConcurrent: 9, maxDepth: 5 });
    assert.strictEqual(config.maxDepth, 5, "file value survives");
    assert.strictEqual(config.maxConcurrent, 3, "tuple options win over file");
  });

  it("garbage file config is ignored", () => {
    for (const junk of [null, undefined, "nope", 42, [1], {}]) {
      assert.strictEqual(normalizeDynamicTaskConfig({}, junk).maxDepth, 2);
    }
  });
});

const inTempFile = (fn) => withTempFile(tmpFilePath("dt-cfg"), fn);

/**
 * A .jsonc file the parser must refuse. One idea with several spellings — the
 * wrong shape, malformed JSON — so the temp file, the write and the refusal are
 * one helper. A case that hand-rolls it is a case that can quietly assert
 * against a file that was never written, or through a second temp-file idiom
 * that is not the one the rest of the file cleans up after.
 */
const assertJsoncRejected = async (contents) => {
  assertNothing(await jsoncRead(contents), `must refuse ${JSON.stringify(contents)}`);
};

/**
 * A .jsonc file the parser must read, and what it read out of it. The mirror of
 * the helper above, and it exists for the same reason: the temp file, the write
 * and the parse are one arrangement, so a case that hand-rolls the accepted side
 * is a case that can assert against a file that was never written, or through a
 * second temp-file idiom the rest of the file does not clean up after.
 */
const jsoncRead = async (contents) => {
  let parsed;
  await inTempFile(async (file) => {
    writeFileSync(file, contents);
    parsed = parseDynamicTaskJsonc(file);
  });
  return parsed;
};

describe("readDynamicTaskPolicy: the one reader of what is in force", () => {
  // The TUI showed `normalizeDynamicTaskConfig(null)` — defaults and env, with the
  // hand-authored file never opened — while the dispatch path resolved the same caps
  // FROM that file. So a project that put caps in it saw the defaults on the screen that
  // edits caps, and every "from config" on that screen was a claim about the defaults.
  // These are the pins that keep the two readers on the same file.
  // A project root with a hand-authored config in it, handed to the case as a ROOT.
  // Named `root` and `configPath` rather than `dir` and `dir` because the first draft of
  // this helper passed `<tmp>/.opencode` as the root — one dirname short — and the reader
  // helpfully resolved the defaults, so the case failed on a number the file had stated.
  const withPolicy = (body, run) =>
    withTempFile(tmpFilePath("dt-policy"), () => {
      const root = tmpFilePath("dt-policy-root");
      const configPath = join(root, DYNAMIC_TASK_FILE);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, body);
      return Promise.resolve(run(root));
    });

  it("reads PER-AGENT caps out of the hand-authored file, which the defaults-only call could not", async () => {
    await withPolicy(JSON.stringify({ agents: { explore: { maxConcurrent: 9, maxDepth: 7 } } }), (root) => {
      const policy = readDynamicTaskPolicy(root, null);
      assert.deepEqual(policy.agents.explore, { maxConcurrent: 9, maxDepth: 7 }, "the file's own per-agent caps survive to the policy");
    });
  });

  it("resolves the same numbers for the screen and the dispatch path, because it is the same function", async () => {
    await withPolicy(JSON.stringify({ agents: { explore: { maxConcurrent: 9 } }, maxDepth: 5 }), (root) => {
      const fileConfig = parseDynamicTaskJsonc(join(root, DYNAMIC_TASK_FILE));
      const fromScreen = readDynamicTaskPolicy(root, null);
      const fromDispatch = normalizeDynamicTaskConfig(null, fileConfig);
      assert.deepEqual(fromScreen, fromDispatch, "two readers of one question must not be able to disagree");
    });
  });

  it("SPELLS the path once in production, so the two readers cannot drift apart", () => {
    // A count, not a value — and the needle is TAKEN FROM the constant, because a test
    // that retyped the path would be the second spelling this exists to prevent. That is
    // also why the retype guard refuses the obvious version of this case: the two rules
    // are the same rule seen from opposite ends.
    const spelled = readdirSync(join(REPO_ROOT, "src"), { recursive: true })
      .filter((file) => String(file).endsWith(".ts"))
      .filter((file) => readFileSync(join(REPO_ROOT, "src", String(file)), "utf8").includes(DYNAMIC_TASK_FILE));
    assert.deepStrictEqual(spelled, ["shared/config.ts"], `the config path is spelled in ${spelled.length} production files: ${spelled.join(", ")}`);
  });

  it("resolves the defaults when there is no file, and says so with an identity it did not have to build", () => {
    assert.deepEqual(readDynamicTaskPolicy(undefined, null), normalizeDynamicTaskConfig(null), "no directory is the same answer as no file");
  });
});

describe("parseDynamicTaskJsonc", () => {
  it("returns null for a missing file", () => {
    assertNothing(parseDynamicTaskJsonc("/nonexistent/path/config.jsonc"), "a config that is not there");
  });

  it("returns null for empty or non-object payloads", async () => {
    assertNothing(parseDynamicTaskJsonc(""), "an empty config");
    await assertJsoncRejected("[1, 2]");
  });

  it("strips comments and parses objects", async () => {
    // A NEUTRAL key, not one of this plugin's: this is a test of the parser, and
    // borrowing a production constant's name here would make it a hand-kept mirror
    // of a vocabulary it knows nothing about — which the retyped-constant rule
    // rightly refuses.
    assertAnswer(
      await jsoncRead('{ /* block */ "count": 3 } // trailing\n'),
      { count: 3 },
      "a commented config parses to the object it describes",
    );
  });
});

describe("config: file and env edges", () => {
  it("parseDynamicTaskJsonc returns null for malformed JSON", async () => {
    await assertJsoncRejected("{ not json,");
  });
});

describe("config field parsing edges", () => {
  it("agentCacheTtlMs comes from options", () => {
    const config = normalizeDynamicTaskConfig({ agentCacheTtlMs: 1500 });
    assert.strictEqual(config.agentCacheTtlMs, 1500);
  });

  // NaN is the interesting one: it is a number, and a `<= 0` guard would let it
  // through, so the whole "safe" claim would rest on a TTL of NaN.
  it("rejects non-positive numbers everywhere", () => {
    assertSafeDefaults(normalizeDynamicTaskConfig({ agentCacheTtlMs: NaN, maxConcurrent: -3, maxDepth: 0 }));
  });

  it("ignores non-boolean allowSameAgentRecursion", () => {
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: "yes" }).allowSameAgentRecursion, false);
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: true }).allowSameAgentRecursion, true);
  });
});

describe("agents: which policy an agent name resolves to", () => {
  /**
   * One budget, three spellings of an agent's caps: both overridden, one
   * overridden, and — the case the config file cannot express — an agent the
   * operator has not capped at all. A describe-level config because the cases below
   * are about how a NAME resolves; spelling a config per case would make each one
   * about the spelling instead.
   */
  const shared = normalizeDynamicTaskConfig({
    agents: { deep: { maxDepth: 4 }, quick: { maxConcurrent: 2 } },
    maxConcurrent: 5,
    maxDepth: 3,
  });

  /** An agent's CAPS, without the name — two agents mean the same policy when these match. */
  const caps = (config, name) => {
    const { maxDepth, maxConcurrent } = resolveAgentCaps(config, name);
    return { maxConcurrent, maxDepth };
  };

  it("with no agents configured, any name runs on the top-level numbers", () => {
    // The common case, and it is the top-level numbers because an agent is counted
    // on its own without being declared: `knownCappedAgents` being empty means no
    // agent is capped SEPARATELY, not that there are no agents.
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 3, maxDepth: 2 });
    assert.deepStrictEqual(resolveAgentCaps(config, "anything"), { agent: "anything", maxConcurrent: 3, maxDepth: 2 });
  });

  it("a configured agent resolves to its own numbers", () => {
    const config = normalizeDynamicTaskConfig({ agents: { deep: bothCaps(1, 3) }, maxConcurrent: 4 });
    assert.deepStrictEqual(resolveAgentCaps(config, "deep"), { agent: "deep", maxConcurrent: 1, maxDepth: 3 });
  });

  it("an agent that omits one number inherits the top-level value for it", () => {
    const config = normalizeDynamicTaskConfig({ agents: { deep: { maxDepth: 3 } }, maxConcurrent: 4, maxDepth: 5 });
    assert.deepStrictEqual(resolveAgentCaps(config, "deep"), { agent: "deep", maxConcurrent: 4, maxDepth: 3 });
  });

  it("knownCappedAgents lists the configured agents, and nothing when none are", () => {
    assert.deepStrictEqual(knownCappedAgents(normalizeDynamicTaskConfig(null)), []);
    assert.deepStrictEqual(
      knownCappedAgents(normalizeDynamicTaskConfig({ agents: { deep: { maxDepth: 3 }, quick: { maxConcurrent: 2 } } })).toSorted(),
      ["deep", "quick"],
    );
  });

  it("every normalized config is its own object — declaring an agent in one cannot leak into another", () => {
    const before = knownCappedAgents(shared);
    assert.deepStrictEqual(before.toSorted(), ["deep", "quick"]);
    assert.deepStrictEqual(knownCappedAgents(normalizeDynamicTaskConfig({})), [], "a config normalized after the agent config must not see it");
    assert.deepStrictEqual(knownCappedAgents(DEFAULT_CONFIG), [], "and the process-wide default must still be the default");
    assert.deepStrictEqual(knownCappedAgents(shared), before, "and reading the caps cannot have changed it either");
  });

  it("agents are normalized at the config boundary, so 'Deep' and 'deep' are one agent", () => {
    // The write side of the key space. Folding only the READ side is how a cap an
    // operator set applies to no agent at all, with no error and no refusal.
    const config = normalizeDynamicTaskConfig({ agents: { Deep: { maxConcurrent: 2 } } });
    assert.deepStrictEqual(knownCappedAgents(config), ["deep"]);
    assert.strictEqual(resolveAgentCaps(config, "deep").maxConcurrent, 2);
    assert.strictEqual(resolveAgentCaps(config, "Deep").maxConcurrent, 2, "and the host's spelling finds it too");
  });

  it("an agent with unusable numbers is dropped, not coerced to zero and not inherited", () => {
    const config = normalizeDynamicTaskConfig({ agents: { neg: { maxDepth: -2 }, zero: { maxConcurrent: 0 } }, maxDepth: 2 });
    assert.deepStrictEqual(knownCappedAgents(config), [], "a knob the operator set and we cannot honour is not a cap at all");
    assert.deepStrictEqual(
      knownCappedAgents(normalizeDynamicTaskConfig({ agents: { ok: { maxDepth: 9 }, zero: { maxConcurrent: 0 } }, maxDepth: 2 })),
      ["ok"],
      "and one usable knob is enough to keep an agent that also carries an unusable one",
    );
  });

  it("an agent nobody declared resolves to the top level, because the name is not a claim", () => {
    // A lane had a separate accept-set, so an undeclared name was REFUSED and the
    // operator was told to declare it. Here the name is the host's own and every
    // registered agent is admitted without being configured — which is what makes the
    // screen able to show one row per agent on a project that has never touched it.
    assert.deepStrictEqual(caps(shared, "typo"), { maxConcurrent: 5, maxDepth: 3 },
      "an uncapped agent runs on the top-level numbers, which is what the host's own agents do");
  });
});

describe("agents: capacity", () => {
  const config = normalizeDynamicTaskConfig({ agents: { quick: bothCaps(1, 2) }, maxConcurrent: 2 });
  const quick = resolveAgentCaps(config, "quick");

  it("returns null when the agent is under its own cap", () => {
    assertNothing(
      checkAgentCapacity({ agentActive: 0, totalActive: 1 }, quick, config.maxConcurrent),
      "a free slot on the agent is reported as no error at all",
    );
  });

  it("the agent's own cap refuses, and names the agent", () => {
    const result = checkAgentCapacity({ agentActive: 1, totalActive: 1 }, quick, config.maxConcurrent);
    assert.ok(result.includes("quick"), "an agent refusal must name the agent, or the operator cannot tell which knob to turn");
    assert.ok(result.includes("1"));
  });

  it("the ceiling refuses across agents, and says so", () => {
    // The knob that fixes it is not the one the per-agent message names, so
    // conflating them sends the operator to edit a cap that was never the constraint.
    const roomy = resolveAgentCaps(config, "other");
    const result = checkAgentCapacity({ agentActive: 0, totalActive: 2 }, roomy, 2);
    assert.ok(result.includes("2"));
    assert.ok(/total|ceiling/i.test(result), "a cross-agent refusal must distinguish the ceiling from an agent cap");
  });
});
