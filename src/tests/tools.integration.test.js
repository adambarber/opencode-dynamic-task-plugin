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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetAgentCache } from "../../dist/index.js";

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
        if (text.includes("[dynamic-task-notify]")) {
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

async function setupTools(hooks = {}, options = {}, directory = tmpProjectDir()) {
  const client = createToolsMock(hooks);
  resetAgentCache();
  const mod = await import("../../dist/index.js");
  const pluginFn = mod.default || mod;
  const result = await pluginFn(
    { client, directory },
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

  async function continueDeadAndSettle(dead, oldId) {
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
    assert.ok(out.includes(oldId) && out.includes(newId), `links both sessions. got: ${out}`);
    return { out, newId };
  }

  it("retained continue on an async-dead session re-admits and spawns anew", async () => {
    const dead = await setupTools({ promptFailIds: new Set(["ses_tools_1"]) });
    const out1 = await dead.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const oldId = out1.match(/Session: (\S+)/)[1];
    await sleep(200);
    const { newId } = await continueDeadAndSettle(dead, oldId);
    await dead.tool.task_interrupt.execute({ session_id: newId });
  });

  it("dead continuation with a vanished agent is refused, not spawned", async () => {
    const hooks = { promptFailIds: new Set(["ses_tools_1"]), agentsList: undefined };
    const dead = await setupTools(hooks);
    const out1 = await dead.tool.dynamic_task.execute(
      { description: "bg task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const oldId = out1.match(/Session: (\S+)/)[1];
    await sleep(200);
    // Registry drift: the agent is gone and the cache is cleared.
    hooks.agentsList = [];
    resetAgentCache();
    const out = await dead.tool.task_continue.execute({
      session_id: oldId,
      prompt: "try again",
      timeout_ms: 5000,
    });
    assert.ok(out.includes("not found"), `refusal names the cause. got: ${out}`);
    assert.ok(out.includes(oldId), `names the dead session. got: ${out}`);
    assert.strictEqual(dead.client._state.sessions.size, 1, "no continuation spawned");
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

    const { out, newId } = await continueDeadAndSettle(dead, oldId);
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

describe("task fleet views", () => {
  it("task_list shows active and retained tasks", async () => {
    const h = await setupTools();
    const out1 = await h.tool.dynamic_task.execute(
      { description: "fleet one", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const id1 = out1.match(/Session: (\S+)/)[1];
    const out2 = await h.tool.dynamic_task.execute(
      { description: "fleet two", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60 },
      { sessionID: "p1" },
    );
    const id2 = out2.match(/Session: (\S+)/)[1];
    await sleep(200);
    const list = await h.tool.task_list.execute({});
    assert.ok(list.includes(id1) && list.includes(id2), `both fleets visible. got: ${list}`);
    assert.ok(list.includes("Active background"), `got: ${list}`);
    await h.tool.task_interrupt.execute({ session_id: id1 });
    await h.tool.task_interrupt.execute({ session_id: id2 });
  });

  it("task_status details tracked tasks and unknowns", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "status probe", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    const detail = await h.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes(childId), `got: ${detail}`);
    assert.ok(detail.includes("explore"), `got: ${detail}`);
    const missing = await h.tool.task_status.execute({ session_id: "ses_ghost" });
    assert.ok(missing.includes("unknown"), `got: ${missing}`);
    assert.ok((await h.tool.task_status.execute({})).includes("required"));
    await h.tool.task_interrupt.execute({ session_id: childId });
  });
});

describe("admission dependencies", () => {
  it("refuses until deps complete, admits after", async () => {
    const h = await setupTools();
    const outA = await h.tool.dynamic_task.execute(
      { description: "dep task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const idA = outA.match(/Session: (\S+)/)[1];

    const refused = await h.tool.dynamic_task.execute(
      { description: "blocked task", subagent_type: "explore", prompt: "hi", await_response: false, depends_on: [idA] },
      { sessionID: "p1" },
    );
    assert.ok(refused.includes("Dependencies pending"), `got: ${refused}`);
    assert.ok(refused.includes(idA));

    await h.fireEvent({ type: "session.idle", properties: { sessionID: idA, status: "idle" } });
    const admitted = await h.tool.dynamic_task.execute(
      { description: "ready task", subagent_type: "explore", prompt: "hi", await_response: false, depends_on: [idA] },
      { sessionID: "p1" },
    );
    assert.ok(admitted.includes("in background"), `got: ${admitted}`);
    await h.tool.task_interrupt.execute({ session_id: idA });
    await h.tool.task_interrupt.execute({ session_id: admitted.match(/Session: (\S+)/)[1] });
  });

  it("unknown deps are treated as satisfied", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "lone task", subagent_type: "explore", prompt: "hi", await_response: false, depends_on: ["ses_gone"] },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("in background"), `got: ${out}`);
    await h.tool.task_interrupt.execute({ session_id: out.match(/Session: (\S+)/)[1] });
  });
});

describe("admission lineage", () => {
  it("nested spawns inherit the parent lineage", async () => {
    const h = await setupTools({}, { blockedAgents: [] });
    const out1 = await h.tool.dynamic_task.execute(
      { description: "parent task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const id1 = out1.match(/Session: (\S+)/)[1];
    const out2 = await h.tool.dynamic_task.execute(
      { description: "nested task", subagent_type: "general", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: id1 },
    );
    assert.ok(out2.includes("in background"), `nested spawn admitted. got: ${out2}`);
    const id2 = out2.match(/Session: (\S+)/)[1];
    const status = await h.tool.task_status.execute({ session_id: id2 });
    assert.ok(status.includes("explore \u2192 general"), `parent chain visible. got: ${status}`);
    await h.tool.task_interrupt.execute({ session_id: id1 });
    await h.tool.task_interrupt.execute({ session_id: id2 });
  });

  it("same-agent nesting is admitted only with the recursion flag", async () => {
    const strict = await setupTools();
    const out1 = await strict.tool.dynamic_task.execute(
      { description: "parent task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const id1 = out1.match(/Session: (\S+)/)[1];
    const denied = await strict.tool.dynamic_task.execute(
      { description: "nested task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: id1 },
    );
    assert.ok(denied.includes("Recursive delegation blocked"), `got: ${denied}`);
    await strict.tool.task_interrupt.execute({ session_id: id1 });

    const lenient = await setupTools({}, { allowSameAgentRecursion: true });
    const out2 = await lenient.tool.dynamic_task.execute(
      { description: "parent task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const id3 = out2.match(/Session: (\S+)/)[1];
    const admitted = await lenient.tool.dynamic_task.execute(
      { description: "nested task", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 5000 },
      { sessionID: id3 },
    );
    assert.ok(admitted.includes("in background"), `flag honored. got: ${admitted}`);
    await lenient.tool.task_interrupt.execute({ session_id: id3 });
    await lenient.tool.task_interrupt.execute({ session_id: admitted.match(/Session: (\S+)/)[1] });
  });
});

describe("prompt routing contract", () => {
  it("model override travels on the prompt, not the create call", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "model task", subagent_type: "explore", prompt: "hi", await_response: true, timeout_ms: 5000, model: "prov/model-x" },
      { sessionID: "p1" },
    );
    assert.ok(out.includes("PROMPT_OK"), `got: ${out}`);
    const childId = out.match(/Session: ([\w-]+)/)[1];
    const created = h.client._state.sessionBodies.get(childId);
    assert.ok(created && !("agent" in created) && !("model" in created), `create shape. got: ${JSON.stringify(created)}`);
    const bodies = h.client._state.promptBodies.filter((p) => p.to === childId);
    assert.ok(bodies.length >= 1, "child prompt recorded");
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.deepStrictEqual(bodies[0].body.model, { providerID: "prov", modelID: "model-x" });
    await h.tool.task_interrupt.execute({ session_id: childId });
  });

  it("prompts without override carry the agent and no model", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "plain task", subagent_type: "explore", prompt: "hi", await_response: true, timeout_ms: 5000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: ([\w-]+)/)[1];
    const bodies = h.client._state.promptBodies.filter((p) => p.to === childId);
    assert.ok(bodies.length >= 1);
    assert.strictEqual(bodies[0].body.agent, "explore");
    assert.ok(!("model" in bodies[0].body), `no model key. got: ${JSON.stringify(bodies[0].body)}`);
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
    const out = await h.tool.dynamic_task.execute(
      { description: "scoped", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await h.fireEvent({ type: "session.idle", properties: { sessionID: childId, status: "idle" } });
    await sleep(30); // onRetainedChange fires synchronously; sleep is for CI, not the contract.

    const ledgerFile = join(dir, ".dynamic-task-ledger.json");
    assert.ok(existsSync(ledgerFile), "ledger must be written inside the plugin directory");
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.ok(ledger.tasks?.[childId], "completed task must be retained in the project ledger");

    const cwdAfter = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;
    assert.strictEqual(cwdAfter, cwdBefore, "the suite must never create or mutate the cwd ledger");

    await h.tool.task_interrupt.execute({ session_id: childId });
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
    const out = await h.tool.dynamic_task.execute(
      { description: "A1 success-status axis", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await h.fireEvent({ type: "session.idle", properties: { sessionID: childId } });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1, "exactly one parent notification");
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `must report error. got: ${note}`);
    assert.ok(note.includes("Too Many Requests"), `must carry provider detail. got: ${note}`);
    assert.ok(!note.includes("completed successfully"), `must never claim success. got: ${note}`);

    const status = await h.tool.task_status.execute({ session_id: childId });
    assert.ok(status.includes("error"), `task_status must show error. got: ${status}`);
    await h.tool.task_interrupt.execute({ session_id: childId });
  });

  it("session.error event notifies error even when hydration finds nothing", async () => {
    const h = await setupTools({ messages: () => [] });
    const out = await h.tool.dynamic_task.execute(
      { description: "err evt", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await h.fireEvent({
      type: "session.error",
      properties: { sessionID: childId, error: { name: "APIError", data: { message: "Too Many Requests" } } },
    });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("ended with an error"), `got: ${note}`);
    await h.tool.task_interrupt.execute({ session_id: childId });
  });

  it("a burst of terminal events notifies the parent exactly once", async () => {
    const h = await setupTools({ messages: erroredMessages });
    const out = await h.tool.dynamic_task.execute(
      { description: "burst", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    // The field log showed three terminal events within 1ms for one failure.
    await Promise.all([
      h.fireEvent({ type: "session.error", properties: { sessionID: childId, error: { name: "APIError", data: { message: "Too Many Requests" } } } }),
      h.fireEvent({ type: "session.status", properties: { sessionID: childId, status: "idle" } }),
      h.fireEvent({ type: "session.idle", properties: { sessionID: childId } }),
    ]);
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1, "single winner must notify once");
    assert.ok(h.client._state.notifications[0].message.includes("ended with an error"));
    await h.tool.task_interrupt.execute({ session_id: childId });
  });

  it("clean completions still report success unchanged", async () => {
    const h = await setupTools();
    const out = await h.tool.dynamic_task.execute(
      { description: "clean", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];
    await h.fireEvent({ type: "session.idle", properties: { sessionID: childId, status: "idle" } });
    await sleep(30);

    assert.strictEqual(h.client._state.notifications.length, 1);
    const note = h.client._state.notifications[0].message;
    assert.ok(note.includes("completed successfully"), `got: ${note}`);
    assert.ok(note.includes("COMPLETED_OK"), `carries assistant text. got: ${note}`);
    await h.tool.task_interrupt.execute({ session_id: childId });
  });
});

describe("spawn resilience: no untracked child survives a failure", () => {
  it("a concurrency rejection leaves no orphan session behind", async () => {
    const h = await setupTools({}, { maxConcurrent: 1 });
    const first = await h.tool.dynamic_task.execute(
      { description: "one", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const firstId = first.match(/Session: (\S+)/)[1];
    const before = new Set(h.client._state.sessions);

    const second = await h.tool.dynamic_task.execute(
      { description: "two", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    assert.ok(/cannot register|concurrency|limit/i.test(second), `must reject. got: ${second}`);

    // Orphan-free invariant: any session the rejection created must be
    // aborted. (A pre-create check that never creates also passes.)
    const created = [...h.client._state.sessions].filter((id) => !before.has(id));
    for (const id of created) {
      assert.ok(h.client._state.aborted.includes(id), `orphan ${id} must be aborted`);
    }
    await h.tool.task_interrupt.execute({ session_id: firstId });
  });

  it("task_interrupt cleans local state when the server session is gone", async () => {
    const h = await setupTools({ abortFailIds: new Set(["ses_tools_1"]) });
    const out = await h.tool.dynamic_task.execute(
      { description: "ghost", subagent_type: "explore", prompt: "hi", await_response: false, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    const childId = out.match(/Session: (\S+)/)[1];

    const res = await h.tool.task_interrupt.execute({ session_id: childId });
    assert.ok(/not found/i.test(res), `reports the server 404. got: ${res}`);

    // Local state must not stay "active" forever after a 404.
    const status = await h.tool.task_status.execute({ session_id: childId });
    assert.ok(!/\bactive\b/.test(status), `must not linger active. got: ${status}`);
  });

  it("a sync-mode prompt failure does not leave the task permanently active", async () => {
    const h = await setupTools({ promptFailIds: new Set(["ses_tools_1"]) });
    const out = await h.tool.dynamic_task.execute(
      { description: "sync fail", subagent_type: "explore", prompt: "hi", await_response: true, timeout_ms: 60000 },
      { sessionID: "p1" },
    );
    assert.ok(/ERROR/i.test(out), `surfaces the failure. got: ${out}`);
    const status = await h.tool.task_status.execute({ session_id: "ses_tools_1" });
    assert.ok(!/\bactive\b/.test(status), `must not linger active. got: ${status}`);
  });
});
