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
import { DEFAULT_LANE, LANE_CAP_NAMES, type DynamicTaskConfig, type LaneConfig, type LaneConfigName } from "../shared/config.js";
import { readLaneOverlayLanes, type LaneOverlay } from "../shared/lane-overlay.js";

/**
 * One entry in the dialog's list.
 *
 * Named "entry" and not "row" because a resolved lane is already a named thing
 * elsewhere: `lane-occupancy.ts` exports `LaneOccupancy`, which is what
 * `task_list` PRINTS, with every cap present. This one is unresolved on purpose
 * — a cap may be absent, meaning inherited — so the two describe the same subject
 * in two states rather than being two things, and a reader who meets both should
 * not assume the shapes agree.
 *
 * That divergence used to be worse than it looks: the printed row was its own
 * hand-written interface, a mirror of `LaneOccupancy` that had already drifted
 * (a widened `depthBoundBy`, a dropped `ceiling`). The duplicate-code gate
 * caught the mirror once doc comments stopped breaking the run — see
 * `scripts/duplicate-gate.mjs`. The printed row IS `LaneOccupancy` now, so the
 * two cannot disagree about a field; the only difference left is resolved vs
 * unresolved, which is the real one.
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

export const UNBOUNDED = "off";

/**
 * One cap, as the operator is asked about it.
 *
 * A cap carries three names in this dialog — the word in a lane row's scanning line,
 * the label on the form's field, and the title of the prompt that asks for it — and
 * they used to be written out in three places. They drifted: the prompt spelled an
 * absent cap "?" where the list said "off", so the box the operator typed into
 * offered a character the dialog had never used anywhere else. One table, so they
 * cannot.
 *
 * The table is TOTAL over `LANE_CAP_NAMES` — a `Record`, not a list — so a cap added
 * to the lane config is a TYPE ERROR here until it has a label, rather than a cap
 * the list shows and the form has no row to edit it with. That is the guarantee the
 * positional grammar's own comment used to claim for itself; it is now enforced by
 * the compiler instead of by a promise in a comment.
 */
export type LaneField = {
  /** The cap's own name, which is also its key in the overlay. */
  cap: LaneConfigName;
  /** What the operator calls it: the form's row, and the prompt's title. */
  label: string;
  /**
   * The clause a lane row gives this cap — how its value and its word read together.
   *
   * A FUNCTION rather than a unit word, because the two caps' words sit on different
   * sides of their number and that is English rather than a choice: "2 concurrent"
   * puts the adjective after, "depth 3" puts the noun before. Handing `laneRowText` a
   * word and a position flag would have been the same fact written twice; the clause
   * is the fact, and the value is the one thing about it that changes per lane.
   */
  listClause: (shown: string) => string;
  /** Said UNDER the field, so the grammar is visible before an answer is asked for. */
  meaning: string;
};

export const LANE_FIELDS: Record<LaneConfigName, LaneField> = {
  maxConcurrent: { cap: "maxConcurrent", label: "Concurrency", listClause: (shown) => `${shown} concurrent`, meaning: `tasks in this lane at once · ${UNBOUNDED} removes the cap` },
  maxDepth: { cap: "maxDepth", label: "Dispatch depth", listClause: (shown) => `depth ${shown}`, meaning: `generations deep · ${UNBOUNDED} removes the cap` },
};

/** The fields in the order the form shows them, which is the order they were declared. */
export const LANE_FIELD_LIST: readonly LaneField[] = Object.values(LANE_FIELDS);

/**
 * A change to one lane's caps, as a PATCH of a `LaneConfig` — the same keys, each
 * additionally nullable. `null` means REMOVE the key, not "set it to nothing" —
 * JSON has no undefined, `{"maxDepth": null}` is a value the reader would have to
 * recognise as absent, and every such reader is a place the two sides can
 * disagree. `exactOptionalPropertyTypes` refuses to let the distinction be made by
 * accident, which is the point of that flag.
 *
 * Mapped over `LaneConfig` rather than listing the caps, so the patch and the lane
 * it patches cannot disagree about which caps exist.
 */
type CapPatch = { [K in keyof LaneConfig]?: number | null };

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

/** The prompt for one field of one lane: one cap, named, with the value in force. */
export function laneFieldPrompt(row: LaneEntry, field: LaneField): LaneFieldPrompt {
  return {
    title: `${field.label} · ${row.name}`,
    // The value in force, as a PLACEHOLDER and not as a pre-filled `value`: a
    // pre-filled box in a terminal appends, so typing "4" over a "1" would answer
    // "14" — a worse trap than an empty box. An empty answer means "leave it", which
    // `applyLaneEdit` says rather than treating as a mistake.
    placeholder: capShown(row.lane, field.cap),
  };
}

/** How ONE cap is shown: its value, or the word that means "not capped". */
export function capShown(lane: LaneConfig, cap: LaneConfigName): string {
  const value = lane[cap];
  return value === undefined ? UNBOUNDED : String(value);
}

export type EditOutcome =
  | { kind: "written"; overlay: LaneOverlay; summary: string }
  | { kind: "unchanged" }
  | { kind: "invalid"; problem: string };

/** What an answer is FOR: one cap of the lane, or the lane itself. */
export type LaneEditTarget = { kind: "cap"; field: LaneField } | { kind: "delete" };

/**
 * Apply one typed answer to the current overlay.
 *
 * A lane is written with only the field the operator actually set, so an overlay
 * never grows a knob nobody chose: `maxDepth: undefined` in JSON is not the same as
 * an absent key, and a reader that tests `!== undefined` for the first and `in` for
 * the second is a real class of bug. Same for the lane itself — a lane set back to
 * `{}` stays present, which is a distinct statement from "this lane is gone".
 *
 * The target is an argument rather than a branch on a typed string, because the
 * grammar is no longer POSITIONAL. It was `"n d"`, one box asking for two numbers in
 * an order only the dialog knew, and the dialog's own comment admitted the cost: an
 * operator who typed a cap without its depth silently set the OTHER one. Asking for
 * each cap under its own name removes the class of mistake, so the parse is a
 * single value and there is nothing left for a position to disambiguate.
 */
export function applyLaneEdit(current: LaneOverlay, row: LaneEntry, target: LaneEditTarget, typed: string): EditOutcome {
  if (row === undefined || row.name === undefined) {
    // A dialog that throws leaves a broken modal on screen and no way back. Every
    // outcome of this function is a string the operator can read, so this is one
    // too — and it is unreachable from the renderer, which is why it is cheap.
    return { kind: "invalid", problem: "no lane to edit" };
  }
  if (target.kind === "delete") return withoutLane(current, row.name);
  const answer = typed.trim();
  // An empty answer to a field the operator opened is not a mistake, it is a
  // decision to change nothing — and it must not write, because the value in force
  // is inherited and writing it would turn a config-file cap into an overlay one.
  if (answer === "") return { kind: "unchanged" };
  const value = asCap(answer);
  if (typeof value === "string") return { kind: "invalid", problem: value };
  // No pruning of empty bodies: an empty body is a MEANINGFUL value — it means
  // "counted separately, on the shared budget" — so dropping one would silently
  // turn a parked lane back into an unaccounted one.
  const patch: CapPatch = {};
  patch[target.field.cap] = value;
  return {
    kind: "written",
    overlay: overlayWith(current, row.name, withCaps(row.lane, patch)),
    summary: `${row.name} → ${target.field.label} ${value === null ? UNBOUNDED : value}`,
  };
}

/**
 * Apply a patch, deleting what it clears so the written JSON says what it means.
 *
 * Over `LANE_CAP_NAMES`, the list the server's reader also iterates, which is what
 * lets this be a loop and still need no cast: iterating `Object.entries(patch)`
 * would land on `string` keys, and iterating the names lands on `keyof LaneConfig`
 * because that is what the names ARE.
 *
 * The previous version wrote the two fields out and its comment claimed that doing
 * so removed "the possibility of a third cap being added and silently ignored
 * here". It did the opposite — a hand-written list of fields is exactly a list of
 * the fields someone remembered, and a third cap would have been dropped by this
 * function while every other reader of the same lane honoured it. What is true
 * now, and was not, is that the writer and the server's reader cannot fall out of
 * step: both iterate `LANE_CAP_NAMES`, so a cap the reader accepts is a cap the
 * dialog writes.
 *
 * The writer has no private list of fields, and now neither does the form: every
 * cap is a row in `LANE_FIELDS`, which is total over the same names. So a cap the
 * reader accepts is a cap the dialog writes AND a cap the form has a row for — the
 * three cannot fall out of step, because they are one declaration.
 */
function withCaps(lane: LaneConfig, patch: CapPatch): LaneConfig {
  const next: LaneConfig = { ...lane };
  for (const name of LANE_CAP_NAMES) {
    const value = patch[name];
    if (value !== undefined) applyCap(next, name, value);
  }
  return next;
}

function applyCap(lane: LaneConfig, key: keyof LaneConfig, value: number | null): void {
  if (value === null) delete lane[key];
  else lane[key] = value;
}

/** The prompt a chosen field leads to: one cap, asked for by name. */
export type LaneFieldPrompt = { title: string; placeholder: string };

/**
 * The grammar for ONE cap: a whole number, or the word that lifts it.
 *
 * It answers for the empty input too, rather than leaving that to the caller,
 * because the caller checking it first meant two checks for one fact — the
 * caller's said "nothing typed" and this one's branch could never run, so the
 * grammar it actually enforced was not the grammar the dialog described.
 */
function asCap(word: string): number | null | string {
  if (word.toLowerCase() === UNBOUNDED) return null;
  if (!/^\d+$/.test(word)) return `"${word}" is not a count — use a whole number, or "${UNBOUNDED}" to remove the cap`;
  const value = Number(word);
  // Zero is a real answer here: it is a lane that admits nothing, which is how
  // an operator parks a lane without deleting it. A cap is not a slot count, so
  // the ceiling is high enough to be a mistake rather than a bound.
  if (value > 10_000) return `a cap of ${value} is a typo, not a policy`;
  return value;
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
