# 16 — Concurrency lanes, dispatch depth, and the TUI that manages them

## Why

Two limits govern every dispatch, and until now they were flat, invisible, and
frozen at boot:

- `maxConcurrent` is one global count, so four cheap `explore` children can
  occupy every slot and starve the implementation work you actually wanted.
- `maxDepth` is one global number, and when a dispatch is refused the message
  cannot tell you which constraint bound — your cap, or the agent set.

"Manage" means view and adjust, without restarting opencode.

## What a lane is

A lane is a named bucket with its own `maxConcurrent` and its own `maxDepth`.
A task joins a lane by name and is counted only against that lane.

Lanes **partition** concurrency, they never multiply it. The top-level
`maxConcurrent` stays a ceiling across every lane, so a config with eight lanes
of four still runs at most four at a time. With no lanes configured the
behaviour is byte-for-byte today's: one implicit `default` lane whose cap is
`maxConcurrent`.

That is the whole safety argument for the feature, and it is why the feature
cannot be used to spend more compute than the operator already allowed.

## Where a UI edit is written

A separate, machine-owned file next to the ledger:

    <project>/.dynamic-task-lanes.json

The hand-authored config file (`.opencode/dynamic-task-plugin.jsonc`) is never
rewritten by a program, so its comments and formatting survive. The overlay is
plain JSON, fully visible, and deleting it resets every lane to config.

Precedence, strongest first:

    overlay  >  env  >  tuple options  >  config file  >  defaults

The overlay outranks env deliberately. The whole point of the feature is that a
click takes effect; a user who has pinned `DYNAMIC_TASK_MAX_CONCURRENT=1` and
then clicks a higher cap in the UI has expressed a newer intent than the env
pin, and a UI that silently did nothing would read as a broken UI. For a
deployment-grade floor, put the number in the config file.

## The chokepoint

`DynamicTaskConfig` is resolved once at boot and frozen, which is the single
reason a UI cannot manage anything today. Admission now reads the overlay at
the one place a dispatch is admitted, so policy is live for every new dispatch
without a restart. A settled or already-admitted task keeps the cap it was
admitted under — a cap governs admission, not the tasks already running.

Reads are one small `readFileSync` per dispatch attempt. Dispatches are
human-scale, so this is not a hot path, and it is a file read rather than a
watcher: no handle to leak, no event to miss.

## Depth and the binding constraint

`allowSameAgentRecursion: false` means a generation may not repeat an agent
name, so the achievable depth is also bounded by how many distinct dispatchable
agent types exist. The view therefore reports an *effective* depth and names the
constraint that binds, because "maxDepth: 4" that silently means 2 is the kind
of thing an operator cannot debug from an error string.

The host's own same-agent rule is **unverified**. The error text that motivated
this feature is ours (see `src/shared/task-policy.ts`), and the host binary does
not contain that sentence. Until a real spawn settles it, the view labels the
depth source as the plugin's own rule and not the host's.

## The TUI

A second module, `src/tui/` → `dist/tui/index.js`, **default**-exporting
`{ id, tui }` and **not** exporting `server` — `TuiPluginModule` is one side or
the other, never both, and the loader rejects a module that is both.

It is registered in `tui.json`, NOT in opencode's `plugin` array:

```jsonc
// .opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["../dist/tui/index.js"]
}
```

Four things in that arrangement are load-bearing, and each of them fails
**silently** — no error, no warning, just a command palette with nothing in it:

- **`tui.json`, not the `plugin` array.** The `plugin` array is the SERVER plugin
  list. A TUI module listed there is a module with no `server` export, so the
  server ignores it. There is no directory auto-discovery for TUI plugins, so a
  module in the wrong file is never loaded at all.
- **Default export.** The loader reads the module's default export and ignores
  named exports. `export const tui` is invisible to it.
- **A non-empty `id`.** It is the module's runtime identity, the key
  `plugin_enabled` uses, and what a later duplicate is rejected against.
- **`namespace: "palette"` on the command.** The host surfaces palette commands
  BY NAMESPACE. A command without one is registered, dispatchable by name and
  runnable from a keybinding, and appears in no list.

None of the four is enforced by the compiler: `Command` carries an index
signature (`[key: string]: unknown`), so a misspelled palette field is silently a
custom field the host never reads. They are pinned in
`src/tests/tui-lane-command.test.js` against the host's documented field list,
each one falsifiable against the shape it replaces.

Every element is the SDK's own. Nothing is drawn:

- a keymap layer with one command, `dynamic-task.lanes`, whose `namespace` is
  `palette` and whose name, title and `slashName` all carry the word — because
  which fields the ctrl+p palette searches is the host's configuration, so the
  word goes in every field we set rather than the one we guessed at. The
  metadata fields are the host's spellings (`desc`, not `description`;
  `slashName`, not the legacy `slash: { name }` of the deprecated
  `api.command` API);
- `api.ui.DialogSelect` to pick a lane or to add one. Adding is a separate
  discriminated choice (`ChoiceKind.Add`), not a magic lane name, so a lane
  called `new` is still a lane;
- `api.ui.DialogPrompt` whose placeholder is the caps as they stand, so the
  operator edits a number they can see;
- `api.ui.toast` to confirm a write, to refuse an unusable answer, and to warn
  about an overlay the dialog could not read.

There is no custom route and no bespoke widget.

Two things about honesty in the dialog, because the TUI is a different process
from the server and cannot see its memory:

- **Occupancy is the last RECORDED set**, read from the ledger with the same
  reader the server uses, and the row says so. A cap shown next to a count that
  may be two dispatches out of date reads as a live gauge, and makes the operator
  distrust the cap — the one number they can act on.
- **Inherited caps are the DEFAULTS.** The TUI cannot see the config file's
  tuple options or the project options file, so a row whose caps come from
  there is labelled `caps from the config file` rather than presented as this
  process's truth. The overlay's own rows — the ones the dialog edits — are
  unaffected.

The dialog's logic lives in `src/tui/lane-editor.ts` with no SDK import, so the
part worth checking (what a typed answer is *allowed* to become) is testable
without a terminal. `off` **deletes** a key rather than writing `null`, which
`exactOptionalPropertyTypes` enforces: two spellings of "no cap" is a reader bug
waiting to happen.

Not shipped, deliberately: a host slot occupancy gauge, and per-key bindings.

## Progression

Shipped: the lane model, the live overlay, lane-aware admission and depth, lane
and effective-depth reporting in the existing tools, and the TUI dialog.

Not shipped, deliberately:

- A live occupancy gauge. It needs the server's running set, which the TUI
  process cannot reach, and the ledger's last-recorded set is a different claim
  wearing the same label.
- A key binding. A palette command is reachable from ctrl+p and from `/lanes`;
  a per-key binding is a global keyboard claim for a settings dialog.
- Editing the config file's own caps from the dialog. It cannot see them, and
  `delete` says whose caps those are rather than pretending to remove them.
