/**
 * question-handling.ts — a child's question, and the one channel out of it.
 *
 * The host publishes `question.asked`; the gate reads it, decides reply or
 * reject, and settles the question exactly once. Both halves are here because
 * the decision is only correct against the host's real payload: a fixture
 * invented to match the code certifies the code, not the host.
 */

import { describe, it, assert } from "./support/runner.js";
import {
  decideQuestion,
  rejectQuestion,
  replyToQuestion,
} from "../../dist/shared/question-handling.js";
import { opaqueHost } from "./support/opaque-host.js";
import { QUESTION_ASKED, readAskedQuestion } from "../../dist/shared/host-events.js";
import { truncateText } from "../../dist/shared/notify.js";
import { assertAnswer, assertIs, assertNothing } from "./support/assertions.js";

describe("question gate: reply/reject settlement", () => {
  function questionClient(behavior) {
    return opaqueHost({ question: { reply: behavior.reply, reject: behavior.reject } });
  }
  const okClient = () => opaqueHost({ question: { reply: async () => {}, reject: async () => {} } });

  // One hypothesis: what replyToQuestion's outcome IS, given how the transport
  // behaved. Only the "already resolved" throw is absorbed — any other failure
  // is the caller's problem to see, with its message intact. A real failure is
  // reported against the question it failed on, so a log line names the subject.
  const outcomes = [
    ["reply succeeds", { reply: async () => {} }, { succeeded: true }],
    ["reply absorbs already-resolved as success",
      { reply: async () => { throw new Error("already resolved"); } },
      { succeeded: true, reason: "already_resolved" }],
    ["reply reports transport failures",
      { reply: async () => { throw new Error("nope"); } },
      { succeeded: false, reason: "q1: nope" }],
  ];
  for (const [name, transport, expected] of outcomes) {
    it(name, async () => {
      assert.deepStrictEqual(
        await replyToQuestion(questionClient({ ...transport, reject: async () => {} }), "q1", "yes"),
        expected,
      );
    });
  }

  it("reply rejects missing id/answer", async () => {
    assert.strictEqual((await replyToQuestion(okClient(), "", "yes")).succeeded, false);
    assert.strictEqual((await replyToQuestion(okClient(), "q1", "")).succeeded, false);
  });

  // The `question` namespace is a documented premise of the client type, and a
  // premise that is load-bearing at runtime has to be probed. Probed per CALL, not
  // per namespace, and reported as a refusal rather than thrown — which is the whole
  // reason this is here: without it a host that lacks the namespace fails inside an
  // event handler, where nothing can report it.
  it("a host without a question call is refused, naming the call it lacks", async () => {
    // The ways the premise can fail, as one table: a namespace missing a call, and a
    // namespace missing outright. Per CALL and not per client, because a host that
    // gained `reject` without `reply` must still be able to reject.
    const cases = [
      [{ question: { reject: async () => {} } }, replyToQuestion, "question.reply"],
      [{ question: { reply: async () => {} } }, rejectQuestion, "question.reject"],
      [{}, replyToQuestion, "question.reply"],
      [{}, rejectQuestion, "question.reject"],
      [{ session: {} }, replyToQuestion, "question.reply"],
    ];
    for (const [client, call, missing] of cases) {
      assert.deepStrictEqual(
        await call(opaqueHost(client), "q1", "yes"),
        { succeeded: false, reason: `this host's client has no ${missing}` },
        `a client without ${missing} must be a refusal, not a crash`,
      );
    }
  });

  it("reject succeeds and absorbs 409 conflicts", async () => {
    assert.deepStrictEqual(await rejectQuestion(okClient(), "q1"), { succeeded: true });
    const conflicted = opaqueHost({
      question: {
        reply: async () => {},
        reject: async () => { const e = new Error("gone"); e.status = 409; throw e; },
      },
    });
    assert.deepStrictEqual(
      await rejectQuestion(conflicted, "q1"),
      { succeeded: true, reason: "already_resolved" }
    );
  });

  it("reject rejects missing id", async () => {
    assertIs((await rejectQuestion(okClient(), "")).succeeded, false, "a question with no id is never sent");
  });
});

// The host publishes `question.asked` carrying `questions: QuestionInfo[]`,
// each with `options: QuestionOption[]`. The suggestions live on the OPTION as
// its `label` — this gate used to read a top-level `properties.answers`, a
// field that exists only on the reply event, so every live question looked
// answerless and was rejected. These cases read the host's real shape, because
// a fixture invented to match the code certifies the code, not the host.
describe("question handling: the asked payload", () => {
  const asked = (properties) => ({ type: QUESTION_ASKED, properties });
  const info = (text, labels) => ({ question: text, header: "Question", options: labels.map((label) => ({ label })) });

  it("a single-part ask with options yields the first label", () => {
    const read = readAskedQuestion(
      asked({ id: "q1", sessionID: "ses_child", questions: [info("Ship it?", ["yes", "no"])] }),
    );
    assertAnswer(read, { questionId: "q1", sessionId: "ses_child", answer: "yes" }, "the one-part ask, read whole");
  });

  // Answering the first part of a two-part ask retires the question with the
  // child never having seen the second answer: a silent loss as a success.
  it("a multi-part ask yields no answer — one entry per asked question, or none", () => {
    assert.strictEqual(
      readAskedQuestion(asked({ id: "q2", sessionID: "ses_child", questions: [info("A?", ["a1"]), info("B?", ["b1"])] })).answer,
      null,
    );
  });

  it("an ask with no options, an empty option list, or a non-string label yields no answer", () => {
    const noOptions = asked({ id: "q3", sessionID: "ses_child", questions: [info("Ship it?", [])] });
    assertNothing(readAskedQuestion(noOptions).answer, "options with nothing to choose");
    const emptyLabels = asked({ id: "q4", sessionID: "ses_child", questions: [{ question: "?", options: [] }] });
    assertNothing(readAskedQuestion(emptyLabels).answer, "options with no labels");
    const nonString = asked({ id: "q5", sessionID: "ses_child", questions: [{ question: "?", options: [{ label: 7 }] }] });
    assertNothing(readAskedQuestion(nonString).answer, "a label that is not a string");
  });

  it("refuses to read a payload it cannot identify: no id, no session, or no questions key", () => {
    assertNothing(readAskedQuestion(asked({ sessionID: "ses_child", questions: [info("?", ["y"])] })), "an ask with no question id");
    assertNothing(readAskedQuestion(asked({ id: "q6", questions: [info("?", ["y"])] })), "an ask with no session");
    assertNothing(readAskedQuestion(asked({ id: "q7", sessionID: "ses_child" })), "an ask with no questions key");
  });

  // The two answers are not the same. Unidentifiable means the gate cannot tell
  // whose question this is, so it touches nothing and leaves the question open.
  // An empty list still identifies a live child with an unanswerable question,
  // and there the fail-closed act is to REJECT it: passing on it would leave a
  // child stuck on a question that can never be answered.
  it("an EMPTY questions list is a refusal, not an unidentifiable event", () => {
    assert.deepStrictEqual(
      readAskedQuestion(asked({ id: "q8", sessionID: "ses_child", questions: [] })),
      { questionId: "q8", sessionId: "ses_child", answer: null },
    );
  });

  // The plugin reads the event the host published, not an SDK-resolved
  // response: only the client wraps. A gate that accepted both would be
  // guessing which one it is holding, and guessing is the defect class here —
  // the bare read of a wrapped event finds nothing and must say so.
  it("ignores an envelope-wrapped payload, since the host publishes it bare", () => {
    const bare = { id: "q9", sessionID: "ses_child", questions: [info("?", ["y"])] };
    assertNothing(readAskedQuestion({ type: QUESTION_ASKED, data: bare }), "an envelope-wrapped payload where the host publishes it bare");
  });
});

describe("question gate: decideQuestion", () => {
  it("an active child with an answer replies with it", () => {
    assertAnswer(decideQuestion("active", "yes"), { action: "reply", answer: "yes" }, "an active child answers");
  });

  // The only reader of this text is the parent: the host's reject endpoint
  // declares `body?: never`, so it cannot reach the asking session. It used to
  // read as child advice — "call task_notify" — which the parent does not hold,
  // and it led with the diagnosis so the parent's own remedy fell past the
  // status view's 120-char truncation. Hence: the parent's tool, up front.
  it("an active child with nothing to answer is rejected with the PARENT's remedy", () => {
    const decision = decideQuestion("active", null);
    assert.strictEqual(decision.action, "reject");
    assert.ok(decision.reason.startsWith("task_continue"), `leads with what the reader can do. got: ${decision.reason}`);
    assert.ok(!decision.reason.includes("task_notify"), `never points at a child-only tool. got: ${decision.reason}`);
    assert.ok(!/when it resumes/.test(decision.reason), `never tells anyone to wait. got: ${decision.reason}`);
  });

  // The claim line is truncated to 120 chars. A reason that puts its instruction
  // last is a reason the operator never reads in full, which is the defect the
  // composition exists to prevent — asserted against the real formatter.
  it("a rejected reason survives the status view's truncation, remedy intact", () => {
    const reason = decideQuestion("active", null).reason;
    const shown = truncateText(reason, 120);
    assert.match(shown, /task_continue the child with the input it needs/);
  });

  it("a settled child is rejected with settled guidance, answer or not", () => {
    for (const answer of ["yes", null]) {
      const decision = decideQuestion("retained", answer);
      assert.strictEqual(decision.action, "reject");
      assert.ok(decision.reason.includes("settled"));
    }
  });
});
