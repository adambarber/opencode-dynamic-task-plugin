/**
 * liveness.ts — the host's turn object, and the three things anyone asks of it.
 *
 * The status channel's own `SessionStatus` and the clock on the child's last
 * message. Two sources and no inference — and the shape of the host's answer is
 * the SDK's, not a copy: the word list below is PARSED OUT of the declaration the
 * production code compiles against, so this suite cannot drift into asserting a
 * host that does not exist.
 *
 * THREE questions, because the host's word answers different ones: is a turn
 * running, is it one this plugin reads at all, and does the host still have the
 * session at all. The third is not answerable from the status map — "nothing
 * running" and "never existed" are the same absence in there — so it is asked of
 * the one endpoint whose contract answers it, and that asymmetry is the reason
 * this file has three questions rather than one.
 */

import { describe, it, assert } from "./support/runner.js";
import { notFoundName } from "./support/sdk-contract.js";
import {
  hostTurnInFlight,
  hostTurnRunning,
  NOT_FOUND_NAME,
  parentTurnStuck,
  readLiveness,
  readSessionPresence,
  SessionExistence,
  statusFromHostTurn,
  UntrackedStatus,
} from "../../dist/shared/liveness.js";
// The assistant role word is PRODUCTION's, consumed and never retyped: a test that
// writes "assistant" by hand is a test that passes on a day the binding changes and
// fails on no day at all, which is the Tenet 12 failure mode exactly. There is no
// matching user binding to import, so "user" is a literal and stays one.
import { opaqueHost } from "./support/opaque-host.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { hostStatusWords } from "./support/sdk-contract.js";

// What each word the host DECLARES means here. The expectation is the claim; the
// word list is the SDK's, so a host that adds or renames one lands in this table's
// absence and the case below fails rather than silently going untested.
const READING_OF = {
  busy: { running: true, untracked: UntrackedStatus.Busy },
  retry: { running: true, untracked: UntrackedStatus.Busy },
  // Unreachable through the real map, and deliberately asserted anyway: the host
  // DELETES on `idle` (session/status.ts), so the map's contract is "running
  // turns only". `hostTurnRunning` must still read an `idle` turn as not running,
  // because a map that could hold one is a map whose absence stops meaning one thing.
  idle: { running: false, untracked: UntrackedStatus.Unknown },
};

describe("liveness vocabulary", () => {
  const declared = hostStatusWords();
  it("reads every word the host declares, so a new word cannot go untested", () => {
    assert.deepStrictEqual(
      [...declared].sort(),
      Object.keys(READING_OF).sort(),
      "the host declares a word this suite has no reading for — decide what it means here first",
    );
  });

  for (const word of declared) {
    it(`reads the host's "${word}" as running=${READING_OF[word]?.running}, untracked=${READING_OF[word]?.untracked}`, () => {
      const expected = READING_OF[word];
      assert.ok(expected, `the host declared "${word}" and this suite has no reading for it`);
      // `retry` is the one word that carries a payload; it is built here rather than
      // as a bare `{type}` so the fixture is the host's actual shape.
      const turn =
        word === "retry" ? { type: word, attempt: 1, message: "retrying", next: 10 } : { type: word };
      const reading = { hostTurn: turn, statusAnswered: true, lastMessageAt: null, messageCount: 0 };
      assert.strictEqual(hostTurnRunning(reading), expected.running);
      assert.strictEqual(statusFromHostTurn(turn), expected.untracked);
    });
  }

  // A key that is not there is the case the whole module turns on, so it is stated
  // on its own rather than as a row: absence is not a word, and the two are read
  // differently by every caller.
  it("reads an unlisted session as unknown, and not as a turn that ended", () => {
    const reading = { hostTurn: undefined, statusAnswered: true, lastMessageAt: null, messageCount: 0 };
    assert.strictEqual(hostTurnRunning(reading), false);
    assert.strictEqual(statusFromHostTurn(undefined), UntrackedStatus.Unknown);
  });

  // The word reaches the reader intact. Coerced to undefined on the way in it would
  // still render "unknown" and still read as not-running — both of which the case
  // above accepts — and the caller that must not settle on an unread word would
  // have no way left to tell the two apart.
  it("carries the host's own turn object through to the reading", async () => {
    const reading = await readLiveness(
      opaqueHost({ session: { status: async () => ({ data: { ses_x: { type: "busy" } } }) } }),
      "ses_x",
      [],
    );
    assert.deepStrictEqual(reading.hostTurn, { type: "busy" }, "the host's own object survives the read");
    assert.strictEqual(reading.statusAnswered, true);
  });
});

// The refusals, which are the half of this module with teeth.
//
// Every reader above answers "what did the host say". Each of these answers a
// question the host did NOT answer — a read that failed, a clock that is only half
// present, a tail that ends on somebody else's message — and the answer in all
// three is "not that". Reading a gap as a fact is the expensive mistake here and it
// is silent: guess "busy" and every owed notification defers for as long as the
// channel is down; guess "settled" and a restart ends every child it finds.
//
// So every case states its refusal ALONGSIDE the reading it must not collapse
// into, and the contrast is the test. An assertion that only ever expected the
// refusal would be satisfied by a function that returned false unconditionally.
describe("liveness: what the host did not say is not a reading", () => {
  const status = (data) => opaqueHost({ session: { status: async () => ({ data }) } });

  it("reports the status channel's silence as silence, not as a settled turn", async () => {
    // The channel is DOWN. Every restored child is left active by the reconciler on
    // the strength of this flag, so reading "no reply" as "no turn running" ends
    // every child in the store the moment the host has one bad moment.
    const failed = opaqueHost({ session: { status: async () => { throw new Error("channel down"); } } });
    const reading = await readLiveness(failed, "ses_x", []);
    assert.strictEqual(reading.statusAnswered, false, "a transport failure is not an answer");
    assert.strictEqual(reading.hostTurn, undefined);

    // The contrast: an answer that lists nothing DID answer, and absence in it means
    // no turn running. Without this the flag would be a constant and worthless.
    const answered = await readLiveness(status({}), "ses_x", []);
    assert.strictEqual(answered.statusAnswered, true);
    assert.strictEqual(answered.hostTurn, undefined, "an unlisted session has no turn, but the channel answered");

    assert.strictEqual(await hostTurnInFlight(failed, "ses_x"), false,
      "a transport error is no evidence the host is holding a write. Reading it as congestion " +
        "defers every debt for as long as the channel is down, which is a silent stall wearing a safety check's name");
    assert.strictEqual(await hostTurnInFlight(status({ ses_x: { type: "busy" } }), "ses_x"), true,
      "a status the host DID state still reads as a turn in flight");
  });

  it("answers existence from the endpoint whose contract answers it", async () => {
    // The SDK's two not-found spellings, because the error mode picks which arrives
    // and a reader hardcoded to one reports every missing session present whenever
    // the other is in force.
    const named = Object.assign(new Error("nope"), { name: NOT_FOUND_NAME });
    const statusOnly = Object.assign(new Error("nope"), { status: 404 });
    const refusing = (error) => opaqueHost({ session: { get: async () => { throw error; } } });

    for (const [spelling, error] of [["name", named], ["status", statusOnly]]) {
      const presence = await readSessionPresence(refusing(error), "ses_x");
      assert.strictEqual(presence.existence, SessionExistence.Missing, `a 404 spelled by ${spelling} is a missing session`);
      assert.strictEqual(presence.missing, error,
        "the host's own refusal is handed back verbatim — a re-spelled one would be a second vocabulary to keep in step");
    }
    // Only one of the two spellings carries the name; the status-only error keeps its
    // `Error` name, which is why the reader has to accept both shapes.
    assert.strictEqual(NOT_FOUND_NAME, notFoundName(),
      "the name production matches on is the name the SDK declares — parsed here, not copied");
    assert.strictEqual((await readSessionPresence(refusing(named), "ses_x")).missing?.name, NOT_FOUND_NAME);
    assert.strictEqual((await readSessionPresence(refusing(statusOnly), "ses_x")).missing?.name, "Error");

    // A refusal that is not the host's not-found says nothing about existence.
    const other = await readSessionPresence(refusing(Object.assign(new Error("nope"), { name: "UnauthorizedError", status: 403 })),
      "ses_x",
    );
    assert.strictEqual(other.existence, SessionExistence.Unread,
      "a 403 is not a missing session — reading it as one ends a child the host still has");

    // And the positive, or the check above proves nothing: a session the host HAS
    // reads present whatever else is true of it.
    const present = await readSessionPresence(
      opaqueHost({ session: { get: async () => ({ data: { id: "ses_x" } }) } }),
      "ses_x",
    );
    assert.strictEqual(present.existence, SessionExistence.Present);
  });

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
    const client = (messages) => opaqueHost({ session: { messages: async () => ({ data: messages }) } });

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