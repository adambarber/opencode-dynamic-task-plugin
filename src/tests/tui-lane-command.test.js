/**
 * The TUI module's contract with the host.
 *
 * THERE IS NO INVENTED API HERE, and that is the whole design. An earlier version of
 * this file stood up a hand-written `fakeApi` and drove the dialogs through it. That
 * double was free to decide what the host does, and it decided wrong: it called
 * `onClose` the instant a dialog opened, so every dialog looked dismissible and the
 * suite "proved" a way out of each one. So the dialog's CONTENT is not a host
 * interaction at all: `laneViewFrom` is pure, and `laneSelectProps` returns the HOST'S
 * OWN prop type, so the props the host would be handed are an ordinary value this
 * suite can read. Most cases below need no double whatsoever — a real overlay is read
 * by the real reader, turned into the real view, and rendered by the real prop builder.
 *
 * The host's contract is enforced where it is authored, in TypeScript: a field the
 * host never reads is a type error in `src/tui/index.ts` rather than a custom property
 * only a terminal would reveal.
 *
 * Where a SEQUENCE must be driven — the command pressed, a row chosen, an answer
 * typed — the double below stands in for the dialog stack and NOTHING ELSE. It does
 * not model escape, because the HOST owns escape: `replace`'s second argument is a
 * notification that it happened, not the mechanism, which
 * @cortexkit/opencode-magic-context establishes at src/tui/index.tsx:1017 where it
 * passes one and calls it "User dismissed via Escape rather than confirming". A
 * double that modelled a dismiss would be deciding host behaviour again, under a
 * heading where that already cost this suite one false defect and one invented fix.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { createTestKeymap, captureKeymapDiagnostics } from "@opentui/keymap/testing";
import { registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LANE_OVERLAY_FILE, readLaneOverlay, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
import { resolveTaskLedgerPath, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { TaskState } from "../../dist/shared/task-state.js";
import { retainedEntry, runningEntry } from "./support/records.js";
import { DEFAULT_LANE } from "../../dist/shared/config.js";
import { LANE_FIELDS, UNBOUNDED } from "../../dist/tui/lane-editor.js";
import { bothCaps, withTempDir } from "./support/fixtures.js";
import tuiModule, { fitsItsDialog, laneSelectProps, laneViewFrom, LANES_SECTION, LIMITS_SECTION, tui } from "../../dist/tui/index.js";

/** The repo root, so the manifest is read as a file rather than assumed to be cwd. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Nothing asked, for the cases about what a row SAYS rather than what choosing it does. */
const NO_ASKS = { edit: () => {}, cap: () => {}, add: () => {} };

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
function dialogStack() {
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
 * The renderer's selection, which is the whole reason escape needs a second way in.
 *
 * `getSelection` returning an object whose `getSelectedText` is non-empty is what
 * disables the host's own escape binding, so the tests have to be able to put that
 * state in place — and take it away again — rather than assume it.
 */
function rendererDouble() {
  const state = { selection: null };
  return {
    state,
    api: {
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
 * `DialogSelect` and `DialogPrompt` return nothing, and nothing IS a valid
 * `JSX.Element`: Solid's element type is a loose union, so a stand-in that renders
 * nothing satisfies the host's real signature with no cast anywhere. What they hand
 * back is the host's props object, unchanged, so the suite reads the same shape the
 * host would.
 */
function hostApi(directory) {
  const seen = { layers: [], toasts: [], selects: [], prompts: [] };
  const dialog = dialogStack();
  const renderer = rendererDouble();
  return {
    seen,
    mounted: dialog.mounted,
    dialog: dialog.stack,
    renderer: renderer.state,
    api: {
      state: { ready: true, config: {}, provider: [], path: { state: "", config: "", worktree: "", directory }, vcs: undefined },
      keymap: {
        registerLayer: (layer) => {
          seen.layers.push(layer);
          return () => {};
        },
      },
      renderer: renderer.api,
      ui: {
        dialog: dialog.stack,
        DialogSelect: (props) => {
          seen.selects.push(props);
        },
        DialogPrompt: (props) => {
          seen.prompts.push(props);
        },
        toast: (input) => seen.toasts.push(input),
      },
    },
  };
}

/** The overlay as it sits on disk, which is what the dispatch path will read. */
function readOverlay(directory) {
  return JSON.parse(readFileSync(join(directory, LANE_OVERLAY_FILE), "utf8"));
}

/**
 * The lane list the host would be handed, for a directory, with no host in sight.
 *
 * The real reader, the real view, the real props. This is what most cases below use,
 * and it is why they need no double: the props are the value, and nothing between
 * the disk and the assertion is a stand-in.
 */
function listOver(directory) {
  return laneSelectProps(laneViewFrom(readLaneOverlay(directory), directory), NO_ASKS);
}

/** The row for one lane, by name. */
const row = (list, title) => list.options.find((candidate) => candidate.title === title);

/**
 * Every word a row puts on screen, as the host lays them out.
 *
 * `title` and `description` SHARE the first line — the host renders them into one
 * clipping `<text>` — while `footer` is drawn in a box of its own that never shrinks,
 * and each entry of `details` is a line of its own below. So a fact that is in the
 * dialog somewhere is in one of these, and a fact missing from all of them is
 * genuinely gone from the operator's view.
 */
const rowText = (list, title) => {
  const found = row(list, title);
  return [[found.title, found.footer ?? "", found.description ?? ""].join(" ").trim(), ...(found.details ?? [])].join("\n");
};

/** The dialog the operator is looking at: the most recent of either kind. */
const top = (seen) => (seen.prompts.length > seen.selects.length
  ? seen.prompts[seen.prompts.length - 1]
  : seen.selects[seen.selects.length - 1]);

/**
 * The overlay shape most cases below need: a lane named `build`, capped at a
 * concurrency, and at a depth when one is given. Depth is a second argument rather
 * than a second literal at each site, so "a build lane with both caps" is named
 * once and the cases that need it cannot drift apart.
 */
const buildLane = (maxConcurrent, maxDepth) => ({
  lanes: { build: maxDepth === undefined ? { maxConcurrent } : { maxConcurrent, maxDepth } },
});

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
async function booted(directory) {
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

/** A project directory holding the given files, with nothing booted and nothing pressed. */
const withProject = (fn, { overlay, active = [], retained = [] } = {}) =>
  withTempDir((directory) => {
    if (overlay !== undefined) writeLaneOverlay(directory, overlay);
    if (active.length > 0 || retained.length > 0) {
      saveTaskLedger({ retained: new Map(retained), active: new Map(active), pending: [] },
        resolveTaskLedgerPath(directory));
    }
    return fn(directory);
  });

/**
 * The lane list the host would be handed, with no host in sight.
 *
 * The real reader, the real occupancy read, the real view, the real props — which is
 * why these cases need no double: the props ARE the value, and nothing between the
 * disk and the assertion is a stand-in.
 */
const withList = (overlay, fn, opts) => withProject((directory) => fn(listOver(directory), directory), { overlay, ...opts });

/**
 * …with the module booted and NOTHING pressed, which is the only state in which a
 * gate can be read at all: press the command and every layer this plugin owns is
 * live, so a test that wants to watch one wake up has to start before that.
 */
const withBooted = (fn, opts) =>
  withProject(async (directory) => fn(await booted(directory), directory), opts);

/**
 * …with the command pressed, which is the only state in which a dialog exists at all.
 * The host is handed back because the sequences have to choose rows and dismiss.
 */
const withOpen = (fn, opts) =>
  withBooted(async (host, directory) => {
    host.command.run();
    assert.equal(host.seen.selects.length, 1, "pressing the command opens the lane list");
    return fn(host, directory);
  }, opts);

/** …over a build lane capped at 2, which is what most of the sequences below are about. */
const withBuildOpen = (fn) => withOpen(fn, { overlay: buildLane(2) });

/**
 * Answer one field on the form that is ALREADY open.
 *
 * Its own helper rather than a shared "set a cap" one, because a second cap is a
 * second trip through the same screen, not a second visit to the lane list. A helper
 * that guessed which it was in would be a test that could not tell the two flows
 * apart — and that is exactly the flow a stale-row bug hides inside, since a form
 * re-opened from a row the write already invalidated shows the old cap and writes
 * the next one from it.
 */
const answerFieldOn = (host, field, answer) => {
  row(top(host.seen), field).onSelect();
  answerPrompt(host, answer);
};

/** Put a lane's FORM on screen — the second screen every cap change starts and ends on. */
const openFormFor = (host, lane) => row(top(host.seen), lane).onSelect();

/**
 * One scenario step, as a wrapper.
 *
 * Every scenario below is the same three lines — put something on screen, then hand
 * the case the same two arguments the wrapper was given — and spelling that shape at
 * each step is duplication the gate is right to refuse. So the shape has a name, and
 * a scenario reads as what it actually does: `given((host) => openFormFor(host, lane))`.
 */
const given = (step) => (fn) => async (host, directory) => {
  await step(host, directory);
  return fn(host, directory);
};

/** …with the build lane's form already open, which is where most of the cases below want to be. */
const withFormOpen = (fn) => withBuildOpen(given((host) => openFormFor(host, "build")));

/** …with concurrency already set to 4 on the build lane: the state the next three cases start from. */
const withConcurrencySet = (fn) => withFormOpen(given((host) => answerFieldOn(host, CONCURRENCY, "4")));

/**
 * Every row on a drawn screen fits it.
 *
 * The host CLIPS a row's first line rather than wrapping it, so a row that does not
 * fit does not look long — it looks broken, with a fact missing and nothing saying
 * which. The arithmetic lives in `fitsItsDialog`; this is the one way a case says
 * "check this whole screen", so a dialog that grows a row cannot escape the check by
 * being added somewhere that forgot to ask for it.
 */
const assertEveryRowFits = (dialog) => {
  for (const option of dialog.options) {
    assert.ok(fitsItsDialog(option), `"${option.title}" is clipped: ${JSON.stringify(option)}`);
  }
};

/** Answer whatever question is on screen, wherever it was opened from. */
const answerPrompt = (host, answer) => {
  host.seen.prompts[host.seen.prompts.length - 1].onConfirm(answer);
};

/** The field labels the form shows, which are the names an operator reads. */
const CONCURRENCY = LANE_FIELDS.maxConcurrent.label;
const DEPTH = LANE_FIELDS.maxDepth.label;

/** Press the list's own "add a lane" choice, then answer the name prompt. */
const nameNewLane = (host, name) => {
  top(host.seen).options.find((choice) => choice.title.startsWith("Add a lane")).onSelect();
  answerPrompt(host, name);
};

/**
 * The registration, read from the repo's own `tui.json`.
 *
 * The half of the contract that cannot be reached from the module: the host loads TUI
 * modules from `tui.json`, not from opencode's `plugin` array, and there is no
 * directory auto-discovery — so an unregistered module is not degraded, it is never
 * loaded, and it fails silently as an empty command palette. The module can be
 * perfectly shaped and still go nowhere, which is exactly what happened, so the
 * registration is pinned here rather than left to a config file nobody checks.
 */
describe("the TUI module is registered where the host looks for it", () => {
  it("is listed in .opencode/tui.json, and the path resolves to a loadable module", async () => {
    const manifest = JSON.parse(readFileSync(join(REPO, ".opencode", "tui.json"), "utf8"));
    const specs = (manifest.plugin ?? []).map((entry) => (Array.isArray(entry) ? entry[0] : entry));
    assert.ok(specs.length > 0, "an empty tui.json plugin array loads nothing at all");

    // Relative specs resolve against the config file that declared them, so the
    // repo's own manifest can be portable rather than carrying one machine's path.
    const resolved = specs.map((spec) => resolve(REPO, ".opencode", spec));
    for (const file of resolved) {
      assert.ok(existsSync(file), `${file} is listed but absent — the palette entry cannot load`);
    }

    const loaded = await import(pathToFileURL(resolved[0]).href);
    assert.ok(loaded.default?.id, "a listed file plugin must default-export a non-empty id");
    assert.ok(!("server" in loaded.default), "a listed TUI module must not export server alongside tui");
  });
});

describe("the module the host loads", () => {
  it("default-exports a non-empty id, and no server beside it", () => {
    // The loader reads the DEFAULT export and ignores named exports, and a file
    // plugin with no id has no runtime identity to be enabled or rejected against.
    // A module exporting BOTH is refused rather than preferred, so this is the whole
    // of what the loader needs — and none of it is a type error, since a named
    // export typechecks exactly as well.
    assert.ok(tuiModule.id, "a file plugin must export a non-empty id");
    assert.equal(typeof tuiModule.tui, "function");
    assert.ok(!("server" in tuiModule), "a module is server OR tui; a module that is both is refused");
  });
});

describe("the lane command reaches the palette", () => {
  /**
   * One command, so one case.
   *
   * These were three tests, and the gate called the shape a clone — correctly, since
   * `it(<title>, … => assert(… command.<field>` is identical between them once the
   * differing title is a bare token. They are three reads of the SAME command's
   * fields rather than three situations, so the checks belong together; each keeps
   * its own message, so a failure still names which field broke and why the host cares.
   */
  it("is listed in the palette, under the host's field names, findable by \"lanes\"", () =>
    withProject(async (directory) => {
      const { command } = await booted(directory);

      // LISTED. The host surfaces palette commands BY NAMESPACE; without this the
      // command is registered, dispatchable by name and runnable from a keybinding,
      // and appears in no list — an empty ctrl+p with no error anywhere.
      assert.equal(command.namespace, "palette",
        "no namespace means registered but listed nowhere, which is the empty panel");

      // READ. `Command` carries an index signature, so a misspelled field is silently
      // a custom property the palette ignores. The legacy `slash: { name }` form
      // belongs to the deprecated `api.command` API and is never read here.
      assert.equal(command.slashName, "lanes", "the palette's slash spelling is `slashName`");
      assert.ok(command.desc, "the palette's second line is `desc`");
      assert.ok(!("description" in command), "`description` is a custom field the host never reads");
      assert.ok(!("slash" in command), "`slash` is the legacy api.command shape, not a palette field");

      // FOUND. Which fields the palette fuzzy-searches is the host's configuration, so
      // the word is in all three we set rather than in the one we guessed.
      assert.match(command.name, /lanes/);
      assert.match(command.title, /lanes/i);
      assert.match(command.desc, /lanes|caps/i);
    }));
});

/**
 * A list holding one `build` lane with both caps set, handed over in all the shapes
 * the drawing cases read: the list, its row, and that row's rendered text.
 *
 * One fixture because these cases are all about the same row — the one whose name is
 * long enough to sit next to a value — and three of them each spelling out the
 * overlay is the shape the duplicate gate is there to refuse.
 */
const withCapsRow = (fn) =>
  withList(buildLane(2, 3), (list) => fn({ list, row: row(list, "build"), text: rowText(list, "build") }));

/** The cap rows — the two fields the default lane IS in this dialog. */
const capRow = (list, cap) => list.options.find((candidate) => candidate.value?.field?.cap === cap);

describe("the lane list is the question the operator came with", () => {
  it("draws the default lane's caps as its own rows, the lanes you named beside them, and nothing else", () =>
    // The WHOLE screen, in the order the host will draw it, as one assertion. It was
    // five partial ones — a title here, a category there, a value somewhere else —
    // and a screen described in pieces is a screen nobody has read: a row added for
    // a reason nobody recorded would satisfy all five. Read as a list, a row that is
    // not in this shape is a failure.
    //
    // Every string on it has to survive "what does this tell me?". The old screen
    // was titled "Lanes", listed a row called "default", explained itself in "idle ·
    // set in the overlay", and described its add row as "name a lane, then set its
    // caps" — four ways of saying nothing, and the two numbers the operator came for
    // were three interactions away.
    withList({ lanes: { [DEFAULT_LANE]: { maxConcurrent: 1 }, build: bothCaps(2, 3), review: {} } }, (list) => {
      assert.equal(list.title, "How many tasks run at once");
      assert.deepEqual(list.options.map((option) => [option.category, option.title, option.footer ?? null]), [
        [LIMITS_SECTION, CONCURRENCY, "1"],
        [LIMITS_SECTION, DEPTH, UNBOUNDED],
        [LANES_SECTION, "build", "2 at once · depth 3"],
        [LANES_SECTION, "review", "no limits"],
        [LANES_SECTION, "Add a lane", null],
      ]);
    }));

  it("and every row is a distinguishable choice, so a lane named 'add' is still a lane", () =>
    withList({ lanes: { add: { maxConcurrent: 5 } } }, (list) => {
      assert.deepEqual(list.options.map((option) => [option.title, option.value.kind]), [
        [CONCURRENCY, "cap"],
        [DEPTH, "cap"],
        ["add", "lane"],
        ["Add a lane", "add"],
      ]);
    }));

  it("shows no occupancy, because a count read from a file is not a gauge", () =>
    // It showed one, labelled "as last recorded", which is honest and useless: it
    // put a number that may be two dispatches out of date beside the one number the
    // operator could act on, and gave them reason to distrust that. A cap is what
    // this screen is for, and `task_list` is where the running set is read.
    withList(buildLane(1), (list) => {
      assert.doesNotMatch(rowText(list, "build"), /idle|running|recorded/);
    }));

  it("an overlay it cannot read is said out loud AND the list still opens, because repair is why it was opened", () =>
    // Not `withOpen`: the file has to be garbage BEFORE the command reads it, and
    // that is the one thing a fixture that writes a well-formed overlay cannot do.
    withProject(async (directory) => {
      writeFileSync(join(directory, LANE_OVERLAY_FILE), "{ not json", "utf8");
      const host = await booted(directory);
      host.command.run();
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "warning"),
        "the operator is told the file is odd, rather than shown a list that silently omits their lanes");
      assert.equal(host.seen.selects.length, 1, "and the list is open, so they can fix it");
    }));
});

/**
 * A row is drawn as ONE line for the title and description plus a line per detail,
 * and the host CLIPS the first line rather than wrapping it. So a row that does not
 * fit does not look long — it looks broken, with a fact missing and nothing saying
 * which. This is the only place that arithmetic is known, and it is the gate: the
 * report that prompted it was a row whose last clause had been silently cut off on
 * every lane, in a green suite, because nothing anywhere compared the content to
 * the width it was about to be drawn in.
 */
describe("a row fits the dialog it is drawn in", () => {
  const LONG = "deployment-review-queue";

  it("for a long lane name carrying both caps, and for the row beside it", () =>
    withList({ lanes: { [LONG]: bothCaps(12, 7) } }, (list) => {
      assertEveryRowFits(list);
    }));

  it("the caps sit in the cell the host never clips, not in the sentence it does", () =>
    // The budget could also be met by cramming everything back onto one clipped
    // line, which is the shape that was there before. So the CELL is asserted, not
    // just the fit: what the operator compares between lanes is the value, and it
    // has to be in the field the host draws outside the clipping text.
    withCapsRow(({ row: found }) => {
      assert.equal(found.footer, "2 at once · depth 3", "the caps are the value");
      assert.equal(found.description, undefined, "and nothing crowds the line they are on");
    }));

  it("and so do the form's own rows, which are drawn in the same dialog", () =>
    // The form's fields carry their MEANING under them, and that is the longest line
    // this dialog draws anywhere — so the budget has to hold for it too, or the
    // explanation of what a cap is would be the thing that gets cut off.
    withFormOpen((host) => {
      assertEveryRowFits(top(host.seen));
    }));
});

describe("choosing a lane", () => {
  it("opens a FORM — a row per cap, each labelled, each showing the value in force", () =>
    withFormOpen((host) => {
      const form = top(host.seen);
      assert.equal(form.title, "build");
      assert.equal(row(form, CONCURRENCY).footer, "2",
        "the value is ON the row, not in a format string the operator has to decode");
      assert.equal(row(form, DEPTH).footer, UNBOUNDED, "including a cap that is not set");
    }));

  it("says under each field what the cap means and how to lift it, BEFORE asking for one", () =>
    // The complaint this replaces was an operator being handed "1 1" and left to work
    // out the order. So the grammar is stated where it is read, not discovered by
    // getting a refusal.
    withFormOpen((host) => {
      for (const label of [CONCURRENCY, DEPTH]) {
        assert.match(row(top(host.seen), label).details.join(" "), new RegExp(UNBOUNDED),
          `${label} says how to lift its cap, so "${UNBOUNDED}" is not a guess`);
      }
    }));

  it("asks for ONE cap, under the field's own name, with the value in force as the placeholder", () =>
    withFormOpen((host) => {
      row(top(host.seen), CONCURRENCY).onSelect();
      assert.equal(host.seen.prompts[0].title, `Concurrency · build`,
        "the question names the FIELD and the lane, so it says what it is asking for");
      assert.equal(host.seen.prompts[0].placeholder, "2", "so the operator edits a number they can see");
    }));

  it("offers no way to delete a lane that is not on disk yet, because it could only fail", () =>
    // Naming a new lane lands on its form before the lane exists, so the one thing
    // that form must not offer is the removal of something the file does not hold.
    // A row that can only fail teaches the operator that this dialog is careless.
    withOpen((host) => {
      row(host.seen.selects[0], "Add a lane").onSelect();
      answerPrompt(host, "deploy");
      assert.equal(row(top(host.seen), "Delete lane"), undefined,
        "there is no overlay entry to remove, and this dialog does not write the config file");
    }));

  /**
   * The other half of what the operator reported: a confirmation has to leave the
   * operator LOOKING at the answer, not a toast floating over the old number — which
   * is indistinguishable from a confirmation that did nothing.
   *
   * It lands on the form rather than the list, because the form is the only screen
   * that shows both caps at once, and one cap is rarely the whole job.
   */
  it("a confirmed answer comes back to the form showing the new value, not a toast over the old one", () =>
    withConcurrencySet((host) => {
      assert.equal(host.seen.prompts.length, 1, "the question is answered, not stacked");
      const form = top(host.seen);
      assert.equal(form.title, "build", "named after the lane, and nothing else");
      assert.equal(row(form, CONCURRENCY).footer, "4", "showing the cap just typed");
      assert.equal(row(form, DEPTH).footer, UNBOUNDED, "and the other one, untouched");
    }));

  it("setting both fields in turn keeps the first, because the form is re-read after a write", () =>
    // The round trip through the real renderer, not through the unit. The row the
    // second field is answered on has to carry the first field's result, and getting
    // that wrong writes a lane with one cap where two were asked for.
    withConcurrencySet((host, directory) => {
      answerFieldOn(host, DEPTH, "2");
      assert.deepEqual(readOverlay(directory).lanes.build, bothCaps(4, 2),
        "both caps the operator set, and neither clobbered by the other");
    }));

  it("'Back to lanes' returns to the list, showing the cap the form just wrote", () =>
    withConcurrencySet((host) => {
      row(top(host.seen), "Back to lanes").onSelect();
      const list = top(host.seen);
      assert.equal(list.title, "How many tasks run at once");
      assert.equal(row(list, "build").footer, "4 at once",
        "the list and the form draw a cap from one funnel, so they cannot disagree about what it is");
    }));

  it("a bad answer is refused in place, keeping what was typed, and nothing is written", () =>
    withFormOpen((host, directory) => {
      answerFieldOn(host, CONCURRENCY, "nope");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /not a count/.test(toast.message)),
        "the operator is told WHY, not just refused");
      assert.equal(host.seen.prompts.length, 2, "the question is still open — closing would discard the answer");
      assert.deepEqual(readOverlay(directory), buildLane(2), "and the file is untouched");
    }));

  it("a write that fails says so and asks again, rather than reporting a cap that was not applied", () =>
    withFormOpen((host, directory) => {
      // The question is opened FIRST, then the file is broken, then the answer is
      // given: the claim is about the write failing, so the write has to be the
      // step that is refused.
      row(top(host.seen), CONCURRENCY).onSelect();
      rmSync(join(directory, LANE_OVERLAY_FILE));
      mkdirSync(join(directory, LANE_OVERLAY_FILE));
      answerPrompt(host, "4");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /could not write/.test(toast.message)),
        "a refused write must not be confirmed as a cap in force");
      assert.equal(host.seen.prompts.length, 2, "and the question is still open");
    }));
});

/**
 * What this suite now observes for real, having stopped for the escape path: the
 * layer objects below are the module's own, handed to a real @opentui/keymap
 * dispatcher, with the host's own dialog guard registered alongside them. The
 * palette's fuzzy search is still the host's configuration and still unobserved.
 */
export const PALETTE_REMAINS_UNOBSERVED = true;

/**
 * Escape, pressed for real.
 *
 * The module's layers go into an actual @opentui/keymap, and the host's dialog
 * guard is registered with them — `enabled: stack.length > 0 &&
 * !renderer.getSelection()?.getSelectedText()`, transcribed from
 * packages/tui/src/ui/dialog.ts:106 at the tag the running binary was built from.
 * Everything that decides WHICH handler runs — the per-layer `enabled` gate, the
 * priority/order tiebreak, the ambiguity resolver — is the library's own code, so
 * these cases cannot pass by agreeing with a stand-in.
 *
 * The host's layer is registered LAST because that is when the host registers it:
 * the dialog component mounts after the plugin loads. Getting that order backwards
 * would make the module's binding win every tie and quietly take the key from every
 * other plugin's dialog, which is the failure this ordering exists to rule out.
 */
function pressEscapeForReal(host, { selectedText = "" } = {}) {
  const { keymap, host: keys, root } = createTestKeymap({ defaultKeys: true });
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  const diagnostics = captureKeymapDiagnostics(keymap);

  host.renderer.selection = selectedText ? { getSelectedText: () => selectedText } : null;

  let hostClosed = 0;
  const register = (layer) => keymap.registerLayer({ target: root, ...layer });
  for (const layer of host.seen.layers) register(layer);
  register({
    enabled: () => host.dialog.depth > 0 && !host.renderer.selection?.getSelectedText(),
    bindings: [{ key: "escape", desc: "Close dialog", group: "Dialog", cmd: () => { hostClosed++; host.dialog.clear(); } }],
  });

  keys.press("escape");
  return { hostClosed, stillOpen: host.dialog.open, diagnostics };
}

describe("escape gets the operator out of the lane list", () => {
  it("and the HOST's own handler is the one that acts, so the key is not taken from every other dialog", () =>
    withOpen((host) => {
      const { hostClosed, stillOpen, diagnostics } = pressEscapeForReal(host);
      assert.equal(hostClosed, 1, "the host's dialog handler ran, not the plugin's");
      assert.equal(stillOpen, false, "and the list is closed");
      assert.deepEqual([...diagnostics.warnings, ...diagnostics.errors], [],
        "two layers on one key must resolve without an ambiguity warning");
    }));

  it("with text selected — which DISABLES the host's binding — the operator is still not stuck", () =>
    // The defect this exists for. `DialogSelect` is the only widget of ours with a
    // filter input that can hold a text selection, and that selection is exactly
    // what switches the host's escape handler off, leaving the footer — which is
    // reachable only with a mouse — as the sole way out of a keyboard-only dialog.
    // Verified against the dispatcher alone: with the host's binding and no
    // selection it closes, and with a selection it does not fire at all.
    withOpen((host) => {
      const { hostClosed, stillOpen, diagnostics } = pressEscapeForReal(host, { selectedText: "build" });
      assert.equal(hostClosed, 0, "the host's handler is disabled while text is selected — the trap");
      assert.equal(stillOpen, false, "and the list is still closable, which is the whole fix");
      assert.equal(host.renderer.selection, null, "the selection goes with it, as the host's handler would");
      assert.deepEqual([...diagnostics.warnings, ...diagnostics.errors], []);
    }));

  it("the escape layer answers only while a dialog of OURS is up, never for another plugin's", () =>
    // `withBooted`, not `withOpen`: the first assertion is about the gate BEFORE
    // anything of ours is on screen, which is the state `withOpen` has already left.
    withBooted((host) => {
      assert.equal(host.escapeLayer.enabled(), false, "nothing of ours is open, so the layer is inert");
      assert.equal(host.escape.key, "escape", "and it is the key the operator actually presses");

      host.command.run();
      assert.equal(host.escapeLayer.enabled(), true, "the list is up, so escape has to be live");

      // Choosing a row mounts a question OVER the list, and `replace` walks the
      // outgoing entry's onClose — so the gate has to be re-armed by the mount, not
      // left wherever the replaced dialog left it. A CAP row, because that is now
      // what the list offers directly: the default lane's two caps are its own rows.
      capRow(host.seen.selects[0], LANE_FIELDS.maxConcurrent.cap).onSelect();
      assert.equal(host.escapeLayer.enabled(), true, "still live over the prompt, not dropped by the replacement");
    }));

  it("the onClose the funnel passes RECORDS the dismissal; performing one would recurse forever", () =>
    withOpen((host) => {
      const notify = host.dialog.onCloseOf();
      assert.equal(typeof notify, "function", "a notification is passed, so the host can report the dismissal");
      notify();
      assert.equal(host.dialog.open, true, "and it did not close the dialog: `clear` is what calls it");
      assert.equal(host.escapeLayer.enabled(), false, "but it did record that no dialog of ours is up");
    }));
});

describe("adding a lane", () => {
  it("a name that already exists opens that lane rather than making a second one", () =>
    withBuildOpen((host) => {
      nameNewLane(host, "build");
      assert.equal(top(host.seen).title, "build",
        "a name that already exists is that lane, not a new one — the operator meant to edit it");
    }));

  it("a new name opens its form, and the first cap set is what creates the lane", () =>
    withBuildOpen((host, directory) => {
      nameNewLane(host, "deploy");
      assert.equal(top(host.seen).title, "deploy",
        "naming a lane lands on its FORM, not on a box for two numbers in an order");
      answerFieldOn(host, CONCURRENCY, "2");      assert.deepEqual(readOverlay(directory).lanes.deploy, { maxConcurrent: 2 },
        "only the cap that was set, and no depth the operator was never asked about");
    }));

  it("an empty name is not a lane called \"\"", () =>
    withBuildOpen((host) => {
      nameNewLane(host, "   ");
      assert.equal(host.seen.prompts.length, 1, "no caps prompt: there is no lane to set caps on");
    }));
});

describe("removing a lane", () => {
  /**
   * The build lane's form with Delete chosen — the state every case below starts
   * from, named once so the three ways it can be wrong are three ASSERTIONS rather
   * than three copies of a sequence in which a wrong step looks like a right one.
   */
  const withDeleteChosen = (fn, opts) =>
    withOpen((host, directory) => {
      row(host.seen.selects[0], "build").onSelect();
      row(top(host.seen), "Delete lane").onSelect();
      fn(host, directory);
    }, { overlay: buildLane(2), ...opts });

  it("takes only that lane out of the overlay, and says what it did", () =>
    // The removal had no case of its own: the only assertion in the file was that
    // the row is ABSENT for a lane that is not on disk, so the row's presence and
    // its effect were both untested. A row that removes nothing and a row that is
    // not there at all look the same from the list, which is the whole screen.
    //
    // One lane and one survivor in the same file, because "it is gone" and "nothing
    // else went with it" are one claim about a rewrite, and a case per clause would
    // be two ways to pass while the other fails.
    withDeleteChosen((host, directory) => {
      assert.deepEqual(readOverlay(directory).lanes, { review: { maxDepth: 2 } },
        "the lane is gone, and a lane nobody asked about is not collateral of removing it");
      assert.ok(
        host.seen.toasts.some((toast) => toast.variant === "success" && /build/.test(toast.message)),
        "and the operator is told which lane went, rather than watching the list change under them",
      );
    }, { overlay: { lanes: { build: { maxConcurrent: 2 }, review: { maxDepth: 2 } } } }));

  it("and comes back to the list, which is the only screen left to go back to", () =>
    withDeleteChosen((host) => {
      assert.equal(top(host.seen).title, "How many tasks run at once");
    }));
});

describe("the list does not read the ledger", () => {
  it("opens with the ledger unreadable, because it is not on the path that draws it", () =>
    // The claim is an ABSENCE, so it needs a ledger that could not be read if it were
    // read. This used to be a test of the opposite: that a broken ledger still let
    // the list open, because the list was reading one to count occupancy. The count
    // is gone, and with it the read — so the breakage here proves the read is not
    // merely made safe, but absent.
    withProject((directory) => {
      writeLaneOverlay(directory, buildLane(4));
      writeFileSync(resolveTaskLedgerPath(directory), "{ not a ledger", "utf8");
      assert.ok(listOver(directory).options.length > 0, "the list is built, and says nothing about tasks running");
    }));
});
