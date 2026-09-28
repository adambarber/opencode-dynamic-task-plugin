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
import { flagWidthsAgree, inForceFlag, plainCell, plainSummary, screenTokens, widthsAgree } from "../../dist/tui/theme.js";
import { capCellOf } from "../../dist/tui/agent-editor.js";
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

describe("a cell says the value, then whatever qualifies it", () => {
  // The TEXT is the contract that survived. The styled form is gone: a frame showed a
  // footer's value stranded 60 columns from its label, so the caps moved into `details`,
  // which the host runs through `Locale.truncateMiddle` and so cannot carry a
  // `StyledText`. The cells are plain text now, and the width the layout gate measures
  // is measured against exactly what is written here — which is why these claims are
  // about the string and not about a colour.
  it("states a number with no qualifier at all, rather than an empty one", () => {
    assert.equal(plainCell(capCell(4, true)), "4", "a stated cap is the number, full stop");
  });

  it("prints BOTH numbers when the agent set holds the depth below the cap", () => {
    // The cap is what the operator typed and the reachable depth is what a dispatch is
    // judged against, so printing only one of them is printing a number that is not in
    // force — on the very screen the cap is set on.
    assert.equal(plainCell(capCell(4, false, 3)), "3/4 agent set binds", "the reachable depth first, the cap beside it");
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
      assert.equal(plainCell(capCellOf(entry, "maxDepth")), "4 from config", "one number, and no ceiling that is not holding it down");
    }
  });

  it("leaves a concurrency cell with no ceiling, because nothing bounds it but its own value", () => {
    const entry = row({ maxConcurrent: 4, maxDepth: 4 }, {}, bound(4, 2));
    // `2/4` here would be the depth's ceiling bleeding into a number it has nothing to do
    // with — the one place a per-row field could be read as a per-screen one.
    assert.equal(plainCell(capCellOf(entry, "maxConcurrent")), "4 from config", "the agent set bounds depth, not concurrency");
  });

  it("draws a note in the label's tier when the theme declares no aside, rather than leaving it invisible", () => {
    // `syntaxComment` is optional in a theme's JSON even though the host's type declares
    // it, so the fallback is load-bearing: a note with no tier of its own would take the
    // host's muted wrapper and read as a value. Degrading to the two-tier screen is the
    // honest outcome here.
    const bare = screenTokens(bareTheme());
    assert.deepEqual(bare.aside, bare.context, "a theme with no aside role falls back to the label's");
    assert.deepEqual(bare.value, darkTheme().current.text, "and the value is unaffected by the missing role");
  });
});

describe("the in-force flag and its plain twin are the same words", () => {
  // The one styled thing a row still draws, and so the one place the two forms can drift.
  // A flag that added a character in paint but not in the budget would be clipped by
  // exactly what the width arithmetic said it was not.
  it("agrees", () => {
    assert.ok(flagWidthsAgree(inForceFlag(TOKENS)), "the painted flag is the flag the gate measures");
  });

  it("wears the value tier and BOLD, because the host paints this gutter in muted", () => {
    // The host draws its own `current()` indicator in the same gutter, in `muted`. A flag
    // there in `muted` is the gutter — and "which value am I changing FROM" is the one
    // piece of state a picker must not make invisible. Proved against a real frame by
    // `scripts/render-proof.js`; this is the same claim in the unit suite.
    const flag = inForceFlag(TOKENS);
    assert.deepEqual(flag.chunks[0].fg, TOKENS.value, "the flag survives the host's muted wrapper");
    assert.equal(flag.chunks[0].attributes & TextAttributes.BOLD, TextAttributes.BOLD, "and is bold");
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

