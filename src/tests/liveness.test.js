/**
 * liveness.ts — the host's status word, and whether it means "still working".
 *
 * Two sources and no inference: the status channel's own word, and the clock on
 * the child's last message. The mapping is a table because the alternative was a
 * chain of conditionals that grew a fourth copy of the same coercion — and a
 * session the host does not list must read as unknown, never as idle.
 */

import { describe, it, assert } from "./support/runner.js";
import { hostTurnRunning, statusFromHostState } from "../../dist/shared/liveness.js";

// The server's own status vocabulary, as the read tools speak it. The words are
// the host's, never ours: a status the server did not state cannot be rendered
// as one, so this mapping is the whole of what an untracked session can say.
// The channel's value is a SessionStatus — busy | retry | idle — and the last
// row is a word it cannot send, which must read as unknown rather than be
// coerced into an outcome.
describe("liveness vocabulary", () => {
  const cases = [
    ["busy", "busy", true],
    ["retry", "busy", true],
    ["idle", "completed", false],
    ["error", "unknown", false],
    [null, "unknown", false],
  ];
  for (const [host, expected, running] of cases) {
    it(`reads the server's "${host}" as ${expected}`, () => {
      assert.strictEqual(statusFromHostState(host), expected);
      assert.strictEqual(hostTurnRunning({ hostState: host, lastMessageAt: null }), running);
    });
  }
});
