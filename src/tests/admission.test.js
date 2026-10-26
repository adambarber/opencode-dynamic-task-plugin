/**
 * Admission.ts — the one gate a dispatch passes through.
 *
 * The agent list the host publishes, the rules a dispatch is admitted under, and
 * the dependency gate that holds one back. Every refusal a case asserts here is a
 * decision production made, so the helpers are the shared claim vocabulary rather
 * than a per-file ladder.
 */

import { buildAgentList, dispatchableAgentNamesOrNull, fetchAgents, resetAgentCache, resolveAdmission } from "../../dist/shared/admission.js";
import { DEFAULT_AGENT_MODE, toAgentRecords } from "../../dist/shared/agent-record.js";
import { assert, beforeEach, defaultConfig, describe, it, opaqueHost } from "./support/index.js";

// --- What the host publishes -------------------------------------------------

describe("buildAgentList", () => {
  it("returns agent names joined by comma", () => {
    const agents = toAgentRecords([
      { description: "test", name: "explore" },
      { name: "general", permissions: [] },
    ]);
    assert.strictEqual(buildAgentList(agents), "explore, general");
  });

  it("returns '(none discovered)' for empty array", () => {
    assert.strictEqual(buildAgentList([]), "(none discovered)");
  });

  // Total on malformed input: the host probes named exports during load and
  // A throw here fails the entire plugin boot (field: agents.map on a
  // Non-array while the default export never ran). Never throw; degrade.
  it("returns '(none discovered)' for non-array input instead of throwing", () => {
    assert.strictEqual(buildAgentList(), "(none discovered)");
    assert.strictEqual(buildAgentList(null), "(none discovered)");
    assert.strictEqual(buildAgentList({ agents: [] }), "(none discovered)");
    assert.strictEqual(buildAgentList("general"), "(none discovered)");
  });

  it("reads the normalised names, so no caller sees a raw payload", () => {
    assert.strictEqual(buildAgentList(toAgentRecords([{ name: "general", permissions: [] }, { nope: 1 }, "x", null])), "general");
    assert.strictEqual(buildAgentList(toAgentRecords([{ nope: 1 }])), "(none discovered)");
  });
});

describe("fetchAgents", () => {
  beforeEach(() => {
    resetAgentCache();
  });

  /**
   * A client whose `agent.list()` answers `respond` — a list, or a function of
   * the call number, which is how a test scripts a failure-then-success without a
   * hand-kept counter that can drift from the assertion that reads it.
   * `client.agentCalls` is the count those assertions actually want.
   */
  function clientWith(respond) {
    const client = {
      // V2 spells this `agent.list` and answers its `{ location, data }` envelope —
      // Or a bare array from the TUI store. Both are shapes the reader takes.
      agent: {
        list: async () => {
          client.agentCalls++;
          return typeof respond === "function" ? respond(client.agentCalls) : respond;
        },
      },
      agentCalls: 0,
    };
    return client;
  }

  /**
   * The dispatchable agent names a client yields — the answer every case here
   * actually asserts on, in one expression. Spelled three ways in this file
   * (`result.length`, `result[0].name`, `result.map(...)`), so which of those
   * was the actual contract was ambiguous; now it is names, always.
   */
  const agentNames = async (client) => {
    const agents = await fetchAgents({ host: opaqueHost(client) });
    return agents.map((a) => a.name);
  };

  it("dispatches subagent and all modes, rejects primary", async () => {
    const mockClient = clientWith([
      { mode: "subagent", name: "explore", permissions: [] },
      { mode: DEFAULT_AGENT_MODE, name: "architect", permissions: [] },
      { name: "unannotated", permissions: [] },
      { mode: "primary", name: "build", permissions: [] },
    ]);

    const fetched = await agentNames(mockClient);
    assert.deepStrictEqual(
      fetched.toSorted(),
      ["architect", "explore", "unannotated"]
    );
  });

  it("admits by label but carries the registry id, which is what the host routes", () => {
    const [agent] = toAgentRecords([{ id: "general", mode: "subagent", name: "General", permissions: [] }]),
     admitted = resolveAdmission([agent], "General", [], defaultConfig);
    assert.strictEqual(admitted.ok, true);
    assert.strictEqual(admitted.agent.id, "general");
  });

  it("handles error gracefully", async () => {
    const mockClient = clientWith(() => {
      throw new Error("Network error");
    });

    assert.deepStrictEqual(await agentNames(mockClient), []);
  });

  // The host probes entry exports outside the plugin lifecycle; the
  // Final-failure warn path must not throw when the client itself is
  // Unusable, or the whole plugin boot fails (field: client.app.log).
  it("returns [] without throwing when the client is unusable", async () => {
    const result = await fetchAgents();
    assert.deepStrictEqual(result, []);
  });

  it("retries once after a transient failure", async () => {
    const mockClient = clientWith((calls) => {
      if (calls === 1) {throw new Error("blip");}
      return [{ mode: "subagent", name: "explore", permissions: [] }];
    }),

     names = await agentNames(mockClient);
    assert.strictEqual(mockClient.agentCalls, 2, "one immediate retry");
    assert.deepStrictEqual(names, ["explore"]);
  });

  // The v2 client answers the `AgentListOutput` envelope (`{ location, data }`); the
  // TUI store answers a bare array. Anything else is not a list of agents, and the
  // Reader says so by returning nothing. The `{ data }` case below is the live shape —
  // An earlier revision of this table pinned the opposite and every live dispatch
  // Failed admission with "(none discovered)".
  it("reads the client's envelope", async () => {
    const respond = {
      data: [{ mode: "subagent", name: "general", permissions: [] }],
      location: { directory: "/mock/project" },
    };
    assert.deepStrictEqual(await agentNames(clientWith(respond)), ["general"]);
  });
  const notLists = [
    ["an envelope keyed by agents", { agents: [{ mode: "subagent", name: "review", permissions: [] }] }],
    ["a single record instead of a list", { mode: "subagent", name: "solo", permissions: [] }],
  ];
  for (const [name, respond] of notLists) {
    it(`yields nothing for ${JSON.stringify(name)}`, async () => {
      assert.deepStrictEqual(await agentNames(clientWith(respond)), [],
        "an answer that is not a list of agents must not become a list of agents");
    });
  }

  // The cache is process-global state; scoping it per client means one
  // Plugin instance (or the host's entry-export probes) can never serve
  // Another client's agent list.
  it("caches per client: two clients keep distinct agent lists", async () => {
    // ONE mint per client, as production does at boot: the cache keys on host
    // Identity, so re-minting per call would mint a fresh cache every read.
    const clientA = clientWith([{ mode: "subagent", name: "alpha", permissions: [] }]),
     clientB = clientWith([{ mode: "subagent", name: "beta", permissions: [] }]),
     hostA = opaqueHost(clientA),
     hostB = opaqueHost(clientB),

    // These reads are a TIMELINE, not three assertions: A, then B, then A again.
    // Declared as data so the order is the spec — the third read is the whole
    // point, since only a per-client cache can answer it without refetching.
     timeline = [
      [hostA, ["alpha"]],
      [hostB, ["beta"]],
      [hostA, ["alpha"]],
    ];
    for (const [host, expected] of timeline) {
      const agents = await fetchAgents({ host });
      assert.deepStrictEqual(agents.map((a) => a.name), expected);
    }
    assert.strictEqual(clientA.agentCalls, 1, "client A's second read is served from its own cache");
    assert.strictEqual(clientB.agentCalls, 1, "client B's fetch never touched client A's cache");
  });

  it("stale entries refetch — TTL still bounds each client's cache", async () => {
    const mockClient = clientWith((calls) =>
      calls === 1
        ? [{ mode: "subagent", name: "first", permissions: [] }]
        : [{ mode: "subagent", name: "second", permissions: [] }]);

    const firstFetch = await fetchAgents({ host: opaqueHost(mockClient) }, 60_000);
    assert.strictEqual(firstFetch[0].name, "first");
    const freshFetch = await fetchAgents({ host: opaqueHost(mockClient) }, 0);
    assert.strictEqual(freshFetch[0].name, "second", "expired TTL forces a fresh fetch");
    assert.strictEqual(mockClient.agentCalls, 2);
  });

  it("resetAgentCache invalidates every client's cache", async () => {
    const mockClient = clientWith([{ mode: "subagent", name: "explore", permissions: [] }]);
    await fetchAgents({ host: opaqueHost(mockClient) }, 60_000);
    resetAgentCache();
    await fetchAgents({ host: opaqueHost(mockClient) }, 60_000);
    assert.strictEqual(mockClient.agentCalls, 2, "reset must not leave any client's entry fresh");
  });

  it("an EMPTY list is re-asked rather than cached, because empty is not a neutral answer", async () => {
    // A host answering `app.agents()` with an empty list while it is still
    // Registering its agents is a real race, and the empty list is not cached
    // Because `[]` is served as a KNOWN answer: admission refuses every dispatch
    // Against it and the cap screen renders no agents. Caching it would spend
    // The whole TTL refusing work the project can do.
    //
    // Pinned in both directions on purpose. `known` alone would also pass against
    // A cache that served the empty list happily and let the cap screen blank out
    // For a whole TTL; the re-ask alone would pass against a read that reported
    // The empty list as UNKNOWN, which is the opposite error and the one that
    // Sends an operator hunting for a project that cannot delegate.
    const mockClient = clientWith([{ mode: "primary", name: "primary", permissions: [] }]);
    assert.deepStrictEqual(await dispatchableAgentNamesOrNull({ host: opaqueHost(mockClient) }, defaultConfig), [], "no subagent is a known empty list, not an unknown one");
    assert.deepStrictEqual(await dispatchableAgentNamesOrNull({ host: opaqueHost(mockClient) }, defaultConfig), [], "and it still knows it on the second read");
    assert.strictEqual(mockClient.agentCalls, 2, "the empty answer is re-asked rather than served from cache");
  });
});

// --- The rules a dispatch is admitted under -----------------------------------

