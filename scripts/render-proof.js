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

/** The colours a dark terminal hands the host, which is where `theme.text` comes from. */
const value = RGBA.fromInts(0xd0, 0xd0, 0xd0);
const context = RGBA.fromInts(0x6c, 0x6c, 0x6c);

/** What `summaryRuns` and `cellFooter` build, spelled the way theme.ts builds them. */
const runs = () => [
  { __isChunk: true, text: "at once ", fg: context },
  { __isChunk: true, text: "2", fg: value, attributes: TextAttributes.BOLD },
  { __isChunk: true, text: " · ", fg: context },
  { __isChunk: true, text: "1", fg: value, attributes: TextAttributes.BOLD },
  { __isChunk: true, text: " from config", fg: context },
];

/** The host's row: a muted `<text>` wrapping whatever we set as the footer. */
const row = () => {
  const footer = jsx("span", { children: new StyledText(runs()) });
  return jsx("box", { children: jsx("text", { fg: context, children: footer }) });
};

const setup = await testRender(row, { width: 60, height: 3 });
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
const claims = [
  ["the number is the value colour, not the host's muted wrapper", spans, (s) => s.text.trim() === "2" && hexOf(s) === asHex(value)],
  ["the number is bold", spans, (s) => s.text.trim() === "2" && (s.attributes & TextAttributes.BOLD) === TextAttributes.BOLD],
  ["the second number is too", spans, (s) => s.text.trim() === "1" && hexOf(s) === asHex(value)],
  ["the qualifier stays muted", spans, (s) => s.text.includes("from config") && hexOf(s) === asHex(context)],
  ["the label stays muted", spans, (s) => s.text.includes("at once") && hexOf(s) === asHex(context)],
];

let broken = 0;
for (const [claim, , holds] of claims) {
  const ok = spans.some(holds);
  if (!ok) broken += 1;
  console.log(`${ok ? "holds " : "BROKEN"}  ${claim}`);
}
if (broken > 0) {
  console.error(`\n${broken} claim(s) broken. Captured spans:`);
  for (const span of spans) console.error("  ", JSON.stringify(span.text), hexOf(span), "attributes:", span.attributes);
}
process.exit(broken === 0 ? 0 : 1);
