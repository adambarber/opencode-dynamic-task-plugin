/**
 * plugin-entry.ts — the surface the host probes.
 *
 * The host invokes EVERY entry-module export as a candidate plugin function, so
 * the entry exposes exactly one: the default plugin function. Domain readers live
 * in shared modules — this case failed the boot before the move, because probe
 * calls against entry exports failed the plugin load. It is one assertion, and it
 * is the assertion that keeps the entry a boundary rather than a dumping ground.
 */

import { describe, it, assert } from "./support/runner.js";
import * as pluginEntry from "../../dist/index.js";

describe("plugin entry: exposes only the default plugin function", () => {
  it("has no named function exports for the host to probe", () => {
    const named = Object.entries(pluginEntry).filter(
      ([name, value]) => name !== "default" && typeof value === "function",
    );
    assert.deepStrictEqual(named.map(([name]) => name), []);
  });
});
