/**
 * What the plugin's durable state SAYS, after a sequence of store events.
 *
 * This subject exists because two suites were each right about half of it and
 * the gap between them shipped two defects that a green suite did not see.
 *
 * `task-state.test.js` drives the store and reads the store. Its retained-write
 * cases counted CALLS to the change sink rather than reading the argument, so a
 * publish of an EMPTY change array passed them: the call happened, the call did
 * nothing. `session-lifecycle.test.js` exercises `mergeLedgerChange` and
 * `saveTaskLedger`, but over ledgers it composes by hand — no store was ever
 * wired to one. So a change that never reached the file was invisible on both
 * sides of the join.
 *
 * The cases here are the join itself. They install the store's own sinks over a
 * real temp file, wired exactly the way `entry/state.ts` wires them — including
 * its early return on a zero-length payload, which is what turned an empty
 * publish into silence — and then read the file back, and read it back AGAIN the
 * way a restart would. The question asked is the one the plugin exists to
 * answer: after the process dies, what will the next one believe?
 */

import { describe, it, assert } from "./support/runner.js";
import { readFileSync } from "node:fs";
import { createTaskStore, noteLateOutcome, registerActiveTask, reviveRetainedTask, transitionState } from "../../dist/shared/task-state.js";
import { loadTaskLedger, mergeLedgerChange, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { childParams, defaultConfig } from "./support/fixtures.js";
import { tmpLedgerPath, withTempFile } from "./support/harness.js";
import { assertIs, assertNothing } from "./support/assertions.js";

/** The on-disk shape, read raw — what a restart's first read would parse. */
const fileSays = (file) => JSON.parse(readFileSync(file, "utf8"));

/**
 * A store whose change sinks write a real ledger file, wired the way
 * `entry/state.ts` wires them.
 *
 * The `changes.length === 0` return is transcribed from production on purpose.
 * It is the line that made an empty publish a silent one, so a fixture that
 * omitted it would be testing a sink this plugin does not have.
 */
function storeWritingLedger(file) {
  const store = createTaskStore();
  let onDisk = { retained: new Map(), active: new Map(), pending: [] };
  const persist = (changes) => {
    if (changes.length === 0) return;
    onDisk = mergeLedgerChange(onDisk, changes);
    saveTaskLedger(onDisk, file);
  };
  store.onActiveChange = persist;
  store.onRetainedChange = persist;
  return store;
}

/** One child registered and settled, so the ledger holds a recorded result. */
function withSettledChild(fn) {
  return withTempFile(tmpLedgerPath(), (file) => {
    const store = storeWritingLedger(file);
    registerActiveTask(store, childParams({ id: "ses_c1", agent: "reviewer" }), defaultConfig);
    transitionState(store, "ses_c1", "completed");
    return fn(file, store);
  });
}

describe("durable ledger — what a restart would believe", () => {
  it("records a late error escalation as error, and a restart reads it as error", () =>
    withSettledChild((file, store) => {
      assertIs(fileSays(file).tasks["ses_c1"].state, "completed", "the seeded record starts as a recorded success");

      noteLateOutcome(store, "ses_c1", "error");

      assertIs(fileSays(file).tasks["ses_c1"].state, "error", "the correction is what the file says");
      // The whole point of the durable ledger: a fresh process, reading only the
      // file, must not learn that a failed child succeeded.
      assertIs(loadTaskLedger(file).retained.get("ses_c1")?.state, "error", "and a restart reads the failure, not the success");
    }));

  it("keeps a reclaimed child in one half of the ledger, and a restart does not read it as settled", () =>
    withSettledChild((file, store) => {
      reviveRetainedTask(store, "ses_c1");

      const onDisk = fileSays(file);
      assertIs(onDisk.active["ses_c1"]?.state, "active", "the revived child is running on disk");
      assertNothing(onDisk.tasks["ses_c1"], "and is not ALSO still sitting in settled history");

      const rebooted = loadTaskLedger(file);
      assertIs(rebooted.retained.size, 0, "no stale settled record survived for the boot pass to restore as completed");
      assertIs(rebooted.active.has("ses_c1"), true, "the running child is the one the next process adopts");
    }));
});
