/**
 * The TUI half of the plugin: one command, one list, one file edited.
 *
 * A TUI module exports `tui` where a server module exports `server` — never both
 * (see `TuiPluginModule`), which is why this is a SEPARATE module rather than a flag
 * on the first. It is not, however, a second entry in opencode's `plugin` array:
 * that array is the SERVER plugin list. The host loads TUI modules from `tui.json` —
 * a different file with its own `plugin` array — and there is no directory
 * auto-discovery for TUI plugins at all, so a module listed in the wrong file is
 * never loaded. An empty command palette is what that looks like.
 *
 * The loader reads the module's DEFAULT export and ignores named exports, and a file
 * plugin must carry a non-empty `id`: it is the module's runtime identity, the key
 * `plugin_enabled` uses, and what a later duplicate is rejected against. So the
 * `export default` below is the module. The named `tui` is kept only so the suite can
 * drive the plugin function without standing up a loader.
 *
 * Nothing about the palette contract below is checkable by the compiler. `Command`
 * carries an index signature (`[key: string]: unknown`), so `title`, `desc`,
 * `namespace` and `slashName` are host conventions rather than typed fields, and a
 * misspelling is silently a custom field the palette never reads. That is why these
 * names are the host's, and why the suite pins them against the documented list
 * rather than against whatever this file happens to say.
 *
 * It lives in a different process from the server, which decides what it can honestly
 * show. It shows the cap in force and whether the operator stated it — and NOT how
 * many are running, because the only source for that here is the ledger's last
 * RECORDED set. Printing it beside a cap made a two-dispatches-out-of-date count look
 * like a live gauge, and gave the operator reason to distrust the one number on the
 * row they could actually act on. `task_list` is where the running set is read.
 *
 * The overlay file is shared, not duplicated: this edits the same format the dispatch
 * path already reads, so there is no second source of truth to reconcile and no server
 * endpoint added to read a number a file already holds.
 */
import type { Plugin } from "@opencode/plugin/tui";
import type { DialogSelectOptions } from "@opencode/plugin/tui/context";
import { type DynamicTaskConfig, readDynamicTaskPolicy } from "../shared/config.js";
import { errorMessage } from "../shared/host-shape.js";
import { depthLimits } from "../shared/task-policy.js";
import {
  AGENT_CAP_NAMES,
  type AgentCapName,
  type AgentOverlay,
  agentOverlayPath,
  readAgentOverlay,
  resolveAgentCaps,
  writeAgentOverlay,
} from "../shared/caps.js";
import { type AgentCaller, dispatchableAgentNamesOrNull } from "../shared/admission.js";
import { type OpaqueHost, asOpaqueHost } from "../shared/client.js";
import {
  type AgentDialog,
  type AgentEntry,
  CAP_CHOICES,
  CAP_LABEL,
  CAP_NOUN,
  CEILING_LABEL,
  type CapCell,
  type CapChoice,
  type CeilingChoice,
  type EditOutcome,
  agentDialogFrom,
  applyCapEdit,
  applyCeilingEdit,
  capCellOf,
  ceilingOf,
  displayName,
  overlayFrom,
} from "./agent-editor.js";
import { FROM_CONFIG, boundClause, namedCell, plainSummary, terseCell } from "./theme.js";

/** The host side this screen talks to, named once. The flows below take it everywhere. */
type Host = Plugin.Context;

/**
 * The command name. It carries "limits" because the palette's fuzzy search runs over
 * the command's own fields and which fields it searches is the host's business, not
 * ours — so the word has to be in the name as well as the title for the ctrl+p query
 * and the `/limits` spelling to land on the same entry.
 */
const COMMAND = "dynamic-task.limits";

/**
 * The MODULE's identity, which is not the command's. `plugin_enabled` is keyed by
 * plugin id, so keying it on the command would make "hide this one command" and
 * "unload this plugin" the same switch.
 */
const PLUGIN_ID = "dynamic-task";

/**
 * What a row in the list stands for, and what a row in a cap picker stands for.
 *
 * Every option carries its own `onSelect` and neither dialog carries one. Two places
 * to answer "what happens when this row is chosen" is how a new row type ends up
 * handled in one of them and silently ignored in the other — and it was stated twice,
 * once per screen, which is the same claim in two places and so a claim free to
 * disagree with itself. It belongs here, where the two lists' vocabularies meet.
 */
type ListChoice = { kind: ChoiceKind.Agent; agent: string } | { kind: ChoiceKind.Ceiling };
type CapsChoice = { kind: ChoiceKind.Cap; agent: string; cap: AgentCapName } | { kind: ChoiceKind.Back };
type PickerChoice =
  | { kind: ChoiceKind.Value; agent: string; cap: AgentCapName; value: number | null }
  | { kind: ChoiceKind.CeilingValue; value: number | null }
  // The same shape the agent screen's own Back row carries, and deliberately not a
  // third spelling of "go back": a kind that means one thing has one representation, so
  // a reader asking "which rows leave this screen alone" finds one answer.
  | { kind: ChoiceKind.Back };

/**
 * The kinds of row either list can hold.
 *
 * An enum, like every other discriminant here, so "a cap" is a named value that cannot
 * be misspelled at a comparison site. A raw string compiles against a union just fine
 * and silently never matches if the spelling drifts.
 */
enum ChoiceKind {
  Agent = "agent",
  Ceiling = "ceiling",
  Cap = "cap",
  Back = "back",
  Value = "value",
  CeilingValue = "ceilingValue",
}

// The palette entry. `keymap.layer` reads Solid context, so it runs in a slot
// render the host owns — never in module scope, never in `setup`, where there is
// no owner and the hooks throw. The render draws nothing; registering is its job.
function registerLimitsCommand(ctx: Host, agentHost: OpaqueHost<AgentCaller>): null {
  ctx.keymap.layer(() => ({
    commands: [
      {
        id: COMMAND,
        title: "Task limits",
        description: "How many of each agent run at once, and how deep it may nest",
        group: "Dynamic Task",
        // The slash spelling is the same command, so there is one entry to
        // discover and not a second one to keep in step.
        slash: { name: "limits" },
        palette: true,
        // The row set is the HOST'S agents, which is a client call: a screen that
        // listed the overlay's own entries would be showing a hand-maintained
        // index of agents rather than the ones this project can actually dispatch
        // to, and would omit every agent nobody had capped yet — which is all of
        // them, on a fresh project.
        run: () => {
          void openLimits(ctx, agentHost);
        },
      },
    ],
    mode: "global",
  }));
  return null;
}

// No escape binding. A plugin that binds one owns `escape` for the whole app,
// and escape is the operator's way to STOP AN IN-FLIGHT REQUEST — a key whose
// failure is not a lost dialog but a turn that will not end. The host's own
// dialogs dismiss on escape, so duplicating it bought nothing except the one case
// it was written for, and it charged for that by owning a key that must never be
// interceptable. The Back rows are the way out of every screen. A `global` layer
// with no `bind` claims no key at all, so interrupt is untouched whatever the
// dialog is doing — a property no predicate can offer.

/**
 * Every select below goes through the host's promise dialog, which resolves with
 * the chosen row's value and `undefined` on dismiss. The width is deliberately not
 * set: every screen here wants the host's default, which is what every other
 * dialog in opencode gets. The budget that has to survive a row is enforced where
 * the content is built (`fitsItsDialog`), not by making this one select the odd
 * width out in the app.
 */
function selectLimitsRow<T>(ctx: Host, dialog: DialogSelectOptions<T>): Promise<T | undefined> {
  return ctx.ui.dialog.select(dialog);
}

/**
 * The module the host actually loads: `{ id, setup }` as the DEFAULT export. The
 * command's layer needs a Solid owner, so `setup` claims the root slot with a
 * render that registers it and draws nothing — and returns the claim's cleanup,
 * so deactivating the plugin takes the palette entry with it.
 */
const plugin = {
  id: PLUGIN_ID,
  setup: (ctx: Host) => {
    const agentHost = asOpaqueHost(tuiAgentCaller(ctx));
    return ctx.ui.slot({ append: "app", render: () => registerLimitsCommand(ctx, agentHost) });
  },
};

export default plugin;

// ─── the two screens ─────────────────────────────────────────────────────────

/**
 * The list, as the host's own prop type.
 *
 * Returning the host's declared shape instead of handing props to the widget inline
 * is what makes the dialog checkable: the props ARE the value, so they are asserted on
 * directly, and a field the host never reads — `description` for the palette's `desc`,
 * the legacy `slash` for `slashName` — becomes a type error here rather than a silent
 * custom property that only a terminal would reveal.
 *
 * No `placeholder`: the host's own default reads "Search", and matching every other
 * dialog in the terminal beats a hint of our own. The one this screen had said "type to
 * filter", which describes the widget rather than the vocabulary, so the box above the
 * list read as a form field that had lost its label.
 */
export function limitsListProps(dialog: AgentDialog): DialogSelectOptions<ListChoice> {
  return {
    title: "Task limits",
    // The filter stays ON here, and this is the one screen of the four that keeps it. A
    // long agent list is the one thing here worth typing into, and every other select in
    // this host has the box, so its absence would be the thing that looked wrong.
    options: [
      {
        // The total NAMES ITSELF rather than sitting above the agents because it is first
        // in the array, which is the rule every reader and every case had to carry. It
        // carries no `category` of its own, because `Total ceiling:` and a `Total` heading
        // over it would say the same word twice in three lines — and the `Agents` heading
        // below is what organises the block, which is the job the heading was wanted for.
        title: `${displayName(CEILING_LABEL)}:`,
        description: `${terseCell(dialog.ceiling)  } ${  CAP_NOUN.maxConcurrent}`,
        value: { kind: ChoiceKind.Ceiling } as const satisfies ListChoice,
      },
      ...dialog.rows.map((row) => ({
        title: `${displayName(row.name)}:`,
        category: "Agents",
        // The caps go in `description` — the field every native dialog in this host uses
        // for the muted text after a title, on the title's own line. This is where a
        // frame sent them back to, after `footer` proved to strand a value 60 columns
        // from the name it described and `details` proved to be an undocumented field
        // costing an indent and a cast. The host draws it, so it follows the selection
        // bar instead of fighting it.
        // The caps ride beside the name ONLY when both fit. A name long enough to crowd
        // them out — and 40 characters of hyphenated agent name is a real thing, since
        // agents are named for what they are — takes the caps with it, whole, rather
        // than having them clipped to a fragment ending mid-figure. A half-line reading
        // `depth 3` is worse than no line: it looks like a bound and is a truncation, and
        // nothing on screen says so. The row still opens the agent's own screen, which is
        // where the caps are in full.
        //
        // This is the width gate's one caller acting on its own verdict, which is the only
        // arrangement in which it can: a gate that reports a clip the screen then ignores
        // has found out that the screen does not care.
        ...(fitsItsDialog({ description: plainSummary(row), title: row.name }, DIALOG_WIDTH) ? { description: plainSummary(row) } : {}),
        value: { agent: row.name, kind: ChoiceKind.Agent } as const satisfies ListChoice,
      })),
    ],
  };
}

/**
 * The ceiling picker: the values the cross-agent total can take.
 *
 * The same list the per-agent concurrency picker offers, deliberately, and by pointing
 * at the same `CAP_CHOICES` entry rather than by restating it. Two different sets of
 * numbers for one concept is how an operator ends up able to set a total of 12 that no
 * per-agent cap can reach, and neither screen explains the asymmetry.
 */
/**
 * No callbacks on the builders below: each option carries a choice VALUE and the flow
 * switches on what `select` resolves with. The old `confirm/back` pair said which
 * press writes the file; now the flow reads the kind and only a value kind writes.
 * A reader of a builder signature learns what the rows ARE, and the flow owns what
 * they DO — one place each, which is what the pair was for.
 */

/**
 * A picker's title: what the screen is FOR, then parenthesised facts about the number.
 *
 * One composition for all three pickers, because the parenthetical is a shape rather than
 * a wording — the agent cap pickers contribute a bound, the ceiling picker contributes the
 * config file, and a fourth picker would contribute whatever it knows. Written per picker
 * it is three joins that happen to agree today, and the first one edited without the other
 * two would leave the screens spelling the same fact three ways.
 *
 * It is also the ONLY place a picker says where its number came from, and that is a
 * decision rather than an omission. The list is a column of quantities — `Explore: 2
 * concurrency * 3/4 depth` — with no adjectives, because `from config` on both figures of
 * every row said it forty times in a column, which is what made the list read as broken
 * strings. A cap of 4 by default and a cap deliberately set to 4 are the same integer and
 * different intentions, so the fact has to live somewhere: the screen where the operator
 * chooses a number is the last place it fits, and a picker that omitted it would leave the
 * information nowhere at all.
 */
function pickerTitle(subject: string, ...clauses: (string | null)[]): string {
  return [subject, ...clauses.filter((clause) => clause !== null).map((clause) => `(${clause})`)].join(" ");
}

export function ceilingPickerProps(ceiling: CapCell): DialogSelectOptions<PickerChoice> {
  return {
    title: pickerTitle(CEILING_LABEL, ceiling.stated ? null : FROM_CONFIG),
    ...valuePicker(
      CAP_CHOICES.maxConcurrent,
      ceiling.stated ? ceiling.value : null,
      (value) => ({ kind: ChoiceKind.CeilingValue, value } as const satisfies PickerChoice),
      BACK_TO_LIST,
    ),
  };
}

/**
 * One agent's two caps, as the rows of a list.
 *
 * The middle screen, and it is here because a row in the list is TWO fields wide but
 * ONE press deep. Opening the concurrency picker straight from the row left the depth
 * cap unreachable — the pair was visible and only half of it was editable, which is
 * worse than showing one, because the operator had been told both were settings. A
 * test that drove the flow found it by asserting the screen it was told to expect.
 *
 * It is a list of fields rather than a text box because the host has no form widget —
 * `Dialog`, `DialogAlert`, `DialogConfirm`, `DialogPrompt` and `DialogSelect` are the
 * whole vocabulary, and only one of them takes a list — and because the operator then
 * sees BOTH caps and both values at once, which a single input box never could.
 *
 * The value rides in `footer`, the one field the host draws outside the clipping text,
 * so a number is never cut off, and `agentSummary` spells the cells exactly as the
 * list row does: one mark, one vocabulary, and a reader is never counting separators
 * to work out which kind of row they are on.
 */
export function agentCapsProps(agent: string, row: AgentEntry): DialogSelectOptions<CapsChoice> {
  return {
    options: [
      ...AGENT_CAP_NAMES.map((cap) => ({
        description: namedCell(capCellOf(row, cap)),
        title: CAP_LABEL[cap],
        value: { agent, cap, kind: ChoiceKind.Cap } as const satisfies CapsChoice,
      })),
      // The way out LAST, below both caps — and it stays a ROW. Escape cannot do this
      // job and the reason is structural rather than a matter of trying harder: the
      // host's own Dialog binds `escape`, `replace` keeps exactly one stack entry, and
      // the stack has no push, so escape closes the whole drill-down. A plugin binding
      // that intercepted it either loses the key outright or — with the host's marked
      // `fallthrough` — fires first and lets the host's close what it had just opened.
      // The way out LAST — and it stays a ROW rather than an escape binding. Escape
      // dismisses the host's dialog wherever the operator stands, so without this row
      // the only way back up is to reopen the palette.
      {
        description: "back to every agent's caps",
        title: ALL_AGENTS_LABEL,
        value: { kind: ChoiceKind.Back } as const satisfies CapsChoice,
      },
    ],
    title: agent,
  };
}

export function capPickerProps(agent: string, cap: AgentCapName, row: AgentEntry): DialogSelectOptions<PickerChoice> {
  const cell = capCellOf(row, cap);
  const stated = cell.stated ? cell.value : null;
  const bound = ceilingOf(row.depth, cap, cell.value);
  // What holds this cap down, stated ONCE, in the title, after a frame showed it six
  // times over. Two facts, in the order they matter: a BOUND changes what the number can
  // be set to, so it is the parenthetical; and when there is no bound but the cap is
  // unstated, the number is the config file's and the screen says so, because a
  // picker full of numbers a list of quiet figures chose between is where an operator
  // decides to overwrite one.
  return {
    title: pickerTitle(`${agent} — ${CAP_LABEL[cap]}`, bound === null ? null : boundClause(bound), stated === null ? FROM_CONFIG : null),
    // The value in force, handed to the HOST rather than painted beside the number. The
    // host matches `current` to a row with `isDeepEqual` (dialog-select.tsx), so this is
    // the same object shape every row below carries — structural identity, not reference
    // identity, and a case that reshaped one without the other would find the marker gone.
    current: { agent, cap, kind: ChoiceKind.Value, value: stated } as const satisfies PickerChoice,
    ...valuePicker(
      CAP_CHOICES[cap],
      stated,
      (value) => ({ agent, cap, kind: ChoiceKind.Value, value } as const satisfies PickerChoice),
      `back to ${agent}'s caps`,
    ),
  };
}

/**
 * A picker's rows: the way back, every value the cap can take, and the way to the config
 * file.
 *
 * The shared body of both pickers, extracted when the ceiling became editable, because
 * the two were about to become the same screen with a different title. It hands back the
 * rows alone rather than the whole dialog, because the TITLE is the one part that
 * genuinely differs — it names an agent and a cap, or names the total — and taking it
 * as a parameter would put the two call sites back to spelling the same four arguments.
 *
 * THREE claims live here, and each is a thing the operator reads.
 *
 * The way out is LAST, below the values: a list of things to act on is read top-down and
 * the exit belongs after what it exits. It is a row rather than an escape binding for a
 * structural reason — the host's own Dialog binds `escape`, `replace` keeps exactly one
 * stack entry, and the stack has no push, so escape can only close the whole drill-down.
 * Both halves of that are proved in the suite with the keymap's own harness.
 *
 * Which value is in force is the host's question, asked through the host's `current`
 * field: it draws the `●` and moves the selection there, in colours chosen at paint time
 * from the row's own state. The fallback row appears only where it can work, because
 * clearing a cap the overlay does not state writes nothing and would leave a row that
 * could only ever be inert.
 */
function valuePicker(
  choices: readonly number[],
  current: number | null,
  asChoice: (value: number | null) => PickerChoice,
  backTo: string,
): Pick<DialogSelectOptions<PickerChoice>, "options"> {
  return {
    options: [
      ...choices.map((value) => ({
        title: `${value}`,
        // WHICH value is in force is the HOST's question, asked through the HOST's
        // field. `current` on the dialog draws a `●` in `theme.primary` against that
        // row and opens the selection on it; it was a `StyledText` flag in the footer
        // before, hand-painted in a fixed tier that could not follow the selection bar
        // and sat 60 columns from the number it described. The host already had it.
        value: asChoice(value),
      })),
      ...(current === null
        ? []
        : [{
            title: "Use the config default",
            // The one sentence too long for a `description` beside a number, so it is
            // what the row says rather than what the number says. Without it a press
            // here looks identical to pressing the number, and the two write opposite
            // files.
            description: "use the config file's number",
            value: asChoice(null),
          }]),
      // The way out LAST, below the values and below the fallback. A list of things to
      // act on is read top-down and the exit belongs after what it exits; a `Back` row
      // above the numbers reads as one of the numbers. And the host replaces the screen
      // under a press, so an exit sitting among the values is one mis-aimed press away
      // from throwing away the place the operator was standing.
      {
        description: backTo,
        title: BACK_LABEL,
        value: { kind: ChoiceKind.Back } as const satisfies PickerChoice,
      },
    ],
  };
}


/**
 * The word on a picker's way out, and the destination the ceiling picker's names.
 *
 * `Back` and not the agent screen's `All agents`, and the two are not required to match
 * because they answer a different question. That row says where a press LANDS — the list
 * of every agent, which is what the operator would call the screen's name. A picker's
 * destination is the screen immediately above it, which is not the list, and a label
 * naming the list while standing on an agent's values would send the operator one level
 * further than they asked for.
 */
export const BACK_LABEL = "Back";

/**
 * The caps screen's way out, which is the same KIND of row under a different name.
 *
 * `Back` names the action and this names the destination, and neither is wrong: the
 * press lands on the list of every agent, which is what an operator would call this
 * screen's home, and a row saying `All agents` tells them where they will be in a way
 * that `Back` cannot. Two labels for one `ChoiceKind.Back` is the honest reading — the
 * two screens answer different questions — so both are named constants rather than one
 * of them being a literal, which is how the distinction would have been lost.
 */
export const ALL_AGENTS_LABEL = "All agents";
/** Where the total's picker goes back to. It bounds the list, so the list is the destination. */
const BACK_TO_LIST = "back to the list of agents";

/**
 * The width the host lays a row out in, and whether this one fits it.
 *
 * The host's own arithmetic, so the budget is enforced where the content is built
 * rather than discovered as a clipped sentence in a terminal. `medium` is 60 columns and
 * `large` is 88 (dialog.ts:22-25), and the plugin asks for neither now: a dialog that
 * never calls `setSize` gets the host's DEFAULT, which is what every other dialog in
 * opencode is, and being the only select in the app with a different width is the sort
 * of thing that reads as a different program before anyone can say why. A dialog can
 * never exceed the terminal less 2 (dialog.ts:59), which makes an 80-column terminal the
 * narrow case worth surviving.
 *
 * What the row spends before any content is the part that was wrong, twice over. The row
 * box is `<box flexDirection="row" paddingLeft={3} paddingRight={3} gap={1}>`
 * (dialog-select.tsx) inside a `scrollbox` at `paddingLeft={1} paddingRight={1}`, so
 * EIGHT columns go before the first character — and the `<text paddingLeft={3}>` that
 * looked like a ninth and tenth is not applied by opentui at all, which only a rendered
 * frame shows. `ROW_GAP` is charged per-footer rather than up front: it exists only
 * between a title and a footer, and a row with no footer pays none of it.
 */
/**
 * The two widths these screens are drawn at, and the reason there are two.
 *
 * `medium` is the host's DEFAULT and what every other dialog in opencode gets, so a
 * screen that fits in it takes it and says nothing. `large` is not a preference; it is
 * the only width at which the list's rows survive.
 *
 * The list is the one screen carrying a name and its caps on one line. The width a row
 * gets is `min(53, 78 - 1 - 8)` at a `large` dialog and `min(53, 58 - 1 - 8)` at
 * `medium` — so an agent name of 40 characters has 11 columns left for its caps at
 * `medium` and 39 at `large`, against a summary like `at once 2  depth 3/4 agent set`
 * that is 30 long. A 40-character agent name is a real thing: agents are named for what
 * they are, and hyphenated descriptive names are the house style.
 *
 * The pickers take `medium` and say nothing, because a row there is a number, a label, or
 * a sentence about what clearing a cap means — none of which is 40 characters of name.
 * One width for both would either clip the list or waste 28 columns on a picker of ten
 * numbers, and the first is the failure the width gate exists to prevent.
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

// ─── the flow ────────────────────────────────────────────────────────────────

/** What the list shows, where it writes, and the base config's fallbacks. */
interface LimitsView {
  dialog: AgentDialog;
  overlay: AgentOverlay;
  directory: string;
  base: DynamicTaskConfig;
  /**
   * The dispatchable agent set, kept because the depth binding is a function of it.
   *
   * Carried rather than re-read so `rowOf` can answer "is this cap reachable" for an
   * agent the list did not draw, using the SAME set the rows were built from. A row
   * resolved against a different agent set than its neighbours would report a depth
   * that holds for it and not for the row above.
   */
  agents: readonly string[] | null;
}

async function openLimits(ctx: Host, agentHost: OpaqueHost<AgentCaller>): Promise<void> {
  // The agent set is the host's own, so the screen has one row per agent this project
  // can actually dispatch to. A failed read is a WARNING over the capped agents, not
  // an empty list — see `agentDialogFrom`.
  let view = await readLimits(ctx, agentHost);
  if (view === undefined) return;
  if (view.dialog.problem) {
    // Said BEFORE the dialog opens rather than instead of it: showing nothing because
    // the file is odd would leave the operator with no way to REPAIR it, and repair is
    // the most likely reason they opened this.
    ctx.ui.toast.show({ message: view.dialog.problem, title: "Task limits", variant: "warning" });
  }
  // One loop, not a stack of screens: each drill-down returns the view to show next,
  // and a dismiss (`undefined`) ends the command. The old stack of `replace`d dialogs
  // had one entry and no push, so "back" was always a re-mount anyway — the loop just
  // says so.
  for (;;) {
    const choice = await selectLimitsRow(ctx, limitsListProps(view.dialog));
    if (choice === undefined) return;
    if (choice.kind === ChoiceKind.Ceiling) view = await openCeiling(ctx, view, agentHost);
    else view = await openAgentCaps(ctx, view, choice.agent, agentHost);
  }
}

/**
 * The cross-agent total, open. Returns the view the list shows next: the RE-READ one
 * after a write — the total bounds every row above it, so the screen that follows an
 * edit to it is the one that shows what it now bounds — and the view in hand when
 * the operator leaves without writing.
 */
async function openCeiling(ctx: Host, view: LimitsView, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView> {
  for (;;) {
    const choice = await selectLimitsRow(ctx, ceilingPickerProps(view.dialog.ceiling));
    if (choice === undefined || choice.kind === ChoiceKind.Back) return view;
    return applyEdit(ctx, view, CEILING_LABEL, () => applyCeilingEdit(view.overlay, { value: choice.value } satisfies CeilingChoice), agentHost);
  }
}

/**
 * One agent's caps, open. The way out is the "All agents" row: dismissing the dialog
 * leaves the whole drill-down, so without that row the only way back up is to reopen
 * the palette.
 */
async function openAgentCaps(ctx: Host, view: LimitsView, agent: string, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView> {
  for (;;) {
    const choice = await selectLimitsRow(ctx, agentCapsProps(agent, rowOf(view, agent)));
    if (choice === undefined || choice.kind === ChoiceKind.Back) return readLimitsOr(ctx, view, agentHost);
    return openCapPicker(ctx, view, choice.agent, choice.cap, agentHost);
  }
}

async function openCapPicker(ctx: Host, view: LimitsView, agent: string, cap: AgentCapName, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView> {
  const row = rowOf(view, agent);
  for (;;) {
    const choice = await selectLimitsRow(ctx, capPickerProps(agent, cap, row));
    // Back goes UP one level, to the agent's own caps — not out to the list. The old
    // stack had no push, so "back" was always a re-mount; the loop just says which
    // screen is re-mounted, and from the picker that is the caps screen.
    if (choice === undefined) return view;
    if (choice.kind === ChoiceKind.Back) return openAgentCaps(ctx, view, agent, agentHost);
    // Lands back on THIS agent's caps, re-read: the other cap of the same pair has to
    // be one choice away, and the row just written is stale the moment the file moves.
    return openAgentCaps(ctx, await applyEdit(ctx, view, agent, () => applyCapEdit(view.overlay, agent, { cap, value: choice.value } satisfies CapChoice), agentHost), agent, agentHost);
  }
}

/** The list re-read, or the view in hand when the host cannot be reached. */
async function readLimitsOr(ctx: Host, view: LimitsView, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView> {
  return (await readLimits(ctx, agentHost)) ?? view;
}

/**
 * Read the two things the screen shows: the overlay, and the host's agent list.
 *
 * Both are the same file the server reads and the same host call, so the screen and the
 * refusals are describing one system. The base config here carries NO plugin options:
 * those are resolved in the server process from the plugin array's tuple and a project
 * file, neither of which the TUI can see. So the inherited caps are the DEFAULTS, and
 * the cells that say "from config" say so for the numbers this process can see — which
 * is why a stated cap, the thing this screen edits, is unaffected.
 *
 * `undefined` when there is no project directory to read: the command is reachable
 * from anywhere, and an overlay path without a directory is not a path.
 */

/**
 * The agent list as the TUI host itself reads it: `ctx.data.location.agent`, the same synchronous
 * agent screens read — so the admission reader's agent-read bound, there for the server's wire dial, never fires here.
 */
function tuiAgentCaller(ctx: Host): AgentCaller {
  return {
    agent: {
      list: async () => {
        const listed = ctx.data.location.agent.list(ctx.location ?? undefined);
        if (!listed) throw new Error("agent store not yet synced");
        return listed;
      },
    },
  };
}
async function readLimits(ctx: Host, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView | undefined> {
  const directory = ctx.location?.directory;
  if (!directory) {
    ctx.ui.toast.show({ message: "no project directory", title: "Task limits", variant: "error" });
    return undefined;
  }
  const read = readAgentOverlay(directory);
  // The dispatch path's own reader, not a second derivation of it. The one source the
  // TUI still cannot see is the registration tuple, which `readDynamicTaskPolicy`
  // states rather than leaves to be discovered.
  const base = readDynamicTaskPolicy(directory, null);
  // `null` here is the FAILED read, not an empty project: it makes the screen show the
  // agents the overlay mentions under a warning, where `[]` would draw an empty list
  // and read as a claim about the project that the plugin never made.
  const agents = await dispatchableAgentNamesOrNull({ host: agentHost }, base);
  return {
    // Resolved HERE, once, by the reader the dialog hands over — a second derivation
    // of "what is in force" is a second answer to it, and the two are free to disagree
    // the moment the row set is built by something else.
    dialog: agentDialogFrom(read.raw, base, agents, base.allowSameAgentRecursion, read.problem),
    // Read with the one reader rather than cast, so an edit can never launder a value
    // the dispatch path already refuses.
    overlay: overlayFrom(read.raw),
    directory,
    base,
    agents,
  };
}
/**
 * The row for an agent, by the host's spelling — the one the list drew.
 *
 * The fallback is the base config's own resolution, and it is the caps module's
 * function rather than a hand-built pair: a row the screen could not find must read as
 * "every cap inherited", which is exactly what resolving an agent with no stated caps
 * means. A hand-built zero pair here would show `0 from config`, and 0 is a cap that
 * refuses every dispatch.
 *
 * The fallback also carries a depth binding, and by the SAME resolver the drawn rows
 * used. An agent the host has published since the list was read is reachable by a
 * dispatch, so a row that answered the depth question with the cap alone would be the
 * one row on the screen whose "depth 4" was never checked against the agent set.
 */
function rowOf(view: LimitsView, agent: string): AgentEntry {
  const found = view.dialog.rows.find((candidate) => candidate.name === agent);
  if (found) return found;
  const policy = resolveAgentCaps(view.base, agent);
  const names = view.agents ?? [];
  const limits = depthLimits({ allowSameAgentRecursion: view.base.allowSameAgentRecursion, maxDepth: policy.maxDepth }, names);
  return {
    depth: { boundBy: limits.boundBy, configured: policy.maxDepth, effective: limits.effective },
    name: agent,
    resolved: { maxConcurrent: policy.maxConcurrent, maxDepth: policy.maxDepth },
    stated: {},
  };
}

/**
 * Write one outcome and say what happened, in one place, and hand back the view the
 * caller shows next.
 *
 * Every edit in this dialog ends here, so the two things that must be said together —
 * a refusal that writes nothing, and a success that only means "in force on the next
 * dispatch" — are said by one function rather than once per call site. A call site
 * that wrote and then reported its own way is how a refusal comes to read as a
 * success, and neither symptom would look like a bug where it happened.
 *
 * The edit is a THUNK rather than an outcome so the two screens cannot disagree about
 * which overlay they are writing from: both read `view.overlay`, and the outcome is
 * computed here, after the shared `unchanged` check, from the same object the write
 * below uses.
 *
 * A write RE-READS before returning: the view in hand was read before the write, so
 * showing it again re-mounts the number the operator just replaced — and the next cap
 * answered from that row would then be written from caps the file no longer has. The
 * write, the read-back, and the screen the operator is left looking at are one thing.
 */
async function applyEdit(ctx: Host, view: LimitsView, title: string, edit: () => EditOutcome, agentHost: OpaqueHost<AgentCaller>): Promise<LimitsView> {
  const outcome = edit();
  if (outcome.kind === "unchanged") return view;
  if (outcome.kind === "invalid") {
    ctx.ui.toast.show({ message: outcome.problem, title, variant: "error" });
    return view;
  }
  try {
    writeAgentOverlay(view.directory, outcome.overlay);
  } catch (error) {
    ctx.ui.toast.show({
      message: `could not write ${agentOverlayPath(view.directory)}: ${errorMessage(error)}`,
      title,
      variant: "error",
    });
    return view;
  }
  ctx.ui.toast.show({ message: `${outcome.summary} — in force on the next dispatch`, title: "Task limits", variant: "success" });
  return (await readLimits(ctx, agentHost)) ?? view;
}
