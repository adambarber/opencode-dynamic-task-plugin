// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.
import type { PluginOptions } from "@opencode-ai/plugin";
import type { DynamicTaskConfig } from "../shared/config.js";
import { normalizeDynamicTaskConfig, parseDynamicTaskJsonc } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks, restoreRetained } from "../shared/task-state.js";
import { loadTaskLedger, saveTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import {
  configurePendingPersistence,
  getPendingDeliveries,
  notifyParent,
  restorePendingDeliveries,
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
      saveTaskLedger({ retained: store.retainedTasks, pending: getPendingDeliveries() }, ledgerPath);
    } catch {
      // best-effort persistence; the next mutation retries
    }
  };
  // Ledger sync: every retained mutation persists. Errors are swallowed
  // here so a durable-state failure can never break control flow.
  store.onRetainedChange = persistLedger;
  configurePendingPersistence(persistLedger);

  // Crash recovery: rehydrate retained tasks, and take ownership of the notices
  // the last boot owed.
  restoreRetained(store, ledger.retained, config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);
  restorePendingDeliveries(ledger.pending);

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
