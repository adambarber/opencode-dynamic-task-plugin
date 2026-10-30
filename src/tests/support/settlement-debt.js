// The settlement-debt fixtures shared by the crash-window suites. A settlement is
// TWO durable facts a crash must not split — "the task settled" (the retained
// claim) and "the parent is owed a notice" (the pending debt) — and every path
// that lands the claim then takes the debt asynchronously (settleRunningChild
// across a transcript read, the spawn-failure path across an abort) needs the
// same two assertions: the debt is durable on disk before the gap, and a boot on
// the residue re-notifies. Both were spelled out in settlement-crash-window.test.js
// and again in spawn-settlement-crash-window.test.js before being lifted here.

import { formatParentNotification } from "../../../dist/shared/notification-text.js";
import { bootOn, ledgerSays, owedEntry, retainedEntry } from "./index.js";

/**
 * The durable pending queue as the next boot would read it: one child's slice,
 * under THIS project's directory. A crash assert reads the disk, not the
 * in-memory queue, because the claim is what SURVIVES a restart.
 */
export const pendingOwedTo = (boot, childSessionId) =>
  ledgerSays(boot.kv, boot.directory).pending.filter((debt) => debt.childSessionId === childSessionId);

/**
 * The on-disk residue a crash leaves after the fix: a retained (settled) record
 * and a pending placeholder debt carrying that child and kind. This is the boot
 * shape a crashed debt becomes. A real notice from the real renderer, dated so
 * the ledger reader keeps it — the reader drops an undated pending row, which
 * would make a case pass by never seeding the debt at all.
 */
export const residueBoot = ({ childSessionId, kind }) =>
  bootOn(() => ({
    pending: [owedEntry({
      childSessionId,
      kind,
      parentSessionId: "ses_parent",
      text: formatParentNotification({ childSessionId, description: "reserved" }, kind, "reserved this"),
    })],
    tasks: {
      [childSessionId]: retainedEntry({
        agentName: "general",
        childSessionId,
        description: "reserved",
        parentSessionId: "ses_parent",
        state: kind,
      }),
    },
  }));
