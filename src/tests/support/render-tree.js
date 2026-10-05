/**
 * src/tests/support/render-tree.js
 * A stand-in for the host's render tree, and the reason it is a stand-in at all.
 *
 * Real renderables cannot be built in this repo's tests. `Renderable`'s constructor
 * initialises the OpenTUI native FFI, which this runtime does not have, so every
 * `BoxRenderable` and `TextRenderable` throws before it exists — verified, not assumed.
 * What CAN be checked without constructing anything is the class shape, and
 * `tui-agent-gauge.test.js` pins that against the shipped classes, so the two facts a
 * stand-in can get wrong stay separated: the shape is proven, only the wiring is stood in.
 *
 * So this is modelled on what the classes really are, not on what would be convenient.
 * Three details came from reading the real thing and each one forecloses a code path that
 * would pass here and fail in the host:
 *
 *   · `getChildren()` is a method; there is NO `children` property on any renderable, so
 *     this builder does not offer one.
 *   · `plainText` is an ACCESSOR on `TextBufferRenderable.prototype` and is ABSENT from
 *     `Renderable.prototype` entirely, so a box answers `undefined` rather than `""`.
 *   · `parent` is a real field, and it is set by `add`, not by the builder alone — a tree
 *     whose parents disagree with its nesting is the classic way a walk finds the right
 *     node in the wrong place.
 */
const box = (children, parent = null) => {
  const node = { getChildren: () => children, parent };
  for (const child of children) child.parent = node;
  return node;
};
const text = (value, parent = null) => ({ getChildren: () => [], parent, get plainText() { return value; } });

/**
 * The host's own tree, shaped as `packages/tui/src/component/prompt/index.tsx` builds it:
 * root → column → column → the footer box at :1656, whose children are the file label, the
 * context figure at :1667, and the commands hint at :1678.
 *
 * `footer: false` builds the same tree with the hint renamed, which is how the FALLBACK path
 * is exercised: a host whose wording moved on is a host with no footer line to find, and the
 * counter has to go somewhere rather than nowhere.
 */
export function renderTree({ footer = true, hint = footer ? "ctrl+p commands" : "palette" } = {}) {
  const line = box([text("/src/project"), text("109.7K (10%)"), text(hint)]);
  const root = box([box([text("a message")]), box([line])]);
  return { line, root };
}
