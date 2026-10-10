/**
 * The caps flow end to end on disk: what a chosen value writes, what it leaves alone, and
 * what the operator is told. The design thesis and harness rationale are in
 * `tui-limits-command.test.js`.
 */

import { AGENT_CAP_NAMES } from "../../dist/shared/caps.js";
import { CAP_LABEL } from "../../dist/tui/agent-editor.js";
import { FROM_CONFIG } from "../../dist/tui/theme.js";
import { assert, assertCapsDrawn, BASE, backToCaps, capRow, capText, choose, chooseValue, clearRow, describe, havingWritten, it, readOverlay, rowText, top, valueRow, withCapsOpen, withOpen, withPickerOpen } from "./support/index.js";

describe("the flow, end to end on disk", () => {
  it("a chosen cap lands in the overlay the dispatch path reads", () =>
    withPickerOpen(havingWritten((host) => chooseValue(host, 4))(async (host, directory) => {
      assert.deepEqual(await readOverlay(directory), { agents: { explore: { maxConcurrent: 4 } } },
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
      assert.deepEqual(await readOverlay(directory), { agents: { explore: { maxConcurrent: 4, maxDepth: 3 } } },
        "the cap set first survives the second, which is the whole claim");
    })));

  it("the depth cap is reachable at all, which a single-press row could not be", () =>
    // The hole the flow found. One row carried both values, and one press had to pick a
    // cap to open — so the row opened the concurrency picker and the depth cap had no
    // way in at all. The pair was VISIBLE and half of it was editable, which is worse
    // than showing one, because the screen had said both were settings.
    withCapsOpen(async (host) => {
      assertCapsDrawn(top(host.seen), "back on the agent's caps");
      for (const cap of AGENT_CAP_NAMES) {
        await choose(host, capRow(host, cap));
        assert.match(top(host.seen).title, new RegExp(`explore — ${CAP_LABEL[cap]}`), `${cap} opens its picker`);
        await backToCaps(host, "explore", "and the way back is one level up, on the agent's own caps");
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
      assert.deepEqual(await readOverlay(directory), { agents: {} },
        "an absent key and a zero are different statements, and only one of them means 'no cap'");
    }));

  it("a write that fails says so and confirms nothing, rather than reporting a cap that was not applied", () =>
    // The host's table refuses the write and answers every read, which is the shape an
    // operator meets when the store is full — and the shape a read-only directory used
    // to fake, before the overlay stopped being a file.
    withPickerOpen(async (host, _directory, channel) => {
      // Armed here, not at boot: the seed is a write too, and a refused seed would open
      // a screen that never had caps on it.
      channel.arm("storageWriteThrows");
      await choose(host, valueRow(host, 4));
      assert.ok(!host.seen.toasts.some((toast) => toast.variant === "success"),
        "a refused write must not be confirmed as a cap in force");
      assert.ok(host.seen.toasts.some((toast) => toast.variant === "error" && /could not be stored/.test(toast.message)),
        "and the operator is told the caps could not be stored");
    }));

  it("the figure on a row is the operator's number", () =>
    // The row used to print how many children were charged to it as well, which meant
    // durable state was read to draw the screen. That number is gone, so the figure a
    // row carries can only be the overlay's — 7 here, chosen because no count of work
    // in flight would produce it.
    withOpen((host) => {
      assert.match(rowText(top(host.seen), "explore"), /7 concurrency/);
    }, { overlay: { agents: { explore: { maxConcurrent: 7 } } } }));
});
