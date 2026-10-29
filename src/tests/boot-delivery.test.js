/**
 * Durable delivery and the durable active set — the restart contract's second half.
 *
 * Split out of boot.test.js along the boundary that already existed: that file is
 * about what a boot does with state it CANNOT read or write; this one is about what
 * it does with state it CAN — debts to redeliver (M2), running children to reconcile
 * (M1), and two processes sharing one project's namespace.
 */

import { ENV } from "../../dist/shared/config.js";
import { LEDGER_KEYS, LEDGER_VERSION } from "../../dist/shared/ledger-storage.js";
import { formatParentNotification } from "../../dist/shared/notification-text.js";
import { clearNotifyLedger } from "../../dist/shared/notify.js";
import { anEmptyLedger, answerMatches, answerSays, assert, bootOn, bootWithLedger, compareStrings, describe, dialCount, it, ledgerSays, owedEntry, retainedEntry, runningEntry, settledOnDisk, setupHarness, sleep, textDeclaresKind, tmpProjectDir, waitFor, withEnv } from "./support/index.js";

/** A record under a version this build does not read — the key space, not a field. */
const aPastLedger = (childSessionId = "ses_old") => `ledger/v${LEDGER_VERSION - 1}/retained/${childSessionId}`;

/** Boot on a ledger the case shapes, and hand back the world every case here wants. */
const bootedOn = async (shape, hooks) => {
  const { directory, ...rest } = await bootOn(shape, hooks);
  // The nested `h` carries the directory too, so the reader helpers that take the
  // harness can spell THIS project's keys — a reader that cannot name the root it
  // reads would silently scan the whole namespace again.
  return { directory, h: { ...rest, directory }, ...rest };
};

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

  const onDisk = (h) => ledgerSays(h.kv, h.directory);
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
  const bootWithRunners = (actives, hostTurnSeed) => bootWithLedger(bootedOn, { active: actives }, { hooks: { hostTurnSeed } });

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

  const ledgerActive = (h) => ledgerSays(h.kv, h.directory).active;

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
    const { h, notices, pluginLog } = await bootWithLedger(bootedOn, { active: { ses_first: runningEntry("ses_first"), ses_second: runningEntry("ses_second") } },
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
  const activeIds = (h) => Object.keys(ledgerSays(h.kv, h.directory).active).toSorted();

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

  /**
   * Two instances, one project, one child BOTH of them saw running.
   *
   * The active record is the one durable fact a second process reads at boot, and
   * the host is told the turn is open so each instance's reconciliation leaves the
   * child running rather than inventing a vanished-child error. `sessionPrefix`
   * tells the two fake hosts apart; the KV is SHARED, which is what the host gives
   * two windows on one repo.
   */
  const twoInstancesSeeing = async (child) => {
    const directory = tmpProjectDir();
    const kv = new Map();
    kv.set(LEDGER_KEYS.active(directory, child), JSON.stringify(runningEntry(child)));
    const turnOpen = { hostTurnSeed: { [child]: undefined } };
    const a = await setupHarness({ directory, domain: { kv }, hooks: { sessionPrefix: "a", ...turnOpen } });
    const b = await setupHarness({ directory, domain: { kv }, hooks: { sessionPrefix: "b", ...turnOpen } });
    return { a, b };
  };

  /**
   * B is a DIFFERENT process, so its claim memory is its own. Clearing the
   * process-global gate is how that boundary is modelled — the same move `boot()`
   * makes — and it is exactly the singleton that hid this case: without the reset
   * the second instance's settlement is suppressed IN PROCESS and the case proves
   * nothing. With it, the second delivery is decided by the SHARED store or not at
   * all, which is the question a second window actually asks.
   */
  const settleAsSecondProcess = async (h, child) => {
    clearNotifyLedger();
    await h.settle(child);
    await sleep(50);
  };

  /**
   * Two instances, one project, one child both saw. Runs `beforeSettle(a, child)`
   * on the first instance, then settles as the second process. Returns both
   * harnesses and the shared child id — the setup every two-instance case
   * repeats.
   */
  const twoInstancesOneSettlement = async (beforeSettle) => {
    const child = "ses_shared";
    const { a, b } = await twoInstancesSeeing(child);
    if (beforeSettle) await beforeSettle(a, child);
    await settleAsSecondProcess(b, child);
    return { a, b, child };
  };

  // The case whose absence the comment here used to record as the finding. Two
  // windows, one child, one settlement each: the parent must hear it once.
  it("delivers a settlement both instances saw exactly once", async () => {
    const { a: fa, b: fb } = await twoInstancesOneSettlement(async (a, child) => {
      // first instance settles the child
      await a.settle(child);
      await waitFor(() => a.notices().length === 1, "the first instance's settlement to reach the parent");
    });

    assert.strictEqual(
      fa.notices().length + fb.notices().length,
      1,
      `one settlement, one notice, across two instances — got: ${JSON.stringify([...fa.notices(), ...fb.notices()].map((n) => n.message))}`,
    );
  });

  // The complement, and the reason the second instance cannot simply be silenced:
  // a settlement and a mid-flight notice are DIFFERENT facts about one child, and
  // collapsing them would swallow one. This is the guard against over-suppression.
  it("still delivers a distinct notice for the same child", async () => {
    const child = "ses_shared";
    const { a, b } = await twoInstancesSeeing(child);
    await a.child(child).notify("first words");
    await waitFor(() => a.notices().length === 1, "the mid-flight notice");
    await settleAsSecondProcess(b, child);
    await waitFor(() => a.notices().length + b.notices().length >= 2, "the settlement beside the notice");

    assert.deepStrictEqual([a.notices().length + b.notices().length], [2],
      "a notice and a settlement are two facts, delivered independently");
  });
});
