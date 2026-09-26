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
    // The default is pulled out as a binding rather than filtered out by its key,
    // so "everything except the default" is the language's rest-destructuring
    // instead of a name this test has to spell and keep correct.
    const { default: theDefaultPlugin, ...namedExports } = pluginEntry;
    assert.strictEqual(typeof theDefaultPlugin, "function", "the default export is the plugin function itself");
    const named = Object.entries(namedExports).filter(([, value]) => typeof value === "function");
    assert.deepStrictEqual(named.map(([name]) => name), []);
  });
});
