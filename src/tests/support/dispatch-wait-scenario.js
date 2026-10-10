/**
 * The dependency-wait scenario, shared by the suite that proves waits are state
 * and the suite that proves every settlement releases them.
 *
 * These were local to the first of those and are now asked for by both: the
 * arrangement for "a running edge plus a dispatch refused on it" is the SUBJECT
 * of both files, not an incidental fixture, and two copies of it would be two
 * slightly different trees — the same defect the shape-first harness exists to
 * prevent, one level up.
 */

//jscpd:ignore-start
import { setupHarness } from "./harness.js";

import { events } from "./mock-host.js";
import { assert } from "./runner.js";

//jscpd:ignore-end
/**
 * A dispatch the dependency gate refuses, which is what leaves a wait held.
 * The refusal is asserted here because every caller depends on it: a fixture
 * that quietly succeeded would leave the case testing nothing.
 */
export async function refuseDispatch(h, description, depends_on, depends_on_settled) {
  const refusal = await h.trySpawn({
    depends_on,
    description,
    prompt: "do the downstream thing",
    subagent_type: "general",
    ...(depends_on_settled ? { depends_on_settled } : {}),
  });
  assert.match(refusal, /Dependencies pending/, "the dispatch was refused");
  return refusal;
}

/**
 * Settle an edge the way a FAILURE does: the host publishes the failure, then the
 * turn ends. Separate from the harness's `settle` because a failure is the whole
 * difference between a dependency that releases a wait and one that kills it, and
 * it is not a thing a test should spell out twice.
 *
 * The failure is `session.error` with an error detail — the host's own event. It
 * used to be a `session.status` carrying the word "error", which is a shape the host
 * cannot emit: `SessionStatus` declares idle | retry | busy and nothing else, and the
 * host writes the map only for the running ones. The mock's word gate refused it,
 * which is the gate working.
 */
export async function failEdge(h, id) {
  await h.fireEvent(events.error(id, { data: { message: "child failed" }, name: "Error" }));
  await h.settle(id);
}

/**
 * Settle something, and hand back what the parent was told about a refused
 * dispatch of `description`. The COUNT is asserted here because both "announced
 * once" and "announced not at all" are the contract, and the caller states
 * which — so no case has to restate it, and none can quietly accept a second.
 */
export async function announcedAbout(h, description, action, expected = 1) {
  const hints = await h.noticesMatching(new RegExp(description), action, expected);
  const report = `announced ${expected} time(s). got: ${JSON.stringify(h.noticeBodies())}`;
  assert.strictEqual(hints.length, expected, report);
  return hints[0] ?? { message: "", to: "" };
}

/**
 * One running edge, and one dispatch refused on it. Returns the edge, because
 * what a case does next is always something TO the edge.
 */
export async function refusedOnOneEdge(h, description, kind = "strict") {
  const edge = await h.spawn({ description: "edge work" });
  const settledOnly = kind === "settled";
  await refuseDispatch(
    h,
    description,
    settledOnly ? undefined : [edge.id],
    settledOnly ? [edge.id] : undefined,
  );
  return edge;
}

/**
 * A refused dispatch waiting on SEVERAL running edges. N spelled as a number
 * because the questions asked of these edges differ only in how many there are.
 */
export async function refusedOverEdges(h, description, count) {
  const edges = [];
  for (let i = 0; i < count; i++) {
    edges.push(await h.spawn({ description: `edge ${i + 1}` }));
  }
  await refuseDispatch(h, description, edges.map((e) => e.id));
  return edges;
}
/** What a waiting parent is told to remember, so cases do not each spell it out. */
export const WAITING_FOR = "consume the edge";

/**
 * A parent waiting on one edge, and the announcement its edge's death produces.
 *
 * Every case in this family is one kill step against a held wait, and each spelled
 * the arrangement out again — which is how three of them came to differ in what
 * they set up while the obligation stayed identical. The fault sets are handed in
 * EMPTY and filled after the spawn: the harness names sessions, and a fixture that
 * had to predict those would be asserting against the counter, not the behaviour.
 */
export async function announcementAfterKill({ fault, kill }) {
  const faults = { abortFailIds: new Set(), promptFailIds: new Set() };
  const h = await setupHarness({ hooks: faults });
  const edge = await refusedOnOneEdge(h, WAITING_FOR);
  if (fault) faults[fault].add(edge.id);
  const hint = await announcedAbout(h, WAITING_FOR, () => kill(h, edge.id));
  return { edge, h, hint };
}
