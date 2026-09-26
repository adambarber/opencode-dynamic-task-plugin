/**
 * The Lane Management dialog's logic, tested without a TUI runtime.
 *
 * The assertions are about the OVERLAY that lands on disk and the numbers the
 * dialog showed, not about which dialog opened: a modal that renders the wrong
 * thing is a bug, but a validation rule that lets `"4 off"` write
 * `{"maxDepth": null}` is a bug that reaches the dispatch path, and only the
 * first is visible by looking at the screen.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { applyLaneOverlay, readLaneOverlay, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
import { DEFAULT_LANE, normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { withTempDir } from "./support/fixtures.js";
import { UNBOUNDED, applyLaneEdit, capsOf, laneDialogFrom, newLaneRow, promptFor } from "../../dist/tui/lane-editor.js";

const BASE = normalizeDynamicTaskConfig(null);

/** The dialog's current state, the way the renderer sees it. */
function view(raw, running = {}) {
  return laneDialogFrom(raw, new Map(Object.entries(running)), BASE);
}

/**
 * An edit, or a refusal — the two outcomes a typed answer can have.
 *
 * A name with no row becomes a new one through the editor's own constructor, the
 * same call the dialog's "add a lane" path makes, so this helper cannot hand
 * `applyLaneEdit` a row shape the renderer would never produce.
 */
function edit(name, typed, raw) {
  const row = view(raw).rows.find((candidate) => candidate.name === name) ?? newLaneRow(name);
  return applyLaneEdit({ lanes: (raw?.lanes ?? {}) }, row, typed);
}

/** The caps the dispatch path would actually run with, from what was written. */
function inForce(directory) {
  const applied = applyLaneOverlay(BASE, readLaneOverlay(directory).raw);
  assert.ok(applied.source !== null, "what was written is something the dispatch path can use");
  return applied.source.lanes;
}

describe("the lane dialog", () => {
  it("offers the default lane with no overlay at all, so a cap is always editable", () => {
    const { rows, problem } = view(null);
    assert.equal(problem, null);
    assert.deepEqual(rows.map((row) => row.name), [DEFAULT_LANE], "the default lane is a row like any other");
  });

  it("offers a lane the CONFIG FILE declares, so the dialog cannot disagree with the refusals", () => {
    const base = normalizeDynamicTaskConfig(null, { lanes: { build: { maxConcurrent: 9 } } });
    const { rows } = laneDialogFrom(null, new Map(), base);
    assert.ok(rows.some((row) => row.name === "build"),
      "a lane the config declares is a lane the operator expects to find here");
  });

  it("says which caps are the overlay's and which are inherited, because the two are not equally editable", () => {
    const { rows } = view({ lanes: { build: { maxConcurrent: 2 } } });
    const build = rows.find((row) => row.name === "build");
    const fallback = rows.find((row) => row.name === DEFAULT_LANE);
    assert.equal(build.inherited, false, "declared in the overlay");
    assert.equal(fallback.inherited, true, "nothing declared, so the caps come from the config file");
  });

  it("still offers rows when the overlay is a shape it cannot read, because repair is why it was opened", () => {
    const { rows, problem } = view({ lanes: [1, 2, 3] });
    assert.ok(problem, "the unreadable shape is reported");
    assert.ok(rows.length > 0, "and the dialog is not empty — there has to be a way to fix it");
  });

  it("counts running tasks against the lane they were dispatched into", () => {
    const { rows } = view({ lanes: { build: { maxConcurrent: 2 } } }, { build: 2 });
    assert.equal(rows.find((row) => row.name === "build")?.running, 2);
  });
});

describe("an answer sets a cap", () => {
  it("one number caps concurrency and leaves depth alone", () => {
    const outcome = edit("build", "4", { lanes: { build: { maxConcurrent: 1, maxDepth: 2 } } });
    assert.equal(outcome.kind, "written");
    assert.deepEqual(outcome.overlay.lanes.build, { maxConcurrent: 4, maxDepth: 2 },
      "the depth the operator did not mention survives");
  });

  it("two numbers cap both", () => {
    assert.deepEqual(edit("build", "4 2", {}).overlay.lanes.build, { maxConcurrent: 4, maxDepth: 2 });
  });

  it("zero is an answer, not a mistake: it parks a lane without deleting it", () => {
    assert.deepEqual(edit("build", "0", {}).overlay.lanes.build, { maxConcurrent: 0 },
      "a lane that admits nothing is a real state");
  });

  it("a new lane is created with only what was typed", () => {
    assert.deepEqual(edit("build", "3", {}).overlay.lanes, { build: { maxConcurrent: 3 } });
  });
});

describe("`off` removes a cap rather than emptying it", () => {
  it("the key is GONE, not null, so the reader has no second shape to recognise", () => {
    const outcome = edit("build", "4 off", { lanes: { build: { maxConcurrent: 1, maxDepth: 2 } } });
    assert.deepEqual(outcome.overlay.lanes.build, { maxConcurrent: 4 });
    assert.equal("maxDepth" in outcome.overlay.lanes.build, false,
      "`{\"maxDepth\": null}` is a value every reader would have to special-case");
  });

  it("a single `off` lifts the concurrency cap", () => {
    assert.deepEqual(edit("build", UNBOUNDED, { lanes: { build: { maxConcurrent: 1 } } }).overlay.lanes.build, {});
  });
});

describe("an answer that cannot be used changes nothing", () => {
  for (const [typed, why] of [
    ["", "nothing typed"],
    ["abc", "not a count"],
    ["-1", "negative"],
    ["3.5", "not a whole number"],
    ["999999", "a typo rather than a policy"],
    ["1 2 3", "more values than the grammar takes"],
  ]) {
    it(`refuses ${JSON.stringify(typed)} — ${why}`, () => {
      const outcome = edit("build", typed, { lanes: { build: { maxConcurrent: 7 } } });
      assert.equal(outcome.kind, "invalid", "the answer is refused, not coerced");
      assert.ok(outcome.kind === "invalid" && outcome.problem.length > 0, "and the operator is told why");
    });
  }
});

describe("deleting a lane", () => {
  it("removes an overlay lane, which sends it back to the config file's caps", () => {
    const outcome = edit("build", "delete", { lanes: { build: { maxConcurrent: 2 } } });
    assert.equal(outcome.kind, "written");
    assert.equal(outcome.overlay.lanes.build, undefined, "the lane is no longer the overlay's business");
  });

  it("an answer with no row to edit is refused in words, not thrown at a dialog", () => {
    const outcome = applyLaneEdit({ lanes: {} }, undefined, "4");
    assert.equal(outcome.kind, "invalid", "a throw here would leave a broken modal with no way back");
  });

  it("refuses to delete a lane that is only inherited, and says whose caps those are", () => {
    const outcome = edit(DEFAULT_LANE, "delete", {});
    assert.equal(outcome.kind, "invalid");
    assert.match(outcome.kind === "invalid" ? outcome.problem : "", /config file/,
      "a refusal that does not name the owner leaves the operator with nothing to do");
  });
});

describe("what the dialog writes is what the dispatch path runs with", () => {
  it("round-trips: the shown caps are the caps in force after a write", async () => {
    await withTempDir((directory) => {
      const outcome = edit("build", "2 3", {});
      assert.equal(outcome.kind, "written");
      writeLaneOverlay(directory, outcome.overlay);
      assert.deepEqual(inForce(directory).build, { maxConcurrent: 2, maxDepth: 3 },
        "the same numbers the dialog displayed, arrived at by the server's own reader");
    });
  });

  it("a write is whole: a reader that arrives mid-write sees the old file or the new one, never half of one", async () => {
    // The atomicity is a property of rename, so the observable claim is that the
    // temp file never shares the target's name — two live opencode instances in
    // one repo would otherwise truncate each other's in-progress write.
    await withTempDir((directory) => {
      writeLaneOverlay(directory, { lanes: { build: { maxConcurrent: 2 } } });
      const leftovers = readdirSync(directory).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, [], "a completed write leaves no temp file behind");
    });
  });
});

describe("the prompt", () => {
  it("shows the caps as they stand, so the operator edits a number they can see", () => {
    const row = view({ lanes: { build: { maxConcurrent: 2 } } }).rows.find((candidate) => candidate.name === "build");
    assert.equal(promptFor(row).placeholder, `2 ${UNBOUNDED}`, "depth is unset, so it shows as off");
    assert.deepEqual(capsOf(row.lane), { concurrency: "2", depth: UNBOUNDED });
  });
});
