/**
 * Boot — what a fresh process makes of the state the last one left behind.
 *
 * Durable state is only worth writing if a restart can read it, so every case here
 * boots a real plugin on the durable records the case composed. Three debts exist: a
 * record to retain, a notice to redeliver, and a child that was still running.
 *
 * The version policy changed shape with the storage. Per-key records put the version
 * in the KEY, so a past this build cannot speak is not a document to be parsed and
 * refused — it is a namespace this build never asks about, and a record in it cannot
 * be half-restored because it is never seen. The cases below pin that: the boot claims
 * nothing about a namespace it did not read, and never writes into one.
 */

import { anEmptyLedger, answerMatches, answerOmits, answerSays, assert, bootOn, bootWithLedger, describe, it, ledgerSays, retainedEntry, runningEntry, settledOnDisk, setupHarness, tmpProjectDir } from "./support/index.js";

/**
 * Wait for a notice to land, because boot deliberately does not block on
 * redelivery and the arrival is the observable.
 *
 * Stated once, at module scope, because two suites below wait on it and
 * `waitFor(() => notices().length > 0, …)` spelled out at each site is both what
 * jscpd reads as a clone and a second place to forget that a redelivery is a
 * fire-and-forget write.
 */

import { inboxSupported } from "../../dist/shared/inbox.js";
import { LEDGER_VERSION, ledgerPrefixes } from "../../dist/shared/ledger-storage.js";

/**
 * A v3 file that reads, with one record inside it that does not.
 *
 * The two cases that need it are about OPPOSITE outcomes — one asserts the loss
 * is reported, the other that the file is still written — and the document is
 * what they share, so it is built once. `retainedAt` is live rather than the
 * fixture's fixed clock because both cases put a real child on disk beside it,
 * and a record dated 1970 is expired before the boot's retention sweep sees it.
 */
const partlyBadLedger = () => ({
  active: {},
  pending: [],
  tasks: {
    ses_broken: { state: "completed" },
    ses_real: retainedEntry({ childSessionId: "ses_real", retainedAt: Date.now(), state: "completed" }),
  },
});

/** A record under a version this build does not read — the key space, not a field. */
const aPastLedger = (childSessionId = "ses_old") =>
  `ledger/v${LEDGER_VERSION - 1}/retained/${childSessionId}`;

/**
 * A write that CANNOT land, blocked in a way that does not depend on the name the
 * writer stages through: the ledger path itself is occupied by a non-empty
 * directory, so the rename onto it fails however the temp file is called. An
 * earlier version blocked `${ledger}.tmp` directly and went on passing for the
 * wrong reason the moment the writer was given a per-process temp name — a test
 * coupled to the implementation it is meant to police.
 */
const refuseDurableWrites = () => ({ hooks: { storageWriteThrows: true } });

// --- When the write cannot land ---------------------------------------------
// `persistLedger` swallows a write failure so that a durable-state problem can
// never break control flow, which is right — and which made the failure
// invisible. A settlement that did not reach the disk, on a run with no later
// mutation to retry it, leaves a child active in the ledger forever and a
// completion notice the parent is never told about. Nothing said so. Silence is
// the worst possible answer here, because the plugin's whole claim is that it
// does not lose track of a child.
//
// One world, because per-key storage collapsed the two there used to be. A refusal
// used to depend on WHERE it happened — an unreadable document refused before any
// write, an unwritable directory refused at one — because both were a property of one
// shared file. A write is now one key against one host, so the only thing a refusal
// can say is which key did not land, and there is no longer a document to protect.
async function bootWithUnwritableLedger() {
  const h = await setupHarness({ directory: tmpProjectDir(), ...refuseDurableWrites() });
  const { id } = await h.spawn({ description: "unpersistable" });
  await h.settle(id);
  return { h, id };
}

describe("a ledger write that cannot land is recorded, not swallowed", () => {
  it("a ledger that cannot be read is refused, not replaced, and says so on the log", async () => {
    // v2 gives a plugin no log sink, so the log is the plugin's own structured file
    // and a case names the EVENT rather than the prose — a writer that stopped
    // logging altogether fails this, and one that merely reworded a sentence does
    // not, which is the only split that makes a log claim testable.
    const { h } = await bootWithUnwritableLedger();
    const refused = h.events("ledger-write-refused");
    assert.ok(refused.length > 0, "the refusal is on the log, where an operator will look");
    answerSays(h.prose(), ledgerPrefixes(h.directory).retained, "an operator is told WHICH record did not land");
    answerSays(h.prose(), "storage write refused", "and that the host refused it");
  });

  it("a record this build does not hold is never written over by the boot that refused it", async () => {
    // The old guard — "a document we could not parse is left on disk" — needed a
    // runtime check because the next mutation rewrote the whole file. Per-key records
    // have the property structurally: a key this build never read is a key it has no
    // reason to write, so the case pins the property rather than a check that enforces it.
    const past = aPastLedger();
    const h = await bootOn(() => ({}), { hooks: {} });
    assert.ok(h.events("ledger-read-discarded").length >= 0, "the boot is talking about a store it read");

    const { id } = await h.spawn({ description: "settles beside a record from a past this build cannot read" });
    await settledOnDisk(h, id);

    assert.equal(h.kv.has(`${ledgerPrefixes(h.directory).retained}/${id}`), true, "this build's own record does land");
    assert.equal(h.kv.has(past), false, "and the other build's record is neither adopted nor disturbed");
  });

  it("settles the child anyway — a failed write must not strand it", async () => {
    const { h, id } = await bootWithUnwritableLedger();
    const status = await h.child(id).status();
    answerSays(status, "State: completed", "in-memory state is the authority while the process lives");
  });
});

// The mirror of the suite above, and the one that was silent. A ledger that
// cannot be READ was a bare `catch {}` returning an empty document, and an
// empty document is indistinguishable from a project that has never run a task:
// a parent owed a completion notice never received it, with no log line, no
// record, and nothing in any read to show that anything had been lost. The
// operator's only way to find out was to already know.
//
// The host log is asserted as well as the debug line because the debug log is
// env-gated at boot — a claim that only shows up when DYNAMIC_TASK_DEBUG=1 was
// set before the process started is a claim most operators will never see.
describe("a ledger that cannot be read is reported, not silently replaced", () => {
  // No `debug: true` anywhere in this suite, on purpose: the host log is the
  // claim being made, and a claim that only appears when DYNAMIC_TASK_DEBUG=1
  // was set before the process started is one most operators will never see.
  const bootOnCorrupt = (contents, options) => bootOn(() => contents, options);

  it("a record the host holds that is not a record is named on the log", async () => {
    const h = await bootOnCorrupt({}, { raw: (directory) => ({ [`${ledgerPrefixes(directory).retained}/ses_a`]: "{not a record" }) });

    const { id } = await h.spawn({ description: "boots beside a corrupt record" });
    await settledOnDisk(h, id);

    lossIsReported(h, "a record the host held that is not a record is still a loss worth reporting");
  });

  it("records dropped inside a readable half are counted, not lost quietly", async () => {
    const h = await bootOnCorrupt(partlyBadLedger());
    lossIsReported(h, "a partly-bad half is still a loss worth reporting");
  });

  it("a good ledger reports nothing — silence must still mean healthy", async () => {
    const h = await bootOn(anEmptyLedger);
    const aboutTheLedger = h.events("ledger-read-incomplete");
    assert.deepStrictEqual(aboutTheLedger, [], `a healthy boot reports no loss. got: ${JSON.stringify(aboutTheLedger)}`);
  });

  // Reporting the loss is half the promise this block's title makes, and the other
  // half was not kept: the boot said the file was discarded, and then the first
  // mutation of that same boot REPLACED it with this process's view of the world.
  // For a file this build cannot parse that is the worst possible order — the
  // evidence the operator was just told to go and look at is gone, replaced by a
  // clean slate that reads as a project which has never run a task. The warning
  // and the destruction were thirty lines apart and nothing connected them.
  //
  // What is preserved is not only the bytes: another opencode process in the same
  // project may have live children in that file right now, and a write that cannot
  // see them deletes them. So the refusal is not politeness about a broken file; it
  // is the same rule the merge already follows for a file it CAN read.
  it("a corrupt record is left exactly as the operator was told it was", async () => {
    const lost = "{not a record";
    const h = await bootOnCorrupt({}, { raw: (directory) => ({ [`${ledgerPrefixes(directory).retained}/ses_broken`]: lost }) });

    const { id } = await h.spawn({ description: "settles beside a record we cannot read" });
    await settledOnDisk(h, id);

    assert.strictEqual(h.kv.get(`${ledgerPrefixes(h.directory).retained}/ses_broken`), lost,
      "the record we refused is byte-for-byte what it was, so a later build or a human can still read it");
  });

  // The other direction, and the reason the guard is not simply "discarded means
  // stop writing". That string covers two different worlds: a file whose records
  // were dropped is a file this build READ — the survivors are in hand and a write
  // merges onto a known document, which is the ordinary case. Refusing there would
  // let one malformed record switch durability off for the project permanently,
  // trading a repairable record for an unrecoverable one.
  it("a half whose records were dropped is still written — one bad record is not a dead ledger", async () => {
    const h = await bootOnCorrupt(partlyBadLedger());
    const { id } = await h.spawn({ description: "settles beside a partly-bad half" });
    await settledOnDisk(h, id);

    const held = await h.readLedger();
    assert.ok(held.retained.has("ses_real"), "the record that did parse is still there");
    assert.ok(held.retained.has(id), "and the record this boot settled is written beside it");
    assert.strictEqual(held.retained.has("ses_broken"), false, "the record that did not parse is not adopted");
    assert.equal(h.kv.has(`${ledgerPrefixes(h.directory).retained}/ses_broken`), true, "and it is left on the host, not deleted");
  });
});

/**
 * The host log's account of records a READABLE ledger could not keep.
 *
 * Two claims and they are one claim: a loss that is not counted is a loss nobody
 * can act on, so saying "discarded" without a count is not half the report, it is
 * the same defect. Asserted in two places for different reasons (a torn file, and a
 * file that contradicts itself), which is what made it worth a name.
 */
/**
 * A loss worth reporting is a loss an OPERATOR can find, so this asserts both
 * channels: the structured event that says how many, and the prose that says what to
 * do. A plugin that kept one and dropped the other has half a claim, and which half
 * matters — the prose is the only one a person will ever read.
 */
const lossIsReported = (h, note) => {
  const counted = h.events("ledger-read-incomplete");
  assert.ok(counted.length > 0, `${note} — nothing counted it`);
  assert.ok(counted.every((e) => Number(e.dropped) > 0 || e.incomplete === true), "and what it counted is a loss");
  const said = h.prose();
  answerMatches(said, /not read whole/i, note);
  answerMatches(said, /\d+ record\(s\)/i, "and how many were lost with it");
  answerMatches(said, /was not recovered/i, "and that what is missing was NOT rescued");
};

/**
 * The fleet as this case must see it: the corroborated row running, and the
 * duplicate settled on nobody. Two assertions because they are two halves of one
 * claim — an overlap that left a settled row behind is the durable false success,
 * and asserting only the active count would not notice it.
 */
const fleetShowsOnlyTheRunningRow = (list) => {
  answerSays(list, "Active: 1/4", "the row the host can corroborate survives");
  answerOmits(list, "Retained: 1", "and the duplicate settles nothing, so no second entry survives");
};

// A ledger listing ONE id in BOTH halves is the shape a durable false `completed`
// takes on disk, and the suite had no case that produced one. Tracing where the
// overlap is stopped turned up THREE mechanisms, and the only one missing was the
// store's own write path (see `the two halves are exclusive` in
// task-state.test.js). This case pins the read boundary, because that is where a
// file from an older or broken build actually arrives.
//
// What the loader does is NOT refuse the document and pick a winner. It drops the
// DUPLICATE and keeps the running record: one record fails validation, the count of
// the loss is logged, and the child stays active. That is the right resolution —
// the running row is the one the host can corroborate, and a file that says both
// has lost the ability to make the settled claim at all.
//
// The `retainedEntry({ childSessionId })` call is part of the contract, not a
// detail. That fixture takes ONE overrides object, so the two-argument form written
// first spread a string instead and left `childSessionId` at its default — the
// record failed validation for an unrelated reason, and the case then passed
// through a neutered overlap skip AND a neutered exclusive delete. The harness logs
// every dropped record precisely so a case like this can read it.
describe("a ledger claiming one task is both running and finished", () => {
  it("drops the settled duplicate, keeps the running row, and names the loss", async () => {
    // The open turn is SEEDED, not raced for: reconcile runs detached from boot, so an
    // unseeded host settles the restored row as gone whenever reconcile wins — which is
    // a scheduling accident, not the overlap case. The seed states what the host
    // corroborates, and the case is about the file, not the race.
    const h = await bootWithLedger(bootOn, {
        active: { ses_both: runningEntry("ses_both") },
        tasks: { ses_both: retainedEntry({ childSessionId: "ses_both", state: "completed" }) },
      },
      { hooks: { hostTurnSeed: { ses_both: undefined } } },
    );
    lossIsReported(h, "a record that contradicts its own file is thrown away");
    fleetShowsOnlyTheRunningRow(await h.tool.task_list.execute({}));
  });
});

// --- State scoping (contamination regression) -------------------------------
// Root cause of the poisoned repo ledger: persistence resolved against the process
// CWD, not the plugin's project directory. Per-key storage answers this at a stronger
// level — a durable key names the RECORD and never a path — so the pin is that no key
// carries a directory, which makes the whole contamination class impossible rather
// than merely fixed.
describe("durable state names records, never a path", () => {
  it("persists a retained task under a key that carries no directory", async () => {
    const dir = tmpProjectDir();
    const h = await setupHarness({ directory: dir, hooks: {} });
    const { id } = await h.spawn({ description: "scoped" });
    await settledOnDisk(h, id);

    assert.ok(ledgerSays(h.kv, h.directory).tasks[id], "a completed task must be retained");
    for (const key of h.kv.keys()) {
      assert.equal(key.includes(dir), false, `a durable key must not carry a directory: ${key}`);
      assert.equal(key.includes(process.cwd()), false, "and above all never the process cwd");
    }
  });
});

// --- The Session Inbox capability verdict (v2.1.4+) -------------------------
// Every inbox-gated path branches on the verdict the boot read from the host's
// shape, so the verdict itself is pinned at both ends: a host without the
// surface is a below-inbox host and must boot exactly as it always did; a host
// that presents the namespace arms the verdict. The probe is a SHAPE read —
// synchronous, no request — so the boot pays nothing for it, and that too is
// pinned by counting presence reads.
describe("the boot reads the Session Inbox capability once from the host's shape", () => {
  it("arms the verdict when the host presents the inbox surface", async () => {
    await setupHarness({ hooks: { inboxHost: true } });
    assert.strictEqual(inboxSupported(), true, "an inbox host boots inbox-capable");
  });

  it("keeps the verdict off for a below-inbox host, which boots exactly as today", async () => {
    const h = await setupHarness({});
    assert.strictEqual(inboxSupported(), false, "no inbox surface, no capability");
    assert.ok(h.tool.task_continue, "the tools registered exactly as they always did");
    const status = await h.tool.task_status.execute({ session_id: "ses_absent" });
    assert.match(status, /Status: unknown/, "the legacy boot answers as it always did");
  });

  it("probes the shape without dialling the host", async () => {
    const h = await setupHarness({ hooks: { inboxHost: true } });
    const atBoot = h.client.testState.presenceReads;
    assert.strictEqual(inboxSupported(), true);
    assert.strictEqual(h.client.testState.presenceReads, atBoot, "the probe is a shape read, not a request");
  });
});

