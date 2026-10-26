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

/**
 * How far a request got before the bound gave up on it.
 *
 * This is the fact the `Bounded` timeout arm used to throw away. `withBound` dispatches
 * its work BEFORE it arms the deadline, so a bound that fires has already handed the
 * request over — `Sent` is the ordinary case, not the exception. `NotSent` is
 * `expired` alone, where no host was there to send to.
 *
 * The distinction decides what a caller may do next and it is not derivable from the
 * value a site chose as its degraded answer. A MUTATION that was sent may have landed;
 * retrying it blind double-applies it. The same mutation not sent is free to retry. Both
 * arrive as `timedOut: true`, so a site that does not ask has to guess — and the guess
 * that reads as failure is what invites the double execution.
 */
export const enum ExpiryPhase {
  /** The work never ran. Nothing happened, and a retry is free. */
  NotSent = "not-sent",
  /** The work was handed over. Whether it landed is exactly what is not known. */
  Sent = "sent",
}

/**
 * The answer, or the bound's report that there was none. DISCRIMINATED, because the
 * two are different shapes and a `timedOut: boolean` field lets a caller read
 * `value.data` after a timeout it has already handled — which is how a `() => null`
 * timeout arm once typed itself as `T` and forced a re-check of a value that could
 * not be null.
 *
 * The timeout arm carries `phase` because `finished` alone does not say it in types:
 * both arms hold a promise, and only the reading of a never-settling one is evidence.
 */
export type Bounded<T, D = T> =
  | { finished: Promise<T>; value: T; timedOut: false }
  | { finished: Promise<T>; phase: ExpiryPhase; value: D; timedOut: true };

/** Nothing was started, so nothing will finish: the one promise that says so. */
const NOT_STARTED: Promise<never> = new Promise<never>(() => {});

/**
 * A deadline beat a call, as a typed failure rather than a sentence.
 *
 * Four sites each rolled their own `new Error("... unanswered after ${N}ms")`, which
 * put the one fact a caller most needs — whether the request was sent — into the
 * middle of a message. Classifying that meant matching a REGEX against English, so
 * `classifyDenialFailure` could only ask whether the text looked like a missing ask and
 * had no way to ask what had actually happened.
 *
 * The phase is a field, so it is read rather than guessed, and the message is derived
 * from it: the two phases are different facts and now read differently.
 */
export class ExpiryError extends Error {
  override readonly name = "ExpiryError";
  readonly phase: ExpiryPhase;
  /** How long the caller was willing to wait before this became an expiry. */
  readonly ms: number;
  /** What was being waited on, named so the message and the log agree. */
  readonly subject: string;
  constructor(ms: number, phase: ExpiryPhase, subject: string) {
    super(`${subject} ${phase === ExpiryPhase.Sent ? "unanswered" : "never sent"} after ${ms}ms`);
    this.ms = ms;
    this.phase = phase;
    this.subject = subject;
  }
}

/**
 * The one construction of a bound's timeout report, so an absent host and a host that
 * did not answer in time cannot drift into two shapes for the same fact.
 *
 * `NotSent` is hardcoded rather than passed: an absent host is the only way to reach
 * this, and a caller able to claim otherwise would be claiming that its own
 * construction is not this one.
 */
export const expired = <D>(timedOut: D): Bounded<never, D> => ({
  finished: NOT_STARTED,
  phase: ExpiryPhase.NotSent,
  timedOut: true,
  value: timedOut,
});

/**
 * The bound's arguments, named once: the deadline, the work it covers, and the value
 * reported when the deadline wins. `callHost` is this plus a host to hand the work, so
 * it takes the SAME tuple rather than spelling the shape a second time — two spellings
 * of one chokepoint's contract is how they drift.
 */
export type BoundArgs<C, T, D> = [ms: number, work: (client: C) => Promise<T>, timedOut: D];

/**
 * Run `work` with a deadline. Resolves with whatever the caller supplies for
 * the timeout case, flagged so the caller can render the degradation instead of
 * silently reporting a thinner answer as a whole one.
 *
 * The timer is always cleared, so a fast work() leaves nothing pending, and
 * `work`'s own rejection is the caller's to handle — this bounds the WAIT, it
 * does not swallow failures.
 *
 * `work` may answer immediately — a client that returns synchronously is ordinary,
 * not exceptional — and it is still typed as returning a promise, because the thing a
 * bound must refuse is a body that FINISHED while the call it wrapped is still open.
 *
 * `timedOut` is the VALUE a bound reports, not a thunk producing one. That is the
 * whole point of the shape: a thunk runs inside the timer callback, where a throw
 * escapes as an uncaught exception and leaves this promise pending forever — the one
 * outcome a bound exists to make impossible. A caller that wants a timeout to travel a
 * throw path throws it AFTER the await, where the failure can be caught.
 *
 * `work` must return a promise, so a synchronous read cannot be passed where a call
 * belongs: a bound around `hostLogCall(client)` looks identical to a bound around
 * `await log(...)` at the call site and is unbounded in fact.
 */
export function withBound<T, D>(
  ms: number,
  work: () => Promise<T>,
  timedOut: D,
): Promise<Bounded<T, D>> {
  return new Promise<Bounded<T, D>>((resolve, reject) => {
    // The operation is held here because a bound does NOT cancel it: the deadline
    // decides when to REPORT, and a caller that orders writes has to be able to
    // wait on the work itself rather than on the report it received too early.
    //
    // Dispatched BEFORE the timer is armed, which is what makes `Sent` the phase this
    // arm reports: there is no arrangement in which the deadline fires and the work
    // has not been handed over. `ExpiryPhase.NotSent` is `expired` alone.
    const finished = Promise.resolve().then(work);
    const timer = setTimeout(() => resolve({ finished, phase: ExpiryPhase.Sent, timedOut: true, value: timedOut }), ms);
    finished.then(
      (value) => {
        clearTimeout(timer);
        resolve({ finished, timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A wall-clock sleep, as the bound funnels own it: a `withBound` whose work never
 * finishes, so the ONLY way out is the deadline — and the deadline arm's value is
 * undefined, because a sleep has no result to report. The caller waits exactly `ms`
 * and cannot overrun: the same invariant `withBound` gives every other wait, applied
 * to the one wait whose whole body IS time. This is the SECOND sanctioned timer in
 * this file (withBound's own deadline is the first), and the gate pins that count.
 */
export function boundedSleep(ms: number): Promise<void> {
  return withBound(ms, () => new Promise<void>(() => {}), undefined).then(() => undefined);
}

// A transcript read is one call to a local server. Generous enough to survive a
// loaded machine, far short of the minutes a parent waits before assuming its
// child is stuck.
const READ_BOUND_MS = 5_000;

// A parent-directed write. Short on purpose. The host accepts a prompt to a
// session that is mid-turn and holds the request until that turn ends — proven
// in the field, where a completion notification sat on the wire for twenty
// minutes and arrived the moment the parent's turn finished. A parent works for
// minutes at a stretch, so "busy" is the ordinary case and must not read as
// "failed": the bound exists to hand the caller an answer NOW, not to give up.
const PARENT_WRITE_BOUND_MS = 2_000;

// A stop. Short for the same reason and by the same argument as the parent
// write, and for one more: this is the one call the plugin makes to work it may
// not own, so a server that never answers it must not be able to keep the caller
// holding the tool open. An unbounded abort was not a slow report — it was a
// `task_interrupt` that never returned, and a `task_continue` that never fired
// its replacement prompt, with the steer claim already armed. The child then sat
// `active` waiting for a replacement turn that could not start, which is a
// stranded child with a live process and no way to see why.
const ABORT_BOUND_MS = 2_000;

// Durable state. The host keeps plugin records in its own SQLite database, so the
// write is local but not free: it contends for the same write lock as the host's
// event traffic. Bound it like a parent write and REFUSE on timeout — a refused
// write is loud and retried by the next mutation; a hung tool call is neither.
const STORAGE_WRITE_BOUND_MS = 2_000;

// Deadlines named per KIND, not per call site: a new read or write that must not
// outlive its caller says which bound it wants instead of inventing a number.
// The agent list is a read on the same terms as a transcript: one call to a local
// server, whose absence must cost the caller a THINNER answer, never a hung turn.
// It had no bound at all, and the retry loop beside it only catches throws — a host
// that accepts the call and never answers left every dispatch waiting on the list.
// `presence` is the existence read — one `session.get` against the same local
// server, same bound, and a key of its own because it is a distinct call with a
// distinct failure mode: it is the ONLY read whose answer can be a refusal, and
// reusing the transcript's bound would let a slow transcript be mistaken for an
// unanswered existence question.
export const READ_BOUNDS: { transcript: number; agents: number; presence: number; storage: number } = {
  agents: READ_BOUND_MS,
  presence: READ_BOUND_MS,
  storage: READ_BOUND_MS,
  transcript: READ_BOUND_MS,
};
// Creating the child's session. The same bound and the same argument as the abort:
// the create is awaited by the CALLER'S turn, so a host that accepts it and never
// answers does not return a late session, it returns nothing at all, and the
// parent's turn stays open for as long as the server feels like holding it.
const CREATE_BOUND_MS = 2_000;

// Answering a child's question. The caller AWAITS the answer and decides the
// child's fate from it, so a reply the host accepts and never returns is not a slow
// answer — it is a settlement that never settles, with the child's turn open.
const QUESTION_BOUND_MS = 2_000;

// v2 has no host log sink (`app.log` is gone), so there is no bounded log WRITE:
// `safeLog` is local file I/O now and needs no deadline against the host. The old
// bound outlived the call it bounded and still described the hang it used to cause.
export const WRITE_BOUNDS: {
  parentPrompt: number;
  abort: number;
  create: number;
  question: number;
  storage: number;
} = {
  abort: ABORT_BOUND_MS,
  create: CREATE_BOUND_MS,
  parentPrompt: PARENT_WRITE_BOUND_MS,
  question: QUESTION_BOUND_MS,
  storage: STORAGE_WRITE_BOUND_MS,
};

/**
 * Test seam: shrink every bound for the duration of a test, and get the restore
 * back. The timer is still real and still fires — only the patience changes.
 *
 * The alternative is a suite that burns two seconds of wall clock per deadline
 * it wants to observe, which is not a test of the code, it is a test of the
 * runner. Nothing in production calls this, and the mechanism stays where it
 * was: a test may shorten a deadline, never substitute for one. Table-driven so
 * a NEW bound is added to the table, not to three hand-written statement groups
 * that can drift apart.
 */
/** The read bounds whose patience a test may shrink, in one place. */
const READ_KEYS = ["transcript", "agents", "presence", "storage"] as const;
const WRITE_KEYS = ["parentPrompt", "abort", "create", "question", "storage"] as const;

export function shrinkBoundsForTesting(ms: number): () => void {
  const readSaved = READ_KEYS.map((key) => [key, READ_BOUNDS[key]] as const);
  const writeSaved = WRITE_KEYS.map((key) => [key, WRITE_BOUNDS[key]] as const);
  for (const key of READ_KEYS) READ_BOUNDS[key] = ms;
  for (const key of WRITE_KEYS) WRITE_BOUNDS[key] = ms;
  return () => {
    for (const [key, was] of readSaved) READ_BOUNDS[key] = was;
    for (const [key, was] of writeSaved) WRITE_BOUNDS[key] = was;
  };
}
