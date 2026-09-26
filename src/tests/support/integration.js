/**
 * The arrangements the integration suites share — boot, scope, and the two ways
 * a case observes the plugin's durable state.
 *
 * These were the preamble of a single 2000-line file, which meant every subject's
 * suite would have had to import the whole file to reach one of them. A boot with
 * a ledger the case wrote is the same arrangement for a needs-input case, a
 * retention-cap case and a redelivery case, so it is one function here rather than
 * three spellings — and `writeLedger` in particular used to be restated with its
 * own filename and version at every site, which is how a reader ends up parsing a
 * document the boot will quietly ignore.
 */

import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { setupHarness, sleep, tmpProjectDir, withTempFile, tmpFilePath } from "./harness.js";
import { events } from "./mock-host.js";
import { resolveTaskLedgerPath } from "../../../dist/shared/session-lifecycle.js";

/**
 * The durable reader's input, written as given. The file name and the version
 * are the reader's contract, not a case's business — and four cases were each
 * spelling out all three, which is four chances to write a document the boot
 * quietly ignores.
 */
export const writeLedger = (directory, document) =>
  writeFileSync(resolveTaskLedgerPath(directory), JSON.stringify({ version: 3, ...document }));

/**
 * A plugin booted on a project whose durable state is a ledger the case wrote.
 * Every restart case needs the same three things — a directory the plugin will
 * read at boot, records in it dated against one clock, and the plugin itself —
 * and each was assembling them by hand.
 *
 * The plugin is BOOTED when this is called, so a case whose boot depends on an
 * environment variable must wrap the call rather than sit outside it — a
 * variable read at boot is fixed for the life of the process, and a fixture that
 * looked like it could be sequenced around that is a fixture that cannot.
 */
export const bootOn = async (seed, { hooks = {} } = {}) => {
  const directory = tmpProjectDir();
  writeLedger(directory, seed(Date.now()));
  return { directory, ...(await setupHarness({ hooks, directory })) };
};

/**
 * Settle the child and let its durable write land. The settlement writes the
 * ledger synchronously — the pause is for CI, not the contract — so it is said
 * once here, where a reader can see which of the two it is, instead of as a
 * private `sleep(30)` that reads like eventual consistency.
 */
export const settledOnDisk = async (h, id, status) => {
  await h.settle(id, status);
  await sleep(30);
};

/**
 * A harness for a case with no dispatched child. The subject there is the host's
 * event stream or a tool called directly, so the boot options ARE the whole
 * arrangement — and spelled inline it was the most repeated line in the suite,
 * where a case that copied it could quietly carry hooks the case beside it did
 * not have. A question no reader can answer by looking at the test.
 */
export const eventHarness = (hooks = {}) => setupHarness({ hooks });

/** A harness that admits exactly one child, so the second dispatch is the case. */
export const withSingleSlot = () => setupHarness({ options: { maxConcurrent: 1 } });

/**
 * One dispatch's tool input, for the raw `dynamic_task.execute` calls that
 * cannot go through a spawn helper. The argument shape IS the tool's contract,
 * and it was spelled out by hand at every one of these sites — so a required
 * field could be missing from the very case testing its neighbour.
 */
export const dispatchArgs = (description, over = {}) => ({ description, subagent_type: "explore", prompt: "hi", ...over });

/**
 * A harness whose prompt to exactly ONE session fails, and nothing else does.
 *
 * Naming the arrangement matters because the two failure modes are the whole
 * difference between a settlement that lands and one that is deferred: a
 * rejection is the transport saying no, a synchronous throw is the call blowing
 * up before it returns. Two cases were each spelling out the hook set inline,
 * which is a line where the session under test can be quietly wrong.
 */
const harnessWithFailingPrompt = (hook, sessionId) => setupHarness({ hooks: { [hook]: new Set([sessionId]) } });

/** A harness that REJECTS the prompt to one session. */
export const harnessRejectingPrompt = (sessionId) => harnessWithFailingPrompt("promptFailIds", sessionId);

/** As `harnessRejectingPrompt`, for a prompt that throws before it returns. */
export const harnessThrowingPrompt = (sessionId) => harnessWithFailingPrompt("promptSyncThrowIds", sessionId);

/**
 * The host's status channel, delivered as an event. The channel and the lifecycle
 * stream are two of the three ways a session's state reaches the plugin, and a
 * case that means "the host says this session is busy" says it here rather than
 * assembling the event inline — the two spellings had begun to drift on which
 * session the word was for.
 */
export const hostStatus = (h, id, type = "idle") => h.fireEvent(events.status(id, type));

/**
 * Wait for an observable, and fail rather than hang. The bound is the only clock
 * in a poll: boot does not block on what it redelivers, so a case that has to
 * see a later effect waits for the effect — never sleeps in its place — and the
 * bound is what turns "never arrives" into a failure.
 */
export async function waitFor(predicate, what) {
  for (let tries = 0; tries < 300; tries++) {
    if (predicate()) return;
    await sleep(1);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A scratch file in the OS temp dir, cleaned up including the `.tmp` sidecar. */
export const inTempFile = (fn) => withTempFile(tmpFilePath("dt-integration"), fn);
