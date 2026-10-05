/**
 * Admission.ts — the one gate a dispatch passes through.
 *
 * The agent list the host publishes, the rules a dispatch is admitted under, and
 * the dependency gate that holds one back. Every refusal a case asserts here is a
 * decision production made, so the helpers are the shared claim vocabulary rather
 * than a per-file ladder.
 */

import { assert, beforeEach, describe, it } from "./support/runner.js";
import { opaqueHost } from "./support/opaque-host.js";
import { buildAgentList, dispatchableAgentNamesOrNull, fetchAgents, parseAgentList, registerAdmittedTask, resetAgentCache, resolveAdmission, resolveDependencies } from "../../dist/shared/admission.js";
import { createTaskStore, registerActiveTask, transitionState } from "../../dist/shared/task-state.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { admits, assertNoAgents, refuses, said } from "./support/assertions.js";
import { DEFAULT_AGENT_MODE, agentCanNotify, toAgentRecords } from "../../dist/shared/agent-record.js";
import { isDispatchableAgent } from "../../dist/shared/task-policy.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { blockingConfig, childParams, defaultConfig, singleSlotConfig } from "./support/fixtures.js";

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
      agentCalls: 0,
      // V2 spells this `agent.list` and answers its `{ location, data }` envelope —
      // Or a bare array from the TUI store. Both are shapes the reader takes.
      agent: {
        list: async () => {
          client.agentCalls++;
          return typeof respond === "function" ? respond(client.agentCalls) : respond;
        },
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
  const agentNames = async (client) => (await fetchAgents({ host: opaqueHost(client) })).map((a) => a.name);

  it("dispatches subagent and all modes, rejects primary", async () => {
    const mockClient = clientWith([
      { mode: "subagent", name: "explore", permissions: [] },
      { mode: DEFAULT_AGENT_MODE, name: "architect", permissions: [] },
      { name: "unannotated", permissions: [] },
      { mode: "primary", name: "build", permissions: [] },
    ]);

    assert.deepStrictEqual(
      (await agentNames(mockClient)).toSorted(),
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
      data: [{ name: "general", mode: "subagent", permissions: [] }],
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
      assert.deepStrictEqual((await fetchAgents({ host })).map((a) => a.name), expected);
    }
    assert.strictEqual(clientA.agentCalls, 1, "client A's second read is served from its own cache");
    assert.strictEqual(clientB.agentCalls, 1, "client B's fetch never touched client A's cache");
  });

  it("stale entries refetch — TTL still bounds each client's cache", async () => {
    const mockClient = clientWith((calls) =>
      calls === 1
        ? [{ mode: "subagent", name: "first", permissions: [] }]
        : [{ mode: "subagent", name: "second", permissions: [] }]);

    assert.strictEqual((await fetchAgents({ host: opaqueHost(mockClient) }, 60_000))[0].name, "first");
    assert.strictEqual((await fetchAgents({ host: opaqueHost(mockClient) }, 0))[0].name, "second", "expired TTL forces a fresh fetch");
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

describe("admission gate: resolveAdmission", () => {
  const records = toAgentRecords([
    { name: "explore", permissions: [] },
    { mode: DEFAULT_AGENT_MODE, name: "architect", permissions: [] },
  ]);

  it("admits a known agent with extended lineage", () => {
    const result = resolveAdmission(records, "explore", ["planner"], defaultConfig);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agent.name, "explore");
    assert.deepStrictEqual(result.newLineage, ["planner", "explore"]);
  });

  describe("the DISPATCHING agent's own depth cap is the one that binds", () => {
    // The defect this pins, in its new shape: an agent that declared `maxDepth` that
    // Nothing read, so the field sat in the operator's config looking authoritative
    // While every dispatch was judged against the top-level number. A declared limit
    // That does not limit is worse than no field, because it is trusted.
    //
    // It is now a PLACEMENT limit — the cap belongs to the agent being dispatched, so
    // It can only be right if the gate resolves the cap from the agent the dispatch
    // Already names rather than from a second key the caller had to supply.
    const records = toAgentRecords([{ name: "architect", permissions: [] }, { name: "coder", permissions: [] }, { name: "explore", permissions: [] }]),
     capped = normalizeDynamicTaskConfig({ agents: { explore: { maxDepth: 2 } }, maxDepth: 5 });

    it("admits a chain the agent's cap allows, where the top-level cap would also allow", () => {
      admits(resolveAdmission(records, "explore", ["architect"], capped), "depth 1 into a cap of 2");
    });

    it("refuses past the agent's cap while the top-level cap has plenty of room", () => {
      const result = resolveAdmission(records, "explore", ["architect", "coder"], capped);
      refuses(result, "the agent's cap of 2 is spent at depth 2, and maxDepth 5 never applies");
      assert.match(result.reason.refusal, /agent "explore"/, "the refusal names the agent whose cap bound");
    });

    it("another agent's depth cap is not spent by this agent's chain", () => {
      // The thing a global cap could not do: `explore` capped at 1 is a direct child
      // And never nested, while `coder` still reaches the full depth. Under one global
      // Number these two were the same dial.
      const narrow = normalizeDynamicTaskConfig({ agents: { explore: { maxDepth: 1 } }, maxDepth: 3 });
      admits(resolveAdmission(records, "coder", ["architect", "explore"], narrow), "coder is uncapped, so the chain stands");
      refuses(resolveAdmission(records, "explore", ["architect"], narrow), "explore is a direct child only");
    });

    it("an agent that declares no depth of its own inherits the top-level cap", () => {
      const inherited = normalizeDynamicTaskConfig({ agents: { explore: { maxConcurrent: 3 } }, maxDepth: 2 });
      admits(resolveAdmission(records, "explore", ["architect"], inherited), "depth 1 of 2");
      refuses(resolveAdmission(records, "explore", ["architect", "coder"], inherited), "depth 2 is past the inherited cap of 2");
    });
  });

  it("does not mutate the input lineage", () => {
    const lineage = ["planner"];
    resolveAdmission(records, "explore", lineage, defaultConfig);
    assert.deepStrictEqual(lineage, ["planner"]);
  });

  it("denies missing names", () => {
    for (const bad of [undefined, null, "", "   "]) {
      const result = resolveAdmission(records, bad, [], defaultConfig);
      said(result.reason?.refusal, "No subagent_type", "a nameless request is told what is missing");
    }
  });

  it("denies unknown records", () => {
    const result = resolveAdmission(records, "nope", [], defaultConfig);
    refuses(result, "an agent the host does not list is refused");
    said(result.reason?.refusal, '"nope" not found', "the refusal names what was asked for");
  });

  it("denies blocked records", () => {
    const result = resolveAdmission(toAgentRecords([{ name: "general", permissions: [] }]), "general", [], blockingConfig());
    refuses(result, "a blocked agent is refused");
    said(result.reason?.refusal, "general", "the refusal names the agent that was refused");
    said(result.reason?.refusal, "blockedAgents", "and the config key that is responsible, which is the remedy");
  });

  it("denies lineage violations", () => {
    const result = resolveAdmission(records, "explore", ["explore"], defaultConfig);
    refuses(result, "a same-agent lineage is refused");
    said(result.reason?.refusal, "Recursive delegation blocked", "the refusal says which rule fired");
    said(result.reason?.refusal, "explore", "and names the agent the lineage already contains");
  });
});

describe("admission gate: allowSameAgentRecursion", () => {
  const strict = normalizeDynamicTaskConfig({}),
   lenient = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true });

  it("blocks same-agent recursion by default", () => {
    refuses(resolveAdmission(toAgentRecords([{ name: "explore", permissions: [] }]), "explore", ["explore"], strict), "the agent is already in the lineage");
  });

  it("honors the recursion flag", () => {
    admits(resolveAdmission(toAgentRecords([{ name: "explore", permissions: [] }]), "explore", ["explore"], lenient), "recursion allowed, so the repeat is fine");
  });

  it("still enforces depth when recursion is allowed", () => {
    const shallow = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true, maxDepth: 1 }),
     result = resolveAdmission(toAgentRecords([{ name: "explore", permissions: [] }]), "explore", ["a", "b"], shallow);
    assert.strictEqual(result.ok, false);
  });
});

describe("admission gate: resolveDependencies", () => {

  function storeWith(childSessionId, state) {
    const store = createTaskStore();
    registerActiveTask(store, {
      agentName: "a", childSessionId, description: "d", lineage: [], parentSessionId: "p",
    }, defaultConfig);
    if (state !== "active") {transitionState(store, childSessionId, state);}
    return store;
  }

  it("admits with no dependencies", () => {
    assert.deepStrictEqual(
      resolveDependencies(createTaskStore()),
      { ok: true }
    );
  });

  it("admits when deps completed", () => {
    const store = storeWith("s1", "completed"),
     s2 = createTaskStore();
    for (const [id, task] of store.retainedTasks) {s2.markRetained(id, task);}
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

describe("admission gate: there is no second key to ask for", () => {
  // Under lanes a dispatch named a lane, and the gate ran an ACCEPT-SET check over it:
  // Absent meant the default lane, a declared name was admitted, and a typo was
  // Refused with the list of lanes that do exist. That check existed only because the
  // Lane was a second key the operator had to keep in step with the agent — so it was
  // A second place to disagree about the same dispatch, and its refusal ("declare it
  // In the config") was advice that was stale the moment it was read.
  //
  // The key space is now the host's own registered agents, and `unknownAgent` above is
  // The one check on it. These cases pin what that leaves: an agent needs no
  // Declaration to be dispatchable, and an unrecognised one is refused against the
  // Host's list rather than a config's.
  const agents = toAgentRecords([{ name: "explore", permissions: [] }, { name: "general", permissions: [] }]);

  it("an agent nobody declared is admitted, because the key space is not the operator's", () => {
    admits(resolveAdmission(agents, "explore", [], normalizeDynamicTaskConfig({ maxConcurrent: 1 })),
      "a cap on another agent must not make this one undiscoverable");
  });

  it("an unrecognised agent is refused against the host's own list", () => {
    const result = resolveAdmission(agents, "typo", [], defaultConfig);
    refuses(result, "an agent the host does not publish is not dispatchable");
    said(result.reason?.refusal, '"typo"', "the refusal names the agent that was asked for");
    said(result.reason?.refusal, "explore", "and points at the agents that do exist");
  });

  it("the admission result carries no routing key at all", () => {
    // The record's `agentName` is the one field a slot is charged against. A second
    // One beside it could disagree with it, and a capped agent filled by children
    // Dispatched elsewhere is what that looks like.
    const result = resolveAdmission(agents, "explore", [], defaultConfig);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(Object.keys(result).toSorted(), ["agent", "newLineage", "ok"]);
  });
});

describe("admission gate: parseAgentList", () => {
  it("accepts bare arrays and drops nameless records", () => {
    const records = parseAgentList([
      { mode: "subagent", name: "explore", permissions: [] },
      { noName: true },
      null,
    ]);
    assert.deepStrictEqual(records.map((a) => a.name), ["explore"]);
  });

  it("normalises every field, so no reader has to ask the payload again", () => {
    const [agent] = parseAgentList([{ extra: 1, mode: "primary", name: "a", permissions: [{ action: NOTIFY_TOOL, resource: "*", effect: "deny" }] }]);
    assert.strictEqual(agent.mode, "primary");
    assert.deepStrictEqual(agent.permissions, [{ action: NOTIFY_TOOL, effect: "deny", resource: "*" }]);
    assert.ok(!("extra" in agent), "a field this plugin never asked for does not travel with the record");
  });

  it("drops a rule the host could not have sent", () => {
    const [agent] = parseAgentList([{ name: "a", permissions: [{ action: "x", resource: "*" }, { action: "y", effect: "maybe", resource: "*" }] }]);
    assert.deepStrictEqual(agent.permissions, [], "an unreadable rule is dropped, not guessed at");
  });

  it("rejects garbage", () => {
    for (const bad of [null, undefined, "str", 42, {}, { agents: "x" }, [{ noName: 1 }]]) {
      assertNoAgents(parseAgentList(bad), `nothing usable in ${JSON.stringify(bad)}`);
    }
  });
});

describe("admission gate: registerAdmittedTask", () => {

  it("registers through the funnel and enforces the concurrency limit", () => {
    const limited = singleSlotConfig(),
     store = createTaskStore(),
     task = registerAdmittedTask(store, childParams({ description: "t1", id: "ses_1" }), limited);
    assert.strictEqual(task.agentName, "explore");
    assert.throws(() => registerAdmittedTask(store, childParams({ description: "t2", id: "ses_2" }), limited), /Concurrency/);
  });
});

describe("agentCanNotify walks the host's ruleset, not a map", () => {
  const record = (permissions) => toAgentRecords([{ id: "general", mode: "subagent", name: "General", permissions }])[0];
  it("a partial-glob deny closes the channel", () => {
    const agent = record([{ action: "task_*", effect: "deny", resource: "*" }]);
    assert.strictEqual(agentCanNotify(agent, NOTIFY_TOOL), false);
  });
  it("the last match wins, so order is meaning", () => {
    const denyLast = record([
      { action: "*", effect: "allow", resource: "*" },
      { action: NOTIFY_TOOL, effect: "deny", resource: "*" },
    ]),
     allowLast = record([
      { action: NOTIFY_TOOL, effect: "deny", resource: "*" },
      { action: NOTIFY_TOOL, effect: "allow", resource: "*" },
    ]);
    assert.strictEqual(agentCanNotify(denyLast, NOTIFY_TOOL), false);
    assert.strictEqual(agentCanNotify(allowLast, NOTIFY_TOOL), true);
  });
  it("`?` is one char and dots are literal, like the host", () => {
    const q = record([{ action: "task_notif?", effect: "deny", resource: "*" }]);
    assert.strictEqual(agentCanNotify(q, NOTIFY_TOOL), false, "one ? matches the one trailing char");
    assert.strictEqual(agentCanNotify(q, "task_notif"), true, "no char, no match, ask means open");
    const dot = record([{ action: "task.notify", effect: "deny", resource: "*" }]);
    assert.strictEqual(agentCanNotify(dot, "taskXnotify"), true, "a dot is not any-char");
  });
  it("absent permissions arrive already denied; an explicit empty list stays open", () => {
    const absent = toAgentRecords([{ id: "g", mode: "subagent", name: "G" }])[0],
     empty = record([]);
    assert.strictEqual(agentCanNotify(absent, NOTIFY_TOOL), false, "the host denies what it was never given");
    assert.strictEqual(agentCanNotify(empty, NOTIFY_TOOL), true, "no rule matches, and no match is ask");
  });
});

describe("isDispatchableAgent hides what the host hides", () => {
  const record = (over) => toAgentRecords([{ id: "g", mode: "subagent", name: "G", permissions: [], ...over }])[0];
  it("a hidden subagent is not offered", () => {
    assert.strictEqual(isDispatchableAgent(record({ hidden: true })), false);
    assert.strictEqual(isDispatchableAgent(record({ hidden: false })), true);
    assert.strictEqual(isDispatchableAgent(record({})), true, "the field defaults the host's way");
  });
});
