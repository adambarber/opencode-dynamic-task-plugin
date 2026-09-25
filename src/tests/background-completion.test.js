/**
 * Background settlement — production-driven.
 *
 * Every test spawns a REAL task through the plugin's dynamic_task tool and
 * settles it through the REAL event handler. No mirrored registration or
 * lifecycle logic: this suite fails when production regresses (Tenet 12).
 * The contract under test is non-blocking: tools return immediately, the
 * plugin arms no timers, and every task settles exactly once by event.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetAgentCache } from "../../dist/shared/admission.js";
import { clearNotifyLedger } from "../../dist/shared/notify.js";
import { resetQuestionSessions } from "../../dist/shared/question-handling.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Harness state must live in a fresh temp project dir, never CWD or a
// shared path — see the ledger-scoping regression suite.
const tmpProjectDir = () => mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));

// --- Production-shaped mock client -----------------------------------------
// session.prompt routes by marker: parent notifications carry
// [dynamic-task-notify]; everything else is child work.

// Child session ids must be unique across the whole file: the notify gate
// dedups per child for the process lifetime (exactly-once is global), so
// per-mock counters would make later tests' first settlement look like a
// duplicate. Real hosts never reuse session ids; the mock must not either.
let globalChildId = 1;

function createMockClient() {
  const sessions = new Map();
  const notifications = [];
  const childPrompts = [];

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
        const id = `ses_bg_${globalChildId++}`;
        sessions.set(id, body);
        return { id };
      },
      prompt: async ({ path, body }) => {
        const text = body?.parts?.[0]?.text || "";
        if (text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]")) {
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
        // Production session.get() carries no status field.
        return {};
      },
      abort: async () => ({ ok: true }),
    },
  };
}

async function setupHarness() {
  const client = createMockClient();
  resetAgentCache();
  clearNotifyLedger();
  resetQuestionSessions();
  const mod = await import("../../dist/index.js");
  const pluginFn = mod.default || mod;
  const result = await pluginFn({ client, directory: tmpProjectDir() }, {});
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  return { client, tool: result.tool, fireEvent: (event) => result.event({ event }) };
}

function extractSessionId(spawnOutput) {
  const match = spawnOutput.match(/Session: (\S+)/);
  assert.ok(match, `spawn output must contain a session id, got: ${spawnOutput}`);
  return match[1];
}

// Rendered ages come back as "45s" / "12m" / "1h 5m" — parse them back to
// seconds so a test can compare the two clocks instead of eyeballing text.
function renderedAgeSeconds(detail, label) {
  const match = detail.match(new RegExp(`^${label}: (?:(\\d+)h )?(?:(\\d+)m )?(\\d+)s ago$`, "m"));
  assert.ok(match, `"${label}" must render an age. Got: ${detail}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

// --- Tests -----------------------------------------------------------------

describe("Background Task Settlement", () => {
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

  async function spawn(parentId, description = "bg task") {
    const output = await harness.tool.dynamic_task.execute(
      {
        description,
        subagent_type: "explore",
        prompt: "Return DONE",
      },
      { sessionID: parentId },
    );
    assert.ok(output.includes("in background"), `expected spawn ack, got: ${output}`);
    const childId = extractSessionId(output);
    spawned.push(childId);
    return childId;
  }

  async function expectSingleSuccessNotification(parentId, description, buildEvent) {
    const childId = await spawn(parentId, description);
    await harness.fireEvent(buildEvent(childId));
    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 completion notification");
    assert.ok(
      notes[0].message.includes("Background task completed successfully"),
      `success text. Got: ${notes[0].message}`,
    );
    return childId;
  }

  it("a hung host log never stalls settlement — observability is detached", async () => {
    harness.client.app.log = () => new Promise(() => {});
    const childId = await spawn("parent_hung_log", "hung log task");
    const settled = await Promise.race([
      harness.fireEvent({ type: "session.idle", properties: { sessionID: childId, status: "idle" } }).then(() => true),
      sleep(2000).then(() => false),
    ]);
    assert.ok(settled, "the event head must not serialize on the log round-trip");
    assert.strictEqual(harness.client._notifications.length, 1, "settlement still notifies");
  });

  it("spawns return immediately with a session id", async () => {
    const started = Date.now();
    const childId = await spawn("parent_fast");
    assert.ok(Date.now() - started < 100, "ack must not wait on the child");
    assert.ok(childId.startsWith("ses_"));
  });

  it("idle event notifies the parent with the child result", async () => {
    for (const parentId of ["parent_001", "parent_002", "parent_003"]) {
      const before = harness.client._notifications.length;
      const childId = await spawn(parentId, `Quick test ${parentId}`);

      await harness.fireEvent({
        type: "session.idle",
        properties: { sessionID: childId, status: "idle" },
      });

      const notes = harness.client._notifications;
      assert.strictEqual(notes.length, before + 1, `exactly 1 new notification [${childId}]`);
      const note = notes[notes.length - 1];
      assert.strictEqual(note.to, parentId, `must notify parent [${childId}]`);
      assert.ok(note.message.includes(childId), `notification must reference the child session [${childId}]`);
      assert.ok(note.message.includes("COMPLETED_OK"), `notification must carry the child result text [${childId}]`);
      assert.ok(note.message.includes("Background task completed successfully"), `success notification [${childId}]`);
    }
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
      children.push({ parent: parentId, child: await spawn(parentId, `Task ${parentId}`) });
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
    const childId = await spawn("err_parent", "Error test");

    await harness.fireEvent({
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: { type: "error" } } },
      properties: { sessionID: childId },
    });

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "exactly 1 notification");
    assert.match(notes[0].message, /ended with an error/i, "error-kind notification");
    assert.ok(!notes[0].message.includes("completed successfully"), "must not be a success notification");
  });

  it("deleted session is a failure, never a success", async () => {
    const childId = await spawn("del_parent", "Deletion test");
    const before = harness.client._notifications.length;

    await harness.fireEvent({
      type: "session.deleted",
      properties: { info: { id: childId } },
    });

    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, before + 1);
    assert.match(notes[notes.length - 1].message, /ended with an error/i, "deletion must read as failure");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `retained state must be error. Got: ${detail}`);
  });

  it("repeated idle events settle exactly once", async () => {
    const childId = await spawn("race_parent", "Race test");
    for (let i = 0; i < 3; i++) {
      await harness.fireEvent({
        type: "session.idle",
        properties: { sessionID: childId, status: "idle" },
      });
    }
    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 1, "first event wins; later ones are no-ops");
    assert.match(notes[0].message, /completed/i);
  });

  it("the plugin arms no timers: silence follows a spawn until an event arrives", async () => {
    const childId = await spawn("patient_parent", "No-timer test");
    await sleep(250);
    assert.strictEqual(harness.client._notifications.length, 0, "nothing settles without an event");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("active"), `task remains tracked and active. Got: ${detail}`);
  });

  it("a late error after success escalates the record and notifies once", async () => {
    const childId = await spawn("escalate_parent", "Escalation test");
    await harness.fireEvent({ type: "session.idle", properties: { sessionID: childId, status: "idle" } });
    assert.strictEqual(harness.client._notifications.length, 1, "success first");

    await harness.fireEvent({ type: "session.error", properties: { sessionID: childId, status: "error" } });
    const notes = harness.client._notifications;
    assert.strictEqual(notes.length, 2, "the contradicting failure is reported");
    assert.match(notes[1].message, /ended with an error/i);
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `record escalates completed→error. Got: ${detail}`);

    // A second error event cannot re-notify or regress the record further.
    await harness.fireEvent({ type: "session.error", properties: { sessionID: childId, status: "error" } });
    assert.strictEqual(harness.client._notifications.length, 2, "escalation happens once");
  });

  it("a working child's own events count as recent activity", async () => {
    const childId = await spawn("parent_activity", "Activity test");
    await sleep(1200);
    const silent = await harness.tool.task_status.execute({ session_id: childId });
    assert.match(silent, /Last activity: \d+s ago/, `starts at the spawn. Got: ${silent}`);

    // Host-shaped progress event: message/part updates carry the child's
    // session id and are the only evidence the turn is moving. Before the
    // heartbeat this event was dropped on the floor and the child read as
    // silent since spawn.
    await harness.fireEvent({
      type: "message.part.updated",
      properties: { sessionID: childId, part: { type: "tool", state: { status: "running" } } },
    });

    const detail = await harness.tool.task_status.execute({ session_id: childId });
    const started = renderedAgeSeconds(detail, "Started");
    const activity = renderedAgeSeconds(detail, "Last activity");
    assert.ok(
      activity < started,
      `the event must move the activity clock past the spawn. started=${started}s activity=${activity}s. Got: ${detail}`,
    );
    assert.ok(!detail.includes("stalled"), `a working child never reads as stalled. Got: ${detail}`);
  });

  it("ignores events for untracked sessions", async () => {
    await spawn("parent_untracked", "Untracked test");
    const before = harness.client._notifications.length;

    await harness.fireEvent({
      type: "session.idle",
      properties: { sessionID: "nonexistent_session", status: "idle" },
    });

    assert.strictEqual(harness.client._notifications.length, before, "no notification for untracked session");
  });
});
