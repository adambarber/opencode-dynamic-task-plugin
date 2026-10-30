/**
 * failure-class.ts — why a child failed, in a vocabulary the parent can read.
 *
 * This is the distinction the parent needs to decide whether to INVESTIGATE. A
 * transient failure is a fact about the network; a structural one is a fact about
 * the work. Both arrive as the same host error string in the same `error` field,
 * and until they were named here the only difference the parent could see was a
 * sentence appended to a notification — prose, unrecoverable, and absent from
 * every tool that reads the record.
 *
 * The classification is CONSERVATIVE on purpose. It runs a revival when it says
 * Transient, so a false Transient resurrects work the operator meant to stop,
 * while a false Structural only ever costs one extra message. Every ambiguous
 * case therefore resolves Structural.
 */

import { classifyFailure, FailureClass, failureNote } from "../../dist/shared/failure-class.js";
import { TaskState } from "../../dist/shared/task-state.js";
import { assert, describe, it } from "./support/index.js";

const failed = (detail) => classifyFailure(TaskState.Error, detail);

// The assistant message error is a discriminated union {name, data}; APIError
// carries isRetryable — the host's OWN retry verdict, and it outranks prose.
const hostShape = (isRetryable, detail) =>
  classifyFailure(TaskState.Error, detail, { errorShape: { isRetryable, name: "APIError" } });

// One door for "all of these details land on this class". The list cases differ
// only in WHICH words they name, and three hand-rolled loops over three lists is
// three places for the table to drift without a case noticing.
const assertClassOf = (details, expected) => {
  for (const detail of details) assert.strictEqual(failed(detail), expected, detail);
};

describe("classifyFailure: no failure is not a class", () => {
  it("a child that finished is not a failure", () => {
    assert.strictEqual(classifyFailure(TaskState.Completed, ""), FailureClass.None);
  });

  // A child that declared it was blocked is telling the parent what it needs.
  // That is a request, not a fault, and nothing about it is the network's doing.
  it("a declared block is a request, not a failure", () => {
    assert.strictEqual(classifyFailure(TaskState.Blocked, "waiting on a decision"), FailureClass.None);
  });
});

describe("classifyFailure: transient means the network, not the work", () => {
  it("names the transport failures that survive a retry", () => {
    assertClassOf([
      "fetch failed",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "socket hang up",
      "network error",
      "read ECONNRESET",
      "premature close",
      "getaddrinfo EAI_AGAIN",
      "TLS handshake timeout",
    ], FailureClass.Transient);
  });

  it("names the provider-side blips that clear on their own", () => {
    assertClassOf([
      "429 Too Many Requests",
      "rate limit exceeded",
      "overloaded",
      "503 Service Unavailable",
      "500 Internal Server Error",
      "502 Bad Gateway",
      "temporarily unavailable",
    ], FailureClass.Transient);
  });

  // #33's outage, in the host's own words: a provider whose model is down
  // for everyone. Retry works — the field evidence is a child revived three
  // times that made progress each time — so the words naming it belong to
  // the network's class, not the work's. Pinned with the full exception
  // spelling and the bare prose, because both arrive.
  it("names the host's model-unavailability, the outage retries get through", () => {
    assertClassOf([
      "SessionRunnerModel.ModelUnavailableError: Model unavailable: coda/coda",
      "ModelUnavailableError",
      "model unavailable: coda/coda",
    ], FailureClass.Transient);
  });
});

describe("classifyFailure: structural means retrying changes nothing", () => {
  it("does not resume a model that cannot call its own tools", () => {
    // The regression this table is written against: "unavailable" is a substring
    // of this message, and the old fragment list matched it. As a prose hint
    // that was a wrong sentence; driving a revival it is an endless retry of a
    // model that will never call that tool.
    assert.strictEqual(failed("Model tried to call unavailable tool 'invalid'"), FailureClass.Structural);
  });

  it("does not resume a cause the operator has to act on", () => {
    assertClassOf([
      "Provider auth failed: invalid API key",
      "Model not found",
      "context length exceeded",
      "quota exceeded — billing required",
      "permission denied",
    ], FailureClass.Structural);
  });

  it("does not resume bare aborted prose, which cannot tell operator-stop from a dropped stream", () => {
    // An interrupt is the operator saying stop, and the host reports it through
    // the same aborted-turn shape a dropped connection produces. Prose alone
    // cannot tell them apart, and reviving an operator's stop button is a child
    // that ignores the stop — so prose-only aborts stay structural. The SHAPE
    // (name: "MessageAbortedError", read off the message union) can tell them
    // apart, and it is transient — see the structured-verdict suite below.
    assertClassOf(["Aborted", "MessageAbortedError: Aborted"], FailureClass.Structural);
  });
  it("treats retryAfterMs as an affirmative transient signal even without matching prose", () => {
    // The host's own retryAfterMs says this error is retryable. The plugin
    // must not override that with a Structural verdict just because the
    // message text doesn't match a known fragment.
    assert.strictEqual(classifyFailure(TaskState.Error, "unknown provider error", { retryAfterMs: 5000 }), FailureClass.Transient);
    assert.strictEqual(classifyFailure(TaskState.Error, "unknown provider error", { retryAfterMs: 0 }), FailureClass.Structural);
    assert.strictEqual(classifyFailure(TaskState.Error, "unknown provider error"), FailureClass.Structural);
  });

});

describe("classifyFailure: the host's own structured error verdict", () => {
  it("the host's isRetryable flag outranks the message text", () => {
    assert.strictEqual(hostShape(true, "some weird prose"), FailureClass.Transient);
    assert.strictEqual(hostShape(false, "temporarily unavailable"), FailureClass.Structural);
    assert.strictEqual(hostShape(false, ""), FailureClass.Structural);
  });

  it("MessageAbortedError is the interrupted-stream signature: transient", () => {
    assert.strictEqual(classifyFailure(TaskState.Error, "Aborted", { errorShape: { name: "MessageAbortedError" } }), FailureClass.Transient);
  });

  // Empty detail with no shape is NOT enough to resume: an affirmative failure
  // EVENT with no payload is the host's verdict. Only the IDLE empty-turn path
  // (settleOutcome's emptyTurn) reads as the interruption signature.
  it("empty detail with no shape stays structural", () => {
    assert.strictEqual(classifyFailure(TaskState.Error, ""), FailureClass.Structural);
    assert.strictEqual(classifyFailure(TaskState.Error, undefined), FailureClass.Structural);
  });
});

describe("failureNote: the parent is told which kind it is, in the same words", () => {
  it("says nothing when nothing failed", () => {
    assert.strictEqual(failureNote(FailureClass.None), "");
  });

  // The label is the contract. A parent (or a tool reading the transcript)
  // greps for `Failure class:` and gets one of three answers; the prose after
  // the colon is for the human and may change, the label may not. Asserting the
  // extracted labels rather than a regex over the whole note means a reworded
  // sentence cannot quietly change WHICH class the parent was told about.
  it("labels the class so the sentence beside it can be reworded", () => {
    const label = (failureClass) => /^Failure class: (\w+)/.exec(failureNote(failureClass))?.[1];
    assert.deepStrictEqual(
      [FailureClass.Transient, FailureClass.Structural].map(label),
      [FailureClass.Transient, FailureClass.Structural],
    );
  });

  it("tells the parent a transient failure is not theirs to investigate", () => {
    assert.match(failureNote(FailureClass.Transient), /not the work/i);
  });

  // A transient failure is normally resumed and never mentioned, so the one time
  // a parent hears one is the time the retries ran out. "This failed" then
  // understates what happened: the network was tried again, twice, and again.
  it("says the retries were spent, so it reads as an outage not one bad turn", () => {
    assert.match(failureNote(FailureClass.Transient, 2), /already been resumed 2 time/);
    assert.doesNotMatch(failureNote(FailureClass.Transient, 0), /already been resumed/);
  });

  it("tells the parent a structural failure needs them", () => {
    assert.match(failureNote(FailureClass.Structural), /investigate|decision/i);
  });
});
