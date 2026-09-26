// What the lanes look like RIGHT NOW: occupancy, caps, and the depth each lane
// can actually reach.
//
// Its own module because this is a question three consumers ask — task_list, the
// lane view, and anything that wants to say "3/4" — and each of them deriving it
// from the store is three answers free to disagree about what a lane is. The
// store holds every running task and the config holds every cap, so the whole
// picture costs no host read: a view that asked the server per lane would turn
// one question into a burst of transport for numbers the plugin already has.

import type { LaneConfigSource } from "./config.js";
import { admissibleLaneNames, resolveLane } from "./config.js";
import { liveLanes } from "./lane-overlay.js";
import { depthLimits, type DepthBound } from "./task-policy.js";
import type { TaskStore } from "./task-state.js";

/** One lane, as the operator sees it. */
export interface LaneOccupancy {
  name: string;
  /** Running tasks charged to this lane. */
  active: number;
  /** The lane's own cap. */
  maxConcurrent: number;
  /** The cross-lane ceiling, which lanes partition and never multiply. */
  ceiling: number;
  /** The depth cap as configured, and the depth actually reachable. */
  depthConfigured: number;
  /** `null` when the dispatchable set could not be read — an unknown, not a zero. */
  depthEffective: number | null;
  /** Which constraint caps the reachable depth. `null` alongside a null effective. */
  depthBoundBy: DepthBound | null;
}

/**
 * Every admissible lane, in a stable order, with the numbers filled in.
 *
 * The accept-set comes from `admissibleLaneNames` — the SAME function admission
 * uses — so the view can never offer a lane the gate would refuse, or omit one
 * it would admit. Two derivations of "which lanes exist" is how a lane becomes
 * invisible in the view while still working, which is the worst shape a bug in
 * this feature can take.
 *
 * `agentNames` is the DISPATCHABLE set, or null when it could not be read. Null
 * is not zero: a project whose agents could not be listed has an unknown depth,
 * and reporting 0 would read as "this lane cannot delegate at all".
 */
export function laneOccupancy(
  store: TaskStore,
  config: LaneConfigSource,
  agentNames: readonly string[] | null,
  allowSameAgentRecursion: boolean,
): LaneOccupancy[] {
  const policy = liveLanes(config);
  return admissibleLaneNames(policy).map((name) => {
    const lane = resolveLane(policy, name);
    const limits = depthLimits({ maxDepth: lane.maxDepth, allowSameAgentRecursion }, agentNames ?? []);
    return {
      name,
      active: activeInLane(store, name),
      maxConcurrent: lane.maxConcurrent,
      ceiling: policy.maxConcurrent,
      depthConfigured: lane.maxDepth,
      depthEffective: agentNames === null ? null : finiteDepth(limits.effective),
      depthBoundBy: agentNames === null ? null : limits.boundBy,
    };
  });
}

/** An unbounded depth has no number to show; -1 is what the config spells. */
function finiteDepth(effective: number): number {
  return Number.isFinite(effective) ? effective : -1;
}

function activeInLane(store: TaskStore, lane: string): number {
  let count = 0;
  for (const task of store.activeTasks.values()) {
    if (task.lane === lane) count++;
  }
  return count;
}
