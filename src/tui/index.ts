/**
 * The TUI half of the plugin: one command, one dialog, one file edited.
 *
 * A TUI module exports `tui` where a server module exports `server` — never both
 * (see `TuiPluginModule`), which is why this is a second entry in the `plugin`
 * array rather than a flag on the first.
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
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { normalizeDynamicTaskConfig } from "../shared/config.js";
import { readLaneOverlay, readLaneOverlayLanes, writeLaneOverlay, type LaneOverlay } from "../shared/lane-overlay.js";
import { loadTaskLedger, resolveTaskLedgerPath, type LoadedTaskLedger } from "../shared/session-lifecycle.js";
import { TaskState } from "../shared/task-state.js";
import { applyLaneEdit, capsOf, laneDialogFrom, newLaneEntry, promptFor, type LaneEntry } from "./lane-editor.js";

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
  const dispose = api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: "Lanes",
        description: "Concurrency caps and dispatch depth, per lane",
        category: "Dynamic Task",
        // The slash spelling is the same command, so there is one entry to
        // discover and not a second one to keep in step.
        slash: { name: "lanes" },
        run: () => {
          openLaneManager(api);
        },
      },
    ],
  });
  api.lifecycle.onDispose(dispose);
};

function openLaneManager(api: TuiApi): void {
  const view = readLanes(api);
  if (view.problem) {
    // Said BEFORE the dialog opens rather than instead of it: showing nothing
    // because the file is odd would leave the operator with no way to REPAIR it,
    // and repair is the most likely reason they opened this.
    api.ui.toast({ variant: "warning", title: "Lanes", message: view.problem });
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<LaneChoice>({
      title: "Lanes",
      placeholder: "a lane, or 'add a lane'",
      // Every option carries its own `onSelect`, and the dialog carries none.
      // Two places to answer "what happens when this row is chosen" is how a new
      // row type ends up handled in one of them and silently ignored in the other.
      options: [
        ...view.rows.map((row) => laneOption(api, view, row)),
        {
          title: "Add a lane…",
          value: { kind: ChoiceKind.Add } as const satisfies LaneChoice,
          onSelect: () => askForName(api, view),
        },
      ],
    }),
  );
}

type LaneView = {
  rows: LaneEntry[];
  problem: string | null;
  overlay: LaneOverlay;
  directory: string;
};

function laneOption(api: TuiApi, view: LaneView, row: LaneEntry) {
  const caps = capsOf(row.lane);
  return {
    title: row.name,
    value: { kind: ChoiceKind.Lane, row } as const satisfies LaneChoice,
    description: [
      `${caps.concurrency} concurrent`,
      `depth ${caps.depth}`,
      row.running === 0 ? "idle" : `${row.running} running, as last recorded`,
      row.inherited ? "caps from the config file" : "set in the overlay",
    ].join(" · "),
    onSelect: () => askForCaps(api, view, row),
  };
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
 * A question asked on top of the lane list, with dismissing it returning to the
 * list. Every question in this dialog has those two halves, so they are stated
 * once: a question that forgets the way back strands the operator in a prompt
 * over a dialog they can no longer see.
 */
function askOverLaneList(api: TuiApi, title: string, placeholder: string, onConfirm: (typed: string) => void): void {
  const back = () => openLaneManager(api);
  api.ui.dialog.replace(
    () => api.ui.DialogPrompt({ title, placeholder, onConfirm, onCancel: back }),
    back,
  );
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
  const raw = readLaneOverlay(directory);
  // The base config, with NO plugin options: those are resolved in the server
  // process from the plugin array's tuple and a project file, neither of which
  // the TUI can see. So the inherited caps here are the DEFAULTS, and the rows
  // that matter — the overlay's own — are unaffected: the dialog edits the
  // overlay, and a row whose caps came from elsewhere is labelled as such rather
  // than presented as this process's truth.
  const dialog = laneDialogFrom(raw.raw, runningByLane(directory), normalizeDynamicTaskConfig(null));
  return { rows: dialog.rows, problem: dialog.problem ?? raw.problem, overlay: overlayFrom(raw.raw), directory };
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
function runningByLane(directory: string): Map<string, number> {
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
