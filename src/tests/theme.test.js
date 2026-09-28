/**
 * The design tokens, as claims a render can be checked against.
 *
 * These assert on the RUNS rather than on a rendered screen because a render is not
 * available in this suite: opentui's renderer is a native FFI library, so `testRender`
 * needs bun and this suite runs under `node --test`. The runs ARE the colour — a
 * `TextChunk` carries the `fg` and the `attributes` the renderer will use — so asserting
 * on them asserts the thing that decides the output rather than a stand-in for it.
 *
 * The one claim here that is NOT settled by reading the runs is the cascade: that the
 * host's own `<text fg={textMuted}>` wrapper does not repaint our runs. That is a fact
 * about the host's row markup, so it is proven where the host is, by
 * `scripts/render-proof.sh`, which renders the real shape under bun and reads the spans
 * back. Nothing in this file can establish it, which is why the script exists.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { TextAttributes } from "@opentui/core";
import { cellFooter, plainCell, plainSummary, screenTokens, summaryFooter, summaryRuns, widthsAgree } from "../../dist/tui/theme.js";
import { capCellOf } from "../../dist/tui/agent-editor.js";
import { footerText } from "./support/assertions.js";
import { bareTheme, capCell, darkTheme, lightTheme, themeRoles } from "./support/harness.js";

const THEME = darkTheme();
const TOKENS = screenTokens(THEME);

/**
 * The row a case needs: one cap stated, the other inherited.
 *
 * `depth` defaults to the UNBOUND shape — the cap is what holds it — so a case that
 * says nothing about nesting gets the ordinary `depth 2` rather than a ceiling it never
 * asked for. `bound` builds the other one: the agent set holding it below the cap.
 */
const unbound = (configured) => ({ configured, effective: configured, boundBy: null });
const row = (resolved, stated, depth = unbound(resolved.maxDepth)) => ({ name: "explore", resolved, stated, depth });
/** A depth the agent set holds below the cap, which is the only bound worth drawing. */
const bound = (configured, effective) => ({ configured, effective, boundBy: "agent-set" });

/** The runs of a footer, by their text, so a case can name one without its index. */
const runOf = (footer, text) => footer.chunks.find((run) => run.text === text);

describe("the design tokens are roles, not colours", () => {
  it("resolves every role from the theme in force, so a light theme is not painted dark", () => {
    const light = screenTokens(lightTheme());
    assert.notDeepEqual(light.value, TOKENS.value, "the value follows the theme rather than a constant");
    assert.notDeepEqual(light.context, TOKENS.context, "and so does the label");
    assert.notDeepEqual(light.aside, TOKENS.aside, "and so does the note");
  });

  it("takes the value from `text`, the token the host derives from the TERMINAL's own foreground", () => {
    assert.deepEqual(TOKENS.value, THEME.current.text, "not selectedListItemText, which a theme may never define");
    assert.deepEqual(TOKENS.context, THEME.current.textMuted, "the label is the host's own de-emphasis token");
  });

  it("takes the note from `syntaxComment`, the host's role for readable-but-recessive annotation", () => {
    // A provenance note IS a comment on a value, and the host already has a role for that
    // — one of some fifty this module was not reading. The alternative was a third hex,
    // which reads as "bright" against a dark terminal and vanishes against a light one.
    assert.deepEqual(TOKENS.aside, THEME.current.syntaxComment, "the note is a note, in the host's own words for one");
  });

  it("resolves a tier below the label in BOTH fixtures, because a tier one side cannot see is not a tier", () => {
    // This is the pin that would have caught the drift: `syntaxComment` was missing from
    // the light fixture while the tier that reads it was already written, so every claim
    // about the note's tier passed against a theme that had none. The two fixtures now
    // take their shape from one place, and this says so rather than trusting it.
    const dark = screenTokens(darkTheme());
    const light = screenTokens(lightTheme());
    assert.deepEqual(themeRoles(), Object.keys(lightTheme().current), "the fixtures declare the same roles");
    assert.deepEqual(Object.keys(light), Object.keys(dark), "and the screen reads the same tiers from each");
    for (const tier of ["value", "context", "aside"]) {
      assert.notDeepEqual(light[tier], dark[tier], `the ${tier} tier follows the theme, in both fixtures`);
    }
  });
});

describe("a cell separates the value from what qualifies it", () => {
  // One bounded depth, built once: the two cases below ask different questions about the
  // SAME figure, and a pair that each rebuilt it could disagree about it without either
  // of them failing — which is how a cell ends up painted one way and asserted another.
  const BOUNDED = cellFooter(capCell(4, false, 3), TOKENS);

  it("paints the number in the value role, in BOLD, because colour is the theme's to change and weight is not", () => {
    const footer = cellFooter(capCell(4, true), TOKENS);
    const value = runOf(footer, "4");
    assert.deepEqual(value.fg, TOKENS.value, "the number wears the value role");
    assert.equal(value.attributes & TextAttributes.BOLD, TextAttributes.BOLD, "and is bold");
  });

  it("paints the note a TIER below the label, because muting it is not the same as setting it apart", () => {
    // The operator read `4 from config` as a two-word value twice, and muting the note to
    // the label's own colour is what had already been tried. What makes a note a note is
    // being quieter than the LABEL, not quieter than the number — one step below the
    // label, so the row reads `at once` (label) `4` (value) `from config` (a note ABOUT
    // the 4) as three kinds of thing rather than five words with two of them bright.
    const footer = cellFooter(capCell(4, false), TOKENS);
    const note = runOf(footer, " from config");
    assert.deepEqual(note.fg, TOKENS.aside, "the note wears the aside tier");
    assert.notDeepEqual(note.fg, TOKENS.context, "which is not the label's tier — that is the whole point of it");
    assert.equal(note.attributes & TextAttributes.BOLD, 0, "and carries no weight the value has");
  });

  it("draws a note in the label's tier when the theme declares no aside, rather than leaving it invisible", () => {
    // `syntaxComment` is optional in a theme's JSON even though the host's type declares
    // it, so the fallback is load-bearing: a note painted in an inherited colour would
    // take the host's muted wrapper, and the operator would be back to reading it as a
    // value. Degrading to the two-tier screen is the honest outcome here.
    const bare = screenTokens(bareTheme());
    assert.deepEqual(bare.aside, bare.context, "a theme with no aside role falls back to the label's");
    assert.deepEqual(bare.value, darkTheme().current.text, "and the value is unaffected by the missing role");
  });

  it("states a number with no qualifier at all, rather than an empty one", () => {
    const footer = cellFooter(capCell(4, true), TOKENS);
    assert.equal(footerText(footer), "· 4", "a stated cap is the number and its mark, full stop");
  });

  it("prints BOTH numbers when the agent set holds the depth below the cap", () => {
    // The cap is what the operator typed and the reachable depth is what a dispatch is
    // judged against, so printing only one of them is printing a number that is not in
    // force — on the very screen the cap is set on.
    assert.equal(footerText(BOUNDED), "· 3/4 agent set binds", "the reachable depth first, the cap beside it");
  });

  it("puts the reachable depth in the loud role and the cap it is held below in the ASIDE tier", () => {
    assert.deepEqual(runOf(BOUNDED, "3").fg, TOKENS.value, "the depth that binds dispatches is the figure");
    assert.deepEqual(runOf(BOUNDED, "/4").fg, TOKENS.aside, "the cap beside it is a note about that figure, not a label beside it");
    assert.deepEqual(runOf(BOUNDED, " agent set binds").fg, TOKENS.aside, "and so is the reason it is held down");
    assert.equal(runOf(BOUNDED, "3").attributes & TextAttributes.BOLD, TextAttributes.BOLD, "and the pair reads as one figure");
  });

  it("prints one number when the bound is at or above the cap, because 4/4 says nothing new", () => {
    // The DECISION is `ceilingOf`'s, not the renderer's, so this goes through a row: a
    // renderer handed `bounded: 4` correctly prints the pair, because by then a caller
    // has already said there is a ceiling. What must not happen is a ceiling being
    // INVENTED for a depth nothing is holding down.
    const atCap = row({ maxConcurrent: 4, maxDepth: 4 }, {}, bound(4, 4));
    const aboveCap = row({ maxConcurrent: 4, maxDepth: 4 }, {}, { configured: 4, effective: 9, boundBy: "agent-set" });
    const unknown = row({ maxConcurrent: 4, maxDepth: 4 }, {}, { configured: 4, effective: null, boundBy: "agent-set" });
    for (const entry of [atCap, aboveCap, unknown]) {
      assert.equal(footerText(cellFooter(capCellOf(entry, "maxDepth"), TOKENS)), "· 4 from config", "one number, and no ceiling that is not holding it down");
    }
  });

  it("leaves a concurrency cell with no ceiling, because nothing bounds it but its own value", () => {
    const entry = row({ maxConcurrent: 4, maxDepth: 4 }, {}, bound(4, 2));
    // `2/4` here would be the depth's ceiling bleeding into a number it has nothing to do
    // with — the one place a per-row field could be read as a per-screen one.
    assert.equal(footerText(cellFooter(capCellOf(entry, "maxConcurrent"), TOKENS)), "· 4 from config", "the agent set bounds depth, not concurrency");
  });

  it("keeps the width contract on a bounded depth, which is the longest cell there is", () => {
    const bounded = row({ maxConcurrent: 6, maxDepth: 4 }, { maxDepth: 4 }, bound(4, 2));
    assert.ok(
      widthsAgree(summaryRuns(bounded, TOKENS), plainSummary(bounded)),
      "a row carrying both numbers is the one most likely to be clipped, so the budget must measure it",
    );
  });

  it("marks a whole cell off from the row's title, because the host draws the two hard against each other", () => {
    const footer = cellFooter(capCell(4, true), TOKENS);
    assert.deepEqual(runOf(footer, "· ").fg, TOKENS.context, "the mark is punctuation, so it is context");
  });
});

describe("an agent's row reads label then value, twice", () => {
  it("paints both LABELS in the context role, so the eye lands on the figures", () => {
    const footer = summaryFooter(row({ maxConcurrent: 1, maxDepth: 1 }, { maxConcurrent: 1 }), TOKENS);
    assert.deepEqual(runOf(footer, "at once ").fg, TOKENS.context, "the label is context, not content");
    assert.deepEqual(runOf(footer, "depth ").fg, TOKENS.context, "both of them");
  });

  it("paints each number in the value role, so the two are comparable at a glance", () => {
    const footer = summaryFooter(row({ maxConcurrent: 1, maxDepth: 1 }, { maxConcurrent: 1, maxDepth: 1 }), TOKENS);
    for (const text of ["1"]) {
      const value = footer.chunks.filter((run) => run.text === text);
      assert.equal(value.length, 2, "both caps' numbers are their own runs");
      for (const run of value) {
        assert.deepEqual(run.fg, TOKENS.value, `a number wears the value role`);
        assert.equal(run.attributes & TextAttributes.BOLD, TextAttributes.BOLD, "and is bold");
      }
    }
  });
});

describe("the painted row and the plain row are the same row", () => {
  it("agrees on a cell that is stated, and on one that is inherited", () => {
    const stated = capCell(4, true);
    const inherited = capCell(4, false);
    assert.ok(widthsAgree(cellFooter(stated, TOKENS).chunks, `· ${plainCell(stated)}`), "stated");
    assert.ok(widthsAgree(cellFooter(inherited, TOKENS).chunks, `· ${plainCell(inherited)}`), "inherited");
  });

  it("agrees on a whole row, which is the width the layout budget is measured in", () => {
    const entry = row({ maxConcurrent: 2, maxDepth: 3 }, { maxConcurrent: 2 });
    assert.ok(
      widthsAgree(summaryRuns(entry, TOKENS), plainSummary(entry)),
      "a run that added or dropped a character would be clipped by exactly what the budget said it was not",
    );
  });
});

describe("screenTokens", () => {
  it("draws the value in the theme's own foreground, not a literal", () => {
    // The claim that started this: a hard bright white reads as "bright" in a dark theme
    // and as INVISIBLE in a light one. So the value must be a ROLE, and the two fixtures
    // must disagree about it — otherwise this suite would pass with a literal in place.
    assert.notEqual(
      screenTokens(darkTheme()).value.buffer.join(),
      screenTokens(lightTheme()).value.buffer.join(),
      "a literal colour would satisfy both themes and be unreadable in one of them",
    );
  });

  it("falls back to a present role when the theme omits the foreground", () => {
    // A theme's JSON may omit a key the host's TYPE declares as always there — the host
    // guards selectedListItemText that way itself. Without a fallback the value renders
    // INHERITED, which is the muted colour this module exists to take it out of, and
    // nothing fails.
    const noForeground = { current: { textMuted: darkTheme().current.textMuted, accent: darkTheme().current.accent } };
    assert.equal(
      screenTokens(noForeground).value.buffer.join(),
      darkTheme().current.accent.buffer.join(),
      "a missing foreground must land on a colour that is present, not on nothing",
    );
  });

  it("prefers the foreground over the fallback when both are there", () => {
    assert.equal(screenTokens(darkTheme()).value.buffer.join(), darkTheme().current.text.buffer.join());
  });
});

