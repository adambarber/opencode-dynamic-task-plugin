// The lane overlay: a machine-owned file that edits policy without a restart.
//
// Its own module because it is a different KIND of input from the config file.
// The config file is hand-authored, read once at boot, and frozen — a program
// must never rewrite it, or the operator's comments and formatting die with the
// edit. The overlay is the opposite: written by a program, read at the moment it
// matters, and deleted to reset. Keeping the two in one module would invite
// exactly the "just write it into the config" move that loses the comments.
//
// Precedence is total by construction: `base` is ALREADY the result of
// env > tuple options > config file > defaults, resolved once at boot. Layering
// the overlay on top of it therefore puts the overlay above every one of those
// with no precedence table to keep in step — which is also why the overlay beats
// an env pin: a user who pinned DYNAMIC_TASK_MAX_CONCURRENT=1 and then raised the
// cap in the UI has expressed a newer intent than the pin, and a UI that silently
// did nothing reads as a broken UI. For a floor that must survive a click, put
// the number in the config file.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_CAP_NAMES, type LaneConfig, type LaneConfigSource } from "./config.js";

/** Beside the ledger, in the project directory the host hands us. */
export const LANE_OVERLAY_FILE = ".dynamic-task-lanes.json";

/** What the overlay may say, as data. Both halves are optional and partial. */
export interface LaneOverlay {
  /** The cross-lane ceiling. Lanes never multiply it, so this is the total. */
  maxConcurrent?: number;
  /** The default lane's depth cap, and the fallback for any lane that omits it. */
  maxDepth?: number;
  lanes?: Record<string, LaneConfig>;
}

/**
 * The lanes of an untrusted overlay, read by the one reader — and what it had to
 * throw away to get them.
 *
 * The report travels with the read because the reader is the ONLY place that
 * knows: asking anything else to work out which caps were dropped means a second
 * reader of the same untrusted file, which is the disagreement this was extracted
 * to prevent. A dialog that cannot say what it ignored shows a cap the dispatch
 * path will not honour as though it applied.
 *
 * Null means the file is a shape this cannot interpret, which is a DIFFERENT
 * answer from "no lanes" and must not collapse into it: a dialog that reported
 * an unreadable file as an empty one would show the config's caps and invite the
 * operator to write over whatever was actually there.
 */
export function readLaneOverlayLanes(raw: unknown): { lanes: Record<string, LaneConfig>; dropped: Record<string, string[]> } | null {
  if (raw === null || raw === undefined) return { lanes: {}, dropped: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawLanes = (raw as { lanes?: unknown }).lanes;
  if (rawLanes === undefined) return { lanes: {}, dropped: {} };
  if (typeof rawLanes !== "object" || rawLanes === null || Array.isArray(rawLanes)) return null;
  const lanes: Record<string, LaneConfig> = {};
  const dropped: Record<string, string[]> = {};
  for (const [name, body] of Object.entries(rawLanes as Record<string, unknown>)) {
    lanes[name] = readLaneBody(body);
    const ignored = ignoredCaps(body);
    if (ignored.length > 0) dropped[name] = ignored;
  }
  return { lanes, dropped };
}

/** The two cap keys a body may set. Anything else in it is not a policy statement. */
const CAP_KEYS = ["maxConcurrent", "maxDepth"] as const;

/** The cap keys a body states that are not a cap the plugin will act on. */
function ignoredCaps(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const body = raw as Record<string, unknown>;
  return CAP_KEYS.filter((key) => body[key] !== undefined && cap(body[key]) === undefined);
}

/** The overlay's path for a project directory. Never process CWD (Tenet: durable state). */
export function laneOverlayPath(directory: string | undefined): string {
  return join(directory || "", LANE_OVERLAY_FILE);
}

/**
 * A cap the plugin will act on: a whole positive number, and nothing else.
 *
 * A zero, a negative, a fraction, or a string is not a cap — they are a hand-mangled
 * file or a writer with a bug, and honouring one would mean either running nothing
 * (`maxConcurrent: 0` refuses every dispatch with no way to name why) or running
 * without limit (`-1` never refuses). Both read as a broken plugin, so the value
 * is dropped and the underlying config answers instead.
 */
function cap(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The knobs a lane body may set. Nothing else in it is a policy statement.
 *
 * EXPORTED because it is the reader for an untrusted file, and a second reader
 * for the same untrusted file is how two processes come to disagree: the dialog
 * shows a cap the dispatch path silently drops, and the operator edits a number
 * that has no effect. One reader, so that cannot happen.
 *
 * Iterated over `LANE_CAP_NAMES` rather than written out per field. Written out,
 * this function is a list of the caps someone remembered, and the cap they did
 * not is dropped from every overlay the plugin ever applies — silently, because
 * a field a reader never mentions cannot be a type error against it.
 */
export function readLaneBody(raw: unknown): LaneConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const body = raw as Record<string, unknown>;
  const out: LaneConfig = {};
  for (const name of LANE_CAP_NAMES) {
    const value = cap(body[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The overlay as policy, or null when there is nothing to layer.
 *
 * Null is distinct from `{}`: null means "no overlay, or one that said nothing
 * usable", and the caller then keeps the base config by identity rather than
 * rebuilding it — so a tree with no overlay resolves exactly as it did before
 * this file existed, which is the claim the whole feature rests on.
 *
 * A lane named in the overlay is kept even when its body carries no usable knob.
 * It is the one spelling of "account for this lane separately, on the default
 * budget", and dropping it would make the lane the operator just created in the UI
 * vanish on the next dispatch — the click would appear to do nothing, which is the
 * one outcome this feature must never have.
 */
export function applyLaneOverlay(
  base: LaneConfigSource,
  raw: unknown,
): { source: LaneConfigSource } | { source: null; problem: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { source: null, problem: "the overlay is not a JSON object" };
  }
  const overlay = raw as Record<string, unknown>;
  const lanes: Record<string, LaneConfig> = {};
  let sawLane = false;
  const rawLanes = overlay["lanes"];
  if (rawLanes !== undefined) {
    if (!rawLanes || typeof rawLanes !== "object" || Array.isArray(rawLanes)) {
      return { source: null, problem: "`lanes` is not an object" };
    }
    for (const [name, body] of Object.entries(rawLanes as Record<string, unknown>)) {
      lanes[name] = readLaneBody(body);
      sawLane = true;
    }
  }
  const maxConcurrent = cap(overlay["maxConcurrent"]);
  const maxDepth = cap(overlay["maxDepth"]);
  if (maxConcurrent === undefined && maxDepth === undefined && !sawLane) {
    return { source: null, problem: "the overlay names no cap" };
  }
  return {
    source: {
      maxConcurrent: maxConcurrent ?? base.maxConcurrent,
      maxDepth: maxDepth ?? base.maxDepth,
      // A lane the overlay does not mention keeps the base file's numbers: the
      // overlay is an EDIT, not a replacement, so an operator who raised one lane
      // does not silently reset the rest to the top-level defaults.
      lanes: { ...base.lanes, ...lanes },
    },
  };
}

/** Read the overlay for a project directory. Best-effort: never throws. */
export function readLaneOverlay(directory: string | undefined): { raw: unknown; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(laneOverlayPath(directory), "utf8");
  } catch {
    return { raw: null, problem: null }; // absent is the normal case, not a problem
  }
  try {
    return { raw: JSON.parse(text) as unknown, problem: null };
  } catch (error) {
    return { raw: null, problem: `the overlay is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ─── the write side ────────────────────────────────────────────────────────

/**
 * Replace the overlay, atomically.
 *
 * Atomic because the reader is a DISPATCH PATH: it reads this file while work is
 * in flight, and a half-written file is a parse failure that silently reverts
 * every cap to the boot config — an operator's edit vanishing because a write
 * was interrupted. Write to a pid-qualified temp file in the same directory and
 * rename over the target, which is atomic within a filesystem; a plain write is
 * not, and a same-directory temp file is not either if the name is shared
 * between two live processes.
 *
 * `applyLaneOverlay` is deliberately NOT called on the way out. The caller has
 * already validated, and re-validating here would drop the one shape that
 * validation must preserve — a lane declared with no knobs of its own.
 */
export function writeLaneOverlay(directory: string | undefined, overlay: LaneOverlay): void {
  const target = laneOverlayPath(directory);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  renameSync(temp, target);
}

// ─── the live read ──────────────────────────────────────────────────────────
//
// One installer, one getter, no arguments to thread: the chokepoint has to sit
// where a lane decision is actually made, and lane decisions are made deep in the
// store by callers (a spawn, a revival) that know nothing about a project
// directory. Tenet 9's process-global shape is the same one the notification
// ledger and the pending-queue writer already use, for the same reason: the thing
// being held is per-process policy, and a boot installs it exactly once.
let readLive: (() => { source: LaneConfigSource | null; problem: string | null }) | null = null;

/** Boot installs the reader. There is no uninstall: the overlay lives as long as the process. */
export function installLiveLanes(read: () => { source: LaneConfigSource | null; problem: string | null }): void {
  readLive = read;
}

/** Test seam: forget the installed reader and return to boot-only policy. */
export function resetLiveLanes(): void {
  readLive = null;
}

/**
 * The policy a lane decision must be made against RIGHT NOW.
 *
 * A function rather than a value because a value would be a snapshot, and the
 * whole feature is that the number changes without a restart. Falls back to the
 * base config when nothing is installed or the overlay is unusable, so a
 * missing/mangled overlay degrades to exactly the frozen behaviour that shipped
 * before lanes existed.
 */
export function liveLanes(base: LaneConfigSource): LaneConfigSource {
  if (!readLive) return base;
  try {
    return readLive().source ?? base;
  } catch {
    // A reader that throws is a bug in the reader, not a reason to refuse a
    // dispatch: policy falls back to the boot config and the work proceeds.
    return base;
  }
}
