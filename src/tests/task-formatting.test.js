/**
 * task-formatting.ts — what the operator reads.
 *
 * The background prompt, the result summary, and the two fleet views (a tree, and
 * one task's detail). Every claim below is about prose, so the fixtures are the
 * production builders: a hand-written record would be a second declaration of a
 * shape with no compiler over it, and it drifts silently in both directions.
 */

import { agentDisplayName, buildBackgroundPrompt, formatTaskListSummary, formatTaskResultSummary, formatTaskStatusDetail, taskResultRecord } from "../../dist/shared/task-formatting.js";
import { assert, describe, it } from "./support/runner.js";
import { SessionExistence } from "../../dist/shared/liveness.js";
import { noticeRecord } from "../../dist/shared/notice-claim.js";
import { notifiedAs } from "./support/records.js";

/**
 * A liveness reading in the shape `readLiveness` returns.
 *
 * The two fields it takes are the whole of the gap this fix closed: `hostTurn` is a
 * host WORD or absent (never a null the plugin made up), and `statusAnswered` says
 * whether anyone managed to ask. So the fixture has no way to say "the channel
 * answered and found nothing" and no way to say "the channel failed" — those are
 * `reading(undefined, …)` and a second factory, not one overloaded null.
 */
const reading = (hostTurn, lastMessageAt) => ({
  existence: SessionExistence.Present,
  hostTurn,
  lastMessageAt,
  messageCount: 1,
  statusAnswered: true,
});

// The record the view formatters read. Production owns the shape
// (taskResultRecord) and the boring truth that goes with it; what is left here is
// this suite's fixture story — a completed, tracked turn with a short latest
// output — so a case states the field it is actually about. `messageCount` used
// to be spelled out as 1 with no assertion behind it: a declared field is a claim
// that the field matters, and this one never did.
const resultRecord = (overrides = {}) =>
  taskResultRecord({ latestText: "hi", sessionId: "s", status: "completed", tracked: true, ...overrides });

// A settled store record beside a stated turn reading: the shape two cases below
// share, which differ only in the reading they place beside it.
const settledRecord = (liveness) => resultRecord({ liveness, status: "completed", task: taskRecord({ state: "completed" }) });

/**
 * formatTaskResultSummary over a settled record carrying this notification, and
 * the notification itself is the gate's own builder — a case names the delivery
 * outcome it is about, not the fields of a NotificationRecord. Five of these were
 * spelled out by hand in one file, which is how `claim` went missing from a
 * `lastNotice` in the same file: a record declared by hand drifts silently, and
 * nothing in an untyped test file notices.
 */
function summaryWith(kind, outcome, target = {}) {
  return formatTaskResultSummary({ ...resultRecord(), notification: notifiedAs(kind, outcome, target) });
}

// The active-task record the fleet views read. Every field the renders read is
// present, because a fixture that omits a required one renders as NaN and the
// test then asserts on nonsense.
function taskRecord(overrides = {}) {
  return {
    agentName: "a", childSessionId: "ses_1", description: "d", lineage: [], parentSessionId: "p", retainedAt: Date.now(), startedAt: Date.now(), state: "active",
    ...overrides,
  };
}

describe("buildBackgroundPrompt", () => {
  it("adds explicit background instructions before user prompt", () => {
    const result = buildBackgroundPrompt("Return COMPLETED_OK when done.");
    assert.match(result, /You are running as a background child task\./);
    assert.match(result, /Return a final, self-contained answer\./);
    assert.match(result, /preempts your current turn/);
    assert.match(result, /never wait/);
    assert.match(result, /Return COMPLETED_OK when done\./);
  });
});

// A parent inspecting a settled child minutes later asks one question the
// notification cannot answer any more: was this the network or was this the
// work? The record is the only thing that outlives the moment, so if the class
// is not rendered here it is not recoverable at all.
describe("readers say WHY a child failed", () => {
  // The class line, exactly, or "" when the reader rendered none. Asserting the
  // whole line rather than a substring is what makes the three cases below one
  // fact instead of three regexes — and it is the label that is the contract, so
  // it is the label a reader can be held to.
  const classLine = (rendered) => /^Failure class: \w+.*$/m.exec(rendered)?.[0] ?? "";

  /**
   * formatTaskResultSummary over an errored, settled child carrying this class.
   * A local builder because the record-and-render call is long enough to read as
   * a clone of the other cases in this file at the gate's floor — and a case
   * should name the class it is about, not the four fields that get it there.
   */
  const erroredWith = (failureClass) => formatTaskResultSummary(resultRecord({
    status: "error",
    task: taskRecord({ failureClass, state: "error" }),
  }));

  it("task_result names the class of a settled failure", () => {
    assert.strictEqual(
      classLine(erroredWith("transient")),
      "Failure class: transient — a network or provider blip, not the work. Nothing here to investigate; the child resumes from where it stopped.",
    );
  });

  it("task_status names it beside the settled clock", () => {
    const detail = formatTaskStatusDetail(taskRecord({ failureClass: "structural", state: "error" }));
    assert.strictEqual(classLine(detail), "Failure class: structural — the work failed, not the connection. This one is a real failure and needs a decision.");
  });

  // The class only means something if it is absent on a success too: a renderer
  // that printed the line unconditionally would teach the parent to ignore it.
  it("a child that finished says nothing about a failure class", () => {
    const result = formatTaskResultSummary(resultRecord({ task: taskRecord({ state: "completed" }) }));
    assert.strictEqual(classLine(result), "", "a success has no class to report");
  });
});

// A fleet view that says "Retained: 9" makes the parent read nine lines to learn
// whether anything went wrong, and the answer it most needs is the one a count
// cannot give: is this nine successes, or five successes and four failures? The
// rollup is the shape, in the same words the class line uses, so a parent that
// has read one notification can read the other.
describe("the retained roll-up says the SHAPE of a fleet, not its size", () => {
  const listOf = (rows) => formatTaskListSummary({
    activeCount: 0,
    maxConcurrent: 4,
    pruned: 0,
    retained: rows,
    tree: [],
  });

  const retained = (state, failureClass) => ({ ...taskRecord({ state }), failureClass });

  it("counts each state, and says how many failures were the network's", () => {
    const list = listOf([
      retained("completed"), retained("completed"), retained("completed"),
      retained("error", "structural"), retained("error", "transient"),
      retained("interrupted"),
    ]);
    assert.match(
      list,
      /Retained: 6 — 3 completed · 2 error \(1 transient\) · 1 interrupted/,
      "the count alone cannot tell a parent whether to investigate",
    );
  });

  // A state nobody has hit must not appear as a zero: "0 blocked" on every
  // ordinary list is noise that teaches a parent to skip the line.
  it("leaves out every state with nothing in it", () => {
    assert.match(listOf([retained("completed")]), /Retained: 1 — 1 completed\n/);
  });

  it("keeps a bare count when there is nothing retained at all", () => {
    assert.match(listOf([]), /Retained: 0\n/);
  });
});

// When a child dies, the parent has to reconstruct what it was in the middle of,
// and the one fact it cannot get any other way is which files that child changed.
// A dirty working tree will not answer it: those files belong to every child
// running against the project at once. The child's own transcript can, and
// task_result already reads it to count messages, so the brief is free.
describe("task_result briefs the parent on what the child touched", () => {
  const summaryOf = (touchedFiles) => formatTaskResultSummary(resultRecord({ touchedFiles }));

  it("names each change with its verb, so a read is not mistaken for one", () => {
    const summary = summaryOf([{ incomplete: false, path: "/p/a.ts", verb: "edit" }]);
    assert.match(summary, /Changed: edit \/p\/a\.ts/);
  });

  // A change that never completed is not the same amount of work to redo as one
  // that landed, and a file listing cannot tell them apart.
  it("says which of them did not finish", () => {
    const summary = summaryOf([{ incomplete: true, path: "/p/b.ts", verb: "write" }]);
    assert.match(summary, /write \/p\/b\.ts \(incomplete\)/);
  });

  // A child that read forty files and changed nothing has said something true and
  // useful by saying this, and a line of forty reads would bury it.
  it("stays silent for a child that changed nothing", () => {
    assert.strictEqual(summaryOf([]).includes("Changed:"), false);
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary(resultRecord({ status: "busy" }));
    assert.match(result, /Recommended next action: use task_status for settleability/);
    assert.match(result, /Tracked: yes/);
  });

  it("renders the store state for active tasks with the sourced liveness beside it", () => {
    const result = formatTaskResultSummary(resultRecord({
      status: "active",
      task: taskRecord(),
      // A turn in progress is the host recording NO verdict — the outcome belongs
      // to a COMPLETED execution, so an open turn has nothing on the session yet.
      liveness: reading(undefined, Date.now() - 1000),
    }));
    assert.match(result, /Status: active/);
    assert.match(result, /Server turn: in progress/);
    assert.match(result, /Last child message: 1s ago/);
    assert.match(result, /Last plugin event: 0s ago/);
    // A working child carries no warning: silence is a claim the sources do not
    // support, and a store that says active is the authority on settleability.
    assert.ok(!result.includes("Warning"), `no warning while the server says busy. got: ${result}`);
  });

  it("never infers a status the sources did not state", () => {
    // "Quiet" in v2 is a turn the host CLOSED, not a turn it never finished
    // recording. An open turn is a positive claim, and this case is about
    // the absence of a question — which is the closed turn.
    const result = formatTaskResultSummary(settledRecord(reading("succeeded", null)));
    assert.match(result, /Status: completed/);
    assert.ok(!result.includes("suggests"), `a guess must never render. got: ${result}`);
    // A settled record with a quiet server has no liveness question left, so
    // the block is absent rather than reporting the absence as a reading.
    assert.ok(!result.includes("Server turn"), `no question, no block. got: ${result}`);
  });

  // The disagreement v2 makes visible and v1 could not express. A settled record
  // beside a turn the host has not closed is not a quiet server; it is two sources
  // saying opposite things, and the view that hides it is the view an operator
  // consults precisely when the two disagree.
  it("surfaces a settled record the host still calls a running turn", () => {
    const result = formatTaskResultSummary(settledRecord(reading(undefined, Date.now() - 1000)));
    assert.match(result, /Server turn: in progress/,
      "the host's open turn is stated even though the store says the task is done");
    assert.match(result, /Status: completed/, "and the store's own state is not overwritten by it");
  });

  it("renders read failures in the same voice with the error as data", () => {
    // The failure case says only what the case is about: it models read.ts's
    // untracked-failure branch, so it says the read was untracked rather than
    // inheriting a fixture that claims otherwise. The shape, the zero-message
    // count and the untracked default itself all come from the production
    // builder, which is the only declaration of them.
    const result = formatTaskResultSummary(
      resultRecord({ error: "boom (not retryable)", sessionId: "ses_gone", status: "error", tracked: false }),
    );
    assert.match(result, /^## Task Result/);
    assert.match(result, /Status: error/);
    assert.match(result, /Error: boom \(not retryable\)/);
    assert.match(result, /Messages: 0/, "a read that produced nothing reports no messages");
    assert.match(result, /Tracked: no/, "and the plugin holds no record of it");
  });

  it("includes recovery guidance for error status", () => {
    const result = formatTaskResultSummary(resultRecord({ status: "error", tracked: false }));
    assert.match(result, /Recommended next action: inspect latest output/);
    assert.match(result, /Tracked: no/);
  });

  it("surfaces delivery attempts when provided", () => {
    const result = formatTaskResultSummary(resultRecord({
      notification: notifiedAs("completed", { attempts: 2, delivered: true }),
      status: "idle",
    }));
    assert.match(result, /Last notification: completed \(delivered in 2 attempt/);
  });

  it("never truncates latest output — pull path is full text", () => {
    const body = "y".repeat(5000);
    const result = formatTaskResultSummary(resultRecord({ latestText: body }));
    assert.ok(result.includes(body), "operator-pulled output must be complete");
  });

  it("surfaces delivery records", () => {
    const base = resultRecord();
    const withNotification = (kind, outcome) =>
      formatTaskResultSummary({ ...base, notification: notifiedAs(kind, outcome) });
    assert.ok(withNotification("completed", { attempts: 1, delivered: true }).includes("delivered in 1 attempt"));
    assert.ok(withNotification("timeout", { attempts: 2, delivered: false }).includes("FAILED after 2 attempt"));
    assert.ok(!formatTaskResultSummary(base).includes("notification:"));
  });

  it("renders a suppressed duplicate as Suppressed, never FAILED", () => {
    const out = summaryWith("notice", { attempts: 0, delivered: false, suppressed: true }, { parentSessionId: "p1" });
    assert.ok(out.includes("Suppressed (duplicate — already delivered)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `suppression is not failure. got: ${out}`);
  });

  it("renders a parentless non-delivery honestly", () => {
    const out = summaryWith("completed", { attempts: 0, delivered: false });
    assert.ok(out.includes("Not delivered (no parent session)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `nowhere to dial is not a failed dial. got: ${out}`);
  });
});

// The fleet list is a tree, so a row carries its depth and — when the parent
// that spawned it is no longer tracked — the link it lost. Both are decided
// here, at the formatter, so they are pinned here.
describe("task formatting: fleet views", () => {
  const treeRow = (over = {}) => ({
    agentName: "explore", childSessionId: "ses_a", depth: 0, description: "A task", parentSessionId: "p1", parentTracked: true, startedAt: Date.now() - 45_000, state: "active", ...over,
  });
  const rowFor = (summary, sessionId) =>
    summary.split("\n").find((line) => line.includes(sessionId)) ?? `(no line for ${sessionId})`;
  const listOf = (over = {}) => formatTaskListSummary({ activeCount: 0, maxConcurrent: 4, pruned: 0, retained: [], tree: [], ...over });
  // The detail view's own seam, so a case states the record it is about and the
  // words it expects rather than the renderer's two arguments. `listOf` is the
  // same seam for the fleet view; a case that spelled either one out was writing
  // the fixture again.
  const detailOf = (over = {}, notification = null) => formatTaskStatusDetail(taskRecord(over), notification);
  /** The words a rendered block has to carry — the claim every case below is a list of. */
  const renders = (text, words) => {
    for (const word of words) assert.ok(text.includes(word), `${word} must be rendered. got: ${text}`);
  };
  /** One agent's occupancy, in the shape the reader hands the formatter. */
  const occupancy = (agent, over = {}) => ({
    active: 0, agent, depthBoundBy: null, depthConfigured: 2, depthEffective: 2, maxConcurrent: 4, stated: {}, ...over,
  });
  /** A rendered list as its LINES, for the two cases that are about where blocks sit. */
  const linesOf = (over = {}) => listOf(over).split("\n");
  /** Where a block starts, in lines. -1 when the block was not rendered at all. */
  const blockAt = (lines, at) => lines.findIndex((line) => line.startsWith(at));
  /** The smallest fleet there is: one running task, nothing retained, no agent set. */
  const ONE_TASK = { activeCount: 1, tree: [treeRow()] };

  // One seam for the two cases below, so each names the STATE it is about rather
  // than re-spelling the record and the render chain — which jscpd reads as a
  // clone of every other 4-line fixture in this file, whether or not any logic
  // is shared.
  const rendering = (over) => detailOf({}, notifiedAs("error", { attempts: 3, delivered: false, ...over }));

  it("renders a written-off notice as EXPIRED, not as a failure", () => {
    // The one fact a parent can act on. "FAILED" says the plugin tried and lost
    // it, and the reader looks for a retry that is not coming; "EXPIRED" says the
    // plugin stopped trying, which means the parent session is not accepting
    // writes at all. A written-off notice rendered as a failure is a notice that
    // looks like a glitch — and the parent is the only reader positioned to fix it.
    const detail = rendering({ expired: true });

    assert.match(detail, /EXPIRED/);
    assert.match(detail, /undelivered after 3 attempt\(s\)/);
    assert.match(detail, /will not be retried/);
    assert.doesNotMatch(detail, /FAILED/, "a written-off notice is not a failed one");
    assert.doesNotMatch(detail, /PENDING/, "and it is not waiting for an answer either");
  });

  it("keeps a genuinely failed notice reading as FAILED", () => {
    // The falsification of the case above: a record with the same attempt count
    // and no expiry must still read as a failure, or the two states have been
    // collapsed and the expiry word proves nothing.
    const detail = rendering({});

    assert.match(detail, /FAILED after 3 attempt\(s\)/);
    assert.doesNotMatch(detail, /EXPIRED/);
  });

  it("the display name is the stored label, and the routing id only where no label was stored", () => {
    assert.strictEqual(agentDisplayName({ agentLabel: "General", agentName: "general" }), "General");
    assert.strictEqual(agentDisplayName({ agentName: "general" }), "general");
    const summary = listOf({ tree: [treeRow({ agentName: "general" })] });
    assert.match(rowFor(summary, "ses_a"), /@general/, `a labelless row reads raw. got: ${summary}`);
  });

  it("formatTaskListSummary counts the running rows and indents the tree", () => {
    const now = Date.now();
    const summary = listOf({
      activeCount: 2,
      retained: [{
        agentName: "reviewer", childSessionId: "ses_r", description: "R task", startedAt: now - 5000, state: "completed",
      }],
      tree: [
        treeRow({ startedAt: now - 45_000 }),
        treeRow({ childSessionId: "ses_b", depth: 1, parentSessionId: "ses_a", startedAt: now - 5000 }),
      ],
    });
    assert.ok(summary.includes("Active: 2/4"), `got: ${summary}`);
    assert.ok(summary.includes("45s"), `ages render. got: ${summary}`);
    assert.ok(summary.includes("ses_r"), `history still listed. got: ${summary}`);
    assert.match(rowFor(summary, "ses_a"), /^- /, `a root sits flush. got: ${summary}`);
    assert.match(rowFor(summary, "ses_b"), /^ {2}- /, `a descendant is indented. got: ${summary}`);
  });

  // Rendered flush it would read as a root, and a root is a task whose parent
  // nobody has stopped.
  it("a row whose parent is not tracked names the link it lost", () => {
    const summary = listOf({ activeCount: 1, tree: [treeRow({ parentSessionId: "ses_gone", parentTracked: false })] });
    assert.match(rowFor(summary, "ses_a"), /spawned by ses_gone, not tracked/, `got: ${summary}`);
  });

  it("the tree ages a row from its LAST EVENT, not from its spawn", () => {
    // The two views disagreed about the same fact. `formatTaskStatusDetail` reads the
    // newest of three clocks — the event heartbeat, an explicit notice, the spawn as the
    // floor — and the tree read `startedAt` alone, so a child spawned twenty minutes ago
    // that emitted an event two seconds ago rendered `20m` beside a wedged one rendering
    // `20m`, and the only way to tell them apart was to ask about each one separately.
    //
    // The fix is not a second rule: it is the SAME reading, asked once. A view that
    // computed its own version of "when did this child last move" would be free to drift
    // from the diagnosis it is meant to corroborate, and drift here is invisible.
    const long = listOf({ activeCount: 1, tree: [treeRow({ lastActivityAt: Date.now() - 2_000, startedAt: Date.now() - 20 * 60_000 })] });
    assert.match(rowFor(long, "ses_a"), /\(2s ago\)/, "the row reports the event, so a working child does not look stale");
    assert.doesNotMatch(rowFor(long, "ses_a"), /20m/, "and not the age of its spawn, which is a different fact");
  });

  it("and marks a row the plugin has heard NOTHING from, without diagnosing it", () => {
    // Over the same threshold the detail view warns at, so the list and the diagnosis
    // cannot disagree about which rows are quiet. The words are deliberately OBSERVED
    // MOTION and not a stall: the detail view's own warning has to say "one long tool
    // call is silent too", so a row claiming a stall would be asserting something the
    // plugin cannot support. It can support "I have not heard from this child".
    const silent = listOf({ activeCount: 1, tree: [treeRow({ startedAt: Date.now() - 25 * 60_000 })] });
    assert.match(rowFor(silent, "ses_a"), /\(no events for 25m\)/, "the row says what is knowable, and stops there");
  });

  it("and leaves a row that is merely YOUNG unremarked", () => {
    // The falsifier. A marker on every row teaches the reader that the marker means
    // nothing, which is the same failure as marking nothing at all — the reader stops
    // looking either way.
    const fresh = listOf({ activeCount: 1, tree: [treeRow()] });
    assert.doesNotMatch(rowFor(fresh, "ses_a"), /no events/, "a child heard from seconds ago needs no note");
  });

  it("formatTaskListSummary names empty states", () => {
    assert.ok(listOf().includes("(none)"));
  });

  // Two cases, one claim: the per-agent block belongs BETWEEN the fleet total and the
  // tree, and when there is nothing to break down it leaves nothing behind.
  //
  // The placement is a claim about what the block IS. `Active: 2/4` is the total, the
  // agent rows are that total broken down against the caps it will be judged on, and the
  // tree is the itemised detail behind them. Rendered after the tree, the block read as
  // an appendix to the detail — a thing you scroll to for bookkeeping — when it is the
  // context the detail has to be read in: the cap beside an agent is what tells a reader
  // whether its rows are at the limit or merely near it. And the absence matters because
  // projects with no dispatchable agents never see this feature, so a separator left
  // behind where the section would have been is a hole in a list read in one pass.
  it("reads top-down: the total, then the breakdown, then the tree", () => {
    const lines = linesOf({ ...ONE_TASK, agents: [occupancy("explore", { active: 1, maxConcurrent: 2, stated: { maxConcurrent: 2 } })] });
    const total = blockAt(lines, "Active:");
    const agents = blockAt(lines, "Agents");
    const tree = lines.findIndex((line) => line.includes("ses_a"));
    assert.ok(total >= 0 && agents > total && tree > agents,
      `the breakdown belongs between the total and the detail. got: ${lines.join("\n")}`);
  });

  it("leaves no section and no gap when there is no agent set", () => {
    const lines = linesOf(ONE_TASK);
    assert.equal(blockAt(lines, "Agents"), -1, "no section for an empty agent set");
    assert.equal(lines[blockAt(lines, "Active:") + 1], lines.find((line) => line.includes("ses_a")),
      "so the tree still follows the total on the very next line");
  });

  it("formatTaskStatusDetail warns on a stalled active turn, stays factual on fresh ones", () => {
    const base = taskRecord();
    const stale = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000 });
    assert.match(stale, /Last plugin event: 20m ago/);
    assert.match(stale, /stalled/);
    assert.match(stale, /task_interrupt/);
    const fresh = detailOf({ ...base, startedAt: Date.now() });
    assert.match(fresh, /Last plugin event:/);
    assert.ok(!fresh.includes("stalled"), `fresh turns carry no warning. got: ${fresh}`);
  });

  it("formatTaskStatusDetail reads activity from observed events, not from the spawn", () => {
    const base = taskRecord();
    // 20m since spawn, an event 2s ago: the child is demonstrably working, so
    // the stall line is a false alarm and must not render.
    const working = detailOf({ ...base, lastActivityAt: Date.now() - 2000, startedAt: Date.now() - 20 * 60 * 1000 });
    assert.match(working, /Last plugin event: 2s ago/);
    assert.ok(!working.includes("stalled"), `observed activity suppresses the stall line. got: ${working}`);
    // No heartbeat yet (plugin booted after the spawn): the spawn stays the
    // honest floor and the silence stays visible.
    const unheard = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000 });
    assert.match(unheard, /Last plugin event: 20m ago/);
    assert.match(unheard, /stalled/);
  });

  it("formatTaskListSummary names pruned expiries when told", () => {
    assert.ok(listOf({ pruned: 1 }).includes("Pruned: 1 expired"), "the expiry is reported");
    assert.ok(!listOf({ pruned: 0 }).includes("Pruned:"), "silence when nothing expired");
  });

  it("formatTaskStatusDetail renders tracked metadata offline", () => {
    const detail = detailOf({
      dependsOn: ["ses_dep"],
      description: "Deep dive",
      lastNotice: noticeRecord("blocked on credentials", "needs_input", Date.now()),
      lineage: ["planner"],
      requestedModel: { modelID: "model", providerID: "prov" },
      startedAt: 1,
    });
    renders(detail, ["ses_1", "planner", "prov/model", "ses_dep", "blocked on credentials"]);
  });

  it("formatTaskStatusDetail surfaces delivery records", () => {
    const detail = detailOf(
      { retainedAt: 2, startedAt: 1, state: "completed" },
      notifiedAs("error", { attempts: 2, delivered: false }),
    );
    renders(detail, ["FAILED"]);
  });
});
