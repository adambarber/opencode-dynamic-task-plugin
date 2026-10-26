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
import { announcementAfterKill, assert, describe, failEdge, it } from "./support/index.js";


// ── the control: the funnel's own path already kept the promise ───────────

/**
 * The obligation, stated once. Every case below is a different way the edge can die
 * and the same promise to the parent, so the words are written once and each case
 * only says HOW its edge died — otherwise the assertion drifts with the copy.
 */
const deadEdge = (hint) => assert.match(hint.message, /never run/i, "a dead edge is dead, not ready");
/** A steer is the only kill here that needs a session id and a prompt. */
const steer = (ready, id) => ready.tool.task_continue.execute({ prompt: "keep going", session_id: id }, { sessionID: "p1" });

describe("a held wait survives every way a child can end", () => {
  it("a child that completes releases the parent", async () => {
    const { hint } = await announcementAfterKill({ kill: (ready, id) => ready.settle(id) });

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
    const { hint } = await announcementAfterKill({
      kill: (ready, id) => ready.tool.task_interrupt.execute({ session_id: id }, { sessionID: "p1" }),
    });

    deadEdge(hint);
  });

  // The same steer under two server failures: an abort the server cannot perform
  // (so the tool settles the child itself) and a prompt the server refuses (so no
  // terminal event will ever arrive for that turn). One arrangement, two deaths.
  for (const [fault, story] of [
    ["abortFailIds", "session the server has forgotten"],
    ["promptFailIds", "prompt the server rejects"],
  ]) {
    it(`a child whose ${story} releases the parent`, async () => {
      const { hint } = await announcementAfterKill({ fault, kill: steer });

      deadEdge(hint);
    });
  }

  it("a child that fails releases the parent, as dead rather than ready", async () => {
    // The control's error sibling, and the sibling the bypasses above get wrong:
    // an edge that ended in failure will not run again, so announcing it as
    // "can go now" hands the parent a dispatch whose gate will refuse — the
    // plugin contradicting itself in one message.
    const { hint } = await announcementAfterKill({ kill: (ready, id) => failEdge(ready, id) });

    deadEdge(hint);
  });
});