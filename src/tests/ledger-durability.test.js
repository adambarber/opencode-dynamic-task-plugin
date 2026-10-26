/**
 * The JOIN: a task store's change sinks, wired the way `entry/state.ts` wires them,
 * reaching the host's durable table — and then read back the way a restart would.
 *
 * This subject exists because two suites were each right about half of it and the gap
 * shipped two defects a green suite did not see. `task-state.test.js` drives the store
 * and reads the store; `ledger-storage.test.js` exercises the durable reader and its
 * writer over records handed to it directly. Neither answers the only question the
 * ledger exists for: after the process dies, what will the next one believe? A change
 * that reached the store and never reached durable state was invisible on both sides
 * of the join — and that is where the file era's worst failure lived, because the
 * whole-file rewrite meant a change could be composed correctly and still lost.
 *
 * The wiring lives in `durable.durableTask`, transcribed from `entry/state.ts`: a
 * fixture that wired it differently would be testing a join this plugin does not have.
 */

import assert from "node:assert/strict";
import { FailureClass } from "../../dist/shared/failure-class.js";
import { ledgerPrefixes } from "../../dist/shared/ledger-storage.js";
import { TaskState } from "../../dist/shared/task-records.js";
import { recordSettledOutcome, registerActiveTask, reviveRetainedTask, transitionState } from "../../dist/shared/task-state.js";
import { childParams, defaultConfig, describe, durable, it, ledgerSays, WORLD_DIRECTORY } from "./support/index.js";

/**
 * One child registered and settled to `failureClass`, so the durable table holds a
 * recorded result that a restart has to read back. One builder, so a case states its
 * difference: written out, the register + settle preamble repeats in every case and
 * the duplication gate is right to call that a clone.
 */
const afterOneSettledChild = async (failureClass) => {
  const settled = await durable.durableTask(async (world, store) => {
    registerActiveTask(store, childParams({ agent: "reviewer", id: "ses_c1" }), defaultConfig);
    transitionState(store, "ses_c1", "completed");
    await world.settle(store);
    if (failureClass) {
      recordSettledOutcome(store, "ses_c1", "error", failureClass);
      await world.settle(store);
    }
  });
  return settled;
};

/** What a restart would believe: the reader alone, claiming nothing about this process. */
async function assertRestartBelieves(world, [field, value], why) {
  const restart = await world.read();
  assert.equal(restart.retained.get("ses_c1")?.[field], value, why);
  return restart;
}

/**
 * The claim most of this suite exists to make, in one place: durable state says it, AND
 * the next process — reading only what the host holds — says it too. Spelled per case
 * the two halves drifted apart, and the duplication gate was right that they are one
 * claim written twice; a case that asserted only the first half proved this process
 * remembered something, which is not what the ledger is for.
 */
async function assertDurableAndReadBack(world, [field, value], why) {
  assert.equal(ledgerSays(world.kv, WORLD_DIRECTORY).tasks.ses_c1[field], value, `durable state — ${why}`);
  return assertRestartBelieves(world, [field, value], `a restart reads it back — ${why}`);
}

/**
 * A settled child whose class the next process MUST read, because a restart that reads
 * `error` with no class believes a structural failure and prints no reason.
 */
async function classRidesCorrection() {
  const { world } = await afterOneSettledChild(FailureClass.Transient);
  await assertDurableAndReadBack(world, ["failureClass", "transient"], "the class rides the correction, and survives");
}

/**
 * A settled child carrying a word this build cannot speak — written by hand, because no
 * writer in this plugin produces it; a merge or a future build's vocabulary does.
 */
async function withAnUnknownClassWord() {
  const { world } = await afterOneSettledChild(FailureClass.Structural);
  renameToUnknownWord(world.kv);
  assert.equal(ledgerSays(world.kv, WORLD_DIRECTORY).tasks.ses_c1.failureClass, "flaky", "the word is in durable state, or the case proves nothing");
  return world;
}

/** A settled child carrying `failureClass`, and the claim that it survives a restart. */
async function thatClassSurvives(failureClass) {
  const { world } = await afterOneSettledChild(failureClass);
  await assertDurableAndReadBack(world, ["failureClass", failureClass], `a ${failureClass} child stays itself`);
}

/** Rewrites the settled class to a word this build does not speak. */
const renameToUnknownWord = (kv) => {
  const [key, value] = [...kv].find(([row]) => row.startsWith(`${ledgerPrefixes(WORLD_DIRECTORY).retained}/`));
  const edited = JSON.parse(value);
  edited.failureClass = "flaky";
  kv.set(key, JSON.stringify(edited));
};

describe("durable ledger — what a restart would believe", () => {
  it("records a late error escalation as error, and a restart reads it as error", async () => {
    const { world, store } = await afterOneSettledChild();
    assert.equal(ledgerSays(world.kv, WORLD_DIRECTORY).tasks.ses_c1.state, "completed", "the seeded record starts as a recorded success");

    recordSettledOutcome(store, "ses_c1", "error");
    await world.settle(store);

    // The whole point of durable state: a fresh process, reading only what the host
    // holds, must not learn that a failed child succeeded.
    await assertDurableAndReadBack(world, ["state", "error"], "a late escalation is a failure, not a success");
  });

  it("publishes nothing for an empty change, so a no-op cannot be heard as a write", async () => {
    const { world, store } = await afterOneSettledChild();
    const before = world.client.storageWriteKeys();

    store.onActiveChange([]);
    store.onRetainedChange([]);
    await world.settle(store);

    assert.deepEqual(world.client.storageWriteKeys(), before, "an empty publish must reach the host as nothing at all");
  });

  it("the failure class rides the SAME publish as the correction, and survives a restart", () => classRidesCorrection());

  // A class this build does not speak is DROPPED, and one it does is RESTORED —
  // table-driven off the enum itself, so adding a fourth class is a red build rather
  // than a field that quietly stops surviving.
  for (const failureClass of Object.values(FailureClass)) {
    it(`durable state carrying "${failureClass}" restores that class, not a neighbour`, () =>
      thatClassSurvives(failureClass));
  }

  it("a class word this build does not speak is DROPPED, not guessed", async () => {
    // The failure mode of guessing wrong is a structural failure announced as a blip:
    // a person told the work is fine when it is not.
    await assertRestartBelieves(await withAnUnknownClassWord(), ["failureClass", undefined], "a word we cannot speak is not a class");
  });

  it("never reads a child as settled while durable state also says it is running", async () => {
    const { world, store } = await afterOneSettledChild();
    reviveRetainedTask(store, "ses_c1");
    await world.settle(store);

    const held = ledgerSays(world.kv, WORLD_DIRECTORY);
    assert.equal(held.active.ses_c1?.state, TaskState.Active, "the revived child is running");
    assert.equal(held.tasks.ses_c1, undefined, "and is not ALSO still sitting in settled history");

    const read = await world.read();
    assert.equal(read.retained.size, 0, "no stale settled record survived for the boot pass to restore as completed");
    assert.equal(read.active.has("ses_c1"), true, "the running child is the one the next process adopts");

    // Second witness, and the reason the reader had to change rather than the writer
    // alone: the contradiction written BY HAND. The point is not that this plugin wrote
    // it — it stopped doing so in the fix above — but that any writer may: a regression,
    // a merge, an edit, a bug fixed in one place and reintroduced in another. The reader
    // is the only place that cannot regress, because it is where the question is asked.
    world.kv.set(`${ledgerPrefixes(WORLD_DIRECTORY).retained}/ses_c1`, JSON.stringify({ ...held.active.ses_c1, retainedAt: 1, state: TaskState.Completed }));

    const rebuilt = await world.read();
    assert.equal(rebuilt.retained.has("ses_c1"), false, "the settled half does not survive state that also calls the child running");
    assert.equal(rebuilt.active.get("ses_c1")?.state, TaskState.Active, "and the running half is what the next process adopts");
    assert.equal(rebuilt.dropped > 0, true, "the contradiction is reported, not silently resolved");
  });
});
