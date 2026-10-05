/**
 * Admission.ts — the one gate a dispatch passes through.
 *
 * The agent list the host publishes, the rules a dispatch is admitted under, and
 * the dependency gate that holds one back. Every refusal a case asserts here is a
 * decision production made, so the helpers are the shared claim vocabulary rather
 * than a per-file ladder.
 */

import { admits, assertNoAgents, refuses, said } from "./support/assertions.js";
import { assert, describe, it } from "./support/runner.js";
import { blockingConfig, childParams, defaultConfig, singleSlotConfig } from "./support/fixtures.js";
import { createTaskStore, registerActiveTask, transitionState } from "../../dist/shared/task-state.js";
import { DEFAULT_AGENT_MODE, agentCanNotify, toAgentRecords, wildcardMatches } from "../../dist/shared/agent-record.js";
import { isDispatchableAgent } from "../../dist/shared/task-policy.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { registerAdmittedTask, resolveAdmission, resolveDependencies } from "../../dist/shared/admission.js";

// --- What the host publishes -------------------------------------------------
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
    const chainAgents = toAgentRecords([{ name: "architect", permissions: [] }, { name: "coder", permissions: [] }, { name: "explore", permissions: [] }]),
     capped = normalizeDynamicTaskConfig({ agents: { explore: { maxDepth: 2 } }, maxDepth: 5 });

    it("admits a chain the agent's cap allows, where the top-level cap would also allow", () => {
      admits(resolveAdmission(chainAgents, "explore", ["architect"], capped), "depth 1 into a cap of 2");
    });

    it("refuses past the agent's cap while the top-level cap has plenty of room", () => {
      const result = resolveAdmission(chainAgents, "explore", ["architect", "coder"], capped);
      refuses(result, "the agent's cap of 2 is spent at depth 2, and maxDepth 5 never applies");
      assert.match(result.reason.refusal, /agent "explore"/, "the refusal names the agent whose cap bound");
    });

    it("another agent's depth cap is not spent by this agent's chain", () => {
      // The thing a global cap could not do: `explore` capped at 1 is a direct child
      // And never nested, while `coder` still reaches the full depth. Under one global
      // Number these two were the same dial.
      const narrow = normalizeDynamicTaskConfig({ agents: { explore: { maxDepth: 1 } }, maxDepth: 3 });
      admits(resolveAdmission(chainAgents, "coder", ["architect", "explore"], narrow), "coder is uncapped, so the chain stands");
      refuses(resolveAdmission(chainAgents, "explore", ["architect"], narrow), "explore is a direct child only");
    });

    it("an agent that declares no depth of its own inherits the top-level cap", () => {
      const inherited = normalizeDynamicTaskConfig({ agents: { explore: { maxConcurrent: 3 } }, maxDepth: 2 });
      admits(resolveAdmission(chainAgents, "explore", ["architect"], inherited), "depth 1 of 2");
      refuses(resolveAdmission(chainAgents, "explore", ["architect", "coder"], inherited), "depth 2 is past the inherited cap of 2");
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

describe("admission gate: toAgentRecords", () => {
  it("accepts bare arrays and drops nameless records", () => {
    const records = toAgentRecords([
      { mode: "subagent", name: "explore", permissions: [] },
      { noName: true },
      null,
    ]);
    assert.deepStrictEqual(records.map((a) => a.name), ["explore"]);
  });

  it("normalises every field, so no reader has to ask the payload again", () => {
    const [agent] = toAgentRecords([{ extra: 1, mode: "primary", name: "a", permissions: [{ action: NOTIFY_TOOL, effect: "deny", resource: "*" }] }]);
    assert.strictEqual(agent.mode, "primary");
    assert.deepStrictEqual(agent.permissions, [{ action: NOTIFY_TOOL, effect: "deny", resource: "*" }]);
    assert.ok(!("extra" in agent), "a field this plugin never asked for does not travel with the record");
  });

  it("drops a rule the host could not have sent", () => {
    const [agent] = toAgentRecords([{ name: "a", permissions: [{ action: "x", resource: "*" }, { action: "y", effect: "maybe", resource: "*" }] }]);
    assert.deepStrictEqual(agent.permissions, [], "an unreadable rule is dropped, not guessed at");
  });

  it("rejects garbage", () => {
    for (const bad of [null, undefined, "str", 42, {}, { agents: "x" }, [{ noName: 1 }]]) {
      assertNoAgents(toAgentRecords(bad), `nothing usable in ${JSON.stringify(bad)}`);
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
  it("matcher flags follow the host, which makes them case-insensitive on win32 only", () => {
    // packages/core/src/util/wildcard.ts:13 — `process.platform === "win32" ? "si" : "s"`.
    // Hardcoding "s" made a case-differing rule deny here and match there, so the
    // answer differed by platform rather than by rule.
    assert.strictEqual(wildcardMatches("win32", NOTIFY_TOOL, "TASK_NOTIFY"), true);
    assert.strictEqual(wildcardMatches("darwin", NOTIFY_TOOL, "TASK_NOTIFY"), false);
    assert.strictEqual(wildcardMatches("linux", NOTIFY_TOOL, "task_*"), true, "every platform globs the same");
    const shouty = record([{ action: "TASK_NOTIFY", effect: "deny", resource: "*" }]);
    assert.strictEqual(
      agentCanNotify(shouty, NOTIFY_TOOL),
      !wildcardMatches(process.platform, NOTIFY_TOOL, "TASK_NOTIFY"),
      "no match is ask, so a case-sensitive platform leaves the channel open",
    );
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
