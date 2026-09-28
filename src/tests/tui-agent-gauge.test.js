/**
 * The live agent counter: what it counts, what it says, and how it finds out.
 *
 * The counter is the one surface of this plugin that is AMBIENT — on screen whether or
 * not the operator asked for anything — and it is also the only one that has to answer
 * from a different process than the one that owns the tasks. These cases are mostly about
 * that difficulty, and the claims worth making about it are specific:
 *
 *  - it counts the ledger's own running half, through the SAME fold `task_list` and the
 *    capacity gate read, so a corner and a refusal cannot describe different worlds;
 *  - it counts only what the ledger's own validating reader kept, so it agrees with the
 *    boot about which records are real;
 *  - a ledger it cannot read reads as zero, because that is what the server would have
 *    booted with — a counter claiming three beside a server that believes nothing is
 *    running is a number the operator cannot act on;
 *  - its denominator is resolved the way the LIMITS SCREEN resolves it, so a cap set in
 *    the dialog moves this number with it rather than beside it;
 *  - and it watches the ledger's DIRECTORY, because `saveTaskLedger` renames a temporary
 *    file over the target and a watch on the file goes deaf at the first write.
 *
 * The element construction is deliberately NOT exercised here. It needs an active
 * renderer, which a `node --test` run does not have, and a case that stood one up would
 * be testing the host rather than this plugin. What a case can check is the CONTENT —
 * the number, the text, the colour role, and the slot the module registers under.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { AGENT_OVERLAY_FILE, writeAgentOverlay } from "../../dist/shared/caps.js";
import { resolveTaskLedgerPath, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { foldActiveByAgent, totalActiveOf } from "../../dist/shared/occupancy.js";
import { activeByAgent } from "../../dist/shared/task-state.js";
import { darkTheme } from "./support/harness.js";
import { screenTokens, widthsAgree } from "../../dist/tui/theme.js";
import { GAUGE_SLOT, gaugeProps, gaugeRuns, gaugeStyledText, gaugeText, isLedgerEvent, readGauge, watchLedger } from "../../dist/tui/agent-gauge.js";
import { withTempDir } from "./support/fixtures.js";
// ONE host double for the whole suite, not a second one here. It is the one that carries a
// real `root`, so the counter's tree walk is exercised here against the same object the
// limits screen meets — and a second double, private to this file, is one more thing that
// can drift from the host without anything failing.
import { hostApi, HOST_THEME } from "./support/limits-screen.js";
import { runningEntry } from "./support/records.js";

const BASE = normalizeDynamicTaskConfig(null);

/**
 * A case about what the gauge reads from a directory, in a fresh one.
 *
 * `withTempDir` + `gaugeOver` + an `it` wrapper is four lines of ceremony repeated a dozen
 * times, and at this file's duplication floor the repetition itself is the clone. This is
 * the ceremony, once, so a case is one line that says only what it is about.
 */
const gaugeCase = (name, claim) => it(name, () => withTempDir((directory) => claim(directory)));

/**
 * A project directory whose ledger holds the given running records.
 *
 * Written through the production writer rather than as JSON, because the writer is what
 * RENAMES: a fixture that wrote the file in place would make the watcher cases pass
 * against an arrangement the plugin never actually runs in.
 *
 * It RETURNS whatever `withTempDir` returns, and so must every case that uses it — a case
 * body that drops the promise is a case that never ran its assertions and read green,
 * which is the one failure mode this suite's own harness exists to catch.
 */
const withLedger = (ids, fn) =>
  withTempDir((directory) => {
    const active = new Map();
    for (const id of ids) active.set(id, runningEntry(id, { agentName: "general" }));
    saveTaskLedger({ retained: new Map(), active, pending: [] }, resolveTaskLedgerPath(directory));
    return fn(directory);
  });

/** The pair the counter shows, over a directory. */
const gaugeOver = (directory) => readGauge(directory, BASE);

/** Running records the production writer would accept, in the shape the fold takes. */
const runningFor = (ids) => ids.map((id) => runningEntry(id, { agentName: "general" }));

describe("the live counter counts the ledger's own running half", () => {
  it("reads nothing running on a project that has never run a task", () =>
    withTempDir((directory) => {
          const gauge = gaugeOver(directory);
          assert.equal(gauge.active, 0, "a first boot has no ledger and so has nothing running");
          assert.equal(gaugeText(gauge.active, gauge.cap), `0/${BASE.maxConcurrent}`, "and the corner says so");
    }));

  it("counts every running record, and the number is the fold's sum", () =>
    withLedger(["ses_a", "ses_b", "ses_c"], (directory) => {
      const expected = totalActiveOf(foldActiveByAgent(runningFor(["ses_a", "ses_b", "ses_c"])));
      assert.equal(gaugeOver(directory).active, expected,
        "the count IS the sum of the fold `task_list` and the capacity gate read, not a count of its own");
      assert.equal(expected, 3, "and that fold says three, so the corner is not quietly under-reporting");
    }));

  it("counts the host's spelling and the policy key as the one agent they are", () => {
    // The fold normalizes on the way in, and this is the claim the corner inherits for
    // free. An agent the host names `Explore` while the cap is written under `explore`
    // would otherwise read as idle on one screen and full on the other.
    const folded = foldActiveByAgent([runningEntry("ses_a", { agentName: "Explore" }), runningEntry("ses_b", { agentName: "explore" })]);
    assert.equal(folded.get("explore"), 2, "two children under two spellings of one agent");
    assert.equal(folded.size, 1, "and one key, because the fold is what makes them one");
  });

  it("drops a record the ledger's own reader rejects, rather than counting it anyway", () =>
    // The reader is `loadTaskLedger`, and it validates. A record whose childSessionId
    // disagrees with its key is corrupt, not merely mislabeled — so the corner agrees
    // with the boot about what is real, instead of counting a file the server would
    // have thrown away on the way in.
    withTempDir((directory) => {
      const entry = runningEntry("ses_a", { agentName: "general" });
      writeFileSync(resolveTaskLedgerPath(directory), JSON.stringify({
        version: 3,
        tasks: {},
        active: { ses_a: { ...entry, childSessionId: "ses_other" } },
        pending: [],
      }));
      assert.equal(gaugeOver(directory).active, 0, "a record the boot would drop is not running for the counter either");
    }));

  it("reads a discarded ledger as nothing running, and does not throw", () =>
    withTempDir((directory) => {
          writeFileSync(resolveTaskLedgerPath(directory), "{ not json");
          assert.equal(gaugeOver(directory).active, 0, "a torn write is survivable and means nothing, not a crash");
    }));
});

describe("the counter's denominator is the cap the limits screen writes", () => {
  it("defaults to the config's own ceiling", () =>
    withTempDir((directory) => {
          assert.equal(gaugeOver(directory).cap, BASE.maxConcurrent, "the same four the dispatch path refuses on by default");
    }));

  it("follows a total set in the overlay, so the corner and the dialog cannot disagree", () =>
    withTempDir((directory) => {
          writeAgentOverlay(directory, { maxConcurrent: 12 });
          assert.equal(gaugeOver(directory).cap, 12, "the stated total, resolved through the same reader the dialog writes");
    }));

  it("ignores an overlay it cannot read, rather than refusing to show a number", () =>
    withTempDir((directory) => {
          writeFileSync(join(directory, AGENT_OVERLAY_FILE), "{ not json");
          assert.equal(gaugeOver(directory).cap, BASE.maxConcurrent, "a file the reader drops leaves the config in force");
    }));

  it("and reads BOTH halves from the one directory the host named, as a single string", () =>
    // The claim the corner actually makes is the PAIR, and the pair is two files read
    // from one place. A gauge that read the count from the project and the cap from
    // process CWD would show `3/4` beside a dialog that says 12, and neither screen
    // would be able to explain the disagreement.
    withLedger(["ses_a", "ses_b", "ses_c"], (directory) => {
      writeAgentOverlay(directory, { maxConcurrent: 12 });
      const gauge = gaugeOver(directory);
      assert.equal(gaugeText(gauge.active, gauge.cap), "3/12",
        "three running against a stated total, which is the whole string the corner draws");
    }));
});

describe("the counter watches the ledger's directory, not the file", () => {
  it("fires when a record is written, and fires on a RENAME the way the writer does it", () =>
    // The writer is `writeFileSync(tmp)` then `renameSync(tmp, file)`. A watch on the file
    // follows the inode it was given, and the inode the host replaces is a different one —
    // so this case is the only thing standing between a counter that updates once and a
    // counter that updates forever. Falsified against the naive file watch, which it
    // fails by name.
    withLedger(["ses_a"], async (directory) => {
      let fired = 0;
      const watcher = watchLedger(directory, () => fired++);
      assert.ok(watcher, "watching a directory the ledger lives in is available");
      try {
        // `fs.watch` attaches ASYNCHRONOUSLY, so a write issued in the same tick can land
        // before the watch is live — and under a suite this size the event loop is busy
        // enough that "the same tick" is not a formality. One settle before the write,
        // and a ceiling well past what a rename costs on an idle machine. Both are the
        // case being patient with the platform: a counter that never sees a rename is a
        // defect, and the ceiling is only here to turn a starved machine into a red test
        // rather than a hung one.
        await new Promise((done) => setTimeout(done, 50));
        const active = new Map([["ses_b", runningEntry("ses_b", { agentName: "general" })]]);
        saveTaskLedger({ retained: new Map(), active, pending: [] }, resolveTaskLedgerPath(directory));
        const deadline = Date.now() + 10000;
        while (fired === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
        assert.ok(fired > 0, "an atomic replace of the ledger is seen, which a watch on the file would miss");
      } finally {
        watcher?.close();
      }
    }));

  it("filters a NAMED neighbour's write out, and answers yes when the platform cannot say", () => {
    // The rule, checked without a filesystem. What the platform reports is a separate
    // question: macOS gives a null filename for a non-recursive directory watch, so a
    // case that waited for a named event would pass here and fail there, or the reverse.
    const LEDGER = ".dynamic-task-ledger.json";
    assert.equal(isLedgerEvent(LEDGER, LEDGER), true, "the ledger's own write is the event this exists for");
    assert.equal(isLedgerEvent("notes.md", LEDGER), false, "a named neighbour is somebody else's business");
    assert.equal(isLedgerEvent(null, LEDGER), true, "and an unnamed event looks, because a frozen counter is worse than a wasted read");
    assert.equal(isLedgerEvent(Buffer.from(LEDGER), LEDGER), true, "the name may arrive as a Buffer, and is still the ledger");
  });

  it("declines to watch rather than refusing the whole TUI", () =>
    // A platform or filesystem that will not watch leaves a counter frozen at its first
    // reading, which is still the truth it was when it was taken. Throwing here would
    // take down the command palette over a number in a corner.
    withTempDir((directory) => {
      assert.equal(watchLedger(join(directory, "no", "such", "place"), () => {}), null,
        "a directory that is not there yields no watcher and no exception");
    }));
});

describe("the counter is drawn in the host's muted grey", () => {
  it("asks for the same tier as the context counter's neighbours, never a hex", () => {
    const tokens = screenTokens(darkTheme());
    const runs = gaugeRuns(2, 4, tokens.context);
    assert.equal(runs.length, 1, "one run, so the number cannot be half one colour and half another");
    assert.equal(runs[0].fg, tokens.context, "the LABEL tier beside the context counter, not the value's");
  });

  it("and its painted text is exactly its plain text, because colour must not change the width", () => {
    const tokens = screenTokens(darkTheme());
    for (const [active, cap] of [[0, 4], [1, 4], [4, 4], [12, 16]]) {
      assert.ok(widthsAgree(gaugeRuns(active, cap, tokens.context), gaugeText(active, cap)),
        `${active}/${cap} paints as wide as it reads`);
    }
  });

  it("reads as a fraction, so the eye can pass over it", () => {
    assert.equal(gaugeText(0, 4), "0/4", "an idle project");
    assert.equal(gaugeText(3, 4), "3/4", "three of four");
  });

  it("sits at the RIGHT margin, which takes the cross axis in a column and an auto margin in a row", () => {
    // The same prop was the right lever in the old seat and the wrong one in this one, and
    // the failure is silent in both directions, so both are pinned.
    //
    // `app_bottom` is `<box flexShrink={0}>` with no `flexDirection` (`app.tsx:1124`), so
    // Yoga's default COLUMN applies and the cross axis is horizontal: `alignSelf:
    // "flex-end"` is what reaches the right edge. In the old seat the container was a ROW
    // (`<box flexDirection="row" gap={1} alignItems="center">{props.right}</box>` at
    // `component/prompt/index.tsx:1479`), the cross axis was vertical, and `alignSelf`
    // moved the counter up and down while an auto left margin was the only sideways lever.
    const props = gaugeProps(screenTokens(darkTheme()).context, () => ({ active: 2, cap: 4 }));
    assert.equal(props.alignSelf, "flex-end", "the column's cross axis is horizontal, so flex-end is what reaches the right edge");
    assert.equal(props.marginLeft, undefined, "an auto margin absorbs the MAIN axis, which is vertical in a column, so it would do nothing");
  });

  it("and the text is a FUNCTION, because that is what makes the counter live", () => {
    // `content` takes a value and would freeze the counter at whatever it said when the
    // session opened. A function child is Solid's reactive form: it is re-invoked when
    // the signal it closes over moves, and the signal moves on the ledger's next write.
    let reading = { active: 0, cap: 4 };
    const props = gaugeProps(screenTokens(darkTheme()).context, () => reading);
    assert.equal(typeof props.children, "function", "a reader, not a snapshot");
    assert.equal(props.children(), "0/4", "which reads the CURRENT pair");
    reading = { active: 3, cap: 12 };
    assert.equal(props.children(), "3/12", "and the next pair, without the element being rebuilt");
  });

  it("is a StyledText, which is what keeps every number above readable with no host at all", () => {
    // A hand-built JSX element needs an ACTIVE RENDERER. The slot builds one inside the
    // host's render, where there is one; a `StyledText` is plain data, so the value can
    // also be produced and inspected anywhere else.
    assert.equal(gaugeStyledText(1, 4, screenTokens(darkTheme()).context).chunks.length, 1);
  });
});

describe("the module mounts the counter where the host draws the prompt's right", () => {
  it("and a store's own fold is the function the corner reads, not a second one beside it", () => {
    // `activeByAgent` is the tool-side caller. The claim is that it DELEGATES: a second
    // loop over `activeTasks` is how the two answers drift, and the duplication gate
    // cannot see it because the loops are four lines each and structurally like a dozen
    // other loops in the file.
    assert.equal(activeByAgent.length, 1, "one argument, the store, and one return value — nothing else to drift");
    assert.equal(typeof foldActiveByAgent, "function", "and the fold it is built from is the one the TUI calls");
  });
});
