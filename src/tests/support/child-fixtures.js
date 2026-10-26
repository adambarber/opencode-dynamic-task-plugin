
import { readFileSync } from "node:fs";
import { getDebugLogPath } from "../../../dist/debug-logger.js";
import { isParentNotification } from "../../../dist/shared/notification-text.js";
import { ASSISTANT_ROLE } from "../../../dist/shared/prompt.js";
import { PARENT, setupHarness, tmpProjectDir, withEnv } from "./harness.js";
import { events, promptText } from "./mock-events.js";
import { unclockedSaid } from "./mock-transcript.js";


/**
 * Boot the plugin, spawn one child, and return the pair a tool test needs.
 * This is the suite's standard arrangement, so it is declared once here rather
 * than forty times as boot-then-spawn.
 */

export async function withChild({ harness = {}, spawn = {}, ctx = { sessionID: PARENT } } = {}) {
  const h = await setupHarness(harness);
  const { id, out, c } = await h.spawn(spawn, ctx);
  return { c, h, id, out };
}

/** `withChild` plus one step, for the arrangements that are this one and then something. */
async function withChildThen(step, opts) {
  const child = await withChild(opts);
  await step(child.h, child.id);
  return child;
}

/**
 * Boot, spawn one child, and settle it — the precondition for reading a
 * child's settled state. Naming it keeps a test from spelling out the same
 * three steps to ask the same question.
 */
export async function withSettledChild(opts = {}) {
  return withChildThen((h, id) => h.settle(id), opts);
}

/**
 * Boot, spawn one child, and have the host ASK it a permission — the arrangement
 * every permission-gate case starts from.
 *
 * Named because the preamble is load-bearing: the ask must reach the gate under
 * the session id the child was dispatched with, and a case that hand-rolled it
 * could use a different one without noticing. A gate that never sees the ask
 * never answers it, so the ask is part of the setup, not the test.
 */
export async function withAskedChild(requestId) {
  return withChildThen((h, id) => h.fireEvent(events.ask(id, requestId)));
}

/**
 * Boot, spawn, settle, and run `body` with debug logging on, handing it the
 * child's debug log — the arrangement every "this must reach the log" assertion
 * needs.
 *
 * A callback, not a handle, and that is the whole point: `debugLog` gates on
 * DYNAMIC_TASK_DEBUG at CALL time, so a fixture that enabled it only for boot
 * would hand back a log that is frozen at the registration line. Every event
 * after the setup — which is every event a log assertion is actually about —
 * would be silently dropped, and an assertion against that log passes against
 * silence. A fixture that cannot outlive its own setup is a fixture that
 * manufactures the failure it is meant to detect.
 *
 * Named because the alternative is four steps (a temp project dir, debug
 * enabled, a settled child, then the log) re-derived per test — and the log path
 * is easy to get subtly wrong. A path that matches nothing reads as an EMPTY
 * log, which is indistinguishable from a gate that logged nothing at all. The
 * derivation belongs next to the debug writer that creates the path, not in
 * each of its readers.
 */
export async function withLoggedChild({ hooks = {} }, body) {
  const directory = tmpProjectDir();
  return withEnv("DYNAMIC_TASK_DEBUG", "1", async () => {
    const { h, c, id, out } = await withSettledChild({ harness: { directory, hooks } });
    return body({
      c,
      directory,
      h,
      id,
      /** The child's debug log, as the operator would read it. */
      log: () => readFileSync(getDebugLogPath(PARENT, id), "utf8"),
      out,
    });
  });
}

/**
 * Boot the plugin and spawn a two-level dispatch tree: a child, and a
 * grandchild that child spawned.
 *
 * Two levels is the deepest tree reachable — lineage accumulates every
 * ancestor's agent NAME and no agent may appear twice, so a chain is bounded by
 * the number of agent types, and the types alternate here for the same reason.
 * Declared once because the fleet views and the subtree stop ask about the same
 * tree, and two copies of "the tree" would be two different trees.
 */
export async function withDispatchTree(harness = {}) {
  const h = await setupHarness(harness);
  const child = await h.spawn({ description: "child task" });
  const grandchild = await h.spawn(
    { description: "grandchild task", subagent_type: "general" },
    { sessionID: child.id },
  );
  return { child, grandchild, h };
}

/**
 * As withDispatchTree, with the grandchild already finished — the shape both
 * the stop and the view have to answer for (a finished node in a running tree).
 */
export async function withSettledDispatchTree(harness = {}) {
  const tree = await withDispatchTree(harness);
  await tree.h.settle(tree.grandchild.id);
  return tree;
}

/**
 * task_result for a spawned child whose message read returns exactly
 * `messages`. Liveness is a question about what a child has written, so a test
 * that asks it is one line of arrangement and one expectation.
 */
export async function resultForChild(messages, opts = {}) {
  return readForChild((client, id) => client.setTranscript(id, messages), opts);
}

/**
 * As resultForChild, for the child whose message read itself fails.
 *
 * The failure is armed as a fault rather than faked with a hook, so the teardown
 * rule sees it fire: a fixture that cannot fail cannot prove the failure path.
 */
export async function resultForUnreadableChild(error = new Error("boom"), opts = {}) {
  return readForChild((client, id) => client.makeUnreadable(id, error), opts);
}

async function readForChild(arrange, opts) {
  const { c, h, id } = await withChild(opts);
  arrange(h.client, id);
  return c.result();
}

/**
 * The two-turn harness the claim-order/revival tests share: the message stream
 * names each turn's output, and the FIRST parent notification fails so the
 * gate's retry lands inside the test's timing window.
 */
export async function setupTwoTurnHarness() {
  let msgCalls = 0;
  const harness = await setupHarness({
    hooks: {
      messages: () => {
        msgCalls++;
        const text = msgCalls === 1 ? "TURN-ONE-OUTPUT" : "TURN-TWO-OUTPUT";
        return [unclockedSaid(text, ASSISTANT_ROLE)];
      },
    },
  });
  const origPrompt = harness.client.session.prompt;
  let parentNotifies = 0;
  harness.client.session.prompt = (args) => {
    if (isParentNotification(promptText(args))) {
      parentNotifies++;
      if (parentNotifies === 1) return Promise.reject(new Error("parent busy"));
    }
    return origPrompt(args);
  };
  return harness;
}
