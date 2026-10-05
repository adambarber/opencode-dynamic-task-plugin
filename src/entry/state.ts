// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.
import type { PluginOptions } from "@opencode/plugin";
import type { DynamicTaskConfig } from "../shared/config.js";
import { readDynamicTaskPolicy } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks, restoreActive, restoreRetained } from "../shared/task-state.js";
import type { LedgerChange } from "../shared/ledger-change.js";
import { LedgerChangeKind } from "../shared/ledger-change.js";
import { loadTaskLedger, mergeLedgerChange, resolveTaskLedgerPath, saveTaskLedger } from "../shared/session-lifecycle.js";
import { errorMessage } from "../shared/host-shape.js";
import { agentOverlayPath, applyAgentOverlay, installLiveAgentCaps, readAgentOverlay, retiredLaneOverlayPath, retiredOverlayPresent } from "../shared/caps.js";
import { SessionExistence, hostTurnRunning, readLiveness, readSessionPresence } from "../shared/liveness.js";
import { releaseWaitingDispatches, settleRunningChild } from "./lifecycle.js";
import {
  configurePendingPersistence,
  containFailure,
  getPendingDeliveries,
  redeliverOwedNotifications,
  restorePendingDeliveries,
  safeLog,
} from "../shared/notify.js";
import type { OpaqueHost } from "../shared/client.js";
import { configureDebugRoot, debugLog } from "../debug-logger.js";

// Plugin-level state store (ephemeral — lost on restart)
export interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
}

/**
 * Answer every wait this settlement decided, from the store's own change sink.
 *
 * Module scope because it captures nothing: it takes the host and the store
 * as arguments, so nesting it inside the boot only shadowed both names. The
 * hook is the store's, and that is the entire argument for it. A settlement
 * is the fact that answers a wait, and the store already publishes every fact
 * about itself — so the sink is the one place where "a task ended" is
 * observable BY CONSTRUCTION rather than by remembering to say so. The five ways
 * a task can end (a host lifecycle event, a post-create failure, a lost server, a
 * refused turn, an operator interrupt) each settle through their own call site,
 * and one of them was the only one that also told the waiting parents; the other
 * four held `depends_on` waits until the wait registry evicted them, which is
 * silent, bounded by a cap, and indistinguishable from a child that is merely
 * slow. Calling the release from each site would have been the same four
 * omissions waiting for the fifth.
 *
 * After `persistLedger` on purpose: the durable record should exist before
 * anyone is told the edge is gone, so a process that dies mid-release re-reads a
 * ledger that already knows.
 *
 * Only `Settled`, and the exclusion is deliberate rather than an oversight.
 * `Forgotten` is a task being evicted from a bounded history — by then it
 * settled, which is when its waits were answered; releasing again would be a
 * second readiness rule for the same edge. A wait naming a task settled in
 * ANOTHER process is a different hole, and it is the shared-ledger adoption gap
 * recorded in docs/tasks/11-durability.md rather than something a hook on this
 * process's own changes could see.
 */
function releaseWaitsForSettled(host: OpaqueHost, store: TaskStore, changes: readonly LedgerChange[]): void {
  for (const change of changes) {
    if (change.kind === LedgerChangeKind.Settled) releaseWaitingDispatches(host, store, change.id);
  }
}

export function initPluginState(directory: string, options: PluginOptions | undefined, host: OpaqueHost): PluginState {
  // The file's own caps, over the defaults, over env — by the ONE reader the TUI also
  // calls, so the screen an operator reads and the policy a dispatch is judged against
  // cannot be derived from two different files.
  const config = readDynamicTaskPolicy(directory, options ?? null);
  const store = createTaskStore();

  // State is scoped to the project directory the host provides (the same
  // root as the config file above) — never the process CWD, which for
  // tests and multi-project hosts is somebody else's tree.
  configureDebugRoot(directory);
  const ledgerPath = resolveTaskLedgerPath(directory);
  installLiveAgentCaps(() => {
    const { raw, problem } = readAgentOverlay(directory);
    // Reported once, at the one moment a client exists. The per-dispatch read is
    // silent by design (a log line on every refusal would be noise), so without
    // this a mangled overlay would simply never apply and the operator would see
    // the old cap with no explanation anywhere.
    if (problem !== null) {
      void safeLog("warn", `Dynamic task plugin: ignoring the agent overlay at ${agentOverlayPath(directory)} — ${problem}. The config file's caps are in force.`);
      debugLog("plugin", "agents", "agent-overlay-ignored", { path: agentOverlayPath(directory), reason: problem });
    }
    // The overlay this one replaced, named rather than ignored. Deleting a file the
    // plugin used to read is the kind of change that looks like a bug from the
    // outside: an operator who had a cap working last week finds it silently not
    // applying, and the only way to tell that from a mis-set number is to be told.
    // Silently reading it is the alternative, and it is wrong in a way that cannot
    // be undone — a lane file whose entries are agent names would re-apply caps
    // under a key the operator never wrote, and the map from lane to agent is
    // exactly the thing that was deleted.
    if (retiredOverlayPresent(directory)) {
      void safeLog("warn", `Dynamic task plugin: ${retiredLaneOverlayPath(directory)} is left over from the lane feature and is NOT read. ` +
        "Caps are now keyed by agent name, and that file's keys were operator-invented. Delete it and re-set the caps you still want.");
      debugLog("plugin", "agents", "retired-lane-overlay", { path: retiredLaneOverlayPath(directory) });
    }
    return applyAgentOverlay(config, raw);
  });

const ledger = loadTaskLedger(ledgerPath);
  // A discarded ledger is a LOST one, and the loss is only actionable if the
  // operator is told. It used to be a bare `catch {}` that returned an empty
  // document, which is indistinguishable from a project that has never run a
  // task — so a parent owed a completion notice simply never received it, with
  // no log, no record, and nothing in any read to show for it. Two channels,
  // matching the write failure below: the host log, which is always on and is
  // where an operator looks when a project has lost track of its tasks, and the
  // structured debug line, which carries the path. The write failure below is
  // reported on both for the same reason, which is the reason it is now
  // reported on both.
  if (ledger.discarded !== null) {
    // What the operator can DO about it is part of the report. Telling a project
    // its records are gone, and then replacing the file those records were in,
    // makes the instruction impossible to follow: there is nothing left to
    // inspect, and no way to tell a foreign version from a v3 file this build
    // merely failed to parse. So the sentence carries both halves — what was
    // lost, and that the file is being left alone until it is dealt with.
    const remedy = ledger.unreadable
      ? " This build will not write to that file either; move it aside or delete it to let durable state resume."
      : " Records that did parse are still in use and are written back.";
    void safeLog("warn", `Dynamic task plugin: the durable task ledger at ${ledgerPath} was discarded — ${ledger.discarded}. Tasks and owed notifications recorded there are gone.${remedy}`);
    debugLog("plugin", "ledger", "ledger-read-discarded", { path: ledgerPath, reason: ledger.discarded });
  }
  // One writer for the whole file. Retained records and owed notices live in one
  // document, so they are written together: a persist that could update one and
  // lose the other is the same deafness this file exists to prevent.
  const persistLedger = (changes: readonly LedgerChange[]) => {
    if (changes.length === 0) return;
    try {
      // Re-read, apply, write. The read is the price of not being the process
      // that deletes someone else's running task: this file is shared by every
      // opencode process in the project, and a write that carried this process's
      // whole private view would silently erase the others' records. See
      // `mergeLedgerChange` for the policy and the ruling behind it.
      //
      // A ledger that cannot be read is treated as the one it was before the
      // change rather than as an invitation to write a fresh slate over another
      // process's children. `unreadable` is what makes that promise true: it is
      // the distinction between a file this build READ and one it never saw at
      // all, and only the second may not be written. The refusal costs this
      // project its durable state until an operator acts — which is loud, and
      // bounded, and reversible; the alternative destroys the file the operator
      // was just told to go and look at, which is neither.
      const current = loadTaskLedger(ledgerPath);
      if (current.unreadable) {
        void safeLog("warn", `Dynamic task plugin: not writing the task ledger at ${ledgerPath} — ${current.discarded}. The file has been left as it was found, and this project's durable task state is off until it is dealt with.`);
        debugLog("plugin", "ledger", "ledger-write-refused", {
          path: ledgerPath,
          reason: current.discarded,
        });
        return;
      }
      saveTaskLedger(mergeLedgerChange(current, changes), ledgerPath);
    } catch (error) {
      // Swallow so a durable-state failure can never break control flow — and
      // RECORD it, because silence here is the worst possible answer. The
      // comment above promises "the next mutation retries", and that promise has
      // a hole: on a run whose last mutation is the one that fails (a child
      // settles, the operator quits), there is no next mutation, the settlement
      // never reaches the disk, and the next boot finds a child still active
      // with a completion notice nobody was told about. The plugin's whole claim
      // is that it does not lose track of a child, so a lost write is the one
      // thing it may not lose quietly.
      //
      // Project-level, not task-level: a write carries every record at once, so
      // it belongs to no single child. One well-known file is more findable than
      // the same line scattered across a hundred task logs.
      //
      // BOTH channels, because the comment above the read failure claimed this
      // symmetry and only half of it was true: a lost WRITE went to a debug log
      // that is off unless DYNAMIC_TASK_DEBUG=1, so the one loss that leaves a
      // child active forever with no notice owed to anyone was the quietest of
      // all — while the loss the host log reports is the one an operator has
      // already had to notice. The host log is the channel that needs no
      // environment variable set before the process started, which is the only
      // kind an operator can rely on being there.
      void safeLog("warn", `Dynamic task plugin: a write to the task ledger at ${ledgerPath} failed — ${errorMessage(error)}. Task state in this project is not being saved until it succeeds; the in-memory state is still correct for this session.`);
      debugLog("plugin", "ledger", "ledger-write-failed", {
        error: errorMessage(error),
        path: ledgerPath,
      });
    }
  };
  // Ledger sync: every retained mutation and every change to the running set
  // persists, through the one writer that holds the whole file. Errors are
  // swallowed here so a durable-state failure can never break control flow.
  store.onRetainedChange = (changes) => {
    persistLedger(changes);
    releaseWaitsForSettled(host, store, changes);
  };
  store.onActiveChange = persistLedger;
  configurePendingPersistence(persistLedger);

  // Crash recovery: rehydrate retained tasks and the running set, and take
  // ownership of the notices the last boot owed.
  restoreRetained(store, ledger.retained, config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);
  restorePendingDeliveries(ledger.pending);

  // The boot pass is the one moment every debt from the last run is visible at
  // once, and until this line existed it was the one moment nothing was. Measured
  // 2026-09-28: a parent left wedged mid-turn, re-injected on every restart by
  // the pay below, wrote no trace to any log — and its ledger was
  // indistinguishable from a healthy queue, because a debt that is still owed
  // and a debt that is owed to a session that will never take it look the same
  // on disk. So the debt is named at the moment it is found, with the count it
  // has and the count it may reach.
  //
  // That pairing is diagnostic, not decoration, and it is only diagnostic because
  // the deferral now spends: this line was originally justified by the fact that a
  // deferred debt could NOT reach its budget, which made the count a dead number
  // and this report useless for the failure it was written for. Now a count that
  // climbs across restarts means the parent is still mid-turn, and a count that
  // reaches the end retires the debt as undelivered — so the log is the place
  // where either is visible instead of inferred.
  const owedDebts = getPendingDeliveries();
  if (owedDebts.length > 0) {
    const each = owedDebts
      .map((debt) => `${debt.kind} for task ${debt.childSessionId} to parent ${debt.parentSessionId} (attempt ${debt.attempts + 1} of ${config.pendingMaxAttempts})`)
      .join("; ");
    void safeLog("info", `Dynamic task plugin: carrying ${owedDebts.length} notification(s) owed from a previous run — ${each}. A parent that is mid-turn defers its notice and spends an attempt for it, so a count that climbs across restarts means the parent is still busy and one that reaches the end retires the notice as undelivered.`);
  }

  // The running set is restored BEFORE the pending notices are paid, and
  // reconciliation is detached (below), so an owed notice and a vanished
  // child's notice can neither mask nor reorder each other.
  const restored = restoreActive(store, ledger.active);
  if (restored > 0) void reconcileRestored(host, store);

  // Pay the debt, oldest first, one pass and no waiting — through the one
  // re-offer of the queue, which is also where the budget comes from, so no
  // caller can dial a debt without it. The fan-out is capped at the same
  // concurrency the operator already allows live work: a redelivery is a real
  // turn, so a queue is paid in batches rather than all at once.
  redeliverOwedNotifications(host, config.pendingMaxAttempts, config.maxConcurrent);

  return { config, store };
}

// One pass, at boot, over the tasks the last process left running — the
// reconciliation that gives the durable running set a meaning. Each restored
// task costs exactly one liveness read (the same read the read tools make) and
// then one of three honest outcomes:
//
//   a turn is running  → it stays active; its own terminal event settles it
//                         through the ordinary path, and there is nothing to do
//   the host says idle → the turn ended while we were gone: settled from the
//                         child's transcript, exactly as an event would settle it
//   the host lists none → gone: settled error, with a cause saying this plugin
//                         lost contact across the restart rather than that the
//                         work failed
//
// A word this plugin does not read is not on that list, and it is deliberately
// not folded into either end: it is not the host saying a turn ended, and it is
// not the host saying there is no child. It lands with the first row, because
// both of the other two are claims about a turn and this is not one.
//
// No polling, no clocks, no second opinion: the host's status words are the
// answer, read once. Detached from boot so a slow transcript cannot delay tool
// registration — the settlement itself is durable before it is delivered, so a
// boot that returns early has already recorded what it decided.
async function reconcileRestored(host: OpaqueHost, store: TaskStore): Promise<void> {
  const restored = [...store.activeTasks.keys()];
  void safeLog("info", `Reconciling ${restored.length} task(s) restored across restart`);
  for (const childSessionId of restored) {
    // Per child, not per pass: a read that fails (the status channel itself is
    // down) must not decide the fate of every task listed after it. Not knowing
    // leaves the task active — the safe reading, because its own terminal event
    // still settles it and nothing is notified that was not observed.
    try {
      const reading = await readLiveness(host, childSessionId);
      // Two facts, and this pass may only end a child on one of them. A turn the
      // host is running is left alone. A status channel that never answered is left
      // alone too: its silence is not evidence, and settling off it would invent the
      // very errors this pass exists to avoid.
      if (!reading.statusAnswered) {
        void safeLog("info", `Restored task ${childSessionId}: status channel unanswered; left active`);
        continue;
      }
      if (hostTurnRunning(reading)) {
        void safeLog("info", `Restored task ${childSessionId} is still running (host says "${reading.hostTurn}"); left active`);
        continue;
      }
      // No running turn, so the session's fate is the transcript's to say — which is
      // `settleRunningChild`'s own work. The one exception is a host that says it has
      // no such session, and that question has its own endpoint: the status map
      // cannot answer it, because "nothing running" and "never existed" look the
      // same in there.
      const presence = await readSessionPresence(host, childSessionId);
      if (presence.existence !== SessionExistence.Missing) {
        await settleRunningChild(host, store, childSessionId, { status: "idle" });
        continue;
      }
      // No cap source, and deliberately so: a boot-reconciled child is not a
      // candidate for the silent transient resume, and reviving a record would send
      // a prompt to a session the host has just denied having.
      await settleRunningChild(host, store, childSessionId, {
        cause: "The plugin restarted while this child was running, and the host then answered that it has no such session (404): the child vanished across the restart, so its work was never seen through — it did not fail.",
        status: "error",
      });
    } catch (error: unknown) {
      void containFailure(`Could not reconcile restored task ${childSessionId}`, error, "left active");
    }
  }
}
