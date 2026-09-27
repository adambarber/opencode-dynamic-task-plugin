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
import { darkTheme, lightTheme } from "./support/harness.js";

const THEME = darkTheme();
const TOKENS = screenTokens(THEME);

/** The row a case needs: one cap stated, the other inherited. */
const row = (resolved, stated) => ({ name: "explore", resolved, stated });

/** The runs of a footer, by their text, so a case can name one without its index. */
const runOf = (footer, text) => footer.chunks.find((run) => run.text === text);

describe("the design tokens are roles, not colours", () => {
  it("resolves both roles from the theme in force, so a light theme is not painted dark", () => {
    const light = screenTokens(lightTheme());
    assert.notDeepEqual(light.value, TOKENS.value, "the value follows the theme rather than a constant");
    assert.notDeepEqual(light.context, TOKENS.context, "and so does the qualifier");
  });

  it("takes the value from `text`, the token the host derives from the TERMINAL's own foreground", () => {
    assert.deepEqual(TOKENS.value, THEME.current.text, "not selectedListItemText, which a theme may never define");
    assert.deepEqual(TOKENS.context, THEME.current.textMuted, "the qualifier is the host's own de-emphasis token");
  });
});

describe("a cell separates the value from what qualifies it", () => {
  it("paints the number in the value role, in BOLD, because colour is the theme's to change and weight is not", () => {
    const footer = cellFooter({ value: 4, stated: true }, TOKENS);
    const value = runOf(footer, "4");
    assert.deepEqual(value.fg, TOKENS.value, "the number wears the value role");
    assert.equal(value.attributes & TextAttributes.BOLD, TextAttributes.BOLD, "and is bold");
  });

  it("paints the qualifier in the context role and NOT bold, so it reads as metadata", () => {
    const footer = cellFooter({ value: 4, stated: false }, TOKENS);
    const qualifier = runOf(footer, " from config");
    assert.deepEqual(qualifier.fg, TOKENS.context, "the qualifier is recessive");
    assert.equal(qualifier.attributes & TextAttributes.BOLD, 0, "and carries no weight the value has");
  });

  it("states a number with no qualifier at all, rather than an empty one", () => {
    const footer = cellFooter({ value: 4, stated: true }, TOKENS);
    assert.equal(footerText(footer), "· 4", "a stated cap is the number and its mark, full stop");
  });

  it("marks a whole cell off from the row's title, because the host draws the two hard against each other", () => {
    const footer = cellFooter({ value: 4, stated: true }, TOKENS);
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
    const stated = { value: 4, stated: true };
    const inherited = { value: 4, stated: false };
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

/** A footer's characters, whichever of the two things a footer can be. */
function footerText(footer) {
  return typeof footer === "string" ? footer : footer.chunks.map((run) => run.text).join("");
}
