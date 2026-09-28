/**
 * The TUI module's contract with the host: it is registered where the host looks, the
 * command reaches the palette, the list is the question the operator came with, and
 * every way out of the dialogs works.
 *
 * THERE IS NO INVENTED API HERE, and that is the whole design. An earlier version of
 * this file stood up a hand-written `fakeApi` and drove the dialogs through it. That
 * double was free to decide what the host does, and it decided wrong: it called
 * `onClose` the instant a dialog opened, so every dialog looked dismissible and the
 * suite "proved" a way out of each one. So the dialog's CONTENT is not a host
 * interaction at all: the prop builders are pure, and they return the HOST'S OWN prop
 * type, so the props the host would be handed are an ordinary value this suite can read.
 * Most cases below need no double whatsoever — a real overlay is read by the real
 * reader, turned into the real view, and rendered by the real prop builder.
 *
 * The host's contract is enforced where it is authored, in TypeScript: a field the
 * host never reads is a type error in `src/tui/index.ts` rather than a custom property
 * only a terminal would reveal.
 *
 * The harness — the host double, the overlay reader and the scenario vocabulary — is in
 * `support/limits-screen.js`, shared with the cross-agent total's own suite. The total
 * is a different cap on a different screen and its cases are in
 * `tui-ceiling-cap.test.js`; the shared vocabulary is the point, not a shared accident.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { createTestKeymap, captureKeymapDiagnostics } from "@opentui/keymap/testing";
import { registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_OVERLAY_FILE, readAgentOverlay, writeAgentOverlay } from "../../dist/shared/caps.js";
import { bothCaps } from "./support/fixtures.js";
import { AGENT_CAP_NAMES } from "../../dist/shared/caps.js";
import { CAP_CHOICES, CAP_LABEL, CEILING_LABEL, agentDialogFrom } from "../../dist/tui/agent-editor.js";
import { CELL_GAP } from "../../dist/tui/theme.js";
import { REPO_ROOT } from "./support/corpus.js";
import { footerText } from "./support/assertions.js";
import tuiModule, { agentCapsProps, capPickerProps, fitsItsDialog, tui } from "../../dist/tui/index.js";
import {
  BASE, REGISTERED, assertEveryRowFits, capRow, capText, clearRow, chooseValue, dialogStack,
  given, havingWritten, hostApi, listOver, openList, pressRowOn, readOverlay,
  rendererDouble, row, rowOn, rowText, rowsOn, settle, titlesOf, top, valueRow, withBooted,
  withCapsOpen, withConfigScreen, withExploreOpen, withList, withOpen, withPickerOpen,
  withProject, booted,
} from "./support/limits-screen.js";

/** The whole screen, in the order the host will draw it: the total, then the agents. */
const WHOLE_SCREEN = [CEILING_LABEL, ...REGISTERED];


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
/**
 * The harness, checked against itself.
 *
 * Every scenario above runs through `given(step, case)`, and it was `given(step)(case)`
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
  it("is listed in .opencode/tui.json, and the path resolves to a loadable module", async () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, ".opencode", "tui.json"), "utf8"));
    const specs = (manifest.plugin ?? []).map((entry) => (Array.isArray(entry) ? entry[0] : entry));
    assert.ok(specs.length > 0, "an empty tui.json plugin array loads nothing at all");

    // Relative specs resolve against the config file that declared them, so the
    // repo's own manifest can be portable rather than carrying one machine's path.
    const resolved = specs.map((spec) => resolve(REPO_ROOT, ".opencode", spec));
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

      // LISTED. The host surfaces palette commands BY NAMESPACE; without this the
      // command is registered, dispatchable by name and runnable from a keybinding,
      // and appears in no list — an empty ctrl+p with no error anywhere.
      assert.equal(command.namespace, "palette",
        "no namespace means registered but listed nowhere, which is the empty panel");

      // READ. `Command` carries an index signature, so a misspelled field is silently
      // a custom property the palette ignores. The legacy `slash: { name }` form
      // belongs to the deprecated `api.command` API and is never read here.
      assert.equal(command.slashName, "limits", "the palette's slash spelling is `slashName`");
      assert.ok(command.desc, "the palette's second line is `desc`");
      assert.ok(!("description" in command), "`description` is a custom field the host never reads");
      assert.ok(!("slash" in command), "`slash` is the legacy api.command shape, not a palette field");

      // FOUND. Which fields the palette fuzzy-searchs is the host's configuration, so
      // the word is in all three we set rather than in the one we guessed. It is no
      // longer "lanes", because nothing here is a lane any more.
      assert.match(command.name, /limits/);
      assert.match(command.title, /limits/i);
      assert.match(command.desc, /agent|limits/i);
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
      assert.match(rowText(list, "explore"), /at once 2/, "the stated cap, with no claim about where it came from");
      assert.match(rowText(list, "explore"), new RegExp(`depth ${BASE.maxDepth} from config`),
        "and the one that is NOT stated says so — an agent at 4 by default and one deliberately set to 4 look the same otherwise");
      assert.match(rowText(list, "general"), new RegExp(`at once ${BASE.maxConcurrent} from config`));
    }));

  it("puts both caps of an agent on its ONE row, so the pair is read together", () =>
    withList({ agents: { explore: bothCaps(2, 1) } }, (list) => {
      // The gap comes from the module, not from a retyped run of spaces: a test that
      // spelled it would be a second place to change, and would keep passing after the
      // cells were separated by something the operator could read as a word.
      const adjacency = `at once 2${CELL_GAP}depth 1`;
      assert.ok(rowText(list, "explore").includes(adjacency),
        `concurrency and depth adjacent as ${JSON.stringify(adjacency)}, which is the ask the row exists for`);
      assert.equal(titlesOf(list).filter((title) => title === "explore").length, 1,
        "two rows of one agent would print the name twice and split the pair apart");
    }));

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
        assert.equal(typeof option.onSelect, "function", `${option.title} has no way to be chosen`);
        assert.ok(option.value, `${option.title} carries no value, so the host cannot filter on it`);
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
      assert.match(text, /at once 9/, "the file's own cap, not the default four");
      assert.doesNotMatch(text, /at once 4/, "and not the default it used to print and call config");
    }));

  it("reads a TOP-LEVEL cap out of the same file, for an agent the file does not name", () =>
    // The other half of the same reader: the file's top level is the fallback for every
    // agent it leaves alone, and reading per-agent entries without the top level would
    // make a file that states a global cap look as if it stated nothing at all.
    withConfigScreen({ maxConcurrent: 3, maxDepth: 1 }, (list) => {
      const text = rowText(list, "explore");
      assert.match(text, /at once 3/, "the file's top level is in force for an agent it does not name");
      assert.match(text, /depth 1\b/, "and so is its depth");
    }));

  it("an overlay it cannot read is said out loud AND the list still opens, because repair is why it was opened", () =>
    withProject(async (directory) => {
      writeFileSync(join(directory, AGENT_OVERLAY_FILE), "{ not json");
      const host = await booted(directory);
      await openList(host);
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "warning" && /not valid JSON/.test(toast.message)),
        "the operator is told the file is odd");
      assert.equal(host.seen.selects.length, 1, "and the list is not empty — there has to be a way to fix it");
      assert.deepEqual(titlesOf(top(host.seen)), WHOLE_SCREEN, "and it still draws the total and the host's agents, not nothing");
    }));
});

describe("a row fits the dialog it is drawn in", () => {
  it("for an agent carrying both caps, stated and inherited", () =>
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      assertEveryRowFits(list);
      assert.match(rowText(list, "explore"), /at once 2/, "and the caps are on screen, not clipped away");
    }));

  it("for agent names far longer than any real one, because the host chooses them", () =>
    // A row's length is a function of a name the plugin does not own, so the budget
    // cannot be checked against a fixture that happens to be short. This drives the
    // arithmetic the host's own layout uses, over the longest shapes the row can take.
    withList(undefined, (list) => {
      const footer = `· at once ${BASE.maxConcurrent} from config · depth ${BASE.maxDepth} from config`;
      for (const name of ["x".repeat(20), "a-very-long-hyphenated-agent-name-indeed", "reviewer"]) {
        assert.ok(fitsItsDialog({ title: name, footer }), `${name.length} chars does not fit: ${name.length + footer.length}`);
      }
      assertEveryRowFits(list);
    }));

  it("the caps sit in the cell the host never clips, not in the sentence it does", () =>
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      const found = row(list, "explore");
      assert.ok(found.footer, "the value rides in `footer`");
      assert.ok(!found.description, "and not in `description`, which shares the clipped headline line");
    }));
});

describe("choosing a cap", () => {
  it("opens a PICKER — a list of the values one cap can take, plus the way to unset it", () =>
    withPickerOpen((host) => {
      assert.deepEqual(titlesOf(top(host.seen)), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default"],
        "one row per legal value, so the whole range is visible rather than guessed at");
      assertEveryRowFits(top(host.seen));
    }));

  it("names the AGENT and the CAP, so a screen of numbers says what they mean", () => {
    for (const cap of AGENT_CAP_NAMES) {
      const picker = capPickerProps("explore", cap, null, () => {});
      assert.equal(picker.title, `explore — ${CAP_LABEL[cap]}`);
      assert.doesNotMatch(picker.title, /lane/i);
    }
  });

  it("marks the value in force, so the operator can see what they are changing FROM", () =>
    withPickerOpen((host) => {
      assert.equal(valueRow(host, 2)?.footer, "in force", "the stated cap is the one in force");
      assert.equal(valueRow(host, 4)?.footer, undefined, "and no other row claims to be");
    }));

  it("offers NO way to clear a cap the overlay does not state, because that row could only be inert", () =>
    withOpen((host) => {
      row(top(host.seen), "general").onSelect();
      assert.equal(clearRow(host), undefined, "there is nothing to clear on an agent that never stated one");
    }, { overlay: { agents: { explore: { maxConcurrent: 2 } } } }));

  it("offers to clear one it DOES state, and says what clearing means", () =>
    withPickerOpen((host) => {
      assert.ok(clearRow(host), "the inverse of setting a cap is offerable");
      assert.match(clearRow(host).details.join(" "), /config file/, "and the row says whose numbers take over");
    }));

  it("a picker built with no host is the host's own prop type, so a field the host never reads cannot be added here", () => {
    // Not a behavioural claim: a compile-time one, reached from JS. The prop builder
    // is exported so this can be called at all, and calling it is what a reader of the
    // production file would do.
    const picker = capPickerProps("explore", "maxConcurrent", 2, () => {});
    assert.deepEqual(titlesOf(picker), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default"]);
    assert.ok(picker.options.every((option) => typeof option.onSelect === "function"));
  });
});

describe("the flow, end to end on disk", () => {
  it("a chosen cap lands in the overlay the dispatch path reads", () =>
    withPickerOpen(havingWritten((host) => chooseValue(host, 4))((host, directory) => {
      assert.deepEqual(readOverlay(directory), { agents: { explore: { maxConcurrent: 4 } } },
        "the value the row promised is the value on disk");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "success" && /next dispatch/.test(toast.message)),
        "and the operator is told it takes effect on the next dispatch, which is all it claims");
    })));

  it("lands back on the AGENT's caps, re-read, so the other cap is one keypress away", () =>
    // The stale-row defect, and the reason the landing screen is an argument rather
    // than a constant. A write makes the view the caller is holding out of date, so a
    // second cap answered from that view would be written from caps the file no
    // longer has. Landing on the LIST instead would also be correct, and would make
    // changing the pair two round trips through the whole screen — the cost a
    // per-agent cap pair exists to avoid.
    withPickerOpen(havingWritten((host) => chooseValue(host, 4))((host) => {
      assert.equal(top(host.seen).title, "explore", "the agent's own caps, not the list and not the value screen");
      // The `·` is the mark between a row's label and its value, and it is there
      // because the host draws `footer` hard against `title` with no column to align
      // — so the cell has to separate itself. Asserted WITH it, so a change to that
      // mark cannot quietly merge the label and the number back into one run of text.
      assert.match(capText(host, "maxConcurrent"), new RegExp(`at once · 4$`, "m"),
        "and it shows the NEW number, not the one it was holding");
      assert.match(capText(host, "maxDepth"), new RegExp(`depth · ${BASE.maxDepth} from config$`, "m"),
        "with the other cap still reading as inherited, so nothing was invented by the write");
    })));

  it("setting the OTHER cap of the same agent keeps the first, because the list is re-read after a write", () =>
    // The stale-row defect, driven through the one flow that has it. One row carries
    // both caps, so the second write happens on a re-read of a view the first write
    // invalidated — and a flow that wrote from the pre-write view would drop the
    // first cap with nothing to show for it.
    withPickerOpen(havingWritten((host) => chooseValue(host, 4))((host, directory) => {
      // Back on the agent's caps, re-read. The DEPTH row is right there — which is
      // the whole claim: the second write happens on a re-read, and it is one keypress
      // away rather than a trip through the list.
      capRow(host, "maxDepth").onSelect();
      assert.equal(top(host.seen).title, `explore — ${CAP_LABEL.maxDepth}`, "the OTHER cap of the same agent");
      valueRow(host, 3).onSelect();
      assert.deepEqual(readOverlay(directory), { agents: { explore: { maxConcurrent: 4, maxDepth: 3 } } },
        "the cap set first survives the second, which is the whole claim");
    })));

  it("the depth cap is reachable at all, which a single-press row could not be", () =>
    // The hole the flow found. One row carried both values, and one press had to pick a
    // cap to open — so the row opened the concurrency picker and the depth cap had no
    // way in at all. The pair was VISIBLE and half of it was editable, which is worse
    // than showing one, because the screen had said both were settings.
    withCapsOpen((host) => {
      assert.deepEqual(titlesOf(top(host.seen)).slice(0, AGENT_CAP_NAMES.length), AGENT_CAP_NAMES.map((cap) => CAP_LABEL[cap]),
        "both caps are rows of the agent's own screen, in the vocabulary of the list row");
      for (const cap of AGENT_CAP_NAMES) assert.equal(typeof capRow(host, cap).onSelect, "function", `${cap} can be opened`);
    }));

  it("clearing the agent's only cap removes the key AND the entry", () =>
    // These were two cases over one event, differing only in their closing message,
    // which is what the duplication gate called them. They are the same write: an
    // agent whose last stated cap is cleared has nothing left to say, so both the key
    // and the entry go. A `null` would be the same file with a second shape every
    // reader would have to recognise, and an empty body would be a dead entry per
    // experiment — the two ways an overlay rots.
    withPickerOpen((host, directory) => {
      clearRow(host).onSelect();
      assert.deepEqual(readOverlay(directory), { agents: {} },
        "an absent key and a zero are different statements, and only one of them means 'no cap'");
    }));

  it("a write that fails says so and confirms nothing, rather than reporting a cap that was not applied", () =>
    withPickerOpen((host, directory) => {
      // A read-only directory: the overlay's temp-then-rename has nowhere to land.
      chmodSync(directory, 0o500);
      try {
        valueRow(host, 4).onSelect();
        assert.ok(!host.seen.toasts.some((toast) => toast.variant === "success"),
          "a refused write must not be confirmed as a cap in force");
        assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /could not write/.test(toast.message)),
          "and the operator is told the file could not be written");
      } finally {
        chmodSync(directory, 0o700);
      }
    }));

  it("the list opens over a directory holding a ledger, because it does not read one", () =>
    // The row used to print how many tasks were charged to it, which meant a read of
    // the ledger file in the render path. The number is gone, and with it the read.
    withOpen((host) => {
      assert.match(rowText(top(host.seen), "explore"), /at once 2/);
    }, { overlay: { agents: { explore: { maxConcurrent: 2 } } }, active: [{ childSessionId: "ses_x", agentName: "explore" }] }));
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

describe("escape gets the operator out of the limits list", () => {
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
      const { hostClosed, stillOpen, diagnostics } = pressEscapeForReal(host, { selectedText: "explore" });
      assert.equal(hostClosed, 0, "the host's handler is disabled while text is selected — the trap");
      assert.equal(stillOpen, false, "and the list is still closable, which is the whole fix");
      assert.equal(host.renderer.selection, null, "the selection goes with it, as the host's handler would");
      assert.deepEqual([...diagnostics.warnings, ...diagnostics.errors], []);
    }));

  it("the escape layer answers only while a dialog of OURS is up, never for another plugin's", () =>
    // `withBooted`, not `withOpen`: the first assertion is about the gate BEFORE
    // anything of ours is on screen, which is the state `withOpen` has already left.
    withBooted(async (host) => {
      assert.equal(host.escapeLayer.enabled(), false, "nothing of ours is open, so the layer is inert");
      assert.equal(host.escape.key, "escape", "and it is the key the operator actually presses");

      await openList(host);
      assert.equal(host.escapeLayer.enabled(), true, "the list is up, so escape has to be live");

      // Choosing a row mounts the picker OVER the list, and `replace` walks the
      // outgoing entry's onClose — so the gate has to be re-armed by the mount, not
      // left wherever the replaced dialog left it.
      row(top(host.seen), "explore").onSelect();
      assert.equal(host.escapeLayer.enabled(), true, "still live over the picker, not dropped by the replacement");
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

