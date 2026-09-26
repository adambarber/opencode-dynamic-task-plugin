/**
 * The TUI module's wiring, driven by a fake api.
 *
 * "It compiles" is not "it loads", and the whole point of this module is a
 * keypress sequence the operator will try in a terminal. So the command is
 * registered for real, dispatched for real, and the dialogs it asks for are
 * recorded — which is as far as a test goes without a terminal, and it catches
 * the failure that matters here: a command that never reaches the palette, or a
 * dialog that renders the wrong tree.
 *
 * What this CANNOT prove, and the last test says so out loud: that the host's
 * palette fuzzy-matches the fields we set. That is the host's search
 * configuration, not ours. The honest position is that the word is in both the
 * name and the title so any reasonable field set lands on this entry, and that
 * pressing ctrl+p is still how the claim gets settled.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_OVERLAY_FILE, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
import { resolveTaskLedgerPath, saveTaskLedger } from "../../dist/shared/session-lifecycle.js";
import { TaskState } from "../../dist/shared/task-state.js";
import { retainedEntry, runningEntry } from "./support/records.js";
import { DEFAULT_LANE } from "../../dist/shared/config.js";
import { UNBOUNDED } from "../../dist/tui/lane-editor.js";
import { withTempDir } from "./support/fixtures.js";
import { tui } from "../../dist/tui/index.js";

/**
 * A minimal api that records what was asked for.
 *
 * Deliberately not a mock of the SDK's behaviour: it answers the five things this
 * module calls, and nothing else exists on it, so a new call site fails here
 * instead of passing silently, and a dialog rendered from a field nobody provided
 * shows up as undefined rather than as a blank row on a real screen.
 */
function fakeApi(directory) {
  const seen = { layers: [], toasts: [], prompts: [], selects: [], disposed: [] };
  const api = {
    state: { path: { directory } },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn) => {
        seen.disposed.push(fn);
        return () => {};
      },
    },
    keymap: {
      registerLayer: (layer) => {
        seen.layers.push(layer);
        return () => {};
      },
    },
    ui: {
      dialog: {
        replace: (render, onClose) => {
          render();
          if (onClose !== undefined) onClose();
        },
        clear: () => {},
      },
      DialogSelect: (props) => {
        seen.selects.push(props);
        return "select";
      },
      DialogPrompt: (props) => {
        seen.prompts.push(props);
        return "prompt";
      },
      toast: (input) => seen.toasts.push(input),
    },
  };
  return { api, seen };
}

/** The overlay as it sits on disk, which is what the dispatch path will read. */
function readOverlay(directory) {
  return JSON.parse(readFileSync(join(directory, LANE_OVERLAY_FILE), "utf8"));
}

/** Boot the module and hand back what it registered, without pressing anything. */
async function registered(directory) {
  const { api, seen } = fakeApi(directory);
  await tui(api, undefined, { id: "dynamic-task" });
  assert.equal(seen.layers.length, 1, "one layer, so the palette has one entry to find");
  return { api, seen, command: seen.layers[0].commands[0] };
}

/**
 * A project directory holding these files, with the lanes dialog open over it.
 *
 * Every case below is the same four steps — a directory holding an overlay, the
 * command, a row in the resulting list — and spelling that out per case is how two
 * of them end up asserting against a file a different case wrote. The files are
 * the ARGUMENT, not a side effect of opening, because `opened(directory, overlay)`
 * read as "look at this" while quietly writing it: two occupancy cases each wrote
 * their own overlay and a ledger, and one of them was asserting against the other's.
 *
 * `ledger` is the ledger's CONTENT; the path is this helper's business, so a case
 * cannot assert against a ledger in some other directory.
 *
 * ONE argument, carrying the directory on it. It was two — (directory, dialog) —
 * and three cases transposed them, which is a mistake a failing assertion gives
 * no hint about, because both arguments are plausible objects to have in hand.
 */
async function withOpenDialog(fn, { overlay, active = [], retained = [] } = {}) {
  return withTempDir(async (directory) => {
    if (overlay !== undefined) writeLaneOverlay(directory, overlay);
    if (active.length > 0 || retained.length > 0) {
      saveTaskLedger({ retained: new Map(retained), active: new Map(active), pending: [] },
        resolveTaskLedgerPath(directory));
    }
    return fn({ ...(await opened(directory)), directory });
  });
}

/**
 * Boot, press, and hand back the open dialog over whatever is already on disk.
 */
async function opened(directory) {
  const { seen, command } = await registered(directory);
  command.run();
  assert.equal(seen.selects.length, 1, "pressing the command opens the lane list");
  const select = seen.selects[0];
  return {
    seen,
    select,
    /** The row for one lane, by name. */
    option: (title) => select.options.find((candidate) => candidate.title === title),
  };
}

describe("the lane command reaches the palette", () => {
  it("registers one command in one layer, and disposes the layer with the plugin", async () => {
    await withTempDir(async (directory) => {
      const { seen, command } = await registered(directory);
      assert.ok(command, "one command, so the palette has one entry to find");
      assert.equal(seen.disposed.length, 1,
        "a layer left registered outlives the plugin and answers a second opencode");
    });
  });

  it("is findable by typing \"lanes\", under every field the palette might search", async () => {
    await withTempDir(async (directory) => {
      const { command } = await registered(directory);
      // ctrl+p then "lanes". Which fields the palette searches is the host's
      // configuration, so the word is in all three of the ones we set rather than
      // in the one we guessed: name, title, and the slash spelling. The last is
      // the same command, so the two spellings cannot drift into two entries.
      assert.match(command.name, /lanes/);
      assert.match(command.title, /lanes/i);
      assert.equal(command.slash.name, "lanes");
    });
  });
});

/**
 * A project whose overlay caps one lane, and the lanes dialog open over it.
 *
 * The common case, named. Ten of the cases below differ only in the cap, and each
 * was spelling the overlay's whole shape inline — which is the jscpd gate's
 * definition of a fixture maintained in ten places at once, and the reason a
 * change to the overlay's shape would have been ten edits.
 *
 * It is `withOpenDialog` with the body attached, not a default: the file is still
 * written because the case named it, so nothing here writes anything a reader
 * cannot account for.
 */
const withBuildLane = (maxConcurrent, fn) => withOpenDialog(fn, { overlay: withBuildLane.overlay(maxConcurrent) });

/** The overlay itself, for the cases that also need a ledger beside it. */
withBuildLane.overlay = (maxConcurrent) => ({ lanes: { build: { maxConcurrent } } });

/**
 * Press the dialog's own "add a lane" choice.
 *
 * Named because three cases press it and each had to know the title text to find
 * it: the choice's wording is a test detail leaking into three assertions, so a
 * rename of the menu item would have broken three tests for no reason a reader
 * could see.
 */
const pressAddLane = (select) =>
  select.options.find((option) => option.title.startsWith("Add a lane")).onSelect();

/**
 * Select a lane and answer its caps prompt.
 *
 * The dialog's one interaction, which three cases each spelled out as "find the
 * row, call onSelect, answer the first prompt" and none of them was actually
 * about: they were about what happens to the answer. The steps get a name so the
 * cases can say what they are checking.
 */
const answerCapsFor = (dialog, lane, answer) => {
  dialog.option(lane).onSelect();
  dialog.seen.prompts[0].onConfirm(answer);
};

/**
 * The add-a-lane flow: press the choice, then name the lane.
 *
 * The second half of the dialog, and the one with more steps: each case that used
 * it had to know both that the choice is pressed and that the NAME prompt is the
 * first one after it, which is a coupling the reader can only verify by reading
 * the command.
 */
const nameNewLane = (dialog, name) => {
  pressAddLane(dialog.select);
  dialog.seen.prompts[0].onConfirm(name);
};

describe("the lane dialog", () => {
  it("names each lane's caps and where they came from, so the operator knows what they are editing", async () => {
    // Not the build-lane fixture: this is the one case with a depth cap as well.
    await withOpenDialog((dialog) => {
      assert.equal(dialog.select.title, "Lanes");
      assert.match(dialog.option("build").description, /2 concurrent · depth 3/);
      assert.match(dialog.option("build").description, /set in the overlay/);
    }, { overlay: { lanes: { build: { maxConcurrent: 2, maxDepth: 3 } } } });
  });

  it("does not let an inherited cap read as one this dialog set", async () => {
    await withTempDir(async (directory) => {
      const { option } = await opened(directory);
      assert.match(option(DEFAULT_LANE).description, /caps from the config file/);
    });
  });

  it("says the occupancy is as last recorded, because it is a file read and not a live gauge", async () => {
    await withOpenDialog((dialog) => {
      assert.match(dialog.option("build").description, /idle/);
    }, { overlay: { lanes: { build: { maxConcurrent: 1 } } } });
  });

  it("warns about an overlay it cannot read AND still opens, because repair is why it was opened", async () => {
    await withTempDir(async (directory) => {
      writeFileSync(join(directory, LANE_OVERLAY_FILE), "{ not json", "utf8");
      const { select, seen } = await opened(directory);
      assert.ok(seen.toasts.some((toast) => toast.variant === "warning"), "the operator is told the file is odd");
      assert.ok(select, "and the dialog is open, so they can fix it");
    });
  });

  it("offers a way to add a lane, as its own choice rather than a name nobody would pick", async () => {
    await withTempDir(async (directory) => {
      const { select, seen } = await opened(directory);
      const add = select.options.find((option) => option.title.startsWith("Add a lane"));
      assert.ok(add, "adding a lane is a distinguishable choice, not a magic lane name");
      add.onSelect();
      assert.equal(seen.prompts[0].title, "New lane name");
    });
  });
});

describe("choosing a lane", () => {
  it("offers a prompt whose placeholder is the caps as they stand", async () => {
    await withBuildLane(2, async (dialog) => {
      dialog.option("build").onSelect();
      assert.equal(dialog.seen.prompts[0].placeholder, `2 ${UNBOUNDED}`, "the operator edits a number they can see");
    });
  });

  it("a bad answer is refused in place, keeping what was typed, and a good one lands on disk", async () => {
    // A DIRECTORY, not a dialog. This case is about two successive dialogs in one
    // place — the second has to find the file the first REFUSED to touch — so it
    // needs somewhere to put them rather than a dialog of its own. Reaching for
    // the one-dialog fixture made it open like every other case here and said
    // nothing about the two rounds, which is the whole claim.
    await withTempDir(async (directory) => {
      const start = withBuildLane.overlay(2);
      writeLaneOverlay(directory, start);

      const refused = await opened(directory);
      answerCapsFor(refused, "build", "nope");
      assert.ok(refused.seen.toasts.some((toast) => toast.variant === "error" && /not a count/.test(toast.message)),
        "the operator is told WHY, not just refused");
      assert.ok(refused.seen.prompts.length >= 2, "the question is still open — closing would discard the answer");
      assert.deepEqual(readOverlay(directory), start, "and nothing was written");

      const accepted = await opened(directory);
      answerCapsFor(accepted, "build", "4 3");
      assert.deepEqual(readOverlay(directory).lanes.build, { maxConcurrent: 4, maxDepth: 3 });
      assert.ok(accepted.seen.toasts.some((toast) => toast.variant === "success" && /next dispatch/.test(toast.message)),
        "a live server will not re-read the file for work already admitted, and claiming otherwise would be a lie");
    });
  });
});

describe("what this suite cannot prove", () => {
  it("the palette's fuzzy search is the host's configuration, so ctrl+p is what settles it", () => {
    // Stated as a fact about the suite rather than left implicit: nothing here
    // can observe which fields opencode's palette searches. What the suite does
    // establish is that the word is in the name AND the title, so a search over
    // either lands on this entry.
    assert.ok(true);
  });
});

describe("adding a lane", () => {
  it("a name that already exists opens that lane rather than making a second one", async () => {
    await withBuildLane(2, async (dialog) => {
      nameNewLane(dialog, "build");
      assert.equal(dialog.seen.prompts[1].title, "Lanes · build",
        "a name that already exists is that lane, not a new one — the operator meant to edit it");
    });
  });

  it("a new name becomes a lane with the caps that get typed", async () => {
    await withBuildLane(2, async (dialog) => {
      nameNewLane(dialog, "deploy");
      assert.equal(dialog.seen.prompts[1].title, "Lanes · deploy");
      dialog.seen.prompts[1].onConfirm("2 1");
      assert.deepEqual(readOverlay(dialog.directory).lanes.deploy, { maxConcurrent: 2, maxDepth: 1 });
    });
  });

  it("an empty name is not a lane called \"\"", async () => {
    await withOpenDialog((dialog) => {
      nameNewLane(dialog, "   ");
      assert.equal(dialog.seen.prompts.length, 1, "no caps prompt: there is no lane to set caps on");
    });
  });
});

describe("when the write does not happen", () => {
  it("a write that fails says so and asks again, rather than reporting a cap that was not applied", async () => {
    await withBuildLane(2, async (dialog) => {
      const { seen } = dialog;
      // The prompt is opened FIRST, then the file is broken, then the answer is
      // given: the claim is about the write failing, so the write has to be the
      // step that is refused.
      dialog.option("build").onSelect();
      rmSync(join(dialog.directory, LANE_OVERLAY_FILE));
      mkdirSync(join(dialog.directory, LANE_OVERLAY_FILE));
      seen.prompts[0].onConfirm("4");
      assert.ok(seen.toasts.some((toast) => toast.variant === "error" && /could not write/.test(toast.message)),
        "a refused write must not be confirmed as a cap in force");
      assert.ok(seen.prompts.length >= 2, "and the question is still open");
    });
  });
});

describe("occupancy is read, not assumed", () => {
  it("counts the running tasks charged to each lane", async () => {
    await withOpenDialog((dialog) => {
      assert.match(dialog.option("build").description, /1 running, as last recorded/);
    }, { overlay: withBuildLane.overlay(4), active: [["ses_r", runningEntry("ses_r", { lane: "build" })]] });
  });

  it("a settled task in the same lane is not occupancy — only a running one is", async () => {
    await withOpenDialog((dialog) => {
      assert.match(dialog.option("build").description, /idle/,
        "a finished child in this lane is history, not a slot in use");
    }, {
      overlay: withBuildLane.overlay(4),
      retained: [["ses_d", retainedEntry({ childSessionId: "ses_d", lane: "build", state: TaskState.Completed })]],
    });
  });

  it("a ledger that cannot be read leaves the dialog open, because a count is not worth a closed dialog", async () => {
    await withTempDir(async (directory) => {
      // The ledger is written as garbage rather than through the helper, because
      // the claim is about a file the reader cannot parse.
      writeLaneOverlay(directory, withBuildLane.overlay(4));
      writeFileSync(resolveTaskLedgerPath(directory), "{ not a ledger", "utf8");
      const dialog = await opened(directory);
      assert.match(dialog.option("build").description, /idle/);
    });
  });
});
