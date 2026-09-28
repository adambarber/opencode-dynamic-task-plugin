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
  hostTurnInFlight,
  hostTurnOver,
  hostTurnRunning,
  parentTurnStuck,
  readLiveness,
  statusFromHostState,
  UntrackedStatus,
} from "../../dist/shared/liveness.js";
// The assistant role word is PRODUCTION's, consumed and never retyped: a test that
// writes "assistant" by hand is a test that passes on a day the binding changes and
// fails on no day at all, which is the Tenet 12 failure mode exactly. There is no
// matching user binding to import, so "user" is a literal and stays one.
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";

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
    const reading = await readLiveness(
      { session: { status: async () => ({ data: { ses_x: { type: "compacting" } } }) } },
      "ses_x",
      [],
    );
    assert.strictEqual(reading.hostState, "compacting", "the host's own word survives the read");
  });
});

// The refusals, which are the half of this module with teeth.
//
// Every reader above answers "what did the host say". Each of these three answers
// a question the host did NOT answer — a read that failed, a clock that is only
// half present, a tail that ends on somebody else's message — and the answer in
// all three is "not that". Reading a gap as a fact is the expensive mistake here
// and it is silent: guess "busy" and every owed notification defers for as long
// as the channel is down; guess "wedged" and every re-delivery is refused on a
// healthy parent. Neither announces itself.
//
// So every case states its refusal ALONGSIDE the reading it must not collapse
// into, and the contrast is the test. An assertion that only ever expected the
// refusal would be satisfied by a function that returned false unconditionally.
describe("liveness: what the host did not say is not a reading", () => {
  const status = (data) => ({ session: { status: async () => ({ data }) } });

  it("reads an un-terminated turn as unfinished by its START, not as no turn at all", async () => {
    // A turn carrying `created` and no `completed` is one the host opened and has
    // not closed. The walk over the tail must reach it and answer with the start,
    // because "no completion" and "no clock" are different sentences and only the
    // first one is about a live turn.
    const closed = { info: { role: ASSISTANT_ROLE, time: { created: 100, completed: 200 } } };
    const open = { info: { role: ASSISTANT_ROLE, time: { created: 300 } } };

    const reading = await readLiveness(status({}), "ses_x", [closed, open]);
    assert.strictEqual(reading.lastMessageAt, 300,
      "the newest turn's start, not the older turn's completion — the walk is newest-first");

    // The contrast. If the fallback answered "no clock at all" this would be null
    // and every open turn in a transcript would read as one that never existed.
    const genuinelyClockless = await readLiveness(status({}), "ses_x", [closed, { info: { role: ASSISTANT_ROLE } }]);
    assert.strictEqual(genuinelyClockless.lastMessageAt, 200,
      "a turn with no clock at all falls back to the last turn that has one, not to null");
  });

  it("does not read a status channel that failed as a busy parent", async () => {
    const failed = { session: { status: async () => { throw new Error("channel down"); } } };

    assert.strictEqual(await hostTurnInFlight(failed, "ses_x"), false,
      "a transport error is no evidence the host is holding a write. Reading it as congestion " +
        "defers every debt for as long as the channel is down, which is a silent stall wearing a safety check's name");

    // The contrast, and the reason this is not a function that always says false.
    assert.strictEqual(await hostTurnInFlight(status({ ses_x: { type: "busy" } }), "ses_x"), true,
      "a status the host DID state still reads as a turn in flight");
    assert.strictEqual(await hostTurnInFlight(status({}), "ses_x"), false,
      "and a session the status map does not list is not a running turn either");
  });

  it("walks past a tail that ends on somebody else's message to find the open turn", async () => {
    // A parent's tail is not one kind of message. The newest entry can be the user's
    // own prompt, or a part-bearing record of any role, and the turn that never closed
    // sits under it. Stopping at the newest entry would call a wedged parent healthy
    // whenever anything was said after the wedge. One factory, so the only difference
    // between the two cases is the clock — which is the whole claim.
    const tailWith = (assistantClock) => ({
      messages: [
        { info: { role: ASSISTANT_ROLE, time: assistantClock } },
        { info: { role: "user", time: { created: 200, completed: 210 } } },
      ],
    });
    const client = (messages) => ({ session: { messages: async () => ({ data: messages }) } });

    assert.strictEqual(await parentTurnStuck(client(tailWith({ created: 100 })), "ses_x"), true,
      "the open assistant turn under a user message is still the turn that never closed");

    // The contrast. Identical tail, identical walk — only the completion differs, so
    // a parentTurnStuck that answered true because it merely found a message would
    // fail this.
    assert.strictEqual(await parentTurnStuck(client(tailWith({ created: 100, completed: 190 })), "ses_x"), false,
      "the same tail with a completed turn underneath is healthy");

    // A tail that never holds an assistant turn at all is not a wedge either: the
    // host has not said a turn failed, and this returns false rather than guessing.
    assert.strictEqual(
      await parentTurnStuck(client({ messages: [{ info: { role: "user" } }] }), "ses_x"),
      false,
      "no assistant turn in the tail is unknown, not a refusal to deliver",
    );
  });
});
