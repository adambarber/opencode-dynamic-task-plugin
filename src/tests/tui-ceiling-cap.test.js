/**
 * The cross-agent total as a cap the operator can set.
 *
 * Its own suite because it is a different SUBJECT from the command that opens the
 * list: the total is not an agent, it has no per-agent body, and every question about
 * it is a question about how the file is written rather than about which rows a screen
 * draws. The two were one file, and the file outgrew the length the gate allows — so
 * the split followed the subject and the harness went to `support/limits-screen.js`,
 * where both suites reach the same dialog stack, the same overlay reader and the same
 * scenario vocabulary.
 *
 * The case that matters most here is the last one. The file is written WHOLE on every
 * edit, so a screen that rebuilds it from one half destroys the other; the total was
 * invisible as a bug until there was a way to set it, and then setting an agent's cap
 * silently deleted it under a success toast.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CAP_CHOICES, CEILING_LABEL, displayName } from "../../dist/tui/agent-editor.js";
import { FROM_CONFIG } from "../../dist/tui/theme.js";
import { AGENT_OVERLAY_FILE } from "../../dist/shared/caps.js";
import { BACK_LABEL, ceilingPickerProps } from "../../dist/tui/index.js";
import { readAgentOverlay } from "../../dist/shared/caps.js";
import { capRow } from "./support/limits-screen.js";

import {
  BASE, backRow, choose, chooseValue, clearRow, given, havingWritten, pressRow, pressRowOn,
  rowText, titlesOf, top, withList, withOpen,
} from "./support/limits-screen.js";

/**
 * …with the cross-agent total's picker open.
 *
 * Its own scenario rather than a parameter on the per-agent one, because the total is
 * reached from the LIST and an agent is reached from the caps screen: parameterising one
 * helper over both would make every case state which of two unrelated flows it is
 * driving, and the reaching is half of what each case is about.
 */
const withCeilingOpen = (fn) => withOpen(given(pressRow(CEILING_LABEL, "the total is a row, so it is reachable at all"), fn));

/**
 * …with a total of 12 already stated, which is the precondition the three write cases
 * below share.
 *
 * Named because it IS the shared state: each of them drives the same four steps to the
 * same file, and a case spelling its own copy would be free to reach a different 12 — a
 * different picker, a different agent — without any of them saying so.
 */
const withCeilingWritten = (fn) => withCeilingOpen(havingWritten((host) => chooseValue(host, 12))(fn));

describe("the cross-agent total is a cap the operator can set", () => {
  /**
   * The total's own row, as text, over whatever the file states.
   *
   * Three cases below are about one ROW and differ only in the overlay under it. Handed
   * the list, each would have repeated the same `withList(undefined, (list) =>` and the
   * same first assertion, which is the scaffolding the duplication gate reads as shared
   * code — and the cases say nothing about a list, only about one cell of it.
   */
  const totalRowOver = (overlay, fn) => withList(overlay, (list) => fn(rowText(list, CEILING_LABEL)));

  it("shows the config file's number on the list, as a figure and nothing else", () =>
    // The number in force and whether the operator WROTE it are the two answers a screen
    // must not confuse: a total of 4 by default and a total deliberately set to 4 are the
    // same integer. The list no longer distinguishes them — it is a column of quantities
    // and `from config` on every row is what made it read as broken strings — so the claim
    // has MOVED to the screen where the operator picks a total. The pair of cases here and
    // the one below is what makes that move checkable rather than merely asserted.
    totalRowOver(undefined, (text) => {
      assert.equal(text, `${displayName(CEILING_LABEL)}: ${BASE.maxConcurrent} concurrency`, "the number the dispatch path refuses on, with no adjective");
    }));

  it("and says where it came from in the PICKER, which is where the operator chooses one", () =>
    // The list is for scanning and this is for deciding, and the same fact is worth
    // different amounts of space in each. If the picker stopped saying it too, the
    // information would be gone rather than moved — which is why the assertion is HERE and
    // not only about the list's silence.
    withOpen(async (host) => {
      await pressRow(CEILING_LABEL, "the total is a row, so it is reachable at all")(host);
      assert.equal(top(host.seen).title, `${CEILING_LABEL} (${FROM_CONFIG})`, "the picker's own title says the number in force is the file's, and not the operator's");
    }));

  it("stops claiming the config once the operator states one", () =>
    totalRowOver({ maxConcurrent: 12 }, (text) => {
      assert.equal(text, `${displayName(CEILING_LABEL)}: 12 concurrency`, "the stated total, not the default it replaced");
    }));

  it("offers the same numbers an agent's concurrency cap does, because it is the same cap", () => {
    // Two different lists for one concept is how an operator ends up able to set a total
    // no per-agent cap can reach, with neither screen explaining the asymmetry. Stated,
    // so the way back to the config file is on the screen too.
    const picker = ceilingPickerProps({ value: 12, stated: true, bounded: null });
    assert.deepEqual(titlesOf(picker), [...CAP_CHOICES.maxConcurrent.map(String), "Use the config default", BACK_LABEL]);
    assert.doesNotMatch(picker.title, /lane/i);
  });

  it("has a way back to the LIST, and looking at the total creates no file", () =>
    // The total's picker had the same hole as an agent's and the same fix: `replace`
    // leaves nothing to pop back to, so without this row the only way out of reading the
    // total's values was to set one of them. Asserted over a project that has never
    // written an overlay, because that is the state where a read that creates a file
    // would be least expected.
    withOpen(async (host, directory) => {
      await pressRow(CEILING_LABEL, "the total is a row, so it is reachable at all")(host);
      await choose(host, backRow(host));
      assert.equal(top(host.seen).title, "Task limits", "the list, whose FIRST row is the total it bounds");
      assert.equal(existsSync(join(directory, AGENT_OVERLAY_FILE)), false,
        "no overlay was written, so abandoning the picker wrote nothing at all");
    }));

  it("writes the total where the dispatch path reads it", () =>
    withCeilingWritten((host, directory) => {
      assert.equal(readAgentOverlay(directory).raw.maxConcurrent, 12,
        "the overlay states the total, so the next dispatch is judged against it");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "success" && /total ceiling set to 12/.test(toast.message)),
        "and the operator is told what changed, in the total's own words");
    }));

  it("clears back to the config file, and says that is what it did", () =>
    withCeilingWritten(async (host, directory) => {
      // The screen is the LIST after a write, so the picker has to be re-entered to
      // clear it — the same two round trips any cap takes.
      await pressRowOn(host, CEILING_LABEL);
      await choose(host, clearRow(host));
      assert.equal(readAgentOverlay(directory).raw.maxConcurrent, undefined,
        "the key is gone rather than null, so the reader stops treating it as stated");
    }));

  it("and setting an AGENT's cap afterwards leaves the total alone", () =>
    // The regression this screen exposed. The file is written WHOLE on every edit, and
    // the screen used to rebuild it from its agents alone — so capping an agent deleted
    // the total, under a success toast about the cap. The two halves are one document,
    // not two that happen to share a path.
    withCeilingWritten(async (host, directory) => {
      await pressRowOn(host, "explore");
      // By the cap's LABEL, which is the row's first word: the caps screen carries each
      // figure in the title now (`at once 2`), so the whole title is not what to press.
      await pressRowOn(host, capRow(host, "maxConcurrent").title);
      await chooseValue(host, 2);
      const written = readAgentOverlay(directory).raw;
      assert.equal(written.maxConcurrent, 12, "the total survives an edit to an agent");
      assert.equal(written.agents.explore.maxConcurrent, 2, "and the agent's own cap is what the edit was for");
    }));
});

