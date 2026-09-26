// Dynamic Task Plugin — non-blocking subagent orchestration with parent notifications
// Location: ~/.config/opencode/plugins/dynamic-task.ts (auto-scanned)
// Docs: https://opencode.ai/docs/plugins
//
// The contract: tools never wait. Every prompt is fired and owned at the gate;
// every settlement (completed/error) rides a lifecycle event through the
// single-winner ledger; children speak mid-flight through task_notify. The
// plugin arms no timers — settlement lives at the notification layer, and the
// only bound on a child is operator intent (task_interrupt).
//
// Layout: this file is wiring only — state boot (entry/state), the event head
// (entry/questions, entry/lifecycle), and the tool inventory (tools/). Only
// the default export is public: the host invokes every entry export as a
// candidate plugin function.

import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { OpenCodeClient } from "./shared/client.js";
import {
  getSessionIdFromEvent,
  isEventRecord,
  eventString,
  errorMessage,
  isTerminalSessionEvent,
} from "./shared/session-lifecycle.js";
import { debugLog } from "./debug-logger.js";
import { safeLog } from "./shared/notify.js";
import { initPluginState } from "./entry/state.js";
import { handleQuestionEvent } from "./entry/questions.js";
import { handleChildLifecycleEvent } from "./entry/lifecycle.js";
import { noteActivity } from "./shared/task-state.js";
import { buildToolMap } from "./tools/index.js";

export default async function dynamicTaskPlugin(
  input: PluginInput,
  options?: PluginOptions,
) {
  // Single sanctioned boundary cast (Task 08): the host provides the
  // `question` namespace beyond the generated SDK surface. Everything
  // downstream takes the augmented OpenCodeClient — no further casts.
  const directory = input.directory;
  const client = input.client as OpenCodeClient;

  if (!client?.app?.agents || !client?.session?.create || !client?.session?.prompt) {
    await safeLog(client, "warn", "Missing required client APIs, plugin disabled");
    return {};
  }

  // Initialize state at plugin load time — the store and config are captured
  // per instance: a second init (multi-workspace) must never reroute this
  // instance's events into another project's store. Debug root and
  // notification ledgers stay process-global by design (Tenet 9 — see the
  // exemption note in docs/tasks/06-persistence-and-observability.md).
  const { config, store } = initPluginState(directory, options);
  const deps = { client, store, config, directory };

  await safeLog(client, "info", "Plugin loaded with dynamic_task, task_continue, task_notify, task_result, task_status, task_list, task_interrupt tools");

  return {
    event: async ({ event }: { event: unknown }) => {
      const eventType = eventString(event, "type") ?? "(none)";
      const eventName = eventString(event, "name") ?? "(none)";
      const evtSessionId = getSessionIdFromEvent(event);
      const topKeys = isEventRecord(event) ? Object.keys(event).slice(0, 8).join(",") : "(null)";

      // The head never blocks the gate: observability is detached (void) —
      // safeLog and debugLog can neither throw nor delay question and
      // lifecycle handling, so every event reaches the settlement path even
      // when the host log hangs.
      void safeLog(client, "info", `event: type=${eventType} name=${eventName} sid=${evtSessionId ?? "(none)"} keys=[${topKeys}]`);
      debugLog("event-handler", "event-handler", "event-received", {
        type: eventType,
        name: eventName,
        sessionId: evtSessionId,
      });

      // --- Activity heartbeat: this head is the ONLY place that sees every
      // host event, so it is where "the child's turn is moving" is observed.
      // Synchronous and before any gate, because the whole point is that a
      // child doing real work (message/part updates, token deltas, tool
      // transitions) never reads as silent since spawn. Terminality is decided
      // once, here, and handed to both consumers: a turn ENDING is real motion
      // but it is not the turn working, and conflating the two is what let a
      // stale ending vouch for itself as the current turn's.
      const terminal = isTerminalSessionEvent(event);
      noteActivity(store, evtSessionId, terminal);

      // --- Question gate (Task 04): attribute through the gate, then settle.
      try {
        if (await handleQuestionEvent(client, store, eventType, event)) return;
      } catch (qerr: unknown) {
        debugLog("unknown", "unknown", "question-handler-error", { error: errorMessage(qerr) });
      }

      // --- Session lifecycle event handler ---
      if (!terminal) return;
      try {
        await handleChildLifecycleEvent(client, store, event);
      } catch (error: unknown) {
        await safeLog(client, "warn", `event handler error: ${errorMessage(error)}`);
        debugLog("event-handler", "event-handler", "event-handler-error", {
          error: errorMessage(error),
        });
      }
    },

    tool: buildToolMap(deps),
  };
}
