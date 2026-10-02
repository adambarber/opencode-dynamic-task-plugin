// Dynamic Task Plugin — non-blocking subagent orchestration with parent notifications
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
// the default export is public.
//
// v2 changed the SHAPE of a plugin, not just its calls: the host decodes the
// default export as `{ id, effect | setup }` and calls `setup(context)`. A bare
// factory function — the v1 shape — is rejected by the loader before any of it
// runs, so this is where "does the plugin load at all" is decided.

import type { Context, Plugin } from "@opencode/plugin/promise/plugin";
import type { PluginOptions } from "@opencode/plugin";
import { asOpaqueHost, hasCoreApis, probeHost } from "./shared/client.js";
import { getSessionIdFromEvent, isTerminalSessionEvent } from "./shared/session-lifecycle.js";
import { errorMessage, eventString } from "./shared/host-shape.js";
import { debugLog } from "./debug-logger.js";
import { safeLog, containFailure, configurePluginLogRoot } from "./shared/notify.js";
import { initPluginState } from "./entry/state.js";
import { handleAskEvent } from "./entry/questions.js";
import { handleChildLifecycleEvent } from "./entry/lifecycle.js";
import { noteActivity } from "./shared/task-state.js";
import { buildToolMap } from "./tools/index.js";

async function setup(context: Context, options?: PluginOptions): Promise<void> {
  const directory = context.location.directory;
  // The one mint. Past this line nothing downstream can name a host namespace.
  const host = asOpaqueHost(context);
  configurePluginLogRoot(directory);

  if (!probeHost(host, hasCoreApis)) {
    safeLog("warn", "Missing required host APIs, plugin disabled");
    return;
  }

  // Initialize state at plugin load time — the store and config are captured
  // per instance: a second init (multi-workspace) must never reroute this
  // instance's events into another project's store. Debug root and
  // notification ledgers stay process-global by design (Tenet 9 — see the
  // exemption note in docs/tasks/06-persistence-and-observability.md).
  const { config, store } = initPluginState(directory, options, host);
  const deps = { host, store, config, directory };
  const tools = buildToolMap(deps);

  safeLog("info", "Plugin loaded with dynamic_task, task_continue, task_notify, task_result, task_status, task_list, task_interrupt tools");

  // The event head, on v2's own registration surface. `transform` registers the
  // editor pass; `subscribe` is the stream itself.
  context.tool.transform((editor) => {
    for (const [name, info] of Object.entries(tools)) editor.add({ ...info, name });
  });
  await context.tool.reload();

  const onEvent = async (event: unknown): Promise<void> => {
    const eventType = eventString(event, "type") ?? "(none)";
    const eventName = eventString(event, "name") ?? "(none)";
    const evtSessionId = getSessionIdFromEvent(event);

    // NO plugin log on this path, and the absence is the design. This head is
    // the only code in the plugin that sees every event, and the host emits one
    // per message AND per part — so a session with 5,399 parts pays this line
    // 5,399 times inside a single turn. `debugLog` below is where per-event
    // observability belongs: it returns before allocating anything unless
    // DYNAMIC_TASK_DEBUG=1, so it costs nothing when nobody is watching.
    debugLog("event-handler", "event-handler", "event-received", {
      type: eventType,
      name: eventName,
      sessionId: evtSessionId,
    });

    // --- Activity heartbeat: this head is the ONLY place that sees every
    // host event, so it is where "the child's turn is moving" is observed.
    // Terminality is decided once, here, and handed to both consumers.
    const terminal = isTerminalSessionEvent(event);
    noteActivity(store, evtSessionId, terminal);

    // --- Ask gate: attribute through the gate, then deny.
    try {
      if (await handleAskEvent(host, store, eventType, event)) return;
    } catch (qerr: unknown) {
      debugLog("unknown", "unknown", "ask-handler-error", { error: errorMessage(qerr) });
    }

    // --- Session lifecycle event handler ---
    if (!terminal) return;
    try {
      await handleChildLifecycleEvent(host, store, event, config);
    } catch (error: unknown) {
      containFailure("event handler error", error);
      debugLog("event-handler", "event-handler", "event-handler-error", { error: errorMessage(error) });
    }
  };

  void (async () => {
    for await (const event of context.event.subscribe()) {
      void onEvent(event);
    }
  })();
}

export default {
  id: "dynamic-task",
  setup: (context: Context) => setup(context),
} satisfies Plugin;