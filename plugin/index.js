// The v2 loader's entry directory. opencode 2.0.22 resolves a configured plugin
// with `Host.resolve({directory})`, which REQUIRES a directory and looks for
// `<dir>/server` then `<dir>/index`. A configured FILE is warned and dropped —
// which is why the plugin silently did not load at all on v2 even though its code
// was fine: `plugin: ["…/dist/index.js"]` was never a plugin v2 could see.
//
// This file is that directory's `index.js`. It is an adapter, not a layer: the
// plugin object is built once in dist/ and re-exported unchanged, so there is no
// second place for the shape of the plugin to be decided.
export { default } from "../dist/index.js";