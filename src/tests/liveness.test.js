/**
 * liveness.ts — the host's TURN record, and the three things anyone asks of it.
 *
 * v2 took away the status map this module used to read and gave no replacement
 * channel, so the turn's state now lives on the session itself: `Session.Info`
 * carries `outcome` — the verdict on the last COMPLETED execution — and `time.idle`,
 * and neither appears until a run reaches a terminal transition.
 *
 * THREE questions, because the turn record answers different ones: is a turn
 * running, is it one this plugin reads at all, and does the host still have the
 * session at all. The third is not answerable from a turn's absence — "nothing
 * finished" and "never existed" are the same absence there — so it is asked of the
 * one call whose contract answers it, and that asymmetry is the reason this file has
 * three questions rather than one.
 *
 * The suite's spine is the case at the bottom: a RUNNING turn made of several
 * COMPLETED messages. That is the shape a live v2 child actually has, and the shape
 * the previous version of this module read as a finished turn.
 */

//jscpd:ignore-start
import {
  hostTurnInFlight,
  hostTurnRunning,
  isSessionMissing,
  NOT_FOUND_REASON,
  PROTOCOL_NOT_FOUND_TAG,
  parentTurnStuck,
  readLiveness,
  readSessionPresence,
  SESSION_NOT_FOUND_TAG,
  SessionExistence,
  statusFromHostTurn,
  UntrackedStatus,
} from "../../dist/shared/liveness.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { compareStrings } from "./support/assertions.js";
import { opaqueHost } from "./support/opaque-host.js";
import { assert, describe, it } from "./support/runner.js";
import { clientErrorReasons, hostOutcomeWords } from "./support/sdk-contract.js";

//jscpd:ignore-end
// What each verdict the host DECLARES means here. The expectation is the claim; the
// word list is the SDK's, so a host that adds or renames one lands in this table's
// absence and the case below fails rather than silently going untested.
const READING_OF = {
  failed: UntrackedStatus.Unknown,
  interrupted: UntrackedStatus.Unknown,
  succeeded: UntrackedStatus.Unknown,
};

describe("liveness vocabulary", () => {
  const declared = hostOutcomeWords();

  it("reads every verdict the host declares, so a new one cannot go untested", () => {
    assert.deepStrictEqual(
      [...declared].toSorted(compareStrings),
      Object.keys(READING_OF).toSorted(compareStrings),
      "the host declares a verdict this suite has no reading for — decide what it means here first",
    );
  });

  it("names a failure reason the client actually declares", () => {
    assert.ok(
      clientErrorReasons().includes(NOT_FOUND_REASON),
      `the client declares ${clientErrorReasons().join(", ")} and not "${NOT_FOUND_REASON}" — a missing-session ` +
        "guard matching a reason the client cannot produce matches nothing",
    );
  });

  for (const word of declared) {
    it(`carries the host's "${word}" through to the reading, and a finished turn is not a running one`, async () => {
      const expected = READING_OF[word];
      assert.ok(expected, `the host declared "${word}" and this suite has no reading for it`);
      const host = opaqueHost({ session: { get: async () => ({ id: "ses_x", outcome: word, time: { idle: 5 } }) } });
      const reading = await readLiveness(host, "ses_x", []);
      assert.strictEqual(reading.hostTurn, word, "the host's own verdict survives the read");
      assert.strictEqual(reading.statusAnswered, true);
      assert.strictEqual(hostTurnRunning(reading), false);
      assert.strictEqual(statusFromHostTurn(reading), expected);
    });
  }

  // A turn with no verdict is the case the whole module turns on, so it is stated on
  // its own rather than as a row: ABSENCE is the open turn, and it is read
  // differently from a turn that has finished.
  it("reads a session with no verdict as an open turn, not as a turn that ended", async () => {
    const host = opaqueHost({ session: { get: async () => ({ id: "ses_x" }) } });
    const reading = await readLiveness(host, "ses_x", []);
    assert.strictEqual(reading.hostTurn, undefined);
    assert.strictEqual(reading.statusAnswered, true, "the host answered — it simply has no verdict yet");
    assert.strictEqual(hostTurnRunning(reading), true);
    assert.strictEqual(statusFromHostTurn(reading), UntrackedStatus.Busy);
  });
});

// The refusals, which are the half of this module with teeth.
//
// Every reader above answers "what did the host say". Each of these answers a
// question the host did NOT answer — a read that failed, a refusal that was not the
// host's not-found — and the answer in both is "not that". Reading a gap as a fact
// is the expensive mistake here and it is silent: guess "busy" and every owed
// notification defers for as long as the channel is down; guess "settled" and a
// restart ends every child it finds.
//
// So every case states its refusal ALONGSIDE the reading it must not collapse
// into, and the contrast is the test. An assertion that only ever expected the
// refusal would be satisfied by a function that returned false unconditionally.
const answering = (value) => opaqueHost({ session: { get: async () => value } });
const refusing = (error) => opaqueHost({ session: { get: async () => { throw error; } } });
const notFound = () => Object.assign(new Error("nope"), { cause: { status: 404 }, reason: NOT_FOUND_REASON });

describe("liveness: what the host did not say is not a reading", () => {

  it("reports the channel's silence as silence, not as an open turn", async () => {
    // The channel is DOWN. A parent-write gate that read this as "busy" would defer
    // every owed notification for as long as the host has one bad moment, which is a
    // silent stall wearing a safety check's name.
    const failed = opaqueHost({ session: { get: async () => { throw new Error("channel down"); } } });
    const reading = await readLiveness(failed, "ses_x", []);
    assert.strictEqual(reading.statusAnswered, false, "a transport failure is not an answer");
    assert.strictEqual(reading.hostTurn, undefined);
    assert.strictEqual(hostTurnRunning(reading), false,
      "an unanswered read is not an open turn — the two must not collapse");
    assert.strictEqual(await hostTurnInFlight(failed, "ses_x"), false);

    // The contrast: a session that DID answer, with no verdict, is an open turn.
    // Without this the flag would be a constant and worthless.
    const answered = await readLiveness(answering({ id: "ses_x" }), "ses_x", []);
    assert.strictEqual(answered.statusAnswered, true);
    assert.strictEqual(await hostTurnInFlight(answering({ id: "ses_x" }), "ses_x"), true);
  });

  it("answers existence from the call whose contract answers it", async () => {
    // The host's own missing-session shape: a `ClientError` whose reason says the
    // server refused and whose cause carries the status. The v1 spelling — a named
    // error, or a status at the top level — is what the previous reader looked for,
    // and a v2 host produces neither, so every lost child read as merely unread.
    const missing = await readSessionPresence(refusing(notFound()), "ses_x");
    assert.strictEqual(missing.existence, SessionExistence.Missing, "a 404 on the cause is a missing session");
    assert.strictEqual(missing.statusAnswered, true, "the host answered — it answered 'no such session'");

    // The contrast: a refusal that is not the host's not-found says nothing about
    // existence, and reading it as one ends a child the host still has.
    for (const error of [
      Object.assign(new Error("nope"), { cause: { status: 403 }, reason: NOT_FOUND_REASON }),
      Object.assign(new Error("nope"), { status: 404 }),
      Object.assign(new Error("nope"), { name: "NotFoundError" }),
    ]) {
      const other = await readSessionPresence(refusing(error), "ses_x");
      assert.strictEqual(other.existence, SessionExistence.Unread,
        `a refusal shaped ${JSON.stringify({ name: error.name, reason: error.reason, status: error.status })} ` +
          "is not the host's not-found, and must not end a session the host still has");
    }

    // And the positive, or the checks above prove nothing: a session the host HAS
    // reads present whatever else is true of it.
    const presence = await readSessionPresence(answering({ id: "ses_x" }), "ses_x");
    assert.strictEqual(presence.existence, SessionExistence.Present);
  });

  it("reads an un-terminated message by its START, not as no clock at all", async () => {
    // A message carrying `created` and no `completed` is one the host opened and has
    // not closed. The walk over the tail must reach it and answer with the start,
    // because "no completion" and "no clock" are different sentences and only the
    // first one is about a live message.
    const closed = { info: { role: ASSISTANT_ROLE, time: { completed: 200, created: 100 } } };
    const open = { info: { role: ASSISTANT_ROLE, time: { created: 300 } } };
    const host = answering({ id: "ses_x" });

    const reading = await readLiveness(host, "ses_x", [closed, open]);
    assert.strictEqual(reading.lastMessageAt, 300,
      "the newest message's start, not the older one's completion — the walk is newest-first");

    // The contrast. If the fallback answered "no clock at all" this would be null
    // and every open message in a transcript would read as one that never existed.
    const genuinelyClockless = await readLiveness(host, "ses_x", [closed, { info: { role: ASSISTANT_ROLE } }]);
    assert.strictEqual(genuinelyClockless.lastMessageAt, 200,
      "a message with no clock at all falls back to the last one that has a clock, not to null");
  });

});

// The case this whole rewrite exists for.
//
// A v2 turn is a SEQUENCE of assistant messages, and each carries its OWN
// `time.completed` — so for most of a running turn, "the last message completed" is
// TRUE. Measured against a live child: 47 minutes of work, with message 7 completing
// 30 seconds in. The previous version of this module derived "the turn is over" from
// exactly that field, and settled a running child as `completed` seconds into its
// first step. The ledger said finished while the work continued for another 40
// minutes, which is the failure a dispatching parent cannot recover from: the result
// it renders is the one it asked for, and it is a lie.
//
// Both shapes are below, so the case cannot be satisfied by a reader that returns
// either answer unconditionally.
describe("liveness: a turn is not a message", () => {
  // One builder for the three cases below: the transcript is the constant, the
  // session object is the variable — which is the whole claim of the describe.
  const hostWithMessages = (messages, session) =>
    opaqueHost({ session: { context: async () => messages, get: async () => session } });

  // Both open-turn cases below read the same shape — no verdict on the session —
  // and differ only in the transcript they hand it.
  const readOpenTurn = async (messages, why) => {
    const reading = await readLiveness(hostWithMessages(messages, { id: "ses_x" }), "ses_x");
    assert.strictEqual(reading.hostTurn, undefined, why);
    return reading;
  };

  const step = (seq, completedAt) => ({
    info: {
      role: ASSISTANT_ROLE,
      time: completedAt === undefined ? { created: seq } : { completed: completedAt, created: seq },
    },
    parts: [{ text: `step ${seq}`, type: "text" }],
  });

  it("calls a RUNNING turn running while every one of its messages has completed", async () => {
    // The live shape: seven finished steps, an eighth in flight, no verdict recorded.
    const messages = [...Array.from({ length: 7 }, (_, i) => step(i, i * 30)), step(7)];

    const reading = await readOpenTurn(messages, "the host has recorded no verdict for the turn");
    assert.strictEqual(hostTurnRunning(reading), true,
      "a turn whose every message has completed is still a turn in progress — that is the shape a live child has");
    const live = hostWithMessages(messages, { id: "ses_x" });
    assert.strictEqual(await hostTurnInFlight(live, "ses_x"), true);
    assert.strictEqual(await parentTurnStuck(live, "ses_x"), true);

    // The contrast, and the falsification. Identical transcript, one field apart on
    // the SESSION: a reader that looked at the transcript at all, or that returned
    // either answer unconditionally, fails this.
    const finished = hostWithMessages(messages, { id: "ses_x", outcome: "succeeded", time: { idle: 900 } });
    const done = await readLiveness(finished, "ses_x");
    assert.strictEqual(done.hostTurn, "succeeded");
    assert.strictEqual(hostTurnRunning(done), false, "the same messages, with a verdict, are a turn that ended");
    assert.strictEqual(await hostTurnInFlight(finished, "ses_x"), false);
  });

  it("does not read a message's own error as the turn's verdict", async () => {
    // The transcript's last message carries an error, and the host has recorded no
    // verdict. The turn is the host's to close; a reader that promoted a message's
    // error into a finished turn would settle a child that is still running.
    const messages = [{ ...step(1, 1), info: { error: { name: "Error" }, role: ASSISTANT_ROLE, time: { completed: 2, created: 1 } } }];

    const reading = await readOpenTurn(messages);
    assert.strictEqual(hostTurnRunning(reading), true, "a message error is not a turn verdict");
  });
});
describe("isSessionMissing names every not-found the host sends", () => {
  // Three exact shapes, each verified against something real: the tagged SDK
  // error (live host), the RPC wire error (plugin framework), the ClientError
  // rejection (promise client). A fourth spelling — top-level status, a bare
  // name, a message about some OTHER thing being gone — must never match.
  const cases = [
    ["dotted core tag", { _tag: SESSION_NOT_FOUND_TAG, sessionID: "ses_x" }, true],
    ["dotted core type", { sessionID: "ses_x", type: SESSION_NOT_FOUND_TAG }, true],
    ["protocol tag", { _tag: PROTOCOL_NOT_FOUND_TAG, message: "Session not found: ses_x" }, true],
    ["protocol type", { message: "Session not found: ses_x", type: PROTOCOL_NOT_FOUND_TAG }, true],
    ["ClientError rejection", Object.assign(new Error("nope"), { cause: { status: 404 }, reason: NOT_FOUND_REASON }), true],
    ["session-scoped message", { message: "Session not found: ses_x" }, true],
    ["agent-not-found tag", { _tag: "Session.AgentNotFoundError", message: "Agent not found: General" }, false],
    ["agent-not-found message", { message: "Agent not found: General" }, false],
    ["top-level status", Object.assign(new Error("nope"), { status: 404 }), false],
    ["bare name", Object.assign(new Error("nope"), { name: "NotFoundError" }), false],
    ["empty failure", {}, false],
  ];
  for (const [name, error, want] of cases) {
    it(`${want ? "reads" : "refuses"}: ${JSON.stringify(name)}`, () => {
      assert.strictEqual(isSessionMissing(error), want);
    });
  }
});
