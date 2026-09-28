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
import { createSignal, onCleanup } from "solid-js";
import type { TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { fg, StyledText, type RGBA, type TextChunk } from "@opentui/core";
import { applyAgentOverlay, readAgentOverlay, type AgentCapSource } from "../shared/caps.js";
import { readDynamicTaskPolicy, type DynamicTaskConfig } from "../shared/config.js";
import { loadTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { foldActiveByAgent, totalActiveOf } from "../shared/occupancy.js";
import { screenTokens } from "./theme.js";

/**
 * Where the counter sits, and the measurement that put it there.
 *
 * The line the operator asked for is drawn by
 * `packages/tui/src/component/prompt/index.tsx:1656-1687`:
 *
 *     <box gap={2} flexDirection="row">
 *       <text fg={theme.textMuted} wrapMode="none">{usage()}</text>      // 109.7K (10%)
 *       <text fg={theme.text}>                                             // ctrl+p commands
 *         {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
 *       </text>
 *     </box>
 *
 * Every child of that box is a literal element, so no slot can place a node on that line. An
 * OpenCode 2 host mounts it by name — `context.ui.slot({ replace: "prompt.footer.status" })`,
 * as `ndom91/opencode-hud` does — and 1.x does not have that API at any published version
 * (`@opencode-ai/plugin` 1.18.30 and 1.18.33 both declare the same twelve host slots and no
 * `ui.slot`; `sst/opencode` at HEAD has zero hits for either), so on this host the line is
 * unreachable and the seat below is the best a plugin can do.
 *
 * Of the twelve, `app_bottom` is the closest: `app.tsx:1124-1126` mounts it in a
 * `<box flexShrink={0}>` directly beneath the `flexGrow` column that holds the route, which
 * puts it at the terminal's bottom edge. `app` is one row lower and is the host's outermost
 * container, which detaches it from the session it is reporting on. `session_prompt_right` is
 * the other candidate and the wrong one — the host renders it in its own row, well ABOVE the
 * footer, which is where the counter used to sit.
 *
 * The muted tier is the one thing this got right from the start — the host draws the context
 * figure in `theme.textMuted`, the role `screenTokens().context` resolves to.
 */
export const GAUGE_SLOT = "app_bottom";

/** What the counter shows: children running, and the total they are counted against. */
export type GaugeReading = { active: number; cap: number };

/** The api fields this counter needs, and no more. */
type GaugeApi = {
  state: { path: { directory: string } };
  theme: Parameters<typeof screenTokens>[0];
};



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
  const directory = api.state.path.directory;
  const base = readDynamicTaskPolicy(directory, null);
  return { slots: { [GAUGE_SLOT]: (ctx) => jsx("text", gaugeProps(screenTokens(ctx.theme).context, readingSignal(directory, base)) as Record<string, unknown>) } };
}

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

export function gaugeProps(muted: RGBA, reading: () => GaugeReading): Record<string, unknown> {
  return {
    fg: muted,
    /**
     * `alignSelf`, and the OPPOSITE of the rule this prop used to carry.
     *
     * In the `right` slot the container was a ROW — `<box flexDirection="row" gap={1}
     * alignItems="center">{props.right}</box>` at `component/prompt/index.tsx:1479` — so the
     * cross axis `alignSelf` acts on was VERTICAL and the horizontal lever had to be an
     * auto left margin. `app_bottom` is a bare `<box flexShrink={0}>`
     * (`app.tsx:1124`), no `flexDirection`, so Yoga's default column applies: the cross axis
     * is now HORIZONTAL and `alignSelf: "flex-end"` is the lever that reaches the right
     * edge. An auto margin would be the dead one here, because auto margins absorb free
     * space along the MAIN axis and the main axis of a column is vertical.
     *
     * Worth stating because the inversion is silent: with the old prop in this container the
     * counter renders correctly and lands on the left, and nothing looks wrong.
     */
    alignSelf: "flex-end",
    // A FUNCTION, not a string. `content` takes a value and this is what makes the
    // counter live: Solid re-invokes the child when the signal it closes over moves, and
    // the signal moves on the ledger's next write.
    children: () => gaugeText(reading().active, reading().cap),
  };
}

