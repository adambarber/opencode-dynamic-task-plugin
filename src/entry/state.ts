// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.
import type { PluginOptions } from "@opencode-ai/plugin";
import type { DynamicTaskConfig } from "../shared/config.js";
import { normalizeDynamicTaskConfig, parseDynamicTaskJsonc } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks, restoreActive, restoreRetained } from "../shared/task-state.js";
import { loadTaskLedger, saveTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { hostTurnRunning, readLiveness } from "../shared/liveness.js";
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
import { configureDebugRoot } from "../debug-logger.js";

// Plugin-level state store (ephemeral — lost on restart)
export interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
}

export function initPluginState(directory: string, options: PluginOptions | undefined, client: OpenCodeClient): PluginState {
  // Load dedicated config file if it exists
  const configPath = directory
    ? `${directory}/.opencode/dynamic-task-plugin.jsonc`
    : null;
  const fileConfig = configPath ? parseDynamicTaskJsonc(configPath) : null;

  const config = normalizeDynamicTaskConfig(options, fileConfig);
  const store = createTaskStore();

  // State is scoped to the project directory the host provides (the same
  // root as the config file above) — never the process CWD, which for
  // tests and multi-project hosts is somebody else's tree.
  configureDebugRoot(directory);
  const ledgerPath = resolveTaskLedgerPath(directory);

  const ledger = loadTaskLedger(ledgerPath);
  // One writer for the whole file. Retained records and owed notices live in one
  // document, so they are written together: a persist that could update one and
  // lose the other is the same deafness this file exists to prevent.
  const persistLedger = () => {
    try {
      saveTaskLedger(
        { retained: store.retainedTasks, active: store.activeTasks, pending: getPendingDeliveries() },
        ledgerPath,
      );
    } catch {
      // best-effort persistence; the next mutation retries
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
      if (hostTurnRunning(reading)) {
        await safeLog(client, "info", `Restored task ${childSessionId} is still working; left active`);
        continue;
      }
      const vanished = reading.hostState === null;
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
