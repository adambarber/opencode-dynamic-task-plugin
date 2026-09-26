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
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { resetAgentCache } from "../../../dist/shared/admission.js";
import { clearNotifyLedger } from "../../../dist/shared/notify.js";
import { resetQuestionSessions } from "../../../dist/shared/question-handling.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        // The abort gate: the first abort parks here until the test releases
        // it, so a racing call can be arranged without monkey-patching.
        if (state.abortGate && !state.abortGate.used) {
          state.abortGate.used = true;
          await state.abortGate.promise;
        }
        state.aborted.push(path.id);
        return { ok: true };
      },
    },
    // Hold the next abort open. Returns the release, awaited by the test.
    gateAbort() {
      const gate = deferred();
      state.abortGate = { promise: gate.promise, used: false, release: gate.resolve };
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
     * Settle a child and hand back the single notice the parent received.
     * Exactly-once delivery is part of the contract, so the count is asserted
     * here rather than repeated at every call site. The sleep is for CI
     * scheduling, not the contract: delivery is a microtask away.
     */
    async settledNotice(id) {
      await harness.settle(id);
      await sleep(30);
      assert.strictEqual(state.notifications.length, 1, "settlement delivers exactly one notice");
      return state.notifications[0].message;
    },
    async spawn(args = {}, ctx = { sessionID: "p1" }) {
      const out = await harness.tool.dynamic_task.execute(
        { description: "bg task", subagent_type: "explore", prompt: "Return DONE", ...args },
        ctx,
      );
      const id = extractSessionId(out);
      spawned.push(id);
      return { out, id };
    },
  };
  liveHarnesses.push(harness);
  return harness;
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
