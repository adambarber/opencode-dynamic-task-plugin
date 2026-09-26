/**
 * Background settlement — production-driven.
 *
 * Every test spawns a REAL task through the plugin's dynamic_task tool and
 * settles it through the REAL event handler. No mirrored registration or
 * lifecycle logic: this suite fails when production regresses (Tenet 12).
 * The contract under test is non-blocking: tools return immediately, the
 * plugin arms no timers, and every task settles exactly once by event.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { events, renderedAgeSeconds, setupHarness, sleep } from "./support/harness.js";

describe("Background Task Settlement", () => {
  let harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  // Children are released by the harness funnel (see support/harness.js), so
  // no test can leak one by forgetting to register it.
  const spawn = async (parentId, description = "bg task") => {
    const { out, id } = await harness.spawn({ description }, { sessionID: parentId });
    assert.ok(out.includes("in background"), `expected spawn ack, got: ${out}`);
    return id;
  };

  async function expectSingleSuccessNotification(parentId, description, buildEvent) {
    const childId = await spawn(parentId, description);
    await harness.fireEvent(buildEvent(childId));
    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, 1, "exactly 1 completion notification");
    assert.ok(
      notes[0].includes("Background task completed successfully"),
      `success text. Got: ${notes[0]}`,
    );
    return childId;
  }

  it("a hung host log never stalls settlement — observability is detached", async () => {
    harness.client.app.log = () => new Promise(() => {});
    const childId = await spawn("parent_hung_log", "hung log task");
    const settled = await Promise.race([
      harness.fireEvent(events.idle(childId)).then(() => true),
      sleep(2000).then(() => false),
    ]);
    assert.ok(settled, "the event head must not serialize on the log round-trip");
    assert.strictEqual(harness.notices().length, 1, "settlement still notifies");
  });

  it("spawns return immediately with a session id", async () => {
    const started = Date.now();
    const childId = await spawn("parent_fast");
    assert.ok(Date.now() - started < 100, "ack must not wait on the child");
    assert.ok(childId.startsWith("ses_"));
  });

  it("idle event notifies the parent with the child result", async () => {
    for (const parentId of ["parent_001", "parent_002", "parent_003"]) {
      const childId = await spawn(parentId, `Quick test ${parentId}`);
      const note = await harness.noticeAfter(events.idle(childId));
      assert.strictEqual(note.to, parentId, `must notify parent [${childId}]`);
      assert.ok(note.message.includes("COMPLETED_OK"), `notification must carry the child result text [${childId}]`);
      assert.ok(note.message.includes("Background task completed successfully"), `success notification [${childId}]`);
    }
  });

  it("session.status idle triggers completion", async () => {
    await expectSingleSuccessNotification("parent_status", "Status event test", (childId) => (events.status(childId)));
  });

  it("sync session.updated idle triggers completion", async () => {
    await expectSingleSuccessNotification("parent_sync", "Sync event test", (childId) => (events.updated(childId)));
  });

  it("multiple rapid completions each notify", async () => {
    const children = [];
    for (const parentId of ["p1", "p2", "p3"]) {
      children.push({ parent: parentId, child: await spawn(parentId, `Task ${parentId}`) });
    }

    for (const { child } of children) {
      await harness.fireEvent(events.idle(child));
    }

    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, 3, "3 notifications for 3 completions");
    for (const { parent, child } of children) {
      const note = harness.noticeFor(child);
      assert.ok(note, `notification must reference ${child}`);
      assert.strictEqual(note.to, parent, `notification for ${child} must go to ${parent}`);
    }
  });

  it("error status yields error-kind notification", async () => {
    const childId = await spawn("err_parent", "Error test");

    await harness.fireEvent(events.errorUpdate(childId));

    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, 1, "exactly 1 notification");
    assert.match(notes[0], /ended with an error/i, "error-kind notification");
    assert.ok(!notes[0].includes("completed successfully"), "must not be a success notification");
  });

  it("deleted session is a failure, never a success", async () => {
    const childId = await spawn("del_parent", "Deletion test");
    const note = await harness.noticeAfter(events.deleted(childId));
    assert.match(note.message, /ended with an error/i, "deletion must read as failure");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `retained state must be error. Got: ${detail}`);
  });

  it("repeated idle events settle exactly once", async () => {
    const childId = await spawn("race_parent", "Race test");
    for (let i = 0; i < 3; i++) {
      await harness.fireEvent(events.idle(childId));
    }
    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, 1, "first event wins; later ones are no-ops");
    assert.match(notes[0], /completed/i);
  });

  it("the plugin arms no timers: silence follows a spawn until an event arrives", async () => {
    const childId = await spawn("patient_parent", "No-timer test");
    await sleep(250);
    assert.strictEqual(harness.notices().length, 0, "nothing settles without an event");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("active"), `task remains tracked and active. Got: ${detail}`);
  });

  it("a late error after success escalates the record and notifies once", async () => {
    const childId = await spawn("escalate_parent", "Escalation test");
    await harness.fireEvent(events.idle(childId));
    assert.strictEqual(harness.notices().length, 1, "success first");

    await harness.fireEvent(events.error(childId));
    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, 2, "the contradicting failure is reported");
    assert.match(notes[1], /ended with an error/i);
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `record escalates completed→error. Got: ${detail}`);

    // A second error event cannot re-notify or regress the record further.
    await harness.fireEvent(events.error(childId));
    assert.strictEqual(harness.notices().length, 2, "escalation happens once");
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
    const before = harness.notices().length;

    await harness.fireEvent(events.idle("nonexistent_session"));

    assert.strictEqual(harness.notices().length, before, "no notification for untracked session");
  });
});
