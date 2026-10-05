/**
 * The host's own geometry: how many columns a row really gets, and whether this one fits.
 *
 * Separated from the screens that consult it because the figures here are MEASURED, and a
 * measurement mixed in with the code that uses it is a measurement that gets re-derived
 * the next time somebody is in this file.
 */

/**
 * The width the host lays a row out in.
 *
 * The host's own arithmetic, so the budget is enforced where the content is built
 * rather than discovered as a clipped sentence in a terminal. `medium` is 60 columns and
 * `large` is 88 (dialog.ts:22-25), and the plugin asks for neither: a dialog that
 * never calls `setSize` gets the host's DEFAULT, which is what every other dialog in
 * opencode is, and being the only select in the app with a different width is the sort
 * of thing that reads as a different program before anyone can say why. A dialog can
 * never exceed the terminal less 2 (dialog.ts:59), which makes an 80-column terminal the
 * narrow case worth surviving.
 *
 * `medium` is also what every row of every screen here fits, which is why there is ONE
 * width and not two. The list is the only screen carrying a name and its caps on one
 * line, and its rows are 34 characters — `2 concurrency * 3/4 depth` — because the
 * figures lost their labels' preamble, so the widest realistic name that fits is 17
 * characters. A width is a fact about the content; a content change that makes a width
 * unnecessary should be allowed to delete the width, or it will outlive its reason.
 *
 * Exported so the render proof can draw at the width the plugin MOUNTS rather than one it
 * invents, which is the error that made the last measurement describe a screen that does
 * not exist.
 */
export const DIALOG_WIDTH = 60;
const TERMINAL_FLOOR = 80;
/** The `scrollbox` the rows sit in, at `paddingLeft={1} paddingRight={1}`. */
const SCROLLBOX_INDENT = 1;
/** The row box's own `paddingLeft={3} paddingRight={3}`. */
const ROW_PADDING_TOTAL = 6;
/** Between a title and a footer. A row with no footer pays none of it. */
const ROW_GAP = 1;

/**
 * What one option row has left for its title, its description, and its footer at a dialog
 * of `width`, or the terminal less 2 on a narrow one.
 *
 * MEASURED, not derived. `bun scripts/render-proof.js --screen` reports 52 for a title
 * under a `medium` dialog and 80 under a `large` one at an 80-column terminal, the
 * `scrollbox`'s one pixel a side included — and counting that is the correction over the
 * arithmetic that preceded it, which was out by two columns in the safe direction and so
 * silently passed everything.
 */
export const dialogRowText = (width: number) => Math.min(width, TERMINAL_FLOOR - 2) - SCROLLBOX_INDENT * 2 - ROW_PADDING_TOTAL;

/**
 * What the host truncates a TITLE to, on its own, before the row's clip is reached.
 *
 * `titleWidth ?? 61` in dialog-select.tsx — 61 whatever the dialog's width. It never binds
 * on a `medium` dialog and always binds on a `large` one, which is the only place it is
 * charged. A budget that cannot fail on the screen it guards is a claim that is not
 * making a claim, so it is checked where it is reachable.
 */
const TITLE_CAP = 61;

/**
 * Whether a row's line fits the dialog the host will draw it in.
 *
 * Two budgets, and they are not the same one. The host truncates the TITLE on its own —
 * `Locale.truncate(props.title, props.titleWidth ?? 61)` — and clips the whole line, title
 * plus the muted `description` in its nested span, at the width of the row's `flexGrow={1}
 * overflow="hidden"` box. So a name can be cut for being long, a description can be cut
 * for being beside a long name, and neither says so.
 *
 * A `footer` is charged to the row and cannot give ground: `flexShrink={0}` against the
 * title's `flexGrow={1}`, so the title goes instead. No screen of ours sets one now — the
 * figure that used to sit there rides in `description` — but the charge stays, because a
 * future row that sets a footer has to be measured against the same row rather than
 * discovered by looking at a frame.
 *
 * The number is MEASURED, not derived. `bun scripts/render-proof.js --screen` reports 52
 * for a title at an 80-column terminal with the host's own `medium` dialog, and every
 * derived version of it has been wrong by a layer: the first counted six columns of
 * indent and missed a one-pixel gap, the next missed the `scrollbox` the rows live in, and
 * a third measured a `large` dialog the plugin no longer mounts. A gate that is tighter
 * than the screen passes everything and tells the operator nothing; one that is looser
 * lets a name be eaten by its own caps. Both are silent, so the figure comes off a frame.
 *
 * What the row spends before any content is the part that was wrong, twice over. The row
 * box is `<box flexDirection="row" paddingLeft={3} paddingRight={3} gap={1}>`
 * (dialog-select.tsx) inside a `scrollbox` at `paddingLeft={1} paddingRight={1}`, so
 * EIGHT columns go before the first character — and the `<text paddingLeft={3}>` that
 * looked like a ninth and tenth is not applied by opentui at all, which only a rendered
 * frame shows. `ROW_GAP` is charged per-footer rather than up front: it exists only
 * between a title and a footer, and a row with no footer pays none of it.
 */
export function fitsItsDialog(row: { title: string; description?: string }, width = DIALOG_WIDTH, footerWidth = 0): boolean {
  // Each separator is charged only when the thing it separates is there. A `+ 1` for the
  // space before a description a row does not have, and a gap for a footer it does not
  // have, are the same class of error as a padding the renderer never applies.
  const description = row.description ? 1 + row.description.length : 0;
  const available = dialogRowText(width);
  // The host truncates the title alone at 61 whenever the row is wider than that, and
  // clips the whole line at `available`. At a `medium` dialog the second is always the
  // smaller, so the first is not charged — a check that cannot fail here is not a check.
  const cap = Math.min(TITLE_CAP, available);
  return row.title.length <= cap && row.title.length + description + footerWidth + (footerWidth > 0 ? ROW_GAP : 0) <= available;
}