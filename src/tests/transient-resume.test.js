/**
 * transient-resume.test.js — a network blip is not the parent's problem.
 *
 * On a network that drops, children die for reasons that have nothing to do with
 * the work: a socket resets mid-turn, a provider answers 503, a fetch fails. The
 * parent cannot act on any of it — it did not cause it and it cannot fix it — and
 * every such failure it hears about costs a turn in which the parent investigates
 * a network problem as if it were a code problem. That is the failure mode this
 * exists to remove, and the field corpus shows its cost: blocked children whose
 * parent conversations opened on a child that had already been dealt with.
 *
 * So a transient failure is not reported. It is resumed, silently, under a
 * bounded budget, and the parent hears about it only once the budget is spent —
 * at which point silence would be the lie.
 *
 * The turn the child dies on carries NO `parts` key, which is the host's real
 * shape for a turn that produced no output. That is not decoration: it is the
 * same shape that made 51 settled children look like successes, so a fixture
 * that quietly added `parts: []` would be testing a turn the host never sends.
 */

import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { answerMatches, assert, assertNoticeCount, childFailingWith, describe, it, promptsTo, sleep } from "./support/index.js";

/** The prompts sent TO a child, as text. The spawn prompt is always the first. */
const childPrompts = (h, id) => promptsTo(h.client, id).map((p) => p.text ?? "");

/**
 * End the child's turn, then assert how much the parent was told.
 *
 * The count IS what every case in this file is about, so it is asked for here
 * rather than by each case on the line after: four cases spelling "settle, then
 * assert the notice count" is four places the arrangement could drift, and the
 * duplicate-code gate was right to call it duplication rather than style.
 */
const noticesAfterSettle = async (h, id, expected, why, wait = 30) => {
  await h.settle(id);
  await sleep(wait);
  assertNoticeCount(h, expected, why);
  return h.noticeBodies();
};

describe("a transient failure is resumed, not reported", () => {
  it("says nothing to the parent and runs the child again", async () => {
    const { h, id } = await childFailingWith("fetch failed: socket hang up");
    await noticesAfterSettle(h, id, 0, "the parent is told nothing about a network blip");

    const prompts = childPrompts(h, id);
    assert.strictEqual(prompts.length, 2, "the spawn prompt, then the resume");
    assert.match(prompts[1], /Resumed/, "the resume says what it is");
  });

  // A structural failure is the parent's actual problem, and the one thing this
  // feature must never swallow. Pinned at the settlement and not only in the
  // classifier's table, so a change to the SETTLEMENT cannot lose the distinction
  // the classifier still makes correctly.
  it("still reports a failure the parent has to act on", async () => {
    const { h, id } = await childFailingWith("Provider auth failed: invalid API key");
    const notices = await noticesAfterSettle(h, id, 1, "a structural failure is reported");
    answerMatches(notices[0], /Failure class: structural/, "and says which kind it is");
  });

  // The host reports an operator's task_interrupt through the same shape a
  // dropped connection produces. Resuming that would be a child that ignores the
  // stop button, so it is asserted here and not only in the classifier.
  it("never resumes a child the operator stopped", async () => {
    const { h, id } = await childFailingWith("MessageAbortedError: Aborted");
    await noticesAfterSettle(h, id, 1, "an interrupt is reported, not resumed");
    assert.strictEqual(childPrompts(h, id).length, 1, "no resume prompt");
  });
});

describe("the budget is what makes silence honest", () => {
  // Without a bound, an outage resumes forever and the parent is never told —
  // worse than the original defect, because it looks like success. The count is
  // the constant rather than a literal here: what this claims is "silence until
  // it is spent, then the truth", and the value is a tunable, not a fact.
  it("stays silent within the budget and reports the truth at the end", async () => {
    const { TRANSIENT_RESUME_BUDGET } = await import("../../dist/shared/transient-resume.js");
    const { h, id } = await childFailingWith("503 Service Unavailable");

    // ONE child, settled repeatedly. The budget is per child, so a fresh spawn
    // each round would hand every round a fresh budget of zero and prove nothing
    // — the first version of this case did exactly that.
    for (let spent = 0; spent < TRANSIENT_RESUME_BUDGET; spent += 1) {
      await noticesAfterSettle(h, id, 0, `resume ${spent + 1} of ${TRANSIENT_RESUME_BUDGET} stays silent`);
    }

    const notices = await noticesAfterSettle(h, id, 1, "the budget's end is reported", 50);
    answerMatches(notices[0], /transient/, "named as transient, not as broken work");
    answerMatches(
      notices[0],
      new RegExp(`resumed ${TRANSIENT_RESUME_BUDGET} time`),
      "and says the retries were spent, so it reads as an outage rather than one unlucky turn",
    );
  });

  // The resume is a settlement, and settlement is deduplicated per child. A
  // resume that forgot to clear that dedup would silence the child's REAL
  // outcome forever — the one failure this feature must not be able to cause.
  it("the child's real outcome is still delivered after a resume", async () => {
    const { h, id } = await childFailingWith("socket hang up");
    await noticesAfterSettle(h, id, 0, "the blip was silent");

    h.client.setTranscript(id, [{ parts: [{ text: "the real answer", type: "text" }], role: ASSISTANT_ROLE }]);
    await noticesAfterSettle(h, id, 1, "the settlement after a resume is delivered, not deduplicated away", 50);
  });
});
