/**
 * The render proof: the host's own row markup, our footer inside it, read back.
 *
 * The one claim the unit suite cannot make. `node --test` cannot render — opentui's
 * renderer is a native FFI library and only bun can load it — so "the host's muted
 * wrapper does not repaint our runs" is checked HERE, against the host's real shape,
 * with the colours captured off the screen rather than asserted from the source that
 * produced them.
 *
 * The tree below is copied from the host, not paraphrased: `<text fg={...}>{footer}</text>`
 * is packages/tui/src/ui/dialog-select.tsx:786, and the muted/selectedForeground choice
 * is :781. If the host changes how it wraps a footer, this stops being a proof of the
 * screen's behaviour and the suite's own spread-for-`details` note is the thing to
 * re-read; run it and watch it fail.
 *
 * Run: bun scripts/render-proof.js   (exits non-zero on a broken claim)
 */
import { RGBA, StyledText, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import { screenTokens, summaryRuns } from "../dist/tui/theme.js";
import { capCellOf } from "../dist/tui/agent-editor.js";

/** The colours a dark terminal hands the host, which is where `theme.text` comes from. */
const value = RGBA.fromInts(0xd0, 0xd0, 0xd0);
const context = RGBA.fromInts(0x6c, 0x6c, 0x6c);
const aside = RGBA.fromInts(0x50, 0x50, 0x50);

/**
 * The row, built by the PRODUCTION functions.
 *
 * This file used to hand-spell the runs, which made it a proof of one claim while
 * looking like a proof of two: the host's wrapper was exercised, but the runs inside it
 * were a paraphrase, so a change to `summaryRuns` — a new tier, a dropped separator, a
 * different qualifier — left this green while the screen said something else. The screen
 * is the thing under test, so the screen's own builder produces the runs.
 */
const TOKEN_THEME = { current: { text: value, textMuted: context, accent: RGBA.fromInts(0x88, 0x88, 0xff), syntaxComment: aside }, mode: () => "dark" };
const tokens = screenTokens(TOKEN_THEME);
const row = (entry) => ({ name: entry.name, resolved: entry.resolved, stated: entry.stated, depth: entry.depth });
const runs = () => summaryRuns(row(entry()), tokens);

/**
 * The row this proof renders: two DIFFERENT numbers, over a bounded depth.
 *
 * Distinct on purpose. With `maxConcurrent: 2` and an effective depth of 2 the two
 * figures rendered the same text, so the depth claim was satisfied by the CONCURRENCY
 * span — and the proof went green with the depth painted in the wrong colour, which is
 * the one thing it exists to catch. Two claims that name different things have to be
 * told apart by their evidence, or neither is a claim.
 */
const entry = () => ({
  name: "explore",
  resolved: { maxConcurrent: 2, maxDepth: 4 },
  stated: {},
  depth: { configured: 4, effective: 3, boundBy: "agent-set" },
});

/** The host's row: a muted `<text>` wrapping whatever we set as the footer. */
const host = () => {
  const footer = jsx("span", { children: new StyledText(runs()) });
  return jsx("box", { children: jsx("text", { fg: context, children: footer }) });
};

const setup = await testRender(host, { width: 60, height: 3 });
await setup.renderOnce();
const spans = setup
  .captureSpans()
  .lines.flatMap((line) => line.spans)
  .filter((span) => span.text.trim() !== "");

/**
 * A colour as `#rrggbb`, off the byte buffer both an RGBA and a captured span carry.
 *
 * A captured `fg` is the renderer's own value rather than an RGBA instance, and both
 * spell the colour the same way — four bytes — so one reader serves an expectation and
 * an observation. A missing buffer is a claim this cannot make, and it reads as "" so
 * the comparison fails rather than passing on a default.
 */
const asHex = (colour) => {
  const buffer = colour?.buffer;
  if (!buffer) return "";
  const channel = (at) => Number(buffer[at] ?? 0).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
};
const hexOf = (span) => asHex(span.fg);
/**
 * Every span whose text IS `text`, and null when none does.
 *
 * `some` is the wrong combinator for a claim about a specific span: it is satisfied by
 * the wrong one. A claim that names the reachable depth must be answered by spans that
 * ARE the reachable depth, and every one of them — so a second span carrying the same
 * text cannot vouch for the first.
 */
const spansOf = (text) => {
  const found = spans.filter((span) => span.text.trim() === text);
  return found.length === 0 ? null : found;
};
const claims = [
  ["the concurrency number is the value colour, not the host's muted wrapper", "2", (s) => hexOf(s) === asHex(value)],
  ["the concurrency number is bold", "2", (s) => (s.attributes & TextAttributes.BOLD) === TextAttributes.BOLD],
  ["the REACHABLE depth is the value colour, which a same-text trap once hid", "3", (s) => hexOf(s) === asHex(value)],
  ["the reachable depth is bold, so the pair reads as one figure", "3", (s) => (s.attributes & TextAttributes.BOLD) === TextAttributes.BOLD],
  ["the cap it is held below is the ASIDE tier, not the label's", "/4", (s) => hexOf(s) === asHex(aside)],
  ["the reason it is held down is in the aside tier too", "agent set binds", (s) => hexOf(s) === asHex(aside)],
  ["the label stays muted, so the eye lands on the figures", "at once", (s) => hexOf(s) === asHex(context)],
];

let broken = 0;
for (const [claim, text, holds] of claims) {
  const found = spansOf(text);
  const ok = found !== null && found.every(holds);
  if (!ok) broken += 1;
  console.log(`${ok ? "holds " : "BROKEN"}  ${claim}${found === null ? "  (no such span was rendered)" : ""}`);
}
if (broken > 0) {
  console.error(`\n${broken} claim(s) broken. Captured spans:`);
  for (const span of spans) console.error("  ", JSON.stringify(span.text), hexOf(span), "attributes:", span.attributes);
}
process.exit(broken === 0 ? 0 : 1);
