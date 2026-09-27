/**
 * The Lane Management dialog's logic, tested without a TUI runtime.
 *
 * The assertions are about the OVERLAY that lands on disk and the numbers the
 * dialog showed, not about which dialog opened: a modal that renders the wrong
 * thing is a bug, but a validation rule that lets an answer write
 * `{"maxDepth": null}` is a bug that reaches the dispatch path, and only the
 * first is visible by looking at the screen.
 *
 * Every case here answers for ONE cap, named — `LANE_FIELDS.maxConcurrent` and
 * not `"maxConcurrent"`, and not a position. That is not tidiness: the gate in
 * `safety-invariants.test.js` refuses a test that retypes a bound production
 * value, and a test that hard-codes a cap name is a hand-kept mirror of a
 * vocabulary it does not own.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { applyLaneOverlay, readLaneOverlay, readLaneOverlayLanes, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
import { DEFAULT_LANE, normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { bothCaps, withTempDir } from "./support/fixtures.js";
import { LANE_FIELDS, UNBOUNDED, applyLaneEdit, capShown, laneDialogFrom, laneFieldPrompt, newLaneEntry } from "../../dist/tui/lane-editor.js";

const BASE = normalizeDynamicTaskConfig(null);

/** The two caps, named once so a case reads as a FIELD being set. */
const CONCURRENCY = LANE_FIELDS.maxConcurrent;
const DEPTH = LANE_FIELDS.maxDepth;

/** The dialog's current state, the way the renderer sees it. */
function view(raw, running = {}) {
  return laneDialogFrom(raw, new Map(Object.entries(running)), BASE);
}

/**
 * Set one cap of one lane, as the form's field row does.
 *
 * A name with no row becomes a new one through the editor's own constructor, the
 * same call the dialog's "add a lane" path makes, so this helper cannot hand
 * `applyLaneEdit` a row shape the renderer would never produce.
 */
function edit(name, field, typed, raw) {
  const row = view(raw).rows.find((candidate) => candidate.name === name) ?? newLaneEntry(name);
  return applyLaneEdit({ lanes: (raw?.lanes ?? {}) }, row, { kind: "cap", field }, typed);
}

/** Remove a lane, as the editor's "Delete lane" row does. */
function remove(name, raw) {
  const row = view(raw).rows.find((candidate) => candidate.name === name) ?? newLaneEntry(name);
  return applyLaneEdit({ lanes: (raw?.lanes ?? {}) }, row, { kind: "delete" }, "");
}

/** The caps the dispatch path would actually run with, from what was written. */
function inForce(directory) {
  const applied = applyLaneOverlay(BASE, readLaneOverlay(directory).raw);
  assert.ok(applied.source !== null, "what was written is something the dispatch path can use");
  return applied.source.lanes;
}

/** Every cap of a lane, as the dialog shows them. */
const shownCaps = (lane) => ({ [CONCURRENCY.cap]: capShown(lane, CONCURRENCY.cap), [DEPTH.cap]: capShown(lane, DEPTH.cap) });

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

describe("the cap vocabulary", () => {
  /**
   * The table is TOTAL over the caps, so this is not really a fact about the two
   * caps that exist — it is a fact about the TYPE. A cap added to `LaneConfig`
   * without a label here will not compile, and `LANE_FIELD_LIST` is what the form
   * and the list row both iterate, so a cap cannot reach the operator through one
   * screen and be missing from the other.
   */
  it("keys every row by its own cap, so the map and the values cannot disagree", () => {
    assert.deepEqual(
      Object.entries(LANE_FIELDS).map(([key, field]) => [key, field.cap]),
      Object.values(LANE_FIELDS).map((field) => [field.cap, field.cap]),
      "a row stored under one cap and claiming another is a cap the form would edit twice and never",
    );
  });

  it("gives every cap a label and a clause, because those are what the operator reads", () => {
    const lane = bothCaps(2, 3);
    for (const field of Object.values(LANE_FIELDS)) {
      assert.ok(field.label.length > 0, `${field.cap} has no label`);
      const clause = field.listClause(capShown(lane, field.cap));
      assert.ok(clause.includes("2") || clause.includes("3"), `${field.cap}'s clause drops the value: ${clause}`);
      assert.ok(clause.trim().length > String(lane[field.cap]).length, `${field.cap}'s clause names nothing: ${clause}`);
      assert.match(field.meaning, new RegExp(UNBOUNDED), `${field.cap} does not say how to remove its cap`);
    }
  });
});

describe("an answer sets the cap it was asked for", () => {
  it("and leaves every other cap exactly as it was", () => {
    const outcome = edit("build", CONCURRENCY, "4", { lanes: { build: bothCaps(1, 2) } });
    assert.equal(outcome.kind, "written");
    assert.deepEqual(outcome.overlay.lanes.build, bothCaps(4, 2),
      "the depth the operator was never asked about survives");
  });

  it("the depth field sets the depth, and not the concurrency", () => {
    const outcome = edit("build", DEPTH, "3", { lanes: { build: bothCaps(1, 2) } });
    assert.deepEqual(outcome.overlay.lanes.build, bothCaps(1, 3));
  });

  it("zero is an answer, not a mistake: it parks a lane without deleting it", () => {
    assert.deepEqual(edit("build", CONCURRENCY, "0", {}).overlay.lanes.build, { maxConcurrent: 0 },
      "a lane that admits nothing is a real state");
  });

  it("a new lane is created with only the cap that was set", () => {
    assert.deepEqual(edit("build", CONCURRENCY, "3", {}).overlay.lanes, { build: { maxConcurrent: 3 } });
  });

  it("says which field changed, so the toast names a cap rather than a lane", () => {
    const outcome = edit("build", DEPTH, "3", {});
    assert.equal(outcome.kind, "written");
    assert.match(outcome.summary, new RegExp(DEPTH.label), "the field's own name, not the lane's");
  });
});

/**
 * The case the positional grammar could not express, and the one most likely to be
 * hit by accident: an operator opens a field to look at it and presses escape.
 *
 * Under the old prompt there was one box for two caps, so leaving it empty had to
 * mean "change nothing" — and the honest way to say that is a distinct outcome, not
 * a refusal. Writing the value in force would be worse than refusing: the cap is
 * often INHERITED, and writing it would turn a config-file cap into an overlay one
 * that the config file could no longer change.
 */
describe("a field opened and left alone", () => {
  it("changes nothing, and says so, rather than refusing or writing", () => {
    const current = { lanes: { build: { maxConcurrent: 1 } } };
    const outcome = edit("build", CONCURRENCY, "   ", current);
    assert.equal(outcome.kind, "unchanged");
  });

  it("and so leaves the overlay with no entry to write at all", () => {
    const row = newLaneEntry("build");
    const outcome = applyLaneEdit({ lanes: {} }, row, { kind: "cap", field: CONCURRENCY }, "");
    assert.equal(outcome.kind, "unchanged", "there is no overlay in the outcome, so there is nothing a writer could write");
  });
});

describe("`off` removes a cap rather than emptying it", () => {
  it("the key is GONE, not null, so the reader has no second shape to recognise", () => {
    const outcome = edit("build", DEPTH, UNBOUNDED, { lanes: { build: bothCaps(1, 2) } });
    assert.deepEqual(outcome.overlay.lanes.build, { maxConcurrent: 1 });
    assert.equal(DEPTH.cap in outcome.overlay.lanes.build, false,
      "`{\"maxDepth\": null}` is a value every reader would have to special-case");
  });

  it("a single `off` lifts the concurrency cap", () => {
    assert.deepEqual(edit("build", CONCURRENCY, UNBOUNDED, { lanes: { build: { maxConcurrent: 1 } } }).overlay.lanes.build, {});
  });
});

describe("an answer that cannot be used changes nothing", () => {
  for (const [typed, why] of [
    ["abc", "not a count"],
    ["-1", "negative"],
    ["3.5", "not a whole number"],
    ["999999", "a typo rather than a policy"],
  ]) {
    it(`refuses ${JSON.stringify(typed)} — ${why}`, () => {
      const outcome = edit("build", CONCURRENCY, typed, { lanes: { build: { maxConcurrent: 7 } } });
      assert.equal(outcome.kind, "invalid", "the answer is refused, not coerced");
      assert.ok(outcome.kind === "invalid" && outcome.problem.length > 0, "and the operator is told why");
    });
  }

  it("names the value that was typed, so the refusal is about THIS answer", () => {
    const outcome = edit("build", CONCURRENCY, "abc", {});
    assert.match(outcome.kind === "invalid" ? outcome.problem : "", /abc/);
  });
});

describe("deleting a lane", () => {
  it("removes an overlay lane, which sends it back to the config file's caps", () => {
    const outcome = remove("build", { lanes: { build: { maxConcurrent: 2 } } });
    assert.equal(outcome.kind, "written");
    assert.equal(outcome.overlay.lanes.build, undefined, "the lane is no longer the overlay's business");
  });

  it("an answer with no row to edit is refused in words, not thrown at a dialog", () => {
    const outcome = applyLaneEdit({ lanes: {} }, undefined, { kind: "cap", field: CONCURRENCY }, "4");
    assert.equal(outcome.kind, "invalid", "a throw here would leave a broken modal with no way back");
  });

  it("refuses to delete a lane that is only inherited, and says whose caps those are", () => {
    const outcome = remove(DEFAULT_LANE, {});
    assert.equal(outcome.kind, "invalid");
    assert.match(outcome.kind === "invalid" ? outcome.problem : "", /config file/,
      "a refusal that does not name the owner leaves the operator with nothing to do");
  });
});

describe("what the dialog writes is what the dispatch path runs with", () => {
  it("round-trips: the caps shown are the caps in force after a write", async () => {
    await withTempDir((directory) => {
      // Two edits, because there are two fields — which is the point of the form.
      // The row is re-read between them, because that is what the renderer does: it
      // calls `readLanes` after a write so the form shows what was WRITTEN. Passing a
      // fresh row instead would hand `withCaps` an empty lane and quietly drop the
      // first cap, which is this test's own first version.
      const first = edit("build", CONCURRENCY, "2", {});
      assert.equal(first.kind, "written");
      const reread = view(first.overlay).rows.find((row) => row.name === "build");
      const second = applyLaneEdit(first.overlay, reread, { kind: "cap", field: DEPTH }, "3");
      assert.equal(second.kind, "written");
      writeLaneOverlay(directory, second.overlay);
      assert.deepEqual(inForce(directory).build, bothCaps(2, 3),
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

describe("the field prompt", () => {
  const buildRow = (raw) => view(raw).rows.find((candidate) => candidate.name === "build");

  it("is named after the FIELD and the lane, so the box says what it is asking", () => {
    const row = buildRow({ lanes: { build: { maxConcurrent: 2 } } });
    assert.equal(laneFieldPrompt(row, CONCURRENCY).title, `${CONCURRENCY.label} · build`);
    assert.equal(laneFieldPrompt(row, DEPTH).title, `${DEPTH.label} · build`);
  });

  it("shows the value in force as its placeholder, so the operator edits a number they can see", () => {
    const row = buildRow({ lanes: { build: { maxConcurrent: 2 } } });
    assert.equal(laneFieldPrompt(row, CONCURRENCY).placeholder, "2");
    assert.equal(laneFieldPrompt(row, DEPTH).placeholder, UNBOUNDED, "depth is unset, so it shows as off");
  });

  it("asks for ONE cap, so a second number is a mistake rather than a depth", () => {
    // The old grammar read "4 3" as both caps. There is no longer a position to
    // read, so a second value is refused instead of silently becoming the other
    // field — which is the whole reason the positional grammar went.
    const outcome = edit("build", CONCURRENCY, "4 3", {});
    assert.equal(outcome.kind, "invalid");
    assert.match(outcome.kind === "invalid" ? outcome.problem : "", /4 3/,
      "and it quotes what was typed, so the operator can see the space they did not mean");
  });
});

describe("a hand-mangled overlay", () => {
  // A file written by a human or by a writer with a bug. The server drops an
  // unusable cap and falls back to the config, which is the right answer; the
  // danger is the dialog DISPLAYING one the server will not honour, and then
  // writing the garbage back out beside the operator's new number.
  // Spelled open rather than through `bothCaps`, on purpose: this body is not a lane,
  // it is a file written by something that got the shape wrong, and borrowing the name
  // of the well-formed helper would say the opposite of what the case is about.
  const mangled = { lanes: { build: { maxConcurrent: "four", maxDepth: -1 } } };

  it("shows the same caps the dispatch path will honour, not the ones the file claims", () => {
    const { rows } = view(mangled);
    assert.deepEqual(shownCaps(rows.find((row) => row.name === "build").lane), bothCaps(UNBOUNDED, UNBOUNDED),
      "a cap the server drops must not appear in the dialog as if it applied");
    assert.deepEqual(applyLaneOverlay(BASE, mangled).source.lanes.build, {},
      "and the two answers agree, because they come from one reader");
  });

  it("says which caps it ignored, so 'unset' is not mistaken for 'inherited'", () => {
    const { problem } = view(mangled);
    assert.match(problem, /build/);
    assert.match(problem, /not a whole positive number/);
  });

  it("an edit does not carry the ignored values back out into the file", () => {
    const { rows } = view(mangled);
    const outcome = applyLaneEdit({ lanes: readLaneOverlayLanes(mangled) }, rows.find((row) => row.name === "build"), { kind: "cap", field: CONCURRENCY }, "5");
    assert.deepEqual(outcome.overlay.lanes.build, { maxConcurrent: 5 },
      "the file keeps the new number and loses the value the server would have refused anyway");
  });
});

describe("an overlay whose shapes are wrong in ways the reader must survive", () => {
  it("a lane body that is not an object is an empty lane, not a crash and not a cap", () => {
    const { rows, problem } = laneDialogFrom({ lanes: { build: "four", deploy: 7 } }, new Map(), BASE);
    assert.deepEqual(shownCaps(rows.find((row) => row.name === "build").lane), bothCaps(UNBOUNDED, UNBOUNDED));
    assert.equal(problem, null, "a body that is not an object states no cap to ignore, so nothing is reported");
  });

  it("lanes that are not an object reads as no overlay at all, and says so", () => {
    const { problem } = laneDialogFrom({ lanes: ["build"] }, new Map(), BASE);
    assert.match(problem, /JSON object/);
  });

  it("no overlay at all is the empty set, and the dialog still has the config's lanes", () => {
    const { rows, problem } = laneDialogFrom(null, new Map(), BASE);
    assert.deepEqual(rows.map((row) => row.name), [DEFAULT_LANE]);
    assert.equal(problem, null);
  });
});
