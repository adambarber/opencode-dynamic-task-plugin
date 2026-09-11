/**
 * Background completion — production-driven.
 *
 * Every test spawns a REAL background task through the plugin's dynamic_task
 * tool and settles it through the REAL event handler. No mirrored registration
 * or lifecycle logic: this suite fails when production regresses (Tenet 12).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { resetAgentCache } from "../../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Production-shaped mock client -----------------------------------------
// session.prompt routes by marker: parent notifications carry
// [dynamic-task-notify]; everything else is child work.

function createMockClient() {
  const sessions = new Map();
  const notifications = [];
  const childPrompts = [];
  let nextId = 1;

  return {
    _sessions: sessions,
    _notifications: notifications,
    _childPrompts: childPrompts,
    app: {
      agents: async () => [{ name: "explore", mode: "subagent" }],
      log: async () => {},
    },
    session: {
      create: async ({ body }) => {
        const id = `ses_bg_${nextId++}`;
        sessions.set(id, body);
        return { id };
      },
      prompt: async ({ path, body }) => {
        const text = body?.parts?.[0]?.text || "";
        if (text.includes("[dynamic-task-notify]")) {
          notifications.push({ to: path.id, message: text });
        } else {
          childPrompts.push({ to: path.id, message: text });
        }
        return { ok: true };
      },
      messages: async () => [
        { role: "assistant", parts: [{ type: "text", text: "COMPLETED_OK" }] },
      ],
      get: async ({ path }) => {
        if (!sessions.has(path.id)) {
          const error = new Error(`Session "${path.id}" not found.`);
          error.status = 404;
          throw error;
        }
        return { status: "idle" };
      },
      abort: async () => ({ ok: true }),
    },
  };
}

async function setupHarness() {
  const client = createMockClient();
  resetAgentCache();
  const mod = await import("../../dist/index.js");
  const pluginFn = mod.default || mod;
  // Low minTimeoutMs: sub-second timeouts keep the suite fast without
  // touching production clamping (resolveTimeoutMs still enforced).
  const result = await pluginFn({ client, directory: "/tmp" }, { minTimeoutMs: 20 });
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  return { client, tool: result.tool, fireEvent: (event) => result.event({ event }) };
}

function extractSessionId(spawnOutput) {
  const match = spawnOutput.match(/Session: (\S+)/);
  assert.ok(match, `spawn output must contain a session id, got: ${spawnOutput}`);
  return match[1];
}

// --- Tests -----------------------------------------------------------------

describe("Background Task Completion Notification", () => {
  let harness;
  let spawned;

  beforeEach(async () => {
    harness = await setupHarness();
    spawned = [];
  });

  afterEach(async () => {
    for (const id of spawned) {
      try {
        await harness.tool.task_interrupt.execute({ session_id: id });
      } catch {
        // Already settled — cleanup is best-effort.
      }
    }
    spawned = [];
  });

  async function spawn(parentId, timeoutMs, description = "bg task") {
    const output = await harness.tool.dynamic_task.execute(
      {
        description,
        subagent_type: "explore",
        prompt: "Return DONE",
        await_response: false,
        timeout_ms: timeoutMs,
      },
      { sessionID: parentId },
    );
    assert.ok(output.includes("in background"), `expected spawn ack, got: ${output}`);
    const childId = extractSessionId(output);
    spawned.push(childId);
    return childId;
  }

  async function expectSingleSuccessNotification(parentId, description, buildEvent) {
    const childId = await spawn(parentId, 5000, description);
    await harness.fireEvent(buildEvent(childId));
    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 completion notification");
    assert.ok(
      notes[0].message.includes("Background task completed successfully"),
      `success text. Got: ${notes[0].message}`,
    );
    return childId;
  }

  it("completes before timeout - notifies parent with success", async () => {
    for (const parentId of ["parent_001", "parent_002", "parent_003"]) {
      const before = harness.client._notifications.length;
      const childId = await spawn(parentId, 5000, `Quick test ${parentId}`);

      await harness.fireEvent({
        type: "session.idle",
        properties: { sessionID: childId, status: "idle" },
      });

      const notes = harness.client._notifications;
      assert.strictEqual(notes.length, before + 1, `exactly 1 new notification [${childId}]`);
      const note = notes[notes.length - 1];
      assert.strictEqual(note.to, parentId, `must notify parent [${childId}]`);
      assert.ok(
        note.message.includes(childId),
        `notification must reference the child session [${childId}]`,
      );
      assert.ok(
        note.message.includes("COMPLETED_OK"),
        `notification must carry the child result text [${childId}]. Got: ${note.message}`,
      );
      assert.ok(
        note.message.includes("Background task completed successfully"),
        `success notification [${childId}]. Got: ${note.message}`,
      );
      assert.ok(!note.message.includes("timed out"), `must not say timed out [${childId}]`);
    }
  });

  it("timeout fallback notifies when no event arrives", async () => {
    await spawn("parent_timeout", 60, "Timeout test task");
    await sleep(250);

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 timeout notification");
    assert.strictEqual(notes[0].to, "parent_timeout");
    assert.ok(
      notes[0].message.includes("did not report completion before timeout"),
      `timeout text. Got: ${notes[0].message}`,
    );
  });

  it("session.status idle triggers completion", async () => {
    await expectSingleSuccessNotification("parent_status", "Status event test", (childId) => ({
      type: "session.status",
      properties: { sessionID: childId, status: "idle" },
    }));
  });

  it("sync session.updated idle triggers completion", async () => {
    await expectSingleSuccessNotification("parent_sync", "Sync event test", (childId) => ({
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: "idle" } },
      properties: { sessionID: childId },
    }));
  });

  it("multiple rapid completions each notify", async () => {
    const children = [];
    for (const parentId of ["p1", "p2", "p3"]) {
      children.push({ parent: parentId, child: await spawn(parentId, 5000, `Task ${parentId}`) });
    }

    for (const { child } of children) {
      await harness.fireEvent({
        type: "session.idle",
        properties: { sessionID: child, status: "idle" },
      });
    }

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 3, "3 notifications for 3 completions");
    for (const { parent, child } of children) {
      const note = notes.find((n) => n.message.includes(child));
      assert.ok(note, `notification must reference ${child}`);
      assert.strictEqual(note.to, parent, `notification for ${child} must go to ${parent}`);
    }
  });

  it("error status yields error-kind notification", async () => {
    const childId = await spawn("sync_err_parent", 5000, "Sync error test");

    await harness.fireEvent({
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: { type: "error" } } },
      properties: { sessionID: childId },
    });

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 notification");
    assert.match(notes[0].message, /ended with an error/i, "error-kind notification");
    assert.ok(
      !notes[0].message.includes("completed successfully"),
      "must not be a success notification",
    );
  });

  it("timed-out tasks leave active state (visible via task_result)", async () => {
    const childId = await spawn("cleanup_parent", 50, "Cleanup test");
    await sleep(200);

    const summary = await harness.tool.task_result.execute({ session_id: childId });
    assert.ok(
      summary.includes("timed_out"),
      `task_result must show the timed-out state. Got: ${summary}`,
    );
  });

  it("event before timeout yields exactly one notification", async () => {
    const childId = await spawn("race_parent", 400, "Race test");

    await harness.fireEvent({
      type: "session.idle",
      properties: { sessionID: childId, status: "idle" },
    });
    await sleep(600);

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "completion only — timeout must not also fire");
    assert.match(notes[0].message, /completed/i);
  });

  it("ignores events for untracked sessions", async () => {
    await spawn("parent_untracked", 5000, "Untracked test");
    const before = harness.client._notifications.length;

    await harness.fireEvent({
      type: "session.idle",
      properties: { sessionID: "nonexistent_session", status: "idle" },
    });

    assert.strictEqual(
      harness.client._notifications.length,
      before,
      "no notification for untracked session",
    );
  });
});
