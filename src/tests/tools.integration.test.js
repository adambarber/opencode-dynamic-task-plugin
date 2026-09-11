/**
 * Tools integration — dynamic_task validation, task_continue branches,
 * task_result/task_interrupt paths, timeout-abort and init guards.
 *
 * Drives the REAL plugin (tool + event) with a hookable mock client.
 * Each test pins production behavior its path implements today; paths
 * scheduled for redesign say so in their names (Tasks 03/04 own them).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { resetAgentCache } from "../../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Hookable mock client --------------------------------------------------
// hooks: {
//   createThrowsOnce?: boolean,
//   promptFailIds?: Set<string>,         // async rejections
//   promptHangIds?: Set<string>,         // never-settling prompts (timeout branch)
//   promptSyncThrowIds?: Set<string>,    // synchronous throws (dead-session fork)
//   abortThrowsOnce?: boolean,
//   abortFailIds?: Set<string>,
//   getThrows?: Error,
// }
// Hook sets are read live: mutate them after setup to arm later phases.

function createToolsMock(hooks = {}) {
  const state = {
    sessions: new Set(),
    notifications: [],
    logs: [],
    aborted: [],
    questionCalls: [],
    createThrown: false,
    abortThrown: false,
  };

  const client = {
    _state: state,
    app: {
      agents: async () => [
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
        void body;
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
        if (text.includes("[dynamic-task-notify]")) {
          state.notifications.push({ to: path.id, message: text });
        }
        return Promise.resolve({ parts: [{ type: "text", text: "PROMPT_OK" }] });
      },
      messages: async () => [
        { role: "assistant", parts: [{ type: "text", text: "COMPLETED_OK" }] },
      ],
      get: async ({ path }) => {
        if (hooks.getThrows) throw hooks.getThrows;
        if (!state.sessions.has(path.id)) {
          const error = new Error(`Session "${path.id}" not found.`);
          error.status = 404;
          throw error;
        }
        return { status: "idle" };
      },
      abort: async ({ path }) => {
        if (hooks.abortThrowsOnce && !state.abortThrown) {
          state.abortThrown = true;
          throw new Error("abort failed");
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
      await ctx.harness.tool.task_interrupt.execute({ session_id: id });
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

async function setupTools(hooks = {}, options = {}) {
  const client = createToolsMock(hooks);
  resetAgentCache();
  const mod = await import("../../dist/index.js");
  const pluginFn = mod.default || mod;
  const result = await pluginFn(
    { client, directory: "/tmp" },
    { minTimeoutMs: 20, ...options },
  );
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  return { client, tool: result.tool, fireEvent: (event) => result.event({ event }) };
}

// --- Tests -----------------------------------------------------------------

describe("dynamic_task validation", () => {
  const ctx = useTrackedHarness();

  it("rejects missing subagent_type with the available list", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", prompt: "hi", await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("No subagent_type"), `got: ${out}`);
    assert.ok(out.includes("explore"), `lists agents. got: ${out}`);
  });

  it("rejects unknown agents", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "nope", prompt: "hi", await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(out.includes('Agent "nope" not found'), `got: ${out}`);
  });

  it("rejects missing and oversized prompts", async () => {
    const missing = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(missing.includes("Invalid prompt"), `got: ${missing}`);

    const long = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", prompt: "x".repeat(100001), await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
  });

  it("rejects blocked agents", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "general", prompt: "hi", await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("blocked"), `got: ${out}`);
  });

  it("rejects over the concurrency limit", async () => {
    const limited = await setupTools({}, { maxConcurrent: 1 });
    const first = await limited.tool.dynamic_task.execute(
      { description: "task one", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 300 },
      { sessionID: "p1" },
    );
    assert.ok(first.includes("in background"), `first must spawn. got: ${first}`);

    const second = await limited.tool.dynamic_task.execute(
      { description: "task two", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 300 },
      { sessionID: "p1" },
    );
    assert.ok(second.includes("ConcurrencyLimitExceeded"), `got: ${second}`);
    await limited.tool.task_interrupt.execute({ session_id: "ses_tools_1" });
  });

  it("surfaces session.create failures", async () => {
    const failing = await setupTools({ createThrowsOnce: true });
    const out = await failing.tool.dynamic_task.execute(
      { description: "task t", subagent_type: "explore", prompt: "hi", await_response: false },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("ERROR"), `got: ${out}`);
    assert.ok(out.includes("create failed"), `got: ${out}`);
  });

  it("warns once about async-by-default", async () => {
    // Short timeout: stray background handles must not outlive the suite.
    // await_response omitted: the deprecation path only fires on the default.
    const args = { description: "task t", subagent_type: "explore", prompt: "hi", timeout_ms: 300 };
    await ctx.harness.tool.dynamic_task.execute(args, { sessionID: "p1" });
    await ctx.harness.tool.dynamic_task.execute(args, { sessionID: "p1" });
    const warnings = ctx.harness.client._state.logs.filter((l) => l.message.includes("Deprecation"));
    assert.strictEqual(warnings.length, 1, "exactly one deprecation warning");
  });
});

describe("task_continue branches", () => {
  const ctx = useTrackedHarness();

  async function spawnBg(timeoutMs = 5000) {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: timeoutMs },
      { sessionID: "p1" },
    );
    const id = out.match(/Session: (\S+)/)[1];
    ctx.spawned.push(id);
    return id;
  }

  it("rejects missing args and oversized prompts", async () => {
    assert.ok((await ctx.harness.tool.task_continue.execute({})).includes("required"));
    const long = await ctx.harness.tool.task_continue.execute({
      session_id: "ses_tools_1",
      prompt: "x".repeat(100001),
    });
    assert.ok(long.includes("Prompt too long"), `got: ${long}`);
  });

  it("active continue returns the prompt result without waiting for events (single-wait)", async () => {
    const childId = await spawnBg();
    const out = await ctx.harness.tool.task_continue.execute({
      session_id: childId,
      prompt: "follow up",
      timeout_ms: 5000,
    });
    assert.ok(out.includes("Follow-up Response"), `got: ${out}`);
    assert.ok(out.includes("PROMPT_OK"), `uses the prompt result directly. got: ${out}`);
  });

  it("active continue times out when the child never answers", async () => {
    // Arm the hang AFTER spawn: the spawn-time prompt must succeed.
    const hooks = { promptHangIds: new Set() };
    const hanging = await setupTools(hooks);
    const out1 = await hanging.tool.dynamic_task.execute(
      { description: "hang task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out1.match(/Session: (\S+)/)[1];
    hooks.promptHangIds.add(childId);
    const out = await hanging.tool.task_continue.execute({
      session_id: childId,
      prompt: "follow up",
      timeout_ms: 60,
    });
    assert.ok(out.includes("Timed out"), `got: ${out}`);
    await hanging.tool.task_interrupt.execute({ session_id: childId });
  });

  it("retained continue reuses the live session", async () => {
    const childId = await spawnBg(60);
    await sleep(200);
    const out = await ctx.harness.tool.task_continue.execute({
      session_id: childId,
      prompt: "summarize",
      timeout_ms: 5000,
    });
    assert.ok(out.includes("Follow-up Response"), `got: ${out}`);
    assert.ok(out.includes("PROMPT_OK"), `reuses live session output. got: ${out}`);
  });

  it("retained continue on an async-dead session reports timeout (Task 07 owns continuation policy)", async () => {
    const dead = await setupTools({ promptFailIds: new Set(["ses_tools_1"]) });
    const out1 = await dead.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const oldId = out1.match(/Session: (\S+)/)[1];
    await sleep(200);

    const out = await dead.tool.task_continue.execute({
      session_id: oldId,
      prompt: "try again",
      timeout_ms: 5000,
    });
    assert.ok(out.includes("Timed out"), `got: ${out}`);
    assert.ok(out.includes(oldId), `names the dead session. got: ${out}`);
  });

  it("retained continue spawns a fresh session when prompt throws synchronously", async () => {
    const hooks = { promptSyncThrowIds: new Set() };
    const dead = await setupTools(hooks);
    const out1 = await dead.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const oldId = out1.match(/Session: (\S+)/)[1];
    await sleep(200);
    hooks.promptSyncThrowIds.add(oldId);

    const pending = dead.tool.task_continue.execute({
      session_id: oldId,
      prompt: "try again",
      timeout_ms: 5000,
    });
    await sleep(50);
    const sessions = [...dead.client._state.sessions];
    const newId = sessions.find((id) => id !== oldId);
    assert.ok(newId, "a continuation session must exist");
    await dead.fireEvent({
      type: "session.idle",
      properties: { sessionID: newId, status: "idle" },
    });
    const out = await pending;
    assert.ok(out.includes("new session"), `got: ${out}`);
    assert.ok(out.includes("PROMPT_OK"), `uses the prompt result directly. got: ${out}`);
    assert.ok(out.includes(oldId) && out.includes(newId), `links both sessions. got: ${out}`);
    await dead.tool.task_interrupt.execute({ session_id: newId });
  });

  it("unknown sessions resolve to unknown state", async () => {
    const out = await ctx.harness.tool.task_continue.execute({
      session_id: "ses_missing",
      prompt: "hello?",
    });
    assert.ok(out.includes("unknown"), `got: ${out}`);
  });
});

describe("task_result and task_interrupt paths", () => {
  const ctx = useTrackedHarness();

  it("task_result requires a session id", async () => {
    assert.ok((await ctx.harness.tool.task_result.execute({})).includes("required"));
  });

  it("task_result reports tracked active tasks", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    ctx.spawned.push(childId);
    const summary = await ctx.harness.tool.task_result.execute({ session_id: childId });
    assert.ok(summary.includes(childId), `got: ${summary}`);
    assert.ok(summary.includes("Tracked background task: yes"), `got: ${summary}`);
  });

  it("task_result maps API 404 to unknown", async () => {
    const summary = await ctx.harness.tool.task_result.execute({ session_id: "ses_gone" });
    assert.ok(summary.includes("unknown"), `got: ${summary}`);
  });

  it("task_result maps transport errors to error state", async () => {
    const failing = await setupTools({ getThrows: Object.assign(new Error("boom"), {}) });
    const summary = await failing.tool.task_result.execute({ session_id: "ses_any" });
    assert.ok(summary.includes('"error"') || summary.includes("error"), `got: ${summary}`);
  });

  it("task_interrupt aborts, reports, and untracks", async () => {
    const out = await ctx.harness.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    ctx.spawned.push(childId);
    const done = await ctx.harness.tool.task_interrupt.execute({ session_id: childId });
    assert.ok(done.includes("interrupted"), `got: ${done}`);
    assert.ok(ctx.harness.client._state.aborted.includes(childId), "abort must reach the API");
    // Interrupt removes the retained entry: the task is no longer tracked.
    const summary = await ctx.harness.tool.task_result.execute({ session_id: childId });
    assert.ok(summary.includes("Tracked background task: no"), `got: ${summary}`);
  });

  it("task_interrupt requires a session id and names missing sessions", async () => {
    assert.ok((await ctx.harness.tool.task_interrupt.execute({})).includes("required"));
    const missing = await setupTools({ abortFailIds: new Set(["ses_ghost"]) });
    const out = await missing.tool.task_interrupt.execute({ session_id: "ses_ghost" });
    assert.ok(out.includes("not found"), `got: ${out}`);
  });
});

describe("timeout, question and init guards", () => {
  it("background prompt failure notifies error promptly", async () => {
    // Arm the failure BEFORE spawn: the spawn id is deterministic per harness.
    const hooks = { promptFailIds: new Set(["ses_tools_1"]) };
    const failing = await setupTools(hooks);
    const out = await failing.tool.dynamic_task.execute(
      { description: "doomed task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await sleep(100);
    const notes = failing.client._state.notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 prompt error notification");
    assert.match(notes[0].message, /ended with an error/i, "error-kind notification");
    const summary = await failing.tool.task_result.execute({ session_id: childId });
    assert.ok(summary.includes("error"), `task must be retained as error. got: ${summary}`);
  });

  it("timeout still notifies when abort fails", async () => {
    const h = await setupTools({ abortThrowsOnce: true });
    const out = await h.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await sleep(250);
    assert.strictEqual(h.client._state.notifications.length, 1, "timeout must notify despite abort failure");
    await h.tool.task_interrupt.execute({ session_id: childId });
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

  async function spawnChild(timeoutMs = 5000) {
    const out = await harness.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: timeoutMs },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    spawned.push(childId);
    return childId;
  }

  it("answers from an active child are auto-answered with the first option", async () => {
    const childId = await spawnChild();
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q1", sessionID: childId, answers: [{ text: "yes" }, { text: "no" }] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1, "exactly one settlement");
    assert.deepStrictEqual(calls[0], { method: "reply", id: "q1", answer: "yes" });
    assert.strictEqual(harness.client._state.notifications.length, 0);
    await harness.fireEvent({ type: "question.replied", properties: { id: "q1" } });
  });

  it("answerless questions are rejected with follow-up guidance", async () => {
    const childId = await spawnChild();
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q2", sessionID: childId, answers: [] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "reject");
    assert.ok(calls[0].reason.includes("task_continue"), `got: ${calls[0].reason}`);
  });

  it("retained task questions are rejected with timeout guidance", async () => {
    const childId = await spawnChild(60);
    await sleep(200);
    await harness.fireEvent({
      type: "question.created",
      properties: { id: "q3", sessionID: childId, answers: [{ text: "yes" }] },
    });
    const calls = harness.client._state.questionCalls;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "reject");
    assert.ok(calls[0].reason.includes("timed out"), `got: ${calls[0].reason}`);
  });

  it("reply failure falls back to rejection", async () => {
    const failing = await setupTools({ questionReplyThrows: true });
    const out = await failing.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await failing.fireEvent({
      type: "question.created",
      properties: { id: "q4", sessionID: childId, answers: [{ text: "yes" }] },
    });
    const calls = failing.client._state.questionCalls;
    assert.ok(calls.some((c) => c.method === "reject"), "fallback rejection must fire");
    await failing.tool.task_interrupt.execute({ session_id: childId });
  });
});

describe("notification delivery records", () => {
  it("failed parent delivery is recorded and surfaced", async () => {
    const hooks = { promptFailIds: new Set(["p1"]) };
    const h = await setupTools(hooks);
    const out = await h.tool.dynamic_task.execute(
      { description: "doomed parent task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await sleep(700);
    assert.strictEqual(h.client._state.notifications.length, 0, "nothing delivered");
    const summary = await h.tool.task_result.execute({ session_id: childId });
    assert.ok(summary.includes("FAILED"), `delivery failure surfaced. got: ${summary}`);
    await h.tool.task_interrupt.execute({ session_id: childId });
  });

  it("late completion yields exactly one completed_after_timeout record", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "late task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await sleep(200);
    await h.fireEvent({
      type: "session.idle",
      properties: { sessionID: childId, status: "idle" },
    });
    const notes = h.client._state.notifications;
    assert.strictEqual(notes.length, 2, "timeout + late completion, exactly once each");
    assert.match(notes[1].message, /after an earlier timeout/);
    await h.tool.task_interrupt.execute({ session_id: childId });
  });
});

describe("timeout behavior modes", () => {
  function recordingDelegatingTimers() {
    const created = [];
    const cleared = [];
    return {
      created,
      cleared,
      provider: {
        setTimeout: (fn, ms, ...rest) => {
          const handle = setTimeout(fn, ms, ...rest);
          created.push(handle);
          return handle;
        },
        clearTimeout: (handle) => {
          cleared.push(handle);
          clearTimeout(handle);
        },
      },
    };
  }

  it("interrupt cancels the armed timeout", async () => {
    const rec = recordingDelegatingTimers();
    const h = await setupTools({}, { timerProvider: rec.provider });
    const out = await h.tool.dynamic_task.execute(
      { description: "timed task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    assert.ok(rec.created.length >= 1, "arm must be observable");
    await h.tool.task_interrupt.execute({ session_id: childId });
    assert.ok(
      rec.created.every((handle) => rec.cleared.includes(handle)),
      "every armed handle must be cancelled on interrupt",
    );
  });

  it("notify mode skips abort and still notifies", async () => {
    const h = await setupTools({}, { timeoutBehavior: "notify", minTimeoutMs: 20 });
    const out = await h.tool.dynamic_task.execute(
      { description: "notify task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await sleep(250);
    assert.strictEqual(h.client._state.notifications.length, 1);
    assert.strictEqual(h.client._state.aborted.length, 0, "notify mode must not abort");
    await h.tool.task_interrupt.execute({ session_id: childId });
  });
});
