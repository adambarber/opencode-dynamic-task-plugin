/**
 * Stops, as arrangements.
 *
 * Every ownership case is the same three steps — arrange a store, aim the tool at
 * a session, assert against the REQUEST the host was asked to make — and each
 * suite that spelled those steps out copied them. The copies are the reason the
 * duplication gate listed a dozen of them, and they were not merely identical
 * text: two of them asserted `wasAborted`, which is the question that passes when
 * the plugin stops a session it had no business stopping. The assertion lives here
 * so it cannot be retyped loosely.
 */

//jscpd:ignore-start
import { assert } from "./runner.js";

import {
  PARENT,
  assertRefusedWithoutReachingTheHost,
  assertStopped,
  interruptAs,
  sessionIds,
  setupHarness,
  withChild,
  withDispatchTree,
} from "./harness.js";
import { withSingleSlot } from "./integration.js";

//jscpd:ignore-end
/**
 * Boot, spawn one child, stop it as `caller`, and require the request to exist.
 * A case that only wants to observe the tool's wording gets the answer back.
 */
export async function withStoppedChild({ harness = {}, spawn = {}, caller = PARENT } = {}) {
  const { h, c } = await withChild({ ctx: { sessionID: caller }, harness, spawn });
  const answer = await interruptAs(h, c.id, caller);
  assertStopped(h, c.id, answer, `a child of ${caller} is the plugin's to stop`);
  return { answer, c, h };
}

/**
 * Boot, arrange whatever the refusal turns on, aim the tool, and require that the
 * host was never asked. The refusal assertion is part of the arrangement because
 * "it said Refused" is not a claim about authority — it is a string the tool
 * chooses, and the damage is the request.
 */
export async function withRefusedStop({ harness = {}, arrange, target, caller, callerFrom, note }) {
  const h = await setupHarness(harness);
  const seeded = arrange ? await arrange(h) : {};
  // The caller is the session under test as often as it is the parent, so it can
  // be named outright or taken from whatever the arrangement created.
  const speaking = caller ?? (callerFrom === "seeded" ? seeded.id : PARENT);
  const asked = target ?? seeded.id;
  const answer = await interruptAs(h, asked, speaking);
  assertRefusedWithoutReachingTheHost(h, answer, asked, note);
  return { answer, h, ...seeded };
}

/**
 * A tree whose MIDDLE record has finished, so the walk must pass through a settled
 * ancestor to reach live work. The sibling arrangement in the harness settles the
 * grandchild instead; the two are named apart because which record is settled is
 * the whole difference between them.
 */
export async function withSettledMiddleChild() {
  const tree = await withDispatchTree();
  await tree.h.settle(tree.child.id);
  return tree;
}

/**
 * A caller aiming at its own session, with the host seeded live so it WOULD obey.
 * Two cases share this — the one that proves no request went out and the one that
 * reads the refusal's wording — and the arrangement is the point: with the
 * session idle, both would pass against a plugin that had no guard at all.
 */
export async function withSelfStop({ note = "a caller naming its own session" } = {}) {
  return withRefusedStop({ harness: { hostStatusSeed: { [PARENT]: "open" } }, note, target: PARENT });
}

/**
 * Two dispatches racing for one slot. The loser was created by the host and could
 * not be registered, so it exists, runs, and has no record — the plugin's leak.
 * Two awaited spawns never produce it: the pre-create re-check refuses the second
 * before the host is asked, which is why the race is the arrangement.
 */
export async function withOrphan() {
  const h = await withSingleSlot();
  const before = new Set(sessionIds(h.client));
  const answers = await Promise.all([
    h.trySpawn({ description: "winner", prompt: "hi", subagent_type: "explore" }),
    h.trySpawn({ description: "loser", prompt: "hi", subagent_type: "explore" }),
  ]);
  // The orphan is named by what it IS — a created session no confirmation claims.
  // Reading it off `wasAborted` would make the fixture depend on what is under test.
  const created = sessionIds(h.client).filter((id) => !before.has(id));
  const orphan = created.find((id) => !answers.some((a) => a.includes(id)));
  assert.strictEqual(typeof orphan, "string", "fixture: the race must produce an orphan");
  return { answers, h, orphan };
}

/** A child whose abort the host loses once, so the bound is the only thing that answers. */
export async function withLostAbort() {
  const { h, c } = await withChild({
    harness: { hooks: { abortLoseOnceIds: new Set(["ses_mock_1"]) } },
    spawn: { description: "doomed" },
  });
  assert.strictEqual(c.id, "ses_mock_1", "fixture: the hook names the child it will lose");
  return { c, h };
}

/**
 * A tree, stopped at its middle child, with the report kept.
 *
 * The arrangement and the stop are one call because the two claims made about it —
 * which sessions the request reached, and what the report says — are the same
 * three steps, and a suite that repeats the steps can pass on the words while
 * nothing was asked for, or on the request while the report lied.
 */
export async function withStoppedTreeChild({ settled = false } = {}) {
  const tree = settled ? await withSettledMiddleChild() : await withDispatchTree();
  const answer = await interruptAs(tree.h, tree.child.id);
  assertStopped(tree.h, [tree.child.id, tree.grandchild.id], answer, "a subtree stop reaches every member");
  return { ...tree, answer };
}

/** One slot, one child holding it, and a second dispatch the host will refuse. */
export async function withRefusedSecondSpawn() {
  const h = await withSingleSlot();
  await h.spawn({ description: "one" });
  const before = new Set(sessionIds(h.client));
  const second = await h.trySpawn({ description: "two", prompt: "hi", subagent_type: "explore" });
  return { created: sessionIds(h.client).filter((id) => !before.has(id)), h, second };
}
