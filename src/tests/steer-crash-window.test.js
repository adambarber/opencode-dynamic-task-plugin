// A crash between a serverGone steer's durable claim and its delivery must not
// silence the parent (#59). The steer's serverGone arm settles the task to Error
// and then notifies, but the real `deliverParent` queues its debt only after an
// `await takeDeliveryClaim` — the same async window every other settlement path
// closes with a synchronous reserve (#51/#57). A process that died in that window
// left a settled error record with no debt and no delivery claim; the next boot
// had nothing to redeliver, and the parent was never told, forever.
//
// The fix applies the same reserve-after-claim shape #51 established: the
// placeholder debt (child + kind = error) is taken the moment the serverGone
// claim lands, BEFORE the notify. Its identity dedups against the real debt
// `deliverParent` writes once the claim walk answers, so a crash in the gap
// leaves the placeholder — and that is the residue a boot redelivers. Both halves
// are asserted here (mirroring settlement-crash-window.test.js and
// spawn-settlement-crash-window.test.js): the debt exists on disk BEFORE the
// delivery-claim walk answers, and a boot on the residue re-notifies.

import { configureDeliveryClaims, resetDeliveryClaims } from "../../dist/shared/notify.js";
import { claimStoreFirstRead } from "./support/delivery-claim-store.js";
import { assert, describe, it, waitFor, withChild } from "./support/index.js";
import { pendingOwedTo } from "./support/settlement-debt.js";

/**
 * A child steered to a vanished session, with the notify's delivery-claim read
 * HELD open. `abortFailIds` makes the abort answer that the session is gone, so
 * the serverGone arm settles Error and delivers. The delivery-claim walk is the
 * very await a crash could interrupt, so its first read is gated: the arm parks
 * there mid-delivery, and what is on disk at that moment is the crash residue.
 * The mock records the read before it parks, so the arrival is observable and the
 * test does not sleep for it. A dedicated file, because the claim store is
 * process-global and the share it with an existing file would let a prior test's
 * in-flight delivery trip the gate.
 */
async function withServerGoneParkedAtClaimRead() {
  const { h, c, id } = await withChild({ harness: { hooks: { abortFailIds: new Set(["ses_mock_1"]) } } });
  let parked = false;
  let release = undefined;
  const gated = new Promise((resolve) => { release = resolve; });
  configureDeliveryClaims(claimStoreFirstRead(() => {
    parked = true;
    return gated;
  }));
  const steer = c.steer("pivot");
  await waitFor(() => parked, "the delivery-claim read to be reached and parked");
  return { gate: { release }, h, id, steer };
}

describe("a crash between the serverGone steer claim and its delivery must not silence the parent", () => {
  it("writes the error settlement debt to disk BEFORE the delivery-claim read answers", async () => {
    const { gate, h, id, steer } = await withServerGoneParkedAtClaimRead();

    // The arm is now parked at the delivery-claim read. The debt must already be
    // durable and carry the settled child and error kind — the claim the next boot
    // needs in order to re-notify the parent at all.
    const [debt] = pendingOwedTo(h, id);
    assert.ok(debt, "the error settlement debt must be on disk while the claim read is held");
    assert.strictEqual(debt.kind, "error", "the debt carries the error kind the serverGone arm claimed");
    assert.strictEqual(debt.childSessionId, id, "the debt is owed for the vanished session");

    // Release the held claim read so the delivery finishes and no coroutine leaks;
    // the real delivery rewrites the placeholder debt, and the parent hears once.
    gate.release();
    await steer;

    resetDeliveryClaims();
  });
});
