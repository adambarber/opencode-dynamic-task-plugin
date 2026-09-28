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
import { writeFileSync } from "node:fs";
import { createTaskStore, recordSettledOutcome, registerActiveTask, reviveRetainedTask, transitionState } from "../../dist/shared/task-state.js";
import { FailureClass } from "../../dist/shared/failure-class.js";
import { loadTaskLedger, mergeLedgerChange, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { childParams, defaultConfig } from "./support/fixtures.js";
import { tmpLedgerPath, withTempFile } from "./support/harness.js";
import { assertAbsent, assertIs } from "./support/assertions.js";
import { fileSays } from "./support/integration.js";

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

/**
 * The same child, then reclaimed: a settled record replaced by a running one, which
 * is the transition the two cases below both need and neither of them owns.
 */
function withRevivedChild(fn) {
  return withSettledChild((file, store) => {
    reviveRetainedTask(store, "ses_c1");
    return fn(file);
  });
}

describe("durable ledger — what a restart would believe", () => {
  it("records a late error escalation as error, and a restart reads it as error", () =>
    withSettledChild((file, store) => {
      assertIs(fileSays(file).tasks["ses_c1"].state, "completed", "the seeded record starts as a recorded success");

      recordSettledOutcome(store, "ses_c1", "error");

      assertIs(fileSays(file).tasks["ses_c1"].state, "error", "the correction is what the file says");
      // The whole point of the durable ledger: a fresh process, reading only the
      // file, must not learn that a failed child succeeded.
      assertIs(loadTaskLedger(file).retained.get("ses_c1")?.state, "error", "and a restart reads the failure, not the success");
    }));

  // All three class cases are the same ARRANGEMENT — settle to `error` carrying a
  // class, then ask what the next process would believe — and differ only in the
  // class, an optional hand-edit, and what the reader is therefore owed. One
  // builder, so a case states its difference: written out, the `withSettledChild`
  // + `recordSettledOutcome` preamble repeats in every case and the duplication
  // gate is right to call that a clone.
  const restartAfterSettling = (failureClass, tamper) => {
    let believed;
    withSettledChild((file, store) => {
      recordSettledOutcome(store, "ses_c1", "error", failureClass);
      if (tamper) tamper(file);
      believed = { onDisk: fileSays(file).tasks["ses_c1"].failureClass, restart: loadTaskLedger(file).retained.get("ses_c1") };
    });
    return believed;
  };

  it("the failure class rides the SAME publish as the correction, and survives a restart", () => {
    // The class is a durable field on the same record as the state, and it is the
    // fact a parent most needs — so a test that reads it off `task_status` proves
    // only that this process held it. The reader that matters is the next one: a
    // restart that reads `error` with no class believes a structural failure and
    // prints no reason, which is the deafness this file exists to prevent, one
    // field over.
    const read = restartAfterSettling(FailureClass.Transient);

    assertIs(read.onDisk, "transient", "the class is in the same write as the correction");
    assertIs(read.restart?.failureClass, "transient", "and a restart reads WHICH failure it was, not only that it failed");
  });

  // A class this build does not speak is DROPPED, and one it does is RESTORED —
  // table-driven off the enum itself, so adding a fourth class is a red build
  // rather than a field that quietly stops surviving. The alternative is a case
  // written per class, which is a case that has to be remembered to be extended.
  for (const failureClass of Object.values(FailureClass)) {
    it(`a file carrying "${failureClass}" restores that class, not a neighbour`, () => {
      const read = restartAfterSettling(failureClass);

      assertIs(read.restart?.failureClass, failureClass, `a ${failureClass} child stays a ${failureClass} child across a restart`);
    });
  }

  it("a class word this build does not speak is DROPPED, not guessed", () => {
    // Falsification for the two above, in the direction that matters: an
    // unrecognised word must not survive as a class, because the failure mode of
    // guessing wrong is a structural failure announced as a blip — a person told
    // the work is fine when it is not. Written by hand, because no writer in this
    // plugin produces it; a merge or a future build's vocabulary does.
    const read = restartAfterSettling(FailureClass.Structural, (file) => {
      const edited = fileSays(file);
      edited.tasks["ses_c1"].failureClass = "flaky";
      writeFileSync(file, JSON.stringify(edited));
    });

    assertIs(read.onDisk, "flaky", "the word is in the file, or the case proves nothing");
    assertAbsent(read.restart?.failureClass, "a word this build does not speak is not a class");
  });

  it("never reads a child as settled while the file also says it is running", () =>
    withRevivedChild((file) => {
      const onDisk = fileSays(file);
      assertIs(onDisk.active["ses_c1"]?.state, "active", "the revived child is running on disk");
      assertAbsent(onDisk.tasks["ses_c1"], "and is not ALSO still sitting in settled history");

      const written = loadTaskLedger(file);
      assertIs(written.retained.size, 0, "no stale settled record survived for the boot pass to restore as completed");
      assertIs(written.active.has("ses_c1"), true, "the running child is the one the next process adopts");

      // Second witness, and the reason the loader had to change rather than the writer
      // alone: the contradiction written BY HAND. The point is not that this plugin
      // wrote it — it stopped doing so in the fix above — but that any writer may: a
      // regression, a merge, an edit, a bug fixed in one place and reintroduced in
      // another. The reader is the only place that cannot regress, because it is where
      // the question is actually asked.
      const corrupt = fileSays(file);
      corrupt.tasks["ses_c1"] = { ...corrupt.active["ses_c1"], state: "completed", retainedAt: 1 };
      writeFileSync(file, JSON.stringify(corrupt));

      const rebuilt = loadTaskLedger(file);
      assertIs(rebuilt.retained.has("ses_c1"), false, "the settled half does not survive a file that also calls the child running");
      assertIs(rebuilt.active.get("ses_c1")?.state, "active", "and the running half is what the next process adopts");
      assertIs(rebuilt.discarded !== null, true, "the contradiction is reported, not silently resolved");
    }));
});
