/**
 * The render proof: the host's own dialog markup, our rows inside it, read back.
 *
 * The one claim the unit suite cannot make. `node --test` cannot render — opentui's
 * renderer is a native FFI library and only bun can load it — so "how wide is a row,
 * actually, and what does the screen look like" is answered HERE, against the host's real
 * shape, by reading a frame rather than by reading the source that produced it.
 *
 * The tree below is copied from the host, not paraphrased: the header, the filter input
 * and the `scrollbox` are packages/tui/src/ui/dialog-select.tsx, and the option row is
 * its `Option` component including the `current` marker and the muted `<span>` the
 * description lives in. If the host changes its layout this stops being a proof of the
 * screen's behaviour — run it and watch the numbers move.
 *
 * Run: bun scripts/render-proof.js --screen
 */
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";

/** The colours a dark terminal hands the host, which is where `theme.text` comes from. */
const value = RGBA.fromInts(0xd0, 0xd0, 0xd0);
const context = RGBA.fromInts(0x6c, 0x6c, 0x6c);
const primary = RGBA.fromInts(0x3a, 0x7b, 0xd8);

if (process.argv.includes("--screen")) {
  const { agentDialogFrom } = await import("../dist/tui/agent-editor.js");
  const { agentCapsProps, capPickerProps, ceilingPickerProps, limitsListProps, DIALOG_WIDTH } = await import("../dist/tui/index.js");
  // The dialog is drawn at the width the plugin MOUNTS it — `DIALOG_WIDTH`, capped by the
  // terminal the host draws into. A proof that picks its own width measures a screen the
  // plugin never shows, which is the error this file was rewritten to stop making.
  const DIALOG = Math.min(DIALOG_WIDTH, 80 - 2);

  const OVERLAY = { agents: { explore: { maxConcurrent: 2, maxDepth: 4 } } };
  const dialog = agentDialogFrom(OVERLAY, { maxConcurrent: 4, maxDepth: 2, allowSameAgentRecursion: false }, ["explore", "general", "review"], false, null);
  const explore = dialog.rows.find((r) => r.name === "explore");
  const actions = { confirm: () => {}, back: () => {} };
  const screens = [
    ["the list - the total above every agent", limitsListProps(dialog, () => {})],
    ["the per-agent cap picker, two agents deep", agentCapsProps("explore", explore)],
    ["the depth picker, where the agent set binds it at 3", capPickerProps("explore", "maxDepth", explore, actions)],
    ["the concurrency picker, where nothing binds it", capPickerProps("explore", "maxConcurrent", explore, actions)],
    ["the total's picker", ceilingPickerProps(dialog.ceiling, actions)],
  ];

  /** The host's own Option body (dialog-select.tsx:660-690), verbatim in geometry. */
  // The host's `Option`, including the three things it does that a hand-rolled row does
  // not: it draws a `●` for the dialog's `current`, and it drops that row's left padding
  // from 3 to 1 to make room. Reproducing the row WITHOUT them was a proof of a screen
  // the host never draws — the same class of error as reproducing it without the filter
  // input, which is what hid a Search box sitting on every picker.
  const isSame = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const option = (o, current) => {
    const marked = isSame(o.value, current);
    const head = o.title + (o.description ? ` ${o.description}` : "");
    return jsx("box", {
      flexDirection: "column",
      children: [
        jsx("box", {
          flexDirection: "row", paddingLeft: marked ? 1 : 3, paddingRight: 3, gap: 1,
          children: [
            ...(marked ? [jsx("text", { flexShrink: 0, fg: primary, children: "\u25cf" })] : []),
            jsx("text", { flexGrow: 1, overflow: "hidden", wrapMode: "none", paddingLeft: 3, children: head }),
            ...(o.footer === undefined ? [] : [jsx("box", { flexShrink: 0, children: jsx("text", { fg: context, children: o.footer }) })]),
          ],
        }),
      ],
    });
  };

  // A category heading per group, the way the host groups by `category` and draws the
  // heading in its own accent, with a blank line above every heading after the first.
  const withHeadings = (options, current) => {
    const rows = [];
    let seen = null;
    for (const o of options) {
      if (o.category && o.category !== seen) {
        if (rows.length > 0) rows.push(jsx("box", { children: [] }));
        rows.push(jsx("box", { paddingTop: seen === null ? 0 : 0, paddingLeft: 3, children: jsx("text", { fg: primary, attributes: TextAttributes.BOLD, children: o.category }) }));
        seen = o.category;
      }
      rows.push(option(o, current));
    }
    return rows;
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
  const hostDialog = (title, children, filtered) =>
    jsx("box", { flexDirection: "column", gap: 1, paddingBottom: 1, flexGrow: 1, children: [
      jsx("box", { paddingLeft: 4, paddingRight: 4, children:
        jsx("box", { flexDirection: "row", justifyContent: "space-between", children: [
          jsx("text", { fg: value, attributes: TextAttributes.BOLD, children: title }),
          jsx("text", { fg: context, children: "esc" }),
        ] }) }),
      ...(filtered
        ? [jsx("box", { paddingTop: 1, children: jsx("text", { fg: context, children: "Search" }) })]
        : []),
      jsx("scrollbox", { paddingLeft: 1, paddingRight: 1, scrollbarOptions: { visible: false }, children: children }),
    ] });

  for (const [heading, d] of screens) {
    const shot = await testRender(
      () => jsx("box", { width: DIALOG, backgroundColor: RGBA.fromInts(0, 0, 0), children:
        hostDialog(d.title, jsx("box", { flexDirection: "column", children: withHeadings(d.options, d.current) }), d.renderFilter !== false) }),
      { width: 80, height: 40 },
    );
    await shot.renderOnce();
    console.log(`\n--- ${JSON.stringify(heading)}`);
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
      () => jsx("box", { width: DIALOG, children: hostDialog("T", jsx("box", { flexDirection: "column", children: [makeRow(probe)] }), false) }),
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
      () => jsx("box", { width: DIALOG, children: hostDialog("T", jsx("box", { flexDirection: "column", children: [makeRow(1)] })) }),
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

console.log(`
Two figures this module used to assert about colour are gone, and the reason is worth
more than they were: the plugin paints nothing. The host draws the title, the muted
description beside it, the right-aligned footer, the category heading and the \u25cf on the
row handed to \`current\` — each in a colour chosen at paint time from the row's own state.
A hand-painted \`fg()\` chunk is fixed, so a figure in the value tier sat on the theme's
primary-coloured selection bar with whatever contrast that gave, and the only way to find
out was to put the cursor on the row and look.

So the claims here are the two the unit suite still cannot make: what the screens LOOK
like, and how many columns they actually have. Both are read off a real frame, and both
have been wrong before.
`);
process.exit(0);
