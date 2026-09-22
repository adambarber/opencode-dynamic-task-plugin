/**
 * Tools integration — the non-blocking contract end to end.
 *
 * Drives the REAL plugin (tools + event handler) with a hookable mock
 * client. Settlement is event-driven: tests settle children by firing the
 * lifecycle events the server would fire, never by waiting on clocks.
 * Every spawn returns immediately; every notification arrives exactly
 * once per settled turn; task_notify is the child's general channel.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetAgentCache } from "../../dist/shared/admission.js";
import { clearNotifyLedger } from "../../dist/shared/notify.js";
import { resetQuestionSessions } from "../../dist/shared/question-handling.js";

// The notify gate is process-global by design (exactly-once delivery). Tests
// reuse deterministic child session ids across harnesses, so isolation resets
// it between tests — production never does.
beforeEach(() => { clearNotifyLedger(); resetQuestionSessions(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh temp project directory per harness: the ledger must follow the
// plugin's project directory (contamination regression, see suite below), so
// shared paths (/tmp, CWD) are forbidden as harness state roots.
function tmpProjectDir() {
  return mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));
}

// --- Hookable mock client --------------------------------------------------
// hooks: {
//   createThrowsOnce?: boolean,
//   promptFailIds?: Set<string>,         // async rejections
//   promptHangIds?: Set<string>,         // never-settling prompts (non-blocking proof)
//   promptSyncThrowIds?: Set<string>,    // synchronous throws
//   abortThrowsOnce?: boolean,
//   abortFailIds?: Set<string>,
//   getThrows?: Error,
//   questionReplyThrows?: boolean,
//   agentsList?: unknown[],
//   messages?: (args) => unknown[],
// }
// Hook sets are read live: mutate them after setup to arm later phases.

function createToolsMock(hooks = {}) {
  const state = {
    sessions: new Set(),
    notifications: [],
    logs: [],
    aborted: [],
    questionCalls: [],
    promptBodies: [],
    sessionBodies: new Map(),
    createThrown: false,
    abortThrown: false,
  };

  const client = {
    _state: state,
    app: {
      agents: async () => hooks.agentsList ?? [
        { name: "explore", mode: "subagent" },
        { name: "general", mode: "subagent" },
      ],
      log: async ({ body }) => {
        state.logs.push(body);
      },
    },
    question: {
      reply: async ({ path, body }) => {
        if (hooks.questionReplyThrows) throw new Error("reply failed");
        state.questionCalls.push({ method: "reply", id: path.id, ...body });
        return { ok: true };
      },
      reject: async ({ path, body }) => {
        if (hooks.questionRejectThrows) throw new Error("reject failed");
        state.questionCalls.push({ method: "reject", id: path.id, ...body });
        return { ok: true };
      },
    },
    session: {
      create: async ({ body }) => {
        if (hooks.createThrowsOnce && !state.createThrown) {
          state.createThrown = true;
          throw new Error("create failed");
        }
        const id = `ses_tools_${state.sessions.size + 1}`;
        state.sessions.add(id);
        state.sessionBodies.set(id, body);
        return { id };
      },
      prompt: ({ path, body }) => {
        if (hooks.promptSyncThrowIds?.has(path.id)) {
          throw new Error(`prompt sync-dead for ${path.id}`);
        }
        if (hooks.promptHangIds?.has(path.id)) {
          return new Promise(() => {});
        }
        if (hooks.promptFailIds?.has(path.id)) {
          return Promise.reject(new Error(`prompt failed for ${path.id}`));
        }
        const text = body?.parts?.[0]?.text || "";
        if (text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]")) {
          state.notifications.push({ to: path.id, message: text });
        } else {
          state.promptBodies.push({ to: path.id, body });
        }
        return Promise.resolve({ parts: [{ type: "text", text: "PROMPT_OK" }] });
      },
      messages: async ({ path }) =>
        hooks.messages?.({ path }) ?? [
          { role: "assistant", parts: [{ type: "text", text: "COMPLETED_OK" }] },
        ],
      get: async ({ path }) => {
        if (hooks.getThrows) throw hooks.getThrows;
        if (!state.sessions.has(path.id)) {
          const error = new Error(`Session "${path.id}" not found.`);
          error.status = 404;
          throw error;
        }
        // Production session.get() carries no status field — the mock must
        // not invent one (liveness reads fall through to the messages).
        return {};
      },
      abort: async ({ path }) => {
        if (hooks.abortThrowsOnce && !state.abortThrown) {
          state.abortThrown = true;
          throw new Error("abort failed");
        }
        if (!state.sessions.has(path.id)) {
          throw new Error(`Session "${path.id}" not found.`);
        }
        if (hooks.abortFailIds?.has(path.id)) {
          throw new Error(`Session "${path.id}" not found.`);
        }
        state.aborted.push(path.id);
        return { ok: true };
      },
    },
  };
  return client;
}

// Shared test-harness funnel: one way to release spawned sessions.
async function interruptSpawned(harness, spawned) {
  for (const id of spawned) {
    try {
      await harness.tool.task_interrupt.execute({ session_id: id });
    } catch {
      // Already settled.
    }
  }
}

// Shared lifecycle funnel: every tracked suite gets a fresh harness and
// releases its spawns the same way. beforeEach/afterEach register against
// the calling describe block.
function useTrackedHarness() {
  const ctx = { harness: null, spawned: [] };
  beforeEach(async () => {
    ctx.harness = await setupTools();
    ctx.spawned = [];
  });
  afterEach(async () => {
    await interruptSpawned(ctx.harness, ctx.spawned);
  });
  return ctx;
}

async function setupTools(hooks = {}, options = {}, directory = tmpProjectDir()) {
  const client = createToolsMock(hooks);
  resetAgentCache();
  const mod = await import("../../dist/index.js");
  const pluginFn = mod.default || mod;
  const result = await pluginFn({ client, directory }, options);
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  return { client, tool: result.tool, fireEvent: (event) => result.event({ event }) };
}

// Spawn funnel: every test gets its child the same way and parses the id
// from the same line the parent reads.
async function spawn(harness, args = {}, ctx = { sessionID: "p1" }) {
  const out = await harness.tool.dynamic_task.execute(
    { description: "bg task", subagent_type: "explore", prompt: "hi", ...args },
    ctx,
  );
  return { out, id: /Session: (\S+)/.exec(out)?.[1] };
}

// Settlement funnel: the only way a task settles in tests — the event the
// server would emit, delivered straight to the handler.
function settle(harness, id, type = "session.idle") {
  return harness.fireEvent({ type, properties: { sessionID: id, status: "idle" } });
}

// Shared two-turn harness: the message stream names each turn's output, and
// the FIRST parent notification fails so the gate's retry lands inside the
// test's timing window. Both claim-order/revival tests pin WHEN the revival
// lands against that retry; the harness itself is one thing.
async function setupTwoTurnHarness() {
  let msgCalls = 0;
  const h = await setupTools({
    messages: () => {
      msgCalls++;
      const text = msgCalls === 1 ? "TURN-ONE-OUTPUT" : "TURN-TWO-OUTPUT";
      return [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];
    },
  });
  const origPrompt = h.client.session.prompt;
  let parentNotifies = 0;
  h.client.session.prompt = (args) => {
    const text = args.body?.parts?.[0]?.text || "";
    if (text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]")) {
      parentNotifies++;
      if (parentNotifies === 1) return Promise.reject(new Error("parent busy"));
    }
    return origPrompt(args);
  };
  return h;
}

// --- Tests -----------------------------------------------------------------

describe("dynamic_task validation", () => {
  const ctx = useTrackedHarness();

  it("rejects missing subagent_type with the available list", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("No subagent_type"), `got: ${out}`);
    assert.ok(out.includes("explore"), `lists agents. got: ${out}`);
  });

  it("rejects unknown agents", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "nope", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes('Agent "nope" not found'), `got: ${out}`);
  });

  it("rejects missing and oversized prompts", async () => {
    const missing = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore" },
      { sessionID: "p1" },
    );
    assert.ok(missing.includes("Invalid prompt"), `got: ${missing}`);

    const long = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", prompt: "x".repeat(100001) },
      { sessionID: "p1" },
    );
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
  });

  it("rejects bare model ids at admission, before creating a session", async () => {
    const before = ctx.harness.client._state.sessions.size;
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", prompt: "hi", model: "GLM-5.3-Flash" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("Invalid model"), `got: ${out}`);
    assert.ok(out.includes("providerID/modelID"), `names the shape. got: ${out}`);
    assert.ok(out.includes("GLM-5.3-Flash"), `names the suspect. got: ${out}`);
    assert.strictEqual(ctx.harness.client._state.sessions.size, before, "no session created for a bad id");
  });

  it("echoes a qualified model in the spawn confirmation", async () => {
    const { out, id } = await spawn(ctx.harness, { model: "nvidia/z-ai/glm-5.3" });
    ctx.spawned.push(id);
    assert.ok(out.includes("Model: nvidia/z-ai/glm-5.3"), `got: ${out}`);
  });

  it("admits any agent by default — general dispatches", async () => {
    const { out, id } = await spawn(ctx.harness, { subagent_type: "general" });
    ctx.spawned.push(id);
    assert.ok(out.includes("@general"), `got: ${out}`);
  });

  it("rejects overlong descriptions at admission", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "x".repeat(3000), subagent_type: "explore", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("Description too long"), `labels stay short. got: ${out}`);
  });

  it("task_list names pruned expiries", async () => {
    const h = await setupTools({}, { retainedTaskTtlMs: 1 });
    const { id } = await spawn(h);
    await settle(h, id);
    await new Promise((r) => setTimeout(r, 5));
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes("Pruned: 1 expired"), `expiry is visible. got: ${list}`);
  });

  it("rejects blocked agents when the operator configures the blocklist", async () => {
    const h = await setupTools({}, { blockedAgents: ["general"] });
    const out = await h.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "general", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("blocked"), `got: ${out}`);
  });

  it("rejects over the concurrency limit", async () => {
    const limited = await setupTools({}, { maxConcurrent: 1 });
    const first = await spawn(limited, { description: "task one" });
    assert.ok(first.out.includes("in background"), `first must spawn. got: ${first.out}`);

    const second = await limited.tool.dynamic_task.execute(
      { description: "task two", subagent_type: "explore", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(second.includes("Cannot run more than"), `got: ${second}`);
    assert.ok(second.includes("task_list"), `points at the slot holders. got: ${second}`);
    await limited.tool.task_interrupt.execute({ session_id: first.id });
  });

  it("surfaces session.create failures", async () => {
    const failing = await setupTools({ createThrowsOnce: true });
    const out = await failing.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("ERROR"), `got: ${out}`);
    assert.ok(out.includes("create failed"), `got: ${out}`);
  });

  it("returns immediately even while the child prompt never settles", async () => {
    // The non-blocking promise, falsifiable: a hung child prompt must not
    // hold the spawn call. No clock can rescue this — there is no clock.
    const hooks = { promptHangIds: new Set() };
    const h = await setupTools(hooks);
    hooks.promptHangIds.add("ses_tools_1");
    const { out, id } = await spawn(h);
    assert.ok(out.includes("in background"), `got: ${out}`);
    assert.ok(id, "session id returned synchronously with the spawn line");
    assert.strictEqual(h.client._state.notifications.length, 0, "nothing settles without an event");
  });
});

describe("task_continue branches", () => {
  const ctx = useTrackedHarness();

  it("rejects missing args and oversized prompts", async () => {
    assert.ok((await ctx.harness.tool.task_continue.execute({})).includes("required"));
    const long = await ctx.harness.tool.task_continue.execute({
      session_id: "ses_tools_1",
      prompt: "x".repeat(100001),
    });
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
  });

  it("steers a still-running task — the turn stops and the message becomes the next turn", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    const out = await ctx.harness.tool.task_continue.execute({
      session_id: id,
      prompt: "follow up",
    });
    assert.ok(out.includes("Steer sent"), `got: ${out}`);
    assert.ok(out.includes("task_interrupt"), `names the stall recovery. got: ${out}`);
    assert.ok(ctx.harness.client._state.aborted.includes(id), "the running turn is stopped first");
    const followUps = ctx.harness.client._state.promptBodies.filter(
      (p) => p.to === id && p.body.parts[0].text.includes("follow up"),
    );
    assert.strictEqual(followUps.length, 1, "the message becomes the next turn");
    assert.ok(
      followUps[0].body.parts[0].text.includes("[Parent steer"),
      `framed as a preemption. got: ${followUps[0].body.parts[0].text}`,
    );
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `a steer never settles. got: ${status}`);
  });

  it("a steered turn's abort echo never settles the task, but the next genuine event does", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    await ctx.harness.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    await settle(ctx.harness, id);
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `the echo is consumed. got: ${status}`);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 0, "the echo notifies nothing");
    await settle(ctx.harness, id);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 1, "the genuine settlement delivers");
    assert.ok(ctx.harness.client._state.notifications[0].message.includes("completed successfully"));
  });

  it("a steer racing a completed settle auto-revives instead of demanding a second call", async () => {
    const h = await setupTools();
    const { id } = await spawn(h);
    let releaseAbort;
    const gate = new Promise((r) => { releaseAbort = r; });
    let firstAbort = true;
    const origAbort = h.client.session.abort;
    h.client.session.abort = (args) => {
      if (firstAbort) { firstAbort = false; return gate; }
      return origAbort(args);
    };
    const steer = h.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    await new Promise((r) => setTimeout(r, 10));
    await h.fireEvent({ type: "session.idle", properties: { sessionID: id, status: "idle" } });
    await h.fireEvent({ type: "session.idle", properties: { sessionID: id, status: "idle" } });
    releaseAbort();
    const out = await steer;
    assert.ok(out.includes("revived"), `closes the loop in one call. got: ${out}`);
    assert.strictEqual(
      h.client._state.promptBodies.filter((p) => p.body.parts[0].text === "pivot").length,
      1,
      "the message fires as the fresh turn",
    );
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("a task settling mid-steer never receives the replacement prompt", async () => {
    const h = await setupTools();
    const { id } = await spawn(h);
    let releaseAbort;
    const gate = new Promise((r) => { releaseAbort = r; });
    const origAbort = h.client.session.abort;
    let firstAbort = true;
    h.client.session.abort = (args) => {
      if (firstAbort) { firstAbort = false; return gate; }
      return origAbort(args);
    };
    const steer = h.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    await new Promise((r) => setTimeout(r, 10));
    await h.tool.task_interrupt.execute({ session_id: id });
    releaseAbort();
    const out = await steer;
    assert.ok(!out.includes("Steer sent"), `must not claim a steer that never happened. got: ${out}`);
    assert.ok(out.includes("interrupted"), `truthful report. got: ${out}`);
    assert.strictEqual(
      h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
      0,
      "no replacement prompt fires on a settled task",
    );
  });

  it("a steer racing a concurrent settlement reports the winner truthfully", async () => {
    const h = await setupTools();
    const { id } = await spawn(h);
    let releaseAbort;
    const gate = new Promise((r) => { releaseAbort = r; });
    let firstAbort = true;
    const origAbort = h.client.session.abort;
    h.client.session.abort = (args) => {
      if (firstAbort) {
        firstAbort = false;
        return gate.then(() => { throw new Error(`Session "${args.path.id}" not found.`); });
      }
      return origAbort(args);
    };
    const steer = h.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    await new Promise((r) => setTimeout(r, 10));
    await h.tool.task_interrupt.execute({ session_id: id });
    releaseAbort();
    const out = await steer;
    assert.ok(out.includes("interrupted"), `reports the actual winner. got: ${out}`);
    assert.ok(!out.includes("settled as error"), `no false error claim. got: ${out}`);
    assert.strictEqual(
      h.client._state.notifications.filter((n) => n.message.includes("Steer failed")).length,
      0,
      "no second notice over the winner's outcome",
    );
  });

  it("steer on a vanished session settles error instead of stranding", async () => {
    const h = await setupTools({ abortFailIds: new Set(["ses_tools_1"]) });
    const { id } = await spawn(h);
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    assert.ok(out.includes("not found"), `got: ${out}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("error"), `settled error, never stranded active. got: ${status}`);
  });

  it("a failed steer abort stays active and sends nothing", async () => {
    const h = await setupTools({ abortThrowsOnce: true });
    const { id } = await spawn(h);
    const out = await h.tool.task_continue.execute({ session_id: id, prompt: "pivot" });
    assert.ok(out.includes("abort failed"), `reports the gap. got: ${out}`);
    assert.ok(out.includes("active"), `admits the child may be live. got: ${out}`);
    assert.strictEqual(
      h.client._state.promptBodies.filter((p) => p.body.parts[0].text.includes("pivot")).length,
      0,
      "no competing prompt races the live turn",
    );
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `stays settable. got: ${status}`);
    await settle(h, id);
    assert.strictEqual(h.client._state.notifications.length, 1, "the live turn still settles");
  });

  it("revives a settled task and the new turn settles again", async () => {
    const { id } = await spawn(ctx.harness);
    await settle(ctx.harness, id);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 1, "first turn settles");

    const out = await ctx.harness.tool.task_continue.execute({
      session_id: id,
      prompt: "summarize",
    });
    assert.ok(out.includes("Follow-up sent"), `got: ${out}`);
    const followUps = ctx.harness.client._state.promptBodies.filter(
      (p) => p.to === id && p.body.parts[0].text.includes("summarize"),
    );
    assert.strictEqual(followUps.length, 1, "the same session is revived, not replaced");

    await settle(ctx.harness, id);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 2, "revival earns a fresh settlement");
    assert.ok(ctx.harness.client._state.notifications[1].message.includes("completed successfully"));
  });

  it("interrupted children are not revived — the guidance says spawn fresh", async () => {
    const { id } = await spawn(ctx.harness);
    await ctx.harness.tool.task_interrupt.execute({ session_id: id });
    const out = await ctx.harness.tool.task_continue.execute({ session_id: id, prompt: "again" });
    assert.ok(out.includes("not revived"), `got: ${out}`);
    assert.ok(out.includes("dynamic_task"), `points at the fresh-spawn path. got: ${out}`);
  });

  it("a revived turn does not wear the previous turn's notification", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    await settle(ctx.harness, id);
    await new Promise((r) => setTimeout(r, 10));
    await ctx.harness.tool.task_continue.execute({ session_id: id, prompt: "again" });
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(!status.includes("Last notification"), `new turn, nothing reported yet. got: ${status}`);
    const summary = await ctx.harness.tool.task_result.execute({ session_id: id });
    assert.ok(!summary.includes("Last notification"), `same for result reads. got: ${summary}`);
  });

  it("reviving with a model override reroutes and persists it", async () => {
    const { id } = await spawn(ctx.harness, { model: "nvidia/z-ai/glm-5.3" });
    ctx.spawned.push(id);
    await settle(ctx.harness, id);
    const out = await ctx.harness.tool.task_continue.execute({ session_id: id, prompt: "again", model: "other/thing-1" });
    assert.ok(out.includes("Follow-up sent"), `got: ${out}`);
    const routed = ctx.harness.client._state.promptBodies.filter((p) => p.to === id);
    assert.deepStrictEqual(routed[routed.length - 1].body.model, { providerID: "other", modelID: "thing-1" });
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("Model: other/thing-1"), `persists on the record. got: ${status}`);
  });

  it("a bare model on continue fails without touching the task", async () => {
    const { id } = await spawn(ctx.harness);
    await settle(ctx.harness, id);
    const before = ctx.harness.client._state.promptBodies.length;
    const out = await ctx.harness.tool.task_continue.execute({ session_id: id, prompt: "again", model: "bare-id" });
    assert.ok(out.includes("Invalid model"), `got: ${out}`);
    assert.strictEqual(ctx.harness.client._state.promptBodies.length, before, "no prompt fires");
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("completed"), `still settled. got: ${status}`);
  });

  it("unknown sessions are refused as untracked", async () => {
    const out = await ctx.harness.tool.task_continue.execute({
      session_id: "ses_missing",
      prompt: "hello?",
    });
    assert.ok(out.includes("not a tracked task"), `got: ${out}`);
  });
});

describe("task_notify: the child-to-parent channel", () => {
  const ctx = useTrackedHarness();

  it("delivers a mid-flight notice and leaves the task active", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    const out = await ctx.harness.tool.task_notify.execute(
      { message: "blocked: need DB credentials" },
      { sessionID: id },
    );
    assert.ok(out.includes("Message sent to parent"), `got: ${out}`);
    const notes = ctx.harness.client._state.notifications;
    assert.strictEqual(notes.length, 1);
    assert.ok(notes[0].to === "p1", "notice routes to the parent session");
    assert.ok(notes[0].message.includes("running child task"), `notice kind. got: ${notes[0].message}`);
    assert.ok(notes[0].message.includes("blocked: need DB credentials"));

    // A notice is not a settlement: the child still completes and reports.
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `task stays active. got: ${status}`);
    assert.ok(status.includes("need DB credentials"), `notice recorded on the task. got: ${status}`);

    await settle(ctx.harness, id);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 2, "settlement still reports");
  });

  it("distinct long notices sharing a prefix both deliver", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    const first = await ctx.harness.tool.task_notify.execute({ message: "a".repeat(200) + "1" }, { sessionID: id });
    const second = await ctx.harness.tool.task_notify.execute({ message: "a".repeat(200) + "2" }, { sessionID: id });
    assert.ok(first.includes("Message sent to parent"), `got: ${first}`);
    assert.ok(second.includes("Message sent to parent"), `prefix collision must not suppress. got: ${second}`);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 2);
  });

  it("a suppressed duplicate says to say something new", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    await ctx.harness.tool.task_notify.execute({ message: "still working" }, { sessionID: id });
    const again = await ctx.harness.tool.task_notify.execute({ message: "still working" }, { sessionID: id });
    assert.ok(again.includes("duplicate suppressed"), `keeps the kind. got: ${again}`);
    assert.ok(again.includes("Say something new"), `tells the child what to do. got: ${again}`);
  });

  it("an unreachable parent is reported distinctly from a duplicate", async () => {
    const h = await setupTools();
    const { id } = await spawn(h);
    const origPrompt = h.client.session.prompt;
    h.client.session.prompt = (args) => {
      if (args.path.id === "p1") return Promise.reject(new Error("parent down"));
      return origPrompt(args);
    };
    const out = await h.tool.task_notify.execute({ message: "hello?" }, { sessionID: id });
    assert.ok(out.includes("did not acknowledge"), `names the failure. got: ${out}`);
    assert.ok(!out.includes("duplicate"), `never confuses the two. got: ${out}`);
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("suppresses an identical repeated notice", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    await ctx.harness.tool.task_notify.execute({ message: "still working" }, { sessionID: id });
    const again = await ctx.harness.tool.task_notify.execute({ message: "still working" }, { sessionID: id });
    assert.ok(again.includes("duplicate suppressed") || again.includes("not sent"), `got: ${again}`);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 1);
  });

  it("a suppressed duplicate shows as Suppressed in task_result, never FAILED", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    await ctx.harness.tool.task_notify.execute({ message: "status: compiling" }, { sessionID: id });
    await ctx.harness.tool.task_notify.execute({ message: "status: compiling" }, { sessionID: id });
    const summary = await ctx.harness.tool.task_result.execute({ session_id: id });
    assert.ok(
      summary.includes("Suppressed (duplicate — already delivered)"),
      `the duplicate must read as suppression. got: ${summary}`,
    );
    assert.ok(!summary.includes("FAILED"), `suppression is not a delivery failure. got: ${summary}`);
  });

  it("refuses untracked callers and settled tasks", async () => {
    const stranger = await ctx.harness.tool.task_notify.execute({ message: "hi" }, { sessionID: "ses_stranger" });
    assert.ok(stranger.includes("Not a tracked task"), `got: ${stranger}`);

    const { id } = await spawn(ctx.harness);
    await settle(ctx.harness, id);
    const late = await ctx.harness.tool.task_notify.execute({ message: "too late" }, { sessionID: id });
    assert.ok(/settled/i.test(late), `got: ${late}`);
  });

  it("validates message shape and length", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    assert.ok((await ctx.harness.tool.task_notify.execute({ message: "  " }, { sessionID: id })).includes("required"));
    const long = await ctx.harness.tool.task_notify.execute({ message: "x".repeat(4001) }, { sessionID: id });
    assert.ok(long.includes("too long"), `got: ${long}`);
  });
});

describe("error settlement guidance", () => {
  async function settleWithMessageError(detail) {
    const h = await setupTools({
      messages: () => [{ info: { role: "assistant", error: { data: { message: detail } } }, parts: [] }],
    });
    const { id } = await spawn(h);
    await h.fireEvent({ type: "session.error", properties: { sessionID: id, status: "error" } });
    assert.strictEqual(h.client._state.notifications.length, 1, "error settles exactly once");
    return h.client._state.notifications[0].message;
  }

  it("transient error settlements name task_continue as the resume path", async () => {
    const note = await settleWithMessageError("429 rate limit exceeded, retry shortly");
    assert.ok(note.includes("transient"), `names the failure class. got: ${note}`);
    assert.ok(note.includes("task_continue"), `points at resume. got: ${note}`);
  });

  it("fatal error settlements carry no resume hint", async () => {
    const note = await settleWithMessageError("permission denied for model");
    assert.ok(note.includes("permission denied"), `keeps the cause. got: ${note}`);
    assert.ok(!note.includes("transient"), `no resume hint for fatal. got: ${note}`);
  });
});

describe("task_result and task_interrupt paths", () => {
  const ctx = useTrackedHarness();

  it("task_result requires a session id", async () => {
    assert.ok((await ctx.harness.tool.task_result.execute({})).includes("required"));
  });

  it("task_result reports store state for active tasks with the live read as advisory", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    const summary = await ctx.harness.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("Status: active"), `the store is authoritative. got: ${summary}`);
    assert.ok(summary.includes("Live inference"), `the API read stays advisory. got: ${summary}`);
    assert.ok(summary.includes("task_status"), `points at the store read. got: ${summary}`);
    assert.ok(summary.includes("Tracked: yes"), `got: ${summary}`);
  });

  it("live inference reads the message stream — production get() carries no status field", async () => {
    const { id } = await spawn(ctx.harness);
    ctx.spawned.push(id);
    const summary = await ctx.harness.tool.task_result.execute({ session_id: id });
    // One default assistant message with no status field reads busy (role
    // inference needs two) — crucially never the invented "idle" the old
    // mock returned for a shape production never emits.
    assert.ok(summary.includes("Session API suggests: busy"), `got: ${summary}`);
    assert.ok(!summary.includes("suggests: idle"), `no invented status. got: ${summary}`);
  });

  it("task_result reports settled state with no advisory block", async () => {
    const { id } = await spawn(ctx.harness);
    await settle(ctx.harness, id);
    const summary = await ctx.harness.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("Status: completed"), `got: ${summary}`);
    assert.ok(!summary.includes("Live inference"), `nothing to contradict once settled. got: ${summary}`);
  });

  it("task_result maps API 404 to unknown, in the same markdown voice", async () => {
    const summary = await ctx.harness.tool.task_result.execute({ session_id: "ses_gone" });
    assert.ok(summary.includes("Status: unknown"), `got: ${summary}`);
    assert.ok(summary.startsWith("## Task Result"), `one format for all reads. got: ${summary}`);
  });

  it("task_result maps transport errors to error state", async () => {
    const failing = await setupTools({ getThrows: Object.assign(new Error("boom"), {}) });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes('"error"') || summary.includes("error"), `got: ${summary}`);
  });

  it("interrupt on a settled task reports the settled state, not a fresh interrupt", async () => {
    const { id } = await spawn(ctx.harness);
    await settle(ctx.harness, id);
    const done = await ctx.harness.tool.task_interrupt.execute({ session_id: id });
    assert.ok(done.includes("already settled as completed"), `truthful report. got: ${done}`);
    assert.ok(!/^Session .* interrupted\.$/.test(done), `must not claim a fresh interrupt. got: ${done}`);
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("completed"), `history untouched. got: ${status}`);
  });

  it("task_interrupt settles as interrupted, preserves history, and reaches the API", async () => {
    const { id } = await spawn(ctx.harness);
    const done = await ctx.harness.tool.task_interrupt.execute({ session_id: id });
    assert.ok(done.includes("interrupted"), `got: ${done}`);
    assert.ok(ctx.harness.client._state.aborted.includes(id), "abort must reach the API");
    // P1a contract: the record survives (history preserved) and no event can
    // re-settle it — the synchronous claim happened BEFORE the abort.
    const status = await ctx.harness.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("interrupted"), `history preserved. got: ${status}`);
    await settle(ctx.harness, id);
    assert.strictEqual(ctx.harness.client._state.notifications.length, 0, "the abort's own idle event must not notify");
  });

  it("task_interrupt requires a session id and names missing sessions", async () => {
    assert.ok((await ctx.harness.tool.task_interrupt.execute({})).includes("required"));
    const missing = await setupTools({ abortFailIds: new Set(["ses_ghost"]) });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    assert.ok(out.includes("not found"), `got: ${out}`);
  });

  it("a failed abort leaves a live task active — the natural event still settles it", async () => {
    const h = await setupTools({ abortThrowsOnce: true });
    const { id } = await spawn(h);
    const out = await h.tool.task_interrupt.execute({ session_id: id });
    assert.ok(out.includes("abort failed"), `reports the abort gap. got: ${out}`);
    assert.ok(out.includes("active"), `admits the child may be live. got: ${out}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `speculative claim withdrawn. got: ${status}`);
    // The child's genuine terminal event still settles and notifies.
    await settle(h, id);
    assert.strictEqual(h.client._state.notifications.length, 1, "natural completion delivers");
    assert.ok(h.client._state.notifications[0].message.includes("completed successfully"));
  });

  it("a failed abort on a settled task records the gap without disturbing history", async () => {
    const h = await setupTools();
    h.client.session.abort = async () => { throw new Error("ECONNREFUSED"); };
    const { id } = await spawn(h);
    await settle(h, id);
    const out = await h.tool.task_interrupt.execute({ session_id: id });
    assert.ok(out.includes("already settled as completed"), `got: ${out}`);
    assert.ok(out.includes("ECONNREFUSED"), `gap recorded in the report. got: ${out}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("completed"), `got: ${status}`);
  });
});

describe("settlement: the notification layer owns outcomes", () => {
  it("parentless settlements leave a visible non-delivery record", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "orphan task", subagent_type: "explore", prompt: "hi" },
      {},
    );
    assert.ok(out.includes("notification: disabled"), `got: ${out}`);
    const id = /Session: (\S+)/.exec(out)?.[1];
    await settle(h, id);
    const summary = await h.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("FAILED") || summary.includes("delivered: false") || summary.includes("no parent"), `deafness must be distinguishable from silence. got: ${summary}`);
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("post-create registration failure notifies instead of stranding error", async () => {
    // Same-tick race through the advisory check: both spawns see an empty
    // slot, both create, the loser hits the authoritative register gate.
    const h = await setupTools({}, { maxConcurrent: 1 });
    const args = (description) => ({ description, subagent_type: "explore", prompt: "hi" });
    const [r1, r2] = await Promise.all([
      h.tool.dynamic_task.execute(args("racer one"), { sessionID: "p1" }),
      h.tool.dynamic_task.execute(args("racer two"), { sessionID: "p1" }),
    ]);
    assert.strictEqual([r1, r2].filter((r) => r.includes("in background")).length, 1, "one winner");
    assert.strictEqual([r1, r2].filter((r) => r.includes("ERROR")).length, 1, "one loser");
    const winner = /Session: (\S+)/.exec([r1, r2].find((r) => r.includes("in background")))?.[1];
    const loser = [...h.client._state.sessions].find((id) => id !== winner);
    assert.ok(loser, "loser session was created");
    assert.ok(h.client._state.aborted.includes(loser), `loser aborted, no orphan. aborted=${h.client._state.aborted}`);
    await sleep(50); // detached error-settlement delivery
    assert.strictEqual(h.client._state.notifications.length, 1, "the error settlement notifies");
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `error kind. got: ${note}`);
    await h.tool.task_interrupt.execute({ session_id: winner });
  });

  it("settlement does not hold the event pump on slow transport", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = await setupTools();
    const origPrompt = h.client.session.prompt;
    h.client.session.prompt = (args) => {
      const text = args.body?.parts?.[0]?.text || "";
      if (text.includes("[dynamic-task-notify]")) return gate;
      return origPrompt(args);
    };
    const { id } = await spawn(h);
    const settled = settle(h, id);
    const winner = await Promise.race([settled.then(() => "event"), sleep(500).then(() => "timeout")]);
    assert.strictEqual(winner, "event", "event handler must not wait for delivery transport");
    release();
    await settled;
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("background prompt failure settles as error and notifies once", async () => {
    const hooks = { promptFailIds: new Set(["ses_tools_1"]) };
    const failing = await setupTools(hooks);
    const { id } = await spawn(failing, { description: "doomed task" });
    await sleep(50); // the fire-and-forget catch schedules the settlement
    const notes = failing.client._state.notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 prompt error notification");
    assert.match(notes[0].message, /ended with an error/i, "error-kind notification");
    const summary = await failing.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("error"), `task must be retained as error. got: ${summary}`);
    // The lifecycle event that follows must not double-settle.
    await settle(failing, id);
    assert.strictEqual(notes.length, 1, "exactly-once survives a late idle");
  });

  it("repeated terminal events notify exactly once", async () => {
    const h = await setupTools();
    const { id } = await spawn(h);
    await settle(h, id);
    await settle(h, id);
    await settle(h, id, "session.status");
    assert.strictEqual(h.client._state.notifications.length, 1, "one settled turn, one notice");
  });

  it("unmatched question events are left untouched (fail-closed scoping)", async () => {
    const h = await setupTools();
    await h.fireEvent({ type: "question.created", properties: { id: "q1" } });
    await h.fireEvent({
      type: "question.created",
      properties: { id: "q9", sessionID: "ses_stranger", answers: [{ text: "yes" }] },
    });
    await h.fireEvent({ type: "question.replied", properties: { id: "q1" } });
    assert.strictEqual(h.client._state.notifications.length, 0, "no parent traffic for questions");
    assert.strictEqual(h.client._state.questionCalls.length, 0, "never touches foreign questions");
  });

  it("init guard disables the plugin without required client APIs", async () => {
    const mod = await import("../../dist/index.js");
    const pluginFn = mod.default || mod;
    const result = await pluginFn({ client: {}, directory: "/tmp" }, {});
    assert.deepStrictEqual(result, {});
  });
});

describe("question gate: child questions settle", () => {
  let harness;
  let spawned;

  beforeEach(async () => {
    harness = await setupTools();
    spawned = [];
  });

  afterEach(async () => {
    await interruptSpawned(harness, spawned);
  });

  it("answers from an active child are auto-answered with the first option", async () => {
    const { id } = await spawn(harness);
    spawned.push(id);
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q1", sessionID: id, answers: [{ text: "yes" }, { text: "no" }] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1, "exactly one settlement");
    assert.deepStrictEqual(calls[0], { method: "reply", id: "q1", answer: "yes" });
    assert.strictEqual(harness.client._state.notifications.length, 0);
    await harness.fireEvent({ type: "question.replied", properties: { id: "q1" } });
  });

  it("answerless questions are rejected with follow-up guidance", async () => {
    const { id } = await spawn(harness);
    spawned.push(id);
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q2", sessionID: id, answers: [] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "reject");
    assert.ok(calls[0].reason.includes("task_continue"), `got: ${calls[0].reason}`);
  });

  it("settled task questions are rejected with settled guidance", async () => {
    const { id } = await spawn(harness);
    spawned.push(id);
    await settle(harness, id);
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q3", sessionID: id, answers: [{ text: "yes" }] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "reject");
    assert.ok(calls[0].reason.includes("settled"), `got: ${calls[0].reason}`);
  });

  it("a failed retained rejection is logged as failed, never as rejected", async () => {
    const dir = tmpProjectDir();
    const prevDebug = process.env.DYNAMIC_TASK_DEBUG;
    process.env.DYNAMIC_TASK_DEBUG = "1";
    try {
      const h = await setupTools({ questionRejectThrows: true }, {}, dir);
      const { id } = await spawn(h);
      await settle(h, id);
      await h.fireEvent({
        type: "question.created",
        properties: { id: "q9", sessionID: id, answers: [{ text: "yes" }] },
      });
      const logFile = join(dir, ".dynamic-task-logs", `parent-p1__child-${id}.log`);
      assert.ok(existsSync(logFile), "retained question path must log");
      const log = readFileSync(logFile, "utf8");
      assert.ok(log.includes("question-retained-reject-failed"), `failure logged. got: ${log}`);
      assert.ok(!log.includes('"eventName":"question-retained-rejected"'), `must not claim rejection. got: ${log}`);
      await h.tool.task_interrupt.execute({ session_id: id });
    } finally {
      if (prevDebug !== undefined) process.env.DYNAMIC_TASK_DEBUG = prevDebug;
      else delete process.env.DYNAMIC_TASK_DEBUG;
    }
  });

  it("request_id linkage is forgotten on reply — no stale attribution", async () => {
    const h = await setupTools();
    const one = await spawn(h, { description: "first owner" });
    await h.fireEvent({
      type: "question.created",
      properties: { request_id: "q-stale", sessionID: one.id, answers: [{ text: "yes" }] },
    });
    assert.strictEqual(h.client._state.questionCalls.length, 1, "first question answered");
    // Reply arrives under request_id only (no id field).
    await h.fireEvent({ type: "question.replied", properties: { request_id: "q-stale" } });
    await h.tool.task_interrupt.execute({ session_id: one.id });
    const two = await spawn(h, { description: "second owner" });
    await h.fireEvent({
      type: "question.created",
      properties: { request_id: "q-stale", sessionID: two.id, answers: [{ text: "yes" }] },
    });
    const last = h.client._state.questionCalls[h.client._state.questionCalls.length - 1];
    assert.strictEqual(last.method, "reply", `stale linkage must not divert to the settled owner. got: ${JSON.stringify(last)}`);
    assert.strictEqual(last.id, "q-stale");
    await h.tool.task_interrupt.execute({ session_id: two.id });
  });

  it("reply failure falls back to rejection", async () => {
    const failing = await setupTools({ questionReplyThrows: true });
    const { id } = await spawn(failing);
    await failing.fireEvent({
      type: "question.created",
      properties: { id: "q4", sessionID: id, answers: [{ text: "yes" }] },
    });
    const calls = failing.client._state.questionCalls;
    assert.ok(calls.some((c) => c.method === "reject"), "fallback rejection must fire");
    await failing.tool.task_interrupt.execute({ session_id: id });
  });
});

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const hooks = { promptFailIds: new Set(["p1"]) };
    const h = await setupTools(hooks);
    const { id } = await spawn(h, { description: "doomed parent task" });
    await settle(h, id);
    assert.strictEqual(h.client._state.notifications.length, 0, "nothing delivered");
    await sleep(600); // detached delivery runs the gate's 250ms retry cycle
    const summary = await h.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("FAILED"), `delivery failure surfaced. got: ${summary}`);
  });

  it("a failed delivery does not consume the settlement — redelivery can succeed", async () => {
    // p1's prompt fails ONLY on the first attempt (child prompt ok, parent
    // notify attempt 1 fails, attempt 2 succeeds): the record is a history,
    // not a veto — exactly-once is about successful deliveries.
    let parentAttempts = 0;
    const h = await setupTools();
    const realPrompt = h.client.session.prompt;
    h.client.session.prompt = (args) => {
      if (args.path.id === "p1" && args.body?.parts?.[0]?.text.includes("[dynamic-task-notify]")) {
        parentAttempts++;
        if (parentAttempts === 1) return Promise.reject(new Error("parent busy"));
      }
      return realPrompt(args);
    };
    const { id } = await spawn(h);
    await settle(h, id);
    await sleep(500); // one retry cycle at the gate's fixed backoff
    assert.strictEqual(h.client._state.notifications.length, 1, "the retry delivered");
    const summary = await h.tool.task_result.execute({ session_id: id });
    assert.ok(summary.includes("completed"), `final record is a success. got: ${summary}`);
  });
});

describe("task fleet views", () => {
  it("task_list shows active and retained tasks", async () => {
    const h = await setupTools();
    const one = await spawn(h, { description: "fleet one" });
    const two = await spawn(h, { description: "fleet two" });
    await settle(h, two.id);
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes(one.id) && list.includes(two.id), `both fleets visible. got: ${list}`);
    assert.ok(list.includes("Active: 1/4"), `got: ${list}`);
    assert.ok(list.includes("Retained: 1"), `got: ${list}`);
    await h.tool.task_interrupt.execute({ session_id: one.id });
  });

  it("task_status details tracked tasks and unknowns", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "status probe" });
    const detail = await h.tool.task_status.execute({ session_id: id });
    assert.ok(detail.includes(id), `got: ${detail}`);
    assert.ok(detail.includes("explore"), `got: ${detail}`);
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    assert.ok(missing.includes("unknown"), `got: ${missing}`);
    assert.ok((await h.tool.task_status.execute({})).includes("required"));
    await h.tool.task_interrupt.execute({ session_id: id });
  });
});

describe("admission dependencies", () => {
  it("refuses until deps complete, admits after", async () => {
    const h = await setupTools();
    const a = await spawn(h, { description: "dep task" });

    const refused = await h.tool.dynamic_task.execute(
      { description: "blocked task", subagent_type: "explore", prompt: "hi", depends_on: [a.id] },
      { sessionID: "p1" },
    );
    assert.ok(refused.includes("Dependencies pending"), `got: ${refused}`);
    assert.ok(refused.includes(a.id));

    await settle(h, a.id);
    const admitted = await spawn(h, { description: "ready task", depends_on: [a.id] });
    assert.ok(admitted.out.includes("in background"), `got: ${admitted.out}`);
    await h.tool.task_interrupt.execute({ session_id: admitted.id });
  });

  it("names the blocking dep state, and depends_on_settled admits settled failures", async () => {
    const h = await setupTools();
    const a = await spawn(h, { description: "dep task" });
    await h.fireEvent({ type: "session.error", properties: { sessionID: a.id, status: "error" } });

    const refused = await h.tool.dynamic_task.execute(
      { description: "strict task", subagent_type: "explore", prompt: "hi", depends_on: [a.id] },
      { sessionID: "p1" },
    );
    assert.ok(refused.includes("Dependencies pending"), `got: ${refused}`);
    assert.ok(refused.includes(`${a.id} (error)`), `names the terminal state. got: ${refused}`);

    const admitted = await spawn(h, { description: "lenient task", depends_on_settled: [a.id] });
    assert.ok(admitted.out.includes("in background"), `settled failure satisfies. got: ${admitted.out}`);
    const status = await h.tool.task_status.execute({ session_id: admitted.id });
    assert.ok(status.includes(a.id), `the settled wait is recorded. got: ${status}`);
    await h.tool.task_interrupt.execute({ session_id: admitted.id });
  });

  it("unknown deps are treated as satisfied", async () => {
    const h = await setupTools();
    const { out, id } = await spawn(h, { description: "lone task", depends_on: ["ses_gone"] });
    assert.ok(out.includes("in background"), `got: ${out}`);
    await h.tool.task_interrupt.execute({ session_id: id });
  });
});

describe("admission lineage", () => {
  it("nested spawns inherit the parent lineage", async () => {
    const h = await setupTools({}, { blockedAgents: [] });
    const one = await spawn(h, { description: "parent task" });
    const two = await spawn(h, { description: "nested task", subagent_type: "general" }, { sessionID: one.id });
    assert.ok(two.out.includes("in background"), `nested spawn admitted. got: ${two.out}`);
    const status = await h.tool.task_status.execute({ session_id: two.id });
    assert.ok(status.includes("explore \u2192 general"), `parent chain visible. got: ${status}`);
    await h.tool.task_interrupt.execute({ session_id: one.id });
    await h.tool.task_interrupt.execute({ session_id: two.id });
  });

  it("same-agent nesting is admitted only with the recursion flag", async () => {
    const strict = await setupTools();
    const one = await spawn(strict, { description: "parent task" });
    const denied = await strict.tool.dynamic_task.execute(
      { description: "nested task", subagent_type: "explore", prompt: "hi" },
      { sessionID: one.id },
    );
    assert.ok(denied.includes("Recursive delegation blocked"), `got: ${denied}`);
    await strict.tool.task_interrupt.execute({ session_id: one.id });

    const lenient = await setupTools({}, { allowSameAgentRecursion: true });
    const two = await spawn(lenient, { description: "parent task" });
    const admitted = await spawn(
      lenient,
      { description: "nested task", subagent_type: "explore" },
      { sessionID: two.id },
    );
    assert.ok(admitted.out.includes("in background"), `flag honored. got: ${admitted.out}`);
    await lenient.tool.task_interrupt.execute({ session_id: two.id });
    await lenient.tool.task_interrupt.execute({ session_id: admitted.id });
  });
});

describe("prompt routing contract", () => {
  it("model override travels on the prompt, not the create call", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "model task", model: "prov/model-x" });
    await sleep(0); // the fire-and-forget prompt records one microtask later
    const created = h.client._state.sessionBodies.get(id);
    assert.ok(created && !("agent" in created) && !("model" in created), `create shape. got: ${JSON.stringify(created)}`);
    const bodies = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.ok(bodies.length >= 1, "child prompt recorded");
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.deepStrictEqual(bodies[0].body.model, { providerID: "prov", modelID: "model-x" });
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("prompts without override carry the agent and no model", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "plain task" });
    await sleep(0);
    const bodies = h.client._state.promptBodies.filter((p) => p.to === id);
    assert.ok(bodies.length >= 1);
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.ok(!("model" in bodies[0].body), `no model key. got: ${JSON.stringify(bodies[0].body)}`);
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("child prompts carry the background-task wrapper instructions", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { prompt: "Review for bugs" });
    await sleep(0);
    const text = h.client._state.promptBodies.find((p) => p.to === id).body.parts[0].text;
    assert.ok(text.includes("background child task"), `wrapped. got: ${text}`);
    assert.ok(text.includes("task_notify"), `teaches the notify channel. got: ${text}`);
    assert.ok(text.includes("Review for bugs"), `carries the payload. got: ${text}`);
    await h.tool.task_interrupt.execute({ session_id: id });
  });
});

// --- State scoping (contamination regression) -------------------------------
// Root cause of the poisoned repo ledger: persistence resolved against the
// process CWD, not the plugin's project directory. Pins: retained mutations
// write inside the directory the host provided, and the CWD is untouched.
describe("ledger follows the plugin directory, never the process cwd", () => {
  it("persists retained tasks under the provided directory only", async () => {
    const dir = tmpProjectDir();
    const cwdLedger = join(process.cwd(), ".dynamic-task-ledger.json");
    const cwdBefore = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;

    const h = await setupTools({}, {}, dir);
    const { id } = await spawn(h, { description: "scoped" });
    await settle(h, id);
    await sleep(30); // onRetainedChange fires synchronously; sleep is for CI, not the contract.

    const ledgerFile = join(dir, ".dynamic-task-ledger.json");
    assert.ok(existsSync(ledgerFile), "ledger must be written inside the plugin directory");
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.ok(ledger.tasks?.[id], "completed task must be retained in the project ledger");

    const cwdAfter = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;
    assert.strictEqual(cwdAfter, cwdBefore, "the suite must never create or mutate the cwd ledger");
  });
});

// ─── Outcome correctness (field repro 2026-09-11T19:30:00.485Z) ─────
// A provider 429 exhausts retries and the server emits session.error (payload
// in properties.error, NO status) plus a terminal idle. The message stream
// records the failure on the assistant message's info.error. The old handler
// read only event status paths, saw "", and told the parent "completed
// successfully" with "Latest output: (completed)". These tests pin the fix.

describe("outcome correctness: failed turns never report success", () => {
  const erroredMessages = () => [
    { info: { role: "user" }, parts: [] },
    {
      info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429, isRetryable: true } } },
      parts: [],
    },
  ];

  it("idle terminal event over an errored message stream notifies error, not success", async () => {
    const h = await setupTools({ messages: erroredMessages });
    const { id } = await spawn(h, { description: "A1 success-status axis" });
    await h.fireEvent({ type: "session.idle", properties: { sessionID: id } });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1, "exactly one parent notification");
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `must report error. got: ${note}`);
    assert.ok(note.includes("Too Many Requests"), `must carry provider detail. got: ${note}`);
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);

    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("error"), `task_status must show error. got: ${status}`);
  });

  it("session.error event notifies error even when hydration finds nothing", async () => {
    const h = await setupTools({ messages: () => [] });
    const { id } = await spawn(h, { description: "err evt" });
    await h.fireEvent({
      type: "session.error",
      properties: { sessionID: id, error: { name: "APIError", data: { message: "Too Many Requests" } } },
    });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `got: ${note}`);
  });

  it("a burst of terminal events notifies the parent exactly once", async () => {
    const h = await setupTools({ messages: erroredMessages });
    const { id } = await spawn(h, { description: "burst" });
    // The field log showed three terminal events within 1ms for one failure.
    await Promise.all([
      h.fireEvent({ type: "session.error", properties: { sessionID: id, error: { name: "APIError", data: { message: "Too Many Requests" } } } }),
      h.fireEvent({ type: "session.status", properties: { sessionID: id, status: "idle" } }),
      h.fireEvent({ type: "session.idle", properties: { sessionID: id } }),
    ]);
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1, "single winner must notify once");
    assert.ok(h.client._state.notifications[0].message.includes("ended with an error"));
  });

  it("deleted session with stale idle status notifies error, never success", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "vanishing child" });
    await h.fireEvent({ type: "session.deleted", properties: { sessionID: id, info: { status: "idle" } } });
    await sleep(30);
    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `vanished session is a failure. got: ${note}`);
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("error"), `state settles error. got: ${status}`);
  });

  it("a retryable prompt failure leaves the task active — its event settles it", async () => {
    // A transport blip (ETIMEDOUT) says nothing about the child: the turn may
    // well be running. Settling error here would deafen the ledger to the
    // child's genuine terminal event, so the task stays active and waits.
    const h = await setupTools();
    const realPrompt = h.client.session.prompt;
    let firstChildPrompt = true;
    h.client.session.prompt = (args) => {
      const text = args.body?.parts?.[0]?.text || "";
      if (firstChildPrompt && !text.includes("[dynamic-task-notify]")) {
        firstChildPrompt = false;
        return Promise.reject(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
      }
      return realPrompt(args);
    };
    const { id } = await spawn(h, { description: "blip child" });
    await sleep(50); // the fire-and-forget catch has run
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("active"), `retryable failure must not settle. got: ${status}`);
    assert.strictEqual(h.client._state.notifications.length, 0, "no error notification for a retryable blip");

    await settle(h, id);
    await sleep(30);
    assert.strictEqual(h.client._state.notifications.length, 1, "the genuine terminal event settles it");
    assert.ok(h.client._state.notifications[0].message.includes("completed successfully"));
    await h.tool.task_interrupt.execute({ session_id: id });
  });

  it("a revived turn is never suppressed by its predecessor's late retry", async () => {
    // The poisoning window: turn 1's delivery fails attempt 1, the operator
    // continues before the 250ms retry resolves, and the retry then succeeds —
    // an in-flight commit from the old generation must not reserve the key
    // that turn 2's settlement needs.
    const h = await setupTwoTurnHarness();
    const { id } = await spawn(h, { prompt: "turn one" });
    await settle(h, id); // attempt 1 fails; the retry is armed at the fixed backoff
    const cont = await h.tool.task_continue.execute({ session_id: id, prompt: "turn two" });
    assert.ok(cont.includes("Follow-up sent"), `got: ${cont}`);
    await sleep(350); // the stale retry lands and commits while the revival is live
    await settle(h, id);
    await sleep(30);
    const notes = h.client._state.notifications;
    assert.strictEqual(notes.length, 2, `both turns deliver. got: ${notes.length}`);
    assert.ok(notes[0].message.includes("TURN-ONE-OUTPUT"), `order preserved. first: ${notes[0]?.message}`);
    assert.ok(notes[1].message.includes("TURN-TWO-OUTPUT"), `revival never suppressed. second: ${notes[1]?.message}`);
  });

  it("turns settle in claim order — a stale retry never jumps a new turn", async () => {
    // Same harness, opposite timing: the revival lands BEFORE the retry
    // resolves, so serialization — not generations — carries the order.
    const h = await setupTwoTurnHarness();
    const { id } = await spawn(h, { prompt: "turn one" });
    await settle(h, id);
    const cont = await h.tool.task_continue.execute({ session_id: id, prompt: "turn two" });
    assert.ok(cont.includes("Follow-up sent"));
    await settle(h, id);
    await sleep(600);
    const notes = h.client._state.notifications;
    assert.strictEqual(notes.length, 2, `both turns deliver. got: ${notes.length}`);
    assert.ok(notes[0].message.includes("TURN-ONE-OUTPUT"), `turn order preserved. first: ${notes[0]?.message}`);
    assert.ok(notes[1].message.includes("TURN-TWO-OUTPUT"), `second: ${notes[1]?.message}`);
  });

  it("concurrent interrupts converge on interrupted, never stuck-active", async () => {
    let releaseAbort1;
    const gate = new Promise((resolve) => { releaseAbort1 = resolve; });
    let calls = 0;
    const h = await setupTools();
    h.client.session.abort = async () => {
      calls++;
      if (calls === 1) { await gate; throw new Error("ECONNREFUSED"); }
      return { ok: true };
    };
    const { id } = await spawn(h);
    const p1 = h.tool.task_interrupt.execute({ session_id: id });
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await h.tool.task_interrupt.execute({ session_id: id });
    releaseAbort1();
    await p1;
    assert.ok(!r2.includes("not a tracked task"), `second interrupt sees the tracked task. got: ${r2}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("interrupted"), `converges interrupted. got: ${status}`);
  });

  it("boot restore honors the configured retention cap", async () => {
    const dir = tmpProjectDir();
    const prev = process.env.DYNAMIC_TASK_RETAINED_MAX_ENTRIES;
    process.env.DYNAMIC_TASK_RETAINED_MAX_ENTRIES = "2";
    try {
      const now = Date.now();
      const tasks = {};
      for (let i = 1; i <= 4; i++) {
        tasks[`ses_boot${i}`] = {
          childSessionId: `ses_boot${i}`, parentSessionId: "p", agentName: "explore",
          description: "d", lineage: [], state: "completed", startedAt: now - 1000, retainedAt: now - i,
        };
      }
      writeFileSync(join(dir, ".dynamic-task-ledger.json"), JSON.stringify({ version: 2, tasks }));
      const h = await setupTools({}, {}, dir);
      const list = await h.tool.task_list.execute({});
      assert.ok(list.includes("Retained: 2"), `configured cap honored. got: ${list}`);
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_TASK_RETAINED_MAX_ENTRIES = prev;
      else delete process.env.DYNAMIC_TASK_RETAINED_MAX_ENTRIES;
    }
  });

  it("abort failure on a completed task reports the gap without annotating success", async () => {
    const h = await setupTools();
    h.client.session.abort = async () => { throw new Error("ECONNREFUSED"); };
    const { id } = await spawn(h);
    await settle(h, id);
    const out = await h.tool.task_interrupt.execute({ session_id: id });
    assert.ok(out.includes("already settled as completed"), `got: ${out}`);
    assert.ok(out.includes("ECONNREFUSED"), `gap reported. got: ${out}`);
    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(!status.includes("Abort error"), `success record stays clean. got: ${status}`);
  });

  it("clean completions still report success unchanged", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "clean" });
    await settle(h, id);
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("completed successfully"), `got: ${note}`);
    assert.ok(note.includes("COMPLETED_OK"), `carries assistant text. got: ${note}`);
  });

  it("a deleted session settles as error, never as success", async () => {
    const h = await setupTools();
    const { id } = await spawn(h, { description: "deleted child" });
    await h.fireEvent({ type: "session.deleted", properties: { sessionID: id } });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `deletion is a failure. got: ${note}`);
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);
  });
});

describe("spawn resilience: no untracked child survives a failure", () => {
  it("a concurrency rejection leaves no orphan session behind", async () => {
    const h = await setupTools({}, { maxConcurrent: 1 });
    const first = await spawn(h, { description: "one" });
    const before = new Set(h.client._state.sessions);

    const second = await h.tool.dynamic_task.execute(
      { description: "two", subagent_type: "explore", prompt: "hi" },
      { sessionID: "p1" },
    );
    assert.ok(/cannot run more than|cannot register|concurrency|limit/i.test(second), `must reject. got: ${second}`);

    // Orphan-free invariant: any session the rejection created must be
    // aborted. (A pre-create check that never creates also passes.)
    const created = [...h.client._state.sessions].filter((id) => !before.has(id));
    for (const id of created) {
      assert.ok(h.client._state.aborted.includes(id), `orphan ${id} must be aborted`);
    }
    await h.tool.task_interrupt.execute({ session_id: first.id });
  });

  it("task_interrupt reports the server 404 without lingering active state", async () => {
    const h = await setupTools({ abortFailIds: new Set(["ses_tools_1"]) });
    const { id } = await spawn(h, { description: "ghost" });

    const res = await h.tool.task_interrupt.execute({ session_id: id });
    assert.ok(/not found/i.test(res), `reports the server 404. got: ${res}`);

    const status = await h.tool.task_status.execute({ session_id: id });
    assert.ok(status.includes("interrupted"), `settled as intended. got: ${status}`);
  });

  it("a sync-throwing prompt failure settles the task out of active", async () => {
    const hooks = { promptSyncThrowIds: new Set(["ses_tools_1"]) };
    const h = await setupTools(hooks);
    // The spawn line still returns — create succeeded; the prompt throws
    // synchronously inside the fire-and-forget path, which owns the settle.
    const { out } = await spawn(h, { description: "sync fail" });
    assert.ok(out.includes("in background"), `spawn reports success first. got: ${out}`);
    await sleep(50);
    const status = await h.tool.task_status.execute({ session_id: "ses_tools_1" });
    assert.ok(!/\[active\]|state: active|Status: active/.test(status), `must not linger active. got: ${status}`);
    assert.ok(status.includes("error"), `settled as error. got: ${status}`);
  });
});
