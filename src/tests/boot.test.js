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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dialCount, setupHarness, sleep, tmpProjectDir, withEnv } from "./support/harness.js";
import { answerMatches, answerSays } from "./support/assertions.js";
import { bootOn, settledOnDisk, waitFor } from "./support/integration.js";
import { owedEntry, retainedEntry, runningEntry } from "./support/records.js";
import { getDebugLogPath } from "../../dist/debug-logger.js";
import { resolveTaskLedgerPath } from "../../dist/shared/session-lifecycle.js";
import { formatParentNotification } from "../../dist/shared/notify.js";

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
// Both cases are the same world, so it is built once: a project whose ledger
// write cannot land, a plugin booted on it, and a child spawned and settled —
// which is what makes the write fail. `debug` wraps the whole thing rather than
// the assertions because `debugLog` gates at CALL time, so a log enabled only
// while reading would hand back a file frozen before the failure happened.
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
  it("logs the failure and names the cause", async () => {
    await bootWithUnwritableLedger({ debug: true });
    const log = readFileSync(getDebugLogPath("plugin", "ledger"), "utf8");
    answerSays(log, "ledger-write-failed", "the failure is on the record");
    answerMatches(log, /EISDIR|EPERM|EACCES|ENOTDIR|ENOTEMPTY/, "and it names the cause, not just that it failed");
    // Which project, not which child: one write carries every record at once, so
    // there is no single child to name. The path is what an operator needs.
    answerSays(log, ".dynamic-task-ledger.json", "and which project's ledger lost the write");
  });

  it("settles the child anyway — a failed write must not strand it", async () => {
    const { h, id } = await bootWithUnwritableLedger();
    const status = await h.child(id).status();
    answerSays(status, "State: completed", "in-memory state is the authority while the process lives");
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
  const owedDebt = () => owedEntry({
    parentSessionId: "ses_parent",
    childSessionId: "ses_owed",
    // A real notification, from the real renderer: a debt built from a hand-written
    // approximation of the wire text is a debt the host never produced, and a boot
    // that redelivers it proves nothing about redelivering a real one.
    text: formatParentNotification({ childSessionId: "ses_owed", description: "owed" }, "completed", "owed this"),
  });

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
  // Boot does not block on redelivery (a held parent must not delay every tool
  // by the write bound), so the observable is waited on — never a sleep standing
  // in for a contract.
  it("an owed notice is delivered once at boot and retired from disk", async () => {
    const { directory, notices } = await bootWithOwed([owedDebt()]);

    assert.deepStrictEqual(
      notices().map((n) => [n.to, n.message.includes("owed this")]),
      [["ses_parent", true]],
      "exactly the owed write, to the parent it was addressed to",
    );
    await waitFor(() => {
      const ledger = onDisk(directory);
      return Array.isArray(ledger?.pending) && ledger.pending.length === 0;
    }, "the debt to be retired once the parent answered");
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
  const bootWithRunners = (actives, hostStatusSeed) => bootOn(
    () => ({ tasks: {}, active: actives, pending: [] }),
    { hooks: { hostStatusSeed } },
  );

  const ledgerActive = (directory) => JSON.parse(readFileSync(resolveTaskLedgerPath(directory), "utf8")).active;

  it("a child the host is still working stays active and settles on its own event", async () => {
    const h = await bootWithRunners({ ses_live: runningEntry("ses_live") }, { ses_live: "busy" });
    const status = await h.tool.task_status.execute({ session_id: "ses_live" }, { sessionID: "ses_parent" });
    answerMatches(status, /State: active/, "still running is still active");
    assert.deepStrictEqual(h.noticeBodies(), [], "no notice for a task that is not over");

    const notice = await h.settledNotice("ses_live");
    answerMatches(notice, /completed successfully/, "its genuine terminal event settles it, once");
  });

  it("a child the host no longer lists settles error, saying it vanished across the restart", async () => {
    const { directory, notices } = await bootWithRunners({ ses_gone: runningEntry("ses_gone") }, {});
    await waitFor(() => notices().length > 0, "the vanished child to settle");
    const [notice] = notices();
    assert.strictEqual(notice.to, "ses_parent", "delivered to the parent it was spawned for");
    answerMatches(notice.message, /ended with an error/, "an error the parent can act on");
    answerMatches(notice.message, /vanish/i, "the parent is told it vanished, not that its work failed");
    answerMatches(notice.message, /restart/i, "and when the loss of contact happened");
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [], "nothing is left pretending to run");
  });

  // The host says the turn is over and the transcript still reads: this is
  // finished work, and settling it error would invent a failure nobody saw.
  it("a child that finished while the parent was down settles completed, not error", async () => {
    const { notices } = await bootWithRunners({ ses_idle: runningEntry("ses_idle") }, { ses_idle: "idle" });
    await waitFor(() => notices().length > 0, "the finished child to settle");
    answerMatches(notices()[0].message, /completed successfully/, "the finished child settles as the success it was");
    assert.doesNotMatch(notices()[0].message, /ended with an error/);
  });

  it("a spawned task is on disk while it runs, and gone from the active set once it settles", async () => {
    const directory = tmpProjectDir();
    const h = await setupHarness({ hooks: {}, directory });
    const { id } = await h.spawn({ description: "durable active" });
    await sleep(30); // the spawn observer writes synchronously; the sleep is for CI, not the contract.
    assert.deepStrictEqual(Object.keys(ledgerActive(directory)), [id], "a running child is durable");

    await settledOnDisk(h, id);
    assert.deepStrictEqual(ledgerActive(directory), {}, "and stops being a running task the moment it settles");
  });
});
