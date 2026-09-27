/**
 * The TUI half of the plugin: one command, one dialog, one file edited.
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
 * It lives in a different process from the server, which decides everything
 * about what it can honestly show. The running task set is in the server's
 * memory, so the occupancy number here comes from the ledger file the server
 * writes — the last RECORDED set, not a live read. The dialog says so in the row
 * rather than presenting a stale count as occupancy, because a cap shown next to
 * a count that may be two dispatches out of date reads as a live gauge and makes
 * the operator distrust the cap, which is the one number they can act on.
 *
 * The overlay file is shared, not duplicated: this edits the same format the
 * dispatch path already reads, so there is no second source of truth to reconcile
 * and no server endpoint added to read a number a file already holds.
 */
import type { TuiDialogPromptProps, TuiDialogSelectProps, TuiDialogStack, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { normalizeDynamicTaskConfig } from "../shared/config.js";
import { readLaneOverlay, readLaneOverlayLanes, writeLaneOverlay, type LaneOverlay } from "../shared/lane-overlay.js";
import { loadTaskLedger, resolveTaskLedgerPath, type LoadedTaskLedger } from "../shared/session-lifecycle.js";
import { TaskState } from "../shared/task-state.js";
import {
  applyLaneEdit,
  capsOf,
  laneDialogFrom,
  newLaneEntry,
  promptFor,
  type LaneDialog,
  type LaneEntry,
} from "./lane-editor.js";

/** The api shape, named once. The plugin function is a long way down a type. */
type TuiApi = Parameters<TuiPlugin>[0];

/**
 * The command name. It carries "lanes" because the palette's fuzzy search runs
 * over the command's own fields and which fields it searches is the host's
 * business, not ours — so the word has to be in the name as well as the title for
 * the ctrl+p query and the `/lanes` spelling to land on the same entry.
 */
const COMMAND = "dynamic-task.lanes";

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
 * EVERY dialog: a plugin that gated on it would answer for other plugins'
 * dialogs too, and pressing escape in someone else's dialog would close it.
 */
let laneDialogUp = false;

/**
 * What a row in the select stands for.
 *
 * A discriminated union rather than a lane name plus a magic string: the
 * alternative puts a sentinel in the same field as a real value, so "add a lane"
 * can only be spelled as a lane name nobody would choose, and one that somebody
 * does choose makes the dialog edit the wrong row.
 */
type LaneChoice = { kind: ChoiceKind.Lane; row: LaneEntry } | { kind: ChoiceKind.Add };

enum ChoiceKind {
  Lane = "lane",
  Add = "add",
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
        title: "Lanes",
        // `desc`, not `description` — the host reads `desc` for the palette's
        // second line, and a `description` is a custom field it never looks at.
        desc: "Concurrency caps and dispatch depth, per lane",
        category: "Dynamic Task",
        // The slash spelling is the same command, so there is one entry to
        // discover and not a second one to keep in step. `slashName`, not
        // `slash: { name }` — the nested form belongs to the legacy `api.command`
        // API, which the host keeps only so v1 plugins initialize.
        slashName: "lanes",
        run: () => {
          openLaneManager(api);
        },
      },
    ],
  });
  // The escape hatch, as a LAYER of its own rather than a binding in the layer
  // above. `enabled` is a LAYER field in the host's keymap — the keymap's
  // addons register it on the layer and on the command, never on a binding — so
  // a gated binding here would gate the whole layer, and the command has to stay
  // dispatchable while the dialog is down.
  api.keymap.registerLayer({
    enabled: () => laneDialogUp,
    bindings: [
      {
        key: "escape",
        desc: "Close lanes",
        group: "Dialog",
        cmd: () => closeLaneDialog(api),
      },
    ],
  });
  // No `onDispose` for either layer. The host already disposes keymap
  // registrations when a plugin deactivates, and the spec says so explicitly;
  // wiring it a second time is not belt-and-braces, it is a second owner for one
  // teardown.
};

/**
 * Every dialog of ours goes through here, which is what makes the flag above true
 * for all of them rather than for whichever call site remembered to set it.
 *
 * `replace` is the host's only way to put a dialog up, and it fires the outgoing
 * entry's `onClose` on every path that takes a dialog down: the escape and
 * ctrl+c handlers pop the top entry, `clear` walks the whole stack, and a second
 * `replace` walks whatever it is replacing. The flag is therefore cleared by the
 * host rather than by each of our own call sites, which is the only arrangement
 * that cannot miss one. It sets a boolean and nothing else — an `onClose` that
 * called `clear()` would recurse forever, because `clear` is itself what calls it.
 *
 * The flag is set AFTER the call, not before, and the order is load-bearing: a
 * `replace` notifies the outgoing entry's handler on its way past, so setting it
 * first would have that notification set it straight back to false and leave the
 * escape layer inert over the very dialog that was just mounted. `replace` is
 * synchronous, so afterwards is also the truth: the new entry is on the stack.
 */
function mountLaneDialog(api: TuiApi, render: Parameters<TuiDialogStack["replace"]>[0]): void {
  api.ui.dialog.replace(render, () => {
    laneDialogUp = false;
  });
  laneDialogUp = true;
}

/**
 * Closing the way the host's own escape handler closes: drop the selection, then
 * clear the stack. Mirrored rather than shortened because the selection is the
 * reason this path exists — it is what disables the host's handler — so leaving
 * it in place would hand the next dialog a selection it did not create.
 */
function closeLaneDialog(api: TuiApi): void {
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

function openLaneManager(api: TuiApi): void {
  const view = readLanes(api);
  if (view.problem) {
    // Said BEFORE the dialog opens rather than instead of it: showing nothing
    // because the file is odd would leave the operator with no way to REPAIR it,
    // and repair is the most likely reason they opened this.
    api.ui.toast({ variant: "warning", title: "Lanes", message: view.problem });
  }
  const asks: LaneAsks = {
    caps: (row) => askForCaps(api, view, row),
    add: () => askForName(api, view),
  };
  // Mounted the way every other plugin mounts: through the one funnel that also
  // owns the escape layer's gate. The handler `mountLaneDialog` passes is a
  // NOTIFICATION, not a mechanism — the host closes on escape by popping the
  // stack itself, and this only records that the dialog is gone. See the funnel
  // for why an `onClose` that closed would recurse.
  mountLaneDialog(api, () => api.ui.DialogSelect(laneSelectProps(view, asks)));
  // The WIDEST thing this plugin shows, so it asks the host for a wider dialog:
  // `medium` is 60 columns, which is a name plus a short cap line and nothing
  // more, and a long lane name clipped its own caps. AFTER the mount, because
  // `replace` resets the size to medium on its way through (dialog.ts:158) — set
  // it first and the host would put it straight back.
  api.ui.dialog.setSize("large");
}

/**
 * What the dialog is handed: the dialog's own view of the rows, plus the two things
 * it needs to write an edit back — the overlay to write into, and where it lives.
 *
 * An intersection rather than a restatement because `readLanes` builds this by
 * re-deriving `rows` and `problem` out of `laneDialogFrom`'s result one line later.
 * A second copy of that pair is a second claim about one producer's output, and it
 * can only be right by coincidence: `LaneDialog` gains a field, the copy does not,
 * and the writer keeps working from a value the reader never sent.
 */
type LaneView = LaneDialog & {
  overlay: LaneOverlay;
  directory: string;
};

/**
 * The view, from what the dialog shows and where it will write back.
 *
 * Pure, so the whole content of both dialogs can be checked with no host at all: the
 * read is an ARGUMENT here rather than a side effect of opening. That is what lets
 * the dialog's props be asserted on directly, with no stand-in for the host's widgets.
 *
 * The argument is the READER'S RESULT, not the overlay: taking the overlay alone
 * would let the two nest wrongly — a whole reader result passed where the overlay
 * belongs reads as an overlay with no lanes, which is an empty list, not an error —
 * and it would drop the problem the reader reported, turning "this file is odd" into
 * a dialog that silently shows less.
 */
export function laneViewFrom(read: ReturnType<typeof readLaneOverlay>, running: Map<string, number>, directory: string): LaneView {
  // The base config, with NO plugin options: those are resolved in the server
  // process from the plugin array's tuple and a project file, neither of which the
  // TUI can see. So the inherited caps here are the DEFAULTS, and the rows that
  // matter — the overlay's own — are unaffected: the dialog edits the overlay, and
  // a row whose caps came from elsewhere is labelled as such rather than presented as
  // this process's truth.
  const dialog = laneDialogFrom(read.raw, running, normalizeDynamicTaskConfig(null));
  return { rows: dialog.rows, problem: dialog.problem ?? read.problem, overlay: overlayFrom(read.raw), directory };
}

/** What a row's selection asks for. The dialog's two ways forward, named. */
export type LaneAsks = {
  caps: (row: LaneEntry) => void;
  add: () => void;
};

/**
 * The lane list, as the host's own prop type.
 *
 * Returning the host's declared shape instead of handing props to the widget in
 * line is what makes the dialog checkable: the props ARE the value, so they are
 * asserted on directly, and a field the host never reads — `description` for the
 * palette's `desc`, the legacy `slash` for `slashName` — becomes a type error here
 * rather than a silent custom property that only a terminal would reveal.
 */
export function laneSelectProps(view: LaneView, asks: LaneAsks): TuiDialogSelectProps<LaneChoice> {
  return {
    title: "Lanes",
    placeholder: "a lane, or 'add a lane'",
    // Every option carries its own `onSelect`, and the dialog carries none.
    // Two places to answer "what happens when this row is chosen" is how a new
    // row type ends up handled in one of them and silently ignored in the other.
    options: [
      ...view.rows.map((row) => ({
        title: row.name,
        value: { kind: ChoiceKind.Lane, row } as const satisfies LaneChoice,
        ...laneRowText(row),
        onSelect: () => asks.caps(row),
      })),
      {
        title: "Add a lane…",
        value: { kind: ChoiceKind.Add } as const satisfies LaneChoice,
        // Described like a real row, so it does not read as the one entry the
        // dialog forgot to fill in.
        description: "name a lane, then set its caps",
        onSelect: asks.add,
      },
    ],
  };
}

/** The caps question, as the host's own prop type. */
export function lanePromptProps(
  title: string,
  placeholder: string,
  onConfirm: (typed: string) => void,
): TuiDialogPromptProps {
  return { title, placeholder, onConfirm };
}

/**
 * One row's two lines, and WHY they are two.
 *
 * A row's title and description share ONE line: the host renders them into a
 * single `<text>` with `wrapMode="none"` and `overflow="hidden"`
 * (dialog-select.tsx:766-783), so a description is a SUFFIX, not a subtitle. It
 * never wraps, and past the width it is simply clipped. This list put all four of
 * its facts there — 60 characters before the row's 3-column indent, in a dialog 60
 * columns wide — so the last clause was cut off on every lane, every time, and a
 * row read as a truncated sentence.
 *
 * The host has a second line for exactly this: `details`, drawn as its own row
 * below with a budget it applies itself (`truncateMiddle(detail, min(76,
 * width - 12))`, dialog-select.tsx:702) and counted in the list's height (line
 * 209). So the facts are sorted by how much they matter, and each goes where it
 * fits:
 *
 *  - the two CAPS on the line they are compared on. Comparing them is the reason
 *    to open this dialog at all, so they get the scanning position.
 *  - the OCCUPANCY and the PROVENANCE below, where there is room to say them in
 *    full. Provenance decides whether editing this row does anything at all, so
 *    it is the last thing that may be truncated, and `details` is the only field
 *    the host budgets rather than clips.
 *
 * `details` is absent from the published `TuiDialogSelectOption` although the host
 * reads it. The type is returned by SPREAD rather than spelled out, because a
 * spread is not excess-property-checked and a cast is not permitted here — an
 * escape hatch, sound only because the field was read in the host's own source at
 * the tag this binary was built from. That is a fact about a file we do not own,
 * so `fitsItsDialog` below re-derives the host's layout and fails the build if the
 * content stops fitting it.
 */
function laneRowText(row: LaneEntry): { description: string; details: string[] } {
  const caps = capsOf(row.lane);
  const occupancy = row.running === 0 ? "idle" : `${row.running} running, as last recorded`;
  const provenance = row.inherited ? "caps from the config file" : "set in the overlay";
  // One detail, not two: a row is two lines tall, and the two context facts are a
  // single thought — how busy it is, and whose caps those are.
  return { description: [`${caps.concurrency} concurrent`, `depth ${caps.depth}`].join(" · "), details: [[occupancy, provenance].join(" · ")] };
}

/**
 * The width the host lays a row out in, and whether this one fits it.
 *
 * The host's own arithmetic, so the budget is enforced where the content is built
 * rather than discovered as a clipped sentence in a terminal. `large` is 88 columns
 * (dialog.ts:22-26), the row's text is indented 3 and its box padded 3 more, a
 * detail line is capped at 76 or the width less 12 (dialog-select.tsx:702), and a
 * dialog can never exceed the terminal less 2 (dialog.ts:59) — so an 80-column
 * terminal is the narrow case, and the one worth holding the content to.
 */
const DIALOG_WIDTH = 88;
const TERMINAL_FLOOR = 80;
const ROW_INDENT = 3;
const ROW_PADDING = 3;

/** Whether every line of `option` fits the dialog the host will draw it in. */
export function fitsItsDialog(option: { title: string; description?: string; details?: string[] }): boolean {
  const width = Math.min(DIALOG_WIDTH, TERMINAL_FLOOR - 2) - ROW_INDENT - ROW_PADDING;
  const headline = option.title.length + 1 + (option.description?.length ?? 0);
  return headline <= width && (option.details ?? []).every((line) => line.length <= Math.min(76, width - 12));
}

function askForName(api: TuiApi, view: LaneView): void {
  askOverLaneList(api, "New lane name", "build", (name) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    // An existing name is not an error to stop on: that row IS the answer,
    // and opening it is what the operator meant.
    const existing = view.rows.find((row) => row.name === trimmed);
    askForCaps(api, view, existing ?? newLaneEntry(trimmed));
  });
}

/**
 * A question asked on top of the lane list.
 *
 * A question REPLACES the list — the host's `replace` sets the stack to a single
 * entry, so there is no depth to nest into — which is why escape here leaves the
 * whole manager rather than returning to the list, and why the confirm path
 * re-opens the list below rather than popping back to it.
 */
function askOverLaneList(api: TuiApi, title: string, placeholder: string, onConfirm: (typed: string) => void): void {
  mountLaneDialog(api, () => api.ui.DialogPrompt(lanePromptProps(title, placeholder, onConfirm)));
}

function askForCaps(api: TuiApi, view: LaneView, row: LaneEntry): void {
  const prompt = promptFor(row);
  const askAgain = (problem: string) => {
    api.ui.toast({ variant: "error", title: row.name, message: problem });
    // Reopen in place: an answer that cannot be used is a question the operator
    // still owes, and closing on failure answers it for them by throwing away
    // everything they typed.
    askForCaps(api, view, row);
  };
  askOverLaneList(api, prompt.title, prompt.placeholder, (typed) => {
    const outcome = applyLaneEdit(view.overlay, row, typed);
    if (outcome.kind === "invalid") return askAgain(outcome.problem);
    try {
      writeLaneOverlay(view.directory, outcome.overlay);
    } catch (error) {
      return askAgain(`could not write the overlay: ${error instanceof Error ? error.message : String(error)}`);
    }
    api.ui.toast({ variant: "success", title: "Lanes", message: `${outcome.summary} — in force on the next dispatch` });
    openLaneManager(api);
  });
}

/**
 * Read the three things the dialog shows: the overlay, the base config's lanes,
 * and the last recorded occupancy. Each comes from the same file the server
 * reads, so the dialog and the refusals are describing one system.
 */
function readLanes(api: TuiApi): LaneView {
  const directory = api.state.path.directory;
  return laneViewFrom(readLaneOverlay(directory), runningByLane(directory), directory);
}

/**
 * The overlay as the dialog will write it back.
 *
 * Read with the one reader rather than cast, so an edit can never launder a value
 * the dispatch path already refuses: a body that arrived as
 * `{"maxConcurrent": "four"}` is read as `{}`, and an edit on top of `{}` writes a
 * body the server will accept, instead of preserving the garbage beside the new
 * number.
 */
function overlayFrom(raw: unknown): LaneOverlay {
  const read = readLaneOverlayLanes(raw);
  return read === null ? { lanes: {} } : { lanes: read.lanes };
}

/**
 * Running tasks per lane, from the ledger's active set.
 *
 * No try/catch, and that is a claim rather than an omission: `loadTaskLedger`
 * REPORTS every way it can fail rather than throwing — a missing file, a
 * directory where the file belongs, and unparseable JSON were each probed and each
 * returns an empty ledger. So a catch here could never fire, and a catch that
 * cannot fire is worse than none: it says "this boundary is dangerous" to every
 * reader while quietly proving the opposite.
 */
export function runningByLane(directory: string): Map<string, number> {
  const counts = new Map<string, number>();
  // A PATH, not the directory. Passing the directory made the read fail on every
  // call, and the catch that hid that reported "no tasks are running" — so the row
  // confidently said `idle` for a lane with work in it.
  const loaded: LoadedTaskLedger = loadTaskLedger(resolveTaskLedgerPath(directory));
  for (const task of loaded.active.values()) {
    if (task.state !== TaskState.Active) continue;
    counts.set(task.lane, (counts.get(task.lane) ?? 0) + 1);
  }
  return counts;
}
