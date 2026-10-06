/**
 * Deadline contract — the one primitive every read and write that must not
 * outlive its caller goes through.
 *
 * Fast by construction: the bounds here are tens of milliseconds, and the seam
 * that shrinks them is the same one the integration suite uses.
 */

//jscpd:ignore-start
import { assert, describe, it } from "./support/runner.js";
import { READ_BOUNDS, WRITE_BOUNDS, shrinkBoundsForTesting, withBound } from "../../dist/shared/execution-bound.js";
import { bounded, sleep } from "./support/harness.js";
import { deferred } from "./support/mock-host.js";

//jscpd:ignore-end
const NO_VALUE = Symbol("degradation");

/**
 * A bound answers a value AND whether that value is the degradation — the two
 * fields travel together and are the whole claim, so they are read together: a
 * case that asserted the value alone would pass on a bound that answered the
 * right thing by timing out.
 */
const assertBound = async (out, expected, why) => {
  assert.deepStrictEqual({ timedOut: out.timedOut, value: out.value }, expected, why);
  return out;
};

describe("execution bound: withBound", () => {
  it("passes a fast answer through as a whole answer", async () => {
    await assertBound(await withBound(1_000, () => Promise.resolve("ok"), NO_VALUE), { timedOut: false, value: "ok" }, "a fast answer is the work's own");
  });

  it("hands back the caller's degradation, flagged, when work runs long", async () => {
    const gate = deferred();
    await assertBound(
      await bounded(20, () => withBound(WRITE_BOUNDS.parentPrompt, () => gate.promise, NO_VALUE)),
      { timedOut: true, value: NO_VALUE },
      "a bound that ran out answers the degradation, flagged",
    );
    gate.resolve();
  });

  // The bug this file exists for: a client that answers synchronously is
  // ordinary. A bound that reached for `.then` on the raw result turned that
  // answer into a TypeError, which the caller read as a failure and answered
  // with a retry — a 200ms stall and a record blaming the wrong thing.
  //
  // The funnel tolerates it; `callHost`'s type no longer ACCEPTS it, because a body
  // that finished before the call it wraps opened is the `safeLog` defect. So this
  // is the tolerance the type is not obliged to promise, kept because the SDK is not
  // ours and a future method may answer synchronously.
  it("accepts a work function that answers synchronously", async () => {
    await assertBound(await withBound(1_000, () => "immediate", NO_VALUE), { timedOut: false, value: "immediate" }, "a synchronous answer is an answer");
  });

  it("reports a synchronous throw as the rejection it is", async () => {
    await assert.rejects(
      withBound(1_000, () => {
        throw new Error("threw before promising");
      }, NO_VALUE),
      /threw before promising/,
    );
  });

  it("surfaces the work's own rejection rather than reporting a timeout", async () => {
    await assert.rejects(withBound(1_000, () => Promise.reject(new Error("upstream down")), NO_VALUE), /upstream down/);
  });

  it("a fast answer leaves no timer behind", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await withBound(60_000, () => "quick", NO_VALUE);
    await sleep(5);
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, `a cleared deadline leaves no pending timer (before ${before}, after ${after})`);
  });
});

describe("execution bound: the test seam", () => {
  it("shrinks every bound and hands the production values back", async () => {
    const production = { read: READ_BOUNDS.transcript, write: WRITE_BOUNDS.parentPrompt };
    const restore = shrinkBoundsForTesting(5);
    assert.deepStrictEqual({ read: READ_BOUNDS.transcript, write: WRITE_BOUNDS.parentPrompt }, { read: 5, write: 5 });
    restore();
    assert.deepStrictEqual({ read: READ_BOUNDS.transcript, write: WRITE_BOUNDS.parentPrompt }, production);
  });
});
