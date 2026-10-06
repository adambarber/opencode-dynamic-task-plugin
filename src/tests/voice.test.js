/**
 * voice.ts — the words the plugin hands the operator.
 *
 * The steer description is the only prose in the plugin that is read BEFORE
 * anything happens, so the two facts it must warn about are pinned here: a
 * mid-steer settles, and a stalled child stays stalled. A description that omits
 * either is a user about to be surprised by the plugin's own design.
 */

//jscpd:ignore-start
import { TASK_CONTINUE_DESCRIPTION, parentUndelivered } from "../../dist/shared/voice.js";
import { assert, describe, it } from "./support/runner.js";

//jscpd:ignore-end
describe("operator voice: continue description", () => {
  it("warns that mid-steer settles and stalls are possible", () => {
    assert.match(TASK_CONTINUE_DESCRIPTION, /mid-steer/);
    assert.match(TASK_CONTINUE_DESCRIPTION, /stalled/);
  });
});

describe("operator voice: the child's undelivered notice", () => {
  it("reports the count the record actually carries", () => {
    // The count used to be the literal 2 in a sentence, so a redelivery that
    // arrived carrying five earlier attempts produced a record reading 7 and a
    // child told to believe 2. The number a child repeats to its parent is the
    // number the gate wrote down; deriving it here is the only way they agree.
    assert.match(parentUndelivered({ attempts: 7 }), /after 7 attempt\(s\)/);
    assert.match(parentUndelivered({ attempts: 2 }), /after 2 attempt\(s\)/);
  });

  it("a written-off notice is not told to retry", () => {
    // The standing duplicate-order, and now a worse one: "retry task_notify
    // later" on a notice the plugin has already given up on is an order to do
    // something that will never be delivered. Branch is answered here, in the
    // one place that reads an undelivered record, so a call site that later
    // redelivers with a carried count cannot reach for the wrong words.
    const voice = parentUndelivered({ attempts: 3, expired: true });

    assert.match(voice, /given up on after 3 attempt\(s\)/);
    assert.match(voice, /will not be retried/);
    assert.doesNotMatch(voice, /retry task_notify later/);
  });

  it("a missing record does not invent a count", () => {
    // No record means the gate wrote nothing down, which is a different thing
    // from a record reading 0 — so it must not render as though it were one.
    assert.match(parentUndelivered(null), /after 0 attempt\(s\)/);
  });
});
