// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.
import type { PluginOptions } from "@opencode-ai/plugin";
import type { DynamicTaskConfig } from "../shared/config.js";
import { normalizeDynamicTaskConfig, parseDynamicTaskJsonc } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks, restoreRetained } from "../shared/task-state.js";
import { loadTaskLedger, saveTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { configureDebugRoot } from "../debug-logger.js";

// Plugin-level state store (ephemeral — lost on restart)
export interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
}

export function initPluginState(directory: string, options?: PluginOptions): PluginState {
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

  // Ledger sync: every retained mutation persists. Errors are swallowed
  // here so a durable-state failure can never break control flow.
  store.onRetainedChange = () => {
    try {
      saveTaskLedger(store.retainedTasks, ledgerPath);
    } catch {
      // best-effort persistence; the next mutation retries
    }
  };

  // Crash recovery: rehydrate retained tasks from the ledger.
  restoreRetained(store, loadTaskLedger(ledgerPath), config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);

  return { store, config };
}
