/**
 * Boot — what a fresh process makes of the state the last one left behind.
 *
 * Durable state is only worth writing if a restart can read it, so every case
 * here boots a real plugin on a ledger the case composed. Three debts exist: a
 * record to retain, a notice to redeliver, and a child that was still running.
 * The version policy is part of this too — a past the reader cannot fully
 * understand is discarded whole rather than half-restored.
 */

import { describe, it } from "./support/runner.js";
import assert from "node:assert";
import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dialCount, setupHarness, sleep, tmpProjectDir, withEnv } from "./support/harness.js";
import { answerMatches, answerOmits, answerSays, textDeclaresKind } from "./support/assertions.js";
import { bootOn, fileSays, settledOnDisk, waitFor, writeLedger } from "./support/integration.js";

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
import { loadTaskLedger, resolveTaskLedgerPath } from "../../dist/shared/session-lifecycle.js";
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
const partlyBadLedger = () => JSON.stringify({
  version: 3,
  tasks: {
    ses_real: retainedEntry({ childSessionId: "ses_real", state: "completed", retainedAt: Date.now() }),
    ses_broken: { state: "completed" },
  },
  active: {},
  pending: [],
});

/**
 * A write that CANNOT land, blocked in a way that does not depend on the name the
 * writer stages through: the ledger path itself is occupied by a non-empty
 * directory, so the rename onto it fails however the temp file is called. An
 * earlier version blocked `${ledger}.tmp` directly and went on passing for the
 * wrong reason the moment the writer was given a per-process temp name — a test
 * coupled to the implementation it is meant to police.
 */
const blockTheLedgerWrite = (directory) => {
  const ledgerPath = resolveTaskLedgerPath(directory);
  mkdirSync(ledgerPath, { recursive: true });
  writeFileSync(path.join(ledgerPath, "occupied"), "not a ledger");
};

// --- When the write cannot land ---------------------------------------------
// `persistLedger` swallows a write failure so that a durable-state problem can
// never break control flow, which is right — and which made the failure
// invisible. A settlement that did not reach the disk, on a run with no later
// mutation to retry it, leaves a child active in the ledger forever and a
// completion notice the parent is never told about. Nothing said so. Silence is
// the worst possible answer here, because the plugin's whole claim is that it
// does not lose track of a child.
//
// TWO worlds, and the difference is where the failure happens rather than how
// loud it is. A ledger path occupied by a directory cannot be READ, so the
// refusal lands before any write is attempted and the file is left alone. A
// ledger that reads perfectly inside a directory that cannot be written to gets
// as far as the write, and fails there. They need different remedies — move the
// file, versus fix the permissions — so they are reported as different things.
//
// The second world is also the one that used to be unreportable, because the
// read-failure report above promised "two channels, matching the write failure
// below" and the write failure had only the channel that is off unless
// DYNAMIC_TASK_DEBUG was set before the process started.
async function bootWithUnwritableLedger({ debug = false } = {}) {
  const directory = tmpProjectDir();
  blockTheLedgerWrite(directory);
  const run = async () => {
    const h = await setupHarness({ directory });
    const { id } = await h.spawn({ description: "unpersistable" });
    await h.settle(id);
    return { h, id, directory };
  };
  return debug ? withEnv("DYNAMIC_TASK_DEBUG", "1", run) : run();
}

describe("a ledger write that cannot land is recorded, not swallowed", () => {
  it("a ledger that cannot be read is refused, not replaced, and says so on the host log", async () => {
    const { h } = await bootWithUnwritableLedger();
    const said = JSON.stringify(h.logs());
    answerMatches(said, /EISDIR|EPERM|EACCES|ENOTDIR|ENOTEMPTY/, "the cause is on the host log, where an operator will look");
    answerMatches(said, /not writing the task ledger/i, "and it says the write was refused rather than attempted");
    answerSays(said, ".dynamic-task-ledger.json", "and which project's ledger is being left alone");
  });

  it("a readable ledger in an unwritable project fails loudly on the host log", async () => {
    // A valid v3 file the reader accepts, in a directory the writer cannot add a
    // file to. The read is not the failure here, so the guard that leaves an
    // unreadable file alone must not fire — and it does not, because the world
    // is reached by permission rather than by content.
    const directory = tmpProjectDir();
    writeLedger(directory, { tasks: {}, active: {}, pending: [] });
    const h = await setupHarness({ directory });
    const { id } = await h.spawn({ description: "unpersistable, but readable" });
    chmodSync(directory, 0o555);
    try {
      await h.settle(id);
    } finally {
      chmodSync(directory, 0o755);
    }
    const said = JSON.stringify(h.logs());
    answerMatches(said, /write to the task ledger.*failed/i, "a lost write is on the host log, not only in a debug file");
    answerMatches(said, /EACCES|EPERM/, "and it names the cause");
    answerSays(said, ".dynamic-task-ledger.json", "and which project's ledger lost the write");
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
  const bootOnCorrupt = (contents) => bootOn(() => contents);

  it("a torn file is named on the host log, where an operator will actually look", async () => {
    const h = await bootOnCorrupt('{"version":3,"tasks":{"ses_a":{"state":"comp');
    const said = JSON.stringify(h.logs());
    answerMatches(said, /discarded/i, "the log says the file was thrown away, not merely empty");
    answerMatches(said, /unparseable/i, "and says which failure it was");
    answerMatches(said, /\.dynamic-task-ledger\.json/, "and which file lost what");
  });

  it("a file this build cannot speak is reported by version, not swallowed", async () => {
    const h = await bootOnCorrupt(JSON.stringify({ version: 2, tasks: {}, active: {}, pending: [] }));
    const said = JSON.stringify(h.logs());
    answerMatches(said, /discarded/i, "an old version is still a discarded file");
    answerMatches(said, /version/i, "and the version is what an operator needs to act on");
  });

  it("records dropped inside a readable file are counted, not lost quietly", async () => {
    const h = await bootOnCorrupt(partlyBadLedger());
    lossIsReported(h, "a partly-bad file is still a loss worth reporting");
  });

  it("a good ledger reports nothing — silence must still mean healthy", async () => {
    const h = await bootOn(() => ({ tasks: {}, active: {}, pending: [] }));
    const aboutTheLedger = h.logs().filter((entry) => /discarded|unparseable/i.test(JSON.stringify(entry)));
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
  it("a file this build cannot parse is left on disk, not overwritten by the boot that reported it", async () => {
    const lost = { version: 2, tasks: { ses_old: retainedEntry({ childSessionId: "ses_old", state: "completed", retainedAt: Date.now() }) } };
    const h = await bootOn(() => lost);
    const ledgerPath = resolveTaskLedgerPath(h.directory);

    const { id } = await h.spawn({ description: "settles into a file we cannot read" });
    await settledOnDisk(h, id);

    assert.deepStrictEqual(fileSays(ledgerPath), lost, "the unreadable file is exactly as the operator was told it was");
    answerMatches(
      JSON.stringify(h.logs()),
      /will not (be )?(over)?write/i,
      "and the operator is told the file is being left alone, not merely that it was read badly",
    );
  });

  // The other direction, and the reason the guard is not simply "discarded means
  // stop writing". That string covers two different worlds: a file whose records
  // were dropped is a file this build READ — the survivors are in hand and a write
  // merges onto a known document, which is the ordinary case. Refusing there would
  // let one malformed record switch durability off for the project permanently,
  // trading a repairable record for an unrecoverable one.
  it("a file whose records were dropped is still written — one bad record is not a dead ledger", async () => {
    const h = await bootOnCorrupt(partlyBadLedger());
    const { id } = await h.spawn({ description: "settles into a partly-bad file" });
    await settledOnDisk(h, id);

    const onDisk = fileSays(resolveTaskLedgerPath(h.directory));
    assert.ok(onDisk.tasks["ses_real"], "the record that did parse is still on disk");
    assert.ok(onDisk.tasks[id], "and the record this boot settled is written beside it");
    assert.ok(onDisk.tasks["ses_broken"] === undefined, "the record that did not parse is not invented");
  });
});

/**
 * A plugin booted on a ledger the case wrote.
 *
 * The document SHAPE is this helper's, not a case's. It was being spelled at three
 * sites — `tasks`, `active`, `pending`, and in one of them `version` — and a case
 * that forgot `pending` produced a document the reader treats as a different thing,
 * silently. The shape belongs to one door; what belongs in the two halves is the
 * case's own decision.
 */
const bootWithLedger = (halves, hooks) => bootOn(() => ({ tasks: {}, active: {}, pending: [], ...halves }), hooks);

/**
 * The host log's account of records a READABLE ledger could not keep.
 *
 * Two claims and they are one claim: a loss that is not counted is a loss nobody
 * can act on, so saying "discarded" without a count is not half the report, it is
 * the same defect. Asserted in two places for different reasons (a torn file, and a
 * file that contradicts itself), which is what made it worth a name.
 */
const lossIsReported = (h, note) => {
  const said = JSON.stringify(h.logs());
  answerMatches(said, /discarded/i, note);
  answerMatches(said, /\d+ record/i, "and how many were lost with it");
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
    const h = await bootWithLedger({
      tasks: { ses_both: retainedEntry({ childSessionId: "ses_both", state: "completed" }) },
      active: { ses_both: runningEntry("ses_both") },
    });
    lossIsReported(h, "a record that contradicts its own file is thrown away");
    fleetShowsOnlyTheRunningRow(await h.tool.task_list.execute({}));
  });
});

// --- State scoping (contamination regression) -------------------------------
// Root cause of the poisoned repo ledger: persistence resolved against the
// process CWD, not the plugin's project directory. Pins: retained mutations
// write inside the directory the host provided, and the CWD is untouched.
describe("ledger follows the plugin directory, never the process cwd", () => {
  it("persists retained tasks under the provided directory only", async () => {
    const dir = tmpProjectDir();
    const cwdLedger = resolveTaskLedgerPath(process.cwd());
    const cwdBefore = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;

    const h = await setupHarness({ hooks: {}, directory: dir });
    const { id } = await h.spawn({ description: "scoped" });
    await settledOnDisk(h, id);

    const ledgerFile = resolveTaskLedgerPath(dir);
    assert.ok(existsSync(ledgerFile), "ledger must be written inside the plugin directory");
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    assert.ok(ledger.tasks?.[id], "completed task must be retained in the project ledger");

    const cwdAfter = existsSync(cwdLedger) ? readFileSync(cwdLedger, "utf8") : null;
    assert.strictEqual(cwdAfter, cwdBefore, "the suite must never create or mutate the cwd ledger");
    });
});

// ─── Durable delivery (docs/tasks/11-durability.md, M2) ──────────────────
// The hole this closes: the plugin settled a task and THEN dialed the parent, so
// a crash in between left a `completed` record with no notice and no evidence one
// was owed. The debt is written before the dial now, which makes a crash cost a
// duplicate notice — visible, and the direction the spec takes deliberately.
describe("boot redelivers what the last boot owed", () => {
  const owedDebt = (parentSessionId = "ses_parent", childSessionId = "ses_owed") => owedEntry({
    parentSessionId,
    childSessionId,
    // A real notification, from the real renderer: a debt built from a hand-written
    // approximation of the wire text is a debt the host never produced, and a boot
    // that redelivers it proves nothing about redelivering a real one.
    text: formatParentNotification({ childSessionId, description: "owed" }, "completed", "owed this"),
  });

  /**
   * A boot over N debts, with the fan-out bound set to `batch`. N well above the
   * bound on purpose: a case at or under the bound cannot tell a cap from no cap.
   */
  const bootWithManyOwed = (count, batch) => withEnv(ENV.maxConcurrent, String(batch), () =>
    bootOn(() => {
      const debts = Array.from({ length: count }, (_, i) => owedDebt(`ses_parent_${i}`, `ses_child_${i}`));
      return {
        tasks: Object.fromEntries(debts.map((d) => [d.childSessionId, retainedEntry({
          childSessionId: d.childSessionId, parentSessionId: d.parentSessionId,
          agentName: "general", description: "owed",
        })])),
        pending: debts,
      };
    }),
  );

  // Every case here is the same world with one debt in it, so the world is built
  // once: a project directory carrying an owed notice, and a plugin booted on it.
  const bootWithOwed = (owedEntries, hooks = {}) => bootOn(() => ({
    tasks: {
      ses_owed: retainedEntry({
        childSessionId: "ses_owed", parentSessionId: "ses_parent",
        agentName: "general", description: "owed",
      }),
    },
    pending: owedEntries,
  }), { hooks });

  const onDisk = (directory) => {
    try {
      return JSON.parse(readFileSync(resolveTaskLedgerPath(directory), "utf8"));
    } catch {
      return null;
    }
  };
  // The owed queue on disk, once it has settled to exactly `count`. The count is
  // the same number the case then asserts, which is the point: a wait spelled
  // with a looser condition than the assertion beneath it is a test that can
  // pass on a queue that went somewhere else.
  const pendingReached = (directory, count) => waitFor(() => {
    const ledger = onDisk(directory);
    return Array.isArray(ledger?.pending) && ledger.pending.length === count;
  }, `the owed queue to reach ${count} on disk`);
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
    const said = JSON.stringify(h.logs());

    answerMatches(said, /owed|outstanding|unpaid/i, "the boot says it is carrying a debt from the last run");
    answerMatches(said, /ses_owed/, "and names the child it is owed for");
    answerMatches(said, /ses_parent/, "and the parent it has to reach");
  });

  it("a healthy boot still says nothing about debts — silence must keep meaning healthy", async () => {
    const h = await bootOn(() => ({ tasks: {}, active: {}, pending: [] }));
    const aboutDebts = h.logs().filter((entry) => /owed|outstanding|unpaid/i.test(JSON.stringify(entry)));
    assert.deepStrictEqual(aboutDebts, [], `a boot with nothing owed reports no debt. got: ${JSON.stringify(aboutDebts)}`);
  });

  it("an owed notice is delivered once at boot and retired from disk", async () => {
    const { directory, notices } = await bootWithOwed([owedDebt()]);

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
    await pendingReached(directory, 0);
  });

  // A held write re-arms its own debt inside the gate, so the queue is not
  // empty afterwards: what must not happen is a SECOND dial in this boot. (The
  // retry itself belongs to a refused write, covered where the transport can
  // refuse: notify.test.js scripts the rejection.) The wait is on the DIAL,
  // not on the queue — the restored ledger already holds the entry, so the
  // queue cannot tell "not yet redelivered" from "redelivered and held".
  it("a redelivery the host still holds is not retried here — it waits for the next boot", async () => {
    const { directory, client } = await bootWithOwed([owedDebt()], { notifyTransport: { hang: new Promise(() => {}) } });
    await waitFor(() => dialCount(client) > 0, "the redelivery to dial");
    assert.strictEqual(dialCount(client), 1, "one dial, then the host holds it");
    assert.strictEqual(onDisk(directory).pending.length, 1, "the unanswered write is owed again");
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
    const { directory } = await bootWithManyOwed(9, 2);
    await pendingReached(directory, 7);

    const stillOwed = onDisk(directory).pending;
    assert.deepStrictEqual([...new Set(stillOwed.map((d) => d.attempts))], [1],
      "and none was charged an attempt for a write that never happened");
  });

  it("a v2 ledger boots clean rather than half-restored", async () => {
    const directory = tmpProjectDir();
    writeFileSync(resolveTaskLedgerPath(directory), JSON.stringify({ version: 2, tasks: {} }));
    const h = await setupHarness({ hooks: {}, directory });
    assert.deepStrictEqual(h.notices(), [], "nothing to redeliver from a past this build cannot read");
    assert.strictEqual(onDisk(directory).version, 2, "and no debt invented from it — the file is untouched");
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
  const bootWithRunners = (actives, hostStatusSeed) => bootWithLedger({ active: actives }, { hooks: { hostStatusSeed } });

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
      { ses_a: "busy", ses_b: "busy" },
    );
    const list = await h.tool.task_list.execute({});
    for (const id of ["ses_a", "ses_b"]) {
      assert.ok(list.includes(id), `${id} is still shown — an unreached record becomes a root, it does not vanish`);
    }
    const stopped = await h.tool.task_interrupt.execute({ session_id: "ses_a" });
    answerSays(stopped, "ses_a", "the stop reports what it acted on");
  });

  const ledgerActive = (directory) => JSON.parse(readFileSync(resolveTaskLedgerPath(directory), "utf8")).active;

  it("a child the host is still working stays active and settles on its own event", async () => {
    const h = await bootWithRunners({ ses_live: runningEntry("ses_live") }, { ses_live: "busy" });
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
    const { directory, notices, logs } = await bootWithLedger(
      { active: { ses_first: runningEntry("ses_first"), ses_second: runningEntry("ses_second") } },
      { hooks: { statusThrows: true } },
    );
    await sleep(150);

    assert.deepStrictEqual(
      Object.keys(ledgerActive(directory)).sort(),
      ["ses_first", "ses_second"],
      "not knowing leaves a child ACTIVE — inventing a settlement is the expensive error here",
    );
    assert.deepStrictEqual(notices(), [], "and nothing is notified that was not observed");

    const said = JSON.stringify(logs());
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
    const { directory, notices } = await bootWithRunners({ ses_gone: runningEntry("ses_gone") }, {});
    await noticeArrives(notices, "the vanished child to settle");
    const [notice] = notices();
    assert.strictEqual(notice.to, "ses_parent", "delivered to the parent it was spawned for");
    textDeclaresKind(notice.message, "error", "an error the parent can act on");
    answerMatches(notice.message, /vanish/i, "the parent is told it vanished, not that its work failed");
    answerMatches(notice.message, /restart/i, "and when the loss of contact happened");
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [], "nothing is left pretending to run");
  });

  // The host says the turn is over and the transcript still reads: this is
  // finished work, and settling it error would invent a failure nobody saw.
  it("a child that finished while the parent was down settles completed, not error", async () => {
    const { notices } = await bootWithRunners({ ses_idle: runningEntry("ses_idle") }, { ses_idle: "idle" });
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
    const h = await setupHarness({ hooks: {}, directory });
    const { id } = await h.spawn({ description: "durable active" });
    await sleep(30); // the spawn observer writes synchronously; the sleep is for CI, not the contract.
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [id], "a running child is durable");

    // Through the READER, not through raw JSON. The writer re-reads the file on
    // every write now (two instances, one ledger), so a record it writes and its
    // own reader then drops is a record the next write is built on top of as
    // absent — a silent slide back to one process's view being the whole truth.
    // "The key is in the file" is not that claim; "the reader keeps it" is.
    const readBack = loadTaskLedger(resolveTaskLedgerPath(directory));
    assert.strictEqual(readBack.discarded, null, "nothing about the record just written failed validation");
    assert.ok(readBack.active.has(id), "and the reader still recognises it as a running task");

    await settledOnDisk(h, id);
    assert.deepStrictEqual(ledgerActive(directory), {}, "and it stops being a running task the moment it settles");
    assert.ok(loadTaskLedger(resolveTaskLedgerPath(directory)).retained.has(id), "while the reader can still see it as settled");
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
  const activeIds = (directory) => Object.keys(JSON.parse(readFileSync(resolveTaskLedgerPath(directory), "utf8")).active).sort();

  it("neither deletes the other's running task", async () => {
    const directory = tmpProjectDir();
    const a = await setupHarness({ hooks: { sessionPrefix: "a" }, directory });
    const b = await setupHarness({ hooks: { sessionPrefix: "b" }, directory });

    const first = await a.spawn({ description: "work from the first window" });
    const second = await b.spawn({ description: "work from the second window" });
    await sleep(30);

    assert.deepStrictEqual(
      activeIds(directory),
      [first.id, second.id].sort(),
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
