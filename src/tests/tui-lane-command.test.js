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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_OVERLAY_FILE, writeLaneOverlay } from "../../dist/shared/lane-overlay.js";
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
 * Boot, press, and hand back the open dialog.
 *
 * Every case below is the same four steps — a project directory holding an
 * overlay, then the command, then a row in the resulting list — and spelling
 * that out per case is how one of them ends up pressing a command and asserting
 * against the previous case's dialog.
 */
async function opened(directory, overlay) {
  if (overlay !== undefined) writeLaneOverlay(directory, overlay);
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

describe("the lane dialog", () => {
  it("names each lane's caps and where they came from, so the operator knows what they are editing", async () => {
    await withTempDir(async (directory) => {
      const { select, option } = await opened(directory, { lanes: { build: { maxConcurrent: 2, maxDepth: 3 } } });
      assert.equal(select.title, "Lanes");
      assert.match(option("build").description, /2 concurrent · depth 3/);
      assert.match(option("build").description, /set in the overlay/);
    });
  });

  it("does not let an inherited cap read as one this dialog set", async () => {
    await withTempDir(async (directory) => {
      const { option } = await opened(directory);
      assert.match(option(DEFAULT_LANE).description, /caps from the config file/);
    });
  });

  it("says the occupancy is as last recorded, because it is a file read and not a live gauge", async () => {
    await withTempDir(async (directory) => {
      const { option } = await opened(directory, { lanes: { build: { maxConcurrent: 1 } } });
      assert.match(option("build").description, /idle/);
    });
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
    await withTempDir(async (directory) => {
      const { option, seen } = await opened(directory, { lanes: { build: { maxConcurrent: 2 } } });
      option("build").onSelect();
      assert.equal(seen.prompts[0].placeholder, `2 ${UNBOUNDED}`, "the operator edits a number they can see");
    });
  });

  it("a bad answer is refused in place, keeping what was typed, and a good one lands on disk", async () => {
    await withTempDir(async (directory) => {
      const start = { lanes: { build: { maxConcurrent: 2 } } };

      const refused = await opened(directory, start);
      refused.option("build").onSelect();
      refused.seen.prompts[0].onConfirm("nope");
      assert.ok(refused.seen.toasts.some((toast) => toast.variant === "error" && /not a count/.test(toast.message)),
        "the operator is told WHY, not just refused");
      assert.ok(refused.seen.prompts.length >= 2, "the question is still open — closing would discard the answer");
      assert.deepEqual(readOverlay(directory), start, "and nothing was written");

      const accepted = await opened(directory, start);
      accepted.option("build").onSelect();
      accepted.seen.prompts[0].onConfirm("4 3");
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
