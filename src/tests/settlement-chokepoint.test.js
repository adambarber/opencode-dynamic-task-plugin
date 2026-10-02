// A wait is a promise the plugin makes to a parent: "send this dispatch again
// when I tell you it can go." The plugin can only keep that promise if EVERY
// way a child leaves `active` also announces itself.
//
// `settleRunningChild` is the settlement funnel, and it is where the announcement
// USED to live — announced as the one place a task settles, which four other sites
// quietly contradicted. The release is now attached to the store's own
// retained-change sink (entry/state.ts), where every settlement passes by
// construction; the funnel kept its own announcement and lost that one line.
//
// The four bypasses: an interrupt claim, a steer whose session the server has
// forgotten, a prompt the server will not accept, a dispatch that failed after its
// session was created. Each was written to reach the right STATE, and reaching the
// right state is not the same as keeping the promise that hangs off it: the parent
// sat on a wait whose edge had been gone for minutes, and the wait survived until
// MAX_WAITS evicted it by accident of unrelated traffic.
//
// So this suite is a sweep. The control case is the funnel's own path, and the
// rest name the ways a child can end without passing through it. Each one states
// only how its edge dies; the assertion is identical, because the obligation is.
import { describe, it } from "./support/runner.js";
import assert from "node:assert";

import { setupHarness } from "./support/harness.js";
import {
  announcedAbout,
  failEdge,
  refusedOnOneEdge,
} from "./support/dispatch-wait-scenario.js";

const WAITING_FOR = "consume the edge";

/**
 * A parent waiting on one edge, with the edge's ending left to the case.
 *
 * The fault sets are handed in EMPTY and filled after the spawn, because the
 * harness names sessions (`ses_mock_1`, `ses_mock_2`, …) and a fixture that had
 * to predict those would be asserting against the counter rather than the
 * behaviour. A set the mock reads at call time makes the arrangement independent
 * of what the counter happened to be.
 */
async function parentWaitingOnAnEdge(hooks = {}) {
  const faults = {
    abortFailIds: new Set(),
    promptFailIds: new Set(),
    ...hooks,
  };
  const h = await setupHarness({ hooks: faults });
  const edge = await refusedOnOneEdge(h, WAITING_FOR);
  return { h, edge, faults };
}

// ── the control: the funnel's own path already kept the promise ───────────

describe("a held wait survives every way a child can end", () => {
  it("a child that completes releases the parent", async () => {
    const { h, edge } = await parentWaitingOnAnEdge();

    const hint = await announcedAbout(h, WAITING_FOR, () => h.settle(edge.id));

    assert.match(hint.message, /can go now/i);
  });

  // ── the four that bypass the funnel ──────────────────────────────────────

  it("a child the operator interrupts releases the parent", async () => {
    // The interrupt claims the turn and suppresses the terminal echo, so this
    // settlement never reaches `settleRunningChild` — it is reached by the
    // abort's own claim instead. The edge is DEAD (an interrupted child is never
    // revived), so the promise it answers is "will never run", not "can go now":
    // handing the parent a dispatch the gate will refuse is the plugin
    // contradicting itself inside one message.
    const { h, edge } = await parentWaitingOnAnEdge();

    const hint = await announcedAbout(h, WAITING_FOR, () =>
      h.tool.task_interrupt.execute({ session_id: edge.id }, { sessionID: "p1" }),
    );

    assert.match(hint.message, /never run/i, "an interrupted edge is dead, not ready");
  });

  it("a child whose session the server has forgotten releases the parent", async () => {
    // A steer cannot abort a session the server no longer has, so it settles the
    // child itself and says so. A direct transition, from a tool, mid-conversation.
    const { h, edge, faults } = await parentWaitingOnAnEdge();
    faults.abortFailIds.add(edge.id);

    const hint = await announcedAbout(h, WAITING_FOR, () =>
      h.tool.task_continue.execute(
        { session_id: edge.id, prompt: "keep going" },
        { sessionID: "p1" },
      ),
    );

    assert.match(hint.message, /never run/i, "a lost edge is dead, not ready");
  });

  it("a child whose prompt the server rejects releases the parent", async () => {
    // The steer fires a replacement prompt and the server refuses it outright.
    // No terminal event will ever arrive for that turn — which is the whole
    // reason the delivery-failure path settles — and the announcement rides on
    // that settlement like any other.
    const { h, edge, faults } = await parentWaitingOnAnEdge();
    faults.promptFailIds.add(edge.id);

    const hint = await announcedAbout(h, WAITING_FOR, () =>
      h.tool.task_continue.execute(
        { session_id: edge.id, prompt: "keep going" },
        { sessionID: "p1" },
      ),
    );

    assert.match(hint.message, /never run/i, "a dead edge is dead, not ready");
  });

  it("a child that fails releases the parent, as dead rather than ready", async () => {
    // The control's error sibling, and the sibling the bypasses above get wrong:
    // an edge that ended in failure will not run again, so announcing it as
    // "can go now" hands the parent a dispatch whose gate will refuse — the
    // plugin contradicting itself in one message.
    const { h, edge } = await parentWaitingOnAnEdge();

    const hint = await announcedAbout(h, WAITING_FOR, () => failEdge(h, edge.id));

    assert.match(hint.message, /never run/i, "dead, not ready");
  });
});