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

import { LEDGER_KEYS, LEDGER_PREFIXES } from "../../../dist/shared/ledger-storage.js";
import { owedIdentity } from "../../../dist/shared/notify-queue.js";
import { ASSISTANT_ROLE } from "../../../dist/shared/prompt.js";
import { setupHarness, sleep, tmpProjectDir } from "./harness.js";
import { assert } from "./runner.js";

/**
 * A harness whose children fail every turn with `detail`, and one such child.
 *
 * This arrangement was being built inline in seven cases, and each build was a
 * chance for the transcript shape to drift from the one the host actually sends.
 * The failed turn here carries an `error` and NO `parts` key, because that is
 * what a turn that produced no output looks like — and a fixture that added
 * `parts: []` would pass the reader's guard for the wrong reason, which is how a
 * green suite shipped a 12% false-success rate on aborted children.
 *
 * How the turn is ENDED stays with the case: a settlement test fires the host's
 * error event, a recovery test ends the turn the ordinary way and settles again.
 */
export async function childFailingWith(detail) {
  const h = await setupHarness({
    hooks: { messages: () => [{ info: { error: { data: { message: detail } }, role: ASSISTANT_ROLE } }] },
  });
  const { id } = await h.spawn({ description: `child that dies of: ${detail}` });
  return { h, id };
}

/**
 * The two halves the durable reader knows, and the reader's own key for each. A
 * fixture that spelled these itself would be free to drift from the layout, so the
 * layout is asked for rather than remembered — and the `tasks` name is the file era's
 * word for the settled half, kept only so a case's document still reads like itself.
 */
const HALVES = [
  ["active", LEDGER_KEYS.active],
  ["tasks", LEDGER_KEYS.retained],
];

/**
 * The durable reader's input, written through the reader's own key layout.
 *
 * A `Storage.set` has no `undefined`, so a record goes in as text: the same thing the
 * writer does, which is why a fixture cannot hand the reader a shape production could
 * never have written and call the reader's rejection a bug.
 */
const putLedger = (kv, document) => {
  for (const [half, keyOf] of HALVES) {
    for (const [childSessionId, entry] of Object.entries(document[half] ?? {})) {
      kv.set(keyOf(childSessionId), JSON.stringify(entry));
    }
  }
  for (const notice of document.pending ?? []) {
    kv.set(LEDGER_KEYS.pending(owedIdentity(notice)), JSON.stringify(notice));
  }
  return kv;
};

/** The durable state as it stands, read back under the reader's own keys. */
export const ledgerSays = (kv) => {
  const entries = (prefix) =>
    Object.fromEntries(
      [...kv]
        .filter(([key]) => key.startsWith(`${prefix}/`))
        .map(([key, value]) => [key.slice(prefix.length + 1), JSON.parse(value)]),
    );
  return {
    active: entries(LEDGER_PREFIXES.active),
    pending: [...kv]
      .filter(([key]) => key.startsWith(`${LEDGER_PREFIXES.pending}/`))
      .map(([, value]) => JSON.parse(value)),
    tasks: entries(LEDGER_PREFIXES.retained),
  };
};

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
export const bootOn = async (seed, { hooks = {}, raw = {} } = {}) => {
  const directory = tmpProjectDir();
  const document = seed(Date.now());
  // `raw` is the seam that can put something the WRITER would never write under a key
  // of its own: a torn record, a record from a past this build cannot read. Both are
  // reader questions, and a fixture that could only produce well-formed records could
  // never ask one.
  const storage = (kv) => {
    putLedger(kv, document);
    for (const [key, value] of Object.entries(raw)) kv.set(key, value);
  };
  return { directory, ...(await setupHarness({ directory, hooks, storage })) };
};

/**
 * Settle the child and let its durable write land.
 *
 * The write is now a bounded, ordered, per-key round trip to the host, so "landed" is
 * an event rather than a pause: the chain the store exposes settles only once the
 * write it covers has been answered, and a refusal would still resolve it. So the
 * ledger is polled until it says what the settlement claimed.
 */
export const settledOnDisk = async (h, id, status) => {
  await h.settle(id, status);
  await waitFor(() => h.kv.size > 0, "the settlement's durable write to land");
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
export const dispatchArgs = (description, over = {}) => ({ description, prompt: "hi", subagent_type: "explore", ...over });

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
 *
 * The word is REQUIRED and no longer defaults to idle, because the host cannot say
 * it: it publishes `session.idle` and deletes the key. A case that means "this turn
 * ended" says that instead.
 */

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

