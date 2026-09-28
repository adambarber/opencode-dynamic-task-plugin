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
import { CAP_LABEL, capCellOf, type AgentEntry, type CapCell } from "./agent-editor.js";

/**
 * The separator between an agent row's two cells.
 *
 * A double space, and not a character, because the host's `space-between` on the row
 * supplies the rest of the separation and the cells already carry their own labels
 * (`at once`, `depth`). A mark between two labelled things is a symbol standing in for
 * information the layout could have supplied.
 */
export const CELL_GAP = "  ";

/** The note a cell carries when the number is the config file's rather than the operator's. */
export const INHERITED = "from config";

/**
 * The short form of "the agent set holds this depth below the cap".
 *
 * `3/4 agent set` and not `3/4 agent set binds at 3`: the row shares its line with an
 * agent's name under the host's own `medium` dialog, and this is what had to give. The
 * number beside the bound already says the two differ, and the full sentence — which
 * names the same bound a third time — is where the picker's title puts it, on a screen
 * that exists to state it once.
 */
const CEILING = "agent set";

/**
 * The title clause that says what holds a cap down, in one piece.
 *
 * The SENTENCE is production vocabulary and is composed here rather than at each site
 * that says it: a case that retyped the words would be pinned to a spelling the screen
 * does not use, and would keep passing after the screen changed its mind.
 */
export const boundClause = (at: number): string => `agent set binds at ${at}`;

/**
 * What a cell says, and the width contract over it.
 *
 * A bounded depth prints BOTH numbers, `3/4`: the reachable one first, because that is
 * the one a dispatch is judged against, and the cap beside it because that is the one the
 * operator typed. A bare integer cannot say whether it is the limit or something else
 * holding it down, which is the whole reason this is a cell and not a number.
 */
export function plainCell(cell: CapCell): string {
  if (cell.bounded !== null) return `${cell.bounded}/${cell.value} ${CEILING}`;
  return cell.stated ? `${cell.value}` : `${cell.value} ${INHERITED}`;
}

/** What one agent's row says, in the host's `description` field. */
export function plainSummary(row: AgentEntry): string {
  return AGENT_CAP_NAMES.map((cap) => `${CAP_LABEL[cap]} ${plainCell(capCellOf(row, cap))}`).join(CELL_GAP);
}
