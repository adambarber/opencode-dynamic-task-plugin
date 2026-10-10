// The wait registry: dispatches the admission gate refused, parked until the
// thing they were refused for settles.
//
// One writer (the admission gate's refusal) and one reader (the settlement
// funnel). The reader asks the SAME predicate the gate asked, so "this dispatch
// can go now" can never disagree with "this dispatch was refused" — two
// hand-written readiness rules would drift, and the drift would read as the
// plugin refusing a dispatch it had just promised.
//
// Its own module because it is its own subject: nothing here decides a task's
// state, and nothing that decides a task's state belongs here.

//jscpd:ignore-start
import type { DependencyBlock } from "./admission.js";
import { evictOldest } from "./bounded-map.js";
import type { SessionId } from "./ids.js";
import type { ParentSession } from "./session-lifecycle.js";

//jscpd:ignore-end
/**
 * Whether a wait's edges are all satisfied; otherwise which ones still block it.
 *
 * The two answers to one question, kept together so a caller cannot answer "admissible"
 * and "still blocked" inconsistently.
 */
export type Admissibility = { ok: true } | { ok: false; pending: DependencyBlock[] };

/** Whether a child session is still running, asked fresh at the moment of the answer. */
export type StillRunning = (childSessionId: SessionId) => boolean;

/** Everything needed to close out one wait: the wait, where it lives, and where it goes. */
interface Settling {
  store: WaitRegistry;
  release: WaitRelease;
  key: string;
  wait: DependencyWait;
}

/** The two questions a wait is asked before it is allowed to leave the registry. */
export interface Judges {
  isAdmissible: (wait: DependencyWait) => Admissibility;
  stillRunning: StillRunning;
}

/**
 * A dispatch the admission gate refused because its dependencies were not
 * ready, held so the plugin can say when the refusal is over.
 *
 * This is the state that `depends_on` never had. The refusal used to be a
 * sentence: the parent had to carry the wait in prose, be alive at the moment
 * the dependency settled, and re-dispatch from memory — three things that all
 * belong to the parent's context, which is what the plugin exists to hold.
 *
 * It holds NO prompt and NO session, deliberately. The parent wrote the
 * dispatch and the parent resumes it; the plugin's whole obligation is to say
 * when the gate will now admit it. So this is process memory, not ledger
 * truth: across a restart this wait and the parent that asked for it are gone
 * together, and a hint that outlived its asker would have nobody to inform.
 */
export interface DependencyWait {
  /** The parent's own words for this dispatch — its identity in every message. */
  description: string;
  /** The parent that asked. The hint goes here, not to the settling task's parent. */
  parentSessionId: ParentSession;
  /** Edges that must reach `completed`. */
  dependsOn: string[];
  /** Edges that only have to settle. */
  dependsOnSettled: string[];
  queuedAt: number;
}

/**
 * All this module needs from a store: the map the waits live in. The
 * structural parameter rather than `TaskStore` so the registry is not wired back
 * into the store's own module — a registry that has to be told what a store is
 * cannot be read as the small thing it is.
 */
export interface WaitRegistry {
  waits: Map<string, DependencyWait>;
}

/** How many refused dispatches one parent may have outstanding. */
export const MAX_WAITS = 64;

/** A wait's key: who is waiting, for what. The parent named both. */
export function waitKey(parentSessionId: string, description: string): string {
  return `${parentSessionId  } ${  description}`;
}

/**
 * Hold a refused dispatch so the plugin can announce its release. Re-recording
 * the same (parent, description) replaces the earlier edges rather than
 * queueing a second hint for one dispatch: the parent asked twice about the
 * same thing, and the newer edges are the ones it means now.
 */
export function holdDispatchWait(
  store: WaitRegistry,
  wait: Omit<DependencyWait, "queuedAt">,
): DependencyWait {
  const held: DependencyWait = { ...wait, queuedAt: Date.now() };
  store.waits.set(waitKey(wait.parentSessionId, wait.description), held);
  // Bounded: the map is a courtesy ledger to a live parent, not a history, and
  // the oldest wait is the one least likely to still be wanted.
  evictOldest(store.waits, MAX_WAITS);
  return held;
}

/** What a settlement did to the waits that were watching it. */
export interface WaitRelease {
  /** Refused dispatches the gate will now admit. */
  ready: DependencyWait[];
  /** Refused dispatches that can never run: every unmet edge is finished, short of done. */
  dead: DependencyWait[];
}

/**
 * The waits this settlement resolves, and the ones it leaves alone. A wait is
 * resolved by the SAME predicate the gate refused it on, so readiness has one
 * definition. It is resolved as `dead` when the predicate still refuses AND no
 * unmet edge is still running: an edge that has settled and is not `completed`
 * will not run again, so waiting on it is waiting on nothing — and a parent that
 * is never told is a parent that waits forever.
 *
 * Resolved waits are removed here, so exactly-once is structural rather than a
 * dedup key: a wait cannot be announced twice because it is announced from the
 * moment it stops existing.
 */
export function releaseWaitsFor(
  store: WaitRegistry,
  settledChildSessionId: string,
  judges: Judges,
): WaitRelease {
  const release: WaitRelease = { dead: [], ready: [] };
  for (const [key, wait] of store.waits) {
    const watching = [wait.dependsOn, wait.dependsOnSettled].some((edges) =>
      edges.includes(settledChildSessionId),
    );
    if (watching) settleWait({ key, release, store, wait }, judges);
  }
  return release;
}

/**
 * One wait that was watching the settled child, taken as far as it can go.
 *
 * Both endings are the same act — this wait is finished waiting, so it leaves the map
 * and lands in one of the two buckets. Only the question it answers differs, and only the
 * question belongs in the arms.
 *
 * Split out of the walk above because a `continue` per arm made the walk read as a
 * ladder, when what it does is call this on the waits that care and skip the rest.
 */
function settleWait(settling: Settling, judges: Judges): void {
  const { store, release, key, wait } = settling;
  const admitted = judges.isAdmissible(wait);
  const doneWaiting = (bucket: DependencyWait[]): void => {
    bucket.push(wait);
    store.waits.delete(key);
  };
  if (admitted.ok) return doneWaiting(release.ready);
  // Still refused: is any edge able to change that, or is this wait finished?
  const canStillClear = admitted.pending.some((edge) => judges.stillRunning(edge.id));
  if (!canStillClear) doneWaiting(release.dead);
}
