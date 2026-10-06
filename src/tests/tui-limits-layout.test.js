/**
 * The row against the host's own geometry: how many columns a dialog really offers, and
 * what a row does when its name and its caps cannot both fit. Measured, not modelled.
 */
//jscpd:ignore-start
import {
  BOUND_DEPTH, LONG_AGENT_NAME, REGISTERED, agentEntry, assertEveryRowFits, dialogRowText, row, rowText, withList,
} from "./support/limits-screen.js";
import { BETWEEN, plainSummary } from "../../dist/tui/theme.js";
import { DIALOG_WIDTH, fitsItsDialog } from "../../dist/tui/geometry.js";
import { assert, describe, it } from "./support/runner.js";
import { bothCaps } from "./support/fixtures.js";
import { displayName } from "../../dist/tui/agent-editor.js";

//jscpd:ignore-end
describe("the host's own layout, as measured rather than modelled", () => {
  // Every DERIVED version of these numbers has been wrong, and each was confident. The
  // first counted six columns of indent and missed a one-pixel gap; the second missed the
  // `scrollbox` at `paddingLeft={1} paddingRight={1}` the rows live in; a third measured
  // a `large` dialog for a screen whose rows turned out not to need one. All were out in
  // the safe direction, which is the worst way to be wrong — the gate was quietly tighter
  // than the screen, so every row passed and the operator learned nothing until a real one
  // clipped.
  //
  // The figures come off a real frame, because a measurement cannot be out by a layer
  // nobody thought of. This case pins what that command measured, so a change to the
  // arithmetic has to be made against the frame.
  it("a row gets 52 columns, at the host's own default dialog", () => {
    assert.equal(DIALOG_WIDTH, 60, "medium — the host's default, which is why no screen of ours calls setSize at all");
    assert.equal(dialogRowText(DIALOG_WIDTH), 52, "60 less the scrollbox's 1+1 and the row's 3+3");
    assert.ok(fitsItsDialog({ title: "M".repeat(52) }), "52 fits, because 52 is what fits");
    assert.ok(!fitsItsDialog({ title: "M".repeat(53) }), "and 53 is clipped by the host, silently, with no ellipsis");
  });

  it("and every screen of ours fits in it, which is why there is one width and not two", () => {
    // The list was `large` for a round, because a 40-character agent name and a 30-character
    // summary shared a row. The row is 34 characters now — `2 concurrency * 3/4 depth` —
    // because the figures lost their labels' preamble and their provenance, so the widest
    // realistic name that fits is 17 characters and the host's default holds every screen.
    // A width is a fact about the content; a content change that makes a width unnecessary
    // should be allowed to delete the width, or it will outlive its reason.
    for (const name of REGISTERED) {
      assert.ok(fitsItsDialog({ description: "4 concurrency * 3/4 depth", title: `${name}:` }), `${name} and both of its figures fit one row`);
    }
  });

  it("a description shares the title's line, so a long name eats it", () => {
    assert.ok(!fitsItsDialog({ description: "x".repeat(20), title: "M".repeat(40) }), "40 + 1 + 20 is 61, over a row of 52");
    assert.ok(fitsItsDialog({ description: "x".repeat(20), title: "M".repeat(30) }), "30 + 1 + 20 is 51, and fits");
  });
});

describe("a row fits the dialog it is drawn in", () => {
  it("for an agent carrying both caps, stated and inherited", () =>
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      assertEveryRowFits(list);
      assert.match(rowText(list, "explore"), /2 concurrency/, "and the caps are on screen, not clipped away");
    }));

  it("counts the FOOTER's width, because the host will not shrink it and the title will", () => {
    // Measured against the host at this tag rather than reasoned about. An option row is
    // `<box flexDirection="row" paddingLeft={3} paddingRight={3} gap={1}>` (dialog-select
    // .tsx:666) holding one `Option`, whose title is `<text flexGrow={1}
    // overflow="hidden" paddingLeft={3}>` and whose footer is `<box flexShrink={0}>`
    // (dialog-select.tsx:786). The footer therefore cannot give ground — the TITLE does,
    // into a clip with no ellipsis. This gate measured the title alone, which is how the
    // case below could claim a 37-character agent name fits beside its caps: 37 < 72, when
    // the host gives the two of them 68 columns between them.
    const caps = plainSummary(agentEntry("explore", BOUND_DEPTH));
    assert.ok(caps.length > 20, `the footer measured is one production really builds, not a fixture: "${caps}"`);
    assert.equal(fitsItsDialog({ title: LONG_AGENT_NAME }, caps.length), false,
      "a long name beside its caps is over the row, and the old arithmetic called it fine");
  });

  it("rides each agent's caps beside its name, and keeps the right edge clear", () =>
    // Rendered, this is the screen's actual failure, and no styling fixes it. The title is
    // a <text flexGrow={1}> and the footer a <box flexShrink={0}> inside a flexDirection
    // "row" (dialog-select.tsx:666,786), so a footer is pushed to the FAR edge and the
    // title's space absorbs the distance: `explore` in column 3, `at once 2` in column 35.
    // The eye travels the whole row to relate them.
    //
    // `description` is the field the host itself puts the muted text in, rendered inside
    // the title's own `<text>`, so the two are one line and one span. Every other select
    // in this host uses it for exactly this and the host picks its colour at paint time
    // from the row's state, which is what a hand-built `fg()` chunk could not do.
    withList(BOUND_DEPTH, (list) => {
      const explore = row(list, "explore");
      assert.equal(explore.footer, undefined, "no footer, so nothing is stranded at the right edge");
      // An EQUALITY, not a `match`: `BETWEEN` is `" * "`, and inside a RegExp that is a
      // quantifier — `concurrency *` means zero or more `y` — so the pattern quietly
      // described something else and the case was testing the regex.
      assert.equal(explore.description, `2 concurrency${BETWEEN}3/4 depth`, "both caps, figure before noun, on the name's own line");
      assert.equal(rowText(list, "explore"), `Explore: 2 concurrency${BETWEEN}3/4 depth`, "and the terminal shows that whole line");
      assert.doesNotMatch(row(list, "general").description, /config/,
        "and the LIST says nothing about where a figure came from: `from config` appeared on both figures of all twenty rows, forty times in a column, and that is what made the list read as broken strings. Where the operator is deciding rather than scanning — the agent's own caps screen — the annotation is still there, because there it answers a question instead of repeating one.");
      assertEveryRowFits(list);
    }));

  it("and a name too WIDE for its caps drops the caps whole, rather than clipping them", () =>
    // The host clips the line with no ellipsis, so a name that cannot share its row has
    // two honest choices: lose the agent, or lose the caps. And it has to lose them
    // WHOLE. A row ending `depth 3` looks like a bound and is a truncation, and nothing
    // on the screen distinguishes the two — which is the failure a silent clip always is.
    //
    // So the screen asks the width gate, and the gate's verdict is acted on here rather
    // than reported and ignored. It is the gate's one caller that consumes its answer,
    // which is the only arrangement in which it can be one.
    withList(undefined, async (list) => {
      const wide = row(list, LONG_AGENT_NAME);
      assert.ok(wide, "the host published it, so it is a row");
      assert.equal(wide.description, undefined, "and the caps went with it, whole — a clipped figure is a lie about a bound");
      assert.equal(wide.title, `${displayName(LONG_AGENT_NAME)}:`, "the name itself is never cut");
      assert.ok(wide.value !== undefined && wide.value.kind !== undefined, "and the row still opens — it carries the choice that opens it, which is where the caps are in full");
      assertEveryRowFits(list);
    }, { agentNames: [...REGISTERED, LONG_AGENT_NAME] }));

  it("the caps ride in `description`, on the title's own line, and the right edge stays clear", () =>
    // This row has been three fields in two rounds and every one of them was wrong for a
    // reason no assertion was asking about, and two frames found it.
    //
    // `footer` is where a cell is "at full size" — the premise for two rounds, and false:
    // the title is a `<text flexGrow={1}>` and the footer a `<box flexShrink={0}>` in a
    // `flexDirection="row"`, so a footer is pushed to the far edge of the dialog, a name
    // in column 3 and its caps in column 35, on a row that reads as two unrelated
    // statements. `details` fixed the position by becoming a column child, and cost a
    // field the host does not declare, an indent, and the caps' colour — a `details` line
    // is a string, because the host runs it through `Locale.truncateMiddle` and a
    // `StyledText` has no `.slice`.
    //
    // `description` is the field every native dialog in this host uses for the muted text
    // after a title, and the host draws it in the title's own `<text>`, so it follows the
    // selection bar and costs nothing to declare.
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      const found = row(list, "explore");
      const caps = plainSummary(agentEntry("explore", { agents: { explore: bothCaps(2, 3) } }));
      assert.equal(found.footer, undefined, "no footer, so nothing is stranded at the right edge");
      assert.equal(found.description, caps, "the caps are the row's description, in the host's own spelling");
      assert.equal(rowText(list, "explore"), `${displayName("explore")}: ${caps}`, "one line, and the terminal shows all of it");
    }));
});