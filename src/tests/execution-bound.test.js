/**
 * Deadline contract — the one primitive every read and write that must not
 * outlive its caller goes through.
 *
 * Fast by construction: the bounds here are tens of milliseconds, and the seam
 * that shrinks them is the same one the integration suite uses.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { withBound, shrinkBoundsForTesting, READ_BOUNDS, WRITE_BOUNDS } from "../../dist/shared/execution-bound.js";
import { deferred, sleep } from "./support/harness.js";

const NO_VALUE = Symbol("degradation");

/** withBound at a deadline a test can outwait, with the production value back. */
function bounded(ms, run) {
  const restore = shrinkBoundsForTesting(ms);
  try {
    return run();
  } finally {
    restore();
  }
}

describe("execution bound: withBound", () => {
  it("passes a fast answer through as a whole answer", async () => {
    const out = await withBound(1_000, () => Promise.resolve("ok"), () => NO_VALUE);
    assert.deepStrictEqual({ value: out.value, timedOut: out.timedOut }, { value: "ok", timedOut: false });
  });

  it("hands back the caller's degradation, flagged, when work runs long", async () => {
    const gate = deferred();
    const out = await bounded(20, () => withBound(WRITE_BOUNDS.parentPrompt, () => gate.promise, () => NO_VALUE));
    assert.deepStrictEqual({ value: out.value, timedOut: out.timedOut }, { value: NO_VALUE, timedOut: true });
    gate.resolve();
  });

  // The bug this file exists for: a client that answers synchronously is
  // ordinary. A bound that reached for `.then` on the raw result turned that
  // answer into a TypeError, which the caller read as a failure and answered
  // with a retry — a 200ms stall and a record blaming the wrong thing.
  it("accepts a work function that answers synchronously", async () => {
    const out = await withBound(1_000, () => "immediate", () => NO_VALUE);
    assert.deepStrictEqual({ value: out.value, timedOut: out.timedOut }, { value: "immediate", timedOut: false });
  });

  it("reports a synchronous throw as the rejection it is", async () => {
    await assert.rejects(
      withBound(1_000, () => {
        throw new Error("threw before promising");
      }, () => NO_VALUE),
      /threw before promising/,
    );
  });

  it("surfaces the work's own rejection rather than reporting a timeout", async () => {
    await assert.rejects(withBound(1_000, () => Promise.reject(new Error("upstream down")), () => NO_VALUE), /upstream down/);
  });

  it("a fast answer leaves no timer behind", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await withBound(60_000, () => "quick", () => NO_VALUE);
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
