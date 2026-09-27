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
  agentDialogFrom,
  applyCapEdit,
  capCellOf,
  overlayFrom,
  type AgentDialog,
  type AgentEntry,
  type CapChoice,
} from "./agent-editor.js";
import { cellFooter, screenTokens, summaryFooter, type ScreenTokens } from "./theme.js";

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
type ListChoice = { kind: ChoiceKind.Agent; agent: string };
type CapsChoice = { kind: ChoiceKind.Cap; agent: string; cap: AgentCapName } | { kind: ChoiceKind.Back };
type PickerChoice = { kind: ChoiceKind.Value; agent: string; cap: AgentCapName; value: number | null };

/**
 * The kinds of row either list can hold.
 *
 * An enum, like every other discriminant here, so "a cap" is a named value that cannot
 * be misspelled at a comparison site. A raw string compiles against a union just fine
 * and silently never matches if the spelling drifts.
 */
enum ChoiceKind {
  Agent = "agent",
  Cap = "cap",
  Back = "back",
  Value = "value",
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
  ask: (agent: string) => void,
  tokens: ScreenTokens,
): TuiDialogSelectProps<ListChoice> {
  return {
    title: "Task limits",
    options: dialog.rows.map((row) => ({
      title: row.name,
      // The footer's TYPE is `JSX.Element | string` while what a styled footer actually
      // is — and what the host's TextNodeRenderable accepts as a child — is a
      // `StyledText`. The field is therefore set by SPREAD, which is not excess-property
      // checked, and never by a cast: sound only because the host's own
      // `TextNodeRenderable.add` names StyledText among the child types it takes, read in
      // the host's source at the tag this binary was built from. A `span` element would
      // need an active renderer, which a props builder does not have outside a test.
      ...({ footer: summaryFooter(row, tokens) } as Record<string, unknown>),
      value: { kind: ChoiceKind.Agent, agent: row.name } as const satisfies ListChoice,
      onSelect: () => ask(row.name),
    })),
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
  current: number | null,
  confirm: (choice: CapChoice) => void,
): TuiDialogSelectProps<PickerChoice> {
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
    options: [
      ...CAP_CHOICES[cap].map((value) => ({
        title: `${value}`,
        // The value in force is marked, so the operator can see what they are changing
        // from without keeping the previous screen in their head. A mark on a value
        // they are not changing would be decoration.
        footer: value === current ? "in force" : undefined,
        value: { kind: ChoiceKind.Value, agent, cap, value } as const satisfies PickerChoice,
        onSelect: () => confirm({ cap, value }),
      })),
      ...(current === null
        ? []
        : [{
            // Only where it can work. Removing a cap the overlay does not state would
            // write nothing, so the row would be one that can only ever be inert.
            title: "Use the config default",
            ...({ details: [FALLBACK_MEANING] } as Record<string, unknown>),
            value: { kind: ChoiceKind.Value, agent, cap, value: null } as const satisfies PickerChoice,
            onSelect: () => confirm({ cap, value: null }),
          }]),
    ],
  };
}

/** What the fallback row means, said on the row that does it. */
const FALLBACK_MEANING = "clear this cap and use the number in the config file instead";

/**
 * The width the host lays a row out in, and whether this one fits it.
 *
 * The host's own arithmetic, so the budget is enforced where the content is built
 * rather than discovered as a clipped sentence in a terminal. `large` is 88 columns
 * (dialog.ts:22-26), the row's text is indented 3 and its box padded 3 more, a detail
 * line is capped at 76 or the width less 12 (dialog-select.tsx:702), and a dialog can
 * never exceed the terminal less 2 (dialog.ts:59) — so an 80-column terminal is the
 * narrow case, and the one worth holding the content to.
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

/** The list, over a view already read. The re-open path, so a second read is not paid for. */
function showLimits(api: TuiApi, view: LimitsView): void {
  const tokens = screenTokens(api.theme);
  mountLimitsSelect(api, () => limitsListProps(view.dialog, (agent) => openAgentCaps(api, view, agent), tokens));
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
  const confirm = (choice: CapChoice) => applyEdit(api, view, agent, choice, (fresh) => openAgentCaps(api, fresh, agent));
  mountLimitsSelect(api, () => capPickerProps(agent, cap, row.stated[cap] ?? null, confirm));
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
 * The list is re-opened afterwards, RE-READ: a write makes the dialog the caller is
 * holding stale, and answering a second cap from that stale row would write from caps
 * the file no longer has — silently dropping the cap just set. The picker is the only
 * screen showing one cap of one agent, so it is also the only place that bug could
 * hide.
 */
async function applyEdit(api: TuiApi, view: LimitsView, agent: string, choice: CapChoice, land: (fresh: LimitsView) => void): Promise<void> {
  const outcome = applyCapEdit(view.overlay, agent, choice);
  if (outcome.kind === "unchanged") return land(view);
  if (outcome.kind === "invalid") {
    api.ui.toast({ variant: "error", title: agent, message: outcome.problem });
    return;
  }
  try {
    writeAgentOverlay(view.directory, outcome.overlay);
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: agent,
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

