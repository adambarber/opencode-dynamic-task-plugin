// Plugin state boot (entry): config normalization, per-instance store, and
// durable-state wiring. Lives apart from the entry so the entry stays wiring.

import type { PluginOptions } from "@opencode/plugin";
import { configureDebugRoot, debugLog } from "../debug-logger.js";
import { applyAgentOverlay, installLiveAgentCaps, retiredLaneOverlayPath, retiredOverlayPresent } from "../shared/caps.js";
import type { OpaqueHost } from "../shared/client.js";
import type { DynamicTaskConfig } from "../shared/config.js";
import { readDynamicTaskPolicy } from "../shared/config.js";
import { createIntentWriter, type IntentStore } from "../shared/create-intent.js";
import { createStore } from "../shared/durable-store.js";
import { LifecycleStatus } from "../shared/host-events.js";
import type { LedgerChange } from "../shared/ledger-change.js";
import { LedgerChangeKind } from "../shared/ledger-change.js";
import { createLedgerStore } from "../shared/ledger-storage.js";
import { hostTurnRunning, readLiveness, readSessionPresence, SessionExistence } from "../shared/liveness.js";
import {
  configurePendingPersistence,
  containFailure,
  getPendingDeliveries,
  LogLevel,
  redeliverOwedNotifications,
  restorePendingDeliveries,
  safeLog,
} from "../shared/notify.js";
import type { OverlayHandlers } from "../shared/overlay-rpc.js";
import { readOverlayWrite, readWirePayload } from "../shared/overlay-rpc.js";
import type { OverlayRead, OverlayStore } from "../shared/overlay-store.js";
import { createOverlayStore } from "../shared/overlay-store.js";
import { createStateFacade } from "../shared/state-facade.js";
import { restoreActive, restoreRetained } from "../shared/task-ledger.js";
import type { TaskStore } from "../shared/task-state.js";
import { createTaskStore, pruneRetainedTasks } from "../shared/task-state.js";
import { releaseWaitingDispatches, settleRunningChild } from "./lifecycle.js";

// Plugin-level state store (ephemeral — lost on restart)
export interface PluginState {
  store: TaskStore;
  /** Durable writes for issued-but-unanswered creates; the same chain as the ledger. */
  intent: IntentStore;
  config: DynamicTaskConfig;
  /** The operator's caps, as the TUI reaches them. See `overlayHandlers`. */
  overlay: OverlayStore;
}

/**
 * The caps an operator stated, installed for this process — and the two things that
 * could have gone wrong with them, said out loud.
 *
 * Reported here and not per decision: a cap decision happens deep in the store, on
 * every spawn, so a warning there would be noise nobody could read. This is the one
 * moment a store exists, which makes it the only moment the problem can be said once
 * and be seen.
 */
function installOverlayPolicy(config: DynamicTaskConfig, directory: string, read: OverlayRead): void {
  if (read.problem !== null) {
    void safeLog(LogLevel.Warn, `Dynamic task plugin: ${read.problem}. The config file's caps are in force.`);
    debugLog("plugin", "agents", "agent-overlay-ignored", { reason: read.problem });
  }
  // The overlay this one replaced, named rather than ignored. Deleting a thing the
  // plugin used to read is the kind of change that looks like a bug from the outside:
  // an operator who had a cap working last week finds it silently not applying, and
  // the only way to tell that from a mis-set number is to be told. Silently reading it
  // is the alternative, and it is wrong in a way that cannot be undone — a lane file's
  // entries are agent names, so they would re-apply caps under keys nobody wrote.
  if (retiredOverlayPresent(directory)) {
    void safeLog(LogLevel.Warn, `Dynamic task plugin: ${retiredLaneOverlayPath(directory)} is left over from the lane feature and is NOT read. ` +
      "Caps are now keyed by agent name, and that file's keys were operator-invented. Delete it and re-set the caps you still want.");
    debugLog("plugin", "agents", "retired-lane-overlay", { path: retiredLaneOverlayPath(directory) });
  }
  installLiveAgentCaps(applyAgentOverlay(config, read.caps));
}

/**
 * The overlay's RPC, as handlers.
 *
 * The write is the one place a new policy is installed, and it installs it HERE
 * rather than leaving the next boot to find it — the caller's process is the only one
 * that can be sure the value it just stored is the value it will judge against.
 *
 * There is no event yet. `OverlayRpc.events` is declared and empty, and this comment used
 * to describe a second window stopping here when caps changed. That is not wired, so a
 * second window reads the overlay when it opens and not again — the slot is there, and the
 * claim is not.
 */
export function overlayHandlers(
  store: OverlayStore,
  config: DynamicTaskConfig,
  directory: string,
): OverlayHandlers {
  return {
    read: async () => readWirePayload(await store.read()),
    write: async (input, context) => {
      // Validated HERE, where the host's `unknown` arrives, and never stored on the
      // strength of the caller's own copy: a document half-understood would be caps the
      // operator never wrote, and the next read would show them something else.
      const overlay = readOverlayWrite(input);
      if (overlay === null) {
        return context.error("not_writable", "that is not a set of caps, so nothing was changed", { reason: "not an overlay" });
      }
      if (!(await store.write(overlay))) {
        return context.error("not_writable", "the caps could not be stored, so nothing was changed", { reason: "not stored" });
      }
      // Re-read rather than applying what was sent: what was STORED is what the
      // dispatch path will read, and the caps reader is what says what it means.
      installOverlayPolicy(config, directory, await store.read());
      return { confirmed: true };
    },
  };
}

/**
 * A durable write the store refused. Loud on the host channel, structured beside it,
 * and the copy says what is lost rather than only what happened — a refusal that
 * merely reports itself reads like noise the next boot learns to skip.
 */
function reportRefusal(what: string): void {
  void safeLog(LogLevel.Warn, `Dynamic task plugin: ${what}. The value is NOT saved, so this project's durable task state does not yet say so.`);
  debugLog("ledger", "ledger", "ledger-write-refused", { reason: what });
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

export async function initPluginState(directory: string, options: PluginOptions | undefined, host: OpaqueHost): Promise<PluginState> {
  // The config file's own caps, over the defaults, over env — read ONCE and applied
  // through the ONE overlay reader, so the screen an operator reads and the policy a
  // dispatch is judged against cannot come from two different places.
  const config = readDynamicTaskPolicy(directory, options ?? null);
  const store = createTaskStore();

  // State is scoped to the project directory the host provides (the same
  // root as the config file above) — never the process CWD, which for
  // tests and multi-project hosts is somebody else's tree.
  configureDebugRoot(directory);

  // Durable state is the host's own per-key storage, so the boot is a READ rather
  // than a file open — and `initPluginState` is async because of it. Nothing below
  // this line may still be waiting on a filesystem.
  const facade = createStateFacade(createStore(host, reportRefusal));
  const ledger = createLedgerStore(facade);
  const read = await ledger.load();

  // The issued-but-unanswered create records ride the SAME store and therefore the
  // SAME write chain as everything else: a second chain would let a create intent and
  // the ledger write it precedes be applied in either order, and the whole point is
  // that the intent is durable BEFORE the create is issued.
  const intent = createIntentWriter(facade);

  // The operator's caps come out of the same store, and are installed as a VALUE: a
  // cap decision is made on the dispatch path, where a bounded host read has no way
  // to say "the host did not answer" without either refusing the dispatch or judging
  // it against the wrong numbers. So the read happens here, once, and a later edit
  // arrives because the RPC write path installs the new policy in this process.
  const overlay = createOverlayStore(facade, directory);
  installOverlayPolicy(config, directory, await overlay.read());

  // Records the host held that were not records, and a read the host never answered.
  // Both are reported, and neither is allowed to sound like the ordinary case: a
  // dropped record is a task the operator may still believe is tracked, and a
  // partial read is a ledger this boot does NOT know is whole.
  if (read.dropped > 0 || read.incomplete) {
    void safeLog(LogLevel.Warn, `Dynamic task plugin: durable task state was not read whole — ${read.dropped} record(s) the host held were not records, and the read was ${read.incomplete ? "partial" : "complete"}. A task that is not in this list was not recovered.`);
    debugLog("ledger", "ledger", "ledger-read-incomplete", { dropped: read.dropped, incomplete: read.incomplete });
  }

  // One writer, now one PER KEY: no read before the write and no whole-file rewrite,
  // so two processes on one project cannot erase each other's running children.
  store.onRetainedChange = (changes) => {
    ledger.persist(changes);
    releaseWaitsForSettled(host, store, changes);
  };
  store.onActiveChange = ledger.persist;
  configurePendingPersistence(ledger.persist);

  // Crash recovery: rehydrate retained tasks and the running set, and take
  // ownership of the notices the last boot owed.
  restoreRetained(store, read.retained, config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);
  restorePendingDeliveries(read.pending);

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
    void safeLog(LogLevel.Info, `Dynamic task plugin: carrying ${owedDebts.length} notification(s) owed from a previous run — ${each}. A parent that is mid-turn defers its notice and spends an attempt for it, so a count that climbs across restarts means the parent is still busy and one that reaches the end retires the notice as undelivered.`);
  }

  // The running set is restored BEFORE the pending notices are paid, and
  // reconciliation is detached (below), so an owed notice and a vanished
  // child's notice can neither mask nor reorder each other.
  const restored = restoreActive(store, read.active);
  if (restored > 0) void reconcileRestored(host, store);

  // Pay the debt, oldest first, one pass and no waiting — through the one
  // re-offer of the queue, which is also where the budget comes from, so no
  // caller can dial a debt without it. The fan-out is capped at the same
  // concurrency the operator already allows live work: a redelivery is a real
  // turn, so a queue is paid in batches rather than all at once.
  redeliverOwedNotifications(host, config.pendingMaxAttempts, config.maxConcurrent);

  return { config, intent, overlay, store };
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
  void safeLog(LogLevel.Info, `Reconciling ${restored.length} task(s) restored across restart`);
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
        void safeLog(LogLevel.Info, `Restored task ${childSessionId}: status channel unanswered; left active`);
        continue;
      }
      if (hostTurnRunning(reading)) {
        void safeLog(LogLevel.Info, `Restored task ${childSessionId} is still running (host says "${reading.hostTurn}"); left active`);
        continue;
      }
      // No running turn, so the session's fate is the transcript's to say — which is
      // `settleRunningChild`'s own work. The one exception is a host that says it has
      // no such session, and that question has its own endpoint: the status map
      // cannot answer it, because "nothing running" and "never existed" look the
      // same in there.
      const presence = await readSessionPresence(host, childSessionId);
      if (presence.existence !== SessionExistence.Missing) {
        await settleRunningChild(host, store, childSessionId, { status: LifecycleStatus.Idle });
        continue;
      }
      // No cap source, and deliberately so: a boot-reconciled child is not a
      // candidate for the silent transient resume, and reviving a record would send
      // a prompt to a session the host has just denied having.
      await settleRunningChild(host, store, childSessionId, {
        cause: "The plugin restarted while this child was running, and the host then answered that it has no such session (404): the child vanished across the restart, so its work was never seen through — it did not fail.",
        status: LifecycleStatus.Error,
      });
    } catch (error: unknown) {
      void containFailure(`Could not reconcile restored task ${childSessionId}`, error, "left active");
    }
  }
}
