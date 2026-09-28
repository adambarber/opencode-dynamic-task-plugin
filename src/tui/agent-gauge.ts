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
import { createMemo, createSignal, onCleanup } from "solid-js";
import type { TuiSlotContext, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { fg, StyledText, type TextChunk } from "@opentui/core";
import type { RGBA } from "@opentui/core";
import { applyAgentOverlay, readAgentOverlay, type AgentCapSource } from "../shared/caps.js";
import { readDynamicTaskPolicy, type DynamicTaskConfig } from "../shared/config.js";
import { loadTaskLedger, resolveTaskLedgerPath } from "../shared/session-lifecycle.js";
import { foldActiveByAgent, totalActiveOf } from "../shared/occupancy.js";
import { screenTokens } from "./theme.js";

/**
 * The host slot this counter is drawn in.
 *
 * Named in ONE place because it is the one fact about this feature that nothing in the
 * repo can check: a slot the host does not draw is not a failing test, it is a number
 * that never appears. `session_prompt_right` is the host's own right-hand region of the
 * session prompt, which is where the context counter this one sits beside is drawn.
 * Changing it is a one-word edit here and nowhere else.
 */
export const GAUGE_SLOT = "session_prompt_right";

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
export function readGauge(directory: string, base: DynamicTaskConfig): { active: number; cap: number } {
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
 * The counter, mounted.
 *
 * `jsx` rather than authored JSX, deliberately. A hand-built element from
 * `@opentui/solid/jsx-runtime` renders identically to `<text>` in a source file, and it
 * needs no transform step, no committed compiled artifact and no `check:` gate — so the
 * whole `tui-compiled` toolchain the reference sidebars carry does not arrive here. It
 * DOES need an active renderer, which is why the children are a FUNCTION: the host calls
 * this inside its own render, and a plain string would be read once at mount and then
 * frozen at whatever the count happened to be when the session opened.
 *
 * A function as the child is Solid's reactive form, so the text re-derives itself when
 * the signal moves — and the signal moves when the ledger is rewritten, which the server
 * does on every task transition. Nothing polls.
 *
 * The colour is a MEMO over `ctx.theme` for the same reason: a theme switched mid-session
 * must not leave a number in the old palette beside everything else in the new one. The
 * role is `context`, the tier the limits screen already uses for a label, and the host
 * draws its own context counter in the same muted grey this asks for.
 */
export function agentGaugeSlot(api: { state: { path: { directory: string } }; theme: unknown }): TuiSlotPlugin {
  const directory = api.state.path.directory;
  const base = readDynamicTaskPolicy(directory, null);
  return {
    slots: {
      [GAUGE_SLOT]: (ctx: TuiSlotContext) => {
        const muted = createMemo(() => screenTokens(ctx.theme).context);
        const [reading, setReading] = createSignal(readGauge(directory, base));
        /**
         * Re-read, and move the signal only if the PAIR moved.
         *
         * The comparison is the point. A directory watch reports every file in the
         * project, and where the platform cannot name the one that changed it reports
         * nothing at all — so an unrelated save arrives here as a spurious event. A
         * signal set to a freshly-read but identical pair is a re-render of the corner
         * for a number that did not move, and over a session of ordinary editing that
         * is most of the events this counter will ever see.
         */
        const refresh = () => {
          const next = readGauge(directory, base);
          if (next.active === reading().active && next.cap === reading().cap) return;
          setReading(next);
        };
        const watcher = watchLedger(directory, refresh);
        onCleanup(() => watcher?.close());
        return jsx("text", {
          fg: muted(),
          children: () => gaugeText(reading().active, reading().cap),
        });
      },
    },
  };
}
