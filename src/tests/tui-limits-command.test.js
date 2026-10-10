/**
 * The TUI module's contract with the host: registered where the host looks, reaching the
 * palette, and the list the operator came with. The design thesis — no invented host API,
 * every case running on the real prop builders — and the harness rationale are here.
 */

//jscpd:ignore-start
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { overlayKey } from "../../dist/shared/overlay-store.js";
import { CEILING_LABEL, displayName, MODEL_LABEL } from "../../dist/tui/agent-editor.js";
import tuiModule from "../../dist/tui/index.js";
import { BETWEEN } from "../../dist/tui/theme.js";
import { REPO_ROOT } from "./support/corpus.js";
import { bothCaps } from "./support/fixtures.js";
import {assertEveryRowFits, 
  BASE, booted, capText, openList, REGISTERED, row, rowText, titlesOf, top, withBooted, withCapsOpen, withConfigScreen, withList, withPickerOpen, withProject,
} from "./support/limits-screen.js";
import { assert, describe, it } from "./support/runner.js";

//jscpd:ignore-end
/**
 * Every row the list draws, in order, as the SCREEN prints it.
 *
 * Built from the same `displayName` the screen builds from, rather than written out. A
 * case that retyped `['total ceiling', 'explore', ...]` would be pinned to a spelling the
 * screen does not use, and would go on passing after the screen capitalised its names and
 * added its colons — which is what these expectations once did for a round, failing
 * thirty-odd cases for one uninteresting change.
 */
// The model sits with the total, directly under it: the two document-level settings
// together, so "what applies to every agent" is read in one place. Five rows for three
// registered agents and no overlay.
const WHOLE_SCREEN = [`${displayName(CEILING_LABEL)}:`, `${displayName(MODEL_LABEL)}:`, ...REGISTERED.map((name) => `${displayName(name)}:`)];

/**
 * The harness, checked against itself.
 *
 * Every scenario here runs through `given(step, case)`, and it was `given(step)(case)`
 * with no call site applying the second half — so `withPickerOpen(case)` handed the
 * UNAPPLIED wrapper to the next layer as its case, `return case(host, directory)`
 * returned a function instead of a promise, and the body was never awaited and never
 * ran. Twenty-odd cases were green because they asserted nothing, including one with a
 * `throw` in it; the only reason it was findable is that a case expecting a screen
 * production did not draw produced a failure nobody could explain.
 *
 * A currying helper whose unapplied form is itself a plausible case function is a trap
 * with no type to catch it, and nothing in the suite would report it. So it is reported
 * here: the wrapper is driven with cases that MUST fail, and these fail unless the
 * rejection reaches the runner. A harness that can silently drop a case body is not a
 * harness, and the only evidence either way is a case that goes red if it breaks.
 */
describe("the harness reports a failing case body", () => {
  it("a case that throws inside a scenario reaches the runner", async () => {
    await assert.rejects(
      withPickerOpen(() => {
        throw new Error("a case body that must not be swallowed");
      }),
      /must not be swallowed/,
      "the scenario wrapper returned without running the case, so every scenario above it is vacuous",
    );
  });

  it("and an assertion inside a case body is as visible as a throw", async () => {
    await assert.rejects(
      withPickerOpen((host) => assert.equal(top(host.seen).title, "a screen production never drew")),
      /never drew/,
      "an assertion inside a case body was swallowed, so no case in this file can fail",
    );
  });
});

describe("the TUI module is registered where the host looks for it", () => {
  it("the package exposes a tui entrypoint, and it loads to the shape the loader decodes", async () => {
    const entrypoint = join(REPO_ROOT, "dist", "tui", "index.js");
    assert.ok(existsSync(entrypoint), `${entrypoint} is absent — the host resolves <package>/tui and finds nothing, so the palette entry cannot load`);

    const loaded = await import(pathToFileURL(entrypoint).href);
    assert.ok(loaded.default?.id, "a TUI module must default-export a non-empty id");
    assert.equal(typeof loaded.default?.setup, "function", "and a setup the loader can call — anything else is an invalid module");
  });
});

describe("the module the host loads", () => {
  it("default-exports a non-empty id and a setup, which is the whole of what the loader needs", () => {
    // The loader reads the DEFAULT export and ignores named exports, and a module
    // with no id has no runtime identity to be enabled or rejected against. A
    // default that is not `{ id, setup }` is refused rather than preferred, so this
    // is the whole of what the loader needs — and none of it is a type error, since
    // a mis-shaped default typechecks exactly as well.
    assert.ok(tuiModule.id, "a TUI module must export a non-empty id");
    assert.equal(typeof tuiModule.setup, "function");
  });
});

describe("the limits command reaches the palette", () => {
  /**
   * One command, so one case.
   *
   * These were three tests, and the gate called the shape a clone — correctly, since
   * `it(<title>, … => assert(… command.<field>` is identical between them once the
   * differing title is a bare token. They are three reads of the SAME command's
   * fields rather than three situations, so the checks belong together; each keeps
   * its own message, so a failure still names which field broke and why the host cares.
   */
  it("is listed in the palette, under the host's field names, findable by \"limits\"", () =>
    withProject(async (directory) => {
      const { command } = await booted(directory);

      // LISTED. The host surfaces palette commands by the `palette` flag; without it
      // the command is registered, dispatchable by name and runnable from a keybinding,
      // and appears in no list — an empty ctrl+p with no error anywhere.
      assert.equal(command.palette, true,
        "no palette flag means registered but listed nowhere, which is the empty panel");

      // READ. A misspelled field is silently a property the palette ignores, so the
      // names are the host's: `description` for the second line, `group` for the
      // section, `slash.name` for the slash spelling.
      assert.equal(command.slash?.name, "limits", "the palette's slash spelling is `slash.name`");
      assert.ok(command.description, "the palette's second line is `description`");
      assert.ok(command.group, "and the section is `group`");

      // FOUND. Which fields the palette fuzzy-searchs is the host's configuration, so
      // the word is in all three we set rather than in the one we guessed.
      assert.match(command.id, /limits/);
      assert.match(command.title, /limits/i);
      assert.match(command.description, /agent|limits/i);
    }));
});

describe("the limits list is the question the operator came with", () => {
  it("draws the total ceiling, then one row per REGISTERED agent and nothing else", () =>
    // The WHOLE screen, in the order the host will draw it, as one assertion. Read as
    // a list, a row added for a reason nobody recorded would satisfy any partial
    // version of it.
    //
    // Four rows for three registered agents, with no overlay at all: the key space
    // is GIVEN, so the screen is populated on a project that has never touched it.
    // Under lanes this could show only the default lane and whatever the operator had
    // declared — which is why an "add a lane" affordance existed at all, and why a
    // second section had to explain itself.
    //
    // The total is FIRST and not merely present. It is the cap a dispatch is refused
    // on before any agent's own cap is consulted, so an operator who raised every
    // per-agent cap and still hit a ceiling has to meet it on the first screen.
    withList(undefined, (list) => {
      assert.deepEqual(titlesOf(list), WHOLE_SCREEN,
        "the cross-agent total, then one row per agent the host publishes, in the host's order");
      assertEveryRowFits(list);
    }));

  it("and an agent the overlay caps is still a row, showing which caps are ITS OWN", () =>
    withList({ agents: { explore: { maxConcurrent: 2 } } }, (list) => {
      assert.deepEqual(titlesOf(list), WHOLE_SCREEN, "capping an agent does not remove it from the list");
      assert.match(rowText(list, "explore"), /2 concurrency/, "the stated cap, with no claim about where it came from");
      assert.doesNotMatch(rowText(list, "explore"), /config/,
        "and the one that is NOT stated does NOT say so HERE. It used to, and the information is real: an agent left at 4 by default and one deliberately set to 4 read the same on this row, and the operator could not tell a cap they had chosen from one they had inherited.");
    }));

  it("and the list's silence about provenance is the caps screen's answer, one level down", () =>
    // The cost of the terse list, stated and bounded rather than absorbed. `from config`
    // appeared on BOTH figures of EVERY row, so a list of twenty agents said it forty
    // times in a column, and a column of repeated annotations is what made the screen
    // read as broken strings rather than as a menu.
    //
    // The information did not go; it MOVED, and this is the case that proves it is
    // reachable — a list that is quiet about a fact is only defensible while the place
    // the operator goes to DECIDE still says it. Delete this case and the quiet would be
    // free: nothing would be left claiming the distinction survives.
    withCapsOpen((host) => {
      assert.match(capText(host, "maxDepth"), /from config/, "a cap the overlay never stated says whose number it is, where the operator sets it");
      assert.doesNotMatch(capText(host, "maxConcurrent"), /from config/, "and a cap the overlay DID state claims nothing");
    }));

  it("so a cap from the config file is still a figure on the list, with no adjective", () =>
    withList(undefined, (list) => {
      assert.match(rowText(list, "general"), new RegExp(`${BASE.maxConcurrent} concurrency`), "the config file's own cap, as a figure and nothing else");
    }));

  it("puts both caps of an agent on its ONE row, so the pair is read together", () =>
    withList({ agents: { explore: bothCaps(2, 1) } }, (list) => {
      // The gap comes from the module, not from a retyped run of spaces: a test that
      // spelled it would be a second place to change, and would keep passing after the
      // cells were separated by something the operator could read as a word.
      const adjacency = `2 concurrency${BETWEEN}1 depth`;
      assert.ok(rowText(list, "explore").includes(adjacency),
        `concurrency and depth adjacent as ${JSON.stringify(adjacency)}, which is the ask the row exists for`);
      assert.equal(titlesOf(list).filter((title) => title === `${displayName("explore")}:`).length, 1,
        "two rows of one agent would print the name twice and split the pair apart");
    }));
});

describe("and the list offers nothing the host does not own", () => {
  it("says no word about lanes, because there are none", () =>
    withList({ agents: { explore: { maxConcurrent: 2 } } }, (list) => {
      for (const title of titlesOf(list)) {
        assert.doesNotMatch(rowText(list, title), /lane/i, "the vocabulary is the operator's, and lanes are gone");
      }
      assert.doesNotMatch(list.title, /lane/i);
    }));

  it("offers no way to add, delete, or name an agent, because the host owns the list", () =>
    // The three affordances a lane needed and an agent does not: a name to invent, an
    // entry to remove, and a "default" standing in for one nobody declared. Each was
    // compensation for a key space the operator had to maintain by hand.
    withList({ agents: { explore: { maxConcurrent: 2 } } }, (list) => {
      const text = list.options.map((option) => rowText(list, option.title)).join(" ");
      assert.doesNotMatch(text, /add|delete|remove|new lane|rename/i,
        "an affordance that operates on the key space is one the plugin cannot justify");
    }));

  it("every row is a distinguishable choice, so an agent named after a cap is still an agent", () =>
    withList(undefined, (list) => {
      for (const option of list.options) {
        assert.ok(option.value !== undefined, `${option.title} carries no choice value, so pressing it answers nothing`);
      }
      // Agent rows name the AGENT they edit, and the total names no agent at all — the
      // two are disjoint claims, and a total row that borrowed an agent's key would open
      // that agent's screen when pressed.
      const agents = list.options.map((option) => option.value.agent).filter((name) => name !== undefined);
      assert.equal(new Set(agents).size, REGISTERED.length,
        "a row's value names the AGENT it edits, so two rows cannot answer for the same one");
      const values = list.options.map((option) => JSON.stringify(option.value));
      assert.equal(new Set(values).size, list.options.length,
        "and no two rows are the same choice, so the host cannot filter them to one and the total is never an agent");
      assert.equal(row(list, CEILING_LABEL).value.agent, undefined,
        "the total's value names no agent, so pressing it cannot open an agent's caps");
    }));

  it("shows no occupancy, because a count read from a file is not a gauge", () =>    // The row used to say how many tasks were charged to it, read from the ledger
    // file. That is the last RECORDED set, not a live count, and printing it beside a
    // cap gave the operator reason to distrust the one number they could act on.
    withList({ agents: { explore: { maxConcurrent: 2 } } }, (list) => {
      assert.doesNotMatch(rowText(list, "explore"), /\d+\/\d+|running|active/i,
        "a number this process cannot verify is not a number to print");
    }));

  it("shows the caps the hand-authored config file states, because those are the ones a dispatch is judged against", () =>
    // The whole file config was invisible to this screen: it resolved against DEFAULTS
    // and said "from config" about them, so a project that capped `explore` at 9 saw 4
    // here and enforced 9. Not a test-only seam — the same numbers reach the dispatch
    // path, so the screen was a false witness about its own subject.
    withConfigScreen({ agents: { explore: { maxConcurrent: 9, maxDepth: 5 } } }, (list) => {
      const text = rowText(list, "explore");
      assert.match(text, /9 concurrency/, "the file's own cap, not the default four");
      assert.doesNotMatch(text, /4 concurrency/, "and not the default it used to print and call config");
    }));

  it("reads a TOP-LEVEL cap out of the same file, for an agent the file does not name", () =>
    // The other half of the same reader: the file's top level is the fallback for every
    // agent it leaves alone, and reading per-agent entries without the top level would
    // make a file that states a global cap look as if it stated nothing at all.
    withConfigScreen({ maxConcurrent: 3, maxDepth: 1 }, (list) => {
      const text = rowText(list, "explore");
      assert.match(text, /3 concurrency/, "the file's top level is in force for an agent it does not name");
      assert.match(text, /1 depth/, "and so is its depth");
    }));

  it("an overlay it cannot read is said out loud AND the list still opens, because repair is why it was opened", () =>
    withProject(async (directory, channel) => {
      // Written straight into the host's table, because no writer of ours would produce
      // it: this is the document a hand-edited store or a stale one holds, and the
      // claim is about what the screen does when it finds one.
      channel.kv.set(overlayKey(directory), "{ not json");
      const host = await booted(directory, { channel });
      await openList(host);
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "warning" && /could not be read/.test(toast.message)),
        "the operator is told the stored caps are odd");
      assert.equal(host.seen.selects.length, 1, "and the list is not empty — there has to be a way to fix it");
      assert.deepEqual(titlesOf(top(host.seen)), WHOLE_SCREEN, "and it still draws the total and the host's agents, not nothing");
    }));
});

/**
 * Escape is the host's key, and this plugin does not take it.
 *
 * The v2 keymap has no library double to drive: layers are plain objects the host
 * interprets, so the property is stated over the objects themselves. A layer with no
 * `bindings` owns no key whatever the dialog is doing — and escape, the operator's way
 * to stop an in-flight request, is the key that must never be interceptable. A gate
 * cannot offer this: a gate is only as good as the state it reads, and a
 * desynchronised one turns "stop this request" into a swallowed keypress, whose failure
 * is a turn that never ends rather than a lost dialog.
 *
 * The Back rows are the way out of every screen, because a dialog the host dismisses
 * needs no key of ours to leave.
 */
describe("escape is the host's key, and this plugin does not take it", () => {
  it("the plugin registers NO bindings, so interrupt cannot be ours to break", () =>
    withBooted(({ bindings }) => {
      const keys = bindings.map((binding) => String(binding.key ?? binding).toLowerCase());
      assert.deepEqual(keys, [],
        `the plugin must register no key bindings at all; it has: ${JSON.stringify(keys)}`);
    }));

  it("and no layer carries bindings either, so a second registration path cannot hide one", () =>
    withBooted((host) => {
      for (const layer of host.seen.layers) {
        assert.ok(layer.bindings === undefined, "a layer with bindings owns a key, whatever the bindings say");
      }
    }));
});