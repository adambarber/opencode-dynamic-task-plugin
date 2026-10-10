// src/tests/support/notify-setup.js
// One home for the transport scripts and the clean-slate hook every notify
// suite shares, so three files can hold three subjects instead of one
// big preamble. Each importer inherits the before/after clean state.

//jscpd:ignore-start
import { gateLedger, getPendingDeliveries, notifyChainCount, redeliverOwedNotifications, restorePendingDeliveries } from "../../../dist/shared/notify.js";
import { cleanNotifyState } from "./gate-world.js";
import { bounded, drain } from "./harness.js";
import { deferred, recordingClient } from "./mock-host.js";
import { opaqueHost } from "./opaque-host.js";
import { afterEach, assert, beforeEach } from "./runner.js";

//jscpd:ignore-end
export const NO_SLEEP = async () => {};

/** The answer a host gives a write it accepted — one answer, so "accepted" is a name and not a shape. */
export const accepted = () => ({ ok: true });

/**
 * The gated parent transport, in its two forms. Every write records its args
 * (so "never dialed" is observable) and then parks on `gate` until the test
 * resolves it; `throwFirst` fails the first write and parks the rest, which is
 * the shape the retry-then-hold tests need. Parked means parked — awaiting
 * anything that is not the gate's promise (a deferred object, say) lets the
 * write resolve immediately, and a test written that way asserts a concurrency
 * claim while actually exercising a transport that answered at once.
 *
 * The option vocabulary is CLOSED. A misspelled key that is silently ignored
 * makes the transport behave like the plan nobody asked for, and the test then
 * passes against a delivery the host never performed — the mock, not the gate,
 * becomes the thing under test.
 */
export function gatedClient(gate, options = {}) {
  const unknown = Object.keys(options).filter((key) => key !== "throwFirst");
  if (unknown.length > 0) throw new Error(`gatedClient: unknown option(s) ${unknown.join(", ")}`);
  let thrownOnce = false;
  return recordingClient(async () => {
    if (options.throwFirst && !thrownOnce) {
      thrownOnce = true;
      throw new Error("parent busy");
    }
    await gate.promise;
    return accepted();
  });
}

/**
 * A client whose every parent write parks until the returned gate is released —
 * the transport that held a completion notice on the wire for twenty minutes in
 * the field. `release` answers the held write and waits one macrotask turn,
 * which is exactly long enough for the continuations already queued against that
 * answer to have run — an observable, not a sleep.
 */export function heldWriteClient() {
  const gate = deferred();
  const held = gatedClient(gate);
  return {
    ...held,
    release: async () => {
      gate.resolve();
      await gate.promise;
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}


/** The transport that answers at once — the default, and a script of outcomes when asked for one. */
export function answeredClient(script = []) {
  // script: Array<"ok"|Error> consumed per prompt call.
  return recordingClient(async () => {
    const step = script.length > 0 ? script.shift() : "ok";
    if (step instanceof Error) throw step;
    return accepted();
  });
}


// The gate's own inputs: which child, what kind, and no real backoff — the
// retry count is the thing under test, so waiting for it proves nothing.
export const gate = (childSessionId, kind) => ({ childSessionId, kind, sleep: NO_SLEEP });

/** The queue as one child's slice of it — module scope, because the debt's owner is the queue, not any one describe. */
export const queuedFor = (childSessionId) =>
  getPendingDeliveries().filter((entry) => entry.childSessionId === childSessionId);

/**
 * The writes that carried THIS text. A boot pays the whole queue, and this file
 * leaves other children's debts behind, so a bare call count would be a count of
 * every debt in the ledger rather than of the one under test.
 */
export const writesTo = (calls, text) => calls.filter((call) => call.text === text);

/**
 * The clean slate every case in this file starts from, defined once because the
 * queue is DURABLE state: `clearNotifyLedger` deliberately does not touch it, so
 * without this each describe inherits whatever the previous one left owed and a
 * case is asserting against a ledger it did not build.
 *
 * Registered ONCE at module scope rather than per describe, which is both the
 * isolation the file wants and the reason the duplication gate stopped
 * reporting the same two hook lines in every block.
 */

beforeEach(cleanNotifyState);
afterEach(cleanNotifyState);

/**
 * The outcome every delivery test ends on: the verdict AND how many writes
 * actually reached the transport. These belong in one assertion because the
 * count is what makes the verdict mean "exactly once" — a test that asserts the
 * verdict alone cannot tell a delivered write from a second copy beside it.
 */
export function assertDelivered(verdict, calls, expectedCalls) {
  assert.strictEqual(verdict, true);
  assert.strictEqual(calls.length, expectedCalls, `${expectedCalls} write(s) reached the parent`);
}

/**
 * Run `body` against a client that HOLDS every parent write: the deadline is
 * shrunk to something a test can outwait, the write stays held until the body
 * releases it, and the hold and the production bounds are restored whatever the
 * body does. The deadline is shrunk, never mocked — the timer is real, only the
 * patience changes.
 */
export async function withHeldWrites(body) {
  return bounded(20, async () => {
    const held = heldWriteClient();
    try {
      return await body(held);
    } finally {
      await held.release();
    }
  });
}
/**
 * The same held transport, NEVER released.
 *
 * This exists because `withHeldWrites` releases in a `finally`, which made "a
 * write that neither resolves nor rejects" unrepresentable — and that is the
 * exact shape that shipped an unbounded redelivery with a green suite. Every
 * held-write test proved the plugin recovers once the host ANSWERS; none could
 * ask what happens when it never does, which is the only question that matters
 * for a debt that is re-offered at every boot.
 *
 * The name says it at the call site, because the failure this fixes is a test
 * that reads like all the others.
 */
export async function withUnansweredWrite(body) {
  return bounded(20, () => body(heldWriteClient()));
}

/**
 * One boot, as `initPluginState` performs it: pay the durable queue through the
 * one re-offer production has.
 *
 * A boot is a PROCESS BOUNDARY, so the in-memory gate goes with it — the claim
 * ledger, the in-flight set and the delivery history are all per-process (the
 * notification ledger is documented as in-memory for exactly this reason), and
 * only the queue survives. Modelling that is what makes this a boot rather than
 * a second offer: without the reset the second entry is SUPPRESSED, because the
 * claim from the previous boot is still in flight in a process that has gone.
 *
 * `gateLedger.clear()` and NOT `clearNotifyLedger`, deliberately: the latter also
 * bumps the epoch, and a parked commit from the previous boot would then be
 * stopped by the epoch guard rather than by the retirement guard this work is
 * about. One guard per test, or the test proves the wrong one.
 */
export async function boot(client, maxAttempts) {
  gateLedger.clear();
  restorePendingDeliveries(getPendingDeliveries());
  redeliverOwedNotifications(opaqueHost(client), maxAttempts);
  // Wait until this boot's own writes have reached their bound, which is what a real
  // boot does before it exits: a redelivery it could not finish is left owed for the next.
  await drain(notifyChainCount, "notify");
}


