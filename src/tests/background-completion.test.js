/**
 * Background settlement — production-driven.
 *
 * Every test spawns a REAL task through the plugin's dynamic_task tool and
 * settles it through the REAL event handler. No mirrored registration or
 * lifecycle logic: this suite fails when production regresses (Tenet 12).
 * The contract under test is non-blocking: tools return immediately, the
 * plugin arms no timers, and every task settles exactly once by event.
 */

import { describe, it, beforeEach, assert } from "./support/runner.js";
import { renderedAgeSeconds, setupHarness, sleep } from "./support/harness.js";
import { events } from "./support/mock-host.js";
import { textDeclaresKind } from "./support/assertions.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";

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

  /**
   * How many notifications the parent actually received, with the bodies in the
   * failure message. The COUNT is the contract this file exists to check — a
   * settlement that notifies twice, or a duplicate that never got dialed, is
   * invisible in the text of any single notice — so it gets one assertion shape
   * instead of a hand-written pair per test.
   */
  const assertNotices = (expected, why) => {
    const notes = harness.noticeBodies();
    assert.strictEqual(notes.length, expected, `${why}. got ${notes.length}: ${JSON.stringify(notes)}`);
  };

  async function expectSingleSuccessNotification(parentId, description, buildEvent) {
    const childId = await spawn(parentId, description);
    await harness.fireEvent(buildEvent(childId));
    assertNotices(1, "exactly 1 completion notification");
    const [note] = harness.noticeBodies();
    textDeclaresKind(note, "completed", "the success kind");
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
    assertNotices(1, "settlement still notifies");
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
      textDeclaresKind(note.message, "completed", `success notification [${childId}]`);
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

    assertNotices(3, "3 notifications for 3 completions");
    for (const { parent, child } of children) {
      const note = harness.noticeFor(child);
      assert.ok(note, `notification must reference ${child}`);
      assert.strictEqual(note.to, parent, `notification for ${child} must go to ${parent}`);
    }
  });

  it("error status yields error-kind notification", async () => {
    const childId = await spawn("err_parent", "Error test");

    await harness.fireEvent(events.errorUpdate(childId));

    assertNotices(1, "exactly 1 notification");
    textDeclaresKind(harness.noticeBodies()[0], "error", "error-kind notification");
  });

  it("deleted session is a failure, never a success", async () => {
    const childId = await spawn("del_parent", "Deletion test");
    const note = await harness.noticeAfter(events.deleted(childId));
    textDeclaresKind(note.message, "error", "deletion must read as failure");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `retained state must be error. Got: ${detail}`);
  });

  it("repeated idle events settle exactly once", async () => {
    const childId = await spawn("race_parent", "Race test");
    for (let i = 0; i < 3; i++) {
      await harness.fireEvent(events.idle(childId));
    }
    assertNotices(1, "first event wins; later ones are no-ops");
    assert.match(harness.noticeBodies()[0], /completed/i);
  });

  it("the plugin arms no timers: silence follows a spawn until an event arrives", async () => {
    const childId = await spawn("patient_parent", "No-timer test");
    await sleep(250);
    assertNotices(0, "nothing settles without an event");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("active"), `task remains tracked and active. Got: ${detail}`);
  });

  it("a late error after success escalates the record and notifies once", async () => {
    const childId = await spawn("escalate_parent", "Escalation test");
    // The contradicting failure, as an event, stated once because this case
    // delivers it twice: the second time it must change nothing.
    const contradicts = () => harness.fireEvent(events.error(childId));
    await harness.fireEvent(events.idle(childId));
    assertNotices(1, "success first");

    await contradicts();
    assertNotices(2, "the contradicting failure is reported");
    textDeclaresKind(harness.noticeBodies()[1], "error", "the contradiction is reported as one");
    const detail = await harness.tool.task_status.execute({ session_id: childId });
    assert.ok(detail.includes("error"), `record escalates completed→error. Got: ${detail}`);

    // A second error event cannot re-notify or regress the record further.
    await contradicts();
    assertNotices(2, "escalation happens once");
  });

  // WHICH kind of failure it was is the fact a parent most needs, and a failure
  // that arrives after a success is not exempt from it: without a class the
  // escalation reads as broken work, and a parent told a socket reset was a
  // broken child spends a turn on the network. The transcript is in scope on
  // this path — it was just read to build the notice — so the class is a
  // decision the code is already in a position to make.
  //
  // Both classes, because a stamp that is always the conservative answer is
  // indistinguishable from no stamp at all: the one that must never be wrong is
  // the blip read as structural, and only a case that also sees a blip read as
  // transient can say the distinction survives here.
  for (const [detail, className] of [
    ["fetch failed: socket hang up", "transient"],
    ["Provider auth failed: invalid API key", "structural"],
  ]) {
    it(`a late failure is recorded and announced as ${className}`, async () => {
      const childId = await spawn(`late_${className}_parent`, `late ${className}`);
      await harness.fireEvent(events.idle(childId));
      assertNotices(1, "the success is notified first");

      harness.client.setTranscript(childId, [{ info: { role: ASSISTANT_ROLE, error: { data: { message: detail } } } }]);
      await harness.fireEvent(events.error(childId));

      assert.match(
        harness.noticeBodies()[1],
        new RegExp(`Failure class: ${className}`),
        "the parent is told which kind of failure it is",
      );
      const status = await harness.tool.task_status.execute({ session_id: childId });
      assert.match(status, new RegExp(`Failure class: ${className}`), `the record keeps the class. Got: ${status}`);
    });
  }

  it("a working child's own events count as recent activity", async () => {
    const childId = await spawn("parent_activity", "Activity test");
    await sleep(1200);
    const silent = await harness.tool.task_status.execute({ session_id: childId });
    assert.match(silent, /Last plugin event: \d+s ago/, `starts at the spawn. Got: ${silent}`);

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
    const activity = renderedAgeSeconds(detail, "Last plugin event");
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

    assertNotices(before, "no notification for untracked session");
  });
});
