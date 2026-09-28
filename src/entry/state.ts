// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.
import type { PluginOptions } from "@opencode-ai/plugin";
import type { DynamicTaskConfig } from "../shared/config.js";
import { readDynamicTaskPolicy } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks, restoreActive, restoreRetained } from "../shared/task-state.js";
import type { LedgerChange } from "../shared/ledger-change.js";
import { loadTaskLedger, mergeLedgerChange, saveTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { errorMessage } from "../shared/host-shape.js";
import { agentOverlayPath, applyAgentOverlay, installLiveAgentCaps, readAgentOverlay, retiredLaneOverlayPath, retiredOverlayPresent } from "../shared/caps.js";
import { hostTurnOver, readLiveness } from "../shared/liveness.js";
import { settleRunningChild } from "./lifecycle.js";
import {
  configurePendingPersistence,
  containFailure,
  getPendingDeliveries,
  notifyParent,
  restorePendingDeliveries,
  safeLog,
} from "../shared/notify.js";
import type { OpenCodeClient } from "../shared/client.js";
import { configureDebugRoot, debugLog } from "../debug-logger.js";

// Plugin-level state store (ephemeral — lost on restart)
export interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
}

export function initPluginState(directory: string, options: PluginOptions | undefined, client: OpenCodeClient): PluginState {
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
      void safeLog(client, "warn", `Dynamic task plugin: ignoring the agent overlay at ${agentOverlayPath(directory)} — ${problem}. The config file's caps are in force.`);
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
      void safeLog(
        client,
        "warn",
        `Dynamic task plugin: ${retiredLaneOverlayPath(directory)} is left over from the lane feature and is NOT read. ` +
          "Caps are now keyed by agent name, and that file's keys were operator-invented. Delete it and re-set the caps you still want.",
      );
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
    void safeLog(client, "warn", `Dynamic task plugin: the durable task ledger at ${ledgerPath} was discarded — ${ledger.discarded}. Tasks and owed notifications recorded there are gone.${remedy}`);
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
        void safeLog(client, "warn", `Dynamic task plugin: not writing the task ledger at ${ledgerPath} — ${current.discarded}. The file has been left as it was found, and this project's durable task state is off until it is dealt with.`);
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
      void safeLog(client, "warn", `Dynamic task plugin: a write to the task ledger at ${ledgerPath} failed — ${errorMessage(error)}. Task state in this project is not being saved until it succeeds; the in-memory state is still correct for this session.`);
      debugLog("plugin", "ledger", "ledger-write-failed", {
        path: ledgerPath,
        error: errorMessage(error),
      });
    }
  };
  // Ledger sync: every retained mutation and every change to the running set
  // persists, through the one writer that holds the whole file. Errors are
  // swallowed here so a durable-state failure can never break control flow.
  store.onRetainedChange = persistLedger;
  store.onActiveChange = persistLedger;
  configurePendingPersistence(persistLedger);

  // Crash recovery: rehydrate retained tasks and the running set, and take
  // ownership of the notices the last boot owed.
  restoreRetained(store, ledger.retained, config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);
  restorePendingDeliveries(ledger.pending);
  // The running set is restored BEFORE the pending notices are paid, and
  // reconciliation is detached (below), so an owed notice and a vanished
  // child's notice can neither mask nor reorder each other.
  const restored = restoreActive(store, ledger.active);
  if (restored > 0) void reconcileRestored(client, store);

  // Pay the debt, oldest first, one pass and no waiting. Every write goes back
  // through the gate — there is no second parent-write path — so a redelivery
  // the host HOLDS re-arms its own entry and waits for the next boot, and one
  // that lands is retired before the receipt is written.
  for (const owed of getPendingDeliveries()) {
    void notifyParent(client, owed.parentSessionId, owed.text, {
      childSessionId: owed.childSessionId,
      kind: owed.kind,
      carriedAttempts: owed.attempts,
    });
  }

  return { store, config };
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
async function reconcileRestored(client: OpenCodeClient, store: TaskStore): Promise<void> {
  const restored = [...store.activeTasks.keys()];
  await safeLog(client, "info", `Reconciling ${restored.length} task(s) restored across restart`);
  for (const childSessionId of restored) {
    // Per child, not per pass: a read that fails (the status channel itself is
    // down) must not decide the fate of every task listed after it. Not knowing
    // leaves the task active — the safe reading, because its own terminal event
    // still settles it and nothing is notified that was not observed.
    try {
      const reading = await readLiveness(client, childSessionId);
      // This pass may end a restored child two ways and no more: the host said
      // the turn is over, or the host stopped listing it. Every other reading —
      // working, retrying, or a word this plugin does not read — leaves it
      // active, because its own terminal event still settles it and nothing is
      // notified that was not observed. Deciding a child's fate from a word we
      // did not understand is how a restart invents an error.
      const vanished = reading.hostState === null;
      if (!vanished && !hostTurnOver(reading)) {
        await safeLog(
          client,
          "info",
          `Restored task ${childSessionId} is not over (host says "${String(reading.hostState)}"); left active`,
        );
        continue;
      }
      // No cap source, and deliberately so: a boot-reconciled child is not a
      // candidate for the silent transient resume. Most of what this pass settles
      // is a child that VANISHED across the restart, and reviving its record
      // would send a prompt to a session the host no longer has. The idle case
      // could be resumed, but a resume that mostly fires against children that
      // are gone is a worse trade than a message. So this pass always reports,
      // and the reason it can is the one that belongs: the parent was told its
      // child is missing.
      await settleRunningChild(client, store, childSessionId, {
        status: vanished ? "error" : "idle",
        ...(vanished
          ? { cause: "The plugin restarted while this child was running, and the host no longer lists a turn for it: the child vanished across the restart, so its work was never seen through — it did not fail." }
          : {}),
      });
    } catch (error: unknown) {
      await containFailure(client, `Could not reconcile restored task ${childSessionId}`, error, "left active");
    }
  }
}
