/**
 * The Lane Management dialog's logic, with no TUI SDK in sight.
 *
 * This is separated from the module that renders it because the part worth
 * checking is not the rendering: it is what an operator's typed answer is
 * ALLOWED to become. A dialog that writes whatever string came back puts an
 * unvalidated value into a file that a dispatch path reads, and the first
 * symptom is a refusal quoting a number nobody typed. So the grammar is parsed
 * and checked here, and the renderer only ever receives either a result to
 * display or a clean next question to ask.
 *
 * It lives under tui/ and imports nothing from the SDK because the SDK is
 * irrelevant to what it decides; the two are separate so that this file is
 * testable and the renderer stays a thin adapter over it.
 */
import { DEFAULT_LANE, type DynamicTaskConfig, type LaneConfig } from "../shared/config.js";
import { readLaneOverlayLanes, type LaneOverlay } from "../shared/lane-overlay.js";

/**
 * One entry in the dialog's list.
 *
 * Named "entry" and not "row" because `task-formatting.ts` already exports a
 * `LaneRow` for what `task_list` PRINTS: a resolved lane, with every cap
 * present. This one is unresolved on purpose — a cap may be absent, meaning
 * inherited — so the two share a name and nothing else, and a reader who meets
 * both should not assume the shapes agree.
 *
 * The default lane is an entry like any other even though the overlay need not
 * mention it: the base config's caps are inherited unless the overlay says
 * otherwise, so a cap the dialog cannot display is a cap the operator cannot
 * correct, and a lane that works but is missing from the dialog is the worst
 * shape that bug can take.
 */
export type LaneEntry = {
  name: string;
  lane: LaneConfig;
  /** Running tasks charged to this lane, as last recorded on disk. */
  running: number;
  /** True when this row is inherited from the base config rather than the overlay. */
  inherited: boolean;
};

export type LaneDialog = {
  rows: LaneEntry[];
  /** Set when the overlay exists but is not something the dialog can show. */
  problem: string | null;
};

/** The prompt a chosen row leads to. */
export type LanePrompt = {
  title: string;
  placeholder: string;
  /** What a correct answer looks like, for the dialog's description line. */
  hint: string;
};

export const UNBOUNDED = "off";

/**
 * A change to one lane's caps. `null` means REMOVE the key, not "set it to
 * nothing" — JSON has no undefined, `{"maxDepth": null}` is a value the reader
 * would have to recognise as absent, and every such reader is a place the two
 * sides can disagree. `exactOptionalPropertyTypes` refuses to let the
 * distinction be made by accident, which is the point of that flag.
 */
type CapPatch = { maxConcurrent?: number | null; maxDepth?: number | null };

/**
 * The rows to offer, from the overlay as it sits on disk.
 *
 * The lanes are read by the SERVER's reader (`readLaneOverlayLanes`), not by a
 * cast of the parsed JSON. That is the whole point: a hand-mangled file —
 * `{"maxConcurrent": "four"}`, `{"maxConcurrent": -1}` — is dropped by the reader
 * the dispatch path uses, so a dialog that trusted its own parse would DISPLAY a
 * cap the server is not honouring, and an edit would launder the garbage it
 * showed into the file it wrote back.
 *
 * A value that was dropped is reported rather than silently shown as unset: the
 * operator is looking at a number that will not apply, and "unset" reads as
 * "inherited" only if nobody says otherwise.
 */
export function laneDialogFrom(raw: unknown, running: ReadonlyMap<string, number>, base: DynamicTaskConfig): LaneDialog {
  const read = readLaneOverlayLanes(raw);
  if (read === null) {
    return { rows: rowsFrom({}, running, base), problem: "the overlay is a JSON object, or nothing at all" };
  }
  const ignored = Object.entries(read.dropped).map(
    ([name, keys]) => `${name}: ${keys.join(", ")} is not a whole positive number, so the cap there is ignored`,
  );
  return {
    rows: rowsFrom(read.lanes, running, base),
    problem: ignored.length > 0 ? ignored.join(" · ") : null,
  };
}

function rowsFrom(lanes: Record<string, LaneConfig>, running: ReadonlyMap<string, number>, base: DynamicTaskConfig): LaneEntry[] {
  // The base config's lanes are part of the answer even when the overlay is
  // empty: a lane declared in the config file is a lane an operator expects to
  // find in the dialog, and leaving it out makes the dialog disagree with the
  // refusals the server will print.
  const names = new Set<string>([...Object.keys(base.lanes), ...Object.keys(lanes), DEFAULT_LANE]);
  return [...names].sort().map((name) => {
    const declared = lanes[name];
    const fromConfig = base.lanes[name];
    return {
      name,
      lane: declared ?? fromConfig ?? base.lanes[DEFAULT_LANE] ?? {},
      running: running.get(name) ?? 0,
      inherited: declared === undefined,
    };
  });
}

/**
 * The row for a lane that is not in the view yet.
 *
 * This is the funnel for "a lane the operator just named". The renderer and the
 * tests both need one, and each hand-rolling its own literal is how a fabricated
 * row ends up carrying fields the real rows do not — which then reads as a lane
 * that exists, is idle, and inherits its caps, all of which are claims nothing
 * has checked.
 */
export function newLaneEntry(name: string): LaneEntry {
  return { name, lane: {}, running: 0, inherited: true };
}

/** The prompt for one row: both caps at once, because two nested dialogs to set two numbers is one too many. */
export function promptFor(row: LaneEntry): LanePrompt {
  return {
    title: `Lanes · ${row.name}`,
    placeholder: `${row.lane.maxConcurrent ?? "?"} ${row.lane.maxDepth ?? UNBOUNDED}`,
    hint: `"n" caps concurrency · "n d" also caps depth · "${UNBOUNDED}" removes a cap · "delete" drops the lane`,
  };
}

/** The two caps a lane declares, as the dialog shows them. */
export function capsOf(lane: LaneConfig): { concurrency: string; depth: string } {
  return {
    concurrency: lane.maxConcurrent === undefined ? UNBOUNDED : String(lane.maxConcurrent),
    depth: lane.maxDepth === undefined ? UNBOUNDED : String(lane.maxDepth),
  };
}

export type EditOutcome =
  | { kind: "written"; overlay: LaneOverlay; summary: string }
  | { kind: "invalid"; problem: string };

/**
 * Apply one typed answer to the current overlay.
 *
 * A lane is written with only the fields the operator actually set, so an
 * overlay never grows a knob nobody chose: `maxDepth: undefined` in JSON is not
 * the same as an absent key, and a reader that tests `!== undefined` for the
 * first and `in` for the second is a real class of bug. Same for the lane
 * itself — a lane set back to `{}` stays present, which is a distinct statement
 * from "this lane is gone".
 */
export function applyLaneEdit(current: LaneOverlay, row: LaneEntry, typed: string): EditOutcome {
  if (row === undefined || row.name === undefined) {
    // A dialog that throws leaves a broken modal on screen and no way back. Every
    // outcome of this function is a string the operator can read, so this is one
    // too — and it is unreachable from the renderer, which is why it is cheap.
    return { kind: "invalid", problem: "no lane to edit" };
  }
  const answer = typed.trim();
  if (answer.toLowerCase() === "delete") {
    return withoutLane(current, row.name);
  }
  const parsed = parseCaps(answer);
  if (typeof parsed === "string") return { kind: "invalid", problem: parsed };
  // No pruning of empty bodies: an empty body is a MEANINGFUL value — it means
  // "counted separately, on the shared budget" — so dropping one would silently
  // turn a parked lane back into an unaccounted one, which is the opposite of
  // what the operator asked for.
  return { kind: "written", overlay: overlayWith(current, row.name, withCaps(row.lane, parsed)), summary: `${row.name} → ${describe(parsed)}` };
}

/**
 * Apply a patch, deleting what it clears so the written JSON says what it means.
 *
 * Written out per field rather than looped over `Object.entries(patch)`: the loop
 * needs a cast to land back on `LaneConfig`, because the type system cannot see
 * that a patch's keys are the same two keys. Naming them removes the cast AND the
 * possibility of a third cap being added to `CapPatch` and silently ignored here.
 */
function withCaps(lane: LaneConfig, patch: CapPatch): LaneConfig {
  const next: LaneConfig = { ...lane };
  if (patch.maxConcurrent !== undefined) applyCap(next, "maxConcurrent", patch.maxConcurrent);
  if (patch.maxDepth !== undefined) applyCap(next, "maxDepth", patch.maxDepth);
  return next;
}

function applyCap(lane: LaneConfig, key: keyof LaneConfig, value: number | null): void {
  if (value === null) delete lane[key];
  else lane[key] = value;
}

/**
 * The caps grammar: "n" caps concurrency, "n d" caps both, "n off" caps
 * concurrency and lifts depth.
 *
 * It answers for the empty input too, rather than leaving that to the caller,
 * because the caller checking it first meant two checks for one fact: the
 * caller's said "nothing typed" and this one's branch could never run, so the
 * grammar it actually enforces was not the grammar the dialog described.
 */
function parseCaps(answer: string): CapPatch | string {
  const [first, second, ...rest] = answer.split(/[\s,]+/).filter((part) => part.length > 0);
  if (first === undefined) return "nothing typed";
  if (rest.length > 0) {
    return `expected "n", "n d", or "off" — got ${rest.length + 2} values`;
  }
  const out: CapPatch = {};
  if (second !== undefined) {
    const depth = asCap(second);
    if (typeof depth === "string") return depth;
    out.maxDepth = depth;
  }
  const concurrency = asCap(first);
  if (typeof concurrency === "string") return concurrency;
  out.maxConcurrent = concurrency;
  return out;
}

function asCap(word: string): number | null | string {
  if (word.toLowerCase() === UNBOUNDED) return null;
  if (!/^\d+$/.test(word)) return `"${word}" is not a count — use a whole number, or "${UNBOUNDED}"`;
  const value = Number(word);
  // Zero is a real answer here: it is a lane that admits nothing, which is how
  // an operator parks a lane without deleting it. A cap is not a slot count, so
  // the ceiling is high enough to be a mistake rather than a bound.
  if (value > 10_000) return `a cap of ${value} is a typo, not a policy`;
  return value;
}

function describe(parsed: CapPatch): string {
  const parts: string[] = [];
  if ("maxConcurrent" in parsed) parts.push(`${parsed.maxConcurrent === null ? UNBOUNDED : parsed.maxConcurrent} concurrent`);
  if ("maxDepth" in parsed) parts.push(`depth ${parsed.maxDepth === null ? UNBOUNDED : parsed.maxDepth}`);
  return parts.join(" · ");
}

function withoutLane(current: LaneOverlay, name: string): EditOutcome {
  if (current.lanes === undefined || !(name in current.lanes)) {
    return { kind: "invalid", problem: `${name} is not set in the overlay — its caps come from the config file, which this dialog does not edit` };
  }
  return { kind: "written", overlay: overlayWith(current, name, null), summary: `${name} removed — it now inherits the config file's caps` };
}

/**
 * The overlay with one lane's body set, or removed when the body is null.
 *
 * The single way an overlay is built in this module. Two inline copies of
 * "copy, assign-or-delete, wrap" is how one of them ends up copying while the
 * other mutates, and an overlay is read on a dispatch path, so the difference
 * shows up as another session's edit vanishing.
 */
function overlayWith(current: LaneOverlay, name: string, lane: LaneConfig | null): LaneOverlay {
  const lanes = { ...current.lanes };
  if (lane === null) delete lanes[name];
  else lanes[name] = lane;
  return { lanes };
}
