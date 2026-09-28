/**
 * The slot probe: one component in every host slot, each printing its own slot name.
 *
 * A probe is only worth having if it actually shows up, so these cases are about the one
 * thing that can silently go wrong — a slot the host never renders, or a label that is not
 * the name the slot is registered under. The second is the one worth a test: the label and
 * the registration key come from the same value, and a case that reads both back proves
 * they cannot drift.
 *
 * "Every slot" itself is not tested here. It is a BUILD invariant — the list is `satisfies`
 * checked against `keyof TuiHostSlotMap`, and a `Record<Exclude<…>, never>` pin fails
 * `npx tsc --noEmit` the moment the host declares a slot this list misses. A test that
 * counted twelve entries would only re-state the list back at itself.
 */
import { describe, it } from "./support/runner.js";
import assert from "node:assert/strict";
import { slotLabelProps, slotProbePlugins } from "../../dist/tui/slot-probe.js";
import { darkTheme } from "./support/harness.js";

describe("slot probe", () => {
  it("registers one plugin per slot, each under exactly one key", async () => {
    const plugins = slotProbePlugins();
    assert.equal(plugins.length, new Set(plugins.flatMap((plugin) => Object.keys(plugin.slots))).size);
    for (const plugin of plugins) assert.equal(Object.keys(plugin.slots).length, 1);
  });

  it("prints the name of the slot it is registered under", () => {
    for (const plugin of slotProbePlugins()) {
      const [name] = Object.entries(plugin.slots)[0];
      assert.equal(slotLabelProps({ theme: darkTheme() }, name).children, `[${name}]`);
    }
  });
});
