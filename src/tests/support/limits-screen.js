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
import { AGENT_CAP_NAMES } from "../../../dist/shared/caps.js";
import { normalizeDynamicTaskConfig } from "../../../dist/shared/config.js";
import { agentDialogFrom, CAP_LABEL, displayName, MODEL_LABEL } from "../../../dist/tui/agent-editor.js";
import {DIALOG_WIDTH, dialogRowText, fitsItsDialog} from "../../../dist/tui/geometry.js";
import tuiModule from "../../../dist/tui/index.js";
import { BACK_LABEL, limitsListProps } from "../../../dist/tui/props.js";
import { withTempDir, writeProjectConfig } from "./fixtures.js";
import { overlayChannel } from "./overlay-channel.js";

export { dialogRowText } from '../../../dist/tui/geometry.js';

/**
 * The models this host has, as its own catalog spells them.
 *
 * Rows the picker reads from `ctx.data.location.model.list()`, keyed the way the host
 * keys them — `providerID` and `id` — so a chosen row is the id the dispatch path would
 * accept. `name` is the display name, which is what an operator reads.
 */
const CATALOG = [
  { id: "glm-5.3", name: "GLM 5.3", providerID: "z-ai" },
  { id: "space-bunny-free", name: "Space Bunny", providerID: "opencode" },
];

/** The qualified pair a catalog row maps to, as the picker maps it. */

/** The base config the TUI can see: defaults only, no plugin options. */
export const BASE = normalizeDynamicTaskConfig(null);

/** The agents this project has, as the host would report them. */
export const REGISTERED = ["explore", "general", "review"];

/**
 * A name longer than any real one, because the HOST chooses them.
 *
 * Named rather than written at each site: three cases now reason about the same
 * worst-case length, and a name retyped at each of them is free to drift — which is how
 * a gate ends up checking a length nothing on screen ever has.
 */
export const LONG_AGENT_NAME = "a-very-long-hyphenated-agent-name-indeed";

/**
 * The host, for the cases that genuinely have to press something.
 *
 * A v2 promise double: `dialog.select` records the options and parks a promise, and a
 * press resolves the open one with the row's VALUE. There is no dialog stack to model
 * — the host owns its dialogs and the plugin only ever awaits one question at a time,
 * so the only state here is the one open question and the history of questions asked.
 * `top`/`rowsOn` read the history; `pressRow`/`choose` answer the open question.
 *
 * It is PARTIAL by the same right the old one was: it carries what production reads
 * (location, data, keymap, ui) and nothing else. A case that needs more is a case
 * about a production read this double does not model, and it should fail loudly here
 * rather than pass against a fuller fiction. In particular there is no `client.agent`:
 * the TUI runtime client has no `agent` namespace, and a double that answers
 * `client.agent.list()` proves a reader the host cannot run.
 */
function hostApi(directory, { agents = REGISTERED, channel, models = CATALOG } = {}) {
  const seen = { layers: [], selects: [], slots: [], toasts: [] };
  const pending = [];
  return {
    api: {
      // The caps channel, with the server's half really behind it. Absent by default so
      // a case that does not care pays nothing for it.
      client: channel?.client ?? { rpc: () => ({}) },
      location: { directory },
      // The row set is the HOST's registered agents, and the model catalog is the HOST'S
      // registered models, both read the way its own screens read them: the data store's
      // per-location collection, synchronously. The catalog rows carry the fields the
      // host's `ModelInfo` declares, because the picker maps `providerID` and `id` — a
      // double that omitted either would map `undefined` and the screen would offer
      // `undefined/undefined` to the operator.
      data: {
        location: {
          agent: {
            list: () => agents.map((name) => ({ mode: "subagent", name, permissions: [] })),
          },
          model: {
            list: () => models.map((entry) => ({ ...entry, compatibility: undefined, enabled: true, family: undefined, id: entry.id, name: entry.name, providerID: entry.providerID })),
          },
        },
      },
      keymap: {
        layer: (build) => {
          seen.layers.push(build());
          return () => {};
        },
      },
      ui: {
        dialog: {
          select: (options) => {
            seen.selects.push(options);
            return new Promise((resolve) => pending.push({ options, resolve }));
          },
        },
        toast: { show: (input) => seen.toasts.push(input) },
        // The palette entry lives in a render the HOST calls, inside its own tree —
        // so this records the claim and the boot below performs it, the way a mount
        // would. A slot the host never draws is a command that never appears.
        slot: (claim) => {
          seen.slots.push(claim);
          return () => {};
        },
      },
    },
    pending,
    seen,
  };
}

/** The caps in force for this project, read the way the dialog reads them. */
export const readOverlay = async (directory) => {
  const overlay = await overlayChannel(directory, BASE).read();
  return overlay.caps;
};

/** The overlay as the operator stated it, through the channel rather than the table. */
async function withCaps(directory, overlay, hostHooks) {
  const channel = overlayChannel(directory, BASE, { host: hostHooks });
  if (overlay !== undefined) await channel.seed(overlay);
  return channel;
}

/**
 * The dialog's content, as the host's own props, with no host in sight.
 *
 * The real reader, the real view, the real prop builders. This is what most cases
 * below use, and it is why they need no double: the props ARE the value, and nothing
 * between the disk and the assertion is a stand-in.
 */
async function listOver(directory, agentNames = REGISTERED) {
  const read = await overlayChannel(directory, BASE).read();
  const dialog = agentDialogFrom(read.caps, BASE, agentNames, false, read.problem);
  return limitsListProps(dialog);
}



/**
 * The row for a thing, by the spelling the OPERATOR gives it — not by the spelling on
 * screen.
 *
 * A case says `row(list, "explore")` and means the agent the host published, whatever the
 * screen chose to PRINT. A list row now prints `Explore:`, so a finder that matched
 * `option.title` exactly found nothing and every case about an agent failed for the same
 * uninteresting reason, thirty times over. Matching is by SHAPE — the exact title, or the
 * capitalised title, or either with the row's colon — so the screen's presentation can
 * change without a case having to learn the change, which is the whole point of a case
 * being about behaviour.
 */
export const row = (list, name) => {
  const titled = (candidate) => candidate.title === name || candidate.title === `${displayName(name)}:` || candidate.title === displayName(name);
  const found = list.options.find(titled);
  if (found) return found;
  return list.options.find((candidate) => candidate.title.startsWith(displayName(name)));
};

/**
 * One agent's entry, as the screen holds it, from the production reader.
 *
 * `capPickerProps` takes an `AgentEntry` and not a number, because the picker needs the
 * entry's depth BINDING as well as the value in force — it has to answer "is this value
 * reachable" about values the cap is not set to. A test that handed it a bare number
 * would be exercising a builder the screen never calls, and the note would never have
 * been proved against the data it claims to read.
 */
export function agentEntry(agent, raw = {}, agentNames = REGISTERED) {
  return agentDialogFrom(raw, BASE, agentNames, false, null).rows.find((candidate) => candidate.name === agent);
}

/**
 * Every word a row puts on screen, as the host lays them out.
 *
 * `title` and `description` SHARE the one line — the host renders them into a single
 * clipping `<text>`, a `flexGrow={1}` box with `overflow="hidden"` and `wrapMode="none"`
 * — so a row is one string and that string is what the terminal shows or clips. A fact
 * that is in the dialog somewhere is in that string; a fact missing from it is genuinely
 * gone from the operator's view.
 */
export const rowText = (list, name) => {
  const found = row(list, name);
  return [[found.title, found.description ?? ""].join(" ").trim()].join("\n");
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
 * `setup` only CLAIMS the slot; the layer is registered when the host performs the
 * render, so this performs it — a command asserted without its render is a command
 * the palette never saw. The command has to be dispatchable while no dialog is up,
 * and the host owns every key the plugin must not take.
 */
export async function booted(directory, opts) {
  const host = hostApi(directory, opts);
  tuiModule.setup(host.api);
  const app = host.seen.slots.find((slot) => slot.append === "app");
  assert.ok(app, "the palette command is mounted where the host draws every screen");
  app.render({});
  const command = host.seen.layers.find((layer) => layer.commands)?.commands[0];
  assert.ok(command, "the palette command is registered");
  // Every binding the plugin owns, as the keymap would see them. Not a specific
  // layer: the property under test is that NO binding of ours is on a key the host
  // needs, which a per-layer lookup cannot express.
  const bindings = host.seen.layers.flatMap((layer) => layer.bindings ?? []);
  return { ...host, bindings, command };
}

/** A project directory holding the given overlay, with nothing booted and nothing pressed. */
export const withProject = (fn, { overlay, ...rest } = {}) =>
  withTempDir(async (directory) => {
    const channel = await withCaps(directory, overlay, rest.host);
    return fn(directory, channel);
  });

/** …with the limits list, built from a real overlay and no host in sight. */
export const withList = (overlay, fn, opts) =>
  withProject(async (directory) => fn(await listOver(directory, opts?.agentNames), directory), { overlay, ...opts });

/**
 * …with the module booted and NOTHING pressed, which is the only state in which a
 * gate can be read at all: press the command and every layer this plugin owns is
 * live, so a test that wants to watch one wake up has to start before that.
 */
export const withBooted = (fn, opts) =>
  withProject(async (directory, channel) => fn(await booted(directory, { ...opts, channel }), directory, channel), opts);

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
  withProject(async (directory, channel) => {
    writeProjectConfig(directory, configBody);
    const host = await booted(directory, { channel });
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

/**
 * One yield of the event loop, so a screen the host drew has actually been drawn
 * before the case reads it. Every renderer involved is synchronous, so this is the
 * same as production's single-threaded ordering with one more await — without it a
 * case asserts against a screen that exists, but not yet, which is a flake and not a
 * behaviour. One named yield, everywhere, because the four sites that needed it
 * were four chances to spell it three different ways.
 */
const settle = () => new Promise((done) => setImmediate(done));

/** How long a case waits for a screen the host has not drawn yet. A bound, not a claim. */
const SCREEN_TICKS = 50;

/** …after the command has been pressed and the caps screen has landed. */
export async function openList(host) {
  host.command.run();
  // Waiting for the DIALOG rather than for a yield: the caps it draws come back over
  // the channel, so a fixed tick passed once by luck and failed the next time one await
  // was added upstream.
  for (let left = SCREEN_TICKS; left > 0 && host.seen.selects.length === 0; left -= 1) await settle();
  assert.ok(host.seen.selects.length > 0, "the command mounted no dialog — the caps read never answered");
}

/** …with the command pressed, which is the only state in which a dialog exists at all. */
export const withOpen = (fn, opts) =>
  withBooted(async (host, directory, channel) => {
    await openList(host);
    assert.equal(host.seen.selects.length, 1, "pressing the command opens the limits list");
    return fn(host, directory, channel);
  }, opts);


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
export const given = (step, fn) => async (host, directory, channel) => {
  await step(host, directory);
  return fn(host, directory, channel);
};

/** …with one agent's two caps on screen. */
export const withCapsOpen = (fn, overlay = { agents: { explore: { maxConcurrent: 2 } } }) =>
  withOpen(given(pressRow("explore"), fn), { overlay });

/**
 * A depth cap stated ABOVE the agent set, which is the only state in which the set binds
 * and the cap becomes a number the operator can type that will not take effect.
 *
 * A constant rather than a scenario, because only the file differs and the reaching is
 * `withPickerOpen`'s: a scenario of its own would re-spell the two row presses and be a
 * second path to the same screen, free to drift from the first.
 */
export const BOUND_DEPTH = { agents: { explore: { maxConcurrent: 2, maxDepth: 4 } } };

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
 * Answer the open question with a row's VALUE.
 *
 * The ONE press in the whole harness: every row carries a choice value and the flow
 * switches on what `select` resolves with, so pressing IS resolving. Asserting the
 * option EXISTS is not a formality — a screen that dropped a row makes every step
 * after it fail on `undefined` with a message about the step rather than about the
 * screen, and the suite then reads as though the flow were broken rather than the
 * row having gone. Asserting a question is OPEN is the same half: a press with no
 * dialog up resolves nothing and hangs the flow's next screen, so it fails HERE with
 * the press named rather than later with a screen missing.
 */
export const choose = async (host, option, what = "the row") => {
  assert.ok(option, `${what} is on screen, so it is reachable at all`);
  const question = host.pending.pop();
  assert.ok(question, `a dialog is open to press ${what} on`);
  question.resolve(option.value);
  await settle();
};

/**
 * Press a row by its title, as a scenario step.
 *
 * The shape every screen-opening step here is: find the row, insist it is there, press
 * it. A screen that dropped a row makes every step after it fail on `undefined` with
 * a message about the step rather than about the screen, and the suite then reads as
 * though the flow were broken rather than the row having gone.
 */
export const pressRow = (title, why) => async (host) => {
  await choose(host, row(top(host.seen), title), why ?? title);
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
export const withPickerOpen = (fn, cap = "maxConcurrent", overlay = { agents: { explore: { maxConcurrent: 2 } } }) =>
  withCapsOpen(given(async (host) => {
    // By the cap's label, which is the row's FIRST WORD rather than its whole title: the
    // caps screen carries the value in the title now (`at once 2`), so matching the whole
    // string would re-report this screen as broken every time a cap changed shape. The
    // label is the part that says WHICH cap, and it is the part worth pinning.
    const opened = rowsOn(host).find((option) => option.title === CAP_LABEL[cap] || option.title.startsWith(`${CAP_LABEL[cap]} `));
    await choose(host, opened, `${cap} is one of the two rows, so the cap is reachable at all`);
  }, fn), overlay);

/**
 * …with the value picker open and a claim made about EVERY row on it.
 *
 * The shape of a screen-level claim, which is the third time two cases have opened the
 * same picker only to say something about all its rows. It is a scenario rather than
 * two call sites because those two differ only in their predicate and their message —
 * one sentence with a different verb in it, which the gate reads as shared code and
 * which a reader has to diff to see is not.
 */
export const withPickerClaimed = (about, why, cap = "maxConcurrent") =>
  withPickerOpen((host) => everyRowClaims(rowsOn(host), about, why), cap);

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
  await choose(host, valueRow(host, value), String(value));
};

/**
 * Press the picker's way out and land one level up.
 *
 * Two cases press Back off a value picker and both need the landing screen named, so
 * the pair is one step: the press, and the proof it went up one level rather than out
 * to the list. The message stays the caller's, because the two cases press Back for
 * different reasons and a shared message would say neither.
 */
export const backToCaps = async (host, agent, why) => {
  await choose(host, backRow(host));
  assert.equal(top(host.seen).title, agent, why);
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

/**
 * Every row of a drawn screen as the TERMINAL will show it: the title and its description
 * on one line, the way the host renders them into a single clipping `<text>`.
 *
 * The pairs that have to be read together. A screen whose figures sit in `description`
 * and whose assertions read `option.title` see only the label, so a case can pass while
 * the row says nothing at all — which is what happened to the caps screen for a round.
 */
const rowsText = (dialog) => dialog.options.map((option) => rowText(dialog, option.title));

/** The row with a given title, or undefined. */
const rowOn = (host, title) => rowsOn(host).find((option) => option.title === title);

/** The value-list row offering `value`. */
export const valueRow = (host, value) => rowOn(host, String(value));
/**
 * The way out of a picker.
 *
 * By the label PRODUCTION spells it, so a rewording is one test to update rather than
 * every case in both suites — and the discovery is the invariant that would otherwise
 * have to be enforced by reading every test. It is imported rather than restated for
 * the reason `clearRow` finds the fallback row by shape: the finder is a collaborator
 * with the screen, and a collaborator that also guesses the screen's wording reports a
 * broken screen when nothing is broken.
 */
/**
 * The row that leaves the screen underfoot, by its label.
 *
 * The label is a parameter because there are two of them and neither is a mistake: a
 * picker says `Back` (the action) and the caps screen says `All agents` (where the press
 * lands). A finder that guessed the wording would report a broken screen the moment one
 * of them was reworded, so the caller says which screen it is standing on.
 */
export const backRow = (host, label = BACK_LABEL) => rowOn(host, label);
/** The value-list row that clears the cap back to the config file's number. */
export const clearRow = (host) => rowsOn(host).find((option) => /config default/.test(option.title));
/** The caps-screen row for one cap, by its label. */
/**
 * A cap's row on the agent's screen, by the cap's LABEL.
 *
 * The label is the row's first word rather than its whole title, because the caps screen
 * carries each figure in the title now (`at once 2`). Matching the whole string would
 * re-report this screen as broken every time a cap changed shape; the label is the part
 * that says WHICH cap, and that is the part worth pinning.
 */
export const capRow = (host, cap) => rowsOn(host).find((option) => option.title === CAP_LABEL[cap] || option.title.startsWith(`${CAP_LABEL[cap]} `));
/** The caps-screen row's text, for the cell assertions. */
export const capText = (host, cap) => {
  const found = capRow(host, cap);
  assert.ok(found, `${cap} is a row on the screen underfoot`);
  return rowText(top(host.seen), found.title);
};

/**
 * The cap rows of a drawn screen, in draw order, minus the way out.
 *
 * Two cases claim the same thing about the caps screen — that both caps are there,
 * labelled, each with its figure — from two different angles: one is about the EXIT being
 * last and needs the rows above it to be only the caps, the other is about the hole the
 * flow found and needs both caps individually pressable. Spelled twice it is one fact
 * restated at two sites, which is the defect the harness exists to prevent.
 */
const capRowsAsDrawn = (dialog) => rowsText(dialog).slice(0, -1);

/**
 * The drawn screen carries both caps, in order, each labelled and each with a figure.
 *
 * The label is pinned literally; the FIGURE is checked for presence, never recomposed.
 * Building the expected text from `CAP_LABEL` and `capCellOf` compares production against
 * production — if `capCellOf` lost the number, both sides would lose it and the case would
 * pass on a row saying nothing at all. That is exactly what `rowsText` exists to catch.
 */
export const assertCapsDrawn = (dialog, why) => {
  const drawn = capRowsAsDrawn(dialog);
  // The model is on this screen too, and it is a row rather than a cap: one row per cap,
  // one for the agent's own model, and the way out. Asserting over the caps alone would
  // pass while the model row was missing, which is the half of the screen nobody would
  // be able to reach.
  assert.equal(drawn.length, AGENT_CAP_NAMES.length + 1, `${why}: one row per cap, the agent's model, and the way out — nothing else`);
  AGENT_CAP_NAMES.forEach((cap, index) => {
    const label = CAP_LABEL[cap];
    assert.ok(drawn[index].startsWith(`${label} `), `${why}: row ${index} is ${cap}, and reads "${drawn[index]}"`);
    assert.notEqual(drawn[index].slice(label.length).trim(), "", `${why}: ${cap} carries its figure, not just its name`);
  });
  assert.ok(drawn[AGENT_CAP_NAMES.length].startsWith(`${MODEL_LABEL} `), `${why}: the agent's model is a row, and reads "${drawn[AGENT_CAP_NAMES.length]}"`);
  assert.notEqual(drawn[AGENT_CAP_NAMES.length].slice(MODEL_LABEL.length).trim(), "", `${why}: the model row carries its value, not just its name`);
};

/**
 * Every row on a drawn screen fits it.
 *
 * The host CLIPS a row's first line rather than wrapping it, so a row that does not
 * fit does not look long — it looks broken, with a fact missing and nothing saying
 * which. The arithmetic lives in `fitsItsDialog`; this is the one way a case says
 * "check this whole screen", so a dialog that grows a row cannot escape the check by
 * being added somewhere that forgot to ask for it.
 */
export const assertEveryRowFits = (dialog, width = DIALOG_WIDTH) =>
  assertRows(
    dialog.options.map((option) => ({ option })),
    ({ option }) => fitsItsDialog(option, width),
    ({ option }) => `"${option.title}" is clipped: ${option.title.length} of title + ${(option.description ?? "").length} of description, over a row of ${dialogRowText(width)}`,
  );

/**
 * Every one of `options` satisfies a claim the case is making about a whole screen.
 *
 * The other half of `assertEveryRowFits`, for a claim that is not about width. Three
 * cases were each writing `rowsOn(host).every(...)` over a different predicate, which is
 * one sentence with a different verb in it — the gate reads that as shared code and so
 * does a reader, and both are right. Naming the row that fails is the part worth having:
 * "no value is out of reach" is a claim about a list, and a list that breaks it is best
 * reported by the element that does.
 */
export const everyRowClaims = (options, about, why) => assertRows(options, about, () => why);

/** The one loop both screen-level claims are written on. */
function assertRows(rows, about, why) {
  for (const entry of rows) assert.ok(about(entry), why(entry));
}
