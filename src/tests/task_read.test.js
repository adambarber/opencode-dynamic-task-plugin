/**
 * task_result, task_status, task_list and task_interrupt — the read and stop
 * surface, against the real plugin.
 *
 * The read tools must never invent a status the sources did not state, and the
 * stop tool must stop a whole tree rather than the session it was handed. Both
 * are claims about absence as much as presence: "unknown" rather than "idle",
 * "a descendant was not acted on" rather than silence.
 */

import { describe, it } from "./support/runner.js";
import assert from "node:assert";
import { resultForChild, resultForUnreadableChild, setupHarness, sleep, statusReadCount, wasAborted, withChild, withDispatchTree, withSettledChild, withSettledDispatchTree } from "./support/harness.js";
import { events, hostSaid, unclockedSaid } from "./support/mock-host.js";
import { answerMatches, answerOmits, answerSays, assertNeedsSessionId, assertNoticeCount, noticeSays, stateOf, statusSays, stillActive } from "./support/assertions.js";
import { eventHarness } from "./support/integration.js";
import { API_UNAVAILABLE, NO_ASSISTANT_TEXT, SEE_ERROR_ABOVE } from "../../dist/shared/task-formatting.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";

/**
 * A child whose abort transport is down, settled — the arrangement behind both
 * "the gap is recorded" and "success is not annotated by a failed abort".
 */
async function withBrokenAbortSettledChild() {
  const h = await setupHarness({ hooks: { abortThrows: "ECONNREFUSED" } });
  const { id, c } = await h.spawn();
  await h.settle(id);
  return { h, c, id, out: await c.interrupt() };
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
      withChild, [["Status: active", true], ["Server status: busy", true], ["task_status", true], ["Tracked: yes", true]]],
    ["task_result never guesses a status from the message stream",
      withChild, [["suggests", false], ["Last child message", true], ["Last plugin event", true]]],
    ["task_result reports a settled state with no liveness noise when the server is quiet",
      withSettledChild, [["Status: completed", true], ["Server status", false], ["Last child message", false]]],
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
      async ({ c, id }) => {
        const out = await c.status();
        return [out, [[/Server status: busy/, true], [/Last child message: \d+s ago/, true]]];
      }],
    ["a just-steered turn waiting to start reads as pending, not as work in progress",
      async ({ c }) => {
        // The abort parks the turn on the server, so the status channel reads
        // idle until the replacement's first event — the exact window turn
        // attribution exists to cover.
        await c.steer("pivot");
        const out = await c.status();
        return [out, [[/Server status: idle/, true], [/replacement turn has not started/i, true], [/stalled/i, false]]];
      }],
    ["a store the server has stopped reporting is flagged, not read as work",
      async ({ h, c }) => {
        h.setHostStatus(c.id, "idle");
        const out = await c.status();
        return [out, [[/missed the ending/i, true], [/task_interrupt/, true]]];
      }],
    ["a settled child the server still calls busy says its settlement was premature",
      async ({ h, c }) => {
        await h.settle(c.id);
        h.setHostStatus(c.id, "busy");
        const out = await c.status();
        return [out, [[/Server status: busy/, true], [/still working/i, true]]];
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
    answerOmits(summary, "Server status", "no reading, no liveness block");
  });

  // Absence of a reading is not evidence of anything. The record renders; the
  // stall line may fire on the plugin's own clock, but nothing claims to know
  // what turn the server is on.
  it("a status channel that cannot be asked renders the record without a diagnosis", async () => {
    const { c } = await withChild({ harness: { hooks: { statusThrows: new Error("status down") } } });
    const status = await statusSays(c, "State: active");
    answerSays(status, "Last plugin event:", "the plugin's own clock still reads");
    answerOmits(status, "Server status", "an unanswered channel renders nothing");
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
      statusThrows: new Error("status down"),
      messages: () => [{ role: ASSISTANT_ROLE, parts: [{ type: "text", text: "working" }] }],
    });
    const summary = await h.tool.task_result.execute({ session_id: "ses_any" });
    answerSays(summary, "Status: unknown");
    answerOmits(summary, "Server status", "nothing was learned");
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

  it("task_interrupt requires a session id and names missing sessions", async () => {
    const h = await setupHarness();
    await assertNeedsSessionId(h.tool.task_interrupt);
    const missing = await eventHarness({ abortFailIds: new Set(["ses_ghost"]) });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    answerSays(out, "not found");
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
    noticeSays(h, 0, "completed successfully", "and it claims success");
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
      answerSays(out, member.id, "the report names ${member.id}");
      assert.ok((await stateOfMember(h, member.id)).includes("interrupted"), `${member.id} is stopped`);
    }
  });

  it("scope self stops only the session it was handed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id, scope: "self" });
    answerOmits(out, grandchild.id, "a descendant was not acted on, so it is not named");
    assert.ok((await stateOfMember(h, child.id)).includes("interrupted"), "the handed session is stopped");
    assert.ok((await stateOfMember(h, grandchild.id)).includes("active"), "the descendant is still running");
  });

  it("an unrecognized scope is refused, never silently widened or narrowed", async () => {
    const { h, child, grandchild } = await withDispatchTree();
    const out = await h.tool.task_interrupt.execute({ session_id: child.id, scope: "everything" });
    answerSays(out, "everything", "the rejected value is quoted back");
    answerSays(out, "subtree", "the choices are named");
    assert.ok((await stateOfMember(h, grandchild.id)).includes("active"), "nothing was stopped");
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
    const { h, child, grandchild } = await withDispatchTree();
    await h.settle(child.id);
    const out = await h.tool.task_interrupt.execute({ session_id: child.id });
    answerSays(out, "already settled as completed", "the root's own truth");
    answerSays(out, grandchild.id, "the live child below it is named");
    assert.ok((await stateOfMember(h, grandchild.id)).includes("interrupted"), "the grandchild is stopped");
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
    assert.ok((await stateOfMember(h, child.id)).includes("interrupted"), "the root is claimed");
    assert.ok((await stateOfMember(h, grandchild.id)).includes("interrupted"), "the descendant is claimed too, before any abort returned");
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
    });

  describe("the lanes line", () => {
    // Each case declares the agent set it is reasoning about, so the expected
    // depth follows from the case instead of from whatever the mock happens to
    // publish today.
    const AGENTS = [
      { name: "architect", mode: "subagent" },
      { name: "coder", mode: "subagent" },
      { name: "explore", mode: "subagent" },
    ];

    // One name for the three steps every case below is: build a harness, list,
    // hand back the text. Written out, it was the file's most-repeated block — and
    // because the repeated part was the arrangement rather than the decision, the
    // duplication gate reported pairs of cases that share nothing but their plumbing.
    const listed = async (options, hooks = { agentsList: AGENTS }) => {
      const h = await setupHarness({ options, hooks });
      return h.tool.task_list.execute({});
    };

    it("shows the default lane even with none declared, so a cap is always visible", async () => {
      const list = await listed({ maxDepth: 2 });
      answerSays(list, "Lanes (active/cap):", "the section is present with no lanes configured");
      assert.match(list, /- default 0\/4 · depth 2/, "occupancy, cap, and the depth in force");
    });

    it("counts a running task against the lane it was dispatched into", async () => {
      // Not `listed`, because the case is about what a SPAWN does to the count, so
      // it has to hold the harness to spawn through rather than have one built for it.
      const h = await setupHarness({ options: { lanes: { build: { maxConcurrent: 3 } } }, hooks: { agentsList: AGENTS } });
      await h.spawn({ description: "in the build lane", lane: "build" });
      assert.match(await h.tool.task_list.execute({}), /- build 1\/3/, "the task is charged to the lane it named");
    });

    it("names the constraint that caps depth, because the cap alone is not in force", async () => {
      // The config says 4 and the number in force is 3. Printing "4" would print
      // the number that does not apply.
      assert.match(await listed({ maxDepth: 4 }), /depth 3 \(agent set binds; cap is 4\)/,
        "the effective depth and the reason it is lower than the cap");
    });

    it("a BLOCKED agent cannot lengthen a chain, so it does not raise the depth", async () => {
      assert.match(await listed({ maxDepth: 9, blockedAgents: ["coder"] }), /depth 2 \(agent set binds; cap is 9\)/,
        "three published agents, one of them unusable, is depth 2 — not 3");
    });

    it("a host that cannot list agents leaves the depth UNKNOWN, not zero", async () => {
      assert.match(await listed({ maxDepth: 4 }, { agentsListThrows: true }), /depth 4 \(dispatchable agents unknown\)/,
        "an unreadable agent set is an unknown; saying 0 would claim no delegation is possible");
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
      assert.ok(/^- /.test(childLine), `a root sits flush. got: ${childLine}`);
      assert.ok(/^  - /.test(grandchildLine), `a descendant is indented under it. got: ${grandchildLine}`);
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
      await h.tool.task_list.execute({});
      assert.strictEqual(statusReadCount(h.client), 0, "a view of records the store already holds must not read the host");
    });
  });

  it("task_status details tracked tasks and unknowns", async () => {
    const h = await setupHarness();
    const { id, c } = await h.spawn({ description: "status probe" });
    const detail = await c.status();
    answerSays(detail, id);
    answerSays(detail, "explore");
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    answerSays(missing, "unknown");
    await assertNeedsSessionId(h.tool.task_status);
    });
});
