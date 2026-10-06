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

//jscpd:ignore-start
import { answerMatches, answerOmits, answerSays, textDeclaresKind } from "./support/assertions.js";
import { bootOn, ledgerSays, settledOnDisk, waitFor } from "./support/integration.js";
import { assert, describe, it } from "./support/runner.js";
import { dialCount, setupHarness, sleep, tmpProjectDir, withEnv } from "./support/harness.js";
import { compareStrings } from "./support/assertions.js";

//jscpd:ignore-end
/**
 * Wait for a notice to land, because boot deliberately does not block on
 * redelivery and the arrival is the observable.
 *
 * Stated once, at module scope, because two suites below wait on it and
 * `waitFor(() => notices().length > 0, …)` spelled out at each site is both what
 * jscpd reads as a clone and a second place to forget that a redelivery is a
 * fire-and-forget write.
 */
const noticeArrives = (notices, why) => waitFor(() => notices().length > 0, why);
import { owedEntry, retainedEntry, runningEntry } from "./support/records.js";
import { LEDGER_PREFIXES, LEDGER_VERSION } from "../../dist/shared/ledger-storage.js";
import { formatParentNotification } from "../../dist/shared/notification-text.js";
import { ENV } from "../../dist/shared/config.js";

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
    answerSays(h.prose(), LEDGER_PREFIXES.retained, "an operator is told WHICH record did not land");
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

    assert.equal(h.kv.has(`${LEDGER_PREFIXES.retained}/${id}`), true, "this build's own record does land");
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
    const h = await bootOnCorrupt({}, { raw: { [`${LEDGER_PREFIXES.retained}/ses_a`]: "{not a record" } });

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
    const h = await bootOnCorrupt({}, { raw: { [`${LEDGER_PREFIXES.retained}/ses_broken`]: lost } });

    const { id } = await h.spawn({ description: "settles beside a record we cannot read" });
    await settledOnDisk(h, id);

    assert.strictEqual(h.kv.get(`${LEDGER_PREFIXES.retained}/ses_broken`), lost,
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
    assert.equal(h.kv.has(`${LEDGER_PREFIXES.retained}/ses_broken`), true, "and it is left on the host, not deleted");
  });
});

/** The empty document: a case that omits a half produces a DIFFERENT ledger, silently. */
const anEmptyLedger = () => ({ active: {}, pending: [], tasks: {} });

/** Boot on a ledger the case shapes, and hand back the world every case here wants. */
const bootedOn = async (shape, hooks) => {
  const { directory, ...rest } = await bootOn(shape, hooks);
  return { directory, h: rest, ...rest };
};

/**
 * A plugin booted on a ledger the case wrote.
 *
 * The document SHAPE is this helper's, not a case's. It was being spelled at three
 * sites — `tasks`, `active`, `pending`, and in one of them `version` — and a case
 * that forgot `pending` produced a document the reader treats as a different thing,
 * silently. The shape belongs to one door; what belongs in the two halves is the
 * case's own decision.
 */
const bootWithLedger = (halves, hooks) => bootedOn(() => ({ ...anEmptyLedger(), ...halves }), hooks);

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
    const h = await bootWithLedger(
      {
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

    assert.ok(ledgerSays(h.kv).tasks[id], "a completed task must be retained");
    for (const key of h.kv.keys()) {
      assert.equal(key.includes(dir), false, `a durable key must not carry a directory: ${key}`);
      assert.equal(key.includes(process.cwd()), false, "and above all never the process cwd");
    }
  });
});

// ─── Durable delivery (docs/tasks/11-durability.md, M2) ──────────────────
// The hole this closes: the plugin settled a task and THEN dialed the parent, so
// a crash in between left a `completed` record with no notice and no evidence one
// was owed. The debt is written before the dial now, which makes a crash cost a
// duplicate notice — visible, and the direction the spec takes deliberately.
describe("boot redelivers what the last boot owed", () => {
  const owedDebt = (parentSessionId = "ses_parent", childSessionId = "ses_owed") => owedEntry({
    childSessionId,
    parentSessionId,
    // A real notification, from the real renderer: a debt built from a hand-written
    // approximation of the wire text is a debt the host never produced, and a boot
    // that redelivers it proves nothing about redelivering a real one.
    text: formatParentNotification({ childSessionId, description: "owed" }, "completed", "owed this"),
  });

  /**
   * A boot over N debts, with the fan-out bound set to `batch`. N well above the
   * bound on purpose: a case at or under the bound cannot tell a cap from no cap.
   */
  const bootWithManyOwed = (count, batch) =>
    withEnv(ENV.maxConcurrent, String(batch), () =>
      bootedOn(() => {
        const debts = Array.from({ length: count }, (_, i) => owedDebt(`ses_parent_${i}`, `ses_child_${i}`));
        return {
          pending: debts,
          tasks: Object.fromEntries(debts.map((d) => [d.childSessionId, retainedEntry({
            agentName: "general", childSessionId: d.childSessionId, description: "owed", parentSessionId: d.parentSessionId,
          })])),
        };
      }));

  // Every case here is the same world with one debt in it, so the world is built
  // once: a project directory carrying an owed notice, and a plugin booted on it.
  const bootWithOwed = (owedEntries, hooks = {}) =>
    bootedOn(() => ({
      pending: owedEntries,
      tasks: {
        ses_owed: retainedEntry({
          agentName: "general", childSessionId: "ses_owed", description: "owed", parentSessionId: "ses_parent",
        }),
      },
    }), { hooks });

  const onDisk = (h) => ledgerSays(h.kv);
  // The owed queue on disk, once it has settled to exactly `count`. The count is
  // the same number the case then asserts, which is the point: a wait spelled
  // with a looser condition than the assertion beneath it is a test that can
  // pass on a queue that went somewhere else.
  const pendingReached = (h, count) => waitFor(() => {
    const ledger = onDisk(h);
    return Array.isArray(ledger?.pending) && ledger.pending.length === count;
  }, `the owed queue to reach ${count}`);
  // Boot does not block on redelivery (a held parent must not delay every tool
  // by the write bound), so the observable is waited on — never a sleep standing
  // in for a contract.
  it("a boot with an owed debt SAYS SO on the host log, where an operator will look", async () => {
    // The detection gap, measured 2026-09-28: the plugin had written zero lines
    // to the host log in this project's entire history, so a parent that was
    // wedged mid-turn and re-injected on every restart left no trace anywhere —
    // not in the log, and not in the ledger, which looks identical to a healthy
    // queue. The write-off path had a careful warning that never fired, because
    // the debt never reached its budget. The boot pass is the one moment every
    // debt is visible at once, so it is the one moment that has to say so.
    const h = await bootWithOwed([owedDebt()]);
    const said = h.pluginLog();

    answerMatches(said, /owed|outstanding|unpaid/i, "the boot says it is carrying a debt from the last run");
    answerMatches(said, /ses_owed/, "and names the child it is owed for");
    answerMatches(said, /ses_parent/, "and the parent it has to reach");
  });

  it("a healthy boot still says nothing about debts — silence must keep meaning healthy", async () => {
    const h = await bootOn(anEmptyLedger);
    const aboutDebts = h.pluginLog().match(/owed|outstanding|unpaid/gi) ?? [];
    assert.deepStrictEqual(aboutDebts, [], `a boot with nothing owed reports no debt. got: ${JSON.stringify(aboutDebts)}`);
  });

  it("an owed notice is delivered once at boot and retired from disk", async () => {
    const { h, notices } = await bootWithOwed([owedDebt()]);

    // Waited on, not slept: the gate asks the host whether the parent will take
    // this write before it makes it, and that read is one more turn of the
    // microtask queue ahead of the dial. Boot deliberately does not block on
    // redelivery, so the notice arriving is the observable, not a delay to be
    // assumed.
    await noticeArrives(notices, "the boot's redelivery write to reach the parent");
    assert.deepStrictEqual(
      notices().map((n) => [n.to, n.message.includes("owed this")]),
      [["ses_parent", true]],
      "exactly the owed write, to the parent it was addressed to",
    );
    await pendingReached(h, 0);
  });

  // A held write re-arms its own debt inside the gate, so the queue is not
  // empty afterwards: what must not happen is a SECOND dial in this boot. (The
  // retry itself belongs to a refused write, covered where the transport can
  // refuse: notify.test.js scripts the rejection.) The wait is on the DIAL,
  // not on the queue — the restored ledger already holds the entry, so the
  // queue cannot tell "not yet redelivered" from "redelivered and held".
  it("a redelivery the host still holds is not retried here — it waits for the next boot", async () => {
    const { client, h } = await bootWithOwed([owedDebt()], { notifyTransport: { hang: new Promise(() => {}) } });
    await waitFor(() => dialCount(client) > 0, "the redelivery to dial");
    assert.strictEqual(dialCount(client), 1, "one dial, then the host holds it");
    assert.strictEqual(onDisk(h).pending.length, 1, "the unanswered write is owed again");
  });

  // The hole, measured on coda 2026-09-28: the boot re-offered EVERY restored
  // debt, with no cap, and each redelivery is `session.prompt` — a real user
  // turn in the parent's session. So a project that had accumulated many owes
  // paid one whole turn per owe in a single boot, all at once, and in a large
  // session a turn costs the parent its entire context. `pendingMaxAttempts`
  // bounds how long ONE debt may live; nothing bounded how many one boot dials.
  // That is the same shape as the re-arm this suite already caught: a budget
  // that is declared and never spent down.
  it("a boot re-offers at most maxConcurrent debts — a queue may not become a flood", async () => {
    const { notices, client } = await bootWithManyOwed(9, 2);
    await waitFor(() => dialCount(client) >= 2, "the bounded batch to be offered");
    await sleep(40);

    assert.strictEqual(notices().length, 2,
      `a boot offered ${notices().length} of 9 debts with the fan-out bound at 2: ${JSON.stringify(notices().map((n) => n.to))}`);
    assert.strictEqual(dialCount(client), 2, "and the host was asked to write exactly twice");
  });

  // The companion invariant, and the reason the bound is safe: work that was NOT
  // attempted must not be charged for. An attempt is the price of a real write, so
  // a deferred debt keeps the count it already had — which is also what lets the
  // queue drain: a debt cannot be written off for patience it did not spend.
  it("a debt the boot did not attempt is still owed, at the count it already had", async () => {
    const { h } = await bootWithManyOwed(9, 2);
    await pendingReached(h, 7);

    const stillOwed = onDisk(h).pending;
    assert.deepStrictEqual([...new Set(stillOwed.map((d) => d.attempts))], [1],
      "and none was charged an attempt for a write that never happened");
  });

  it("a ledger from a past this build cannot read boots clean rather than half-restored", async () => {
    const past = aPastLedger();
    const h = await setupHarness({ directory: tmpProjectDir(), hooks: {}, storage: (kv) => kv.set(past, "{}") });
    assert.deepStrictEqual(h.notices(), [], "nothing to redeliver from a namespace this build never read");
    assert.strictEqual(h.kv.get(past), "{}", "and the record is untouched — a build that can read it still can");
  });
});

// ─── Durable active set (docs/tasks/11-durability.md, M1) ────────────────
// The hole this closes: a child still running when the parent stopped had no
// record anywhere, so its terminal event found nothing to settle and dropped —
// it burned tokens and reported nothing. The running set is on disk now, and the
// next boot makes exactly one liveness read per restored task to decide what
// happened to it. No clocks, no polling: the host's own status words are the
// answer, and each cell below is a different set of words.
describe("boot reconciles what the last boot was still running", () => {
  /**
   * Boot with restored children and the host's own verdict about each one.
   *
   * `hostTurnSeed` is the v2 turn record: an entry means the host has recorded a
   * verdict for that turn, its absence means a turn is still open. The v1 spelling
   * of this — a status map the host deletes on idle — is gone, and a fixture that
   * still seeds it proves nothing: the map nothing reads cannot fail a case.
   */
  const bootWithRunners = (actives, hostTurnSeed) => bootWithLedger({ active: actives }, { hooks: { hostTurnSeed } });

  // A record file is a document a person can edit and a crash can tear, and
  // admission cannot produce a parent link that points back up the tree — but
  // nothing VALIDATES that the link points down. Two records naming each other
  // are therefore well-formed input, and the walk that renders the fleet and
  // the walk that computes a subtree stop are the same recursive descent over
  // those links. Without a path guard it recurses forever, and the failure is
  // an unhandled RangeError in a READ: one bad record bricks task_list and
  // task_interrupt, which are the two things a parent reaches for when
  // something is already wrong. Nothing held this before: the walk carried a
  // `path` set whose only exercise was a comment saying it could not be
  // reached, and removing it left every case green.
  it("a record file whose parent links form a cycle still reads and still stops", async () => {
    const h = await bootWithRunners(
      {
        ses_a: runningEntry("ses_a", { parentSessionId: "ses_b" }),
        ses_b: runningEntry("ses_b", { parentSessionId: "ses_a" }),
      },
      { ses_a: "succeeded", ses_b: "succeeded" },
    );
    const list = await h.tool.task_list.execute({});
    for (const id of ["ses_a", "ses_b"]) {
      assert.ok(list.includes(id), `${id} is still shown — an unreached record becomes a root, it does not vanish`);
    }
    const stopped = await h.tool.task_interrupt.execute({ session_id: "ses_a" });
    answerSays(stopped, "ses_a", "the stop reports what it acted on");
  });

  const ledgerActive = (h) => ledgerSays(h.kv).active;

  it("a child the host is still working stays active and settles on its own event", async () => {
    const h = await bootWithRunners({ ses_live: runningEntry("ses_live") }, { ses_live: "open" });
    const status = await h.tool.task_status.execute({ session_id: "ses_live" }, { sessionID: "ses_parent" });
    answerMatches(status, /State: active/, "still running is still active");
    assert.deepStrictEqual(h.noticeBodies(), [], "no notice for a task that is not over");

    const notice = await h.settledNotice("ses_live");
    textDeclaresKind(notice.message, "completed", "its genuine terminal event settles it, once");
  });

  // The status channel is DOWN, which is a different thing from a channel that
  // says nothing about a session: this is a read that throws, and it is the one
  // input `readLiveness` does not absorb — it guards its transcript read and not
  // this one, so the throw reaches the per-child catch for real.
  //
  // PER CHILD, not per pass. A failed read must not decide the fate of every task
  // listed after it, and the two-child shape is the only way to see that: a catch
  // wrapped around the LOOP instead of the body would pass a single-child case
  // and silently strand the second. So what is asserted is that both children
  // were still attempted — their names are in the log because the failure is
  // reported per child — and that both were left running, since a child's own
  // terminal event is what settles it and nothing else may.
  it("a status channel that is down leaves every restored child active, and attempts each one", async () => {
    const { h, notices, pluginLog } = await bootWithLedger(
      { active: { ses_first: runningEntry("ses_first"), ses_second: runningEntry("ses_second") } },
      { hooks: { presenceThrows: true } },
    );
    await sleep(150);

    assert.deepStrictEqual(
      Object.keys(ledgerActive(h)).toSorted(),
      ["ses_first", "ses_second"],
      "not knowing leaves a child ACTIVE — inventing a settlement is the expensive error here",
    );
    assert.deepStrictEqual(notices(), [], "and nothing is notified that was not observed");

    const said = pluginLog();
    for (const id of ["ses_first", "ses_second"]) {
      assert.ok(said.includes(id), `${id} was attempted: the failure is reported per child, so a catch around the loop would leave this name out`);
    }
    assert.match(said, /status channel unanswered; left active/,
      "and the log says which kind of gap it was — the word names the reason, so a reader can tell " +
        "a channel that was down from a host that listed nothing");
  });

  /**
   * Wait for a notice to land, because boot deliberately does not block on
   * redelivery and the arrival is the observable.
   *
   * Stated once, at module scope, because two suites below wait on it and
   * `waitFor(() => notices().length > 0, …)` spelled out at each site is both what
   * jscpd reads as a clone and a second place to forget that a redelivery is a
   * fire-and-forget write.
   */
  it("a child the host no longer lists settles error, saying it vanished across the restart", async () => {
    const { h, notices } = await bootWithRunners({ ses_gone: runningEntry("ses_gone") }, {});
    await noticeArrives(notices, "the vanished child to settle");
    const [notice] = notices();
    assert.strictEqual(notice.to, "ses_parent", "delivered to the parent it was spawned for");
    textDeclaresKind(notice.message, "error", "an error the parent can act on");
    answerMatches(notice.message, /vanish/i, "the parent is told it vanished, not that its work failed");
    answerMatches(notice.message, /restart/i, "and when the loss of contact happened");
    assert.deepStrictEqual(Object.keys(ledgerActive(h)), [], "nothing is left pretending to run");
  });

  // The host says the turn is over and the transcript still reads: this is
  // finished work, and settling it error would invent a failure nobody saw.
  it("a child that finished while the parent was down settles completed, not error", async () => {
    const { notices } = await bootWithRunners({ ses_idle: runningEntry("ses_idle") }, { ses_idle: "succeeded" });
    await waitFor(() => notices().length > 0, "the finished child to settle");
    textDeclaresKind(notices()[0].message, "completed", "the finished child settles as the success it was");
  });

  // A fourth word on the status channel is not this plugin's to interpret, and
  // the two things it is NOT are the two the reconciliation branch above acts
  // on. Collapsing "the host does not list this session" into "the host listed
  // a word I do not recognise" makes an unknown word indistinguishable from a
  // vanished child — so a child the host is still working under a word added
  // upstream is settled at boot as an error that never happened, with a cause
  // invented for it. Not knowing leaves it active, which is the same safe
  // reading the failed-read branch already takes: its own terminal event still
  // settles it, and nothing is notified that was not observed.
  // A child that finished while the parent was down settles completed, not error
  // (above). There is deliberately no case here for a status word this plugin does
  // not recognise: the host's word list is a closed union that production compiles
  // against, and the fake refuses to hold a word that is not in it — so the state is
  // unreachable, not merely untested. Its successor is liveness.test.js's "reads every
  // word the host declares": if the host ever adds one, that case fails until the new
  // word's meaning is decided in writing.

  it("a spawned task is on disk while it runs, and gone from the active set once it settles", async () => {
    const directory = tmpProjectDir();
    const h = await setupHarness({ directory, hooks: {} });
    const { id } = await h.spawn({ description: "durable active" });
    await sleep(30); // the spawn observer writes synchronously; the sleep is for CI, not the contract.
    assert.deepStrictEqual(Object.keys(ledgerActive(h)), [id], "a running child is durable");

    // Through the READER, not through the rows. A record the writer writes and its own
    // reader then drops is a record the next write is built on top of as absent — a
    // silent slide back to one process's view being the whole truth. "The key is in the
    // store" is not that claim; "the reader keeps it" is.
    const readBack = await h.readLedger();
    assert.strictEqual(readBack.dropped, 0, "nothing about the record just written failed validation");
    assert.ok(readBack.active.has(id), "and the reader still recognises it as a running task");

    await settledOnDisk(h, id);
    assert.deepStrictEqual(ledgerActive(h), {}, "and it stops being a running task the moment it settles");
    const ledger = await h.readLedger();
    assert.ok(ledger.retained.has(id), "while the reader can still see it as settled");
  });
});

// ─── Two plugin instances, one project ───────────────────────────────────────
//
// The ledger is ONE file and every opencode process in a project writes it. That
// is not a hypothetical: the operator running two windows on one repo is
// ordinary, and refusing the second instance was ruled out. So the question this
// file exists to answer is not "may two processes share it" but "what does the
// second one do to the first one's records".
//
// Before the merge: each process re-serialized its own private view of the whole
// document, so whichever wrote last deleted the other's running tasks outright —
// with no error, and while the deleted process went on running the child. The
// loss had no failure to find it by, which is the worst shape a data loss takes.
describe("two plugin instances sharing one project", () => {
  const activeIds = (h) => Object.keys(ledgerSays(h.kv).active).toSorted();

  it("neither deletes the other's running task", async () => {
    const directory = tmpProjectDir();
    // ONE durable domain under two plugin processes, which is what the host gives
    // them: the table is global, so two windows on one project write the same keys.
    const kv = new Map();
    const a = await setupHarness({ directory, domain: { kv }, hooks: { sessionPrefix: "a" } });
    const b = await setupHarness({ directory, domain: { kv }, hooks: { sessionPrefix: "b" } });

    const first = await a.spawn({ description: "work from the first window" });
    const second = await b.spawn({ description: "work from the second window" });
    await sleep(30);

    assert.deepStrictEqual(
      activeIds(a),
      [first.id, second.id].toSorted(compareStrings),
      "each instance's running task survives the other instance's write",
    );
  });

  // There is deliberately NO settlement case here, and its absence is the
  // finding rather than an omission. Settling owes a notice, and the owed
  // queue is a module-level singleton — one per process in production, and
  // one per process in a test too. So the second harness installs its own
  // writer over the first one's, and the LAST write of a settlement comes
  // from the wrong instance. A case written there passes for that reason and
  // would have read as proof that a settlement is safe. It was written, it
  // passed, and it proved nothing; the merge is pinned directly instead, where
  // it is a pure function and nothing is hijacked (session-lifecycle.test.js).
});
