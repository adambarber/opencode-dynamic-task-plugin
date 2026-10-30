// A settlement is TWO durable facts that a crash must not be able to split:
// "the task settled" (the retained claim) and "the parent is owed a notice"
// (the pending debt). `settleRunningChild` took the first, then read the child's
// transcript (up to 5s), and only then queued the second — so a process that died
// inside that read left a settled record with no debt and no delivery claim, and
// the next boot had nothing to redeliver. The parent was never told, forever.
//
// The fix queues a placeholder debt the moment the settlement claim lands. Its
// identity is (child + kind), independent of the message text, so the real debt
// the delivery writes a moment later replaces it; only when the process dies in
// the gap is the placeholder what survives — and that is exactly the case it was
// written for. Both halves of that contract are asserted here: the debt exists
// on disk BEFORE the transcript read answers, and a boot redelivers the
// placeholder to the parent.

import { formatParentNotification } from "../../dist/shared/notification-text.js";
import { setupHarness } from "./support/harness.js";
import { assert, bootOn, describe, it, ledgerSays, owedEntry, retainedEntry, waitFor } from "./support/index.js";

/**
 * The durable pending queue as the next boot would read it: one child's slice,
 * under THIS project's directory. A crash assert reads the disk, not the
 * in-memory queue, because the claim is what SURVIVES a restart.
 */
const pendingOwedTo = (boot, childSessionId) =>
  ledgerSays(boot.kv, boot.directory).pending.filter((debt) => debt.childSessionId === childSessionId);

describe("a crash between settlement and delivery must not silence the parent", () => {
  it("writes the settlement debt to disk BEFORE reading the child's transcript", async () => {
    const h = await setupHarness();
    const { id } = await h.spawn({ description: "crash-window task" });

    // Arm the host to HOLD the next transcript read. The crash this queue exists
    // for is a process dying inside that read: the settlement claim has landed,
    // the delivery debt has not. Holding the read parks `settleRunningChild`
    // exactly there, so what is on disk at this moment is the crash residue.
    const gate = h.client.gateMessageRead();
    await h.settle(id);

    // The settlement is now parked at the transcript read. The debt must already
    // be durable and carry the settled child and kind — the claim the next boot
    // needs in order to re-notify the parent at all.
    await waitFor(() => pendingOwedTo(h, id).length === 1, "the settlement debt to be on disk before the transcript is read");
    const [debt] = pendingOwedTo(h, id);
    assert.strictEqual(debt.kind, "completed", "the debt carries the verdict the settlement claimed");

    // Release the held read so the settlement finishes and no coroutine leaks;
    // the real delivery rewrites the placeholder debt, and the parent hears once.
    gate.release();
    await waitFor(() => h.noticeBodies().length >= 1, "the settlement still delivers once the transcript read answers");
  });

  it("redelivers a placeholder debt across a restart", async () => {
    // The on-disk residue a crash leaves AFTER the fix: a retained (settled)
    // record and a pending placeholder debt carrying that child and kind. This is
    // the boot shape the previous case's debt becomes the moment the process dies.
    const boot = await bootOn(() => ({
      // A real notice from the real renderer, dated so the ledger reader keeps it:
      // the reader drops an undated pending row, which would make this case pass
      // by never seeding the debt at all.
      pending: [owedEntry({
        childSessionId: "ses_reserve",
        kind: "completed",
        parentSessionId: "ses_parent",
        text: formatParentNotification({ childSessionId: "ses_reserve", description: "reserved" }, "completed", "reserved this"),
      })],
      tasks: {
        ses_reserve: retainedEntry({
          agentName: "general",
          childSessionId: "ses_reserve",
          description: "reserved",
          parentSessionId: "ses_parent",
        }),
      },
    }));

    // Boot redelivery offers the placeholder as a real write to the parent.
    await waitFor(() => pendingOwedTo(boot, "ses_reserve").length === 0, "the debt to be paid and retired from disk");
    const noticeBody = boot.noticeBodies().find((body) => body.includes("ses_reserve"));
    assert.ok(noticeBody, "the parent is re-notified about the reserved task on the next boot");
  });
});
