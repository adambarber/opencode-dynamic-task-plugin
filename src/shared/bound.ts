// src/shared/bound.ts
// Execution-bound funnel (Task 02) — the ONLY module that arms task waits.
// Tenet 7: every wall-clock budget lives here or in DynamicTaskConfig —
// no call site inlines a number. Tenet 2: bounds constrain execution;
// the shape of the work does not matter. Defensive rules: exactly one
// timer per wait, fire-once even under races, late settlement is swallowed
// (never an unhandled rejection), and handles are unref'd so plugin waits
// never hold the host process open.

import type { TimerProvider } from "./config.js";

// ─── Named budgets ─────────────────────────────────────────────────
// Fixed internal budgets. Config-driven budgets (default/min/max timeout)
// stay in DynamicTaskConfig; this is the single home for the rest.

export const ABORT_TIMEOUT_MS = 5000;

// ─── TimeoutController ─────────────────────────────────────────────
// Opaque ownership of one armed timer. cancel() is idempotent and safe
// after firing — callers never touch raw handles.

export interface TimeoutController {
  cancel(): void;
}

// ─── startTimeout ──────────────────────────────────────────────────
// Arms exactly one timer. onFire runs at most once; cancel() suppresses it.

export function startTimeout(
  timerProvider: TimerProvider,
  ms: number,
  onFire: () => void,
): TimeoutController {
  let fired = false;
  const handle = timerProvider.setTimeout(() => {
    if (fired) return;
    fired = true;
    onFire();
  }, ms);
  // Defensive: plugin waits must never hold the host process open.
  (handle as unknown as { unref?: () => void })?.unref?.();

  let cancelled = false;
  return {
    cancel() {
      if (cancelled || fired) return;
      cancelled = true;
      timerProvider.clearTimeout(handle);
    },
  };
}

// ─── withBound ─────────────────────────────────────────────────────
// Races already-started work against a single bound. Resolves
// { timedOut: false, value } when work wins, { timedOut: true } after
// running onTimeout when the bound wins. Work rejection propagates (after
// cancelling the timer); late settlement in either direction is a no-op.

export type BoundOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

export function withBound<T>(
  timerProvider: TimerProvider,
  ms: number,
  work: Promise<T>,
  onTimeout: () => void,
): Promise<BoundOutcome<T>> {
  return new Promise<BoundOutcome<T>>((resolve, reject) => {
    let done = false;
    const timer = startTimeout(timerProvider, ms, () => {
      if (done) return;
      done = true;
      onTimeout();
      resolve({ timedOut: true });
    });
    work.then(
      (value) => {
        if (done) return;
        done = true;
        timer.cancel();
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (done) return;
        done = true;
        timer.cancel();
        reject(error);
      },
    );
  });
}
