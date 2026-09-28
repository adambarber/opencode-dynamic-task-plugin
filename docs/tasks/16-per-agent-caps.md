# 16 — Per-agent caps, dispatch depth, and the TUI that manages them

## Why

Two limits govern every dispatch, and until now they were flat, invisible, and
frozen at boot:

- `maxConcurrent` is one global count, so four cheap `explore` children can
  occupy every slot and starve the implementation work you actually wanted.
- `maxDepth` is one global number, and when a dispatch is refused the message
  cannot tell you which constraint bound — your cap, or the agent set.

"Manage" means view and adjust, without restarting opencode.

## What a cap hangs off

A cap is keyed by **the agent a dispatch already names**. `agents.explore.
maxConcurrent` is how many `explore` children may run at once;
`agents.explore.maxDepth` is how deep an `explore` may be dispatched. The
top-level `maxConcurrent` and `maxDepth` are the **fallback** for any agent that
does not state its own, which is what makes them a floor rather than a
competing setting.

Per-agent caps **partition** concurrency, they never multiply it. The top-level
`maxConcurrent` stays a ceiling across every agent, so a config with eight
agents capped at four still runs at most four at a time. With nothing
configured the behaviour is byte-for-byte what it was: one number, applied to
everything.

### Why not a lane

This was a lane feature first, and the lane is gone. A lane was a **second name
the operator had to invent**, declare in the config before it was admissible,
and then pass on every dispatch meant to spend it. That bought three affordances
— add, delete, and a "default" standing in for one nobody had declared — and
cost a second gate to keep the two names in step. A screen listing both looked
like two settings where one was a default and the other a departure from it.

Keying by the agent the dispatch already supplies deletes the vocabulary, and
with it every affordance that was compensating for it. The screen is one row per
**registered agent**, which is a list the plugin does not own and therefore
cannot get out of step with.

Two fields went with it. `TaskRecord.lane` was a routing key on a record that
already carried `agentName`, and the two were free to disagree — which is how a
capped agent could be filled by children dispatched as something else. And the
spawn tool's `lane` argument is gone, so a model no longer has to know a
vocabulary in order to dispatch.

The retired overlay, `<project>/.dynamic-task-lanes.json`, is **reported at boot
and never read**. Its keys were operator-invented, and no map from lane to agent
is one the plugin can justify. A file of empty bodies would apply caps under
keys nobody wrote, silently. A leftover file produces a warning naming it,
because an operator whose cap worked yesterday and does not today has no other
way to tell a mis-set number from a file that stopped being read.

## The cap concept has one owner

`src/shared/caps.ts` owns the whole thing: the vocabulary (`AGENT_CAP_NAMES`,
`AgentCaps`), the agent key space (`agentKey`, `resolveAgentCaps`), the capacity
judgment (`checkAgentCapacity`), the occupancy view (`agentOccupancy`), and the
durable overlay. It imports nothing but `node:fs`, `host-shape`, and
`task-policy`.

That narrowness is load-bearing rather than tidy. The store needs
`checkAgentCapacity` to judge a claim, so `caps → task-state` would be a cycle,
which is why the count crosses the boundary as a **map of numbers** instead of
the store: this module can judge occupancy without knowing what a task is.

It is one module because those five questions have to change together. While they
lived in five — config holding the shape, an overlay module holding the file, a
third holding the view, the store holding the count, the gate holding the
judgment — the concept had **no owner**, and re-keying it touched fifteen
production files for what is one lookup, with nothing in the type system saying
so. A concept without an owner is a change with a fan-out instead of a seam.

`config.ts` owns **precedence** (which of env, options, file, overlay wins) and
imports the shape from `caps.ts`; `caps.ts` owns **meaning**. A config that also
judged its own numbers had two answers to "how many of this agent may run", and
the one that happened to be called first was the one the operator saw.

`AgentLister` and `LogSink` are typed to the calls they make rather than to the
plugin's whole client, which is what lets the TUI process — holding a different
SDK generation's client — share the server's agent reader. The `app.log` call is
**checked at the boundary** (the `hasQuestionCall` idiom) rather than asserted in
a type that would reject a client that logs perfectly well.

## Where a UI edit is written

A separate, machine-owned file next to the ledger:

    <project>/.dynamic-task-agents.json

The hand-authored config file (`.opencode/dynamic-task-plugin.jsonc`) is never
rewritten by a program, so its comments and formatting survive. The overlay is
plain JSON, fully visible, and deleting it resets every agent to config.

Precedence, strongest first:

    overlay  >  env  >  tuple options  >  config file  >  defaults

The overlay outranks env deliberately. The whole point of the feature is that a
click takes effect; a user who has pinned `DYNAMIC_TASK_MAX_CONCURRENT=1` and
then clicks a higher cap in the UI has expressed a newer intent than the env
pin, and a UI that silently did nothing would read as a broken UI. For a
deployment-grade floor, put the number in the config file.

## The chokepoint

`DynamicTaskConfig` is resolved once at boot and frozen, which is the single
reason a UI cannot manage anything today. The store's **one** capacity judgment,
`agentCapacityRefusal`, resolves the overlay on its way through — so policy is
live for every claim without a restart, and the spawn tool's advisory pre-check
and the authoritative gate cannot disagree about what "full" means. A settled or
already-admitted task keeps the cap it was admitted under: a cap governs
admission, not the tasks already running.

Reads are one small `readFileSync` per claim. Dispatches are human-scale, so this
is not a hot path, and it is a file read rather than a watcher: no handle to leak,
no event to miss.

An agent's name is folded through `agentKey` on **both** the read and the write.
A dispatch supplies the host's spelling, a config key is whatever the operator
typed, and folding only one side is how a cap an operator set applies to no agent
at all — no error, no refusal, just an agent running uncapped under a cap they
can see. The same fold is in the running-task count, because undercounting a busy
agent is the one direction of error that never announces itself.

**The fold is on the KEY; the record keeps the host's spelling.** Both sides
folding was the rule, and it used to be satisfied by baking the folded name into
the record at registration — which is lossy in a way the counts cannot see. The
`agentName` in a retained or active record is what `task_list`, `task_result` and
the TUI all print, so a record written for a host agent spelled `Explore` claimed
`explore`, and the claim was unfalsifiable: the counts stayed correct, every cap
kept working, and the only evidence was a word on a screen that disagreed with
the host. Folding at the key instead — `foldActiveByAgent` groups by `agentKey`
and the record is untouched — gives the same equality on both sides with no lie
in the value, and leaves the host's spelling available for anything that has to
name the agent to the host rather than to a person. The compiler cannot enforce
this, so the invariant is a case: dispatch to an agent whose host name differs
from its folded key and read the count.

## Depth, and the binding constraint

A per-agent `maxDepth` is a **placement limit**: the deepest generation at which
THAT agent may be dispatched. `maxDepth: 1` on `explore` means it is a direct
child and never nested. It is only meaningful because it is scoped — a depth
printed on a row that in fact applied to every row would be a number the operator
could edit in one place and have change everywhere.

`allowSameAgentRecursion: false` means a generation may not repeat an agent name,
so the achievable depth is also bounded by how many distinct dispatchable agents
exist. The view therefore reports an *effective* depth and names the constraint
that binds (`DepthBound.AgentCap` or `AgentSet`), because "maxDepth: 4" that
silently means 2 is the kind of thing an operator cannot debug from an error
string. The refusal names the **agent**, not a lane: the cap arrives already
resolved from the agent being dispatched, so it is the only name there is.

The host's own same-agent rule is **unverified**. The error text that motivated
this feature is ours (see `src/shared/task-policy.ts`), and the host binary does
not contain that sentence.

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
`src/tests/tui-limits-command.test.js` against the host's documented field list,
each one falsifiable against the shape it replaces.

Every element is the SDK's own. Nothing is drawn. Three screens, all
`api.ui.DialogSelect`:

1. **The list.** One row per registered agent, each showing **both** caps side by
   side in its `footer` (`explore · at once 1 · depth 1`). An agent whose cap
   falls back to the config file says so — `at once 4 from config` — because an
   agent at 4 by default and one deliberately set to 4 are otherwise the same
   row, and those are two different answers to "did I do that?". The rows come
   from `dispatchableAgentNamesOrNull`, so the screen is populated on a project
   that has never been configured. No `placeholder`: the host's own default reads
   "Search", and matching every other dialog beats a hint of our own.
2. **One agent's caps**, as a row per cap with the value in `footer` — the one
   field the host draws outside the clipping text, so a number is never cut off.
   The host has no form widget, so a two-field form is a list whose rows are
   fields, and that is the better answer anyway. This screen exists because a
   list row is two fields wide and one press deep: opening a value list straight
   from the row left the depth cap **unreachable**, which a test driving the flow
   found by asserting the screen it had been told to expect. A setting that is
   visible and not editable is worse than one that is not shown.
3. **One cap's values**, as a list of the numbers it can take, with the value in
   force marked `in force`, plus `Use the config default` when the overlay states
   that cap. A list rather than a text box: typing `2` is three keystrokes and an
   opportunity to type `2k`, and the cap an operator sets is almost always one of
   a handful. `CAP_CHOICES` is a `Record` over `AgentCapName`, so a new cap with no
   values will not compile.

`api.ui.toast` confirms a write, refuses an unusable answer, and warns about an
overlay the dialog could not read. There is no custom route and no bespoke widget.

A change lands back where it was asked from, which is why the destination is an
**argument**: a value chosen lands on that agent's caps, because the other cap of
the same agent has to be one keypress away rather than a trip through the list.
The write **re-reads before landing** — a write makes the view the caller is
holding out of date, and landing on that one re-mounts the number the operator
just replaced. `All agents` is a row rather than a nicety: the host's `replace`
sets the dialog stack to a single entry, so there is no previous screen to pop
back to and escape leaves the manager entirely.

`details` is absent from the published `TuiDialogSelectOption` although the host
reads it. The prop is returned by SPREAD rather than spelled out, because a spread
is not excess-property-checked and a cast is not permitted here — an escape hatch,
sound only because the field was read in the host's own source at the tag this
binary was built from. That is a fact about a file we do not own, so
`fitsItsDialog` re-derives the host's layout and fails the build if the content
stops fitting it.

One thing about honesty in the dialog, because the TUI is a different process
from the server and cannot see its memory:

- **Inherited caps are the DEFAULTS.** The TUI cannot see the config file's tuple
  options or the project options file, so a cap that falls back is the config's
  defaults rather than this process's truth. The overlay's own caps — the ones
  the dialog edits — are unaffected, and every cell says which it is.
- **No occupancy is shown, and none is read.** The row used to carry a count read
  from the ledger, labelled `as last recorded`. That is the last RECORDED set, not
  a live gauge, and printing it beside a cap gave the operator reason to distrust
  the one number they could act on. So the read is gone rather than made safe:
  `task_list` is where the running set is, and this screen is about limits.

The dialog's logic lives in `src/tui/agent-editor.ts` with no SDK import, so the
part worth checking (what a chosen value is *allowed* to become) is testable
without a terminal. Clearing a cap **deletes** the key rather than writing `null`,
and an agent whose last cap goes leaves the overlay entirely — two spellings of
"no cap" is a reader bug waiting to happen, and a dead entry per experiment is how
an overlay rots.

## One rule for the writer and the reader

`readAgentCapBody` in `src/shared/caps.ts` is the only place that decides what a
cap is, and the dialog reads through it rather than keeping a copy.

They once disagreed, and the seam between them was a safety cap. The dialog's
grammar accepted a zero, wrote `{"maxConcurrent": 0}`, and told the operator it
was "in force on the next dispatch"; the reader requires a positive cap, dropped
it on the next read, and the agent fell through to the top-level default. In this
project that turned a cap of 1 into 4: an operator tightening an agent to nothing
got the loosest cap the config has, under a success message. Nothing in the suite
could see it, because every case asked what the dialog **wrote** and none asked
what the reader would then **read back**.

So the join is asserted now, as an invariant over every value the picker offers,
iterating `CAP_CHOICES` rather than a hand-written list — "offered" and "kept"
being two different lists is the defect. The refusals are asserted alongside, and
the reader also **reports** what it dropped, because a dialog that cannot say what
it ignored shows a cap the dispatch path will not honour as though it applied.

## The harness is checked against itself

`src/tests/tui-limits-command.test.js` drives its scenario wrapper with cases that
**must fail**, and fails unless the rejection reaches the runner. A currying
helper whose unapplied form is itself a plausible case function is a trap with no
type to catch it: the wrapper was `given(step)(case)` with no call site applying
the second half, so the case body was never awaited and never ran, and twenty-odd
cases were green because they asserted nothing — including one with a `throw` in
it. A harness that can silently drop a case body is not a harness, and the only
evidence either way is a case that goes red if it breaks.

Not shipped, deliberately: a host slot occupancy gauge, and per-key bindings.

The ambient gauge was built and then removed, and the reason is a host limit
rather than a judgement about the number. The line the operator asked for is
drawn at `packages/tui/src/component/prompt/index.tsx:1656-1687` beside the
context figure, and every child of that box is a literal element, so no slot can
place a node on it. OpenCode 2 mounts it by name
(`context.ui.slot({ replace: "prompt.footer.status" })`, as
`ndom91/opencode-hud` does); 1.x has no such API — `@opencode-ai/plugin` at both
1.18.30 and 1.18.33 declares the same twelve host slots and no `ui.slot`, and
`sst/opencode` at HEAD has zero hits for either. The other twelve seats are real
and none of them is that line: `session_prompt_right` renders in its own row
well above the footer, and `app_bottom` is the terminal's bottom edge. So a
counter on this host is either in the wrong place or nowhere, and nowhere is the
honest answer. `task_list` remains where the running set is, and the caps remain
editable here — the capability is the dialog, not the corner.
