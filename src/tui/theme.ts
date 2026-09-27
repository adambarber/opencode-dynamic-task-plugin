/**
 * The screen's design tokens, and the two ways a value cell is drawn.
 *
 * Colours are named as ROLES here and resolved from the host's active theme in the one
 * function that paints a cell. A cell written as `theme.text` at each call site would
 * tie the screen to whatever that token happens to be in the theme in force, and a
 * literal would tie it to one theme for ever: a hard `#ffffff` reads as "bright" in a
 * dark theme and is unreadable in a light one, which is precisely the bug a plugin that
 * "looks bright" ships. The role is the stable thing; the value is the theme's business.
 *
 * `value` is `text` rather than `selectedListItemText`, and the reason comes from the
 * host's own source rather than from taste. What the host paints an active row's text
 * with is `selectedForeground`, which is NOT that token: it returns
 * `selectedListItemText` only when `_hasSelectedListItemText` is set, and otherwise
 * COMPUTES pure black or pure white from the background's luminance. And
 * `selectedListItemText` is optional in a theme's JSON and is explicitly filtered out of
 * inheritance, so reading it unguarded would be reading a field the host itself treats
 * as possibly absent — the cast-without-a-check this repo forbids everywhere else.
 * `text` is always defined and is always the theme's own foreground: in a dark theme
 * that is the near-white the number was missing, and in a light theme it is the
 * near-black, which is the same intent stated without a theme in it.
 *
 * Bold is what actually separates a numeral from its label in a terminal, and it is
 * theme-independent: no palette can switch it off and no value of it is illegible.
 * Colour alone would carry the emphasis, and colour is exactly the thing a theme owns.
 *
 * The plain and painted forms are both here because they are different claims and the
 * layout gate needs the first while the screen needs the second: a painted form can
 * only be measured by rendering it, and the width the host clips against is a property
 * of the CHARACTERS, not of their colour. `widthsAgree` is the gate — it fails the build
 * if the two ever stop describing the same row, which is the only way they could drift.
 */
import { bold, fg, StyledText } from "@opentui/core";
import type { RGBA, TextChunk } from "@opentui/core";
import { AGENT_CAP_NAMES } from "../shared/caps.js";
import { CAP_LABEL, capCellOf, type AgentEntry, type CapCell } from "./agent-editor.js";

/**
 * How a theme is reached from the plugin api, named so `screenTokens` can take it.
 *
 * `text`, `accent` and `syntaxComment` are all declared `readonly RGBA` by the host and
 * all are still probed for absence below, because the declaration is not a promise: a
 * theme's JSON may omit a key, and the host itself guards `selectedListItemText` at
 * runtime with `_hasSelectedListItemText` rather than trusting its own type. A theme that
 * drops `text` would otherwise hand `fg(undefined)`, which renders as INHERITED — the
 * host's muted wrapper — putting the value back in the colour this module exists to take
 * it out of, with nothing in the build to say so.
 */
type ThemeLike = {
  readonly current: { text: RGBA; textMuted: RGBA; accent: RGBA; syntaxComment?: RGBA };
};

/**
 * The colours this screen paints with, as roles.
 *
 * THREE, and the count is the number of KINDS of thing a row draws. The previous two were
 * justified as "the row draws two things", which was a miscount that a render settled: a
 * row is a value, a label naming the value, and a note about where the value came from —
 * and folding the last two together put six of the row's eleven tokens in one colour, so
 * `4 from config` read as a two-word value and the operator read the note as a broken
 * input. Muting the note was never going to fix that; only a tier below the label can.
 *
 * So the tiers are ordered by how much they are the reason the eye came:
 *
 *   value   `text`          the number, bold      the answer
 *   context `textMuted`     `at once`, `depth`    which question the number answers
 *   aside   `syntaxComment` `from config`         a note ABOUT the number
 *
 * `syntaxComment` is the host's own role for readable-but-recessive annotation, which is
 * exactly what a provenance note is — a comment on the value. It was available all along:
 * the host declares some fifty roles and this module was reading three of them. Its virtue
 * is that it is SEMANTIC, so a theme that ranks it near its own muted level degrades to the
 * two-tier screen rather than to something unreadable, and a theme that ranks it lower gets
 * the separation for free. Nothing here is a hex: a literal would read as "bright" against
 * a dark terminal and vanish against a light one, which is the whole defect.
 */
export interface ScreenTokens {
  /** The number in force. The theme's own foreground, in bold. */
  value: RGBA;
  /** The label naming which cap a number is: `at once`, `depth`. */
  context: RGBA;
  /** A note about a number rather than a number: `from config`, `agent set binds`. */
  aside: RGBA;
}

/**
 * The three roles, resolved once from the theme in force.
 *
 * The `??` on the value is the same move the other cortexkit sidebars make
 * (`theme.success ?? theme.accent`): a missing role falls back to a role that is present
 * rather than to nothing, because a wrong-but-visible colour is recoverable and an
 * inherited one is invisible. The context role needs no fallback — an absent `textMuted`
 * inherits the host's own muted wrapper, which is what it asked for anyway. The aside
 * falls back to `textMuted` because a theme that never heard of `syntaxComment` should
 * draw a note in the label's tier rather than leave the note invisible.
 */
export function screenTokens(theme: ThemeLike): ScreenTokens {
  const current = theme.current;
  return {
    value: current.text ?? current.accent,
    context: current.textMuted,
    aside: current.syntaxComment ?? current.textMuted,
  };
}

/**
 * The gap between a row's two cells, in place of the mark that used to be there.
 *
 * The `·` is deleted rather than re-coloured. A separator is a symbol with no information
 * in it, and at the label's own tier it read as a word — so `from config · depth` scanned
 * as one phrase and the two cells stopped grouping. The reference rows this screen was
 * built against separate their cells with space and a rule drawn by the layout, not with a
 * character between the figures; a double space is the whole of that, and the host's
 * `space-between` already supplies the rest of the separation on the row itself.
 */
export const CELL_GAP = "  ";

/**
 * The mark that OPENS a cell on the screen where the cell is the whole footer.
 *
 * Not the deleted separator, and kept apart from it because the two answer different
 * questions. That one sat BETWEEN two cells that already had their own labels, where it
 * was a symbol standing in for information the layout could have supplied. This one opens
 * a footer that IS one cell, with no label of its own and no column to align against, so
 * without it `4` reads as the tail of the word beside it. Different job, same character.
 */
export const LEAD = "·";

/** The note a cell carries when the number is the config file's rather than the operator's. */
const INHERITED = "from config";
/** The note for a depth the agent set holds below the cap. */
const CEILING = "agent set binds";

/**
 * What a cell says, unstyled: the width contract.
 *
 * A bounded depth prints BOTH numbers, `3/4`: the reachable one first, because that is
 * the one a dispatch is judged against, and the cap beside it because that is the one
 * the operator typed. This is the same shape the cortexkit sidebars use for a value with
 * a ceiling (`148/158`), and for the same reason — a bare integer cannot say whether it
 * is the limit or something else holding it down, and a wordier label ("depth 4, capped
 * at 3 by the agent set") costs more width than it earns in meaning.
 */
export function plainCell(cell: CapCell): string {
  if (cell.bounded !== null) return `${cell.bounded}/${cell.value} ${CEILING}`;
  return cell.stated ? `${cell.value}` : `${cell.value} ${INHERITED}`;
}

/** What one agent's row says, unstyled: the width contract for a whole row. */
export function plainSummary(row: AgentEntry): string {
  return AGENT_CAP_NAMES.map((cap) => `${CAP_LABEL[cap]} ${plainCell(capCellOf(row, cap))}`).join(CELL_GAP);
}

/**
 * A cell's painted runs.
 *
 * CHUNKS rather than an element, and one span per cell in the callers, because the
 * number and its note have to be the SAME run sequence for a row — a cell that
 * opened its own span would break the row's single line. `bold(fg(…))` nests into one
 * chunk carrying both, rather than two adjacent runs that could be split by a
 * reflow.
 *
 * The note is drawn in the ASIDE tier, a step below the label, because that step is the
 * whole difference between a note and a value. In the label's own tier `4 from config`
 * was read as a two-word figure — the operator called it a broken input, twice, and
 * muting it is what had already been tried. A note that is a tier quieter is a note.
 */
export function cellRuns(cell: CapCell, tokens: ScreenTokens): TextChunk[] {
  // The reachable number is the loud one even in `3/4`, because it is the one a
  // dispatch is judged against; the cap beside it is a NOTE about it, so it takes the
  // aside tier rather than the label's. Both in bold: the pair is one reading, and
  // splitting it across weights would ask the eye to hold `3` and then re-read `4` as
  // a separate value.
  if (cell.bounded !== null) {
    return [
      bold(fg(tokens.value)(String(cell.bounded))),
      bold(fg(tokens.aside)(`/${cell.value}`)),
      fg(tokens.aside)(" " + CEILING),
    ];
  }
  return [
    bold(fg(tokens.value)(String(cell.value))),
    ...(cell.stated ? [] : [fg(tokens.aside)(" " + INHERITED)]),
  ];
}

/**
 * One agent's row value, painted: both caps in reading order.
 *
 * The LABELS are context and the numbers are value, so the eye lands on the figures and
 * reads the words beside them on a second pass — the reverse of the arrangement where
 * everything shares one weight and nothing leads. The marks are context for the same
 * reason: a `·` is punctuation, and punctuation that competes with a numeral reads as
 * content.
 */
export function summaryRuns(row: AgentEntry, tokens: ScreenTokens): TextChunk[] {
  return AGENT_CAP_NAMES.flatMap((cap, index) => [
    ...(index === 0 ? [] : [fg(tokens.context)(CELL_GAP)]),
    fg(tokens.context)(`${CAP_LABEL[cap]} `),
    ...cellRuns(capCellOf(row, cap), tokens),
  ]);
}

/**
 * Chunks as what a row's `footer` is set to.
 *
 * A `StyledText` rather than a string, and the reason is the host's own row markup: it
 * wraps a row's `footer` in `<text fg={muted}>`, so a footer that is a STRING is muted in
 * its entirety — the number and the word "from config" arrive as one blob with nothing
 * in the pipeline able to address either. Splitting them into styled runs is what lets
 * the value carry the theme's foreground while the qualifier stays recessive. `fg`
 * cascades to descendants that do not set their own, so the runs' own colours win over
 * the host's muted wrapper; `render-proof.sh` renders the real thing and reads the spans
 * back, so that is checked rather than assumed.
 *
 * A `StyledText` and NOT a `<span>` element, and this is the second half of the same
 * finding. A hand-built element from `@opentui/solid/jsx-runtime` renders identically to
 * authored JSX, but it needs an ACTIVE RENDERER — `jsx` throws "No renderer found"
 * outside one. A props builder is called inside the host's render in production and
 * outside one in every test, so an element footer would make the props impure and take
 * the suite's whole basis for asserting on them with it. A `StyledText` is plain data:
 * `TextNodeRenderable.add` names it as an accepted child, so it renders as one and costs
 * no renderer.
 */

/**
 * Whether the painted form is as wide as the plain one.
 *
 * The gate that keeps the two claims about a row from drifting: the layout budget is
 * measured in characters, and colour does not make text longer or shorter. If a run
 * added a character the plain spelling does not have, the row would be clipped by
 * exactly as much as the budget said it was not.
 */
export function widthsAgree(runs: TextChunk[], plain: string): boolean {
  return runs.map((run) => run.text).join("") === plain;
}

/**
 * One cell, as the value a row's `footer` carries.
 *
 * The leading mark, and only here. On the AGENT screen the cell IS the whole footer, and
 * the host draws a footer hard against the row's title with no column to align the two
 * — so without a mark the label and the number read as one run of text and the number
 * looks like the tail of the word. On the LIST screen each cell already follows its own
 * label inside the same footer, so a mark there would be a second separator between the
 * same two things.
 */
export function cellFooter(cell: CapCell, tokens: ScreenTokens): StyledText {
  return new StyledText([fg(tokens.context)(`${LEAD} `), ...cellRuns(cell, tokens)]);
}

/** One agent's row value, as the value a row's `footer` carries. */
export function summaryFooter(row: AgentEntry, tokens: ScreenTokens): StyledText {
  return new StyledText(summaryRuns(row, tokens));
}
