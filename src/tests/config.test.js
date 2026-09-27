/**
 * config.ts — where a limit comes from, and what happens when a source is unusable.
 *
 * Three levels (tuple options, file, env) and a default under all of them, plus
 * the JSONC file layer. The subject throughout is precedence: which level wins,
 * and what an unusable value at one level does to the level below it.
 */

import { describe, it, assert } from "./support/runner.js";
import { writeFileSync } from "node:fs";
import { ENV, DEFAULT_CONFIG, DEFAULT_LANE, admissibleLaneNames, checkLaneCapacity, knownLaneNames, normalizeDynamicTaskConfig, parseDynamicTaskJsonc, resolveLane, resolveLaneName } from "../../dist/shared/config.js";
import { tmpFilePath, withEnv, withTempFile } from "./support/harness.js";
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
      maxDepth: 3,
      maxConcurrent: 8,
      blockedAgents: ["general", "coder"],
    });
    assert.strictEqual(config.maxDepth, 3);
    assert.strictEqual(config.maxConcurrent, 8);
    assert.deepStrictEqual(config.blockedAgents, ["general", "coder"]);
  });

  it("ignores unknown, malformed, or hostile option fields", () => {
    const config = normalizeDynamicTaskConfig({ unknownField: "ignored", maxConcurrent: "8" });
    assert.strictEqual(config.maxConcurrent, 4, "string numbers must not slip in");
    assert.ok(!("unknownField" in config));
  });

  it("lets env override tuple options", async () => {
    await withEnv(ENV.maxConcurrent, "7", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 2 }).maxConcurrent, 7);
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
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 }, { maxDepth: 5, maxConcurrent: 9 });
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
    assertSafeDefaults(normalizeDynamicTaskConfig({ maxDepth: 0, maxConcurrent: -3, agentCacheTtlMs: NaN }));
  });

  it("ignores non-boolean allowSameAgentRecursion", () => {
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: "yes" }).allowSameAgentRecursion, false);
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: true }).allowSameAgentRecursion, true);
  });
});

describe("lanes: which policy a lane name resolves to", () => {
  /**
   * One budget, three spellings of a lane: both knobs overridden, one knob
   * overridden, and a name with no knobs of its own. A describe-level config
   * because the cases below are about how a NAME resolves — spelling a config
   * per case would make each one about the spelling instead.
   */
  const sharedLanes = normalizeDynamicTaskConfig({
    maxDepth: 3,
    maxConcurrent: 5,
    lanes: { deep: { maxDepth: 4 }, quick: { maxConcurrent: 2 }, accounting: {} },
  });

  /** A lane's LIMITS, without the name — two lanes mean the same policy when these match. */
  const limits = (config, name) => {
    const { maxDepth, maxConcurrent } = resolveLane(config, name);
    return { maxDepth, maxConcurrent };
  };

  it("with no lanes configured, any name runs on the top-level numbers", () => {
    // Not a lane: this is the config's OWN caps, which share the keys only because a
    // lane inherits them. `bothCaps` would say these belong to a lane.
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 3, maxDepth: 2 });
    const lane = resolveLane(config, "anything");
    assert.deepStrictEqual(lane, { name: "anything", maxConcurrent: 3, maxDepth: 2 });
  });

  it("a configured lane resolves to its own numbers", () => {
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 4, lanes: { deep: bothCaps(1, 3) } });
    assert.deepStrictEqual(resolveLane(config, "deep"), { name: "deep", maxConcurrent: 1, maxDepth: 3 });
  });

  it("a lane that omits one number inherits the top-level value for it", () => {
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 4, maxDepth: 5, lanes: { deep: { maxDepth: 3 } } });
    assert.deepStrictEqual(resolveLane(config, "deep"), { name: "deep", maxConcurrent: 4, maxDepth: 3 });
  });

  it("knownLaneNames lists the configured lanes, and nothing when none are", () => {
    assert.deepStrictEqual(knownLaneNames(normalizeDynamicTaskConfig(null)), []);
    assert.deepStrictEqual(
      knownLaneNames(normalizeDynamicTaskConfig({ lanes: { deep: { maxDepth: 3 }, quick: { maxConcurrent: 2 } } })).sort(),
      ["deep", "quick"],
    );
  });

  it("a name is normalized the same way everywhere it is spelled", () => {
    assert.strictEqual(resolveLaneName("  Deep  "), "deep");
    assert.strictEqual(resolveLaneName(""), DEFAULT_LANE);
    assert.strictEqual(resolveLaneName(undefined), DEFAULT_LANE);
    assert.strictEqual(resolveLaneName(7), DEFAULT_LANE);
  });

  it("every normalized config is its own object — declaring a lane in one cannot leak into another", () => {
    const before = knownLaneNames(sharedLanes);
    assert.deepStrictEqual(before, ["deep", "quick", "accounting"]);
    assert.deepStrictEqual(knownLaneNames(normalizeDynamicTaskConfig({})), [], "a config normalized after the lane config must not see it");
    assert.deepStrictEqual(knownLaneNames(DEFAULT_CONFIG), [], "and the process-wide default must still be the default");
    assert.deepStrictEqual(knownLaneNames(sharedLanes), before, "and reading a lane cannot have changed it either");
  });

  it("the default lane is admissible whether or not any lane was declared", () => {
    assert.deepStrictEqual(admissibleLaneNames(normalizeDynamicTaskConfig({})), [DEFAULT_LANE], "with nothing declared the default lane is still the one that works");
    assert.deepStrictEqual(admissibleLaneNames(sharedLanes), [DEFAULT_LANE, "deep", "quick", "accounting"]);
    assert.deepStrictEqual(
      admissibleLaneNames(normalizeDynamicTaskConfig({ lanes: { [DEFAULT_LANE]: { maxDepth: 9 } } })),
      [DEFAULT_LANE],
      "declaring the default lane must not make it appear twice, or the UI would offer it twice",
    );
  });

  it("lanes are normalized at the config boundary, so 'Deep' and 'deep' are one lane", () => {
    const config = normalizeDynamicTaskConfig({ lanes: { Deep: { maxConcurrent: 2 } } });
    assert.deepStrictEqual(knownLaneNames(config), ["deep"]);
    assert.strictEqual(resolveLane(config, "deep").maxConcurrent, 2);
  });

  it("a lane with unusable numbers is dropped, not coerced to zero and not inherited", () => {
    const config = normalizeDynamicTaskConfig({ maxDepth: 2, lanes: { zero: { maxConcurrent: 0 }, neg: { maxDepth: -2 } } });
    assert.deepStrictEqual(knownLaneNames(config), [], "a knob the operator set and we cannot honour is not a lane at all");
    assert.deepStrictEqual(
      knownLaneNames(normalizeDynamicTaskConfig({ maxDepth: 2, lanes: { zero: { maxConcurrent: 0 }, ok: { maxDepth: 9 } } })),
      ["ok"],
      "and one usable knob is enough to keep a lane that also carries an unusable one",
    );
  });

  // The three spellings a lane can be written in, over ONE budget, so the case
  // below is about how a name RESOLVES rather than about how a config is
  // spelled. Two of these spellings are the same lane and must be equal: an
  // operator who wrote no knobs meant the top-level numbers, not a lane that
  // happens to be missing them.
  it("a lane resolves to its own overrides, filled in from the top level", () => {
    assert.deepStrictEqual(resolveLane(sharedLanes, "deep"), { name: "deep", maxDepth: 4, maxConcurrent: 5 });
    assert.deepStrictEqual(resolveLane(sharedLanes, "quick"), { name: "quick", maxDepth: 3, maxConcurrent: 2 });
    assert.deepStrictEqual(resolveLane(sharedLanes, "accounting"), { name: "accounting", maxDepth: 3, maxConcurrent: 5 });
  });

  it("a lane with no knobs of its own is the top-level budget under a name", () => {
    assert.deepStrictEqual(limits(sharedLanes, "accounting"), limits(sharedLanes, DEFAULT_LANE),
      "separate accounting on the default budget must be expressible, and must mean the default budget");
  });

  it("a lane nobody declared resolves to the top level, because the name is not a claim", () => {
    assert.deepStrictEqual(limits(sharedLanes, "typo"), limits(sharedLanes, DEFAULT_LANE));
  });
});

describe("lanes: capacity", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 2, lanes: { quick: bothCaps(1, 2) } });
  const quick = resolveLane(config, "quick");

  it("returns null when the lane is under its own cap", () => {
    assertNothing(
      checkLaneCapacity({ laneActive: 0, totalActive: 1 }, quick, config.maxConcurrent),
      "a free slot in the lane is reported as no error at all",
    );
  });

  it("the lane's own cap refuses, and names the lane", () => {
    const result = checkLaneCapacity({ laneActive: 1, totalActive: 1 }, quick, config.maxConcurrent);
    assert.ok(result.includes("quick"), "a lane refusal must name the lane, or the operator cannot tell which knob to turn");
    assert.ok(result.includes("1"));
  });

  it("the global ceiling refuses across lanes, and says so", () => {
    const roomy = resolveLane(normalizeDynamicTaskConfig({ maxConcurrent: 2, lanes: { a: {}, b: {} } }), "b");
    const result = checkLaneCapacity({ laneActive: 0, totalActive: 2 }, roomy, 2);
    assert.ok(result.includes("2"));
    assert.ok(/total|ceiling/i.test(result), "a cross-lane refusal must distinguish the ceiling from a lane cap");
  });

  it("an empty lane name is impossible: resolveLaneName defaults before a cap is ever judged", () => {
    assert.strictEqual(resolveLaneName(undefined), DEFAULT_LANE);
  });
});
