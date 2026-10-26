/**
 * task_result, task_status, task_list and task_interrupt — the read and stop
 * surface, against the real plugin.
 *
 * The read tools must never invent a status the sources did not state, and the
 * stop tool must stop a whole tree rather than the session it was handed. Both
 * are claims about absence as much as presence: "unknown" rather than "idle",
 * "a descendant was not acted on" rather than silence.
 */

import { isSessionMissing } from "../../dist/shared/liveness.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { API_UNAVAILABLE, NO_ASSISTANT_TEXT, SEE_ERROR_ABOVE } from "../../dist/shared/task-formatting.js";
import { answerMatches, answerOmits, answerSays, assert, assertNeedsSessionId, assertNoticeCount, describe, eventHarness, hostSaid, it, resultForChild, resultForUnreadableChild, setupHarness, sleep, stateOf, statusSays, stillActive, textDeclaresKind, unclockedSaid, wasAborted, withChild, withDispatchTree, withSettledChild, withSettledDispatchTree, withSettledMiddleChild } from "./support/index.js";

/**
 * A child whose abort transport is down, settled — the arrangement behind both
 * "the gap is recorded" and "success is not annotated by a failed abort".
 */
async function withBrokenAbortSettledChild() {
  const h = await setupHarness({ hooks: { abortThrows: "ECONNREFUSED" } });
  const { id, c } = await h.spawn();
  await h.settle(id);
  return { c, h, id, out: await c.interrupt() };
}

describe("task_result and task_interrupt paths", () => {

  it("task_result requires a session id", async () => {
    const h = await setupHarness();
    await assertNeedsSessionId(h.tool.task_result);
  });

  // One hypothesis: task_result reports the STORE's state, and the liveness read
  // underneath it is the SERVER's own word plus the child's own last message —
  // never a guess about message shapes. Each case names the fragments that must
  // (or must not) be in the report for its state.
  const reports = [
    ["task_result reports store state for active tasks with the server's liveness beside it",
      withChild, [["Status: active", true], ["Server turn: in progress", true], ["task_status", true], ["Tracked: yes", true]]],
    ["task_result never guesses a status from the message stream",
      withChild, [["suggests", false], ["Last child message", true], ["Last plugin event", true]]],
    ["task_result reports a settled state with no liveness noise when the server is quiet",
      withSettledChild, [["Status: completed", true], ["Server turn", false], ["Last child message", false]]],
  ];
  for (const [name, scenario, expectations] of reports) {
    it(name, async () => {
      const { c } = await scenario();
      const summary = await c.result();
      for (const [fragment, present] of expectations) {
        assert.ok(
          summary.includes(fragment) === present,
          `${present ? "must" : "must not"} contain ${fragment}. got: ${summary}`,
        );
      }
    });
  }

  // Liveness is a four-way question and each answer names its own source, so a
  // reader can never take "active" for "working" or a stall for a store that
  // simply has not been told. The two failure modes are the ones that produce
  // wrong recoveries: waiting on a dead child, and interrupting a live one.
  const liveness = [
    ["a running child reads the server's word and the child's own last message",
      async ({ c }) => {
        const out = await c.status();
        return [out, [[/Server turn: in progress/, true], [/Last child message: \d+s ago/, true]]];
      }],
    ["a just-steered turn waiting to start reads as pending, not as work in progress",
      async ({ c }) => {
        // The abort parks the turn, and the host DELETES a parked turn from its status
        // map — so the channel answers, and its answer is that it lists nothing. That is
        // the window turn attribution exists to cover, and it is not the word `idle`:
        // a fake that stored `idle` here is the lie this whole fix removed.
        await c.steer("pivot");
        const out = await c.status();
        return [out, [[/Server turn: interrupted/, true], [/replacement turn has not started/i, true], [/stalled/i, false]]];
      }],
    ["a store the server has stopped reporting is flagged, not read as work",
      async ({ h, c }) => {
        h.setHostStatus(c.id, "succeeded");
        const out = await c.status();
        return [out, [[/missed the ending/i, true], [/task_interrupt/, true]]];
      }],
    ["a settled child the server still calls busy says its settlement was premature",
      async ({ h, c }) => {
        await h.settle(c.id);
        h.setHostStatus(c.id, "open");
        const out = await c.status();
        return [out, [[/Server turn: in progress/, true], [/still working/i, true]]];
      }],
  ];
  for (const [name, read] of liveness) {
    it(name, async () => {
      const ctx = await withChild();
      const [out, expectations] = await read(ctx);
      for (const [pattern, present] of expectations) {
        assert.ok(
          pattern.test(out) === present,
          `${present ? "must" : "must not"} match ${pattern}. got: ${out}`,
        );
      }
    });
  }

  it("task_result maps API 404 to unknown, in the same markdown voice", async () => {
    const h = await setupHarness();
    const summary = await h.tool.task_result.execute({ session_id: "ses_gone" });
    answerSays(summary, "Status: unknown");
    assert.ok(summary.startsWith("## Task Result"), `one format for all reads. got: ${summary}`);
    // The fake must reject the way the host rejects, or this test proves the
    // reader against a shape production never sees — which is how an untracked
    // session once read as a network error under a green suite.
    const rejection = await h.client.session.context({ sessionID: "ses_gone" }).then(
      () => null,
      (error) => error,
    );
    assert.ok(isSessionMissing(rejection), "the fake's not-found is a shape the reader reads");
    });

  // The read that fails is the one the tool actually makes. A transport
  // failure is reported as an error status, never as a quiet success.
  it("task_result maps a failed read to error state", async () => {
    const failing = await setupHarness({ hooks: { messages: () => { throw new Error("boom"); } } });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: error");
    answerSays(summary, "boom", "the cause rides along");
    answerSays(summary, SEE_ERROR_ABOVE, "an empty Latest block points at the error rather than pretending");
    });

  it("a tracked task whose read fails still reports the store's own state", async () => {
    const summary = await resultForUnreadableChild();
    answerSays(summary, "Status: active", "the store is the authority");
    answerSays(summary, API_UNAVAILABLE, "the failed read says so");
    answerOmits(summary, "Server turn", "no reading, no liveness block");
  });

  // Absence of a reading is not evidence of anything. The record renders; the
  // stall line may fire on the plugin's own clock, but nothing claims to know
  // what turn the server is on.
  it("a status channel that cannot be asked renders the record without a diagnosis", async () => {
    const { c } = await withChild({ harness: { hooks: { presenceThrows: new Error("status down") } } });
    const status = await statusSays(c, "State: active");
    answerSays(status, "Last plugin event:", "the plugin's own clock still reads");
    // A channel that failed is named as failed, and is NOT reported as one that
    // answered and found nothing: the reader has to be able to tell "the server has
    // no turn" from "nobody could ask", because those need different responses.
    answerSays(status, "the host did not answer", "the gap is named as a gap");
    answerOmits(status, "in progress", "an unread channel is not an open turn either");
    answerOmits(status, "missed the ending", "no reading, no verdict");
  });

  // What a child's *written* output is reported as when there is none to
  // report. One arrangement — a child whose single message carries no clock and
  // no assistant text, which is exactly what a plugin booted mid-turn sees —
  // and the two lines that must state the absence rather than invent it.
  const nothingWritten = [
    ["no message times", "Last child message: (none yet)"],
    ["no assistant text", NO_ASSISTANT_TEXT],
  ];
  for (const [name, expected] of nothingWritten) {
    it(`a child with ${name} says so rather than guessing an age`, async () => {
      const summary = await resultForChild([unclockedSaid()]);
      answerSays(summary, expected, "no invention");
    });
  }

  // The message list is `{ info, parts }` per item — the clock lives on `info`.
  // Reading `time` off the item is not a crash: it renders as "this child has
  // never written a message", which is what a live smoke test caught on a child
  // that had written three.
  it("a child's last message time comes off the message's info, not the item", async () => {
    const writtenAt = Date.now() - 45_000;
    const summary = await resultForChild([hostSaid("done", writtenAt)]);
    answerMatches(summary, /Last child message: 4[0-9]s ago/, "the child's own clock");
  });

  // No record to reconcile and no server word: the only honest status is the
  // absence of one. Reporting "completed" here is how a caller resumes a
  // session that is still working.
  it("an untracked session with no status channel is unknown, not idle", async () => {
    const h = await eventHarness({
      messages: () => [{ parts: [{ text: "working", type: "text" }], role: ASSISTANT_ROLE }],
      presenceThrows: new Error("status down"),
    });
    const summary = await h.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: unknown");
    // The gap is named, and it is not dressed up as the host having said the session
    // lists nothing — that inference ends children, so it must not reach a reader.
    answerSays(summary, "the host did not answer");
    answerOmits(summary, "in progress", "an unread channel is not an open turn");
  });

  it("a retryable transport failure says so", async () => {
    const refused = await setupHarness({ hooks: { messages: () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    } } });
    const summary = await refused.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: error");
    answerSays(summary, "(retryable)", "a refused connection is worth retrying");
  });

  it("interrupt on a settled task reports the settled state, not a fresh interrupt", async () => {
    const { c } = await withSettledChild();
    const done = await c.interrupt();
    answerSays(done, "already settled as completed", "truthful report");
    assert.ok(!/^Session .* interrupted\.$/.test(done), `must not claim a fresh interrupt. got: ${done}`);
    assert.strictEqual(await stateOf(c), "State: completed", "history untouched");
  });

  it("task_interrupt settles as interrupted, preserves history, and reaches the API", async () => {
    const { h, c, id } = await withChild();
    const done = await c.interrupt();
    answerSays(done, "interrupted");
    assert.ok(wasAborted(h.client, id), "abort must reach the API");
    // P1a contract: the record survives (history preserved) and no event can
    // re-settle it — the synchronous claim happened BEFORE the abort.
    assert.strictEqual(await stateOf(c), "State: interrupted", "history preserved");
    await h.settle(id);
    assertNoticeCount(h, 0, "the abort's own idle event must not notify");
  });

  it("task_interrupt requires a session id and refuses one it never dispatched", async () => {
    const h = await setupHarness();
    await assertNeedsSessionId(h.tool.task_interrupt);
    const missing = await eventHarness({ abortFailIds: new Set(["ses_ghost"]) });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    // It used to ask the server about it and report the 404 as `not found`, which
    // read as a legitimate answer about the session. The host is not asked at all
    // now: a session this plugin did not dispatch is refused before any transport is
    // touched, so the answer says so and names what it is not — see the abort
    // ownership suite for the request-level claim. The 404 hook stays because a
    // refusal must hold when the server would have answered.
    answerSays(out, "ses_ghost", "names the session it will not touch");
    answerSays(out, "not a session this plugin dispatched");
    assert.deepStrictEqual(
      missing.client.testState.abortAttempts,
      [],
      "the server must never be asked about a session this plugin did not start",
    );
  });

  it("a failed abort leaves a live task active — the natural event still settles it", async () => {
    const { h, c, id } = await withChild({ harness: { hooks: { abortThrowsOnce: true } } });
    const out = await c.interrupt();
    answerSays(out, "abort failed", "reports the abort gap");
    answerSays(out, "active", "admits the child may be live");
    await stillActive(c, "speculative claim withdrawn");
    // The child's genuine terminal event still settles and notifies.
    await h.settle(id);
    assertNoticeCount(h, 1, "natural completion delivers");
    textDeclaresKind(h.noticeBodies()[0], "completed", "and the natural event settles completed");
  });

  it("a failed abort on a settled task records the gap without disturbing history", async () => {
    const { c, out } = await withBrokenAbortSettledChild();
    answerSays(out, "already settled as completed");
    answerSays(out, "ECONNREFUSED", "gap recorded in the report");
    const status = await statusSays(c, "completed");
    answerOmits(status, "Abort error", "a success record stays clean");
    });
});

// A dispatch is a tree, so an interrupt that stops only the session it was
// handed reports success while a descendant keeps spending tokens. Each case
// names the set the plugin acted on, and each member's own truth.
//
// Two levels is the deepest tree reachable today (see withDispatchTree); the
// walk is depth-agnostic, so nothing here is written to two levels.
describe("subtree interrupt: stopping a task stops everything under it", () => {
  // The state of one member of the tree, read through the same bound-child
  // handle every other case uses — so there is one way to ask a task its state.
  const stateOfMember = (h, id) => stateOf(h.child(id));

  it("one interrupt stops the whole tree and names every member", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    for (const member of [child, grandchild]) {
      answerSays(out, member.id, `the report names ${member.id}`);
      const memberState = await stateOfMember(h, member.id);
      assert.ok(memberState.includes("interrupted"), `${member.id} is stopped`);
    }
  });

  it("scope self stops only the session it was handed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ scope: "self", session_id: child.id });
    answerOmits(out, grandchild.id, "a descendant was not acted on, so it is not named");
    const childState = await stateOfMember(h, child.id);
    assert.ok(childState.includes("interrupted"), "the handed session is stopped");
    const grandchildState = await stateOfMember(h, grandchild.id);
    assert.ok(grandchildState.includes("active"), "the descendant is still running");
  });

  it("an unrecognized scope is refused, never silently widened or narrowed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ scope: "everything", session_id: child.id });
    answerSays(out, "everything", "the rejected value is quoted back");
    answerSays(out, "subtree", "the choices are named");
    const grandchildState = await stateOfMember(h, grandchild.id);
    assert.ok(grandchildState.includes("active"), "nothing was stopped");
  });

  it("a settled descendant is not named: there was nothing to stop there", async () => {
    const { h, child, grandchild } = await withSettledDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    answerOmits(out, grandchild.id, "the finished child is not re-aborted");
    answerSays(out, child.id, "the task the caller named is still answered");
  });

  // The walk starts at the named session whatever state it is in, so a
  // finished parent is not a wall: the grandchild it left running is exactly
  // the work an interrupt is for, and reporting only "already settled" would
  // hand back a clean answer over work that is still spending tokens.
  it("a settled task still has a live child below it, and the child is stopped", async () => {
    const { h, child, grandchild } = await withSettledMiddleChild();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    answerSays(out, "already settled as completed", "the root's own truth");
    answerSays(out, grandchild.id, "the live child below it is named");
    const grandchildState = await stateOfMember(h, grandchild.id);
    assert.ok(grandchildState.includes("interrupted"), "the grandchild is stopped");
  });

  // The claim is what orders the echoes: a terminal event for a task whose
  // interrupt claim has already been taken finds settled history instead of
  // an active record, so it cannot report a completion the parent was just
  // told about. With claims taken one abort at a time, the descendant is
  // still active while the first abort is in flight — and this is the window
  // the ordering makes unrepresentable.
  it("the whole tree is claimed before the first abort reaches the server", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const gate = h.client.gateAbort();
    const pass = h.tool.task_interrupt.execute({ session_id: child.id });
    await sleep(30);
    const rootState = await stateOfMember(h, child.id);
    assert.ok(rootState.includes("interrupted"), "the root is claimed");
    const grandchildState = await stateOfMember(h, grandchild.id);
    assert.ok(grandchildState.includes("interrupted"), "the descendant is claimed too, before any abort returned");
    gate.release();
    await pass;
  });
});

describe("task fleet views", () => {
  it("task_list shows active and retained tasks", async () => {
    const h = await setupHarness();
    const one = await h.spawn({ description: "fleet one" });
    const two = await h.spawn({ description: "fleet two" });
    await h.settle(two.id);
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes(one.id) && list.includes(two.id), "both fleets visible");
    answerSays(list, "Active: 1/4");
    answerSays(list, "Retained: 1");
    answerSays(list, "@Explore", "rows read the stored label, not the routing id");
    });

  describe("the agents line", () => {
    // Each case declares the agent set it is reasoning about, so the expected
    // depth follows from the case instead of from whatever the mock happens to
    // publish today.
    const AGENTS = [
      { mode: "subagent", name: "architect", permissions: [] },
      { mode: "subagent", name: "coder", permissions: [] },
      { mode: "subagent", name: "explore", permissions: [] },
    ];

    // One name for the three steps every case below is: build a harness, list,
    // hand back the text. Written out, it was the file's most-repeated block — and
    // because the repeated part was the arrangement rather than the decision, the
    // duplication gate reported pairs of cases that share nothing but their plumbing.
    const listed = async (options, hooks = { agentsList: AGENTS }) => {
      const h = await setupHarness({ hooks, options });
      return h.tool.task_list.execute({});
    };

    /**
     * The agents section of a list, as its own lines, so a case states the config and
     * not a string it is hunting for.
     *
     * Cut at the blank line, not at the end of the text: the section is one of three
     * and a helper that ran on would make a case about depth assert over the retained
     * block too — which passes while saying nothing about the row it was written for.
     */
    const agentsLine = async (options, hooks) => {
      const list = await listed(options, hooks);
      const at = list.indexOf("Agents (active/cap):");
      assert.notEqual(at, -1, "the agents line is present");
      const rest = list.slice(at + "Agents (active/cap):".length);
      return rest.split("\n").slice(1).filter(Boolean).slice(0, rest.split("\n").slice(1).indexOf(""));
    };

    /**
     * This config must produce exactly this agents line, and say why if it does not.
     *
     * The claim, not the string, is the point — so the expected lines are built from
     * the same cap numbers the config carries rather than typed out, and a change to
     * the row's spelling fails one place with one message instead of three.
     */
    const expectAgentsLine = async (options, expected, why, hooks) =>
      assert.deepEqual(await agentsLine(options, hooks), expected, why);

    it("shows every REGISTERED agent even with nothing capped, so a cap is always visible", async () => {
      // The whole point of keying by agent: the rows come from the host's own set, so
      // the line is populated on a project that has never been configured. Under lanes
      // this could only show a "default" row standing in for one nobody had declared.
      await expectAgentsLine({ maxDepth: 2 },
        AGENTS.map((agent) => `- ${agent.name} 0/4 at once · depth 2`),
        "occupancy, cap, and the depth in force, for every agent the host publishes, and nothing else");
    });

    it("counts a running task against the AGENT it was dispatched as", async () => {
      // Not `listed`, because the case is about what a SPAWN does to the count, so
      // it has to hold the harness to spawn through rather than have one built for it.
      const h = await setupHarness({ hooks: { agentsList: AGENTS }, options: { agents: { explore: { maxConcurrent: 3 } } } });
      await h.spawn({ description: "an explore child" });
      const list = await h.tool.task_list.execute({});
      assert.match(list, /- explore 1\/3/, "the task is charged to the agent it ran as");
      assert.match(list, /- coder 0\/4/, "and no other agent is charged for it — a cap is not a shared pool");
    });

    it("names the constraint that caps depth, because the cap alone is not in force", async () => {
      // The config says 4 and the number in force is 3. Printing "4" would print
      // the number that does not apply.
      assert.match(await listed({ maxDepth: 4 }), /depth 3 \(agent set binds; cap is 4\)/,
        "the effective depth and the reason it is lower than the cap");
    });

    it("a BLOCKED agent cannot lengthen a chain, so it does not raise the depth", async () => {
      assert.match(await listed({ blockedAgents: ["coder"], maxDepth: 9 }), /depth 2 \(agent set binds; cap is 9\)/,
        "three published agents, one of them unusable, is depth 2 — not 3");
    });

    it("a host that cannot list agents leaves the depth UNKNOWN, not zero", async () => {
      // Stated on an agent the overlay caps, because that is the only case where a row
      // exists at all: with a failed read and nothing capped there is no agent to report
      // on, and the line is simply absent rather than reporting a depth of nothing.
      const config = { agents: { explore: { maxDepth: 4 } }, maxDepth: 4 };
      const lines = await agentsLine(config, { agentsListThrows: true });
      assert.deepEqual(lines, [`- explore 0/4 at once (yours) · depth ${config.maxDepth} (dispatchable agents unknown)`],
        "an unreadable agent set is an unknown; saying 0 would claim no delegation is possible");
      assert.doesNotMatch(lines.join("\n"), /depth 0/, "and 0 is the specific number that must never stand in for it");
    });
  });

  // A fleet view that hides its own expiries reads as "nothing expired", so the
  // prune is part of the view's claim rather than bookkeeping behind it.
  it("task_list names pruned expiries", async () => {
    const { h } = await withSettledChild({ harness: { options: { retainedTaskTtlMs: 1 } } });
    await sleep(5);
    const list = await h.tool.task_list.execute({});
    answerSays(list, "Pruned: 1 expired", "expiry is visible");
  });

  // A dispatch is a tree, and the flat list hid that: the one fact that
  // decides HOW to stop a runaway task — it is a grandchild, not a sibling —
  // was in the store and in no view. The tree costs no extra host read, because
  // the store already holds every edge.
  describe("the running fleet renders as the tree it is", () => {
    const lineFor = (list, sessionId) =>
      list.split("\n").find((line) => line.includes(sessionId)) ?? `(no line for ${sessionId})`;

    it("a grandchild is shown under the task that spawned it", async () => {
      const { h, child, grandchild } = await withDispatchTree();
      const list = await h.tool.task_list.execute({});
      const childLine = lineFor(list, child.id);
      const grandchildLine = lineFor(list, grandchild.id);
      assert.ok(childLine.startsWith("- "), `a root sits flush. got: ${childLine}`);
      assert.ok(grandchildLine.startsWith("  - "), `a descendant is indented under it. got: ${grandchildLine}`);
    });

    it("a finished task is history, not part of the running tree", async () => {
      const { h, child, grandchild } = await withSettledDispatchTree();
      const list = await h.tool.task_list.execute({});
      answerSays(list, "Active: 1/4", "one task is still running");
      const section = list.slice(0, list.indexOf("Retained:"));
      answerSays(section, child.id, "the running task is there");
      answerOmits(section, grandchild.id, "the finished one is not in the tree");
      answerSays(list, grandchild.id, "history still has it");
    });

    // Retention prunes finished records. When the pruned task is the parent of
    // something still running, the child cannot be indented under a row that
    // is gone — so it names the parent it lost instead of reading as a root.
    // A root is a task whose parent nobody has stopped.
    it("a pruned parent is named, never silently dropped from the tree", async () => {
      const { h, child, grandchild } = await withDispatchTree({ options: { retainedTaskTtlMs: 1 } });
      await h.settle(child.id);
      await sleep(10);
      const list = await h.tool.task_list.execute({});
      answerSays(list, "Pruned: 1", "the prune is reported");
      const grandchildLine = lineFor(list, grandchild.id);
      answerSays(grandchildLine, `spawned by ${child.id}, not tracked`, "the severed link is named");
      answerSays(list, "Active: 1/4", "the child is still the one running task");
    });

    it("the tree spends no host read", async () => {
      const { h } = await withDispatchTree();
      const before = h.transcriptReads();
      await h.tool.task_list.execute({});
      assert.strictEqual(h.transcriptReads(), before, "a view of records the store already holds must not read the host");
    });
  });

  it("task_status details tracked tasks and unknowns", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "status probe" });
    const detail = await c.status();
    answerSays(detail, id);
    answerSays(detail, "Agent: Explore", "the status names the label");
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    answerSays(missing, "unknown");
    await assertNeedsSessionId(h.tool.task_status);
    });
});
