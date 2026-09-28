/**
 * src/tui/agent-gauge.ts
 * The live agent counter that sits beside the host's own context counter.
 *
 * It is a MUTED number in a corner, and that is the whole design. It is not a gauge
 * panel: there is no heading, no bar, no per-agent breakdown, and nothing to click. What
 * it answers is one question an operator asks constantly and cannot otherwise answer
 * without leaving the prompt — "how full am I?" — and it answers it in the same tone as
 * the context percentage beside it, so the eye can pass over it.
 *
 * It counts LIVE, and that word is the whole difficulty. This is a different process from
 * the one that owns the tasks: the server has the store, this has nothing. So the count
 * comes from the LEDGER, which is the durable projection the store is itself hydrated
 * from, read by `loadTaskLedger` — the one reader that validates, so the half it hands
 * back is the half the server would have restored. And the number itself comes from
 * `foldActiveByAgent`, the same fold `task_list` and the capacity gate read, because a
 * counter that had its own idea of "running" is a second definition of the one fact the
 * operator is about to trust.
 *
 * The cap is the cross-agent total, resolved the way the LIMITS SCREEN resolves it — the
 * same config, the same overlay, the same reader — so the number on the corner and the
 * number in the dialog are the same number by construction rather than by agreement.
 *
 * Liveness comes from watching the ledger's DIRECTORY, and the reason is a fact about
 * how the file is written rather than a preference: `saveTaskLedger` writes a temporary
 * file and renames it over the target, so the file's identity changes on every write. A
 * watch on the file follows the old inode and goes deaf after the first write — a
 * counter that updates once and then silently lies for the rest of the session, which is
 * worse than a counter that never updated at all.
 */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { TuiSlotContext, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { BaseRenderable, CliRenderer, fg, Renderable, StyledText, TextRenderable, type RGBA, type TextChunk } from "@opentui/core";
import { applyAgentOverlay, readAgentOverlay, type AgentCapSource } from "../shared/caps.js";
import { readDynamicTaskPolicy, type DynamicTaskConfig } from "../shared/config.js";
import { loadTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { foldActiveByAgent, totalActiveOf } from "../shared/occupancy.js";
import { screenTokens } from "./theme.js";

/**
 * The FALLBACK slot — used when the host's own footer line cannot be found in the tree.
 *
 * The whole host slot vocabulary is twelve names, from `TuiHostSlotMap` in the installed
 * `@opencode-ai/plugin`:
 *
 *     app · app_bottom · home_logo · home_prompt · home_prompt_right
 *     session_prompt · session_prompt_right
 *     home_bottom · home_footer · sidebar_title · sidebar_content · sidebar_footer
 *
 * None of them is the row the CONTEXT figure is drawn in, and that is not an omission in
 * the plugin API. In `packages/tui/src/component/prompt/index.tsx` the footer is
 * hand-built JSX with no hook in it at all:
 *
 *     <box gap={2} flexDirection="row">               // :1656
 *       <Show when={editorContextLabelState() ...}>    //   the file label
 *       <text fg={theme.textMuted} wrapMode="none">   // :1667  <-- 169.6K (16%)
 *         {[item().context, item().cost].filter(Boolean).join(" · ")}
 *       </text>
 *       <text fg={theme.text}>                        //        ctrl+p commands
 *         {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
 *       </text>
 *     </box>
 *
 * Every child of that box is a literal element, so no slot can place a node on that line.
 * The route does hand the plugin a `right` region, and it is a real one
 * (`routes/session/index.tsx:1330`), but the host renders it in its OWN row
 * (`component/prompt/index.tsx:1479-1483` — `<box flexDirection="row" gap={1}
 * alignItems="center">{props.right}</box>`), a row ABOVE this one. That is why the counter
 * kept landing where the operator did not ask for it, and why it is a fallback now:
 * `footerLineOf` reaches the real line through the renderer instead.
 *
 * The muted tier is the one thing this got right from the start — the host draws the
 * context figure in `theme.textMuted`, the role `screenTokens().context` resolves to.
 */
export const GAUGE_SLOT = "session_prompt_right";

/**
 * The host's commands hint — the anchor the footer line is found by.
 *
 * A user-visible string rather than an id or a class, because the host sets neither on
 * that box and neither would survive a rename anyway. This is the wording the operator
 * reads every session, so it is the most stable thing available, and a host that changed
 * it would be a host whose footer a human would also notice.
 */
export const FOOTER_ANCHOR = "commands";

/**
 * The part of a renderable the search touches — `Pick`ed off the real class, not written
 * out by hand.
 *
 * `getChildren` and `parent` are taken from `BaseRenderable` so this cannot drift from the
 * host: a renamed member is a compile error here rather than a search that quietly finds
 * nothing at runtime. `plainText` is the one member that is NOT on `BaseRenderable` — it
 * lives on `TextBufferRenderable`, the subclass that carries text — so it is added as
 * optional, which is also the honest reading of a box: a box has no text and answers
 * `undefined` rather than `""`.
 *
 * Real renderables cannot be built in this repo's tests — `Renderable`'s constructor
 * initialises the OpenTUI native FFI, which this runtime does not have, so every one of them
 * throws before it exists. Hence a structural type rather than `Renderable` itself: it is the
 * one thing a test can satisfy while production still passes the real `renderer.root`.
 */
export type TreeLike = Pick<BaseRenderable, "getChildren" | "parent"> & { plainText?: string };

/**
 * The first node whose text ends with the host's commands hint, or null.
 *
 * `plainText` is optional on the type because a box genuinely has none — see `TreeLike` —
 * so the guard is a real question rather than a formality. This is the whole search: a depth
 * -first walk, and a host with no such text is a null rather than a guess.
 *
 * Typed at the base class rather than the caller's, because `BaseRenderable` types both
 * `getChildren` and `parent` at itself while a real tree is heterogeneous — boxes and texts
 * are different subclasses. One cast at the boundary buys a plain recursion.
 *
 * The walk, in the type the base class actually hands out.
 *
 * `BaseRenderable.getChildren` and `.parent` are typed at `BaseRenderable`, while a real
 * tree is heterogeneous — boxes and texts are different subclasses — so this cannot be
 * generic over the caller's narrower type without a cast per step. The two exported
 * wrappers below pay that cast ONCE each, at the boundary, and keep the recursion here
 * plain.
 */
function anchorWithin(node: TreeLike, anchor: string): TreeLike | null {
  if (typeof node.plainText === "string" && node.plainText.trimEnd().endsWith(anchor)) return node;
  for (const child of node.getChildren()) {
    const hit = anchorWithin(child, anchor);
    if (hit) return hit;
  }
  return null;
}

/**
 * The box that holds the host's footer line, or null when it is not in this tree.
 *
 * The ANCHOR's parent, not an ancestor: the hint is a direct child of that box, and taking
 * the parent rather than the nearest enclosing box is what makes the counter a SIBLING of
 * the context figure instead of a child of whatever happens to contain it.
 */
export function footerLineOf<T extends TreeLike>(root: T, anchor: string = FOOTER_ANCHOR): T | null {
  // `?.` yields `undefined` on a miss, and the contract says `null`. A caller that
  // compared against null would silently be comparing against undefined.
  return (anchorWithin(root, anchor)?.parent as T | undefined) ?? null;
}

/** What the counter shows: children running, and the total they are counted against. */
export type GaugeReading = { active: number; cap: number };

/** The api fields this counter needs, and no more. */
type GaugeApi = {
  state: { path: { directory: string } };
  theme: Parameters<typeof screenTokens>[0];
  /** Optional because a missing renderer must cost the counter its ideal placement, not
   * the TUI its prompt: the fallback slot is a working mount, and crashing a mount over a
   * layout preference would be the worst possible trade. */
  renderer?: CliRenderer;
  /** Told WHERE the counter landed, once. Not a logger: the mount reports a fact and the
   * composition root decides what to do with it, so this module neither knows the host's
   * log call nor formats an error. */
  onPlacement?: (placement: GaugePlacement) => void;
};

/**
 * Where the counter ended up, as a fact rather than a sentence.
 *
 * A placement that is invisible cannot be debugged from the inside, and this one is decided
 * by facts no test here can see: whether the host handed over a renderer, whether its tree
 * held the commands hint, and whether a node could be built at all. The last is the one
 * that matters — the plugin bundles its OWN `@opentui/core`, separate from the copy
 * compiled into the host, and a renderable built across that boundary is not obviously one
 * the host's render loop will draw. Guessing at that is how two restarts get spent.
 *
 * `refusal` is the raw thrown value, not a string, so the one place that formats unknown
 * throwables stays the place that formats unknown throwables.
 */
export type GaugePlacement =
  | { readonly at: "footer" }
  | { readonly at: "slot"; readonly because: "no-renderer" | "no-footer-line"; readonly refusal?: unknown };

/** Say where the counter landed, if anyone is listening, and only ever once. */
function report(api: GaugeApi, placement: GaugePlacement): void {
  api.onPlacement?.(placement);
}



/**
 * What the counter shows, and the mark that carries it.
 *
 * `liveAgents / totalAgentsCap` is the shape an operator already reads for a fraction,
 * and the numerator is the part that changes. The denominator is the same
 * `N/M` the reference sidebars use for a value with a ceiling (`148/158`), so the
 * corner is a row of the same kind as the rest of the interface rather than a
 * new convention to learn.
 */
export function gaugeText(active: number, cap: number): string {
  return `${active}/${cap}`;
}

/** The counter's runs, in the tone the context counter beside it is drawn in. */
export function gaugeRuns(active: number, cap: number, muted: RGBA): TextChunk[] {
  return [fg(muted)(gaugeText(active, cap))];
}

/**
 * The counter, as the value a slot hands the host.
 *
 * A `StyledText` and not a JSX element, and for the reason the cell footers in `theme.ts`
 * already state: a hand-built element needs an ACTIVE RENDERER, which a props builder
 * does not have outside a test, and a `StyledText` is plain data that
 * `TextNodeRenderable.add` names among the child types it takes. A counter is the last
 * thing that should be able to take the TUI down because a renderer was missing.
 *
 * `muted` is passed in rather than read from a theme here, which is what lets every
 * number in this file be asserted on under `node --test` with no host and no renderer.
 * The role is the caller's decision because the role is a claim about the SCREEN, and
 * this module is only the number.
 */
export function gaugeStyledText(active: number, cap: number, muted: RGBA): StyledText {
  return new StyledText(gaugeRuns(active, cap, muted));
}

/**
 * The pair the counter shows, read from disk.
 *
 * Both halves are read where the limit dialog reads them — the project directory the
 * host gave us, never process CWD — and neither throws. A ledger that cannot be read
 * reports zero running, because that is what the server would have booted with: a
 * discarded ledger leaves an empty store, and a counter reading `3/4` beside a server
 * that believes nothing is running is a number the operator cannot act on.
 */
export function readGauge(directory: string, base: DynamicTaskConfig): GaugeReading {
  const ledger = loadTaskLedger(resolveTaskLedgerPath(directory));
  const overlay = readAgentOverlay(directory);
  // `applyAgentOverlay` returns null for a file that said nothing usable, in which case
  // the base config IS the policy — the same resolution the limits screen's cells make,
  // so a cap set in the dialog moves this number with it.
  const policy: AgentCapSource = applyAgentOverlay(base, overlay.raw) ?? base;
  return {
    active: totalActiveOf(foldActiveByAgent(ledger.active.values())),
    cap: policy.maxConcurrent,
  };
}

/**
 * Whether a directory-watch event is about the ledger.
 *
 * A pure rule, extracted so it can be checked without a filesystem, because what the
 * PLATFORM reports is a separate question and a case that waits for a named event only
 * passes on the platform it was written on. macOS in particular reports a null filename
 * for a non-recursive directory watch, so this rule is consulted with nothing on some
 * machines and with a name on others, and both have to be right.
 *
 * A null filename answers TRUE deliberately. It means the platform could not say which
 * path changed, and the two mistakes are not symmetric: re-reading the ledger is a cheap
 * idempotent parse, while declining to look is a counter frozen at whatever it said when
 * the session opened — a number the operator has no way to tell is stale. The cost of
 * saying yes too often is paid by `refresh`, which discards a pair that did not move.
 */
export function isLedgerEvent(filename: string | Buffer | null | undefined, wanted: string): boolean {
  if (filename === null || filename === undefined) return true;
  return String(filename) === wanted;
}

/**
 * Watch the ledger and call `onChange` whenever it is rewritten.
 *
 * A watch on the DIRECTORY, filtered by name, because the write is an atomic rename:
 * `fs.watch` on the file keeps reporting events for the inode it was given, and the
 * inode the host will replace is a different one. Watching the directory also means a
 * ledger that does not exist yet — a first boot — is seen appearing.
 *
 * Never throws and never rejects. A platform or filesystem that refuses to watch is a
 * counter that stops updating, and a counter frozen at its first reading is still the
 * truth it was when it was taken; refusing to mount the TUI over it would not be.
 * Returns the watcher so the caller can close it, and null when watching was refused.
 */
export function watchLedger(directory: string, onChange: () => void): FSWatcher | null {
  const ledgerPath = resolveTaskLedgerPath(directory);
  const wanted = basename(ledgerPath);
  try {
    return watch(dirname(ledgerPath), (_event, filename) => {
      if (isLedgerEvent(filename, wanted)) onChange();
    });
  } catch {
    return null;
  }
}

/**
 * The counter, mounted on the host's own footer line.
 *
 * Two paths, and the order is the design. The FIRST is the real line: find the box holding
 * the host's commands hint in the live tree and add a sibling text to it, which is what
 * puts `N/M` on the same row as the context figure and the shortcut hints. The SECOND is
 * the `session_prompt_right` slot, used only when the walk finds nothing — a host that
 * renames the hint, or a screen with no prompt at all. A fallback is not a nicety here:
 * without it a changed hint would take the counter away entirely, and a counter the
 * operator can see in the wrong place is worth more than one they cannot see.
 *
 * The renderer is public API and `Renderable.add`, `parent` and `getChildren` are public
 * members, so this is not reaching into host internals — it is reading the same tree the
 * host is already drawing. It IS coupled to the host's layout, which is the real cost, and
 * the fallback is what makes that cost survivable rather than silent.
 *
 * Liveness is the ledger watch, and the node is re-read and re-set rather than rebuilt: a
 * new `TextRenderable` per tick would churn the host's layout on every task transition.
 * The re-add check is for the same reason the fallback exists — the host owns that box and
 * its reconciler may drop a node it did not create, so a node that finds itself detached is
 * put back rather than left silently invisible.
 */
export function mountGauge(api: GaugeApi): TuiSlotPlugin {
  return { slots: { [GAUGE_SLOT]: deferredCounter(api) } };
}

/**
 * The counter, mounted on the host's own line when there is one, and in the slot when not.
 *
 * The WALK IS DEFERRED INTO THIS FUNCTION, and that is the whole trick of the mount. This
 * plugin loads at startup, before any session is open, so a walk at mount time would find
 * an empty tree and — having found nothing — never look again. There is no lifecycle hook
 * for "first paint" (`TuiLifecycle` carries an `AbortSignal` and `onDispose`, and nothing
 * else), but there IS a reliable signal that the prompt exists: the host CALLS this, because
 * it calls a slot's renderer when it draws that slot's region, and the region is inside the
 * prompt. So the one moment the tree is known to be walkable is the one moment the host
 * hands us.
 *
 * Which also settles the fallback. An empty return is invisible: the host's row at
 * `component/prompt/index.tsx:1479-1483` is gated on `hasRightContent()`, which is a memo
 * over the `right` PROP and therefore true whether or not this function has anything to
 * say — the row was empty before this plugin existed and nobody saw it. So attaching to the
 * real line and returning nothing leaves no trace in the slot, and returning the counter here
 * is the fallback the operator sees rather than no counter at all.
 *
 * The attach is attempted once and remembered. This runs on every re-render of the region,
 * and a second `add` would stack a second `N/M` on the host's line.
 */
export function deferredCounter(api: GaugeApi): (ctx: TuiSlotContext) => JSX.Element | null {
  const directory = api.state.path.directory;
  const base = readDynamicTaskPolicy(directory, null);
  const muted = createMemo(() => screenTokens(api.theme).context);
  let attached = false;
  return (ctx) => {
    if (!attached) {
      const join = footerLineToJoin(api);
      if (!join) {
        report(api, { at: "slot", because: api.renderer?.root ? "no-footer-line" : "no-renderer" });
      } else {
        const attempt = attachToFooterLine(join.renderer, join.line, muted(), directory, base);
        attached = attempt.handle !== null;
        report(api, attached ? { at: "footer" } : { at: "slot", because: "no-footer-line", refusal: attempt.refusal });
      }
    }
    if (attached) return null;
    return jsx("text", gaugeProps(screenTokens(ctx.theme).context, readingSignal(directory, base)) as Record<string, unknown>);
  };
}

/**
 * The host's own footer line, or null when this host has not got one to join.
 *
 * The DECISION, split from the construction beside it, because only the decision is
 * testable. Two things stop the rest: a real `TextRenderable` needs the OpenTUI native FFI,
 * and `jsx` from `@opentui/solid/jsx-runtime` is EAGER — it calls `createElement` on the
 * spot and throws "No renderer found" without one. Folding the two together would mean the
 * walk had no case of its own and the only thing under test was a refusal.
 *
 * The renderer is read rather than assumed, because `api.renderer` is a host object crossing
 * a process boundary and the one thing a mount must never do is take the prompt down over a
 * layout preference. A renderer with no tree, or a tree with no commands hint in it, costs
 * the counter its ideal placement and nothing else.
 */
export function footerLineToJoin(api: GaugeApi): { renderer: CliRenderer; line: Renderable } | null {
  const renderer = api.renderer;
  const root = renderer?.root;
  if (!renderer || !root) return null;
  const line = footerLineOf(root);
  return line ? { renderer, line } : null;
}

/**
 * The reading as a SIGNAL, for the slot's Solid child to close over.
 *
 * `gaugeProps` takes a function precisely so a caller can hand it a signal, and a signal is
 * what a Solid child re-derives from. The setter compares the PAIR first, because a
 * directory watch reports every file in the project — and where the platform cannot name the
 * one that changed, it reports nothing at all, so an unrelated save arrives here too. A
 * signal set to a freshly-read but identical pair re-renders the corner for a number that
 * did not move, and over a session of ordinary editing that is most of the events this
 * counter will ever see.
 */
function readingSignal(directory: string, base: DynamicTaskConfig): () => GaugeReading {
  const [reading, setReading] = createSignal(readGauge(directory, base));
  const refresh = () => {
    const next = readGauge(directory, base);
    if (next.active === reading().active && next.cap === reading().cap) return;
    setReading(next);
  };
  const watcher = watchLedger(directory, refresh);
  onCleanup(() => watcher?.close());
  return reading;
}

/**
 * The node this counter owns, and the two things that can happen to it.
 *
 * Returned rather than closed over so the mount has a handle it can detach, and so a test
 * can hold one without a renderer.
 */
export interface GaugeHandle {
  /** Re-read the ledger and move the text, if the pair moved. */
  refresh(): void;
  /** Stop watching and take the node out of the host's line. */
  dispose(): void;
}

/**
 * Add the counter to the host's footer line, as a sibling of its own text.
 *
 * Returns null — never throws — when the line will not take a node, so a caller that also
 * has a slot to fall back on always has somewhere to go.
 */
export function attachToFooterLine(
  renderer: CliRenderer,
  line: Renderable,
  muted: RGBA,
  directory: string,
  base: DynamicTaskConfig,
): { handle: GaugeHandle | null; refusal?: unknown } {
  let reading = readGauge(directory, base);
  let node: TextRenderable;
  try {
    node = new TextRenderable(renderer, { fg: muted, content: gaugeText(reading.active, reading.cap) });
    line.add(node);
  } catch (error) {
    return { handle: null, refusal: error };
  }
  /**
   * Re-read, and touch the node only if the PAIR moved.
   *
   * One function for both callers — the ledger watcher and the returned handle — because
   * two copies of this is two places for a re-attach check to be forgotten in.
   */
  const refresh = () => {
    const next = readGauge(directory, base);
    if (next.active === reading.active && next.cap === reading.cap) return;
    reading = next;
    try {
      node.content = gaugeText(reading.active, reading.cap);
      // The host owns this box. If its reconciler dropped a node it did not create, the
      // counter would go invisible with no error anywhere, so a detached node goes back.
      if (node.parent !== line) line.add(node);
    } catch {
      return;
    }
  };
  const watcher = watchLedger(directory, refresh);
  return {
    handle: {
      refresh,
      dispose: () => {
        watcher?.close();
        try {
          line.remove(node);
        } catch {
          return;
        }
      },
    },
  };
}

/**
 * The element's props, as a value the host will spread onto a `text`.
 *
 * Split out because these props ARE the design, and a design that can only be seen by
 * restarting a TUI is a design nobody can review. A case can read this object; it cannot
 * read the element `jsx` makes from it, which needs a renderer. So the part that decides
 * where the counter sits and what colour it is lives here, and the one line that turns it
 * into an element lives in the slot body.
 */
export function gaugeProps(muted: RGBA, reading: () => GaugeReading): Record<string, unknown> {
  return {
    fg: muted,
    /**
     * An auto left margin, and NOT `alignSelf`.
     *
     * The slot's container is a ROW — `packages/tui/src/component/prompt/index.tsx`
     * renders it as `<box flexDirection="row" gap={1} alignItems="center">{props.right}</box>`,
     * and the route hands the slot in as the prompt's `right` prop. In a row the main axis
     * is horizontal, so the cross axis `alignSelf` acts on is VERTICAL: an `alignSelf` here
     * moves the counter up and down, and `justifyContent` defaults to packing children
     * left, which is why a bare `<text>` lands at the left margin. `marginLeft: "auto"`
     * claims the free space on the left instead, which is the one way to sit at the right
     * edge of a row you do not own. Yoga accepts `auto` here, and the type says so.
     */
    marginLeft: "auto",
    // A FUNCTION, not a string. `content` takes a value and this is what makes the
    // counter live: Solid re-invokes the child when the signal it closes over moves, and
    // the signal moves on the ledger's next write.
    children: () => gaugeText(reading().active, reading().cap),
  };
}

