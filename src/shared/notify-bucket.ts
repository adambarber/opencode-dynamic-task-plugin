// src/shared/notify-bucket.ts — per-child rate limit for task_notice.
// A child may land at most `maxPerMinute` notices in any rolling 60-second
// window. Each notice IS a `session.prompt`, a real user turn in the parent's
// session, so an unrate-limited looping child wedges the parent. Overflows are
// suppressed (never dialed) and logged; when the bucket recovers a summary of
// what was suppressed is owed to the parent.

const WINDOW_MS = 60_000;

interface Bucket {
  // Stamps of notices delivered in the current window.
  stamps: number[];
  // Notices suppressed in the current window, awaiting a summary.
  suppressed: number;
  // Start of the current rolling window.
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Decide whether one notice from a child may be delivered right now.
 *
 * Returns `allowed` and, when the bucket just recovered from a suppression,
 * `summaryOwed` — how many notices were suppressed in the window that closed,
 * so the caller can deliver a single summary notice to the parent.
 */
export function takeNotice(childSessionId: string, maxPerMinute: number, now: number): {
  allowed: boolean;
  summaryOwed: number;
} {
  const bucket = buckets.get(childSessionId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    // New window: report whatever was suppressed before, then this notice
    // opens the new window and consumes its first token.
    buckets.set(childSessionId, { stamps: [now], suppressed: 0, windowStart: now });
    return { allowed: true, summaryOwed: bucket ? bucket.suppressed : 0 };
  }
  // Drop stamps that have fallen out of the rolling window.
  bucket.stamps = bucket.stamps.filter((stamp) => now - stamp < WINDOW_MS);
  if (bucket.stamps.length < maxPerMinute) {
    bucket.stamps.push(now);
    return { allowed: true, summaryOwed: 0 };
  }
  bucket.suppressed++;
  return { allowed: false, summaryOwed: 0 };
}

/** Test/boot seam: drop every per-child bucket. Process-global by design. */
export function clearNoticeBucket(): void {
  buckets.clear();
}
