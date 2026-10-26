// The tool descriptions are the parent agent's only manual. Four clauses are
// load-bearing (issue #37): the stale-transcript trap in the read tools, the
// wait-for-notify steering discipline, and the two-sources trust boundary.
// Each is pinned here so the teaching cannot silently regress.

import {
  TASK_CONTINUE_DESCRIPTION,
  TASK_RESULT_DESCRIPTION,
  TASK_STATUS_DESCRIPTION,
} from "../../dist/shared/voice.js";
import { answerMatches, answerSays, describe, it } from "./support/index.js";

describe("the descriptions a parent reads before it acts", () => {
  it("task_result names the stale-transcript trap — a working child shows no new output", () => {
    answerMatches(
      TASK_RESULT_DESCRIPTION,
      /latest COMPLETED turn/i,
      "the output's own granularity is stated, not implied",
    );
    answerSays(
      TASK_RESULT_DESCRIPTION,
      "working mid-turn",
      "the trap — a mid-turn child frozen in the view — is named",
    );
  });

  it("task_status carries the same trap beside the two-sources boundary", () => {
    answerSays(
      TASK_STATUS_DESCRIPTION,
      "the plugin's own bookkeeping",
      "the store's state is claimed for what it is",
    );
    answerSays(
      TASK_STATUS_DESCRIPTION,
      "host",
      "the host's live word is the other source, named",
    );
  });

  it("task_continue teaches the storm discipline — wait for the notify before steering again", () => {
    answerSays(
      TASK_CONTINUE_DESCRIPTION,
      "wait for the next",
      "one steer, then wait — the hardstand rule, in the manual",
    );
  });
});
