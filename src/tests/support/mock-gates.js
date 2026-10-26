/**
 * The armed primitives: a client whose answer the test decides, and a gate that can
 * be made to fail or to never answer.
 *
 * These are not host shapes — they are the levers a test pulls. Keeping them apart
 * from `mock-host.js` says which is which: a fixture here can lie about the server,
 * a lever here can only lie about timing, and a suite that reaches for a lever is
 * visibly not asserting anything about the host's contract.
 */

import { armFault } from "./faults.js";
import { hostSaid, hostSaying } from "./mock-transcript.js";
import { missingSessionError } from "./sdk-contract.js";

/**
 * A client whose only method is the parent write, plus the list of writes that
 * actually reached it. Every test in this file needs the same two things — a
 * transport whose answer the test decides, and the count of writes that got
 * there — and they were two hand-written client literals per test, so "dialed
 * exactly once" was answered by whichever literal that test happened to copy. One
 * wrapper, one recording: a test that wants the write to park, to throw, or to
 * note its own ordering says so in `respond`, and the record is the same record.
 */
export function recordingClient(respond) {
  const calls = [];
  const turns = new Map();
  return {
    calls,
    // The same two facts the big fake keeps, written to the same place: a turn running
    // is an assistant message with no `completed`, and its absence from the record is
    // the one thing that reads as "open". A private map here would be a second copy
    // of a fact production reads from the transcript.
    setMessages: (id, list) => turns.set(id, list),
    setStatus: (id, word) => {
      turns.set(id, [word === "open" ? hostSaying("") : hostSaid("")]);
    },
    client: {
      session: {
        context: async (args) => turns.get(args.sessionID) ?? [],
        // Project the message list down to the turn record production reads: no
        // finished message means the host has recorded no verdict, and a finished
        // message's own error/absence of one names how it ended. A session this
        // client has no messages for at all is a NotFound like any other.
        get: async ({ sessionID }) => {
          if (!turns.has(sessionID)) throw missingSessionError();
          const messages = turns.get(sessionID) ?? [];
          const lastAssistant = messages.findLast((m) => m?.type === "assistant");
          if (!lastAssistant || lastAssistant.time?.completed === undefined) {
            return { id: sessionID, outcome: undefined, time: { created: Date.now() } };
          }
          return {
            id: sessionID,
            outcome: lastAssistant.error ? "failed" : "succeeded",
            time: { created: lastAssistant.time.created ?? Date.now(), idle: lastAssistant.time.completed },
          };
        },
        prompt: async (args) => {
          calls.push(args);
          return respond(args);
        },
      },
    },
  };
}

/**
 * The SDK envelope every answer arrives in. `refusal` is the second half of the
 * same contract: the SDK does not throw on an API error, it RESOLVES the envelope
 * with an `error` beside a non-2xx status — which is why a fake that can only
 * refuse by throwing cannot express a refusal, and why a case written against it
 * tested the wrong branch.
 */

/** A promise plus its resolver — the gate tests use to hold a reply open. */
export function deferred() {
  // Typed as what they HOLD, not as the initializer: `null` placeholders typed
  // `null` made every `await pair.promise` an await of a non-Promise, which is
  // exactly the class the await-thenable rule exists to catch — a gate whose
  // promise cannot be awaited is a gate that answers nothing.
  const pair = /** @type {{
    promise: Promise<void> | null;
    reject: ((e?: unknown) => void) | null;
    resolve: (() => void) | null;
  }} */ ({ promise: null, resolve: null, reject: null });
  pair.promise = new Promise((resolve, reject) => {
    pair.resolve = resolve;
    pair.reject = reject;
  });
  return pair;
}

/**
 * Arm one host call open, the way every gated call is armed. The mock consults
 * `state[name]`, the test holds the release: one shape, so a new gate cannot
 * invent its own protocol with the mock.
 */
export function armGate(state, name, { fails = false, maybe = false } = {}) {
  const gate = deferred();
  state[name] = { fails, promise: gate.promise, release: gate.resolve, used: false };
  // The gate name is the fault name: one spelling, so the teardown rule needs no
  // translation table between "what a test armed" and "what a branch records".
  armFault(state, name);
  if (maybe) state.maybe.add(name);
  return { release: () => gate.resolve() };
}
