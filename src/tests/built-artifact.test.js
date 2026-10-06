/**
 * The built plugin, as the host will actually load it.
 *
 * These claims are about `dist/`, not `src/`, because that is the artifact the host
 * imports and the artifact this repo symlinks into its plugin directory. `tsc` proves
 * the source compiles; nothing in the source tree can prove what that build RUNTIME
 * asks the host's machine for — which is why a dependency here broke in production and
 * not in any of the four hundred tests.
 */
//jscpd:ignore-start
import { DIST_DIR, REPO_ROOT, exists, listProdFiles, readSource, siteOf, walkSource } from "./support/corpus.js";
import { assert, describe, it } from "./support/runner.js";
import { join } from "node:path";

//jscpd:ignore-end
/** Every `.js` the build emitted, which is every file the host can import. */
const builtFiles = () => walkSource(DIST_DIR, (file) => file.endsWith(".js"));

/**
 * The specifiers a file asks the loader to find, minus the ones always present.
 *
 * Only value imports count: `import type` is erased by the compiler, so a type-only
 * import of a package the plugin cannot resolve is free — the four modules that read
 * the SDK's shapes this way are why the built plugin has no bare specifier in it.
 */
const importsIn = (text, { typeOnly } = {}) => {
  const pattern = typeOnly
    ? /^import[^;]*?from\s*"([^"]+)"/gm
    : /^import(?!\s+type\b)[^;]*?from\s*"([^"]+)"/gm;
  return [...text.matchAll(pattern)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
};

describe("the built plugin", () => {
  it("asks the host's machine for nothing at all", async (t) => {
    await t.test("every specifier in dist/ is a Node builtin or a relative path", () => {
      assert.ok(exists(DIST_DIR), "dist/ must be built before this claim can be made");
      const offenders = [];
      for (const file of builtFiles()) {
        const { text } = readSource(file);
        for (const specifier of importsIn(text)) offenders.push(`${siteOf(file)} -> ${specifier}`);
      }
      // The plugin is loaded through a symlink into ~/.config/opencode/plugins/, where
      // there is no node_modules and nothing will ever install one. A bare specifier
      // resolves against the LINK path, so the host answers "Cannot find package" and
      // the plugin does not load at all — the whole plugin, over one import.
      assert.deepEqual(offenders, [], "dist/ must import nothing outside itself and node:");
    });

    // The dist claim is the one that matters; this one says WHERE a bare import came
    // from, so the next person to write one is told which file to change.
    await t.test("the source it is built from makes no runtime import either", () => {
      const offenders = listProdFiles()
        .filter((file) => file.endsWith(".ts"))
        .flatMap((file) => {
          const { text } = readSource(file);
          return importsIn(text).map((specifier) => `${siteOf(file)} -> ${specifier}`);
        });
      assert.deepEqual(offenders, [], "a bare import in src/ becomes a bare import in dist/");
    });
  });

  it("keeps the host's reserved error prefix to itself", async () => {
    const { OverlayRpc } = await import(join(DIST_DIR, "shared", "overlay-rpc.js"));
    const reserved = Object.values(OverlayRpc.methods)
      .flatMap((method) => Object.keys(method.errors ?? {}))
      .filter((name) => name.startsWith("rpc."));
    // The one check `@opencode/schema`'s `Rpc.define` performs, kept here because that
    // package cannot be imported at runtime. A declared error the host reserves would
    // be refused at registration, taking the whole plugin down over a name.
    assert.deepEqual(reserved, [], "a declared error name must not start with the host's reserved prefix");
  });

  it("is a directory the host can point at, with both entrypoints", () => {
    for (const entry of ["index.js", "tui/index.js"]) {
      assert.ok(exists(`${REPO_ROOT}/dist/${entry}`), `dist/${entry} is one of the entrypoints the host probes`);
    }
  });
});