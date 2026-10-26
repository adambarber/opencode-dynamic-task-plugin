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
import { debugLog } from "./debug-logger.js";
import { handleChildLifecycleEvent } from "./entry/lifecycle.js";
import { handleAskEvent } from "./entry/questions.js";
import { initPluginState, overlayHandlers } from "./entry/state.js";
import { asOpaqueHost, hasCoreApis, type OpaqueHost, probeHost } from "./shared/client.js";
import { getSessionIdFromEvent, isTerminalSessionEvent } from "./shared/host-events.js";
import { errorMessage, eventString } from "./shared/host-shape.js";
import { containFailure, LogLevel, safeLog } from "./shared/notify.js";
import { OverlayRpc } from "./shared/overlay-rpc.js";
import { noteActivity, type TaskStore } from "./shared/task-state.js";
import { buildToolMap } from "./tools/index.js";

async function setup(context: Context): Promise<void> {
  const {directory} = context.location;
  // v2 carries plugin options ON the context (`context.options`), not as a second
  // argument — the host calls `setup(context)` with one argument. A two-parameter
  // signature here would typecheck while silently receiving `undefined`.
  const {options} = context;
  // The one mint. Past this line nothing downstream can name a host namespace.
  const host = asOpaqueHost(context);

  if (!probeHost(host, hasCoreApis)) {
    safeLog(LogLevel.Warn, "Missing required host APIs, plugin disabled");
    return;
  }

  // Initialize state at plugin load time — the store and config are captured
  // per instance: a second init (multi-workspace) must never reroute this
  // instance's events into another project's store. Debug root and
  // notification ledgers stay process-global by design (Tenet 9 — see the
  // exemption note in docs/tasks/06-persistence-and-observability.md).
  const { config, intent, overlay, store } = await initPluginState(directory, options, host);
  const deps = { config, directory, host, intent, store };
  const tools = buildToolMap(deps);

  // The caps channel, on the host's own route between two plugins. It exists because
  // the TUI is a plugin too: the operator's caps live in a store the TUI has no access
  // to, so a dialog writes them through this method.
  //
  // The location travels with the call, so neither method takes a directory: that
  // guarantee is the host's, and it is why a dialog cannot reach another project's caps.
  await context.rpc.register(OverlayRpc, overlayHandlers(overlay, config, directory));

  safeLog(LogLevel.Info, "Plugin loaded with dynamic_task, task_continue, task_notify, task_result, task_status, task_list, task_interrupt tools");

  // The event head, on v2's own registration surface. `transform` registers the
  // editor pass; `subscribe` is the stream itself.
  // AWAITED, not fire-and-forget: `transform` returns `Promise<Registration>` and the
  // registration applies asynchronously, so an un-awaited transform lets the `reload`
  // below publish the tool list BEFORE our `editor.add` calls land — observed live as
  // zero `tool.updated` events and sessions with none of the seven tools.
  await context.tool.transform((editor) => {
    for (const [name, info] of Object.entries(tools)) editor.add({ ...info, name });
  });
  await context.tool.reload();

  const onEvent = makeEventHandler({ config, host, store });

  void runEventPump(context, onEvent);
}

/**
 * The event head, built once at boot: every event flows through here, so the
 * heartbeat, the ask gate and the lifecycle settlement all read the SAME fact.
 * The head takes the boot's pieces as one object — the file's idiom (deps rides
 * to the tools the same way) — because its arguments are state, not parameters.
 */
function makeEventHandler(deps: {
  config: Awaited<ReturnType<typeof initPluginState>>["config"];
  host: OpaqueHost;
  store: TaskStore;
}): (event: unknown) => Promise<void> {
  const { config, host, store } = deps;
  return async (event: unknown): Promise<void> => {
    // The observation half, named: the log line and the heartbeat ride together
    // because both are "this event was seen" facts. It hands back the two facts
    // the gates below read.
    const { eventType, terminal } = observeEvent(store, event);

    // --- Ask gate: attribute through the gate, then deny.
    try {
      if (await handleAskEvent(host, store, eventType, event)) return;
    } catch (error: unknown) {
      debugLog("unknown", "unknown", "ask-handler-error", { error: errorMessage(error) });
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
}

/**
 * The head's observation half. NO plugin log on this path, and the absence is
 * the design: the host emits one event per message AND per part — a session
 * with 5,399 parts pays this line 5,399 times inside a single turn — so
 * `debugLog` below is where per-event observability belongs (it returns before
 * allocating anything unless DYNAMIC_TASK_DEBUG=1). This is also the ONLY place
 * that sees every host event, so it is where "the child's turn is moving" is
 * observed; terminality is decided once, here, and handed to the gates.
 */
function observeEvent(store: TaskStore, event: unknown): { eventType: string; terminal: boolean } {
  const eventType = eventString(event, "type") ?? "(none)";
  const evtSessionId = getSessionIdFromEvent(event);
  debugLog("event-handler", "event-handler", "event-received", {
    name: eventString(event, "name") ?? "(none)",
    sessionId: evtSessionId,
    type: eventType,
  });
  const terminal = isTerminalSessionEvent(event);
  noteActivity(store, evtSessionId, terminal);
  return { eventType, terminal };
}

/**
 * The event pump: the one loop every settlement, notification and gate rides.
 * Per-event errors are contained INSIDE onEvent; this owns the stream itself.
 * A rejection from the iterator is contained (containFailure + the operator's
 * log) rather than left as an unhandled rejection — Node >= 15 answers one by
 * killing the whole host process. And when the iterator ENDS without failing,
 * the plugin keeps running but can never see another event — no settlements, no
 * notifications — so deafness is named rather than silent. The host exposes no
 * re-subscription, so the honest deliverable is the log, not a retry.
 */
async function runEventPump(context: Context, onEvent: (event: unknown) => Promise<void>): Promise<void> {
  try {
    for await (const event of context.event.subscribe()) {
      void onEvent(event);
    }
    void safeLog(LogLevel.Warn, "Dynamic task plugin: the plugin's event subscription ended; the plugin is deaf until the host restarts. No task will settle or notify until then.");
  } catch (error: unknown) {
    containFailure("event stream failed", error, "the plugin is deaf until the host restarts");
  }
}

export default {
  id: "dynamic-task",
  // The function itself, not a re-annotating forwarder: the loader calls
  // `setup(context)` with ONE argument (promise/adapter.js) and `satisfies Plugin`
  // already types the parameter. A wrapper could only restate it, and a two-parameter
  // one would typecheck while receiving `undefined` forever.
  setup,
} satisfies Plugin;