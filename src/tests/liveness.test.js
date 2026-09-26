/**
 * liveness.ts — the host's status word, and the three things anyone asks of it.
 *
 * Two sources and no inference: the status channel's own word, and the clock on
 * the child's last message. THREE questions, because the host's word answers
 * different ones: is a turn running, is it over, and is it one this plugin
 * reads at all. The word the host did not state must not be coerced into an
 * outcome — a session it no longer lists is unknown, and so is a word it may
 * add tomorrow, and only the first of those is a claim about a child.
 */

import { describe, it, assert } from "./support/runner.js";
import {
  hostTurnOver,
  hostTurnRunning,
  statusFromHostState,
  UntrackedStatus,
} from "../../dist/shared/liveness.js";

// The server's own status vocabulary, as the read tools speak it. The words are
// the host's, never ours: a status the server did not state cannot be rendered
// as one, so this table is the whole of what an untracked session can say. The
// channel's value is a SessionStatus — busy | retry | idle — and the rows below
// them are the two things that are NOT a claim about a turn: a word outside that
// set, and no entry at all. Both answer neither question, and keeping them in
// one table is what stops a reader from treating one as the other.
describe("liveness vocabulary", () => {
  const cases = [
    // host word, what it renders as, a turn is running, a turn is over
    ["busy", UntrackedStatus.Busy, true, false],
    ["retry", UntrackedStatus.Busy, true, false],
    ["idle", UntrackedStatus.Completed, false, true],
    ["compacting", UntrackedStatus.Unknown, false, false],
    ["error", UntrackedStatus.Unknown, false, false],
    [null, UntrackedStatus.Unknown, false, false],
  ];
  for (const [host, rendered, running, over] of cases) {
    it(`reads the server's "${host}" as ${rendered}, running=${running}, over=${over}`, () => {
      const reading = { hostState: host, lastMessageAt: null, messageCount: 0 };
      assert.strictEqual(statusFromHostState(host), rendered);
      assert.strictEqual(hostTurnRunning(reading), running);
      assert.strictEqual(hostTurnOver(reading), over);
    });
  }

  // The word reaches the reader intact. If it were coerced to null on the way in
  // it would still render "unknown" and still read as not-running — both of
  // which the table above accepts — and the one caller that must not settle on
  // it would have no way left to tell the two apart.
  it("carries a word it does not read through to the reading, rather than dropping it", async () => {
    const { readLiveness } = await import("../../dist/shared/liveness.js");
    const reading = await readLiveness(
      { session: { status: async () => ({ data: { ses_x: { type: "compacting" } } }) } },
      "ses_x",
      [],
    );
    assert.strictEqual(reading.hostState, "compacting", "the host's own word survives the read");
  });
});
