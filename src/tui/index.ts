/**
 * The TUI half of the plugin: one command, one list, one file edited.
 *
 * A TUI module exports `tui` where a server module exports `server` — never both
 * (see `TuiPluginModule`), which is why this is a SEPARATE module rather than a flag
 * on the first. It is not, however, a second entry in opencode's `plugin` array:
 * that array is the SERVER plugin list. Registration is one directory, built as
 * `index` (server) plus `tui` (TUI), linked into `~/.config/opencode/plugins/`.
 *
 * The loader reads the module's DEFAULT export and ignores named exports, and a file
 * plugin must carry a non-empty `id`: it is the module's runtime identity, the key
 * `plugin_enabled` uses, and what a later duplicate is rejected against. So the
 * `export default` below is the module.
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
 *
 * This file is the FLOW: what registers, what reads, and what a chosen row does to the
 * file. What a row SAYS is `props.ts`, and how wide a row may be is `geometry.ts`.
 */
import type { Plugin } from "@opencode/plugin/tui";
import type { DialogSelectOptions } from "@opencode/plugin/tui/context";
import { type DynamicTaskConfig, readDynamicTaskPolicy } from "../shared/config.js";
import { depthLimits } from "../shared/task-policy.js";
import {
  type AgentCapName,
  type AgentOverlay,
  resolveAgentCaps,
} from "../shared/caps.js";
import { overlayChannel } from "./overlay-client.js";
import { type AgentCaller, dispatchableAgentNamesOrNull } from "../shared/admission.js";
import { type OpaqueHost, asOpaqueHost } from "../shared/client.js";
import {
  type AgentDialog,
  type AgentEntry,
  CEILING_LABEL,
  type CapChoice,
  type CeilingChoice,
  type EditOutcome,
  agentDialogFrom,
  applyCapEdit,
  applyCeilingEdit,
  overlayFrom,
} from "./agent-editor.js";
import { ChoiceKind, agentCapsProps, capPickerProps, ceilingPickerProps, limitsListProps } from "./props.js";

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
 * The agent list as the TUI host itself reads it: `ctx.data.location.agent`, the same
 * synchronous agent screens read — so the admission reader's bound, there for the
 * server's wire dial, never fires here.
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
  // Through the channel, not off the disk: the caps the dispatch path will judge
  // against are the ones this call returns, and reading anything else here would be a
  // second answer to the same question.
  const read = await overlayChannel(ctx).read();
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
    dialog: agentDialogFrom(read.caps, base, agents, base.allowSameAgentRecursion, read.problem),
    // Read with the one reader rather than cast, so an edit can never launder a value
    // the dispatch path already refuses.
    overlay: overlayFrom(read.caps),
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
  // A refusal is an ANSWER here, not an exception: the dialog's whole promise is that a
  // number it showed stays true, and an unstored edit must not be reported as an
  // applied one. The server's declared error is why this is a message and not a crash.
  const written = await overlayChannel(ctx).write(outcome.overlay);
  if (!("written" in written)) {
    ctx.ui.toast.show({ message: written.problem, title, variant: "error" });
    return view;
  }
  ctx.ui.toast.show({ message: `${outcome.summary} — in force on the next dispatch`, title: "Task limits", variant: "success" });
  return (await readLimits(ctx, agentHost)) ?? view;
}