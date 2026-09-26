/**
 * voice.ts — the words the plugin hands the operator.
 *
 * The steer description is the only prose in the plugin that is read BEFORE
 * anything happens, so the two facts it must warn about are pinned here: a
 * mid-steer settles, and a stalled child stays stalled. A description that omits
 * either is a user about to be surprised by the plugin's own design.
 */

import { describe, it, assert } from "./support/runner.js";
import { TASK_CONTINUE_DESCRIPTION } from "../../dist/shared/voice.js";

describe("operator voice: continue description", () => {
  it("warns that mid-steer settles and stalls are possible", () => {
    assert.match(TASK_CONTINUE_DESCRIPTION, /mid-steer/);
    assert.match(TASK_CONTINUE_DESCRIPTION, /stalled/);
  });
});
