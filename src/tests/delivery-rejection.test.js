// A delivery that FAILS must never become a process-killing unhandled rejection.
//
// Every parent-directed write is fire-and-forget by contract (see deliverParent's
// docblock): call sites void it and attach only `.then`. On the code this file
// falsified, a rejected durable read during the delivery-claim walk traveled out of
// notifyParent uncaught — out of deliverParent to `.then`-only call sites, and out of
// redeliverOwedNotifications to a bare `void` — and Node >= 15 answers an unhandled
// rejection by killing the whole host process. One failed host read during one
// settlement, and the operator's editor dies.

import { deliverParent } from "../../dist/entry/lifecycle.js";
import { NotifyKind } from "../../dist/shared/notification-text.js";
import { getLatestNotification, owedDelivery, redeliverOwedNotifications, restorePendingDeliveries } from "../../dist/shared/notify.js";
import { afterEach, answerSays, assert, cleanNotifyState, describe, it, opaqueHost, PARENT, setupHarness, waitFor } from "./support/index.js";

/** The debt a boot re-offers: one owed write, built by the queue's own builder. */
const owedDebt = (childSessionId) =>
  owedDelivery({ childSessionId, kind: NotifyKind.Completed, parentSessionId: PARENT }, "owed notice", 1);

describe("a delivery whose durable read fails is contained, never fatal", () => {
  // A storage fault no longer REJECTS the claim walk: durable-store.load converts a
  // scan rejection into a partial read, takeDeliveryClaim reads a partial -> "revoked",
  // and a revoked claimant still dials (the parent's own transport is fine). The right
  // assertion is therefore containment — the settlement is delivered, the host is not
  // killed, the storage loss is still reported — not a non-delivery invented by a
  // rejection that no longer happens.
  it("a settlement whose delivery-claim read is unreadable is still delivered and leaves the host alive", async () => {
    const hb = {};
    const h = await setupHarness({ hooks: hb });
    // spawn first so the boot's own read is unaffected, then arm the fault
    const { c } = await h.spawn();
    hb.storageThrows = true;
    await c.settle();
    await waitFor(() => getLatestNotification(c.id) !== null, "the settlement's delivery record");
    assert.strictEqual(
      getLatestNotification(c.id).delivered,
      true,
      "the partial read degrades to a revoked claim that still dials, not a lost delivery",
    );
    answerSays(h.prose(), "storage unavailable", "the operator is still told the store would not answer");
  });

  it("deliverParent survives an unreadable durable claim read and still delivers", async () => {
    const hb2 = {};
    const h = await setupHarness({ hooks: hb2 });
    hb2.storageThrows = true;
    const verdict = await deliverParent(opaqueHost(h.client), PARENT, "ses_child", "bg task", NotifyKind.Error, "the text");
    assert.strictEqual(verdict, true, "the partial read degrades to a revoked claim that still dials, never an unhandled rejection");
    assert.strictEqual(getLatestNotification("ses_child").delivered, true, "and the parent is told");
    answerSays(h.prose(), "storage unavailable", "and the store's refusal is still on the operator's log");
  });

  it("a boot that redelivers an owed notice survives a failing durable read", async () => {
    const hookBag3 = {};
    const h = await setupHarness({ hooks: hookBag3 });
    restorePendingDeliveries([owedDebt("ses_owed")]);
    hookBag3.storageThrows = true;
    redeliverOwedNotifications(opaqueHost(h.client), 3);
    await waitFor(() => h.prose().includes("storage unavailable"), "the redelivery's failure on the log");
    restorePendingDeliveries([]);
  });
});

afterEach(cleanNotifyState);
