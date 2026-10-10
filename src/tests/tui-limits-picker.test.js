/**
 * Choosing a cap: the picker the host draws, and the claims its title and its rows make.
 * The design thesis and the harness rationale are in `tui-limits-command.test.js`.
 */

import { AGENT_CAP_NAMES } from "../../dist/shared/caps.js";
import { CAP_CHOICES, CAP_LABEL } from "../../dist/tui/agent-editor.js";
import { ALL_AGENTS_LABEL, BACK_LABEL, capPickerProps } from "../../dist/tui/props.js";
import { boundClause, FROM_CONFIG } from "../../dist/tui/theme.js";
import { agentEntry, assert, assertCapsDrawn, assertEveryRowFits, BOUND_DEPTH, backRow, backToCaps, choose, clearRow, describe, everyRowClaims, it, readOverlay, row, rowsOn, titlesOf, top, valueRow, withCapsOpen, withOpen, withPickerClaimed, withPickerOpen } from "./support/index.js";

describe("a bound is a note, not a removal", () => {
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
});

describe("the picker is the host's own list of values, and a way to leave it", () => {
  it("puts the way out LAST, below the settings it exits", () =>
    // A list of things to act on is read top-down, and an exit belongs after what it
    // exits. A "Back" row above the two caps reads as a third cap — and the host
    // replaces the screen under a press, so a mistimed press on it would throw away the
    // place the operator was standing, which is the one thing an exit must never cost.
    withCapsOpen(async (host) => {
      const titles = titlesOf(top(host.seen));
      assert.equal(titles.at(-1), ALL_AGENTS_LABEL, "the exit is the last row, not a third cap above them");
      assertCapsDrawn(top(host.seen), "back on the caps screen");
      await choose(host, backRow(host, ALL_AGENTS_LABEL));
      assert.equal(top(host.seen).title, "Task limits", "which lands on the list, not on a value");
    }));

  it("lists every value one cap can take, so the range is visible rather than guessed at", () =>
    withPickerOpen((host) => {
      assert.deepEqual(titlesOf(top(host.seen)), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default", BACK_LABEL],
        "one row per legal value, and the way out below them");
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

  it("has a way back that writes nothing, because its only other exit is escape", () =>
    withPickerOpen(async (host, directory) => {
      // The gap this closes. Every other row on a picker either SETS THE FILE or cannot
      // be pressed, and the host's `replace` leaves no previous dialog to pop back to —
      // so before this row existed, a picker had no non-destructive exit at all.
      // Changing your mind meant closing the whole manager and navigating back in, or
      // picking a value you did not want under a success toast.
      const rows = titlesOf(top(host.seen));
      assert.equal(rows.at(-1), BACK_LABEL,
        "the way out is the LAST row, below the values: a navigation row sitting above ten numbers reads as a value, and the host replaces the screen under a press");
      await backToCaps(host, "explore", "and it lands on the agent's own two caps, one level up");
      assert.deepEqual(await readOverlay(directory), { agents: { explore: { maxConcurrent: 2 } } },
        "the overlay is untouched — abandoning a picker is not an edit");
      assert.equal(host.seen.toasts.length, 0, "and nothing is announced about a change that did not happen");
    }));

  it("and every picker row leads somewhere, so a new row kind cannot be added without a way on", () =>
    // The failure this shape rules out: a row whose `onSelect` is absent is a row the
    // operator can see, focus, and do nothing with. The agent screen's own Back row
    // already has that guarantee and the pickers did not, which is the drift.
    withPickerClaimed((option) => option.value !== undefined, "a visible row that does nothing is worse than no row"));
});

describe("clearing a cap, or offering no way to", () => {
  it("offers nothing to clear on a cap the overlay does not state, because that row could only be inert", () =>
    withOpen(async (host) => {
      await choose(host, row(top(host.seen), "general"));
      assert.equal(clearRow(host), undefined, "there is nothing to clear on an agent that never stated one");
    }, { overlay: { agents: { explore: { maxConcurrent: 2 } } } }));

  it("offers to clear one it DOES state, and says what clearing means", () =>
    withPickerOpen((host) => {
      assert.ok(clearRow(host), "the inverse of setting a cap is offerable");
      assert.match(clearRow(host).description, /config file/, "and the row says whose numbers take over");
    }));

  it("builds to the host's own prop type, so a field the host never reads cannot be added here", () => {
    // Not a behavioural claim: a compile-time one, reached from JS. The prop builder
    // is exported so this can be called at all, and calling it is what a reader of the
    // production file would do.
    const picker = capPickerProps("explore", "maxConcurrent", agentEntry("explore", { agents: { explore: { maxConcurrent: 2 } } }));
    assert.deepEqual(titlesOf(picker), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default", BACK_LABEL]);
    assert.ok(picker.options.every((option) => option.value !== undefined));
  });
});