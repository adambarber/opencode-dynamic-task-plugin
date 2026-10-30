// The spawn-failure path is the FOURTH place the settlement debt pair can be
// split (#57, after #51's three lifecycle chokepoints). A failed spawn that
// already created a session settles it to Error AND sends a delivery — but a
// real `await abortSession` sits between the durable terminal claim and the
// parent-owed debt, so a process that died inside the abort left a settled
// error record with no debt and no delivery claim. The next boot had nothing
// to redeliver; the parent was never told, forever.
//
// The fix applies the same reserve-after-claim shape #51 established: the
// placeholder debt (child + kind = error) is taken the moment the spawn-failure
// claim lands, BEFORE the abort await. Its identity dedups against the real debt
// `deliverParent` writes once the abort answers, so a crash in the gap leaves the
// placeholder — and that is the residue a boot redelivers. Both halves are
// asserted here (mirroring settlement-crash-window.test.js): the debt exists on
// disk BEFORE the abort answers, and a boot on the residue re-notifies.

import { assert, describe, it, waitFor, withSingleSlot } from "./support/index.js";
import { pendingOwedTo, residueBoot } from "./support/settlement-debt.js";
import { twoSlotRace } from "./support/stop-scenarios.js";

/**
 * One slot, and two dispatches racing for it, with the loser's abort HELD open.
 * Both sessions are created, one claims the slot, the OTHER cannot be registered
 * — the created-but-untracked session the spawn-failure path aborts. The abort is
 * the very await a crash could interrupt, so it is gated: the failure path parks
 * there mid-delivery, and what is on disk at that moment is the crash residue.
 * The mock records the id BEFORE it parks, so the orphan is both thrown and
 * locatable. A fixture rather than the case body, so the debt statement is the
 * case and the arrangement is not.
 */
async function withSpawnFailureParkedAtAbort() {
  const h = await withSingleSlot();
  const gate = h.client.gateAbort();
  const both = Promise.allSettled(twoSlotRace(h));
  await waitFor(() => h.client.testState.abortAttempts.length >= 1, "the refused spawn to reach its abort");
  const [orphan] = h.client.testState.abortAttempts;
  return { both, gate, h, orphan };
}

describe("a crash between the spawn-failure claim and its delivery must not silence the parent", () => {
  it("writes the error settlement debt to disk BEFORE the abort answers", async () => {
    const { both, gate, h, orphan } = await withSpawnFailureParkedAtAbort();
    assert.strictEqual(typeof orphan, "string", "fixture: the refused spawn must have an orphan session to abort");

    // The spawn-failure path is now parked at the abort. The debt must already be
    // durable and carry the settled child and error kind — the claim the next boot
    // needs in order to re-notify the parent at all.
    await waitFor(() => pendingOwedTo(h, orphan).length === 1, "the error settlement debt to be on disk before the abort is read");
    const [debt] = pendingOwedTo(h, orphan);
    assert.strictEqual(debt.kind, "error", "the debt carries the error kind the spawn-failure claimed");

    // Release the held abort so the failure path finishes and no coroutine leaks;
    // the real delivery rewrites the placeholder debt, and the parent hears once.
    gate.release();
    await both;
    await waitFor(() => h.noticeBodies().length >= 1, "the spawn failure still delivers once the abort answers");
  });

  it("redelivers the placeholder error debt across a restart", async () => {
    // The on-disk residue a crash leaves AFTER the fix: a retained (settled-error)
    // record and a pending placeholder debt carrying that child and error kind.
    // This is the shape the previous case's debt becomes the moment the process dies.
    const boot = await residueBoot({ childSessionId: "ses_spawn", kind: "error" });

    // Boot redelivery offers the placeholder as a real write to the parent.
    await waitFor(() => pendingOwedTo(boot, "ses_spawn").length === 0, "the debt to be paid and retired from disk");
    const noticeBody = boot.noticeBodies().find((body) => body.includes("ses_spawn"));
    assert.ok(noticeBody, "the parent is re-notified about the reserved task on the next boot");
  });
});
