import assert from "node:assert";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Yield until the queue has run once, so a fire-and-forget write has had its
 * reaction delivered. NOT a sleep: the point is the turn of the loop, and the
 * length of a bound is a fact no test should be guessing at.
 *
 * A MACROTASK, and that is load-bearing: `drain` waits for a production DEADLINE, and
 * a deadline is a timer. `setImmediate` yields within the timers phase, so a drain
 * built on it spins 200 turns in under 5ms and reports "the chain did not drain" for
 * a 20ms bound that has not been given 20ms yet — a helper that cannot observe the
 * thing it exists to observe.
 */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Await `settled()` until `chainOf()` reports nothing left in flight. */
export const drain = async (chainOf, chainName = "unnamed") => {
  const started = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - started) / 1000n) / 1000;
  for (let turn = 0; chainOf() > 0; turn++) {
    assert.ok(
      turn < 200,
      `the writes never reached their bound — the chain did not drain (${chainName}) after ${elapsedMs()}ms`,
    );
    await settled();
  }
};
