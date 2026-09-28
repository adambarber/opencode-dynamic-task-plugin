/**
 * task-formatting.ts — what the operator reads.
 *
 * The background prompt, the result summary, and the two fleet views (a tree, and
 * one task's detail). Every claim below is about prose, so the fixtures are the
 * production builders: a hand-written record would be a second declaration of a
 * shape with no compiler over it, and it drifts silently in both directions.
 */

import { describe, it, assert } from "./support/runner.js";
import { buildBackgroundPrompt, formatTaskListSummary, formatTaskResultSummary, formatTaskStatusDetail, taskResultRecord } from "../../dist/shared/task-formatting.js";
import { noticeRecord } from "../../dist/shared/task-state.js";
import { notifiedAs } from "./support/records.js";

// The record the view formatters read. Production owns the shape
// (taskResultRecord) and the boring truth that goes with it; what is left here is
// this suite's fixture story — a completed, tracked turn with a short latest
// output — so a case states the field it is actually about. `messageCount` used
// to be spelled out as 1 with no assertion behind it: a declared field is a claim
// that the field matters, and this one never did.
const resultRecord = (overrides = {}) =>
  taskResultRecord({ sessionId: "s", status: "completed", latestText: "hi", tracked: true, ...overrides });

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
    childSessionId: "ses_1", parentSessionId: "p", agentName: "a", description: "d",
    lineage: [], state: "active", startedAt: Date.now(), retainedAt: Date.now(),
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
    task: taskRecord({ state: "error", failureClass }),
  }));

  it("task_result names the class of a settled failure", () => {
    assert.strictEqual(
      classLine(erroredWith("transient")),
      "Failure class: transient — a network or provider blip, not the work. Nothing here to investigate; the child resumes from where it stopped.",
    );
  });

  it("task_status names it beside the settled clock", () => {
    const detail = formatTaskStatusDetail(taskRecord({ state: "error", failureClass: "structural" }));
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
    tree: [],
    activeCount: 0,
    retained: rows,
    maxConcurrent: 4,
    pruned: 0,
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
    const summary = summaryOf([{ verb: "edit", path: "/p/a.ts", incomplete: false }]);
    assert.match(summary, /Changed: edit \/p\/a\.ts/);
  });

  // A change that never completed is not the same amount of work to redo as one
  // that landed, and a file listing cannot tell them apart.
  it("says which of them did not finish", () => {
    const summary = summaryOf([{ verb: "write", path: "/p/b.ts", incomplete: true }]);
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
      liveness: { hostState: "busy", lastMessageAt: Date.now() - 1000 },
    }));
    assert.match(result, /Status: active/);
    assert.match(result, /Server status: busy/);
    assert.match(result, /Last child message: 1s ago/);
    assert.match(result, /Last plugin event: 0s ago/);
    // A working child carries no warning: silence is a claim the sources do not
    // support, and a store that says active is the authority on settleability.
    assert.ok(!result.includes("Warning"), `no warning while the server says busy. got: ${result}`);
  });

  it("never infers a status the sources did not state", () => {
    const result = formatTaskResultSummary(resultRecord({
      status: "completed",
      task: taskRecord({ state: "completed" }),
      liveness: { hostState: null, lastMessageAt: null },
    }));
    assert.match(result, /Status: completed/);
    assert.ok(!result.includes("suggests"), `a guess must never render. got: ${result}`);
    // A settled record with a quiet server has no liveness question left, so
    // the block is absent rather than reporting the absence as a reading.
    assert.ok(!result.includes("Server status"), `no question, no block. got: ${result}`);
  });

  it("renders read failures in the same voice with the error as data", () => {
    // The failure case says only what the case is about: it models read.ts's
    // untracked-failure branch, so it says the read was untracked rather than
    // inheriting a fixture that claims otherwise. The shape, the zero-message
    // count and the untracked default itself all come from the production
    // builder, which is the only declaration of them.
    const result = formatTaskResultSummary(
      resultRecord({ sessionId: "ses_gone", status: "error", tracked: false, error: "boom (not retryable)" }),
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
      status: "idle",
      notification: notifiedAs("completed", { delivered: true, attempts: 2 }),
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
    assert.ok(withNotification("completed", { delivered: true, attempts: 1 }).includes("delivered in 1 attempt"));
    assert.ok(withNotification("timeout", { delivered: false, attempts: 2 }).includes("FAILED after 2 attempt"));
    assert.ok(!formatTaskResultSummary(base).includes("notification:"));
  });

  it("renders a suppressed duplicate as Suppressed, never FAILED", () => {
    const out = summaryWith("notice", { delivered: false, attempts: 0, suppressed: true }, { parentSessionId: "p1" });
    assert.ok(out.includes("Suppressed (duplicate — already delivered)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `suppression is not failure. got: ${out}`);
  });

  it("renders a parentless non-delivery honestly", () => {
    const out = summaryWith("completed", { delivered: false, attempts: 0 });
    assert.ok(out.includes("Not delivered (no parent session)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `nowhere to dial is not a failed dial. got: ${out}`);
  });
});

// The fleet list is a tree, so a row carries its depth and — when the parent
// that spawned it is no longer tracked — the link it lost. Both are decided
// here, at the formatter, so they are pinned here.
describe("task formatting: fleet views", () => {
  const treeRow = (over = {}) => ({
    childSessionId: "ses_a", agentName: "explore", description: "A task", state: "active",
    startedAt: Date.now() - 45_000, depth: 0, parentSessionId: "p1", parentTracked: true, ...over,
  });
  const rowFor = (summary, sessionId) =>
    summary.split("\n").find((line) => line.includes(sessionId)) ?? `(no line for ${sessionId})`;
  const listOf = (over = {}) => formatTaskListSummary({ tree: [], activeCount: 0, retained: [], maxConcurrent: 4, pruned: 0, ...over });
  // The detail view's own seam, so a case states the record it is about and the
  // words it expects rather than the renderer's two arguments. `listOf` is the
  // same seam for the fleet view; a case that spelled either one out was writing
  // the fixture again.
  const detailOf = (over = {}, notification = null) => formatTaskStatusDetail(taskRecord(over), notification);
  /** The words a rendered block has to carry — the claim every case below is a list of. */
  const renders = (text, words) => {
    for (const word of words) assert.ok(text.includes(word), `${word} must be rendered. got: ${text}`);
  };

  it("formatTaskListSummary counts the running rows and indents the tree", () => {
    const now = Date.now();
    const summary = listOf({
      tree: [
        treeRow({ startedAt: now - 45_000 }),
        treeRow({ childSessionId: "ses_b", depth: 1, parentSessionId: "ses_a", startedAt: now - 5000 }),
      ],
      activeCount: 2,
      retained: [{
        childSessionId: "ses_r", agentName: "reviewer", description: "R task",
        state: "completed", startedAt: now - 5000,
      }],
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
    const summary = listOf({ tree: [treeRow({ parentTracked: false, parentSessionId: "ses_gone" })], activeCount: 1 });
    assert.match(rowFor(summary, "ses_a"), /spawned by ses_gone, not tracked/, `got: ${summary}`);
  });

  it("formatTaskListSummary names empty states", () => {
    assert.ok(listOf().includes("(none)"));
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
    const working = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000, lastActivityAt: Date.now() - 2000 });
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
      description: "Deep dive",
      lineage: ["planner"],
      startedAt: 1,
      requestedModel: { providerID: "prov", modelID: "model" },
      dependsOn: ["ses_dep"],
      lastNotice: noticeRecord("blocked on credentials", "needs_input", Date.now()),
    });
    renders(detail, ["ses_1", "planner", "prov/model", "ses_dep", "blocked on credentials"]);
  });

  it("formatTaskStatusDetail surfaces delivery records", () => {
    const detail = detailOf(
      { state: "completed", startedAt: 1, retainedAt: 2 },
      notifiedAs("error", { delivered: false, attempts: 2 }),
    );
    renders(detail, ["FAILED"]);
  });
});
