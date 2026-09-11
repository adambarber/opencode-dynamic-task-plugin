/**
 * Integration tests for sync mode (await_response=true).
 *
 * Unlike unit tests which test helpers in isolation, these tests
 * exercise the actual `dynamic_task` tool handler end-to-end with
 * a mock client that simulates real OpenCode session lifecycle.
 *
 * The key failure mode we're catching: sync mode hangs forever because
 * the Promise never resolves. These tests verify the Promise DOES resolve.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Harness state must live in a fresh temp project dir, never CWD or a
// shared path — see the ledger-scoping regression suite.
const tmpProjectDir = () => mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));

// ─── Module-level state for mock client ──────────────────────────
// These are set by createMockClient and read by fireLifecycleEvent.

/** @type {(event: any) => void} */
let registeredEventHandler = null;
let pluginCleanup = null;

// ─── Mock client factory ───────────────────────────────────────────

function createMockClient() {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, any[]>} */
  const sessionMessages = new Map();
  /** @type {Array<{ level: string; message: string }>} */
  const logs = [];

  let nextSessionNum = 1;

  return {
    _logs: logs,
    _sessions: sessions,
    _sessionMessages: sessionMessages,

    app: {
      agents: async () => [
        { name: "explore", mode: "subagent", description: "Exploration agent" },
        { name: "reviewer", mode: "subagent", description: "Review agent" },
      ],
      log: async ({ body }) => {
        logs.push(body);
      },
    },

    session: {
      create: async ({ body }) => {
        const id = `ses_integration_${nextSessionNum++}_${randomUUID().slice(0, 8)}`;
        sessions.set(id, { id, status: "created", agent: body.agent, parentID: body.parentID });
        sessionMessages.set(id, [
          { role: "user", parts: [{ type: "text", text: "Initial prompt" }] },
        ]);
        return { id };
      },

      prompt: async ({ path, body }) => {
        const msgs = sessionMessages.get(path.id) || [];
        msgs.push({ role: "user", parts: body?.parts || [] });
        const promptText = body?.parts?.map((p) => p?.text || "").join("\n") || "";
        if (promptText.includes("Long task")) {
          sessionMessages.set(path.id, msgs);
          return new Promise(() => {});
        }
        const assistant = { role: "assistant", parts: [{ type: "text", text: "COMPLETED_OK" }] };
        msgs.push(assistant);
        sessionMessages.set(path.id, msgs);
        return assistant;
      },

      messages: async ({ path }) => {
        return sessionMessages.get(path.id) || [];
      },

      get: async ({ path }) => {
        const session = sessions.get(path.id);
        if (!session) return { status: "unknown" };
        return { status: "idle" };
      },

      abort: async ({ path }) => {
        return { ok: true };
      },
    },
  };
}

// ─── Helper to manually complete a child session ──────────────────
// Simulates the child agent responding and the real OpenCode lifecycle event.

function completeChildSession(client, childSessionId) {
  const msgs = client._sessionMessages.get(childSessionId) || [];
  msgs.push({ role: "assistant", parts: [{ type: "text", text: "COMPLETED_OK" }] });
  client._sessionMessages.set(childSessionId, msgs);

  // Fire the lifecycle event as OpenCode would
  // NOTE: OpenCode's plugin event handler is called with ({ event: actualEvent })
  if (registeredEventHandler) {
    registeredEventHandler({ event: {
      type: "session.idle",
      properties: {
        sessionID: childSessionId,
        status: "idle",
      },
    }});
  }
}

// ─── Plugin setup helpers ──────────────────────────────────────────

async function setupPlugin(client, options = {}) {
  // Dynamic import so we test against the built dist (same as production)
  const plugin = await import("../../dist/index.js");

  // Plugin function expects export default
  const pluginFn = plugin.default || plugin;
  const result = await pluginFn(
    { client, directory: tmpProjectDir() },
    { defaultTimeoutMs: 5000, ...options },
  );

  if (result.event) {
    registeredEventHandler = result.event;
  }

  return result;
}

async function teardownPlugin() {
  registeredEventHandler = null;
}

// ─── Test helpers ──────────────────────────────────────────────────

/**
 * Call the dynamic_task execute handler with the given args and ctx.
 * Returns the execute handler's return string.
 */
async function executeDynamicTask(handler, args, ctx = {}) {
  return await handler.execute(args, ctx);
}

/**
 * Shared arrange/act preamble: start a sync task, let it register, then
 * complete its first child session. Collapses the per-test copy of the
 * session-lookup + completion sequence into one funnel.
 */
async function startSyncTaskAndCompleteFirstChild(client, handler, args) {
  const resultPromise = executeDynamicTask(handler, args);
  // Small delay to let the Promise register (simulates network lag)
  await new Promise((r) => setTimeout(r, 50));
  const sessionId = [...client._sessions.keys()][0];
  assert.ok(sessionId, "A session should have been created");
  completeChildSession(client, sessionId);
  return resultPromise;
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Sync Mode Integration — dynamic_task execute handler", () => {
  let client;
  let handler;
  let pendingTimeout;

  beforeEach(async () => {
    client = createMockClient();
    const result = await setupPlugin(client);
    handler = result.tool?.dynamic_task;
    assert.ok(handler, "dynamic_task tool must be registered");
  });

  afterEach(async () => {
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
    await teardownPlugin();
  });

  // ── Test 1: Normal sync — event arrives AFTER Promise registers ──

  it("sync mode: event arrives after Promise — resolves normally", async () => {
    const resultPromise = startSyncTaskAndCompleteFirstChild(client, handler, {
      subagent_type: "explore",
      prompt: "Say hello",
      await_response: true,
      timeout_ms: 5000,
    });

    const result = await resultPromise;
    assert.ok(result.includes("@explore Response"), `Expected agent response, got: ${result}`);
    // The event handler resolves with { text: "(completed)" }
    assert.ok(result.includes("(completed)")
      || result.includes("COMPLETED_OK")
      || result.includes("(Subagent completed)"),
      `Expected completion marker in: ${result}`);
    // Critical: must NOT say "Timed out" — prove sync worked
    assert.ok(!result.includes("Timed out"),
      `Sync mode must NOT time out. Got: ${result}`);
  });

  // ── Test 2: Complete before polling starts ──

  it("sync mode: child completes before poll starts — does NOT hang", async () => {
    // Start execution. It creates the session, sends the prompt,
    // then starts polling. Complete the child during the poll interval.
    const resultPromise = executeDynamicTask(handler, {
      subagent_type: "explore",
      prompt: "Quick task",
      await_response: true,
      timeout_ms: 5000,
    });

    // Wait for the session to be created (async) then complete it
    let sessionId;
    for (let i = 0; i < 50; i++) {
      const keys = [...client._sessions.keys()];
      if (keys.length > 0) { sessionId = keys[0]; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(sessionId, "A session should have been created within 500ms");

    // Complete the child immediately — poll should detect it
    completeChildSession(client, sessionId);

    // Timebox to prove it doesn't hang
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT — sync mode hung")), 3000),
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    assert.ok(result.includes("@explore Response"),
      `Expected agent response, got: ${result}`);
    assert.ok(!result.includes("Timed out"),
      `Must not time out. Got: ${result}`);
  });

  // ── Test 3: String coercion — "true" string triggers sync mode ──

  it("sync mode: await_response='true' (string) triggers sync", async () => {
    const resultPromise = startSyncTaskAndCompleteFirstChild(client, handler, {
      subagent_type: "explore",
      prompt: "Say hi",
      await_response: "true",
      timeout_ms: 5000,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT — string 'true' hung")), 3000),
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    assert.ok(result.includes("@explore Response"),
      `Expected agent response with string 'true', got: ${result}`);
  });

  // ── Test 4: Timeout — no event comes, timeout resolves ──

  it("sync mode: timeout fires when no event arrives", async () => {
    const resultPromise = executeDynamicTask(handler, {
      subagent_type: "explore",
      prompt: "Long task",
      await_response: true,
      timeout_ms: 100,  // very short timeout
    });

    const result = await resultPromise;
    assert.ok(result.includes("Timed out"),
      `Expected timeout message, got: ${result}`);
    assert.ok(result.includes("task_continue"),
      `Expected task_continue guidance, got: ${result}`);
  });

  // ── Test 5: Background mode — no sync Promise created ──

  it("background mode: await_response=false returns immediately", async () => {
    const result = await executeDynamicTask(handler, {
      subagent_type: "explore",
      prompt: "Do something",
      await_response: false,
      timeout_ms: 5000,
    });

    assert.ok(result.includes("Spawned @explore in background"),
      `Expected immediate spawn message, got: ${result}`);
    assert.ok(result.includes("Session:"),
      `Expected session ID in output, got: ${result}`);
  });
});
