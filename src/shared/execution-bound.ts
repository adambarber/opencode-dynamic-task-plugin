// The bound funnel: the ONLY place in production that owns a wall-clock timer.
//
// Why this exists, from the field. A child's outcome reaches the parent through
// exactly one path, and that path runs `hydrateLatestOutcome` first to quote the
// child's last words. The read is documented never-throws — and it indeed never
// throws — but it was unbounded, so a read that never settled parked the whole
// notification behind it forever: the state write had already happened, so the
// task read as settled, correct, and reported, while the parent was told
// nothing at all. No record, no log, no failure to retry. The only survivor was
// a later event that happened to take a different branch.
//
// A bound converts an unbounded wait into a bounded, *reported* one: the caller
// gets a value on time and knows the value is degraded. That is the whole
// contract — never "the read might be slow", always "the caller is told".
//
// One timer, one owner, one place. `safety-invariants` fails any other
// timer-shaped call in src/**, so a new wait cannot enter anywhere else.

export type Bounded<T> = { value: T; timedOut: boolean };

/**
 * Run `work` with a deadline. Resolves with whatever the caller supplies for
 * the timeout case, flagged so the caller can render the degradation instead of
 * silently reporting a thinner answer as a whole one.
 *
 * The timer is always cleared, so a fast work() leaves nothing pending, and
 * `work`'s own rejection is the caller's to handle — this bounds the WAIT, it
 * does not swallow failures.
 *
 * `work` may be sync or async. A client whose method answers immediately is
 * ordinary, not exceptional, and a bound that demanded a promise would turn
 * that answer into a TypeError — the failure would surface as a retry, a
 * latency, and a wrong record, all of which blame the wrong thing.
 */
export function withBound<T>(
  ms: number,
  work: () => T | Promise<T>,
  onTimeout: () => T,
): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ value: onTimeout(), timedOut: true }), ms);
    Promise.resolve().then(work).then(
      (value) => {
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// A transcript read is one call to a local server. Generous enough to survive a
// loaded machine, far short of the minutes a parent waits before assuming its
// child is stuck.
export const READ_BOUND_MS = 5_000;

// A parent-directed write. Short on purpose. The host accepts a prompt to a
// session that is mid-turn and holds the request until that turn ends — proven
// in the field, where a completion notification sat on the wire for twenty
// minutes and arrived the moment the parent's turn finished. A parent works for
// minutes at a stretch, so "busy" is the ordinary case and must not read as
// "failed": the bound exists to hand the caller an answer NOW, not to give up.
export const PARENT_WRITE_BOUND_MS = 2_000;

// Deadlines named per KIND, not per call site: a new read or write that must not
// outlive its caller says which bound it wants instead of inventing a number.
export const READ_BOUNDS: { transcript: number } = { transcript: READ_BOUND_MS };
export const WRITE_BOUNDS: { parentPrompt: number } = { parentPrompt: PARENT_WRITE_BOUND_MS };

/**
 * Test seam: shrink every bound for the duration of a test, and get the restore
 * back. The timer is still real and still fires — only the patience changes.
 *
 * The alternative is a suite that burns two seconds of wall clock per deadline
 * it wants to observe, which is not a test of the code, it is a test of the
 * runner. Nothing in production calls this, and the mechanism stays where it
 * was: a test may shorten a deadline, never substitute for one.
 */
export function shrinkBoundsForTesting(ms: number): () => void {
  const read = READ_BOUNDS.transcript;
  const write = WRITE_BOUNDS.parentPrompt;
  READ_BOUNDS.transcript = ms;
  WRITE_BOUNDS.parentPrompt = ms;
  return () => {
    READ_BOUNDS.transcript = read;
    WRITE_BOUNDS.parentPrompt = write;
  };
}
