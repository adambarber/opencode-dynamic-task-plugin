/**
 * The words a limits row is made of, and the width contract over them.
 *
 * This module used to carry the theme. It carried `screenTokens`, a `StyledText` for
 * every figure, a two-tier colour vocabulary and a gate holding the painted form to the
 * width of the plain one — several hundred lines whose whole purpose was to paint
 * something the host paints for us.
 *
 * The host's `DialogSelect` option takes `title`, `description`, `footer`, `category`
 * and `current`, and draws all five: a muted `<span>` after the title on the same line, a
 * right-aligned footer in `fg` when the row is selected, an accent heading per category,
 * and a `●` in `theme.primary` on the `current` row. Every one of those adapts to the
 * selection bar, because the host chooses the colour at paint time from the row's own
 * state. Hand-built `fg()` chunks cannot: they are fixed, so a figure painted in the
 * value tier sits on the theme's primary-coloured bar with whatever contrast that gives,
 * and the only way to find out was to look.
 *
 * So nothing here paints anything, and what is left is a handful of strings plus the
 * two functions that compose them. That is not a smaller feature: it is the same screen,
 * drawn the way every other dialog in the host is drawn.
 */
import { AGENT_CAP_NAMES } from "../shared/caps.js";
import { CAP_NOUN, capCellOf, type AgentEntry, type CapCell } from "./agent-editor.js";

/**
 * The mark between an agent's two figures.
 *
 * A `*`, and not the `·` this file used to separate its cells with. Two labelled
 * quantities with nothing between them read as one broken string — `4 concurrency2 depth`
 * or `4 concurrency depth`, depending on which way the eye jumps — and the mark is what
 * says they are two facts and not one. The `·` was removed for the same reason two rounds
 * ago: a glyph standing in for information the layout could have supplied. This one
 * cannot be supplied by the layout, because a menu row has one gap in it and two things
 * to separate.
 */
export const BETWEEN = " * ";

/** The note a cell carries when the number is the config file's rather than the operator's. */
export const INHERITED = "from config";

/**
 * The same fact, as a TITLE clause, for the screen where the operator chooses a number.
 *
 * `INHERITED` and this are the same claim in two places a number appears: a cell beside a
 * figure, and a title above a list of them. Two spellings because the positions are not
 * interchangeable — `(from config)` reads as a parenthetical in a title, and `from config`
 * would read as a status in one.
 */
export const FROM_CONFIG = "from config file";

/**
 * The title clause that says what holds a cap down, in one piece.
 *
 * The SENTENCE is production vocabulary and is composed here rather than at each site
 * that says it: a case that retyped the words would be pinned to a spelling the screen
 * does not use, and would keep passing after the screen changed its mind.
 */
export const boundClause = (at: number): string => `agent set binds at ${at}`;

/**
 * One figure, alone: what a cap holds right now, and nothing else.
 *
 * A bounded depth prints BOTH numbers, `3/4`: the reachable one first, because that is
 * the one a dispatch is judged against, and the cap beside it because that is the one the
 * operator typed. A bare integer cannot say whether it is the limit or something else
 * holding it down, and the two numbers say it in the width the repo already spends on
 * `148/158` in its sidebars.
 *
 * NO PROVENANCE. A figure here is `4`, not `4 from config`, and that is the whole reason
 * the list stopped reading as broken strings: the annotation appeared twice on every
 * row, on both figures, and a list of twenty rows said `from config` forty times in a
 * column. Where the operator is DECIDING rather than scanning — the agent's own caps
 * screen — the annotation is still there, in `namedCell`, because there it is one line
 * answering a question and here it is a column of noise.
 */
export function terseCell(cell: CapCell): string {
  return cell.bounded !== null ? `${cell.bounded}/${cell.value}` : `${cell.value}`;
}

/**
 * One figure where the operator is deciding about it, so the number says whose it is.
 *
 * The same number `terseCell` prints, with the noun that says what it counts and the
 * provenance when the config file is the one that set it. This is the spelling on the
 * agent's own caps screen, where a row IS a setting and "who chose this" is part of what
 * the row is asking.
 */
export function namedCell(cell: CapCell): string {
  return `${terseCell(cell)}${cell.stated ? "" : ` ${INHERITED}`}`;
}

/**
 * An agent's row as the TERMINAL shows it: `4 concurrency * 2 depth`.
 *
 * Figure first, noun second, mark between. The order is the one a table of quantities is
 * read in, and the inversion from the screen's earlier `at once 4` is the fix rather than
 * a style: a label before its figure makes the reader hold the label while they find the
 * number, and with two labels per row the eye is holding two while it reads four things.
 */
export function plainSummary(row: AgentEntry): string {
  return AGENT_CAP_NAMES.map((cap) => `${terseCell(capCellOf(row, cap))} ${CAP_NOUN[cap]}`).join(BETWEEN);
}
