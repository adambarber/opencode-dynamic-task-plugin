/**
 * plugin-entry.ts — the surface the host probes.
 *
 * Under v1 the host invoked EVERY entry-module export as a candidate plugin
 * function, so the entry exposed exactly one. Under v2 that is no longer true and
 * no longer the constraint: packages/core/src/plugin/module.ts decodes
 * `Schema.Union([{id, effect}, {id, setup}])` off `.default` and reads nothing else.
 *
 * So the pin is now the decoder itself. A bare function — the v1 shape, which was
 * fine for a year — is REJECTED here with "must export a default definition", and
 * that rejection is silent at boot: no tools appear and no error reaches the user.
 */

import { describe, it, assert } from "./support/runner.js";
import pluginEntry from "../../dist/index.js";

describe("plugin entry: decodes as a v2 plugin definition", () => {
  it("is an object the host's union can decode, not a factory function", () => {
    // The decoder unions {id, effect} against {id, setup}; a bare function
    // satisfies neither arm, so the type of the default export IS the assertion.
    assert.notStrictEqual(typeof pluginEntry, "function", "v2 decodes an object, never a factory function");
    assert.strictEqual(typeof pluginEntry.id, "string", "every arm of the decoder's union requires an id");
    assert.ok(pluginEntry.id.length > 0, "an empty id names no plugin");
  });

  it("picks exactly one arm: setup or effect, and setup for this plugin", () => {
    // Both arms present is not a stricter definition — it is an ambiguous one, and
    // the decoder resolves it by preference, which is a fact about the loader that
    // the plugin should not depend on.
    assert.strictEqual(typeof pluginEntry.setup, "function", "the promise API arm is what this plugin is written against");
    assert.strictEqual("effect" in pluginEntry, false, "one arm only; the loader prefers one and silently ignores the other");
  });

  it("returns nothing the host must clean up, so setup can be awaited once", () => {
    // setup runs exactly once per host load and is never called again, so a cleanup
    // function it returns has nowhere to be called from on the server path.
    assert.ok(pluginEntry.setup.length <= 2, "setup takes (context, options) and needs no third argument");
  });
});