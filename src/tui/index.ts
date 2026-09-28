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
import type { TuiDialogSelectProps, TuiDialogStack, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { readDynamicTaskPolicy, type DynamicTaskConfig } from "../shared/config.js";
import { errorMessage } from "../shared/host-shape.js";
import { depthLimits } from "../shared/task-policy.js";
import {
  AGENT_CAP_NAMES,
  agentOverlayPath,
  readAgentOverlay,
  resolveAgentCaps,
  writeAgentOverlay,
  type AgentCapName,
  type AgentOverlay,
} from "../shared/caps.js";
import { dispatchableAgentNamesOrNull } from "../shared/admission.js";
import {
  CAP_CHOICES,
  CAP_LABEL,
  CEILING_LABEL,
  agentDialogFrom,
  applyCapEdit,
  applyCeilingEdit,
  capCellOf,
  ceilingOf,
  overlayFrom,
  type AgentDialog,
  type AgentEntry,
  type CapChoice,
  type CapCell,
  type CeilingChoice,
  type EditOutcome,
} from "./agent-editor.js";
import { cellFooter, plainSummary, screenTokens, summaryFooter, type ScreenTokens } from "./theme.js";

/** The api shape, named once. The plugin function is a long way down a type. */
type TuiApi = Parameters<TuiPlugin>[0];

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
 * Whether a dialog of OURS is on screen. Read by the escape layer below.
 *
 * A flag rather than `api.ui.dialog.open`, which answers the same question for
 * EVERY dialog: a plugin that gated on it would answer for other plugins' dialogs too,
 * and pressing escape in someone else's dialog would close it.
 */
let limitsDialogUp = false;

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

export const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        // REQUIRED for the command to appear in ctrl+p at all. The host surfaces
        // palette commands BY NAMESPACE; a command without one is registered,
        // runnable by keybinding and dispatchable by name, and listed nowhere. This
        // one field is the whole difference between a working palette entry and an
        // empty panel, and nothing about it is enforced by the type.
        namespace: "palette",
        title: "Task limits",
        // `desc`, not `description` — the host reads `desc` for the palette's
        // second line, and a `description` is a custom field it never looks at.
        desc: "How many of each agent run at once, and how deep it may nest",
        category: "Dynamic Task",
        // The slash spelling is the same command, so there is one entry to
        // discover and not a second one to keep in step. `slashName`, not
        // `slash: { name }` — the nested form belongs to the legacy `api.command`
        // API, which the host keeps only so v1 plugins initialize.
        slashName: "limits",
        // Async because the row set is the HOST'S agents, which is a client call:
        // a screen that listed the overlay's own entries would be showing a
        // hand-maintained index of agents rather than the ones this project can
        // actually dispatch to, and would omit every agent nobody had capped yet —
        // which is all of them, on a fresh project.
        run: () => {
          void openLimits(api);
        },
      },
    ],
  });
  // The escape hatch, as a LAYER of its own rather than a binding in the layer
  // above. `enabled` is a LAYER field in the host's keymap — the keymap's addons
  // register it on the layer and on the command, never on a binding — so a gated
  // binding here would gate the whole layer, and the command has to stay
  // dispatchable while the dialog is down.
  api.keymap.registerLayer({
    enabled: () => limitsDialogUp,
    bindings: [
      {
        key: "escape",
        desc: "Close task limits",
        group: "Dialog",
        cmd: () => closeLimitsDialog(api),
      },
    ],
  });
  // No `onDispose` for either layer. The host already disposes keymap registrations
  // when a plugin deactivates, and the spec says so explicitly; wiring it a second
  // time is not belt-and-braces, it is a second owner for one teardown.
};

/**
 * Every dialog of ours goes through here, which is what makes the flag above true
 * for all of them rather than for whichever call site remembered to set it.
 *
 * `replace` is the host's only way to put a dialog up, and it fires the outgoing
 * entry's `onClose` on every path that takes a dialog down: the escape and ctrl+c
 * handlers pop the top entry, `clear` walks the whole stack, and a second `replace`
 * walks whatever it is replacing. The flag is therefore cleared by the host rather
 * than by each of our own call sites, which is the only arrangement that cannot miss
 * one. It sets a boolean and nothing else — an `onClose` that called `clear()` would
 * recurse forever, because `clear` is itself what calls it.
 *
 * The flag is set AFTER the call, not before, and the order is load-bearing: a
 * `replace` notifies the outgoing entry's handler on its way past, so setting it
 * first would have that notification set it straight back to false and leave the
 * escape layer inert over the very dialog that was just mounted. `replace` is
 * synchronous, so afterwards is also the truth: the new entry is on the stack.
 *
 * The WIDTH lives here too, and for the same reason. `replace` resets the dialog to
 * `medium` (60 columns) on its way through, so `setSize` has to come after the mount
 * — a fact that was stated at each call site as a comment beside its own `setSize`,
 * and which the next dialog would have had to rediscover by reading the host. Every
 * dialog of ours is `large`, so it is the funnel's to set rather than a call site's: a
 * new dialog that forgot would be silently narrow, and a narrow row is clipped rather
 * than wrapped, so the symptom is a fact missing from a line that still looked fine.
 */
function mountLimitsDialog(api: TuiApi, render: Parameters<TuiDialogStack["replace"]>[0]): void {
  api.ui.dialog.replace(render, () => {
    limitsDialogUp = false;
  });
  limitsDialogUp = true;
  api.ui.dialog.setSize("large");
}

/** Every list of ours goes through here, on top of the mount funnel. */
function mountLimitsSelect<T>(api: TuiApi, build: () => TuiDialogSelectProps<T>): void {
  mountLimitsDialog(api, () => api.ui.DialogSelect(build()));
}

/**
 * Closing the way the host's own escape handler closes: drop the selection, then
 * clear the stack. Mirrored rather than shortened because the selection is the reason
 * this path exists — it is what disables the host's handler — so leaving it in place
 * would hand the next dialog a selection it did not create.
 */
function closeLimitsDialog(api: TuiApi): void {
  if (api.renderer.getSelection()) api.renderer.clearSelection();
  api.ui.dialog.clear();
}

/**
 * The module the host actually loads: `{ id, tui }` as the DEFAULT export, with no
 * `server` alongside it. Target-exclusive is a loader REJECTION, not a preference.
 */
const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
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
export function limitsListProps(
  dialog: AgentDialog,
  ask: (choice: ListChoice) => void,
  tokens: ScreenTokens,
): TuiDialogSelectProps<ListChoice> {
  return {
    title: "Task limits",
    options: [
      // The cross-agent total FIRST, above the agents it bounds, because it is the cap
      // a dispatch is refused on before any agent's own cap is consulted — so it is the
      // row that explains a refusal the per-agent rows do not. It is a row rather than a
      // cell in a row for the same reason: it has no agent, and a row that is not about
      // an agent cannot be drawn by the per-agent mapper below.
      {
        title: CEILING_LABEL,
        ...({ footer: cellFooter(dialog.ceiling, tokens) } as Record<string, unknown>),
        value: { kind: ChoiceKind.Ceiling } as const satisfies ListChoice,
        onSelect: () => ask({ kind: ChoiceKind.Ceiling }),
      },
      ...dialog.rows.map((row) => {
        // The field the caps ride in is CHOSEN BY MEASUREMENT, and the name is the reason
        // the choice exists. The footer's box does not shrink, so a name long enough to
        // crowd the caps clips its own row — silently, with no ellipsis. The host's
        // `details` is a line of its own, truncated in the middle rather than at the end,
        // so a name that cannot share a row still gets read: the row degrades to the
        // agent and roughly its caps, which is a fact, rather than to half a name and no
        // caps, which is a defect with an agent in it.
        //
        // `plainSummary` is the twin `summaryFooter` styles, so the two cannot disagree
        // about how wide the row is — and the width is asked of the same function that
        // the gate below is written against, rather than of a second arithmetic.
        const caps = plainSummary(row);
        return {
          title: row.name,
          // The footer's TYPE is `JSX.Element | string` while what a styled footer actually
          // is — and what the host's TextNodeRenderable accepts as a child — is a
          // `StyledText`. The field is therefore set by SPREAD, which is not excess-property
          // checked, and never by a cast: sound only because the host's own
          // `TextNodeRenderable.add` names StyledText among the child types it takes, read in
          // the host's source at the tag this binary was built from. A `span` element would
          // need an active renderer, which a props builder does not have outside a test.
          ...(fitsItsDialog({ title: row.name }, caps.length)
            ? ({ footer: summaryFooter(row, tokens) } as Record<string, unknown>)
            : withDetails(caps)),
          value: { kind: ChoiceKind.Agent, agent: row.name } as const satisfies ListChoice,
          onSelect: () => ask({ kind: ChoiceKind.Agent, agent: row.name }),
        };
      }),
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
 * The two things a picker can be asked to do, named.
 *
 * A pair of trailing callbacks said `confirm, back` on both picker builders, and the
 * duplication gate called the two signatures one piece of code — correctly, because the
 * duplication was real: two positional slots at the tail of two signatures, growing a
 * third input in the middle. Naming them is the fix rather than a restyle, and it says
 * the thing the pair means: one of these leaves the screen having changed the file, and
 * one of them leaves it having changed nothing. A reader of the old signature had to
 * check the body to learn that, and a caller could swap them by accident.
 */
type PickerActions<Choice> = {
  /** A value was chosen. It writes the file, so the screen that follows is the write's. */
  confirm: (choice: Choice) => void;
  /** The way out was chosen. It writes nothing, so the screen that follows is a re-read. */
  back: () => void;
};

export function ceilingPickerProps(ceiling: CapCell, actions: PickerActions<CeilingChoice>): TuiDialogSelectProps<PickerChoice> {
  const { confirm, back } = actions;
  return {
    title: CEILING_LABEL,
    ...valuePicker(
      CAP_CHOICES.maxConcurrent,
      ceiling.stated ? ceiling.value : null,
      (value) => ({ kind: ChoiceKind.CeilingValue, value } as const satisfies PickerChoice),
      (value) => confirm({ value }),
      back,
      BACK_TO_LIST,
      NOTHING_HOLDS,
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
export function agentCapsProps(
  agent: string,
  row: AgentEntry,
  ask: (cap: AgentCapName) => void,
  back: () => void,
  tokens: ScreenTokens,
): TuiDialogSelectProps<CapsChoice> {
  return {
    title: agent,
    options: [
      ...AGENT_CAP_NAMES.map((cap) => ({
        title: CAP_LABEL[cap],
        ...({ footer: cellFooter(capCellOf(row, cap), tokens) } as Record<string, unknown>),
        value: { kind: ChoiceKind.Cap, agent, cap } as const satisfies CapsChoice,
        onSelect: () => ask(cap),
      })),
      {
        title: "All agents",
        value: { kind: ChoiceKind.Back } as const satisfies CapsChoice,
        onSelect: back,
      },
    ],
  };
}

/**
 * The cap picker, as the host's own prop type: a list of the values one cap can take.
 *
 * The host has no form widget — `Dialog`, `DialogAlert`, `DialogConfirm`,
 * `DialogPrompt` and `DialogSelect` are the whole vocabulary, and only one of them
 * takes a list — so "set this number" is a list of numbers. Which is the better answer
 * anyway: the operator sees the whole legal range at once, which a text box never
 * could, and cannot type a value the reader will refuse.
 *
 * The title names the agent AND the cap, because the two questions a row asks are
 * "how many of this" and "how deep", and a picker that said only "at once" would be a
 * screen of numbers with no way to tell what any of them meant.
 */
export function capPickerProps(
  agent: string,
  cap: AgentCapName,
  row: AgentEntry,
  actions: PickerActions<CapChoice>,
): TuiDialogSelectProps<PickerChoice> {
  const { confirm, back } = actions;
  const cell = capCellOf(row, cap);
  const title = `${agent} — ${CAP_LABEL[cap]}`;
  return {
    title,
    // `details` is the one field the host budgets rather than clips: it draws the
    // string as its own row below, capped at `min(76, width - 12)`. A row's title and
    // description share ONE clipped line instead, so the sentence under a row cannot
    // be a suffix that runs off the end.
    //
    // `details` is absent from the published `TuiDialogSelectOption` although the host
    // reads it. The prop is returned by SPREAD rather than spelled out, because a
    // spread is not excess-property-checked and a cast is not permitted here — an
    // escape hatch, sound only because the field was read in the host's own source at
    // the tag this binary was built from. That is a fact about a file we do not own,
    // so `fitsItsDialog` below re-derives the host's layout and fails the build if the
    // content stops fitting it.
    ...valuePicker(
      CAP_CHOICES[cap],
      cell.stated ? cell.value : null,
      (value) => ({ kind: ChoiceKind.Value, agent, cap, value } as const satisfies PickerChoice),
      (value) => confirm({ cap, value }),
      back,
      `back to ${agent}'s caps`,
      (value) => ceilingOf(row.depth, cap, value),
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
 * FOUR claims live here and each is a thing the operator reads. The way back is FIRST,
 * which is the only position a navigation affordance belongs in: a screen that opens
 * with ten numbers and puts its exit at the bottom has made the operator scroll or press
 * END to change their mind. It is a row rather than an escape-layer binding because the
 * host's `replace` sets the dialog stack to a single entry — there is no previous dialog
 * to pop back to, so before this row a picker's only exit was the one that closed the
 * whole manager, and every other row on the screen wrote the file. The destination is
 * said in `details` because it is not the same screen for both pickers, and a label that
 * named one destination while standing on the other would be a lie in a row whose entire
 * job is to say where it goes.
 *
 * The value in force is MARKED, so the change is visible without holding the previous
 * screen in mind. The fallback row appears only where it can work, because clearing a cap
 * the overlay does not state writes nothing and would leave a row that could only ever be
 * inert. And the `details` spelling of what clearing means is the one field the host
 * budgets rather than clips.
 */
function valuePicker(
  choices: readonly number[],
  current: number | null,
  asChoice: (value: number | null) => PickerChoice,
  onPick: (value: number | null) => void,
  back: () => void,
  backTo: string,
  heldBy: (value: number) => number | null,
) {
  return {
    options: [
      {
        title: BACK_LABEL,
        ...withDetails(backTo),
        value: { kind: ChoiceKind.Back } as const satisfies PickerChoice,
        onSelect: back,
      },
      ...choices.map((value) => ({
        title: `${value}`,
        // A mark on a value the operator is not changing would be decoration.
        footer: value === current ? "in force" : undefined,
        // The depth the agent set will not let this cap reach. `description` rather than
        // a third colour tier, because it is a sentence and the host clips a suffix off
        // the headline rather than giving it a line of its own — and it shares that line
        // with a title of one or two characters, so there is room for it there.
        ...described(heldNote(heldBy, value)),
        value: asChoice(value),
        onSelect: () => onPick(value),
      })),
      ...(current === null
        ? []
        : [{
            title: "Use the config default",
            ...withDetails(FALLBACK_MEANING),
            value: asChoice(null),
            onSelect: () => onPick(null),
          }]),
    ],
  };
}

/**
 * Why this value cannot take effect, said on the value, or undefined when it can.
 *
 * The word "unreachable" and not a removed row, because the value is legal: `maxDepth`
 * stops offering values past 8 on the grounds that depth is a small number, and an
 * operator who registers a ninth agent tomorrow has a legal cap this list cannot hold.
 * Marking the ones the agent set holds down is the version of that care which survives
 * the agent set changing, and naming the number that binds makes the row a decision
 * rather than a refusal.
 */
const heldNote = (heldBy: (value: number) => number | null, value: number): string | undefined => {
  const effective = heldBy(value);
  return effective === null ? undefined : `unreachable — agent set binds at ${effective}`;
};

/**
 * Nothing holds a total down but the total.
 *
 * A function rather than a flag, so the picker's rows come out of ONE body and the
 * ceiling's row is not a special case with a branch in it. The claim is a real one and
 * belongs where it is made: `AgentDialog.ceiling` records that its `bounded` is always
 * null for the same reason.
 */
const NOTHING_HOLDS = () => null;

/** What the fallback row means, said on the row that does it. */
const FALLBACK_MEANING = "clear this cap and use the number in the config file instead";

/**
 * A row's `details`, spread in.
 *
 * The host budgets each entry of `details` against its own width and truncates it with
 * an ellipsis, while the headline it clips would take the whole row with it — so a row
 * that means something beyond its title says it here. The helper exists because the
 * field is not on the option type (the host carries it for keyboard rendering and
 * nothing in the plugin reads it back), so both rows that wanted it spelled the same
 * `as` object, and the duplication gate was right to call those two rows one piece of
 * code.
 */
const withDetails = (...lines: string[]) => ({ details: lines } as Record<string, unknown>);

/**
 * A row's `description`, spread in — and ABSENT when there is nothing to say.
 *
 * The opposite problem from `withDetails`, and the reason it is not the same helper. The
 * host declares `description?: string` without a `| undefined`, so under this repo's
 * `exactOptionalPropertyTypes` a key carrying `undefined` is a type error rather than
 * an absent key. A row that has no note therefore cannot say so by passing `undefined`;
 * the field has to be left out, and this is the one place that decides to leave it.
 */
const described = (description: string | undefined) =>
  (description === undefined ? {} : { description }) as Record<string, unknown>;

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
/** Where the total's picker goes back to. It bounds the list, so the list is the destination. */
const BACK_TO_LIST = "back to the list of agents";

/**
 * The width the host lays a row out in, and whether this one fits it.
 *
 * The host's own arithmetic, so the budget is enforced where the content is built
 * rather than discovered as a clipped sentence in a terminal. `large` is 88 columns and
 * `medium` is 60 (dialog.ts:22-25); the plugin asks for `large` on every screen it
 * mounts, so 88 is the figure and a dialog can never exceed the terminal less 2
 * (dialog.ts:59), which makes an 80-column terminal the narrow case worth surviving.
 *
 * What the row spends before any content is the part that was wrong. The row box is
 * `<box flexDirection="row" paddingLeft={3} paddingRight={3} gap={1}>`
 * (dialog-select.tsx:666) and the title inside it carries `paddingLeft={3}` of its own
 * (dialog-select.tsx:786) — six columns were counted, ten are spent, and the four in
 * between were handed to content that could not use them.
 */
const DIALOG_WIDTH = 88;
const TERMINAL_FLOOR = 80;
const ROW_INDENT = 3;
const ROW_PADDING = 3;
const ROW_GAP = 1;
const TITLE_INDENT = 3;
/** What the host subtracts from the DIALOG for a detail line, which it then caps at 76. */
const DETAIL_MARGIN = 12;

/** The dialog as it is actually drawn: 88, or the terminal less 2 on a narrow one. */
const DIALOG = Math.min(DIALOG_WIDTH, TERMINAL_FLOOR - 2);

/** What one option row has left for its title, its description, and its footer. */
export const DIALOG_ROW_TEXT = DIALOG - ROW_INDENT - ROW_PADDING - ROW_GAP - TITLE_INDENT;

/** What one `details` line has. The host truncates these with an ellipsis in the middle. */
const DIALOG_DETAIL_TEXT = Math.min(76, DIALOG - DETAIL_MARGIN);

/**
 * Whether every line of `row` fits the dialog the host will draw it in.
 *
 * The footer is charged to the row, and that is the claim that changed. The footer sits
 * in a `flexShrink={0}` box (dialog-select.tsx:786) while the title is `flexGrow={1}` with
 * `overflow="hidden"` and `wrapMode="none"`: the footer cannot give ground, so the TITLE
 * does, and it goes to a clip with no ellipsis and nothing to say it happened. A gate
 * measuring the title alone could not see an agent's name being eaten by its own caps —
 * which is what the hand-typed footer in the case that drove these names was hiding,
 * being a string production cannot emit and a field this function never read.
 *
 * `description` shares the title's `<text>` in a nested span (dialog-select.tsx:778), so
 * it is charged to the same line with the one space that separates them.
 */
export function fitsItsDialog(row: { title: string; description?: string; details?: string[] }, footerWidth = 0): boolean {
  const headline = row.title.length + 1 + (row.description?.length ?? 0) + footerWidth;
  return headline <= DIALOG_ROW_TEXT && (row.details ?? []).every((line) => line.length <= DIALOG_DETAIL_TEXT);
}

// ─── the flow ────────────────────────────────────────────────────────────────

/** What the list shows, where it writes, and the base config's fallbacks. */
type LimitsView = {
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
};

async function openLimits(api: TuiApi): Promise<void> {
  // The agent set is the host's own, so the screen has one row per agent this project
  // can actually dispatch to. A failed read is a WARNING over the capped agents, not
  // an empty list — see `agentDialogFrom`.
  const view = await readLimits(api);
  if (view.dialog.problem) {
    // Said BEFORE the dialog opens rather than instead of it: showing nothing because
    // the file is odd would leave the operator with no way to REPAIR it, and repair is
    // the most likely reason they opened this.
    api.ui.toast({ variant: "warning", title: "Task limits", message: view.dialog.problem });
  }
  showLimits(api, view);
}

/**
 * One list's press, dispatched on the row's own choice.
 *
 * The list takes ONE callback for every row rather than one per row KIND, and the
 * signature is the reason: a callback per kind means a new kind is a new positional
 * parameter, and a caller that has not been updated does not fail to compile — it
 * passes its tokens where the new callback belongs, and the screen fails on a theme
 * role three frames away from the mistake. A row carrying its own choice makes the
 * row kind a property of the row, so adding one is adding a case here and nothing
 * else.
 */
function askListChoice(api: TuiApi, view: LimitsView, choice: ListChoice): void {
  if (choice.kind === ChoiceKind.Ceiling) return openCeiling(api, view);
  openAgentCaps(api, view, choice.agent);
}

/** The list, over a view already read. The re-open path, so a second read is not paid for. */
function showLimits(api: TuiApi, view: LimitsView): void {
  const tokens = screenTokens(api.theme);
  mountLimitsSelect(api, () => limitsListProps(view.dialog, (choice) => askListChoice(api, view, choice), tokens));
}

/**
 * The cross-agent total, open.
 *
 * Lands on the LIST rather than on a per-agent screen, because there is no per-agent
 * screen for it: the total bounds every row above it, so the screen that follows an
 * edit to it is the one that shows what it now bounds.
 */
function openCeiling(api: TuiApi, view: LimitsView): void {
  const confirm = (choice: CeilingChoice) =>
    applyEdit(api, view, CEILING_LABEL, () => applyCeilingEdit(view.overlay, choice), (fresh) => showLimits(api, fresh));
  mountLimitsSelect(api, () => ceilingPickerProps(view.dialog.ceiling, { confirm, back: () => showLimits(api, view) }));
}

/**
 * One agent's caps, open.
 *
 * Every visible way out of here leads somewhere on purpose. The host's `replace` sets
 * the stack to a single entry, so there is no previous dialog to pop back to, and
 * escape from any of these leaves the manager entirely — which is why "All agents" is a
 * row and not a nicety: without it the only way back is to reopen the palette.
 */
function openAgentCaps(api: TuiApi, view: LimitsView, agent: string): void {
  const row = rowOf(view, agent);
  const tokens = screenTokens(api.theme);
  mountLimitsSelect(api, () =>
    agentCapsProps(agent, row, (cap) => openCapPicker(api, view, agent, cap), () => showLimits(api, view), tokens),
  );
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
 */
async function readLimits(api: TuiApi): Promise<LimitsView> {
  const directory = api.state.path.directory;
  const read = readAgentOverlay(directory);
  // The dispatch path's own reader, not a second derivation of it. This used to be
  // `normalizeDynamicTaskConfig(null)` — DEFAULTS only, with the hand-authored config
  // file never read — so a project that put caps in that file saw the defaults here
  // while its dispatches were judged against the file, and every "from config" on this
  // screen was a claim about the defaults. The one source the TUI still cannot see is
  // the registration tuple, which `readDynamicTaskPolicy` states rather than leaves to
  // be discovered. The path itself is named in ONE place, and a source-count pin in the
  // config suite holds that: a comment spelling it here would be a second place to
  // change, so it does not spell it.
  const base = readDynamicTaskPolicy(directory, null);
  // `null` here is the FAILED read, not an empty project: it makes the screen show the
  // agents the overlay mentions under a warning, where `[]` would draw an empty list
  // and read as a claim about the project that the plugin never made.
  const agents = await dispatchableAgentNamesOrNull(api.client, base);
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

function openCapPicker(api: TuiApi, view: LimitsView, agent: string, cap: AgentCapName): void {
  const row = rowOf(view, agent);
  // The landing screen takes the RE-READ view, which is why `confirm` ignores its own
  // `view` argument: a write makes the view the caller is holding out of date, and
  // landing on that one shows the number the operator just replaced.
  const confirm = (choice: CapChoice) =>
    applyEdit(api, view, agent, () => applyCapEdit(view.overlay, agent, choice), (fresh) => openAgentCaps(api, fresh, agent));
  mountLimitsSelect(api, () =>
    capPickerProps(agent, cap, row, { confirm, back: () => openAgentCaps(api, view, agent) }),
  );
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
  const limits = depthLimits({ maxDepth: policy.maxDepth, allowSameAgentRecursion: view.base.allowSameAgentRecursion }, names);
  return {
    name: agent,
    stated: {},
    resolved: { maxConcurrent: policy.maxConcurrent, maxDepth: policy.maxDepth },
    depth: { configured: policy.maxDepth, effective: limits.effective, boundBy: limits.boundBy },
  };
}

/**
 * Write one outcome and say what happened, in one place.
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
 * The list is re-opened afterwards, RE-READ: a write makes the dialog the caller is
 * holding stale, and answering a second cap from that stale row would write from caps
 * the file no longer has — silently dropping the cap just set. The picker is the only
 * screen showing one cap of one agent, so it is also the only place that bug could
 * hide.
 */
async function applyEdit(api: TuiApi, view: LimitsView, title: string, edit: () => EditOutcome, land: (fresh: LimitsView) => void): Promise<void> {
  const outcome = edit();
  if (outcome.kind === "unchanged") return land(view);
  if (outcome.kind === "invalid") {
    api.ui.toast({ variant: "error", title, message: outcome.problem });
    return;
  }
  try {
    writeAgentOverlay(view.directory, outcome.overlay);
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title,
      message: `could not write ${agentOverlayPath(view.directory)}: ${errorMessage(error)}`,
    });
    return;
  }
  api.ui.toast({ variant: "success", title: "Task limits", message: `${outcome.summary} — in force on the next dispatch` });
  // Where a confirmed answer LANDS is an argument because the value screen is reached
  // from one place and the other cap of the same agent has to be one keypress from it.
  // Landing on the list instead would make changing both caps two round trips through
  // the whole screen, which is the cost a per-agent cap pair is supposed to avoid.
  //
  // RE-READ before landing, and that is the load-bearing part of this function rather
  // than a courtesy: the view in hand was read before the write, so landing on it
  // re-mounts the number the operator just replaced — and the next cap answered from
  // that row would then be written from caps the file no longer has. The write, the
  // read-back, and the screen the operator is left looking at are one thing.
  land(await readLimits(api));
}

