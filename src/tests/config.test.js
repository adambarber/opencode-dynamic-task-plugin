/**
 * config.ts — where a limit comes from, and what happens when a source is unusable.
 *
 * Three levels (tuple options, file, env) and a default under all of them, plus
 * the JSONC file layer. The subject throughout is precedence: which level wins,
 * and what an unusable value at one level does to the level below it.
 */

import { describe, it, assert } from "./support/runner.js";
import { writeFileSync } from "node:fs";
import {
  ENV,
  checkConcurrencyLimit,
  normalizeDynamicTaskConfig,
  parseDynamicTaskJsonc,
} from "../../dist/shared/config.js";
import { tmpFilePath, withEnv, withTempFile } from "./support/harness.js";
import { assertAnswer, assertNothing } from "./support/assertions.js";

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
    assertAnswer(
      await jsoncRead('{ /* block */ "maxDepth": 3 } // trailing\n'),
      { maxDepth: 3 },
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

describe("task-state: concurrency helper", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 2 });

  it("returns null when under limit", () => {
    assertNothing(checkConcurrencyLimit(1, config), "a free slot is reported as no error at all");
  });

  it("returns error message when at limit", () => {
    const result = checkConcurrencyLimit(2, config);
    assert.ok(result.includes("Cannot run more than"));
    assert.ok(result.includes("2"));
  });

  it("returns error message when over limit", () => {
    const result = checkConcurrencyLimit(3, config);
    assert.ok(result);
  });
});
