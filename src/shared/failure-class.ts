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
 * the substring that swept in the fatal ones.
 */
const PROVIDER_FRAGMENTS = ["rate limit", "overload", "temporar"];

/**
 * Classify a settlement. The VERDICT is an input, not a detail: a child that
 * finished carries no failure class even if it left an error string behind, and
 * a child that declared it was blocked is asking a question rather than
 * reporting a fault.
 */
export function classifyFailure(verdict: TaskState, detail: unknown): FailureClass {
  if (verdict !== TaskState.Error) return FailureClass.None;
  if (typeof detail !== "string" || !detail.trim()) return FailureClass.Structural;
  const lowered = detail.toLowerCase();
  const transient =
    TRANSPORT_FRAGMENTS.some((fragment) => lowered.includes(fragment)) ||
    PROVIDER_FRAGMENTS.some((fragment) => lowered.includes(fragment)) ||
    PROVIDER_STATUS.some((pattern) => pattern.test(lowered));
  return transient ? FailureClass.Transient : FailureClass.Structural;
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
 */
export function failureNote(failureClass: FailureClass): string {
  if (failureClass === FailureClass.Transient) {
    return "Failure class: transient — a network or provider blip, not the work. "
      + "Nothing here to investigate; the child resumes from where it stopped.";
  }
  if (failureClass === FailureClass.Structural) {
    return "Failure class: structural — the work failed, not the connection. "
      + "This one is a real failure and needs a decision.";
  }
  return "";
}
