/**
 * admission.ts — the one gate a dispatch passes through.
 *
 * The agent list the host publishes, the rules a dispatch is admitted under, and
 * the dependency gate that holds one back. Every refusal a case asserts here is a
 * decision production made, so the helpers are the shared claim vocabulary rather
 * than a per-file ladder.
 */

import { describe, it, beforeEach, assert } from "./support/runner.js";
import { buildAgentList, fetchAgents, parseAgentList, registerAdmittedTask, resolveAdmission, resolveDependencies, resetAgentCache } from "../../dist/shared/admission.js";
import { createTaskStore, registerActiveTask, transitionState } from "../../dist/shared/task-state.js";
import { DEFAULT_LANE, normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { admits, assertNoAgents, refuses, said } from "./support/assertions.js";
import { blockingConfig, childParams, defaultConfig, singleSlotConfig } from "./support/fixtures.js";

// --- What the host publishes -------------------------------------------------

describe("buildAgentList", () => {
  it("returns agent names joined by comma", () => {
    const agents = [
      { name: "explore", description: "test" },
      { name: "general" },
    ];
    assert.strictEqual(buildAgentList(agents), "explore, general");
  });

  it("returns '(none discovered)' for empty array", () => {
    assert.strictEqual(buildAgentList([]), "(none discovered)");
  });

  // Total on malformed input: the host probes named exports during load and
  // a throw here fails the entire plugin boot (field: agents.map on a
  // non-array while the default export never ran). Never throw; degrade.
  it("returns '(none discovered)' for non-array input instead of throwing", () => {
    assert.strictEqual(buildAgentList(undefined), "(none discovered)");
    assert.strictEqual(buildAgentList(null), "(none discovered)");
    assert.strictEqual(buildAgentList({ agents: [] }), "(none discovered)");
    assert.strictEqual(buildAgentList("general"), "(none discovered)");
  });

  it("drops non-record entries instead of printing undefined", () => {
    assert.strictEqual(buildAgentList([{ name: "general" }, { nope: 1 }, "x", null]), "general");
    assert.strictEqual(buildAgentList([{ nope: 1 }]), "(none discovered)");
  });
});

describe("fetchAgents", () => {
  beforeEach(() => {
    resetAgentCache();
  });

  /**
   * A client whose app.agents() answers `respond` — a list, a wrapped host
   * response ({data}/{agents}), or a function of the call number, which is how
   * a test scripts a failure-then-success without a hand-kept counter that can
   * drift from the assertion that reads it. `client.agentCalls` is the count
   * those assertions actually want.
   */
  function clientWith(respond, log = async () => {}) {
    const client = {
      agentCalls: 0,
      app: {
        agents: async () => {
          client.agentCalls++;
          return typeof respond === "function" ? respond(client.agentCalls) : respond;
        },
        log,
      },
    };
    return client;
  }

  /**
   * The dispatchable agent names a client yields — the answer every case here
   * actually asserts on, in one expression. Spelled three ways in this file
   * (`result.length`, `result[0].name`, `result.map(...)`), so which of those
   * was the actual contract was ambiguous; now it is names, always.
   */
  const agentNames = async (client) => (await fetchAgents(client)).map((a) => a.name);

  it("dispatches subagent and all modes, rejects primary", async () => {
    const mockClient = clientWith([
      { name: "explore", mode: "subagent" },
      { name: "architect", mode: "all" },
      { name: "unannotated" },
      { name: "build", mode: "primary" },
    ]);

    assert.deepStrictEqual(
      (await agentNames(mockClient)).sort(),
      ["architect", "explore", "unannotated"]
    );
  });

  it("handles error gracefully", async () => {
    const mockClient = clientWith(() => {
      throw new Error("Network error");
    });

    assert.deepStrictEqual(await agentNames(mockClient), []);
  });

  // The host probes entry exports outside the plugin lifecycle; the
  // final-failure warn path must not throw when the client itself is
  // unusable, or the whole plugin boot fails (field: client.app.log).
  it("returns [] without throwing when the client is unusable", async () => {
    const result = await fetchAgents(undefined);
    assert.deepStrictEqual(result, []);
  });

  it("retries once after a transient failure", async () => {
    const mockClient = clientWith((calls) => {
      if (calls === 1) throw new Error("blip");
      return [{ name: "explore", mode: "subagent" }];
    });

    const names = await agentNames(mockClient);
    assert.strictEqual(mockClient.agentCalls, 2, "one immediate retry");
    assert.deepStrictEqual(names, ["explore"]);
  });

  // One hypothesis: whichever envelope the host wraps the list in, exactly the
  // dispatchable agents come back — the server answers all three shapes.
  const envelopes = [
    ["handles wrapped response (result.data)", "data", "general"],
    ["handles wrapped response (result.agents)", "agents", "review"],
  ];
  for (const [name, key, kept] of envelopes) {
    it(name, async () => {
      const mockClient = clientWith({ [key]: [
        { name: kept, mode: "subagent" },
        { name: "excluded", mode: "primary" },
      ] });

      assert.deepStrictEqual(await agentNames(mockClient), [kept], "primary agents are not dispatchable");
    });
  }

  // The cache is process-global state; scoping it per client means one
  // plugin instance (or the host's entry-export probes) can never serve
  // another client's agent list.
  it("caches per client: two clients keep distinct agent lists", async () => {
    const clientA = clientWith([{ name: "alpha", mode: "subagent" }]);
    const clientB = clientWith([{ name: "beta", mode: "subagent" }]);

    // These reads are a TIMELINE, not three assertions: A, then B, then A again.
    // Declared as data so the order is the spec — the third read is the whole
    // point, since only a per-client cache can answer it without refetching.
    const timeline = [
      [clientA, ["alpha"]],
      [clientB, ["beta"]],
      [clientA, ["alpha"]],
    ];
    for (const [client, expected] of timeline) {
      assert.deepStrictEqual((await fetchAgents(client)).map((a) => a.name), expected);
    }
    assert.strictEqual(clientA.agentCalls, 1, "client A's second read is served from its own cache");
    assert.strictEqual(clientB.agentCalls, 1, "client B's fetch never touched client A's cache");
  });

  it("stale entries refetch — TTL still bounds each client's cache", async () => {
    const mockClient = clientWith((calls) =>
      calls === 1
        ? [{ name: "first", mode: "subagent" }]
        : [{ name: "second", mode: "subagent" }]);

    assert.strictEqual((await fetchAgents(mockClient, 60000))[0].name, "first");
    assert.strictEqual((await fetchAgents(mockClient, 0))[0].name, "second", "expired TTL forces a fresh fetch");
    assert.strictEqual(mockClient.agentCalls, 2);
  });

  it("resetAgentCache invalidates every client's cache", async () => {
    const mockClient = clientWith([{ name: "explore", mode: "subagent" }]);
    await fetchAgents(mockClient, 60000);
    resetAgentCache();
    await fetchAgents(mockClient, 60000);
    assert.strictEqual(mockClient.agentCalls, 2, "reset must not leave any client's entry fresh");
  });
});

// --- The rules a dispatch is admitted under -----------------------------------

describe("admission gate: resolveAdmission", () => {
  const agents = [
    { name: "explore" },
    { name: "architect", mode: "all" },
  ];

  it("admits a known agent with extended lineage", () => {
    const result = resolveAdmission(agents, "explore", ["planner"], defaultConfig);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agent.name, "explore");
    assert.deepStrictEqual(result.newLineage, ["planner", "explore"]);
  });

  describe("a lane's own depth cap is the one that binds", () => {
    // The defect this pins: a lane declared `maxDepth` that nothing read, so the
    // field sat in the operator's config looking authoritative while every
    // dispatch was judged against the top-level number. A declared limit that
    // does not limit is worse than no field, because it is trusted.
    const agents = [{ name: "architect" }, { name: "coder" }, { name: "explore" }];
    const capped = normalizeDynamicTaskConfig({ maxDepth: 5, lanes: { build: { maxDepth: 2 } } });

    it("admits a chain the lane's cap allows, where the top-level cap would also allow", () => {
      admits(resolveAdmission(agents, "coder", ["architect"], capped, "build"), "depth 1 into a cap of 2");
    });

    it("refuses past the lane's cap while the top-level cap has plenty of room", () => {
      const result = resolveAdmission(agents, "explore", ["architect", "coder"], capped, "build");
      refuses(result, "the lane's cap of 2 is spent at depth 2, and maxDepth 5 never applies");
      assert.match(result.reason.refusal, /lane "build"/, "the refusal names the lane whose cap bound");
    });

    it("a lane that declares no depth of its own inherits the top-level cap", () => {
      const inherited = normalizeDynamicTaskConfig({ maxDepth: 2, lanes: { build: {} } });
      admits(resolveAdmission(agents, "coder", ["architect"], inherited, "build"), "depth 1 of 2");
      refuses(resolveAdmission(agents, "explore", ["architect", "coder"], inherited, "build"),
        "depth 2 is past the inherited cap of 2");
    });
  });

  it("does not mutate the input lineage", () => {
    const lineage = ["planner"];
    resolveAdmission(agents, "explore", lineage, defaultConfig);
    assert.deepStrictEqual(lineage, ["planner"]);
  });

  it("denies missing names", () => {
    for (const bad of [undefined, null, "", "   "]) {
      const result = resolveAdmission(agents, bad, [], defaultConfig);
      said(result.reason?.refusal, "No subagent_type", "a nameless request is told what is missing");
    }
  });

  it("denies unknown agents", () => {
    const result = resolveAdmission(agents, "nope", [], defaultConfig);
    refuses(result, "an agent the host does not list is refused");
    said(result.reason?.refusal, '"nope" not found', "the refusal names what was asked for");
  });

  it("denies blocked agents", () => {
    const result = resolveAdmission([{ name: "general" }], "general", [], blockingConfig());
    refuses(result, "a blocked agent is refused");
    said(result.reason?.refusal, "general", "the refusal names the agent that was refused");
    said(result.reason?.refusal, "blockedAgents", "and the config key that is responsible, which is the remedy");
  });

  it("denies lineage violations", () => {
    const result = resolveAdmission(agents, "explore", ["explore"], defaultConfig);
    refuses(result, "a same-agent lineage is refused");
    said(result.reason?.refusal, "Recursive delegation blocked", "the refusal says which rule fired");
    said(result.reason?.refusal, "explore", "and names the agent the lineage already contains");
  });
});

describe("admission gate: allowSameAgentRecursion", () => {
  const strict = normalizeDynamicTaskConfig({});
  const lenient = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true });

  it("blocks same-agent recursion by default", () => {
    refuses(resolveAdmission([{ name: "explore" }], "explore", ["explore"], strict), "the agent is already in the lineage");
  });

  it("honors the recursion flag", () => {
    admits(resolveAdmission([{ name: "explore" }], "explore", ["explore"], lenient), "recursion allowed, so the repeat is fine");
  });

  it("still enforces depth when recursion is allowed", () => {
    const shallow = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true, maxDepth: 1 });
    const result = resolveAdmission([{ name: "explore" }], "explore", ["a", "b"], shallow);
    assert.strictEqual(result.ok, false);
  });
});

describe("admission gate: resolveDependencies", () => {

  function storeWith(childSessionId, state) {
    const store = createTaskStore();
    registerActiveTask(store, {
      childSessionId, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [],
    }, defaultConfig);
    if (state !== "active") transitionState(store, childSessionId, state);
    return store;
  }

  it("admits with no dependencies", () => {
    assert.deepStrictEqual(
      resolveDependencies(createTaskStore(), undefined),
      { ok: true }
    );
  });

  it("admits when deps completed", () => {
    const store = storeWith("s1", "completed");
    const s2 = createTaskStore();
    for (const [id, task] of store.retainedTasks) s2.retainedTasks.set(id, task);
    admits(resolveDependencies(s2, ["s1"]), "a completed dependency admits");
  });

  it("refuses with the blocking set and names each dep state", () => {
    const active = storeWith("s1", "active");
    assert.deepStrictEqual(resolveDependencies(active, ["s1"]), { ok: false, pending: [{ id: "s1", state: "active" }] });
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(resolveDependencies(failed, ["s2"]), { ok: false, pending: [{ id: "s2", state: "error" }] });
  });

  it("settled-waits admit failed and interrupted deps but still block actives", () => {
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(resolveDependencies(failed, undefined, ["s2"]), { ok: true });
    const halted = storeWith("s3", "interrupted");
    assert.deepStrictEqual(resolveDependencies(halted, undefined, ["s3"]), { ok: true });
    const active = storeWith("s1", "active");
    assert.deepStrictEqual(resolveDependencies(active, undefined, ["s1"]), { ok: false, pending: [{ id: "s1", state: "active" }] });
  });

  it("strict wins when an id sits in both lists", () => {
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(
      resolveDependencies(failed, ["s2"], ["s2"]),
      { ok: false, pending: [{ id: "s2", state: "error" }] },
    );
  });

  it("treats unknown ids as satisfied (aged-out tolerance)", () => {
    admits(resolveDependencies(createTaskStore(), ["ses_gone"]), "an unknown id is treated as satisfied");
  });
});

describe("admission gate: the lane a dispatch asks for", () => {
  const agents = [{ name: "explore" }];
  const withLanes = normalizeDynamicTaskConfig({ lanes: { deep: { maxDepth: 4 } } });

  it("an absent lane is the default lane", () => {
    const result = resolveAdmission(agents, "explore", [], withLanes);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.lane, DEFAULT_LANE);
  });

  it("a declared lane is admitted and reported", () => {
    const result = resolveAdmission(agents, "explore", [], withLanes, "Deep");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.lane, "deep");
  });

  it("a lane nobody declared is refused, and the refusal names the lanes that exist", () => {
    const result = resolveAdmission(agents, "explore", [], withLanes, "typo");
    refuses(result, "a typo'd lane name is refused rather than silently given the default's budget");
    said(result.reason?.refusal, '"typo"', "the refusal names the lane that was asked for");
    said(result.reason?.refusal, "deep", "the refusal names the lanes that do exist");
  });

  it("with no lanes declared, only the default lane is a name", () => {
    const result = resolveAdmission(agents, "explore", [], defaultConfig, "whatever");
    refuses(result, "with nothing declared there is nothing to name but the default lane");
    said(result.reason?.refusal, '"whatever"', "the refusal echoes the name that was asked for");
    said(result.reason?.refusal, DEFAULT_LANE, "and points at the one lane that does exist");
  });

  it("a non-string lane is a refusal, not a quiet fall back to the default", () => {
    const result = resolveAdmission(agents, "explore", [], withLanes, 7);
    refuses(result, "a lane that is not a name cannot be resolved to a budget");
    said(result.reason?.refusal, '"7"', "the refusal echoes what was passed");
  });
});

describe("admission gate: parseAgentList", () => {
  it("accepts bare arrays and drops nameless records", () => {
    const records = parseAgentList([
      { name: "explore", mode: "subagent" },
      { noName: true },
      null,
    ]);
    assert.deepStrictEqual(records.map((a) => a.name), ["explore"]);
  });

  it("accepts data and agents envelopes", () => {
    assert.deepStrictEqual(
      parseAgentList({ data: [{ name: "a" }] }).map((a) => a.name),
      ["a"]
    );
    assert.deepStrictEqual(
      parseAgentList({ agents: [{ name: "b" }] }).map((a) => a.name),
      ["b"]
    );
  });

  it("prefers the first non-empty list", () => {
    assert.deepStrictEqual(
      parseAgentList({ agents: [], data: [{ name: "c" }] }).map((a) => a.name),
      ["c"]
    );
  });

  it("rejects garbage", () => {
    for (const bad of [null, undefined, "str", 42, {}, { agents: "x" }, [{ noName: 1 }]]) {
      assertNoAgents(parseAgentList(bad), `nothing usable in ${JSON.stringify(bad)}`);
    }
  });
});

describe("admission gate: registerAdmittedTask", () => {

  it("registers through the funnel and enforces the concurrency limit", () => {
    const limited = singleSlotConfig();
    const store = createTaskStore();
    const task = registerAdmittedTask(store, childParams({ id: "ses_1", description: "t1" }), limited);
    assert.strictEqual(task.agentName, "explore");
    assert.throws(() => registerAdmittedTask(store, childParams({ id: "ses_2", description: "t2" }), limited), /Concurrency/);
  });
});
