/**
 * The four screens as the host's own prop types — what a row says, and which row means
 * what. The flow that acts on a choice lives in `index.ts`.
 */
//jscpd:ignore-start
import type { DialogSelectOptions } from "@opencode/plugin/tui/context";
import { AGENT_CAP_NAMES, type AgentCapName } from "../shared/caps.js";
import type { ModelOverride } from "../shared/model-choice.js";
import {
  type AgentDialog,
  type AgentEntry,
  CAP_CHOICES,
  CAP_LABEL,
  CAP_NOUN,
  CEILING_LABEL,
  type CapCell,
  type ModelCell,
  MODEL_LABEL,
  MODEL_FROM_CONFIG,
  capCellOf,
  ceilingOf,
  displayName,
  modelCell,
  namedModelCell,
} from "./agent-editor.js";
import { spellModel } from "../shared/model-choice.js";
import { FROM_CONFIG, boundClause, namedCell, plainSummary, terseCell } from "./theme.js";
import { DIALOG_WIDTH, fitsItsDialog } from "./geometry.js";

//jscpd:ignore-end
/**
 * What a row in the list stands for, and what a row in a cap picker stands for.
 *
 * Every option carries its own `onSelect` and neither dialog carries one. Two places
 * to answer "what happens when this row is chosen" is how a new row type ends up
 * handled in one of them and silently ignored in the other — and it was stated twice,
 * once per screen, which is the same claim in two places and so a claim free to
 * disagree with itself. It belongs here, where the two lists' vocabularies meet.
 */
export type ListChoice =
  | { kind: ChoiceKind.Agent; agent: string }
  | { kind: ChoiceKind.Ceiling }
  // The global model, a sibling of the total: one setting for every agent, held at the
  // same level and edited through the same drill-down.
  | { kind: ChoiceKind.GlobalModel };
export type CapsChoice =
  | { kind: ChoiceKind.Cap; agent: string; cap: AgentCapName }
  // The agent's own model, which beats the global one. A row on the agent's screen rather
  // than on the list, because it is the agent's setting and not the fleet's.
  | { kind: ChoiceKind.Model; agent: string }
  | { kind: ChoiceKind.Back };
export type PickerChoice =
  | { kind: ChoiceKind.Value; agent: string; cap: AgentCapName; value: number | null }
  | { kind: ChoiceKind.CeilingValue; value: number | null }
  // A model, or null to clear the stated one and let the layer below answer. `agent` is
  // null for the global row, where there is no key to fold — the same distinction the
  // list's own `Ceiling` and `Agent` kinds draw, for the same reason.
  | { kind: ChoiceKind.ModelValue; agent: string | null; value: ModelOverride | null }
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
export enum ChoiceKind {
  Agent = "agent",
  Ceiling = "ceiling",
  Cap = "cap",
  Back = "back",
  Value = "value",
  CeilingValue = "ceilingValue",
  GlobalModel = "globalModel",
  Model = "model",
  ModelValue = "modelValue",
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
      {
        // The model, immediately below the total it answers to: the two document-level
        // settings together, so an operator reading "what applies to every agent" reads
        // them in one place instead of finding one on a second screen.
        title: `${displayName(MODEL_LABEL)}:`,
        ...(fitsItsDialog({ description: modelCell(dialog.model), title: MODEL_LABEL }, DIALOG_WIDTH) ? { description: modelCell(dialog.model) } : {}),
        value: { kind: ChoiceKind.GlobalModel } as const satisfies ListChoice,
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
/** The way out of a picker, named by where it lands. */
function backRow(description: string): { description: string; title: string; value: PickerChoice } {
  return { description, title: BACK_LABEL, value: { kind: ChoiceKind.Back } as const satisfies PickerChoice };
}

function pickerTitle(subject: string, ...clauses: (string | null)[]): string {
  return [subject, ...clauses.filter((clause) => clause !== null).map((clause) => `(${clause})`)].join(" ");
}

/**
/**
 * The model picker: the host's own catalog, then the way out.
 *
 * THE ROWS ARE THE HOST'S, and that is the whole claim. A model row the dispatch path
 * could diverge from is a screen that lies, so the catalog arrives from
 * `ctx.data.location.model.list()` — the same collection the host's own model selector
 * reads — and is named providerID/modelID by the host, not by us. The agent rows on the
 * list above are read the same way for the same reason.
 *
 * `models` is a parameter rather than a read because this module is pure: the props are
 * the value and the host is not in sight. An empty catalog answers with nothing to
 * choose, and a screen that offers no models says so rather than inventing them.
 *
 * The fallback row is NOT "use the config default": a cleared model falls back to the
 * layer below, which for the global setting is the dispatching parent's own model — a
 * live read and not a stored value. So the row says `Inherit` and the sentence under it
 * names the layer, because the two pickers offer two different things and the operator
 * is choosing between them.
 */
export function modelPickerProps(
  subject: string,
  models: readonly ModelOverride[],
  cell: ModelCell,
  inheritLabel: string,
): DialogSelectOptions<PickerChoice> {
  return {
    // No provenance clause when the model is the parent's: there is nothing to attribute
    // it to but a live read, and "from config" beside `parent's model` would be a claim
    // about a file that holds no such setting.
    title: pickerTitle(subject, cell.stated ? null : cell.model === null ? null : MODEL_FROM_CONFIG),
    current: { agent: null, kind: ChoiceKind.ModelValue, value: cell.stated ? cell.model : null } as const satisfies PickerChoice,
    options: [
      ...models.map((model) => ({
        // The host's own spelling, not ours: the title is what an operator reads on the
        // host's own model selector, and the value is the pair the write path stores. One
        // model, two representations, and only one of them is a string.
        title: spellModel(model),
        value: { agent: null, kind: ChoiceKind.ModelValue, value: model } as const satisfies PickerChoice,
      })),
      // Only where it can work: clearing a model the file does not state writes nothing,
      // the same rule the value pickers follow.
      ...(cell.stated
        ? [{
            title: "Inherit",
            description: inheritLabel,
            value: { agent: null, kind: ChoiceKind.ModelValue, value: null } as const satisfies PickerChoice,
          }]
        : []),
      backRow(subject),
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
 *
 * No callbacks on the builders: each option carries a choice VALUE and the flow switches
 * on what `select` resolves with. A reader of a builder signature learns what the rows
 * ARE, and the flow owns what they DO — one place each.
 */
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
 * Each figure rides in `description`, the one field the host draws inside the title's own
 * text, so a number is never cut off and nothing is stranded at the right edge;
 * `namedCell` spells the cells exactly as the list row does, so one mark and one
 * vocabulary, and a reader is never counting separators to work out which kind of row
 * they are on.
 */
export function agentCapsProps(agent: string, row: AgentEntry): DialogSelectOptions<CapsChoice> {
  return {
    options: [
      ...AGENT_CAP_NAMES.map((cap) => ({
        description: namedCell(capCellOf(row, cap)),
        title: CAP_LABEL[cap],
        value: { agent, cap, kind: ChoiceKind.Cap } as const satisfies CapsChoice,
      })),
      // The model sits with the caps because it is the agent's own setting in the same
      // sense they are: this is the screen where an agent's dispatch behaviour is stated,
      // and a model anywhere else would be a setting the operator has to leave this screen
      // to find. `namedModelCell` spells provenance the same way `namedCell` does, so one
      // vocabulary answers "is this mine?" across both kinds of row.
      {
        description: namedModelCell(row.model),
        title: MODEL_LABEL,
        value: { agent, kind: ChoiceKind.Model } as const satisfies CapsChoice,
      },
      // The way out LAST, below both caps — and it stays a ROW. Escape cannot do this
      // job and the reason is structural rather than a matter of trying harder: the
      // host's own Dialog binds `escape`, `replace` keeps exactly one stack entry, and
      // the stack has no push, so escape closes the whole drill-down. A plugin binding
      // that intercepted it either loses the key outright or — with the host's marked
      // `fallthrough` — fires first and lets the host's close what it had just opened.
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
      backRow(backTo),
    ],
  };
}