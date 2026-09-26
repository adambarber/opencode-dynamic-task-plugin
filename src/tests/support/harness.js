/**
 * Test harness funnel — the one way a test boots the plugin, gets a child,
 * releases it, and speaks the server's event language.
 *
 * Every suite that drives the REAL plugin used to carry its own copy of the
 * temp-project-dir rule, the process-global resets, a mock client, and a
 * spawn/cleanup pair. Five copies meant five places for a child to leak, for
 * the ledger resets to drift, and for a mock to answer a shape the server
 * never sends. This module is the single declaration of all of it.
 *
 * Ground truth, not test doubles of the thing under test (Tenet 12): the
 * harness boots `dist/index.js` and calls its real tools and real event
 * handler. Only the *host* (the OpenCode server) is faked, because the server
 * is not what these suites are about.
 */

import assert from "node:assert";
import { mkdtempSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { resetAgentCache } from "../../../dist/shared/admission.js";
import { clearNotifyLedger } from "../../../dist/shared/notify.js";
import { resetQuestionSessions } from "../../../dist/shared/question-handling.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Set an env var for the duration of a test and put the host back exactly as
 * it was. The save/restore dance was copied per test, and one copy leaked:
 * a test that wrote a var without a finally left it set for every suite after
 * it in the same process. Restoring the ABSENCE of a var matters as much as
 * its value, so this owns that too.
 */
export async function withEnv(key, value, fn) {
  const had = Object.hasOwn(process.env, key);
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

/**
 * Hand a test a path in the OS temp dir and clean up whatever the test left
 * there — INCLUDING the ledger dance's `.tmp` sidecar. Two hand-rolled copies
 * unlinked only the file, so a failing atomic write could leave the sidecar
 * behind; the absence check is the cleanup, not a hope.
 */
export async function withTempFile(path, fn) {
  try {
    return await fn(path);
  } finally {
    for (const file of [path, `${path}.tmp`]) {
      try {
        unlinkSync(file);
      } catch {
        /* never created */
      }
    }
  }
}

/** A unique path in the OS temp dir. The caller does not create it. */
export const tmpFilePath = (label = "dt") =>
  join(tmpdir(), `${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}`);

/** A promise plus its resolver — the gate tests use to hold a reply open. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Harness state must live in a fresh temp project dir, never CWD or a shared
 * path — see the ledger-scoping regression suite.
 */
export function tmpProjectDir() {
  return mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));
}

/**
 * The server's lifecycle event shapes, declared once. Tests used to spell
 * these literals inline, which is how a test can end up asserting against a
 * shape the host never emits. `updated` and `error` take the inner status so
 * one declaration covers both the plain and error-valued payloads.
 */
export const events = {
  /**
   * `properties` rides through so a test can reproduce a slimmer host payload
   * (`events.idle(id, {})`) when the absence of a field is the point.
   */
  idle: (id, properties = { status: "idle" }) => ({ type: "session.idle", properties: { sessionID: id, ...properties } }),
  status: (id, status = "idle") => ({ type: "session.status", properties: { sessionID: id, status } }),
  // A sync update. `status` is the string, or the host's error object.
  updated: (id, status = "idle") => ({
    type: "sync",
    name: "session.updated.1",
    data: { info: { status } },
    properties: { sessionID: id },
  }),
  errorUpdate: (id) => events.updated(id, { type: "error" }),
  deleted: (id, properties = {}) => ({ type: "session.deleted", properties: { sessionID: id, ...properties } }),
  // EventSessionError carries an error detail, never a status field.
  error: (id, error) => ({
    type: "session.error",
    properties: { sessionID: id, ...(error ? { error } : {}) },
  }),
  /**
   * A question the child asked. `answers: []` is the answerless variant; an
   * absent `sessionID` is the unowned question, which the gate must ignore.
   * A question carries `id`, or `request_id`, or both — the identity the host
   * used is part of the shape, so pass whichever the test is about.
   */
  question: (sessionID, answers, extra = {}) => ({
    type: "question.created",
    properties: { ...(sessionID ? { sessionID } : {}), answers, ...extra },
  }),
  /** The reply that retires a question — it may arrive under request_id only. */
  questionReplied: (props) => ({ type: "question.replied", properties: props }),
};

/**
 * The production-shaped mock host.
 *
 * hooks: {
 *   createThrowsOnce?: boolean,
 *   promptFailIds?: Set<string>,         // async rejections
 *   promptHangIds?: Set<string>,         // never-settling prompts (non-blocking proof)
 *   promptSyncThrowIds?: Set<string>,    // synchronous throws
 *   abortThrowsOnce?: boolean,
 *   abortFailIds?: Set<string>,
 *   getThrows?: Error,
 *   questionReplyThrows?: boolean,
 *   questionRejectThrows?: boolean,
 *   agentsList?: unknown[],
 *   messages?: (args) => unknown[],
 * }
 * Hook sets are read live: mutate them after setup to arm later phases.
 *
 * Session ids are per-host and numbered from 1, so a test can name
 * `ses_mock_1` and be sure it is the first child it created. They repeat
 * across hosts on purpose: the notify ledger is process-global, and the resets
 * below are what isolate it (production never resets anything).
 */
export function createMockClient(hooks = {}) {
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
    notifyAttempts: 0,
    childPromptFailed: false,
    abortGate: null,
  };

  return {
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
        const id = `ses_mock_${state.sessions.size + 1}`;
        state.sessions.add(id);
        state.sessionBodies.set(id, body);
        return { id };
      },
      // session.prompt routes by marker: parent notifications carry
      // [dynamic-task-notify] / [dynamic-task-notice]; everything else is
      // child work.
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
        const isNotify =
          text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]");
        if (isNotify) {
          // The delivery transport for THIS notification, as a plan rather
          // than an override: a test states what the transport does, never how
          // the plugin reaches it.
          const plan = hooks.notifyTransport;
          if (plan?.hang) return plan.hang;
          if (plan?.failTimes && ++state.notifyAttempts <= plan.failTimes) {
            return Promise.reject(new Error("parent notify failed"));
          }
          state.notifications.push({ to: path.id, message: text });
        } else {
          if (hooks.childPromptFailOnce && !state.childPromptFailed) {
            state.childPromptFailed = true;
            return Promise.reject(
              Object.assign(new Error(hooks.childPromptFailOnce.message), {
                code: hooks.childPromptFailOnce.code,
              }),
            );
          }
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
        if (hooks.abortThrows) {
          // The message is what a test will assert it saw, so the plan carries
          // it rather than the test reaching in to normalize it.
          throw new Error(hooks.abortThrows === true ? "abort transport is down" : hooks.abortThrows);
        }
        if (!state.sessions.has(path.id)) {
          throw new Error(`Session "${path.id}" not found.`);
        }
        if (hooks.abortFailIds?.has(path.id)) {
          throw new Error(`Session "${path.id}" not found.`);
        }
        // The abort gate: the first abort parks here until the test releases
        // it, so a racing call can be arranged without monkey-patching. With
        // `fails`, the released abort reports the session as gone — the race
        // outcome the settlement path must survive.
        if (state.abortGate && !state.abortGate.used) {
          state.abortGate.used = true;
          await state.abortGate.promise;
          if (state.abortGate.fails) {
            throw new Error(`Session "${path.id}" not found.`);
          }
        }
        state.aborted.push(path.id);
        return { ok: true };
      },
    },
    // Hold the next abort open. Returns the release, awaited by the test.
    gateAbort({ fails = false } = {}) {
      const gate = deferred();
      state.abortGate = { promise: gate.promise, used: false, fails, release: gate.resolve };
      return { release: () => gate.resolve() };
    },
  };
}

/** Parse the child id out of the same line the parent reads. */
export function extractSessionId(spawnOutput) {
  const match = spawnOutput.match(/Session: (\S+)/);
  assert.ok(match, `spawn output must contain a session id, got: ${spawnOutput}`);
  return match[1];
}

/**
 * Rendered ages come back as "45s" / "12m" / "1h 5m" — parse them back to
 * seconds so a test can compare the two clocks instead of eyeballing text.
 */
export function renderedAgeSeconds(detail, label) {
  const match = detail.match(new RegExp(`^${label}: (?:(\\d+)h )?(?:(\\d+)m )?(\\d+)s ago$`, "m"));
  assert.ok(match, `"${label}" must render an age. Got: ${detail}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

// Harnesses booted during the current test, so one afterEach can release every
// child any test spawned — including ones a test built inline rather than
// through a shared beforeEach.
const liveHarnesses = [];

/**
 * Boot the real plugin against a mock host and return the harness.
 *
 * The process-global stores are reset HERE, at the moment a plugin instance
 * is created, rather than in a per-file beforeEach that a test could run
 * without. `harness.spawn` records the child it creates, so cleanup cannot be
 * forgotten by a test that builds its harness inline.
 */
export async function setupHarness({ hooks = {}, options = {}, directory = tmpProjectDir() } = {}) {
  const client = createMockClient(hooks);
  const state = client._state;
  resetAgentCache();
  clearNotifyLedger();
  resetQuestionSessions();
  const mod = await import("../../../dist/index.js");
  const pluginFn = mod.default || mod;
  const result = await pluginFn({ client, directory }, options);
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  const spawned = [];

  const harness = {
    client,
    tool: result.tool,
    directory,
    spawned,
    fireEvent: (event) => result.event({ event }),
    // The settlement funnel: a task settles only by the event the server
    // would emit, delivered straight to the handler.
    settle: (id) => result.event({ event: events.idle(id) }),
    // What the parent has been sent, in order: { to, message } records — the
    // routing target is part of the contract, so it stays visible.
    notices: () => state.notifications,
    noticeBodies: () => state.notifications.map((n) => n.message),
    // The notice that mentions a child session, or undefined. A child id is
    // in every settlement notice, so this is the handle for "the notice FOR
    // this child" — routing target included.
    noticeFor: (childId) => state.notifications.find((n) => n.message.includes(childId)),
    questionCalls: () => state.questionCalls,
    logs: () => state.logs,
    aborted: () => state.aborted,
    /**
     * Deliver a terminal event and return the single notice it must produce.
     * Exactly-once delivery is part of the contract, so the count is asserted
     * here rather than repeated at every call site. The sleep is for CI
     * scheduling, not the contract: delivery is a microtask away.
     */
    async noticeAfter(event) {
      await harness.fireEvent(event);
      await sleep(30);
      assert.strictEqual(state.notifications.length, 1, "a terminal event notifies exactly once");
      return state.notifications[0].message;
    },
    /**
     * Settle a child and hand back the single notice the parent received — the
     * common case of noticeAfter, where the terminal event is the idle event.
     */
    async settledNotice(id) {
      return harness.noticeAfter(events.idle(id));
    },
    /**
     * The admission path's own call: the tool's answer, with no id and nothing
     * to clean up. A refusal test states the whole request, so any default here
     * would fill in the very field under test.
     */
    trySpawn(args, ctx = { sessionID: "p1" }) {
      return harness.tool.dynamic_task.execute(args, ctx);
    },
    /**
     * Spawn one child. Returns the id, the spawn confirmation, and the child's
     * bound tools — binding here means a test never restates which session it
     * is talking about, and it cannot bind the wrong one.
     */
    async spawn(args = {}, ctx = { sessionID: "p1" }) {
      const out = await harness.tool.dynamic_task.execute(
        { description: "bg task", subagent_type: "explore", prompt: "Return DONE", ...args },
        ctx,
      );
      const id = extractSessionId(out);
      if (id) spawned.push(id);
      return { out, id, c: bindChild(harness, id, args, ctx) };
    },
    /**
     * A child that already exists, with its tools bound to it. Every test in a
     * tool suite drives SOME child's tool, so the (tool, session_id, ctx)
     * triple is the suite's boilerplate — binding it once here is why no test
     * restates which session it is talking about. Use withChild() to spawn one.
     */
    child(id, args = {}, ctx = { sessionID: "p1" }) {
      return bindChild(harness, id, args, ctx);
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

/**
 * The tools of a child session, bound. `id` may be null for a child that does
 * not exist yet (a steer that revives a settled turn, a list) — the binding is
 * lazy so the handle is usable either way.
 */
function bindChild(harness, id, spawnArgs = {}, ctx = { sessionID: "p1" }) {
  const tool = (name) => (args = {}, callCtx) =>
    harness.tool[name].execute({ session_id: id, ...args }, callCtx ?? ctx);
  return {
    get id() { return id; },
    set id(next) { id = next; },
    tool,
    /** Spawn this child and keep the handle's id in sync. */
    async spawn(args = {}) {
      const out = await harness.spawn({ ...spawnArgs, ...args }, ctx);
      id = out.id;
      return out;
    },
    steer: (prompt) => tool("task_continue")({ prompt }),
    interrupt: () => tool("task_interrupt")(),
    status: () => tool("task_status")(),
    result: () => tool("task_result")(),
    revive: () => tool("task_revive")(),
    // The child speaks to its parent, so notify routes by the CHILD's id.
    notify: (message) => harness.tool.task_notify.execute({ message }, { sessionID: id ?? ctx.sessionID }),
    settle: () => harness.settle(id),
  };
}

/**
 * Boot the plugin, spawn one child, and return the pair a tool test needs.
 * This is the suite's standard arrangement, so it is declared once here rather
 * than forty times as boot-then-spawn.
 */
export async function withChild({ harness = {}, spawn = {}, ctx = { sessionID: "p1" } } = {}) {
  const h = await setupHarness(harness);
  const { id, out, c } = await h.spawn(spawn, ctx);
  return { h, c, id, out };
}

/**
 * Boot, spawn one child, and settle it — the precondition for reading a
 * child's settled state. Naming it keeps a test from spelling out the same
 * three steps to ask the same question.
 */
export async function withSettledChild(opts = {}) {
  const { h, c, id, out } = await withChild(opts);
  await h.settle(id);
  return { h, c, id, out };
}

/** Release one harness's children. Best-effort: settled children are fine. */
export async function releaseSpawns(harness) {
  for (const id of harness.spawned.splice(0)) {
    try {
      await harness.tool.task_interrupt.execute({ session_id: id });
    } catch {
      // Already settled — cleanup is best-effort.
    }
  }
}

// Registered here, not in each test file: importing the harness is the opt-in.
afterEach(async () => {
  for (const harness of liveHarnesses.splice(0)) {
    await releaseSpawns(harness);
  }
});

/**
 * The two-turn harness the claim-order/revival tests share: the message stream
 * names each turn's output, and the FIRST parent notification fails so the
 * gate's retry lands inside the test's timing window.
 */
export async function setupTwoTurnHarness() {
  let msgCalls = 0;
  const harness = await setupHarness({
    hooks: {
      messages: () => {
        msgCalls++;
        const text = msgCalls === 1 ? "TURN-ONE-OUTPUT" : "TURN-TWO-OUTPUT";
        return [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];
      },
    },
  });
  const origPrompt = harness.client.session.prompt;
  let parentNotifies = 0;
  harness.client.session.prompt = (args) => {
    const text = args.body?.parts?.[0]?.text || "";
    if (text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]")) {
      parentNotifies++;
      if (parentNotifies === 1) return Promise.reject(new Error("parent busy"));
    }
    return origPrompt(args);
  };
  return harness;
}
