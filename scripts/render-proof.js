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
import { inForceFlag, screenTokens } from "../dist/tui/theme.js";

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

/**
 * What this renders, and why it is what the screen actually draws.
 *
 * It USED to be the cap cells, and that is the whole reason this file changed shape. A
 * frame showed a footer's value stranded 60 columns from its label, so the caps moved
 * into `details` — which the host runs through `Locale.truncateMiddle`, i.e. `str.length`
 * and `str.slice`, so it cannot carry a `StyledText` and the caps lost their colour tiers.
 * `in force` is the one styled thing left on a row: a status flag, two words, sitting in
 * the gutter the host paints its own `current()` indicator in, where being muted is what
 * makes it a flag rather than a value.
 */
const runs = () => inForceFlag(tokens).chunks;

/**
 * The host's row: a muted `<text>` wrapping whatever we set as the footer.
 *
 * A STRING footer is wrapped in exactly this `<text fg={muted}>` too, and a string
 * arrives already greyed, so the host's wrapper is a no-op on it. That is the reason the
 * flag is a `StyledText` rather than a literal, and it is a fact about the host rather
 * than about us — so it is proved here, against the real thing.
 */
const host = () => {
  const footer = jsx("span", { children: new StyledText(runs()) });
  return jsx("box", { children: jsx("text", { fg: context, children: footer }) });
};

/**
 * The whole SCREEN, drawn by the host's own row markup, read back as text.
 *
 * `testRender` takes the COMPONENT, not its result, and calls it inside the renderer
 * context — so a `jsx` call outside one throws "No renderer found", which is why this
 * is a thunk per screen rather than a tree built up front.
 *
 * The proof below checks COLOUR, and colour is the smaller half of whether a screen
 * reads. The larger half is where things SIT: the title is a `<text flexGrow={1}>` and
 * the footer a `<box flexShrink={0}>` inside a `flexDirection="row"`, so a footer is
 * pushed to the far edge of the dialog with the title's space absorbing the distance —
 * an agent's name in column 3 and its caps in column 35, on a row that reads as two
 * unrelated statements. Reading the host's flexbox did not surface that. A frame did,
 * immediately, and the layout was wrong in a way no assertion had been asking about.
 *
 * So this prints the screens the plugin actually builds. Not a claim — an artifact.
 * Whatever it prints is what the terminal will show, which is the only answer to "does
 * it look right" that has ever been worth anything.
 *
 * Run: bun scripts/render-proof.js --screen
 */
if (process.argv.includes("--screen")) {
  const { agentDialogFrom } = await import("../dist/tui/agent-editor.js");
  const { agentCapsProps, capPickerProps, ceilingPickerProps, limitsListProps } = await import("../dist/tui/index.js");

  const OVERLAY = { agents: { explore: { maxConcurrent: 2, maxDepth: 4 } } };
  const dialog = agentDialogFrom(OVERLAY, { maxConcurrent: 4, maxDepth: 2, allowSameAgentRecursion: false }, ["explore", "general", "review"], false, null);
  const explore = dialog.rows.find((r) => r.name === "explore");
  const actions = { confirm: () => {}, back: () => {} };
  const t = screenTokens(TOKEN_THEME);
  const screens = [
    ["the list - the total above every agent", limitsListProps(dialog, () => {})],
    ["the depth picker, where the agent set binds it at 3", capPickerProps("explore", "maxDepth", explore, actions, t)],
    ["the concurrency picker, where nothing binds it", capPickerProps("explore", "maxConcurrent", explore, actions, t)],
    ["the total's picker", ceilingPickerProps(dialog.ceiling, actions, t)],
  ];

  /** The host's own Option body (dialog-select.tsx:660-690), verbatim in geometry. */
  const option = (o) => {
    const head = o.title + (o.description ? ` ${o.description}` : "");
    return jsx("box", {
      flexDirection: "column",
      children: [
        jsx("box", {
          flexDirection: "row", paddingLeft: 3, paddingRight: 3, gap: 1,
          children: [
            jsx("text", { flexGrow: 1, overflow: "hidden", wrapMode: "none", paddingLeft: 3, children: head }),
            ...(o.footer === undefined ? [] : [jsx("box", { flexShrink: 0, children: jsx("text", { children: o.footer }) })]),
          ],
        }),
        ...(o.details ?? []).map((d) => jsx("box", { paddingLeft: 3, paddingRight: 3, children: jsx("text", { fg: context, wrapMode: "none", children: d }) })),
      ],
    });
  };

  /**
   * The host's whole dialog, copied from `dlg.tsx` and `dialog-select.tsx`.
   *
   * The ROWS ALONE were not the screen. Rendered first as a bare column of option rows
   * they read fine, and the real thing was still wrong, because three layers of the host
   * sit around them and were never drawn: the `Dialog` box caps at `width - 2` and adds
   * `paddingTop={1}`; `DialogSelect` draws a header row (`paddingLeft={4} paddingRight={4}`)
   * with the title and `esc`; and — the one that mattered — a `scrollbox` at
   * `paddingLeft={1} paddingRight={1}` holds the rows, so a row is two columns narrower
   * than a `Dialog`-level reading says. Above the rows, unless `renderFilter` is false,
   * the host draws a `Search` input — which was on every one of these screens, including
   * the pickers whose entire option set is ten numbers.
   */
  const FILTERED = screens.some(([, d]) => d.renderFilter !== false);

  const hostDialog = (title, children) =>
    jsx("box", { flexDirection: "column", gap: 1, paddingBottom: 1, flexGrow: 1, children: [
      jsx("box", { paddingLeft: 4, paddingRight: 4, children:
        jsx("box", { flexDirection: "row", justifyContent: "space-between", children: [
          jsx("text", { fg: value, attributes: TextAttributes.BOLD, children: title }),
          jsx("text", { fg: context, children: "esc" }),
        ] }) }),
      ...(FILTERED
        ? [jsx("box", { paddingTop: 1, children: jsx("text", { fg: context, children: "Search" }) })]
        : []),
      jsx("scrollbox", { paddingLeft: 1, paddingRight: 1, scrollbarOptions: { visible: false }, children: children }),
    ] });

  for (const [heading, d] of screens) {
    const shot = await testRender(
      () => jsx("box", { width: 78, backgroundColor: RGBA.fromInts(0, 0, 0), children:
        hostDialog(d.title, jsx("box", { flexDirection: "column", children: d.options.map(option) })) }),
      { width: 80, height: 40 },
    );
    await shot.renderOnce();
    console.log(`\n--- ${heading}`);
    console.log(shot.captureSpans().lines
      .map((line) => line.spans.map((s) => s.text).join("").replace(/\s+$/, ""))
      .filter((line) => line !== "")
      .join("\n"));
  }
  // The width a row's title actually gets, MEASURED rather than derived.
  //
  // Deriving it is what went wrong. The arithmetic in `fitsItsDialog` reads the host's
  // `Dialog` box and the option row, and the chain between them — a `scrollbox` at
  // `paddingLeft={1} paddingRight={1}` — was in neither, so the gate was 2 columns out
  // in the safe direction and its docstring claimed a re-derivation it had not done. A
  // measurement cannot be out by a layer nobody thought of.
  // How many characters of a title actually reach the screen, found by RENDERING lengths
  // rather than by modelling the host's padding chain. Every derived version of this
  // number has been wrong by a layer: the first counted six columns of indent and
  // missed the gap, the second missed the `scrollbox` the rows sit in, and both were
  // confident. A measurement is not.
  const fits = async (makeRow, probe) => {
    const shot = await testRender(
      () => jsx("box", { width: 78, children: hostDialog("T", jsx("box", { flexDirection: "column", children: [makeRow(probe)] })) }),
      { width: 80, height: 8 },
    );
    await shot.renderOnce();
    const line = shot.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("|")));
    if (!line) return false;
    return line.spans.map((sp) => sp.text).join("").includes("|".repeat(probe));
  };
  const longest = async (makeRow) => {
    for (let n = 80; n > 0; n -= 1) {
      if (await fits(makeRow, n)) return n;
    }
    return 0;
  };
  const headline = () => (n) => jsx("box", { flexDirection: "row", paddingLeft: 3, paddingRight: 3, gap: 1, children:
    [jsx("text", { flexGrow: 1, overflow: "hidden", wrapMode: "none", paddingLeft: 3, children: "|".repeat(n) })] });
  const withFooter = () => (n) => jsx("box", { flexDirection: "row", paddingLeft: 3, paddingRight: 3, gap: 1, children:
    [jsx("text", { flexGrow: 1, overflow: "hidden", wrapMode: "none", paddingLeft: 3, children: "|".repeat(n) }),
     jsx("box", { flexShrink: 0, children: jsx("text", { children: "in force" }) })] });
  const detailLine = () => (n) => jsx("box", { flexDirection: "column", children: [
    jsx("box", { paddingLeft: 3, paddingRight: 3, children: jsx("text", { fg: context, wrapMode: "none", children: "|".repeat(n) }) })] });
  // Where the text STARTS, which is the claim the docstrings lean on hardest: "the row
  // spends ten columns before any content". A `<text paddingLeft={3}>` is the only
  // reason to believe in a third indent, and the frame does not show one.
  const indent = async (makeRow) => {
    const shot = await testRender(
      () => jsx("box", { width: 78, children: hostDialog("T", jsx("box", { flexDirection: "column", children: [makeRow(1)] })) }),
      { width: 80, height: 8 },
    );
    await shot.renderOnce();
    const line = shot.captureSpans().lines.find((l) => l.spans.some((sp) => sp.text.includes("|")));
    if (!line) throw new Error("the marked row was not drawn at all");
    return line.spans.map((sp) => sp.text).join("").indexOf("|");
  };
  const titleOnly = await longest(headline());
  const titleAndFooter = await longest(withFooter());
  const detailOnly = await longest(detailLine());
  console.log("\n--- measured at an 80-column terminal (the narrow case)");
  console.log(`a title's own text          ${titleOnly}`);
  console.log(`a title sharing a "in force" ${titleAndFooter}  (so the flag costs ${titleOnly - titleAndFooter - 1} columns plus the 1px gap)`);
  console.log(`a details line              ${detailOnly}`);
  console.log(`a title's text starts at     ${await indent(headline())}  (scrollbox 1 + row 3 = 4, so a text paddingLeft is NOT applied)`);
  console.log(`a details line starts at     ${await indent(detailLine())}`);

  process.exit(0);
}

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
  ["the flag survives the host's muted wrapper, in the VALUE tier", "in force", (s) => hexOf(s) === asHex(value)],
  ["and is bold, so it is a flag rather than a stray word", "in force", (s) => (s.attributes & TextAttributes.BOLD) === TextAttributes.BOLD],
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
