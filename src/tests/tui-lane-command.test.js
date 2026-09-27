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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LANE_OVERLAY_FILE, readLaneOverlay, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
import { resolveTaskLedgerPath, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { TaskState } from "../../dist/shared/task-state.js";
import { retainedEntry, runningEntry } from "./support/records.js";
import { DEFAULT_LANE } from "../../dist/shared/config.js";
import { withTempDir } from "./support/fixtures.js";
import tuiModule, { laneSelectProps, laneViewFrom, runningByLane, tui } from "../../dist/tui/index.js";

/** The repo root, so the manifest is read as a file rather than assumed to be cwd. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Nothing asked, for the cases about what a row SAYS rather than what choosing it does. */
const NO_ASKS = { caps: () => {}, add: () => {} };

/**
 * The dialog stack, as the host declares it.
 *
 * `replace` mounts a dialog and nothing else happens: the host owns ESC, so a
 * double that "handles" a dismiss would be deciding the host's behaviour — which is
 * exactly what the earlier double did when it ran the dismiss handler at mount time.
 * This one records only what was mounted, and `clear` is a real host call because
 * the widgets make it, not a stand-in for ESC.
 */
function dialogStack() {
  const mounted = [];
  return {
    stack: {
      replace: (render) => {
        mounted.push(render());
      },
      clear: () => {
        mounted.length = 0;
      },
      setSize: () => {},
      size: "medium",
      depth: 1,
      open: true,
    },
    mounted,
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
  return {
    seen,
    mounted: dialog.mounted,
    api: {
      state: { ready: true, config: {}, provider: [], path: { state: "", config: "", worktree: "", directory }, vcs: undefined },
      keymap: {
        registerLayer: (layer) => {
          seen.layers.push(layer);
          return () => {};
        },
      },
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
 * The real reader, the real occupancy read, the real view, the real props. This is
 * what most cases below use, and it is why they need no double: the props are the
 * value, and nothing between the disk and the assertion is a stand-in.
 */
function listOver(directory) {
  return laneSelectProps(laneViewFrom(readLaneOverlay(directory), runningByLane(directory), directory), NO_ASKS);
}

/** The row for one lane, by name. */
const row = (list, title) => list.options.find((candidate) => candidate.title === title);

/** The dialog the operator is looking at: the most recent of either kind. */
const top = (seen) => (seen.prompts.length > seen.selects.length
  ? seen.prompts[seen.prompts.length - 1]
  : seen.selects[seen.selects.length - 1]);

/** The overlay shape most cases below need: a lane capped at concurrency only. */
const buildLane = (maxConcurrent) => ({ lanes: { build: { maxConcurrent } } });

/**
 * A host with the module booted, and the command it registered.
 *
 * ONE place the module is booted, because booting IS a production interaction and
 * two call sites spelling it out is two places to forget the plugin's own id, or to
 * stop asserting there is exactly one layer.
 */
async function booted(directory) {
  const host = hostApi(directory);
  // The host hands the plugin its OWN declared id as meta, so this reads the
  // module's id rather than repeating the string: a test that retyped it would be a
  // second place to change, and the suite already gates on exactly that.
  await tui(host.api, undefined, { id: tuiModule.id });
  assert.equal(host.seen.layers.length, 1, "one layer, so the palette has one entry to find");
  return { ...host, command: host.seen.layers[0].commands[0] };
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
 * …with the command pressed, which is the only state in which a dialog exists at all.
 * The host is handed back because the sequences have to choose rows and dismiss.
 */
const withOpen = (fn, opts) =>
  withProject(async (directory) => {
    const host = await booted(directory);
    host.command.run();
    assert.equal(host.seen.selects.length, 1, "pressing the command opens the lane list");
    return fn(host, directory);
  }, opts);

/** …over a build lane capped at 2, which is what most of the sequences below are about. */
const withBuildOpen = (fn) => withOpen(fn, { overlay: buildLane(2) });

/**
 * Select a lane and answer its caps prompt.
 *
 * The dialog's one interaction, which several cases each spelled out as "find the
 * row, call onSelect, answer the latest prompt" and none of them was actually about:
 * they were about what happens to the answer.
 */
const answerCapsFor = (host, lane, answer) => {
  row(top(host.seen), lane).onSelect();
  host.seen.prompts[host.seen.prompts.length - 1].onConfirm(answer);
};

/** Press the list's own "add a lane" choice, then answer the name prompt. */
const nameNewLane = (host, name) => {
  top(host.seen).options.find((choice) => choice.title.startsWith("Add a lane")).onSelect();
  host.seen.prompts[host.seen.prompts.length - 1].onConfirm(name);
};

/** Answer whatever question is on top, which after naming is the new lane's caps. */
const answerLatest = (host, answer) => host.seen.prompts[host.seen.prompts.length - 1].onConfirm(answer);

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

describe("the lane list says what it is showing", () => {
  it("names each lane's caps and where they came from, so the operator knows what they are editing", () =>
    // Not the plain build lane: this is the one case with a depth cap as well.
    withList({ lanes: { build: { maxConcurrent: 2, maxDepth: 3 } } }, (list) => {
      assert.equal(list.title, "Lanes");
      assert.match(row(list, "build").description, /2 concurrent · depth 3/);
      assert.match(row(list, "build").description, /set in the overlay/);
    }));

  it("does not let an inherited cap read as one this dialog set", () =>
    withList(undefined, (list) => {
      assert.match(row(list, DEFAULT_LANE).description, /caps from the config file/);
    }));

  it("says the occupancy is as last recorded, because it is a file read and not a live gauge", () =>
    withList(buildLane(1), (list) => {
      assert.match(row(list, "build").description, /idle/);
    }));

  it("offers a way to add a lane, as its own choice rather than a name nobody would pick", () =>
    withList(undefined, (list) => {
      const add = row(list, "Add a lane…");
      assert.ok(add, "adding a lane is a distinguishable choice, not a magic lane name");
      assert.equal(add.value.kind, "add", "and a discriminated one, so a lane called 'add' is still a lane");
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

describe("choosing a lane", () => {
  it("offers a prompt whose placeholder is the caps the list just showed", () =>
    withOpen((host) => {
      const described = row(host.seen.selects[0], DEFAULT_LANE).description;
      row(host.seen.selects[0], DEFAULT_LANE).onSelect();
      const [concurrency, depth] = host.seen.prompts[0].placeholder.split(" ");
      assert.equal(concurrency, described.split(" ")[0], "the operator edits the concurrency they can see");
      assert.equal(depth, described.split(" · ")[1].split(" ")[1], "and the depth");
    }));

  /**
   * The other half of what the operator reported: confirming an answer has to leave
   * the operator looking at the LIST, showing the answer they just gave.
   *
   * A confirmation that does not visibly change the thing it confirmed is
   * indistinguishable from a confirmation that did nothing, and a toast floating over
   * the old number is exactly that. So the sequence is asserted, not just the write.
   */
  it("a confirmed answer comes back as a list showing the new caps, not a toast over the old one", () =>
    withBuildOpen((host) => {
      answerCapsFor(host, "build", "4 3");
      assert.equal(host.seen.prompts.length, 1, "the question is answered, not stacked");
      const shown = top(host.seen);
      assert.equal(shown.title, "Lanes", "the operator is back on the list");
      assert.match(row(shown, "build").description, /4 concurrent · depth 3/,
        "showing the caps just typed — a toast over the old number reads as nothing happening");
    }));

  it("a bad answer is refused in place, keeping what was typed, and nothing is written", () =>
    withBuildOpen((host, directory) => {
      answerCapsFor(host, "build", "nope");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /not a count/.test(toast.message)),
        "the operator is told WHY, not just refused");
      assert.equal(host.seen.prompts.length, 2, "the question is still open — closing would discard the answer");
      assert.deepEqual(readOverlay(directory), buildLane(2), "and the file is untouched");
    }));

  it("a write that fails says so and asks again, rather than reporting a cap that was not applied", () =>
    withBuildOpen((host, directory) => {
      // The prompt is opened FIRST, then the file is broken, then the answer is
      // given: the claim is about the write failing, so the write has to be the
      // step that is refused.
      row(host.seen.selects[0], "build").onSelect();
      rmSync(join(directory, LANE_OVERLAY_FILE));
      mkdirSync(join(directory, LANE_OVERLAY_FILE));
      host.seen.prompts[0].onConfirm("4");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /could not write/.test(toast.message)),
        "a refused write must not be confirmed as a cap in force");
      assert.equal(host.seen.prompts.length, 2, "and the question is still open");
    }));
});

/**
 * What this suite still cannot prove, said out loud rather than left implicit:
 * that the host's palette fuzzy-matches the fields we set. That is the host's
 * search configuration, not ours. What the suite does establish is that the
 * command is NAMESPACED to the palette, uses the host's field spellings, and
 * carries the word in every field we set — so ctrl+p and then "lanes" is the
 * one thing left to press.
 */
export const PALETTE_REMAINS_UNOBSERVED = true;

describe("adding a lane", () => {
  it("a name that already exists opens that lane rather than making a second one", () =>
    withBuildOpen((host) => {
      nameNewLane(host, "build");
      assert.equal(top(host.seen).title, "Lanes · build",
        "a name that already exists is that lane, not a new one — the operator meant to edit it");
    }));

  it("a new name becomes a lane with the caps that get typed", () =>
    withBuildOpen((host, directory) => {
      nameNewLane(host, "deploy");
      answerLatest(host, "2 1");
      assert.deepEqual(readOverlay(directory).lanes.deploy, { maxConcurrent: 2, maxDepth: 1 });
    }));

  it("an empty name is not a lane called \"\"", () =>
    withBuildOpen((host) => {
      nameNewLane(host, "   ");
      assert.equal(host.seen.prompts.length, 1, "no caps prompt: there is no lane to set caps on");
    }));
});

describe("occupancy is read, not assumed", () => {
  it("counts the running tasks charged to each lane, and only the running ones", () =>
    withList(buildLane(4), (list) => {
      assert.match(row(list, "build").description, /1 running, as last recorded/);
    }, { active: [["ses_r", runningEntry("ses_r", { lane: "build" })]] }));

  it("a settled task in the same lane is not occupancy — it is history, not a slot in use", () =>
    withList(buildLane(4), (list) => {
      assert.match(row(list, "build").description, /idle/);
    }, {
      retained: [["ses_d", retainedEntry({ childSessionId: "ses_d", lane: "build", state: TaskState.Completed })]],
    }));

  it("a ledger that cannot be read leaves the list open, because a count is not worth a closed dialog", () =>
    // NOT `withList`: the ledger has to be broken BEFORE the list is read, or the
    // assertion is about a good ledger and proves nothing. The one case whose
    // premise is the order of two reads, so it says so by doing the reads itself.
    withProject((directory) => {
      writeLaneOverlay(directory, buildLane(4));
      // Written as garbage rather than through the helper, because the claim is
      // about a file the reader cannot parse.
      writeFileSync(resolveTaskLedgerPath(directory), "{ not a ledger", "utf8");
      assert.match(row(listOver(directory), "build").description, /idle/);
    }));
});
