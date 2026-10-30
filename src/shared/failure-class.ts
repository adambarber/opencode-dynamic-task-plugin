/**
 * failure-class.ts — why a child failed, named.
 *
 * The host reports every failed turn the same way: an `error` field on the
 * assistant message, carrying one free-text string. That single string is the
 * whole difference between "the network hiccuped, this child is fine" and "this
 * child's work is broken and somebody has to look at it", and it is the
 * difference the parent most needs made — because a parent who cannot tell the
 * two apart has exactly two options: ignore every failure, or investigate every
 * failure. On a flaky network, that is the difference between a system that
 * keeps working and one that burns a turn root-causing a socket reset.
 *
 * Until this module existed the only place the distinction appeared was a
 * sentence appended to a notification (`resumeHint`), which is prose: not
 * machine-readable, absent from `task_result`/`task_list`/`task_status`, and
 * silently lost the moment a settlement took any other path.
 *
 * ## The conservative rule
 *
 * This classification is not decoration. It arms a revival, which costs a
 * network call and re-opens a child's turn. The two error directions are not
 * symmetric:
 *
 *   - a false **Transient** resurrects work the operator meant to stop, spends a
 *     slot, and can hide a genuinely broken child behind endless retries;
 *   - a false **Structural** costs exactly one extra message to a human.
 *
 * So every ambiguous case resolves Structural. That includes the largest
 * ambiguity of all: a bare abort. The host reports an operator's `task_interrupt`
 * and a dropped connection through the same aborted-turn shape, and a revival
 * that fires on the first is a child that ignores the stop button.
 *
 * A marker must therefore be an affirmative claim about the NETWORK before this
 * will say Transient. Absent a marker, it declines.
 */

import { TaskState } from "./task-state.js";

/** Why a child failed. `None` is not a failure class — it is its absence. */
export enum FailureClass {
  /** The child finished. Nothing to classify, and nothing to investigate. */
  None = "none",
  /** A transport or provider blip that says nothing about the work. */
  Transient = "transient",
  /** The work itself failed. A person, or a deliberate decision, is needed. */
  Structural = "structural",
}

/**
 * Transport-level wording. Substrings, because the host's transport errors are
 * free text assembled by undici/fetch and vary by runtime — these are the
 * spellings that actually appear, not a formal grammar.
 */
const TRANSPORT_FRAGMENTS = [
  // The classifier in prompt.ts already treats these as retryable for a failed
  // WRITE; a failed READ of the same wire fails the same way.
  "econnrefused",
  "etimedout",
  "econnreset",
  "fetch failed",
  "network",
  "timeout",
  "socket hang up",
  "premature close",
  "connection reset",
  "connection closed",
  "connection refused",
  "getaddrinfo",
  "eai_again",
  "epipe",
  "stream error",
  "tls",
];

/**
 * Provider-side HTTP blips, as standalone tokens. The word boundary is load
 * bearing once this decides something: a bare `.includes("500")` reads a token
 * budget ("max tokens 500") as an upstream failure, and a revival loop spends a
 * slot on each one.
 */
const PROVIDER_STATUS = [/\b429\b/, /\b500\b/, /\b502\b/, /\b503\b/];

/**
 * Provider-side wording that names the blip rather than its code.
 *
 * Note what is absent. The previous list carried "unavailable", which was
 * harmless as a hint and catastrophic as a trigger: it is a substring of
 * `Model tried to call unavailable tool 'invalid'`. That is a model that will
 * never call that tool, so every revival of it fails identically and forever.
 * "temporar" covers the honest phrasings ("temporarily unavailable") without
 * the substring that swept in the fatal ones. Model unavailability itself is
 * named below, by MODEL_UNAVAILABLE, under a boundary that cannot match that
 * same sentence.
 */
const PROVIDER_FRAGMENTS = ["rate limit", "overload", "temporar"];

/**
 * The host's word for a provider whose model is down — the #33 outage, which
 * retried through every time. Word boundaries for the same reason
 * PROVIDER_STATUS's are load bearing, and one pattern per spelling because the
 * exception name arrives in CamelCase, where no space exists to match:
 *
 *   - the exception class: SessionRunnerModel.ModelUnavailableError;
 *   - the prose after its colon: "Model unavailable: coda/coda".
 *
 * Neither can reach `Model tried to call unavailable tool` — "model" is
 * followed by " tried", not the space the second pattern needs, and the name
 * is not present at all — so the sweep the old bare "unavailable" caused
 * stays impossible.
 */
const MODEL_UNAVAILABLE = [/\bmodelunavailableerror\b/, /\bmodel unavailable\b/];

/**
 * Classify a settlement. The VERDICT is an input, not a detail: a child that
 * finished carries no failure class even if it left an error string behind, and
 * a child that declared it was blocked is asking a question rather than
 * reporting a fault.
 */
/**
 * The host's own structured verdict, read off the assistant message's error
 * union: `APIError` carries `isRetryable`, and `MessageAbortedError` marks a
 * turn cut mid-stream. Either outranks prose matching.
 */
export interface HostErrorShape {
  name?: string | undefined;
  isRetryable?: boolean | undefined;
}

export function classifyFailure(verdict: TaskState, detail: unknown, host?: { retryAfterMs?: number | undefined; errorShape?: HostErrorShape | undefined }): FailureClass {
  if (verdict !== TaskState.Error) return FailureClass.None;

  // The host's own verdicts are affirmative signals: retryAfterMs and
  // isRetryable mean the host itself considers this error retryable, and the
  // plugin must not override them with a Structural verdict just because the
  // message text doesn't match a known fragment.
  if (typeof host?.retryAfterMs === "number" && host.retryAfterMs > 0) return FailureClass.Transient;
  if (host?.errorShape?.isRetryable === true) return FailureClass.Transient;
  if (host?.errorShape?.isRetryable === false) return FailureClass.Structural;
  if (host?.errorShape?.name === "MessageAbortedError") return FailureClass.Transient;

  if (typeof detail !== "string" || !detail.trim()) return FailureClass.Structural;
  const lowered = detail.toLowerCase();
  const transient =
    TRANSPORT_FRAGMENTS.some((fragment) => lowered.includes(fragment)) ||
    PROVIDER_FRAGMENTS.some((fragment) => lowered.includes(fragment)) ||
    MODEL_UNAVAILABLE.some((pattern) => pattern.test(lowered)) ||
    PROVIDER_STATUS.some((pattern) => pattern.test(lowered));
  return transient ? FailureClass.Transient : FailureClass.Structural;
}

/**
 * Whether a value read off disk is one of the three classes.
 *
 * The durable read is untrusted, so this is a guard and not a cast. It is also the
 * chokepoint the class needed and did not have: `failureClass` was written to the
 * ledger by the settlement and never read back out of it, so the field was durable
 * on disk and absent from every record a restart hydrated — the one field whose
 * whole job is to survive until someone looks at it, and which did not.
 */
export function isFailureClass(value: unknown): value is FailureClass {
  return value === FailureClass.None || value === FailureClass.Transient || value === FailureClass.Structural;
}

/**
 * The parent-facing sentence for a class. Owned HERE, beside the classifier that
 * decides it, so the wording and the decision cannot drift into disagreeing —
 * the previous arrangement put the two in different modules, which is how a hint
 * ends up describing a classification that no longer exists.
 *
 * The `Failure class: <word>` label is the part that is a contract. The rest is
 * for the human and may be reworded. Returns "" for None: a child that finished
 * owes its parent no apology, and a trailing blank section reads as a fault.
 *
 * `resumesSpent` is what makes a transient failure HONEST rather than merely
 * quiet. A transient failure is normally resumed and never mentioned, so the one
 * time a parent hears about one is the time the retries ran out — and "this
 * failed" then understates what happened, because the network tried again and
 * tried again first. A parent who knows the blips are exhausted can decide the
 * outage is not going to clear; a parent told only that it failed will read the
 * message as one unlucky attempt.
 */
export function failureNote(failureClass: FailureClass, resumesSpent = 0): string {
  if (failureClass === FailureClass.Transient) {
    const spent = resumesSpent > 0
      ? ` It had already been resumed ${resumesSpent} time(s) without getting through, so this is a lasting outage rather than one unlucky turn.`
      : "";
    return `Failure class: transient — a network or provider blip, not the work. `
      + `Nothing here to investigate; the child resumes from where it stopped.${  spent}`;
  }
  if (failureClass === FailureClass.Structural) {
    return "Failure class: structural — the work failed, not the connection. "
      + "This one is a real failure and needs a decision.";
  }
  return "";
}
