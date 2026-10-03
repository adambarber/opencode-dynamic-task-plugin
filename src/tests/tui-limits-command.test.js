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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_OVERLAY_FILE, readAgentOverlay, writeAgentOverlay } from "../../dist/shared/caps.js";
import { capCellOf } from "../../dist/tui/agent-editor.js";
import { bothCaps, withTempDir } from "./support/fixtures.js";
import { AGENT_CAP_NAMES } from "../../dist/shared/caps.js";
import { CAP_CHOICES, CAP_LABEL, CEILING_LABEL, agentDialogFrom } from "../../dist/tui/agent-editor.js";
import { REPO_ROOT } from "./support/corpus.js";
import { BETWEEN, FROM_CONFIG, boundClause, namedCell, plainSummary } from "../../dist/tui/theme.js";
import { displayName } from "../../dist/tui/agent-editor.js";
import tuiModule, { ALL_AGENTS_LABEL, BACK_LABEL, DIALOG_WIDTH, agentCapsProps, capPickerProps, ceilingPickerProps, fitsItsDialog, limitsListProps } from "../../dist/tui/index.js";

import {
  BASE, BOUND_DEPTH, LONG_AGENT_NAME, REGISTERED, agentEntry, assertEveryRowFits, backRow, capRow, capText, choose, clearRow, chooseValue, dialogRowText, rowsText,
  everyRowClaims, given, havingWritten, hostApi, listOver, openList, pressRowOn, readOverlay,
  row, rowOn, rowText, rowsOn, settle, titlesOf, top, valueRow, withBooted,
  withCapsOpen, withConfigScreen, withExploreOpen, withList, withOpen, withPickerClaimed, withPickerOpen,
  withProject, booted,
} from "./support/limits-screen.js";

/** The whole screen, in the order the host will draw it: the total, then the agents. */
/**
 * Every row the list draws, in order, as the SCREEN prints it.
 *
 * Built from the same `displayName` the screen builds from, rather than written out. A
 * case that retyped `['total ceiling', 'explore', ...]` would be pinned to a spelling the
 * screen does not use, and would go on passing after the screen capitalised its names and
 * added its colons — which is what this file's expectations did for a round, failing
 * thirty-odd cases for one uninteresting change.
 */
const WHOLE_SCREEN = [`${displayName(CEILING_LABEL)}:`, ...REGISTERED.map((name) => `${displayName(name)}:`)];


/**
 * The registration, read from the package the host resolves.
 *
 * The half of the contract that cannot be reached from the module: the host resolves
 * the TUI entrypoint off the SAME package as the server plugin (`<dir>/tui`), so a
 * TUI module that builds but that no entrypoint reaches is never loaded, and it fails
 * silently as an empty command palette. The module can be perfectly shaped and still
 * go nowhere, which is exactly what happened, so the entrypoint is pinned here rather
 * than left to a path nobody checks.
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

describe("the host's own layout, as measured rather than modelled", () => {
  // Every DERIVED version of these numbers has been wrong, and each was confident. The
  // first counted six columns of indent and missed a one-pixel gap; the second missed the
  // `scrollbox` at `paddingLeft={1} paddingRight={1}` the rows live in; a third measured
  // a `large` dialog for a screen whose rows turned out not to need one. All were out in
  // the safe direction, which is the worst way to be wrong — the gate was quietly tighter
  // than the screen, so every row passed and the operator learned nothing until a real one
  // clipped.
  //
  // The figures come off a real frame (`bun scripts/render-proof.js --screen`), because a
  // measurement cannot be out by a layer nobody thought of. This case pins what that
  // command measured, so a change to the arithmetic has to be made against the frame.
  it("a row gets 52 columns, at the host's own default dialog", () => {
    assert.equal(DIALOG_WIDTH, 60, "medium — the host's default, which is why no screen of ours calls setSize at all");
    assert.equal(dialogRowText(DIALOG_WIDTH), 52, "60 less the scrollbox's 1+1 and the row's 3+3");
    assert.ok(fitsItsDialog({ title: "M".repeat(52) }), "52 fits, because 52 is what fits");
    assert.ok(!fitsItsDialog({ title: "M".repeat(53) }), "and 53 is clipped by the host, silently, with no ellipsis");
  });

  it("and every screen of ours fits in it, which is why there is one width and not two", () => {
    // The list was `large` for a round, because a 40-character agent name and a 30-character
    // summary shared a row. The row is 34 characters now — `2 concurrency * 3/4 depth` —
    // because the figures lost their labels' preamble and their provenance, so the widest
    // realistic name that fits is 17 characters and the host's default holds every screen.
    // A width is a fact about the content; a content change that makes a width unnecessary
    // should be allowed to delete the width, or it will outlive its reason.
    for (const name of REGISTERED) {
      assert.ok(fitsItsDialog({ title: `${name}:`, description: "4 concurrency * 3/4 depth" }), `${name} and both of its figures fit one row`);
    }
  });

  it("a description shares the title's line, so a long name eats it", () => {
    assert.ok(!fitsItsDialog({ title: "M".repeat(40), description: "x".repeat(20) }), "40 + 1 + 20 is 61, over a row of 52");
    assert.ok(fitsItsDialog({ title: "M".repeat(30), description: "x".repeat(20) }), "30 + 1 + 20 is 51, and fits");
  });
});

describe("a row fits the dialog it is drawn in", () => {
  it("for an agent carrying both caps, stated and inherited", () =>
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      assertEveryRowFits(list);
      assert.match(rowText(list, "explore"), /2 concurrency/, "and the caps are on screen, not clipped away");
    }));

  it("counts the FOOTER's width, because the host will not shrink it and the title will", () => {
    // Measured against the host at this tag rather than reasoned about. An option row is
    // `<box flexDirection="row" paddingLeft={3} paddingRight={3} gap={1}>` (dialog-select
    // .tsx:666) holding one `Option`, whose title is `<text flexGrow={1}
    // overflow="hidden" paddingLeft={3}>` and whose footer is `<box flexShrink={0}>`
    // (dialog-select.tsx:786). The footer therefore cannot give ground — the TITLE does,
    // into a clip with no ellipsis. This gate measured the title alone, which is how the
    // case below could claim a 37-character agent name fits beside its caps: 37 < 72, when
    // the host gives the two of them 68 columns between them.
    const caps = plainSummary(agentEntry("explore", BOUND_DEPTH));
    assert.ok(caps.length > 20, `the footer measured is one production really builds, not a fixture: "${caps}"`);
    assert.equal(fitsItsDialog({ title: LONG_AGENT_NAME }, caps.length), false,
      "a long name beside its caps is over the row, and the old arithmetic called it fine");
  });

  it("rides each agent's caps beside its name, and keeps the right edge clear", () =>
    // Rendered, this is the screen's actual failure, and no styling fixes it. The title is
    // a <text flexGrow={1}> and the footer a <box flexShrink={0}> inside a flexDirection
    // "row" (dialog-select.tsx:666,786), so a footer is pushed to the FAR edge and the
    // title's space absorbs the distance: `explore` in column 3, `at once 2` in column 35.
    // The eye travels the whole row to relate them.
    //
    // `description` is the field the host itself puts the muted text in, rendered inside
    // the title's own `<text>`, so the two are one line and one span. Every other select
    // in this host uses it for exactly this and the host picks its colour at paint time
    // from the row's state, which is what a hand-built `fg()` chunk could not do.
    withList(BOUND_DEPTH, (list) => {
      const explore = row(list, "explore");
      assert.equal(explore.footer, undefined, "no footer, so nothing is stranded at the right edge");
      // An EQUALITY, not a `match`: `BETWEEN` is `" * "`, and inside a RegExp that is a
      // quantifier — `concurrency *` means zero or more `y` — so the pattern quietly
      // described something else and the case was testing the regex.
      assert.equal(explore.description, `2 concurrency${BETWEEN}3/4 depth`, "both caps, figure before noun, on the name's own line");
      assert.equal(rowText(list, "explore"), `Explore: 2 concurrency${BETWEEN}3/4 depth`, "and the terminal shows that whole line");
      assert.doesNotMatch(row(list, "general").description, /config/,
        "and the LIST says nothing about where a figure came from: `from config` appeared on both figures of all twenty rows, forty times in a column, and that is what made the list read as broken strings. Where the operator is deciding rather than scanning — the agent's own caps screen — the annotation is still there, because there it answers a question instead of repeating one.");
      assertEveryRowFits(list);
    }));

  it("and a name too WIDE for its caps drops the caps whole, rather than clipping them", () =>
    // The host clips the line with no ellipsis, so a name that cannot share its row has
    // two honest choices: lose the agent, or lose the caps. And it has to lose them
    // WHOLE. A row ending `depth 3` looks like a bound and is a truncation, and nothing
    // on the screen distinguishes the two — which is the failure a silent clip always is.
    //
    // So the screen asks the width gate, and the gate's verdict is acted on here rather
    // than reported and ignored. It is the gate's one caller that consumes its answer,
    // which is the only arrangement in which it can be one.
    withList(undefined, async (list) => {
      const wide = row(list, LONG_AGENT_NAME);
      assert.ok(wide, "the host published it, so it is a row");
      assert.equal(wide.description, undefined, "and the caps went with it, whole — a clipped figure is a lie about a bound");
      assert.equal(wide.title, `${displayName(LONG_AGENT_NAME)}:`, "the name itself is never cut");
      assert.ok(wide.value !== undefined && wide.value.kind !== undefined, "and the row still opens — it carries the choice that opens it, which is where the caps are in full");
      assertEveryRowFits(list);
    }, { agentNames: [...REGISTERED, LONG_AGENT_NAME] }));

  it("the caps ride in `description`, on the title's own line, and the right edge stays clear", () =>
    // This row has been three fields in two rounds and every one of them was wrong for a
    // reason no assertion was asking about, and two frames found it.
    //
    // `footer` is where a cell is "at full size" — the premise for two rounds, and false:
    // the title is a `<text flexGrow={1}>` and the footer a `<box flexShrink={0}>` in a
    // `flexDirection="row"`, so a footer is pushed to the far edge of the dialog, a name
    // in column 3 and its caps in column 35, on a row that reads as two unrelated
    // statements. `details` fixed the position by becoming a column child, and cost a
    // field the host does not declare, an indent, and the caps' colour — a `details` line
    // is a string, because the host runs it through `Locale.truncateMiddle` and a
    // `StyledText` has no `.slice`.
    //
    // `description` is the field every native dialog in this host uses for the muted text
    // after a title, and the host draws it in the title's own `<text>`, so it follows the
    // selection bar and costs nothing to declare.
    withList({ agents: { explore: bothCaps(2, 3) } }, (list) => {
      const found = row(list, "explore");
      assert.equal(found.footer, undefined, "no footer, so nothing is stranded at the right edge");
      assert.equal(found.description, plainSummary(agentEntry("explore", { agents: { explore: bothCaps(2, 3) } })), "the caps are the row's description, in the host's own spelling");
      assert.equal(rowText(list, "explore"), `${displayName("explore")}: ${plainSummary(agentEntry("explore", { agents: { explore: bothCaps(2, 3) } }))}`, "one line, and the terminal shows all of it");
    }));
});

/** What the two cap rows read as the terminal will show them, for an agent capped at 2. */
const AGENT_CAP_ROWS = AGENT_CAP_NAMES.map((cap) => {
  const entry = agentEntry("explore", { agents: { explore: { maxConcurrent: 2 } } });
  return CAP_LABEL[cap] + " " + namedCell(capCellOf(entry, cap));
});

/**
 * The cap rows of a drawn screen, in draw order, minus the way out.
 *
 * Two cases in this file claim the same thing about the caps screen — that both caps are
 * there, labelled, each with its figure — from two different angles: one is about the EXIT
 * being last and needs the rows above it to be only the caps, the other is about the hole
 * the flow found and needs both caps to be individually pressable. Spelled twice it is
 * four lines and seventy tokens of identical shape, and the gate is right to: the two
 * `AGENT_CAP_NAMES.map` chains are one claim written out, and the line above each says so.
 */
const capRowsAsDrawn = (dialog) => rowsText(dialog).slice(0, -1);

describe("choosing a cap", () => {
  it("puts the way out LAST, below the settings it exits", () =>
    // A list of things to act on is read top-down, and an exit belongs after what it
    // exits. A "Back" row above the two caps reads as a third cap — and the host
    // replaces the screen under a press, so a mistimed press on it would throw away the
    // place the operator was standing, which is the one thing an exit must never cost.
    withCapsOpen(async (host) => {
      const titles = titlesOf(top(host.seen));
      assert.equal(titles.at(-1), ALL_AGENTS_LABEL, "the exit is the last row, not a third cap above them");
      const row2 = agentEntry("explore", { agents: { explore: { maxConcurrent: 2 } } });
      assert.deepEqual(
        rowsText(top(host.seen)).slice(0, -1),
        AGENT_CAP_NAMES.map((cap) => CAP_LABEL[cap] + " " + namedCell(capCellOf(row2, cap))),
        "and the two caps are still the whole list, each carrying its own figure beside its label",
      );
      await choose(host, backRow(host, ALL_AGENTS_LABEL));
      assert.equal(top(host.seen).title, "Task limits", "which lands on the list, not on a value");
    }));

  it("marks a depth the AGENT SET holds below the cap, and still offers it", () =>
    // The cap is what the operator SET; the depth they can reach is bounded by the
    // agent set whatever the cap says, so over a three-agent set a cap of four permits
    // three. The picker listed all eight values with nothing distinguishing them, so
    // setting one the set held down produced a success toast and a depth that never
    // arrived — and the operator's only way to find out was to dispatch and read
    // `task_list`.
    //
    // MARKED and not omitted, which is the half that is easy to get wrong. Dropping the
    // unreachable values would make a legal cap unsettable: an operator who registers a
    // fourth agent afterwards would find the cap they set gone, with nothing saying a
    // screen took it away. The note says what binds, so the value is a decision the
    // operator can make with the number in front of them.
    // Stated ONCE, in the title, after a frame showed it said five times — once on the
    // title and once on each of 4, 5, 6, 7 and 8. A fact repeated until it is wallpaper
    // is a fact nobody reads, and the title is where the eye already is.
    withPickerOpen((host) => {
      const entry = agentEntry("explore", BOUND_DEPTH);
      const held = entry.depth.effective;
      assert.ok(held !== null && held < entry.resolved.maxDepth,
        "the agent set binds below the stated cap, or this case proves nothing about a bound");
      assert.match(top(host.seen).title, new RegExp(boundClause(held)),
        "the title says what holds the cap down");
      const repeats = rowsOn(host).filter((option) => `${option.description ?? ""}`.includes(boundClause(held)));
      assert.deepEqual(repeats, [], "and no value row says it again");
    }, "maxDepth", BOUND_DEPTH));

  it("keeps every value pressable, because a bound is a note and not a removal", () =>
    // The pin against the tempting half of the fix. Omitting an unreachable value makes
    // the screen shorter and the defect invisible, and costs an operator a cap they set
    // legitimately the moment a fourth agent exists.
    withPickerOpen((host) => {
      everyRowClaims(rowsOn(host), (option) => option.value !== undefined,
        "every value the picker offers is settable, reachable or not");
    }, "maxDepth", BOUND_DEPTH));

  it("puts no bound on a CONCURRENCY cap, because nothing holds one but itself", () =>
    // The bound is derived from the cap's own kind, not from the value. A concurrency cap
    // has no ceiling that is not its own value, so a note on it would be a claim about
    // nothing — and a screen that annotates one picker and not the other teaches the
    // operator that the marks are decoration.
    withPickerOpen((host) => {
      assert.doesNotMatch(top(host.seen).title, new RegExp(boundClause(1)), "nothing holds a concurrency cap but itself");
    }, "maxConcurrent", BOUND_DEPTH));

  it("opens a PICKER — a list of the values one cap can take, plus the way to unset it", () =>
    withPickerOpen((host) => {
    assert.deepEqual(titlesOf(top(host.seen)), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default", BACK_LABEL],
        "one row per legal value, so the whole range is visible rather than guessed at, and the way out is below them");
      assertEveryRowFits(top(host.seen));
    }));

  it("names the AGENT and the CAP, and says the file's number when the cap is not the operator's", () => {
    // Three clauses, all in the title and none of them anywhere else on the screen: WHO
    // the caps are, WHICH cap, and whether the number in force is one the operator wrote.
    // The third was found missing by the case that says the LIST is quiet about
    // provenance — a picker whose list is a column of bare figures, offering a number the
    // file chose, is the screen where an operator decides to overwrite one, so that is
    // where the fact belongs.
    const stated = { agents: { explore: { maxConcurrent: 2, maxDepth: 3 } } };
    for (const cap of AGENT_CAP_NAMES) {
      const owned = capPickerProps("explore", cap, agentEntry("explore", stated));
      assert.equal(owned.title, `explore — ${CAP_LABEL[cap]}`, "a cap the overlay states claims nothing about the file");
      const inherited = capPickerProps("explore", cap, agentEntry("explore"));
      assert.equal(inherited.title, `explore — ${CAP_LABEL[cap]} (${FROM_CONFIG})`, "and a cap it does not says so, in the one place the operator is choosing a number");
      assert.doesNotMatch(owned.title, /lane/i);
    }
  });

  it("marks the value in force, so the operator can see what they are changing FROM", () =>
    // The mark is the HOST's `current`, handed to it and not painted here. It draws a `●`
    // in `theme.primary` on that row and opens the selection there — both of which a
    // hand-built footer could not do, since a `StyledText` is fixed and a selection bar is
    // a colour the host picks at paint time. `isDeepEqual` is how the host matches, so the
    // `current` and the row's own `value` are the same object SHAPE; a case that reshaped
    // one without the other would find the marker gone and this would still be green if it
    // compared them by reference instead of by what the host compares.
    withPickerOpen((host) => {
      const screen = top(host.seen);
      const stated = valueRow(host, 2);
      assert.deepEqual(screen.current, stated.value, "the value in force is the one the host is told is current");
      assert.notDeepEqual(screen.current, valueRow(host, 4).value, "and no other value claims to be");
      assert.equal(stated.footer, undefined, "with nothing painted in the right-hand gutter beside it");
    }));

  it("offers NO way to clear a cap the overlay does not state, because that row could only be inert", () =>
    withOpen(async (host) => {
      await choose(host, row(top(host.seen), "general"));
      assert.equal(clearRow(host), undefined, "there is nothing to clear on an agent that never stated one");
    }, { overlay: { agents: { explore: { maxConcurrent: 2 } } } }));

  it("offers to clear one it DOES state, and says what clearing means", () =>
    withPickerOpen((host) => {
      assert.ok(clearRow(host), "the inverse of setting a cap is offerable");
      assert.match(clearRow(host).description, /config file/, "and the row says whose numbers take over");
    }));

  it("a picker built with no host is the host's own prop type, so a field the host never reads cannot be added here", () => {
    // Not a behavioural claim: a compile-time one, reached from JS. The prop builder
    // is exported so this can be called at all, and calling it is what a reader of the
    // production file would do.
    const picker = capPickerProps("explore", "maxConcurrent", agentEntry("explore", { agents: { explore: { maxConcurrent: 2 } } }));
    assert.deepEqual(titlesOf(picker), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default", BACK_LABEL]);
    assert.ok(picker.options.every((option) => option.value !== undefined));
  });

  it("has a way back that writes nothing, because its only other exit is escape", () =>
    // The gap this closes. Every other row on a picker either SETS THE FILE or cannot
    // be pressed, and the host's `replace` leaves no previous dialog to pop back to — so
    // before this row existed, a picker had no non-destructive exit at all. Changing
    // your mind meant closing the whole manager and navigating back in, or picking a
    // value you did not want under a success toast.
    //
    // The file is asserted as well as the landing screen, because "go back" that wrote
    // would land on a screen showing a number the operator never chose.
    withPickerOpen(async (host, directory) => {
      assert.equal(titlesOf(top(host.seen)).at(-1), BACK_LABEL,
        "the way out is the LAST row, below the values: a navigation row sitting above ten numbers reads as a value, and the host replaces the screen under a press");
      await choose(host, backRow(host));
      assert.equal(top(host.seen).title, "explore", "and it lands on the agent's own two caps, one level up");
      assert.deepEqual(readOverlay(directory), { agents: { explore: { maxConcurrent: 2 } } },
        "the overlay is untouched — abandoning a picker is not an edit");
      assert.equal(host.seen.toasts.length, 0, "and nothing is announced about a change that did not happen");
    }));

  it("and every picker row now leads somewhere, so a new row kind cannot be added without a way on", () =>
    // The failure this shape rules out: a row whose `onSelect` is absent is a row the
    // operator can see, focus, and do nothing with. The agent screen's own Back row
    // already has that guarantee and the pickers did not, which is the drift.
    withPickerClaimed((option) => option.value !== undefined, "a visible row that does nothing is worse than no row"));
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
      // LABEL AND VALUE, whole rows and by EQUALITY, so a failure prints what the
      // operator sees. The operator set this one, so it claims no provenance — that is
      // the difference between a number the file holds and a number somebody chose, and it
      // is the reason `namedCell` and `terseCell` are two spellings rather than one.
      assert.equal(capText(host, "maxConcurrent"), `${CAP_LABEL.maxConcurrent} 4`, "and it shows the NEW number, not the one it was holding");
      assert.equal(capText(host, "maxDepth"), `${CAP_LABEL.maxDepth} ${BASE.maxDepth} from config`, "with the other cap still reading as inherited, so nothing was invented by the write");
    })));

  it("setting the OTHER cap of the same agent keeps the first, because the list is re-read after a write", () =>
    // The stale-row defect, driven through the one flow that has it. One row carries
    // both caps, so the second write happens on a re-read of a view the first write
    // invalidated — and a flow that wrote from the pre-write view would drop the
    // first cap with nothing to show for it.
    withPickerOpen(havingWritten((host) => chooseValue(host, 4))(async (host, directory) => {
      // Back on the agent's caps, re-read. The DEPTH row is right there — which is
      // the whole claim: the second write happens on a re-read, and it is one keypress
      // away rather than a trip through the list.
      await choose(host, capRow(host, "maxDepth"));
      assert.equal(top(host.seen).title, `explore — ${CAP_LABEL.maxDepth} (${FROM_CONFIG})`, "the OTHER cap of the same agent, and the file still holding its number");
      await choose(host, valueRow(host, 3));
      assert.deepEqual(readOverlay(directory), { agents: { explore: { maxConcurrent: 4, maxDepth: 3 } } },
        "the cap set first survives the second, which is the whole claim");
    })));

  it("the depth cap is reachable at all, which a single-press row could not be", () =>
    // The hole the flow found. One row carried both values, and one press had to pick a
    // cap to open — so the row opened the concurrency picker and the depth cap had no
    // way in at all. The pair was VISIBLE and half of it was editable, which is worse
    // than showing one, because the screen had said both were settings.
    withCapsOpen(async (host) => {
      assert.deepEqual(capRowsAsDrawn(top(host.seen)), AGENT_CAP_ROWS, "both caps are rows of the agent's own screen, each with its figure");
      for (const cap of AGENT_CAP_NAMES) {
        await choose(host, capRow(host, cap));
        assert.match(top(host.seen).title, new RegExp(`explore — ${CAP_LABEL[cap]}`), `${cap} opens its picker`);
        await choose(host, backRow(host));
        assert.equal(top(host.seen).title, "explore", "and the way back is one level up, on the agent's own caps");
      }
    }));

  it("clearing the agent's only cap removes the key AND the entry", () =>
    // These were two cases over one event, differing only in their closing message,
    // which is what the duplication gate called them. They are the same write: an
    // agent whose last stated cap is cleared has nothing left to say, so both the key
    // and the entry go. A `null` would be the same file with a second shape every
    // reader would have to recognise, and an empty body would be a dead entry per
    // experiment — the two ways an overlay rots.
    withPickerOpen(async (host, directory) => {
      await choose(host, clearRow(host));
      assert.deepEqual(readOverlay(directory), { agents: {} },
        "an absent key and a zero are different statements, and only one of them means 'no cap'");
    }));

  it("a write that fails says so and confirms nothing, rather than reporting a cap that was not applied", () =>
    withPickerOpen(async (host, directory) => {
      // A read-only directory: the overlay's temp-then-rename has nowhere to land.
      chmodSync(directory, 0o500);
      try {
        await choose(host, valueRow(host, 4));
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
      assert.match(rowText(top(host.seen), "explore"), /2 concurrency/);
    }, { overlay: { agents: { explore: { maxConcurrent: 2 } } }, active: [{ childSessionId: "ses_x", agentName: "explore" }] }));
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