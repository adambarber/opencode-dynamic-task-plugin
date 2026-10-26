/**
 * The Task Limits dialog's logic, tested without a TUI runtime.
 *
 * The assertions are about the OVERLAY that lands on disk and the numbers the
 * dialog showed, not about which dialog opened: a modal that renders the wrong
 * thing is a bug, but a validation rule that lets an answer write
 * `{"maxDepth": null}` is a bug that reaches the dispatch path, and only the
 * first is visible by looking at the screen.
 *
 * Every case here answers for ONE cap, named — `CAP_LABEL.maxConcurrent` and not
 * `"maxConcurrent"`, and not a position. That is not tidiness: the gate in
 * `safety-invariants.test.js` refuses a test that retypes a bound production
 * value, and a test that hard-codes a cap name is a hand-kept mirror of a
 * vocabulary it does not own.
 */
import { AGENT_CAP_NAMES, applyAgentOverlay, readAgentOverlayCaps } from "../../dist/shared/caps.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { agentDialogFrom, applyCapEdit, CAP_CHOICES, CAP_LABEL, capCellOf, overlayFrom } from "../../dist/tui/agent-editor.js";
import { BETWEEN, INHERITED, namedCell, plainSummary, terseCell } from "../../dist/tui/theme.js";
import { assert, bothCaps, describe, it, overlayChannel, tempProject, withTempDir } from "./support/index.js";

const BASE = normalizeDynamicTaskConfig(null);

/** One project's caps channel, over the config the dialog writes against. */
const channel = (directory) => overlayChannel(directory, BASE);

/** The dialog's current state, the way the renderer sees it. */
function view(raw, agentNames) {
  return agentDialogFrom(raw, BASE, agentNames, false, null);
}

/** The registered agents these cases use, so a row set is never empty by accident. */
const AGENTS = ["explore", "general", "review"];

/** Set one cap of one agent, as the picker's value row does. */
function edit(agent, cap, value, raw) {
  return applyCapEdit(overlayFrom(raw), agent, { cap, value });
}

/**
 * The claim both edit paths end on, named once: the write succeeded and
 * `explore`'s overlay landed whole. The dialog helper and the raw `applyCapEdit`
 * answer with the same shape, and this is the one place that knows what a
 * landed cap edit reads.
 */
const editLanded = (outcome, expected, why) => {
  assert.equal(outcome.kind, "written");
  assert.deepEqual(outcome.overlay.agents.explore, expected, why);
};

/** `explore`'s row, as the list drew it. The fixture four cases reason about. */
const exploreRow = (caps) => view({ agents: { explore: caps } }, AGENTS).rows[0];

/** The rows a dialog draws, so a case states the overlay and the agent set and stops. */
const rowsFor = (overlay, agentNames = AGENTS) => view(overlay, agentNames).rows;

/**
 * The agent names a row set holds, in order.
 *
 * The claim every list case makes, named once: four sites were spelling
 * `rowNames(rows)` and the duplication gate was right to call them the
 * same code, because they are — and a helper that cannot be wrong about which field
 * the screen keys on is also the one place to change if that field ever moves.
 */
const rowNames = (rows) => rows.map((row) => row.name);

/** The overlay after clearing `explore`'s concurrency cap, which the cases below want whole. */
const clearing = (agent, stated) => {
  const outcome = edit(agent, "maxConcurrent", null, { agents: { [agent]: stated } });
  assert.equal(outcome.kind, "written", "clearing a stated cap is a write");
  return outcome.overlay.agents;
};

/**
 * A cap the dialog accepts, the reader keeps, and the reader hands back unchanged.
 *
 * The join, named, because every claim about the writer is a claim about this and
 * writing it out at each site is how a case ends up asserting the writer alone — which
 * is exactly how a `0` came to be written under a success toast for a whole release.
 */
function survivesRoundTrip(cap, value) {
  const outcome = edit("explore", cap, value, {});
  assert.equal(outcome.kind, "written", `the dialog accepts ${cap} ${value}`);
  const read = readAgentOverlayCaps(outcome.overlay);
  assert.deepEqual(read.dropped, {}, "the reader discards nothing about it");
  assert.equal(read.agents.explore[cap], value, "and the value is the value that was chosen");
}

/** The caps the dispatch path would actually run with, from what was stored. */
function inForce(caps) {
  const applied = applyAgentOverlay(BASE, caps);
  assert.ok(applied !== null, "what was stored is something the dispatch path can use");
  return applied;
}

describe("a depth the agent set holds below the cap", () => {
  // The dialog is where the cap is SET, so a cell that printed only the cap let an
  // operator type 4, be obeyed as far as 3, and find out from a DIFFERENT screen. The
  // cap is a number they can change; the reachability is a number they cannot, which is
  // the more important one to be able to read.
  const TWO_AGENTS = ["explore", "general"];

  it("carries the REACHABLE depth beside the cap, naming which constraint holds it", () => {
    const { rows } = agentDialogFrom({}, BASE, TWO_AGENTS, false, null);
    const explore = rows.find((row) => row.name === "explore");
    assert.equal(explore.depth.configured, 2, "the cap the operator sets");
    assert.equal(explore.depth.effective, 2, "and the depth that is actually reachable");
    assert.equal(explore.depth.boundBy, "agent-cap", "at equal depth the cap is what binds, and the screen says which");
  });

  it("claims no ceiling when the cap is already below the agent set", () => {
    const base = { ...BASE, allowSameAgentRecursion: false, maxDepth: 1 };
    const { rows } = agentDialogFrom({}, base, TWO_AGENTS, false, null);
    const explore = rows.find((row) => row.name === "explore");
    // Naming the CAP as the binding constraint is the more useful half: it tells the
    // operator the number in front of them is the one doing the work, so raising it is
    // what would change anything.
    assert.equal(explore.depth.boundBy, "agent-cap", "a cap of 1 over two agents is held by the cap, not the set");
    assert.equal(capCellOf(explore, "maxDepth").bounded, null, "so the cell prints one number, not 1/1");
  });

  it("prints the reachable depth of TWO, with a cap of four, as 2/4", () => {
    const { rows } = agentDialogFrom({}, { ...BASE, maxDepth: 4 }, TWO_AGENTS, false, null);
    const explore = rows.find((row) => row.name === "explore");
    assert.equal(terseCell(capCellOf(explore, "maxDepth")), "2/4", "both numbers, reachable first, with no adjective");
  });

  it("lets the cap bind when the same agent may recur, because then the set is not the wall", () => {
    const { rows } = agentDialogFrom({}, { ...BASE, maxDepth: 4 }, TWO_AGENTS, true, null);
    const explore = rows.find((row) => row.name === "explore");
    assert.equal(explore.depth.effective, 4, "with recursion allowed a cap of 4 is a depth of 4");
    assert.equal(capCellOf(explore, "maxDepth").bounded, null, "and there is no ceiling to print");
  });

  it("claims no depth at all when the dispatchable set is unknown", () =>
    // A failed agent read is a WARNING over the capped agents, not an empty set. The
    // rows still appear, so the fallback is real — but it is a DISPLAY decision, and
    // depthing over it would claim the one capped agent is the whole project. An empty
    // set is not the answer either: `depthLimits` reads that as depth 0, and "nothing
    // may nest" is a harder claim than "we could not find out".
    agentDialogFrom({ agents: { explore: { maxDepth: 4 } } }, BASE, null, false, null).rows.forEach((row) => {
      assert.equal(row.depth.effective, null, "an unknown set cannot bound a depth");
      assert.equal(row.depth.boundBy, null, "and nothing is named as the constraint");
      assert.equal(capCellOf(row, "maxDepth").bounded, null, "so the cell prints the cap alone");
    }));

  it("counts the set the host PUBLISHES minus the agents the plugin refuses", () =>
    // `agentNames` arrives already narrowed to the dispatchable set, so the screen counts
    // what a dispatch could actually name. A refused agent cannot go deeper, and counting
    // it would report a reach the operator can never use.
    agentDialogFrom({}, { ...BASE, maxDepth: 4 }, ["explore", "general", "review"], false, null).rows.forEach((row) => {
      assert.equal(row.depth.effective, 3, "three dispatchable agents permit depth 3, not 4");
      assert.equal(row.depth.boundBy, "agent-set", "so the agent set is the constraint, not the cap");
    }));
});

describe("the limits list", () => {
  it("has one row per REGISTERED agent, with no overlay at all", () => {
    // The point of keying by agent: the key space is GIVEN, so the screen is
    // populated on a project that has never touched it. Under lanes this could only
    // show the default lane and whatever the operator had declared, which is why an
    // "add a lane" affordance existed at all.
    const { rows, problem } = view(null, AGENTS);
    assert.equal(problem, null);
    assert.deepEqual(rowNames(rows), AGENTS, "every registered agent is a row like any other");
  });

  it("shows BOTH caps of an agent on its one row, as a table of quantities", () => {
    // The operator's own framing: the concurrency cap "next to" the depth. Two rows
    // of one agent would print the name twice and split the pair apart. The mark is the
    // module's, so this says the two cells are ADJACENT without retyping how wide that is.
    //
    // Figure before noun — `1 concurrency * 2 depth` — because this is a table of
    // quantities and a table reads its numbers first. The label-before-figure order it
    // replaced (`at once 1`) is the same fact in the register used inside sentences, and
    // on a row it made the reader hold a label while they found a number, twice per row.
    const row = exploreRow(bothCaps(1, 2));
    assert.equal(plainSummary(row), `1 concurrency${BETWEEN}2 depth`);
  });

  /**
   * The two caps of an agent that has declared one, and the spelling each is read in.
   *
   * The two cases below are about the SAME row from two directions — what a cell says with
   * an adjective and what it says without one — and spelled out, the `view` call and the
   * four lookups are eight identical lines. So the row is built once, here, and each case
   * names only the cell and the spelling it is about.
   */
  const oneStated = () => view({ agents: { explore: { maxConcurrent: 1 } } }, AGENTS).rows[0];

  it("reports which caps are INHERITED in the cell, because an agent at 4 by default and one set to 4 look the same", () => {
    // The LIST no longer prints the annotation, on either figure of any row — it said
    // `from config` forty times in a column, which is what made the screen read as broken
    // strings. The fact is still IN the cell, and the agent's own caps screen prints it;
    // what changed is that a column of quantities carries no adjectives and a screen where
    // you are choosing a cap does.
    const row = oneStated();
    assert.equal(capCellOf(row, "maxConcurrent").stated, true, "declared in the overlay");
    assert.equal(namedCell(capCellOf(row, "maxConcurrent")), "1", "and an operator's own number claims no provenance");
    assert.equal(capCellOf(row, "maxDepth").stated, false, "nothing declared, so it comes from the config file");
    assert.equal(namedCell(capCellOf(row, "maxDepth")), `${BASE.maxDepth} ${INHERITED}`);
  });

  it("and the terse spelling, which is what the list prints, drops the annotation entirely", () =>
    const cell = capCellOf(oneStated(), "maxDepth");
    assert.equal(terseCell(cell), `${BASE.maxDepth}`, "a figure, with no adjective beside it"));

  it("still offers rows when the overlay is a shape it cannot read, because repair is why it was opened", () => {
    const { rows, problem } = agentDialogFrom({ agents: [1, 2, 3] }, BASE, AGENTS, false, "that is not an object");
    assert.ok(problem, "the unreadable shape is reported");
    assert.deepEqual(rowNames(rows), AGENTS, "and the list is not empty — there has to be a way to fix it");
  });

  it("falls back to the CAPPED agents when the host's list is unreadable", () => {
    // `null` is a failed read, not a project with no agents, and the two must not
    // render identically: an empty list claims something the plugin never learned.
    assert.deepEqual(rowNames(rowsFor({ agents: { explore: { maxConcurrent: 2 } } }, null)), ["explore"]);
  });

  it("carries no occupancy, because nothing in the dialog reads one any more", () => {
    // The row used to say how many tasks were charged to it, read from the ledger
    // file. That is the last RECORDED set, not a live count, and printing it beside
    // a cap gave the operator reason to distrust the one number they could act on.
    const row = exploreRow({ maxConcurrent: 2 });
    assert.ok(!("running" in row) && !("active" in row),
      "an entry that cannot say how busy an agent is does not carry a number saying zero");
  });
});

describe("the cap vocabulary", () => {
  /**
   * These are facts about the TYPE, not about the two caps that exist: a cap added to
   * `AgentCapName` without a label and a choice list here will not compile. The two
   * records are what make a cap cannot reach the operator through one screen and be
   * missing from the other.
   */
  it("labels and offers a value for every cap that exists", () => {
    for (const cap of AGENT_CAP_NAMES) {
      assert.ok(CAP_LABEL[cap]?.length > 0, `${cap} has no label`);
      assert.doesNotMatch(CAP_LABEL[cap], new RegExp(`\\b${cap}\\b`),
        `${cap}'s label is the config's noun rather than a question about tasks`);
      assert.ok(CAP_CHOICES[cap]?.length > 0, `${cap} can be set to nothing`);
    }
  });

  it("offers a label and a value list for every cap, and nothing else", () => {
    // TOTAL over the caps, so this is a fact about the type and not about the two that
    // exist: a cap added to `AGENT_CAP_NAMES` without a label or a value list will not
    // compile, which is the only reason a new cap cannot arrive with an empty picker.
    assert.deepEqual(Object.keys(CAP_LABEL).toSorted(), [...AGENT_CAP_NAMES].toSorted());
    assert.deepEqual(Object.keys(CAP_CHOICES).toSorted(), [...AGENT_CAP_NAMES].toSorted());
  });
});

describe("an answer sets the cap it was asked for", () => {
  it("and leaves every other cap exactly as it was", () => {
    const outcome = edit("explore", "maxConcurrent", 4, { agents: { explore: bothCaps(1, 2) } });
    editLanded(outcome, bothCaps(4, 2), "the depth the operator was never asked about survives");
  });

  it("the depth cap sets the depth, and not the concurrency", () => {
    assert.deepEqual(edit("explore", "maxDepth", 3, { agents: { explore: bothCaps(1, 2) } }).overlay.agents.explore, bothCaps(1, 3));
  });

  it("refuses a zero, because a cap the reader discards is not a cap", () =>
    // This case used to say the opposite — "zero is an answer, not a mistake" — and it
    // was wrong. The reader requires a POSITIVE cap, so a zero written here was
    // dropped on the next read and the agent fell through to the top-level default:
    // an operator tightening an agent to nothing got the loosest cap the config has,
    // under a success toast. The test passed because it only ever asked what the
    // dialog WROTE.
    assert.equal(edit("explore", "maxConcurrent", 0, {}).kind, "invalid"));

  it("an agent nobody had capped yet is created with only the cap that was set", () => {
    assert.deepEqual(edit("review", "maxConcurrent", 3, {}).overlay.agents, { review: { maxConcurrent: 3 } });
  });

  it("says which cap changed, so the toast names the setting rather than the project", () => {
    const outcome = edit("explore", "maxDepth", 3, {});
    assert.match(outcome.summary, new RegExp(CAP_LABEL.maxDepth));
  });

  it("writes the FOLDED key, so a host's spelling still finds the cap it was given", () => {
    // The direction of error that never announces itself: a key the lookup does not
    // find is a cap applying to no agent at all, with no error and no refusal.
    assert.deepEqual(Object.keys(edit("Explore", "maxConcurrent", 2, {}).overlay.agents), ["explore"]);
  });
});

/**
 * The case the picker makes structural rather than a grammar's problem: an operator
 * opens a cap to look at it and presses escape.
 *
 * Under the old prompt there was one box for two caps, so leaving it empty had to
 * mean "change nothing" — and the honest way to say that is a distinct outcome, not
 * a refusal. Writing the value in force would be worse than refusing: the cap is
 * often INHERITED, and writing it would turn a config-file cap into an overlay one
 * that the config file could no longer change.
 */
describe("a cap opened and left alone", () => {
  it("changes nothing, and says so, rather than refusing or writing", () => {
    assert.equal(edit("explore", "maxConcurrent", 1, { agents: { explore: { maxConcurrent: 1 } } }).kind, "unchanged");
  });

  it("and so leaves the overlay with no entry to write at all", () => {
    const outcome = applyCapEdit({ agents: {} }, "explore", { cap: "maxConcurrent", value: null });
    assert.equal(outcome.kind, "unchanged", "there is no overlay in the outcome, so there is nothing a writer could write");
  });
});

describe("clearing a cap removes it rather than emptying it", () => {
  it("the key is GONE, not null, so the reader has no second shape to recognise", () => {
    const outcome = edit("explore", "maxDepth", null, { agents: { explore: bothCaps(1, 2) } });
    assert.deepEqual(outcome.overlay.agents.explore, { maxConcurrent: 1 });
    assert.equal("maxDepth" in outcome.overlay.agents.explore, false,
      "`{\"maxDepth\": null}` is a value every reader would have to special-case");
  });

  it("an agent whose LAST cap is cleared leaves the overlay entirely", () => {
    // Leaving an empty body behind would make the file grow one dead entry per
    // experiment, and would keep the agent listed as "capped" with nothing capped.
    assert.deepEqual(clearing("explore", { maxConcurrent: 1 }), {});
  });

  it("and the agent keeps its place in the list, on the config's numbers", () => {
    // Clearing a cap is not deleting an agent — there is no such operation, because
    // the agent was never the operator's to delete. It came from the host.
    const {rows} = view({ agents: {} }, AGENTS);
    assert.deepEqual(rowNames(rows), AGENTS, "every registered agent is still a row");
    assert.equal(namedCell(capCellOf(rows[0], "maxConcurrent")), `${BASE.maxConcurrent} ${INHERITED}`);
  });
});

describe("an answer that cannot be used changes nothing", () => {
  for (const [value, why] of [
    [0, "a zero refuses every dispatch"],
    [-1, "a negative never refuses"],
    [1.5, "not a whole number"],
    [999999, "a typo rather than a policy"],
  ]) {
    it(`refuses ${JSON.stringify(value)} — ${why}`, () => {
      const outcome = edit("explore", "maxConcurrent", value, { agents: { explore: { maxConcurrent: 7 } } });
      assert.equal(outcome.kind, "invalid", "the answer is refused, not coerced");
      assert.ok(outcome.kind === "invalid" && outcome.problem.length > 0, "and the operator is told why");
    });
  }

  it("names the value that was chosen, so the refusal is about THIS answer", () => {
    const outcome = edit("explore", "maxConcurrent", 999999, {});
    assert.match(outcome.kind === "invalid" ? outcome.problem : "", /999999/);
  });

  it("an agent with no name is refused in words, not thrown at a dialog", () => {
    const outcome = applyCapEdit({ agents: {} }, "   ", { cap: "maxConcurrent", value: 4 });
    assert.equal(outcome.kind, "invalid", "a throw here would leave a broken modal with no way back");
  });
});

describe("what the dialog writes is what the dispatch path runs with", () => {
  it("round-trips: the caps shown are the caps in force after a write", async () => {
    await withTempDir(async (directory) => {
      // Two edits, because there are two caps — which is the point of one row carrying
      // both. The overlay is re-read between them, because that is what the renderer
      // does: it re-opens the list after a write so the row shows what was WRITTEN.
      // Passing the pre-write overlay instead would drop the first cap, which is this
      // test's own first version.
      const first = edit("explore", "maxConcurrent", 2, {});
      assert.equal(first.kind, "written");
      const second = applyCapEdit(first.overlay, "explore", { cap: "maxDepth", value: 3 });
      assert.equal(second.kind, "written");
      await channel(directory).seed(second.overlay);
      const reread = await channel(directory).read();
      assert.deepEqual(inForce(reread.caps).agents.explore, bothCaps(2, 3),
        "the same numbers the dialog displayed, arrived at by the server's own reader");
    });
  });

  it("a write is whole: the second write REPLACES the document, so one cap is never half of another", async () => {
    // Whole-write is what the dialog's own loop depends on: it re-opens the list after
    // writing, so what it renders is what it read back. A merging write would let a
    // second cap land against a first one the reader never returned.
    await withTempDir(async (directory) => {
      const store = channel(directory);
      await store.seed({ agents: { explore: bothCaps(2, 3) } });
      await store.seed({ agents: { explore: { maxDepth: 3 } } });
      const stored = await store.read();
      assert.deepEqual(inForce(stored.caps).agents.explore, { maxDepth: 3 },
        "the document now holds the second write alone");
    });
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
  //
  // ONE good cap among the garbage, deliberately: a body where every cap is dropped
  // makes the whole overlay null (nothing to apply), which the case below asserts
  // separately. What this one pins is the harder half — an entry that SURVIVES with
  // one cap intact while its other was discarded, which is the state an edit then
  // writes over.
  const mangled = { agents: { explore: { maxConcurrent: "four", maxDepth: 2 } } };

  it("shows the same caps the dispatch path will honour, not the ones the file claims", () => {
    const {rows} = view(mangled, AGENTS);
    assert.deepEqual(rows.find((row) => row.name === "explore").stated, { maxDepth: 2 },
      "the string cap is dropped and only the whole number survives");
    assert.deepEqual(applyAgentOverlay(BASE, mangled)?.agents.explore, { maxDepth: 2 },
      "and the two answers agree, because they come from one reader");
    assert.equal(terseCell(capCellOf(rows[0], "maxDepth")), "2", "so the cell shows 2, not the file's claim");
  });

  it("a body whose every cap is dropped leaves no overlay at all", () => {
    // Nothing to apply means nothing to layer, and an entry that constrains nothing
    // must not be what makes the file "present" — the two are different questions and
    // a file of empty bodies would answer the first and not the second.
    assert.strictEqual(applyAgentOverlay(BASE, { agents: { explore: { maxConcurrent: "four" } } }), null);
  });

  it("says which caps it ignored, so 'unset' is not mistaken for 'inherited'", () => {
    const { dropped } = readAgentOverlayCaps(mangled);
    assert.deepEqual(dropped.explore, ["maxConcurrent"]);
  });

  it("an edit does not carry the ignored values back out into the file", () => {
    // 4 rather than 5: the picker's list goes 4, 6, and a value it does not offer is
    // refused. That refusal is correct, and worth having confirmed by this case
    // choosing an offered one — an unoffered value would have tested the list rather
    // than the reader's agreement.
    const outcome = applyCapEdit(overlayFrom(mangled), "explore", { cap: "maxConcurrent", value: 4 });
    editLanded(outcome, bothCaps(4, 2),
      "the file keeps the new number and the one the server honoured, and loses the value the server would have refused");
  });
});

describe("an overlay whose shapes are wrong in ways the reader must survive", () => {
  it("an agent body that is not an object states no cap and is not a cap", () => {
    const rows = rowsFor({ agents: { explore: "four", general: 7 } });
    assert.deepEqual(rows.find((row) => row.name === "explore").stated, {});
    assert.equal(namedCell(capCellOf(rows[0], "maxDepth")), `${BASE.maxDepth} ${INHERITED}`,
      "a body that is not an object states no cap, so the config's own applies");
  });

  it("an absent document states no problem, so the list is the host's agents and mentions nothing else", async () => {
    // The row set is the FIRST case in this file, and this is the same claim from the
    // reader's side: a document that is not there is the normal case, and a reader that
    // reported it as one would have every operator chasing caps they never set.
    const absent = await channel(tempProject()).read();
    assert.equal(absent.problem, null, "absent is not a problem");
  });
});

/**
 * The writer and the reader must agree about what a cap is.
 *
 * The bug this pins was not a wrong number but a right one in the wrong place: the
 * dialog's grammar accepted a zero, wrote `{"maxConcurrent": 0}`, and told the
 * operator it was "in force on the next dispatch" — and the reader, which requires a
 * positive cap, dropped it on the next read, so the agent fell through to the
 * top-level default. In this project that turned a cap of 1 into 4. Nothing in the
 * suite could see it, because every case here asked what the dialog WROTE and none
 * asked what the reader would then READ BACK.
 *
 * So the join is the assertion, and it is stated as the invariant rather than as the
 * one number that broke: for every cap the dialog will write, the reader must keep
 * it. The refusals are asserted alongside, because a writer that accepted nothing
 * would satisfy the first half alone.
 */
describe("every cap the dialog offers is a cap the reader keeps", () => {
  // One loop over the picker's own content, because "offered" and "kept" being two
  // different lists IS the defect: a value the writer accepts and the reader drops is a
  // row that promises a cap and silently writes none. Iterating `CAP_CHOICES` rather
  // than a hand-written list is what keeps the two the same list.
  for (const cap of AGENT_CAP_NAMES) {
    for (const value of CAP_CHOICES[cap]) {
      it(`${cap} ${value} survives the round trip`, () => survivesRoundTrip(cap, value));
    }
  }

  it("and clearing a cap writes an ABSENT key, not a zero, keeping the caps it did not clear", () => {
    const agents = clearing("explore", bothCaps(2, 2));
    assert.ok(!("maxConcurrent" in agents.explore),
      "an absent key and a zero are different statements, and only one of them means 'no cap'");
    assert.deepEqual(agents.explore, { maxDepth: 2 }, "and the other cap is untouched");
  });

  for (const value of [0, -1, 1.5, 1e3]) {
    it(`refuses ${JSON.stringify(value)} rather than writing a cap nothing will honour`, () => {
      const outcome = edit("explore", "maxConcurrent", value, { agents: { explore: bothCaps(2, 2) } });
      assert.ok(["unchanged", "invalid"].includes(outcome.kind),
        "the answer is either left alone or refused — never written");
    });
  }
});
