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

/** How a theme is reached from the plugin api, named so `screenTokens` can take it. */
type ThemeLike = { readonly current: { text: RGBA; textMuted: RGBA } };

/**
 * The colours this screen paints with, as roles.
 *
 * Two, because the row draws two things: the value the operator came to read, and the
 * context that qualifies it. A third role for anything else is a role with no difference
 * between it and one of these two.
 */
export interface ScreenTokens {
  /** The number in force. The theme's own foreground, in bold. */
  value: RGBA;
  /** What qualifies a value rather than being one: a label, a mark, "from config". */
  context: RGBA;
}

/** The two roles, resolved once from the theme in force. */
export function screenTokens(theme: ThemeLike): ScreenTokens {
  return { value: theme.current.text, context: theme.current.textMuted };
}

/** The mark between a row's label and its value, and between its two cells. */
export const SEP = "·";

/** The qualifier a cell carries when the number is the config file's rather than the operator's. */
const INHERITED = "from config";

/** What a cell says, unstyled: the width contract. */
export function plainCell(cell: CapCell): string {
  return cell.stated ? `${cell.value}` : `${cell.value} ${INHERITED}`;
}

/** What one agent's row says, unstyled: the width contract for a whole row. */
export function plainSummary(row: AgentEntry): string {
  return AGENT_CAP_NAMES.map((cap) => `${CAP_LABEL[cap]} ${plainCell(capCellOf(row, cap))}`).join(` ${SEP} `);
}

/**
 * A cell's painted runs.
 *
 * CHUNKS rather than an element, and one span per cell in the callers, because the
 * number and its qualifier have to be the SAME run sequence for a row — a cell that
 * opened its own span would break the row's single line. `bold(fg(…))` nests into one
 * chunk carrying both, rather than two adjacent runs that could be split by a
 * reflow.
 */
export function cellRuns(cell: CapCell, tokens: ScreenTokens): TextChunk[] {
  return [
    bold(fg(tokens.value)(String(cell.value))),
    ...(cell.stated ? [] : [fg(tokens.context)(" " + INHERITED)]),
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
    ...(index === 0 ? [] : [fg(tokens.context)(` ${SEP} `)]),
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
  return new StyledText([fg(tokens.context)(`${SEP} `), ...cellRuns(cell, tokens)]);
}

/** One agent's row value, as the value a row's `footer` carries. */
export function summaryFooter(row: AgentEntry, tokens: ScreenTokens): StyledText {
  return new StyledText(summaryRuns(row, tokens));
}
