/**
 * Execution-bound contract (Task 02) — pins the single-timer funnel against
 * the REAL TimerProvider seam plus recording fakes. No time mocks of the
 * contract itself: real short-waits prove firing, fakes prove call-shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  ABORT_TIMEOUT_MS,
  startTimeout,
  withBound,
} from "../../dist/shared/bound.js";
import { REAL_TIMERS } from "../../dist/shared/config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordingTimers() {
  const created = [];
  const cleared = [];
  let nextId = 1;
  return {
    created,
    cleared,
    provider: {
      setTimeout: (fn) => {
        const id = nextId++;
        created.push(id);
        return id;
      },
      clearTimeout: (id) => {
        cleared.push(id);
      },
    },
  };
}

describe("bound: named budgets", () => {
  it("centralizes the abort budget (no inline literals at call sites)", () => {
    assert.strictEqual(ABORT_TIMEOUT_MS, 5000);
  });
});

describe("bound: startTimeout", () => {
  it("fires exactly once via the real provider", async () => {
    let fires = 0;
    startTimeout(REAL_TIMERS, 10, () => {
      fires++;
    });
    await sleep(50);
    assert.strictEqual(fires, 1);
  });

  it("cancel prevents firing and is idempotent", async () => {
    let fires = 0;
    const timer = startTimeout(REAL_TIMERS, 20, () => {
      fires++;
    });
    timer.cancel();
    timer.cancel();
    await sleep(60);
    assert.strictEqual(fires, 0);
  });

  it("arms exactly one timer per wait", () => {
    const rec = recordingTimers();
    const timer = startTimeout(rec.provider, 100, () => {});
    assert.strictEqual(rec.created.length, 1);
    timer.cancel();
    assert.deepStrictEqual(rec.cleared, rec.created);
  });

  it("unrefs the handle so waits never hold the host process open", () => {
    let unrefed = false;
    const provider = {
      setTimeout: () => ({ unref: () => { unrefed = true; } }),
      clearTimeout: () => {},
    };
    startTimeout(provider, 100, () => {});
    assert.strictEqual(unrefed, true);
  });
});

describe("bound: withBound", () => {
  it("resolves the work value when fast", async () => {
    const outcome = await withBound(REAL_TIMERS, 1000, Promise.resolve("v"), () => {});
    assert.deepStrictEqual(outcome, { timedOut: false, value: "v" });
  });

  it("reports timeout and runs onTimeout once when slow", async () => {
    let fires = 0;
    const outcome = await withBound(
      REAL_TIMERS,
      20,
      new Promise((resolve) => setTimeout(() => resolve("late"), 80)),
      () => { fires++; },
    );
    assert.deepStrictEqual(outcome, { timedOut: true });
    await sleep(100);
    assert.strictEqual(fires, 1, "late settlement must not refire");
  });

  it("propagates work rejection and cancels the timer", async () => {
    const rec = recordingTimers();
    const failure = new Error("work failed");
    // Fake timers never advance: rejection must still propagate.
    const pending = withBound(rec.provider, 1000, Promise.reject(failure), () => {});
    await assert.rejects(() => pending, /work failed/);
    assert.deepStrictEqual(rec.cleared, rec.created);
  });

  it("cancels the timer when work wins", async () => {
    const rec = recordingTimers();
    const outcome = await withBound(rec.provider, 1000, Promise.resolve("v"), () => {});
    assert.deepStrictEqual(outcome, { timedOut: false, value: "v" });
    assert.deepStrictEqual(rec.cleared, rec.created);
  });
});
