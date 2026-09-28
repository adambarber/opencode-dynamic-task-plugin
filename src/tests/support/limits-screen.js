/**
 * The limits screen's test harness: a host double, and the scenario vocabulary.
 *
 * It was the top of `tui-limits-command.test.js`, and it outgrew the file's subject: the
 * cross-agent total is a different cap on a different screen from the command that opens
 * the list, and its cases pushed the command's file past the length the gate allows. So
 * the harness moved out and each suite kept the cases whose subject is its own. What is
 * left here is not a helper library in the abstract: it is the ONE dialog stack, the ONE
 * overlay reader and the ONE set of scenario names, and two suites sharing them is what
 * makes a row that appears on one screen and not the other a fact both can see.
 *
 * What the double does and does not stand for is the contract the command's suite
 * states, and it is worth repeating here because this is where a case is written: the
 * CONTENT of a dialog is not a host interaction at all - the prop builders are pure and
 * return the host's own type, so most cases need no double. The double is here for the
 * SEQUENCES: a command pressed, a row chosen, a value chosen. It does not model escape,
 * because the host owns escape.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_OVERLAY_FILE, readAgentOverlay, writeAgentOverlay } from "../../../dist/shared/caps.js";
import { withTempDir } from "./fixtures.js";
import { renderTree } from "./render-tree.js";
import { DYNAMIC_TASK_FILE, normalizeDynamicTaskConfig } from "../../../dist/shared/config.js";
import { CAP_LABEL, agentDialogFrom } from "../../../dist/tui/agent-editor.js";
import { screenTokens } from "../../../dist/tui/theme.js";
import { darkTheme } from "./harness.js";
import { footerText } from "./assertions.js";
import tuiModule, { fitsItsDialog, limitsListProps, tui } from "../../../dist/tui/index.js";

/** The base config the TUI can see: defaults only, no plugin options. */
export const BASE = normalizeDynamicTaskConfig(null);

/** Nothing asked, for the cases about what a row SAYS rather than what choosing it does. */
export const NO_ASKS = () => {};

/** The agents this project has, as the host would report them. */
export const REGISTERED = ["explore", "general", "review"];

/**
 * The dialog stack, modelled on the host's own `useDialog` rather than on what a
 * test would like it to do.
 *
 * Three properties are the host's, and each was measured against the source at the
 * tag the running binary was built from (packages/tui/src/ui/dialog.ts):
 *
 *  - `replace` SETS the stack to a single entry. There is no push, so depth never
 *    exceeds one and a second dialog cannot bury the first.
 *  - `replace` and `clear` both walk the outgoing entries calling their `onClose`.
 *    That is why an `onClose` which itself cleared would recurse forever.
 *  - the escape and ctrl+c handlers pop the top entry and call its `onClose`.
 *
 * The earlier double had none of these: it ignored `onClose` entirely, which is what
 * let a suite "prove" a way out of every dialog that the host does not offer.
 */
export function dialogStack() {
  const mounted = [];
  let stack = [];
  const notifyOutgoing = () => {
    for (const entry of stack) entry.onClose?.();
  };
  return {
    stack: {
      replace: (render, onClose) => {
        notifyOutgoing();
        stack = [{ render, onClose }];
        mounted.push(render());
      },
      clear: () => {
        notifyOutgoing();
        stack = [];
        mounted.length = 0;
      },
      setSize: () => {},
      get size() {
        return "medium";
      },
      get depth() {
        return stack.length;
      },
      get open() {
        return stack.length > 0;
      },
      /** The notification the top entry was mounted with, for asserting on directly. */
      onCloseOf: () => stack[0]?.onClose,
    },
    mounted,
  };
}

/**
 * The renderer, as the plugin meets it.
 *
 * This is `api.renderer`, a `CliRenderer`, and it is handed over under THAT name, so it has
 * to answer for the members the plugin reads off it — not just the ones an earlier suite
 * happened to need. A double named `renderer` that is really a selection double is the
 * worst kind of collaborator: it passes a case while leaving a real code path unrun, and
 * when production then reads `renderer.root` the suite breaks for a reason that has nothing
 * to do with what it claims to be testing. So it carries a `root` too, built by
 * `renderTree`, which means the counter's real mount — the tree walk, the `TextRenderable`,
 * the add to the host's own line — is exercised here rather than nowhere.
 *
 * `getSelection` returning an object whose `getSelectedText` is non-empty is what disables
 * the host's own escape binding, so the tests can put that state in place — and take it
 * away again — rather than assume it.
 */
export function rendererDouble({ footer = true } = {}) {
  const state = { selection: null };
  return {
    state,
    api: {
      // The real `CliRenderer` exposes both, and a tree the counter can walk. `footer:
      // false` renames the hint, which is the case where the walk finds nothing and the
      // slot has to carry the counter instead.
      root: renderTree({ footer }).root,
      getSelection: () => state.selection,
      clearSelection: () => {
        state.selection = null;
      },
    },
  };
}

/**
 * A host, for the cases that genuinely have to press something.
 *
 * `DialogSelect` returns nothing, and nothing IS a valid `JSX.Element`: Solid's
 * element type is a loose union, so a stand-in that renders nothing satisfies the
 * host's real signature with no cast anywhere. What it hands back is the host's props
 * object, unchanged, so the suite reads the same shape the host would.
 */
export function hostApi(directory, { withFooter = true } = {}) {
  const seen = { layers: [], toasts: [], selects: [], slots: [] };
  const dialog = dialogStack();
  const renderer = rendererDouble({ footer: withFooter });
  return {
    seen,
    mounted: dialog.mounted,
    dialog: dialog.stack,
    renderer: renderer.state,
    api: {
      state: { ready: true, config: {}, provider: [], path: { state: "", config: "", worktree: "", directory }, vcs: undefined },
      // The host's theme, because the screen resolves its design tokens from it. The
      // host derives `text` from the TERMINAL's own default foreground (theme.ts
      // `generateSystem`), so a double carrying a dark terminal's foreground and a
      // muted gray is the shape that actually occurs — not a theme the suite invented
      // to suit the assertions.
      theme: HOST_THEME,
      keymap: {
        registerLayer: (layer) => {
          seen.layers.push(layer);
          return () => {};
        },
      },
      renderer: renderer.api,
      // The row set is the HOST's registered agents, so the client has to answer —
      // and `app.agents` is the one call the shared reader makes. A bare array is
      // what `parseAgentList` reads, which is the shape the SDK returns through the
      // envelope.
      client: {
        app: {
          agents: async () => ({ data: REGISTERED.map((name) => ({ name })) }),
          log: async () => undefined,
        },
      },
      // Slots are where the LIVE counter is mounted, so the double has to accept a
      // registration and keep it. It does not call the slot's function: doing so needs
      // an active renderer, which is the same absence that keeps the gauge's element
      // construction out of every case here. What a case CAN check is that the module
      // registers exactly one, under the name it claims — a counter mounted in a slot
      // the host never draws is not a failing test, it is a number that never appears.
      slots: {
        register: (plugin) => {
          seen.slots.push(plugin);
          return "dynamic-task";
        },
      },
      ui: {
        dialog: dialog.stack,
        DialogSelect: (props) => {
          seen.selects.push(props);
        },
        toast: (input) => seen.toasts.push(input),
      },
    },
  };
}

/** The overlay as it sits on disk, which is what the dispatch path will read. */
export function readOverlay(directory) {
  return JSON.parse(readFileSync(join(directory, AGENT_OVERLAY_FILE), "utf8"));
}

/**
 * The host's theme, once. Both the api double and the token resolution read this, so a
 * case cannot pass a hand-made token object and prove something the screen would never
 * paint — the tokens below are the production `screenTokens` over this theme.
 */
export const HOST_THEME = darkTheme();
export const TOKENS = screenTokens(HOST_THEME);


/**
 * The dialog's content, as the host's own props, with no host in sight.
 *
 * The real reader, the real view, the real prop builders. This is what most cases
 * below use, and it is why they need no double: the props ARE the value, and nothing
 * between the disk and the assertion is a stand-in.
 */
export function listOver(directory, agentNames = REGISTERED) {
  const read = readAgentOverlay(directory);
  return limitsListProps(agentDialogFrom(read.raw, BASE, agentNames, false, read.problem), NO_ASKS, TOKENS);
}

/** The row for one agent, by its host spelling. */
export const row = (list, title) => list.options.find((candidate) => candidate.title === title);

/**
 * Every word a row puts on screen, as the host lays them out.
 *
 * `title` and `description` SHARE the first line — the host renders them into one
 * clipping `<text>` — while `footer` is drawn in a box of its own that never shrinks,
 * and each entry of `details` is a line of its own below. So a fact that is in the
 * dialog somewhere is in one of these, and a fact missing from all of them is
 * genuinely gone from the operator's view.
 */
export const rowText = (list, title) => {
  const found = row(list, title);
  return [[found.title, footerText(found.footer), found.description ?? ""].join(" ").trim(), ...(found.details ?? [])].join("\n");
};

/** The dialog the operator is looking at: the most recent one mounted. */
export const top = (seen) => seen.selects[seen.selects.length - 1];

/** The row titles of a dialog, in the order the host will draw them. */
export const titlesOf = (dialog) => dialog.options.map((option) => option.title);

/**
 * A host with the module booted, and the command it registered.
 *
 * ONE place the module is booted, because booting IS a production interaction and
 * two call sites spelling it out is two places to forget the plugin's own id.
 *
 * The two layers are kept apart deliberately: the command has to be dispatchable
 * while no dialog is up, and the escape binding has to be live only while one is,
 * and the keymap's `enabled` is a LAYER field — so one layer could not be both.
 * Reading the command out of "the first layer" is therefore a claim about an
 * ordering nothing guarantees, so it is read by what the layer actually carries.
 */
export async function booted(directory) {
  const host = hostApi(directory);
  // The host hands the plugin its OWN declared id as meta, so this reads the
  // module's id rather than repeating the string: a test that retyped it would be a
  // second place to change, and the suite already gates on exactly that.
  await tui(host.api, undefined, { id: tuiModule.id });
  const command = host.seen.layers.find((layer) => layer.commands)?.commands[0];
  const escapeLayer = host.seen.layers.find((layer) => layer.bindings);
  assert.ok(command, "the palette command is registered");
  assert.ok(escapeLayer, "and the escape layer that gets the operator out");
  return { ...host, command, escape: escapeLayer.bindings[0], escapeLayer };
}

/** A project directory holding the given overlay, with nothing booted and nothing pressed. */
export const withProject = (fn, { overlay, active = [], retained = [] } = {}) =>
  withTempDir((directory) => {
    if (overlay !== undefined) writeAgentOverlay(directory, overlay);
    if (active.length > 0 || retained.length > 0) {
      // Kept so a case can prove the list does not need it: a ledger-shaped directory
      // that the list opens over without reading is the claim.
      writeFileSync(join(directory, ".dynamic-task-ledger.json"), JSON.stringify({ retained: Object.fromEntries(retained), active: Object.fromEntries(active), pending: [] }));
    }
    return fn(directory);
  });

/** …with the limits list, built from a real overlay and no host in sight. */
export const withList = (overlay, fn, opts) => withProject((directory) => fn(listOver(directory), directory), { overlay, ...opts });

/**
 * …with the module booted and NOTHING pressed, which is the only state in which a
 * gate can be read at all: press the command and every layer this plugin owns is
 * live, so a test that wants to watch one wake up has to start before that.
 */
export const withBooted = (fn, opts) => withProject(async (directory) => fn(await booted(directory), directory), opts);

/**
 * The screen the operator actually sees, with a hand-authored config file in the tree.
 *
 * Every other case in this file builds `agentDialogFrom` over a BASE it supplies, which
 * is why none of them caught this: the reader that decides which numbers are in force is
 * the TUI's, and they all bypassed it. This one writes the file, boots the real module,
 * runs the real command, and asserts on the text the host would draw — so the question
 * "does the screen show what the dispatch path enforces" is asked of the screen.
 */
export const withConfigScreen = (configBody, fn) =>
  withProject(async (directory) => {
    const configPath = join(directory, DYNAMIC_TASK_FILE);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(configBody));
    const host = await booted(directory);
    await host.command.run();
    await settle();
    return fn(host.seen.selects[host.seen.selects.length - 1], directory, host);
  });

/**
 * Let the microtask queue drain.
 *
 * The command's `run` is typed `() => void` — the host does not await it — so every
 * screen this plugin mounts lands in a continuation, and the suite has to yield before
 * it can look at one. A tick COUNT would be a second claim about how many awaits the
 * production path has, and one more await upstream would leave every case here failing
 * on a number rather than on a behaviour. One named yield, everywhere, because the four
 * sites that needed it were four chances to spell it three different ways.
 */
export const settle = () => new Promise((done) => setImmediate(done));

/** …after the command has been pressed and the agent list has resolved. */
export async function openList(host) {
  host.command.run();
  await settle();
}

/** …with the command pressed, which is the only state in which a dialog exists at all. */
export const withOpen = (fn, opts) =>
  withBooted(async (host, directory) => {
    await openList(host);
    assert.equal(host.seen.selects.length, 1, "pressing the command opens the limits list");
    return fn(host, directory);
  }, opts);

/** …over an overlay capping `explore`, which is what most of the sequences below are about. */
export const withExploreOpen = (fn) => withOpen(fn, { overlay: { agents: { explore: { maxConcurrent: 2 } } } });

/**
 * One scenario step, then the case, as a single wrapper.
 *
 * Every scenario below is the same two lines — put something on screen, then hand the
 * case the same arguments — and spelling that shape at each step is duplication the
 * gate is right to refuse. So the shape has a name, and a scenario reads as what it
 * actually does: `given(openPicker, (host) => …)`.
 *
 * BOTH arguments, not curried. It was `given(step)(fn)` and every call site passed
 * only the step, so the case was dropped on the floor: `withPickerOpen(fn)` handed
 * the UNAPPLIED wrapper to `withExploreOpen` as its case, `return fn(host, directory)`
 * returned a function rather than a promise, and the body was never awaited and never
 * ran. Every scenario below it was green because it asserted nothing — including the
 * ones that had a `throw` in them, which is the only reason this was findable at all.
 * A currying helper whose unapplied form is itself a plausible case function is a
 * trap with no type to catch it, and the guard below is what closes it.
 */
export const given = (step, fn) => async (host, directory) => {
  await step(host, directory);
  return fn(host, directory);
};

/** …with one agent's two caps on screen. */
export const withCapsOpen = (fn) => withExploreOpen(given((host) => row(top(host.seen), "explore").onSelect(), fn));

/**
 * …with a value already chosen and the screen landed where the write sent it.
 *
 * A scenario step, named because three cases below start by writing 4 and then assert
 * three different things about the result. Written out, the opening was three copies
 * of the same four lines and the duplication gate was right to call them one code.
 */
export const havingWritten = (step) => (fn) => given(async (host) => {
  await step(host);
}, fn);

/**
 * Press a row by its title, as a scenario step.
 *
 * The shape every screen-opening step here is: find the row, insist it is there, press
 * it. Asserting the row EXISTS is not a formality - a screen that dropped a row makes
 * every step after it fail on `undefined` with a message about the step rather than
 * about the screen, and the suite then reads as though the flow were broken rather than
 * the row having gone.
 */
export const pressRow = (title, why) => (host) => {
  const opened = row(top(host.seen), title);
  assert.ok(opened, why ?? `${title} is on screen, so it is reachable at all`);
  opened.onSelect();
};

/**
 * Press a row on whatever screen is up NOW, and let the screen it opens land.
 *
 * The step for a case that has already written once: a write lands on the list, so the
 * next thing pressed is a row of the list and the screen after THAT is the picker. Two
 * row lookups and two settles per step, spelled out at three sites, is the duplication
 * the gate reads - and one of those sites was pressing a row it never checked was
 * there.
 */
export const pressRowOn = async (host, title) => {
  await pressRow(title)(host);
  await settle();
};

/** …with the value list open on ONE named cap of `explore`. */
export const withPickerOpen = (fn, cap = "maxConcurrent") =>
  withCapsOpen(given((host) => {
    const opened = row(top(host.seen), CAP_LABEL[cap]);
    assert.ok(opened, `${cap} is one of the two rows, so the cap is reachable at all`);
    opened.onSelect();
  }, fn));

/**
 * Choose a value and let the screen land where the write sends it.
 *
 * The two halves are one step, and they were separate at four call sites — which is
 * how a case could press a value and then assert against the screen it had not been
 * replaced on yet, reading green for a write that had not landed yet. The settle is a
 * queue drain rather than a tick count, so it does not become a second claim about how
 * many awaits the production path has.
 */
export const chooseValue = async (host, value) => {
  valueRow(host, value).onSelect();
  await settle();
};

/**
 * The rows on whatever screen is up.
 *
 * The ONE way a case reaches the current dialog's rows. Four finders were each
 * spelling `top(host.seen).options.find(...)`, which is four copies of the question
 * "which screen am I looking at" — and a fifth screen would have been a fifth copy,
 * each free to answer for a different dialog than the one the case meant.
 */
export const rowsOn = (host) => top(host.seen).options;

/** The row with a given title, or undefined. */
export const rowOn = (host, title) => rowsOn(host).find((option) => option.title === title);

/** The value-list row offering `value`. */
export const valueRow = (host, value) => rowOn(host, String(value));
/** The value-list row that clears the cap back to the config file's number. */
export const clearRow = (host) => rowsOn(host).find((option) => /config default/.test(option.title));
/** The caps-screen row for one cap, by its label. */
export const capRow = (host, cap) => rowOn(host, CAP_LABEL[cap]);
/** The caps-screen row's text, for the cell assertions. */
export const capText = (host, cap) => rowText(top(host.seen), CAP_LABEL[cap]);

/**
 * Every row on a drawn screen fits it.
 *
 * The host CLIPS a row's first line rather than wrapping it, so a row that does not
 * fit does not look long — it looks broken, with a fact missing and nothing saying
 * which. The arithmetic lives in `fitsItsDialog`; this is the one way a case says
 * "check this whole screen", so a dialog that grows a row cannot escape the check by
 * being added somewhere that forgot to ask for it.
 */
export const assertEveryRowFits = (dialog) => {
  for (const option of dialog.options) {
    assert.ok(fitsItsDialog(option), `"${option.title}" is clipped: ${JSON.stringify(option)}`);
  }
};
